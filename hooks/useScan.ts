"use client";

// One reducer for every way a scan arrives: the live SSE route (GET /api/scan/<chain>/<token>?tier=)
// or a recorded Scan replayed through playScan(). Both speak ScanEvent, so the room has one path.
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { playScan, type ScanReplayOptions } from "@/lib/xray/replay";
import type {
  BigBuy,
  BuyersFinding,
  CallRecord,
  Diagnosis,
  FlowFinding,
  PricePoint,
  Scan,
  ScanEvent,
  ScanMeta,
  SmartFinding,
  Tier,
  WallsFinding,
} from "@/lib/xray/types";

export type ScanStatus = "idle" | "connecting" | "scanning" | "done" | "error";
export type ScanMode = "live" | "replay";

export interface ScanFindings {
  buyers: BuyersFinding | null;
  flow: FlowFinding | null;
  walls: WallsFinding | null;
  smart: SmartFinding | null;
}

export type ScanTotals = Scan["totals"];

export interface ScanBudget {
  message: string;
  creditsLeftToday: number;
  creditsRemaining: number | null;
}

export interface ScanState {
  /** Increments on every start; events from an older run are ignored. */
  runId: number;
  status: ScanStatus;
  mode: ScanMode | null;
  tier: Tier | null;
  target: { chain: string; token: string } | null;
  stage: { stage: string; message: string } | null;
  meta: ScanMeta | null;
  price: PricePoint[];
  bigBuys: BigBuy[];
  findings: ScanFindings;
  diagnosis: Diagnosis | null;
  /** Oldest first. */
  calls: CallRecord[];
  totals: ScanTotals;
  error: { message: string; retryable: boolean } | null;
  budget: ScanBudget | null;
  synthetic: boolean;
  /** The complete scan: the replayed file, or the live `done` payload. */
  scan: Scan | null;
  startedAt: number;
}

const EMPTY_FINDINGS: ScanFindings = { buyers: null, flow: null, walls: null, smart: null };
const EMPTY_TOTALS: ScanTotals = { calls: 0, networkCalls: 0, credits: 0, cacheHits: 0, durationMs: 0 };

export function initialScanState(): ScanState {
  return {
    runId: 0,
    status: "idle",
    mode: null,
    tier: null,
    target: null,
    stage: null,
    meta: null,
    price: [],
    bigBuys: [],
    findings: EMPTY_FINDINGS,
    diagnosis: null,
    calls: [],
    totals: EMPTY_TOTALS,
    error: null,
    budget: null,
    synthetic: false,
    scan: null,
    startedAt: 0,
  };
}

export type ScanAction =
  | {
      type: "start";
      runId: number;
      mode: ScanMode;
      tier: Tier | null;
      target: { chain: string; token: string };
      synthetic: boolean;
      scan: Scan | null;
      startedAt: number;
    }
  | { type: "events"; runId: number; events: ScanEvent[] }
  /** Calls made outside the scan stream (the on-demand wallet check), added to the evidence. */
  | { type: "calls"; runId: number; calls: CallRecord[] }
  | { type: "connection-lost"; runId: number; message: string }
  | { type: "reset" };

function addCall(t: ScanTotals, c: CallRecord): ScanTotals {
  const credits = Number.isFinite(c.credits) ? c.credits : 0;
  return {
    calls: t.calls + 1,
    networkCalls: t.networkCalls + (c.cached ? 0 : 1),
    credits: t.credits + credits,
    cacheHits: t.cacheHits + (c.cached ? 1 : 0),
    durationMs: Math.max(t.durationMs, Number.isFinite(c.at) ? c.at : 0),
  };
}

function applyEvent(s: ScanState, e: ScanEvent): ScanState {
  const live = s.status === "connecting" ? "scanning" : s.status;
  switch (e.type) {
    case "stage":
      return { ...s, status: live, stage: { stage: e.stage, message: e.message } };
    case "meta":
      return {
        ...s,
        status: live,
        meta: e.meta,
        price: Array.isArray(e.price) ? e.price : [],
        bigBuys: Array.isArray(e.bigBuys) ? e.bigBuys : [],
      };
    case "call":
      return { ...s, status: live, calls: [...s.calls, e.call], totals: addCall(s.totals, e.call) };
    case "finding":
      return { ...s, status: live, findings: { ...s.findings, [e.key]: e.finding } };
    case "diagnosis":
      return { ...s, status: live, diagnosis: e.diagnosis };
    case "done": {
      const scan = e.scan;
      return {
        ...s,
        status: "done",
        error: null,
        scan,
        tier: scan.tier ?? s.tier,
        meta: scan.meta ?? s.meta,
        price: scan.price?.length ? scan.price : s.price,
        bigBuys: scan.bigBuys ?? s.bigBuys,
        findings: {
          buyers: scan.findings?.buyers ?? s.findings.buyers,
          flow: scan.findings?.flow ?? s.findings.flow,
          walls: scan.findings?.walls ?? s.findings.walls,
          smart: scan.findings?.smart ?? s.findings.smart,
        },
        diagnosis: scan.diagnosis ?? s.diagnosis,
        calls: s.calls.length >= (scan.calls?.length ?? 0) ? s.calls : scan.calls,
        totals: scan.totals ?? s.totals,
        synthetic: s.synthetic || scan.synthetic === true,
        stage: { stage: "done", message: "Scan complete" },
      };
    }
    case "error":
      return { ...s, status: "error", error: { message: e.message, retryable: e.retryable } };
    case "budget":
      // The server refused the live scan (budget, visitor limit, live scans off): terminal, and
      // retrying would be refused again.
      return {
        ...s,
        status: "error",
        error: { message: e.message, retryable: false },
        budget: { message: e.message, creditsLeftToday: e.creditsLeftToday, creditsRemaining: e.creditsRemaining },
      };
    default:
      return s;
  }
}

/** Pure reducer behind useScan (exported for tests and tooling). */
export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case "reset":
      return { ...initialScanState(), runId: state.runId };
    case "start":
      return {
        ...initialScanState(),
        runId: action.runId,
        status: action.mode === "live" ? "connecting" : "scanning",
        mode: action.mode,
        tier: action.tier,
        target: action.target,
        synthetic: action.synthetic,
        scan: action.scan,
        startedAt: action.startedAt,
      };
    case "events": {
      if (action.runId !== state.runId) return state;
      let next = state;
      for (const e of action.events) next = applyEvent(next, e);
      return next;
    }
    case "calls": {
      if (action.runId !== state.runId || !action.calls.length) return state;
      let totals = state.totals;
      for (const c of action.calls) totals = addCall(totals, c);
      return { ...state, calls: [...state.calls, ...action.calls], totals };
    }
    case "connection-lost": {
      if (action.runId !== state.runId || state.status === "done" || state.status === "error") return state;
      const message = state.budget?.message ?? action.message;
      return { ...state, status: "error", error: { message, retryable: true } };
    }
    default:
      return state;
  }
}

const SSE_EVENT_NAMES = ["stage", "call", "meta", "finding", "diagnosis", "done", "budget"] as const;

/** Accepts `data: {"type":…}` messages and named SSE events whose payload omits `type`. */
export function parseSseEvent(eventName: string, data: string): ScanEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type === "string") return obj as unknown as ScanEvent;
  if (eventName !== "message") return { ...obj, type: eventName } as unknown as ScanEvent;
  return null;
}

/** The state of a recorded scan shown fully read (the server-rendered first paint of a page). */
export function scanStateFromScan(scan: Scan): ScanState {
  const started = scanReducer(initialScanState(), {
    type: "start",
    runId: 0,
    mode: "replay",
    tier: scan.tier ?? null,
    target: { chain: scan.meta.chain, token: scan.meta.tokenAddress },
    synthetic: scan.synthetic === true,
    scan,
    startedAt: 0,
  });
  return scanReducer(started, { type: "events", runId: 0, events: scanToEvents(scan) });
}

/** Same event order as playScan, all at once, used if the replay player is unavailable. */
export function scanToEvents(scan: Scan): ScanEvent[] {
  const events: ScanEvent[] = [
    { type: "stage", stage: "context", message: "Reading the chart" },
    { type: "meta", meta: scan.meta, price: scan.price ?? [], bigBuys: scan.bigBuys ?? [] },
  ];
  for (const call of scan.calls ?? []) events.push({ type: "call", call });
  const f = scan.findings;
  if (f?.buyers) events.push({ type: "finding", key: "buyers", finding: f.buyers });
  if (f?.flow) events.push({ type: "finding", key: "flow", finding: f.flow });
  if (f?.walls) events.push({ type: "finding", key: "walls", finding: f.walls });
  if (f?.smart) events.push({ type: "finding", key: "smart", finding: f.smart });
  if (scan.diagnosis) events.push({ type: "diagnosis", diagnosis: scan.diagnosis });
  events.push({ type: "done", scan });
  return events;
}

export function scanUrl(chain: string, token: string, tier: Tier): string {
  return `/api/scan/${encodeURIComponent(chain)}/${encodeURIComponent(token)}?tier=${tier}`;
}

export interface ScanControls {
  state: ScanState;
  /** Adds calls made outside the stream (e.g. the wallet check) to the current run's evidence. */
  appendCalls: (runId: number, calls: CallRecord[]) => void;
  /** Opens the live SSE stream (spends credits server-side). Returns the run id (see state.runId). */
  startLive: (chain: string, token: string, tier?: Tier) => number;
  /** Replays a recorded scan through the same reducer. Returns the run id (see state.runId). */
  replay: (scan: Scan, opts?: ScanReplayOptions) => number;
  /** Stops the running stream / replay (state is kept). */
  stop: () => void;
  /** Stops and clears. */
  reset: () => void;
}

/** `initialScan`: a recorded scan to start from, fully read (so the server renders it on first paint). */
export function useScan(initialScan?: Scan | null): ScanControls {
  const [state, dispatch] = useReducer(scanReducer, initialScan ?? null, (seed) => (seed ? scanStateFromScan(seed) : initialScanState()));
  const runRef = useRef(0);
  const cancelRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    const cancel = cancelRef.current;
    cancelRef.current = null;
    cancel?.();
  }, []);

  const startLive = useCallback(
    (chain: string, token: string, tier: Tier = "quick") => {
      stop();
      const runId = ++runRef.current;
      dispatch({
        type: "start",
        runId,
        mode: "live",
        tier,
        target: { chain, token },
        synthetic: false,
        scan: null,
        startedAt: Date.now(),
      });
      if (typeof window === "undefined" || typeof EventSource === "undefined") {
        dispatch({ type: "connection-lost", runId, message: "This browser cannot open a live x-ray stream." });
        return runId;
      }

      const es = new EventSource(scanUrl(chain, token, tier));
      let closed = false;
      let received = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        es.close();
      };
      const handle = (name: string, data: string) => {
        if (closed || runRef.current !== runId) return;
        const event = parseSseEvent(name, data);
        if (!event) return;
        received += 1;
        dispatch({ type: "events", runId, events: [event] });
        // The server closes after done / error / budget; close first so EventSource never reconnects
        // (a reconnect would re-attach to, or restart, the scan).
        if (event.type === "done" || event.type === "error" || event.type === "budget") close();
      };

      es.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") handle("message", ev.data);
      };
      for (const name of SSE_EVENT_NAMES) {
        es.addEventListener(name, (ev) => {
          if (ev instanceof MessageEvent && typeof ev.data === "string" && ev.data) handle(name, ev.data);
        });
      }
      // "error" is both a ScanEvent name and the EventSource connection-failure event.
      es.addEventListener("error", (ev) => {
        if (ev instanceof MessageEvent && typeof ev.data === "string" && ev.data) {
          handle("error", ev.data);
          return;
        }
        if (closed || runRef.current !== runId) return;
        close();
        dispatch({
          type: "connection-lost",
          runId,
          message: received
            ? "The live x-ray lost its connection before it finished."
            : "The live x-ray could not start. Live scans may be off, or today's credit budget is spent.",
        });
      });

      cancelRef.current = close;
      return runId;
    },
    [stop],
  );

  const replay = useCallback(
    (scan: Scan, opts?: ScanReplayOptions) => {
      stop();
      const runId = ++runRef.current;
      dispatch({
        type: "start",
        runId,
        mode: "replay",
        tier: scan.tier ?? null,
        target: { chain: scan.meta.chain, token: scan.meta.tokenAddress },
        synthetic: scan.synthetic === true,
        scan,
        startedAt: Date.now(),
      });

      // Buffer the synchronous part (instant replays emit everything inside playScan()).
      let sync = true;
      const buffer: ScanEvent[] = [];
      const onEvent = (e: ScanEvent) => {
        if (runRef.current !== runId) return;
        if (sync) buffer.push(e);
        else dispatch({ type: "events", runId, events: [e] });
      };
      let cancel: (() => void) | null = null;
      try {
        cancel = playScan(scan, onEvent, opts);
      } catch {
        buffer.length = 0;
        buffer.push(...scanToEvents(scan));
      }
      sync = false;
      if (buffer.length) dispatch({ type: "events", runId, events: buffer });
      cancelRef.current = () => cancel?.();
      return runId;
    },
    [stop],
  );

  const reset = useCallback(() => {
    stop();
    runRef.current += 1;
    dispatch({ type: "reset" });
  }, [stop]);

  const appendCalls = useCallback((runId: number, calls: CallRecord[]) => {
    if (calls.length) dispatch({ type: "calls", runId, calls });
  }, []);

  // Unmount (and strict-mode's simulated unmount) closes the stream / stops the replay.
  useEffect(() => stop, [stop]);

  return useMemo(() => ({ state, appendCalls, startLive, replay, stop, reset }), [state, appendCalls, startLive, replay, stop, reset]);
}
