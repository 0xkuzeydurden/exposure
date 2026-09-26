// Replays a recorded Scan as the same ScanEvent stream the live SSE route emits, so the UI has one
// code path. Timing comes from Scan.calls[].at, compressed by `speed`.
//
// Order: stage(context) -> meta -> context calls -> for buyers, flow, walls, smart: stage -> that
// finding's calls -> finding -> (any other calls) -> stage(diagnosis) -> diagnosis -> stage(done) -> done.
// Calls are grouped by finding and sorted by `at` inside a group; each call waits (its at - the previous
// emitted call's at) / speed, clamped to [0, maxGapMs], so a live scan whose findings ran in parallel
// still replays one finding at a time with its own rhythm.
import { stageMessage } from "./copy";
import type { CallRecord, FindingKey, Scan, ScanEvent } from "./types";

export interface ScanReplayOptions {
  /** 1 = recorded speed. Default 6. Gaps longer than maxGapMs (after speed) are clamped. */
  speed?: number;
  maxGapMs?: number;
  /** Emit everything synchronously (no animation). */
  instant?: boolean;
}

export const DEFAULT_REPLAY_SPEED = 6;
export const DEFAULT_REPLAY_MAX_GAP_MS = 250;

const FINDINGS = ["buyers", "flow", "walls", "smart"] as const;

export interface ScanReplayStep {
  /** ms after playScan() was called. */
  at: number;
  events: ScanEvent[];
}

function findingEvent(scan: Scan, key: (typeof FINDINGS)[number]): ScanEvent {
  switch (key) {
    case "buyers":
      return { type: "finding", key, finding: scan.findings.buyers };
    case "flow":
      return { type: "finding", key, finding: scan.findings.flow };
    case "walls":
      return { type: "finding", key, finding: scan.findings.walls };
    case "smart":
      return { type: "finding", key, finding: scan.findings.smart };
  }
}

/** The full timed event list. Exported for tests and for UIs that want to know the total length up front. */
export function scanTimeline(scan: Scan, opts?: ScanReplayOptions): ScanReplayStep[] {
  const speed = opts?.speed != null && Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : DEFAULT_REPLAY_SPEED;
  const maxGap =
    opts?.maxGapMs != null && Number.isFinite(opts.maxGapMs) && opts.maxGapMs >= 0 ? opts.maxGapMs : DEFAULT_REPLAY_MAX_GAP_MS;

  // Group calls by finding, stable-sorted by `at` inside each group.
  const lanes = new Map<FindingKey | "other", CallRecord[]>();
  const known = new Set<string>(["context", ...FINDINGS]);
  (scan.calls ?? []).forEach((call) => {
    const lane = known.has(call.finding) ? call.finding : "other";
    const list = lanes.get(lane) ?? [];
    list.push(call);
    lanes.set(lane, list);
  });
  const atOf = (c: CallRecord) => (Number.isFinite(c.at) ? c.at : NaN);
  for (const list of lanes.values()) {
    list.sort((a, b) => {
      const x = atOf(a);
      const y = atOf(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return 0;
      return x - y;
    });
  }

  const steps: ScanReplayStep[] = [];
  const push = (at: number, e: ScanEvent) => {
    const last = steps[steps.length - 1];
    if (last && last.at === at) last.events.push(e);
    else steps.push({ at, events: [e] });
  };

  let t = 0;
  let prevAt = 0;
  const emitCalls = (calls: CallRecord[] | undefined) => {
    for (const call of calls ?? []) {
      const at = Number.isFinite(call.at) ? call.at : prevAt;
      t += Math.min(maxGap, Math.max(0, (at - prevAt) / speed));
      prevAt = at;
      push(t, { type: "call", call });
    }
  };

  push(0, { type: "stage", stage: "context", message: stageMessage("context", scan) });
  push(0, { type: "meta", meta: scan.meta, price: scan.price ?? [], bigBuys: scan.bigBuys ?? [] });
  emitCalls(lanes.get("context"));

  for (const key of FINDINGS) {
    push(t, { type: "stage", stage: key, message: stageMessage(key, scan) });
    emitCalls(lanes.get(key));
    push(t, findingEvent(scan, key));
  }

  // Calls recorded against "you" (or an unknown key) do not belong to a finding of the scan.
  emitCalls([...(lanes.get("you") ?? []), ...(lanes.get("other") ?? [])]);

  push(t, { type: "stage", stage: "diagnosis", message: stageMessage("diagnosis", scan) });
  push(t, { type: "diagnosis", diagnosis: scan.diagnosis });
  push(t, { type: "stage", stage: "done", message: stageMessage("done", scan) });
  push(t, { type: "done", scan });
  return steps;
}

/** How long a replay runs (ms) with these options; 0 when instant. */
export function replayDurationMs(scan: Scan, opts?: ScanReplayOptions): number {
  if (opts?.instant) return 0;
  const steps = scanTimeline(scan, opts);
  return steps.length ? steps[steps.length - 1].at : 0;
}

/** Emits: stage(context), meta, then per finding stage + its calls + finding, diagnosis, done. Returns cancel. */
export function playScan(scan: Scan, onEvent: (e: ScanEvent) => void, opts?: ScanReplayOptions): () => void {
  const steps = scanTimeline(scan, opts);

  if (opts?.instant) {
    for (const step of steps) for (const e of step.events) onEvent(e);
    return () => {};
  }

  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const step of steps) {
    timers.push(
      setTimeout(() => {
        for (const e of step.events) {
          if (cancelled) return;
          onEvent(e);
        }
      }, step.at),
    );
  }

  return () => {
    if (cancelled) return;
    cancelled = true;
    for (const id of timers) clearTimeout(id);
    timers.length = 0;
  };
}
