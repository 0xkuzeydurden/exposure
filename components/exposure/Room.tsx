"use client";

// The radiology room: signage / ward (lightbox + clipboard) / desk (intake + evidence) / waiting
// room, and the orchestration of one exposure:
//   overlay.run (charge → flash → swap → eyelids open): the scan stream starts at the swap
//   → the beam reads the film (0→1 over 2.4s; live scans keep sweeping until the findings are in)
//   → funding-source dots merge → the report types findings 1–5 (each lights its film marker with
//   a monitor beep) → impression → stamp.
// Recorded scans replay through the same path (useScan + playScan).
// The first page of a browser session opens on the check-in gate (CheckIn): the room is rendered behind
// it and the opening exposure only starts once the visitor checked in (with sound) or entered silently.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CheckIn } from "@/components/exposure/CheckIn";
import { DirectorStage } from "@/components/exposure/Director";
import type { DirectorConfig } from "@/components/exposure/DirectorScript";
import { ExposureOverlay, useExposure, type ExposurePhase } from "@/components/exposure/ExposureOverlay";
import Film from "@/components/exposure/Film";
import { Intake, type IntakeLive, type IntakeTarget } from "@/components/exposure/Intake";
import { LabResults, type LabTab } from "@/components/exposure/LabResults";
import { Report, shortAddr, type FindingNo, type WalletUi } from "@/components/exposure/Report";
import { Signage } from "@/components/exposure/Signage";
import {
  findRecorded,
  loadGallery,
  loadScan,
  loadSyntheticScan,
  patientFromScan,
  patientKey,
  SYNTHETIC_URL,
  WaitingRoom,
  type Patient,
} from "@/components/exposure/WaitingRoom";
import { useScan } from "@/hooks/useScan";
import { checkedInSnapshot, completeCheckIn, gateNeeded, hasCheckedIn, subscribeCheckIn } from "@/lib/exposure/checkin";
import { sound, useSoundEnabled } from "@/lib/exposure/sound";
import { isCancelled, sleep, TypingCancelled, waitFor } from "@/lib/exposure/typewriter";
import { isEvmChain, isValidAddress } from "@/lib/nansen/chains";
import { chainLabel, evidenceLine, examLabel, patientName, reportDate } from "@/lib/xray/copy";
import { makeSyntheticWalletCheck } from "@/lib/xray/fixtures";
import type { CallRecord, LadderBin, Scan, Tier, WalletCheck } from "@/lib/xray/types";

/* ------------------------------------------------------------------------------------------ */

export type RoomInitial =
  /**
   * Home: the first waiting-room patient (else the synthetic one), exposed once automatically.
   * `scan` is that patient read on the server, so the first paint already shows the film and report.
   */
  | { kind: "featured"; scan?: Scan | null }
  /** /x/<chain>/<token>: the recorded scan if there is one, else a "Take the x-ray" button. */
  | { kind: "token"; chain: string; token: string; scan: Scan | null; invalid?: string | null };

export interface RoomProps {
  initial: RoomInitial;
  /** Recording mode (?rec=1): a scripted demo over the recorded gallery (components/exposure/Director). */
  director?: DirectorConfig | null;
}

type Target = { kind: "scan"; scan: Scan } | { kind: "live"; chain: string; token: string; tier: Tier };

interface FilmAnim {
  reveal: number;
  beam: boolean;
  merge: number;
  markers: number;
  /**
   * A live scan is still running: the beam sweeps an empty film (findings held back) so already
   * revealed layers do not vanish and reappear on every sweep; they are read once, when all are in.
   */
  hold: boolean;
}

const FINAL_ANIM: FilmAnim = { reveal: 1, beam: false, merge: 1, markers: 5, hold: false };
const BLANK_ANIM: FilmAnim = { reveal: 0, beam: false, merge: 0, markers: 0, hold: false };

const REVEAL_MS = 2400;
const LIVE_SWEEP_MS = 3200;
const BEAM_FADE_MS = 260;
const MERGE_MS = 800;
const AUTOPLAY_DELAY_MS = 1200;
/** From the check-in card leaving to the intro (the click already said "start"). */
const AFTER_CHECKIN_MS = 300;
const GHOST_CHAR_MS = 90;

const WALLET_IDLE = { pending: false, error: null as string | null };
const NO_BUYS: Scan["bigBuys"] = [];

interface AccountInfo {
  known: boolean;
  hasKey: boolean;
  liveEnabled: boolean;
  creditsRemaining: number | null;
  quickCredits: number;
  /** Server-provided deep estimate for EVM chains (else estimated per chain). */
  deepCredits: number | null;
  /** Server-provided deep estimates by chain kind (funder tracing only runs on EVM). */
  deepByChain: { evm: number; other: number } | null;
  /** Credits left in today's deep-scan budget (min of the deep and daily caps). */
  deepLeft: number | null;
}

const ACCOUNT_UNKNOWN: AccountInfo = {
  known: false,
  hasKey: false,
  liveEnabled: false,
  creditsRemaining: null,
  quickCredits: 13,
  deepCredits: null,
  deepByChain: null,
  deepLeft: null,
};

/* ----------------------------------------- helpers ----------------------------------------- */

const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const linear = (t: number) => t;

/** Server (and hydration) snapshot of the check-in: not yet, so the gate is in the server HTML. */
const NOT_CHECKED_IN = () => false;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** rAF tween; rejects with TypingCancelled when `signal` aborts. */
function tween(ms: number, fn: (k: number) => void, ease: (t: number) => number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TypingCancelled());
      return;
    }
    let raf = 0;
    const onAbort = () => {
      cancelAnimationFrame(raf);
      reject(new TypingCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      fn(ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
      else {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
    };
    raf = requestAnimationFrame(step);
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function pickCredits(src: unknown, tier: Tier): number | null {
  if (!src || typeof src !== "object") return null;
  const v = (src as Record<string, unknown>)[tier];
  if (num(v) !== null) return num(v);
  if (v && typeof v === "object") return num((v as Record<string, unknown>).credits) ?? num((v as Record<string, unknown>).total);
  return null;
}

/** Tolerant /api/account parser (liveEnabled from the budget status, liveBuilds from the old route). */
function parseAccount(body: unknown): AccountInfo {
  if (!body || typeof body !== "object") return { ...ACCOUNT_UNKNOWN, known: true };
  const b = body as Record<string, unknown>;
  const hasKey = bool(b.hasKey) ?? false;
  const live = bool(b.liveEnabled) ?? bool(b.liveScans) ?? bool(b.liveBuilds) ?? false;
  const est = b.estimates ?? b.tiers ?? b.creditEstimates;
  const byChain = b.deepByChain && typeof b.deepByChain === "object" ? (b.deepByChain as Record<string, unknown>) : null;
  const evm = byChain ? num(byChain.evm) : null;
  const other = byChain ? num(byChain.other) : null;
  return {
    known: true,
    hasKey,
    liveEnabled: hasKey && live,
    creditsRemaining: num(b.creditsRemaining),
    quickCredits: pickCredits(est, "quick") ?? num(b.quickCredits) ?? 13,
    deepCredits: pickCredits(est, "deep") ?? num(b.deepCredits),
    deepByChain: evm !== null && other !== null ? { evm, other } : null,
    deepLeft: num(b.deepLeft),
  };
}

/** Deep-scan estimate for a chain (lib/xray/budget: 18 + holders, + buyers on EVM; 15 each live). */
function deepEstimate(account: AccountInfo, chain: string): number {
  const evm = isEvmChain(chain);
  if (account.deepByChain) return evm ? account.deepByChain.evm : account.deepByChain.other;
  return (evm ? account.deepCredits : null) ?? (evm ? 48 : 33);
}

/** The `calls` array of an /api/wallet answer (the check's own Nansen calls, for the evidence tab). */
function walletCalls(body: unknown): CallRecord[] {
  const calls = body && typeof body === "object" ? (body as { calls?: unknown }).calls : null;
  if (!Array.isArray(calls)) return [];
  return calls.filter(
    (c): c is CallRecord => !!c && typeof c === "object" && typeof (c as CallRecord).endpoint === "string" && typeof (c as CallRecord).credits === "number",
  );
}

/** Share of the ladder's tokens bought below `cost` (log-interpolated), like the wallet pipeline. */
function cheaperShare(ladder: LadderBin[] | undefined, cost: number): number | null {
  if (!ladder?.length || !(cost > 0)) return null;
  let total = 0;
  let cheaper = 0;
  for (const b of ladder) {
    if (!(b.tokens > 0)) continue;
    total += b.tokens;
    if (b.hi <= cost) cheaper += b.tokens;
    else if (b.lo < cost && b.lo > 0 && b.hi > b.lo) cheaper += b.tokens * (Math.log(cost / b.lo) / Math.log(b.hi / b.lo));
  }
  return total > 0 ? Math.max(0, Math.min(1, cheaper / total)) : null;
}

/** /api/wallet answers a WalletCheck (new route) or the old {cost, amount, priceNow} probe. */
function toWalletCheck(body: unknown, address: string, scan: { priceNow: number | null; smartAvg: number | null; ladder?: LadderBin[] }): WalletCheck {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const inner = (raw.check ?? raw.you ?? raw.wallet ?? raw) as Record<string, unknown>;
  const short = typeof inner.short === "string" && inner.short ? inner.short : shortAddr(address);
  if ("vsSmartMoneyPct" in inner || "cheaperShare" in inner || typeof inner.status === "string") {
    const status = inner.status === "ok" || inner.status === "partial" || inner.status === "unavailable" ? inner.status : "ok";
    return {
      status,
      address: typeof inner.address === "string" ? inner.address : address,
      short,
      cost: num(inner.cost),
      pnlPct: num(inner.pnlPct),
      vsSmartMoneyPct: num(inner.vsSmartMoneyPct),
      cheaperShare: num(inner.cheaperShare),
      holdingTokens: num(inner.holdingTokens),
    };
  }
  const cost = num(inner.cost);
  const priceNow = num(inner.priceNow) ?? scan.priceNow;
  const valid = cost !== null && cost > 0;
  return {
    status: valid ? "ok" : "unavailable",
    address,
    short,
    cost: valid ? cost : null,
    pnlPct: valid && priceNow ? priceNow / cost - 1 : null,
    vsSmartMoneyPct: valid && scan.smartAvg ? cost / scan.smartAvg - 1 : null,
    cheaperShare: valid ? cheaperShare(scan.ladder, cost) : null,
    holdingTokens: num(inner.amount) ?? num(inner.holdingTokens),
  };
}

function syncUrl(chain: string, token: string): void {
  if (typeof window === "undefined") return;
  const path = `/x/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`;
  if (window.location.pathname !== path) window.history.replaceState(null, "", path);
}

/* ------------------------------------------ Room ------------------------------------------ */

export function Room({ initial, director = null }: RoomProps) {
  // The page's recorded scan, read on the server: the first paint shows it fully read.
  const [initialScan] = useState<Scan | null>(() => initial.scan ?? null);
  const { state, replay, startLive, appendCalls } = useScan(initialScan);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const sceneRef = useRef<HTMLDivElement>(null);
  const { ref: exposureRef, run: runExposure } = useExposure();
  const [soundOn, setSoundOn] = useSoundEnabled();

  const [anim, setAnim] = useState<FilmAnim>(() => (initialScan ? FINAL_ANIM : BLANK_ANIM));
  const [focus, setFocus] = useState<FindingNo | null>(null);
  const [report, setReport] = useState<{ key: number; mode: "typing" | "instant"; gate: boolean }>({
    key: 0,
    mode: "instant",
    gate: true,
  });
  const [you, setYou] = useState<WalletCheck | null>(null);
  const [walletState, setWalletState] = useState(WALLET_IDLE);
  const [lab, setLab] = useState<{ open: boolean; tab: LabTab }>({ open: false, tab: "summary" });
  const [account, setAccount] = useState<AccountInfo>(ACCOUNT_UNKNOWN);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [armed, setArmed] = useState(false);
  const [ghost, setGhost] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** /x/<chain>/<token> without a recording: offer a live x-ray. */
  const [cta, setCta] = useState<{ chain: string; token: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(initial.kind === "token" ? (initial.invalid ?? null) : null);

  const seqAbort = useRef<AbortController | null>(null);
  /**
   * Set by the first user action: the intro (ghost typing / autoplay) must not start or continue.
   * Set from the start in recording mode, where the director runs the room.
   */
  const tookOver = useRef(director !== null);

  /* ------------------------------ check-in gate ------------------------------ */
  const checkedIn = useSyncExternalStore(subscribeCheckIn, checkedInSnapshot, NOT_CHECKED_IN);
  const gated = gateNeeded({ recording: director !== null, checkedIn });
  /** `open`: the intro waits; `fresh`: the visitor checked in on this page (the intro follows at once). */
  const gate = useRef({ open: gated, fresh: false });
  useEffect(() => {
    gate.current.open = gated;
  });
  const onCheckedIn = useCallback(() => {
    gate.current = { open: false, fresh: true };
    completeCheckIn();
  }, []);
  // Checked in on an earlier page of this session: no gate, so try to start the audio without a
  // gesture (allowed after a same-origin reload in most browsers; else silent until the first click).
  const recording = director !== null;
  useEffect(() => {
    if (!recording && hasCheckedIn()) sound.resume();
  }, [recording]);

  const scanCache = useRef(new Map<string, Scan>());
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  });

  /* ------------------------------ account (0 credits) ------------------------------ */
  const loadAccount = useCallback((signal?: AbortSignal) => {
    fetch("/api/account", { cache: "no-store", signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => setAccount(parseAccount(body)))
      .catch(() => {
        if (!signal?.aborted) setAccount({ ...ACCOUNT_UNKNOWN, known: true });
      });
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    loadAccount(ctrl.signal);
    return () => ctrl.abort();
  }, [loadAccount]);
  // A live scan the server refused (budget / visitor limit / live off): what it offers has changed.
  const refused = state.budget !== null;
  useEffect(() => {
    if (!refused) return;
    const ctrl = new AbortController();
    loadAccount(ctrl.signal);
    return () => ctrl.abort();
  }, [refused, loadAccount]);

  /* ------------------------------ showing & exposing ------------------------------ */

  /** Shows a recorded scan at once (no transition), e.g. the first paint of a page. */
  const present = useCallback(
    (scan: Scan) => {
      seqAbort.current?.abort();
      setYou(null);
      setWalletState(WALLET_IDLE);
      setFocus(null);
      setAnim(FINAL_ANIM);
      setReport((r) => ({ key: r.key + 1, mode: "instant", gate: true }));
      replay(scan, { instant: true });
    },
    [replay],
  );

  /** One exposure: flash + eyelids, then the beam, the merge and the typed report. */
  const expose = useCallback(
    async (target: Target, opts: { url?: boolean } = {}) => {
      seqAbort.current?.abort();
      const ctrl = new AbortController();
      seqAbort.current = ctrl;
      const signal = ctrl.signal;
      const reduce = prefersReducedMotion();
      setLab((l) => (l.open ? { ...l, open: false } : l));
      setCta(null);
      setInvalid(null);
      setNotice(null);
      setFocus(null);

      let runId = -1;
      const swap = () => {
        if (runId !== -1 || signal.aborted) return;
        setArmed(false);
        setGhost(null);
        setYou(null);
        setWalletState(WALLET_IDLE);
        setAnim(reduce ? FINAL_ANIM : BLANK_ANIM);
        setReport((r) => ({ key: r.key + 1, mode: reduce ? "instant" : "typing", gate: reduce }));
        runId = target.kind === "scan" ? replay(target.scan, { instant: true }) : startLive(target.chain, target.token, target.tier);
        const synthetic = target.kind === "scan" && target.scan.synthetic === true;
        if (opts.url !== false && !synthetic) {
          if (target.kind === "scan") syncUrl(target.scan.meta.chain, target.scan.meta.tokenAddress);
          else syncUrl(target.chain, target.token);
        }
      };

      try {
        await runExposure(swap);
      } catch {
        /* the overlay never blocks the scan */
      }
      if (signal.aborted) return;
      swap(); // no-op when the overlay already swapped
      if (reduce) return;

      try {
        // Wait for the first image (meta + price) of this run.
        await waitFor(() => {
          const s = stateRef.current;
          return s.runId === runId && (s.meta !== null || s.status === "error");
        }, signal, 40);
        if (signal.aborted || stateRef.current.meta === null) return;

        const finished = () => {
          const s = stateRef.current;
          return s.runId !== runId || s.status === "done" || s.status === "error";
        };
        const setReveal = (k: number) => setAnim((a) => ({ ...a, reveal: k }));
        if (target.kind === "live") {
          // Keep the beam sweeping gently over the bare film until every finding is in (findings are
          // held back meanwhile), then one clean read of everything.
          setAnim((a) => ({ ...a, beam: true, hold: true }));
          while (!finished()) {
            await tween(LIVE_SWEEP_MS, setReveal, inOut, signal);
            if (!finished()) await sleep(300, signal);
          }
          setAnim((a) => ({ ...a, reveal: 0, hold: false }));
        } else {
          setAnim((a) => ({ ...a, beam: true }));
        }
        await tween(REVEAL_MS, setReveal, inOut, signal);
        setAnim((a) => ({ ...a, reveal: 1, beam: false }));
        await sleep(BEAM_FADE_MS, signal);
        // Linear progress: the film eases the merge itself (geometry.mergeEase).
        await tween(MERGE_MS, (k) => setAnim((a) => ({ ...a, merge: k })), linear, signal);
        setReport((r) => ({ ...r, gate: true }));
      } catch (err) {
        if (!isCancelled(err)) throw err;
      }
    },
    [runExposure, replay, startLive],
  );

  const getScan = useCallback(
    async (p: Patient, signal?: AbortSignal): Promise<Scan | null> => {
      const hit = scanCache.current.get(p.url);
      if (hit) return hit;
      // The page's server-read scan is this patient: no second download.
      if (
        initialScan &&
        patientKey(initialScan.meta.chain, initialScan.meta.tokenAddress) === patientKey(p.chain, p.tokenAddress) &&
        (initialScan.synthetic === true) === (p.url === SYNTHETIC_URL)
      ) {
        scanCache.current.set(p.url, initialScan);
        return initialScan;
      }
      const scan = p.url === SYNTHETIC_URL ? await loadSyntheticScan(signal) : await loadScan(p.url, signal);
      if (scan) scanCache.current.set(p.url, scan);
      return scan;
    },
    [initialScan],
  );

  /* ------------------------------ first view ------------------------------ */
  useEffect(() => {
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const stop = () => signal.aborted || tookOver.current;
    /** Resolves once the check-in gate is gone (at once without one); true when it was on this page. */
    const afterGate = async (sig: AbortSignal) => {
      await waitFor(() => !gate.current.open, sig, 40);
      return gate.current.fresh;
    };
    void (async () => {
      try {
        let list = await loadGallery(signal);
        if (!list.length) {
          const syn = initialScan?.synthetic ? initialScan : await loadSyntheticScan(signal);
          if (syn) {
            scanCache.current.set(SYNTHETIC_URL, syn);
            list = [patientFromScan(syn, SYNTHETIC_URL)];
          }
        }
        if (signal.aborted) return;
        setPatients(list);
        setGalleryLoading(false);

        if (initial.kind === "featured") {
          let scan: Scan | null = null;
          let featured: Patient | null = null;
          for (const p of list) {
            scan = await getScan(p, signal);
            if (scan) {
              featured = p;
              break;
            }
          }
          if (stop()) return;
          if (!scan || !featured) {
            setNotice("No recorded x-rays yet.");
            return;
          }
          // Already on the lightbox when the server rendered it.
          if (scan !== stateRef.current.scan) present(scan);
          const fresh = await afterGate(signal);
          if (stop() || prefersReducedMotion()) return;
          // The mockup's opening: the patient's name is typed into the intake, then the exposure.
          await sleep(fresh ? AFTER_CHECKIN_MS : AUTOPLAY_DELAY_MS, signal);
          const name = scan.meta.symbol.replace(/^\$/, "");
          for (let i = 1; i <= name.length; i++) {
            if (stop()) return;
            setGhost(name.slice(0, i));
            await sleep(GHOST_CHAR_MS, signal);
          }
          await sleep(250, signal);
          if (stop()) return;
          await expose({ kind: "scan", scan }, { url: false });
          return;
        }

        // /x/<chain>/<token>
        if (initial.invalid) return;
        const scan = initial.scan ?? (await findRecorded(initial.chain, initial.token, signal));
        if (stop()) return;
        if (!scan) {
          setCta({ chain: initial.chain, token: initial.token });
          return;
        }
        if (scan !== stateRef.current.scan) present(scan);
        const fresh = await afterGate(signal);
        if (stop() || prefersReducedMotion()) return;
        await sleep(fresh ? AFTER_CHECKIN_MS : AUTOPLAY_DELAY_MS * 0.6, signal);
        if (stop()) return;
        await expose({ kind: "scan", scan }, { url: false });
      } catch (err) {
        if (!isCancelled(err) && !signal.aborted) setNotice("The waiting room could not be loaded.");
      }
    })();
    return () => {
      ctrl.abort();
      seqAbort.current?.abort();
      setGhost(null);
    };
    // First view only (per page); `initial` is fixed for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ user actions ------------------------------ */

  /** A user action takes over: stop the intro (ghost typing / pending autoplay). */
  const takeOver = useCallback(() => {
    if (!tookOver.current) {
      tookOver.current = true;
      setGhost(null);
    }
    sound.unlock();
  }, []);

  const selectPatient = useCallback(
    async (p: Patient) => {
      takeOver();
      const scan = await getScan(p);
      if (!scan) {
        setNotice(`The file for $${p.symbol.replace(/^\$/, "")} could not be opened.`);
        return;
      }
      await expose({ kind: "scan", scan });
    },
    [getScan, expose, takeOver],
  );

  const admit = useCallback(
    async (t: IntakeTarget) => {
      takeOver();
      if (t.recorded) {
        await selectPatient(t.recorded);
        return;
      }
      setNotice(null);
      const recorded = await findRecorded(t.chain, t.token);
      if (recorded) {
        await expose({ kind: "scan", scan: recorded });
        return;
      }
      if (accountRef.current.liveEnabled) {
        await expose({ kind: "live", chain: t.chain, token: t.token, tier: "quick" });
        return;
      }
      const who = t.symbol ? `$${t.symbol.replace(/^\$/, "")}` : shortAddr(t.token);
      setNotice(`No x-ray on file for ${who}. Live x-rays are off: pick a patient from the waiting room.`);
    },
    [selectPatient, expose, takeOver],
  );

  const takeXray = useCallback(() => {
    takeOver();
    const s = stateRef.current;
    if (s.scan) {
      void expose({ kind: "scan", scan: s.scan }, { url: false });
      return;
    }
    if (cta && accountRef.current.liveEnabled) void expose({ kind: "live", chain: cta.chain, token: cta.token, tier: "quick" });
  }, [expose, cta, takeOver]);

  const startDeep = useCallback(() => {
    const m = stateRef.current.meta;
    if (!m) return;
    sound.unlock();
    void expose({ kind: "live", chain: m.chain, token: m.tokenAddress, tier: "deep" });
  }, [expose]);

  const retryLive = useCallback(() => {
    const s = stateRef.current;
    if (s.mode !== "live" || !s.target) return;
    void expose({ kind: "live", chain: s.target.chain, token: s.target.token, tier: s.tier ?? "quick" });
  }, [expose]);

  const onWalletSubmit = useCallback(async (address: string) => {
    const s = stateRef.current;
    const meta = s.meta;
    if (!meta) return;
    if (s.synthetic && s.scan) {
      // The synthetic preview answers with its own sample wallet (no Nansen call, clearly synthetic).
      setYou(makeSyntheticWalletCheck(s.scan));
      setWalletState(WALLET_IDLE);
      return;
    }
    const a = address.trim();
    if (!isValidAddress(meta.chain, a)) {
      setWalletState({ pending: false, error: `That is not a ${chainLabel(meta.chain)} wallet address.` });
      return;
    }
    const runId = s.runId;
    setWalletState({ pending: true, error: null });
    try {
      const res = await fetch("/api/wallet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: meta.chain,
          token: meta.tokenAddress,
          wallet: a,
          priceNow: meta.priceNow,
          smartAvgEntry: s.findings.smart?.avgEntry ?? undefined,
          ladder: s.findings.walls?.ladder ?? undefined,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (stateRef.current.runId !== runId) return;
      if (!res.ok) {
        const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
        throw new Error(msg ?? `The wallet check failed (${res.status}).`);
      }
      setYou(
        toWalletCheck(body, a, {
          priceNow: meta.priceNow,
          smartAvg: s.findings.smart?.avgEntry ?? null,
          ladder: s.findings.walls?.ladder,
        }),
      );
      // The check's own Nansen calls belong in the evidence of this exposure.
      appendCalls(runId, walletCalls(body));
      setWalletState(WALLET_IDLE);
    } catch (err) {
      if (stateRef.current.runId !== runId) return;
      setWalletState({ pending: false, error: err instanceof Error ? err.message : "The wallet check failed." });
    }
  }, [appendCalls]);

  const onFindingStart = useCallback((n: FindingNo) => {
    setAnim((a) => (a.markers >= n ? a : { ...a, markers: n }));
    sound.beep();
  }, []);

  const openLab = useCallback((tab: LabTab) => setLab({ open: true, tab }), []);
  /** From the report header or the signage: the Summary tab. Markers and findings open their own tab. */
  const openLabSummary = useCallback(() => setLab({ open: true, tab: "summary" }), []);
  const closeLab = useCallback(() => setLab((l) => ({ ...l, open: false })), []);
  const onLabTab = useCallback((tab: LabTab) => setLab((l) => ({ ...l, tab })), []);
  const onPhase = useCallback((p: ExposurePhase) => {
    if (p === "charge") setArmed(true);
    else if (p === "flash" || p === "done") setArmed(false);
  }, []);
  const toggleSound = useCallback(() => setSoundOn(!soundOn), [setSoundOn, soundOn]);

  /* ------------------------------ derived view ------------------------------ */

  const replayed = state.mode === "replay";
  // Replays count the calls up with the beam (as in the mockup); live scans count real events.
  const shownTotals = useMemo(() => {
    const t = state.totals;
    if (!replayed) return t;
    const k = Math.min(1, anim.reveal * 1.05);
    return { ...t, calls: Math.round(t.calls * k), credits: Math.round(t.credits * k) };
  }, [state.totals, replayed, anim.reveal]);

  const f = state.findings;
  const allFindings = f.buyers && f.flow && f.walls && f.smart ? { buyers: f.buyers, flow: f.flow, walls: f.walls, smart: f.smart } : null;
  const reportScan = useMemo(
    () => ({
      meta: state.meta ?? undefined,
      totals: state.meta ? shownTotals : undefined,
      ...(report.gate && allFindings ? { findings: allFindings } : {}),
      ...(report.gate && state.diagnosis ? { diagnosis: state.diagnosis } : {}),
    }),
    // allFindings is rebuilt from the four finding identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.meta, shownTotals, report.gate, f.buyers, f.flow, f.walls, f.smart, state.diagnosis],
  );

  const liveRunning = state.mode === "live" && (state.status === "connecting" || state.status === "scanning");
  const reportStatus =
    state.status === "error"
      ? `X-ray interrupted: ${state.error?.message ?? "unknown error"}`
      : liveRunning && !report.gate
        ? (state.stage?.message ?? "Charging the tube…")
        : null;

  const walletUi: WalletUi = useMemo(() => {
    let disabledReason: string | null = null;
    // The synthetic preview answers any submission with its sample wallet (no credits).
    if (state.synthetic) disabledReason = state.status === "done" ? null : "Available when the scan finishes.";
    else if (!account.known) disabledReason = "Checking whether wallet checks are on…";
    else if (!account.liveEnabled) disabledReason = "Wallet checks need live x-rays, which are off here.";
    else if (!state.meta || state.status !== "done") disabledReason = "Available when the scan finishes.";
    return { enabled: disabledReason === null, pending: walletState.pending, error: walletState.error, disabledReason };
  }, [state.synthetic, state.meta, state.status, account.known, account.liveEnabled, walletState]);

  const intakeLive: IntakeLive = useMemo(
    () => ({ known: account.known, enabled: account.liveEnabled, quickCredits: account.quickCredits }),
    [account.known, account.liveEnabled, account.quickCredits],
  );

  const signNote = (() => {
    if (state.synthetic) return "synthetic preview · illustrative data · fictional token";
    if (state.mode === "replay" && state.meta) return `recorded ${reportDate(state.meta.scannedAt)} UTC · replayed for 0 credits`;
    if (state.mode === "live") {
      if (liveRunning) return `live x-ray · ${state.tier ?? "quick"} · ${state.totals.credits} credits so far`;
      if (state.status === "done") return `live x-ray · ${state.totals.credits} credits`;
    }
    return null;
  })();

  const canReplay = state.scan !== null;
  const takeLabel = !canReplay && cta && account.liveEnabled ? `Take the x-ray (≈${account.quickCredits} credits)` : "Take the x-ray";
  const takeDisabled = !canReplay && !(cta && account.liveEnabled);

  const activeKey = state.meta ? patientKey(state.meta.chain, state.meta.tokenAddress) : null;
  const deep =
    account.liveEnabled && !state.synthetic && state.meta && state.tier !== "deep" && !liveRunning
      ? { credits: deepEstimate(account, state.meta.chain), left: account.deepLeft, onStart: startDeep }
      : null;

  const showTotals = state.meta !== null;
  const evidence = showTotals ? evidenceLine(shownTotals) : "no exposure yet";

  /* ------------------------------ lightbox messages ------------------------------ */
  let lightboxCard: ReactNode = null;
  if (invalid) {
    lightboxCard = (
      <div className="lb-card" role="status">
        <b>Unreadable request</b>
        <p>{invalid}</p>
        <p className="lb-small">Pick a patient from the waiting room, or paste a token address in the intake.</p>
      </div>
    );
  } else if (cta && !state.meta) {
    lightboxCard = (
      <div className="lb-card">
        <b>No x-ray on file</b>
        <p>
          {shortAddr(cta.token)} · {chainLabel(cta.chain)}
        </p>
        {!account.known ? (
          <p className="lb-small">Checking the x-ray room…</p>
        ) : account.liveEnabled ? (
          <>
            <button type="button" className="btn lb-go" onClick={takeXray}>
              Take the x-ray (≈{account.quickCredits} credits)
            </button>
            <p className="lb-small">A quick live scan reads flows, smart money and recent buyers from the Nansen API.</p>
          </>
        ) : (
          <p className="lb-small">Live x-rays are off: pick a patient from the waiting room.</p>
        )}
      </div>
    );
  } else if (state.status === "error" && !state.meta) {
    lightboxCard = (
      <div className="lb-card" role="alert">
        <b>{state.budget ? "No live x-ray right now" : "The x-ray failed"}</b>
        <p>{state.error?.message}</p>
        {state.mode === "live" && state.error?.retryable && account.liveEnabled ? (
          <button type="button" className="btn lb-go" onClick={retryLive}>
            Try again (≈{state.tier === "deep" && state.target ? deepEstimate(account, state.target.chain) : account.quickCredits} credits)
          </button>
        ) : null}
      </div>
    );
  } else if (liveRunning && !state.meta) {
    lightboxCard = (
      <div className="lb-card lb-quiet" role="status">
        <p>{state.stage?.message ?? "Charging the tube…"}</p>
      </div>
    );
  }

  const budgetNote = state.budget?.message ?? null;

  return (
    <main className="room">
      {gated ? <CheckIn onDone={onCheckedIn} /> : null}

      <div className="scene" ref={sceneRef}>
        <Signage
          note={signNote}
          soundOn={soundOn}
          onToggleSound={toggleSound}
          onTakeXray={takeXray}
          takeLabel={takeLabel}
          takeDisabled={takeDisabled}
          onOpenLab={openLabSummary}
          labDisabled={!state.meta}
        />

        <div className="ward">
          <div className="lightbox">
            <span className="clip l" aria-hidden="true" />
            <span className="clip r" aria-hidden="true" />
            <Film
              meta={state.meta}
              price={state.price}
              bigBuys={anim.hold ? NO_BUYS : state.bigBuys}
              buyers={anim.hold ? null : f.buyers}
              flow={anim.hold ? null : f.flow}
              walls={anim.hold ? null : f.walls}
              smart={anim.hold ? null : f.smart}
              you={anim.hold ? null : you}
              reveal={anim.reveal}
              beam={anim.beam}
              merge={anim.merge}
              markers={anim.markers}
              focus={focus}
              onMarkerClick={openLab}
              className="film"
            />
            {lightboxCard}
          </div>

          <div className="clipboard">
            <span className="clamp" aria-hidden="true" />
            <Report
              key={report.key}
              scan={reportScan}
              you={you}
              mode={report.mode}
              onFindingStart={onFindingStart}
              onFindingClick={openLab}
              onFindingHover={setFocus}
              onWalletSubmit={onWalletSubmit}
              status={reportStatus}
              wallet={walletUi}
              exam={examLabel(state.tier ?? "deep")}
              synthetic={state.synthetic}
              onOpenLab={openLabSummary}
            />
          </div>
        </div>

        <div className="desk">
          <Intake
            patients={patients}
            live={intakeLive}
            armed={armed}
            ghost={ghost}
            notice={notice ?? budgetNote}
            onSubmit={admit}
            onActivate={takeOver}
          />
          <button type="button" className="evidence" onClick={() => openLab("evidence")} aria-label="Open the evidence: every Nansen API call">
            this exposure: <b>{evidence}</b>
            <br />
            <em>POWERED BY NANSEN API</em>
          </button>
        </div>

        <WaitingRoom patients={patients} activeKey={activeKey} loading={galleryLoading} onSelect={selectPatient} />
      </div>

      <ExposureOverlay ref={exposureRef} target={sceneRef} onPhase={onPhase} />

      <LabResults
        open={lab.open}
        tab={lab.tab}
        onTab={onLabTab}
        onClose={closeLab}
        meta={state.meta}
        tier={state.tier}
        findings={state.findings}
        diagnosis={state.diagnosis}
        calls={state.calls}
        totals={state.meta ? state.totals : null}
        you={you}
        wallet={walletUi}
        onWalletSubmit={onWalletSubmit}
        deep={deep}
        synthetic={state.synthetic}
        replayed={replayed}
        onFocusFinding={setFocus}
      />

      {director ? (
        <DirectorStage
          config={director}
          room={{ patients, initialScan, getScan, openLab, closeLab, setFocus, exposeScan: (scan: Scan) => expose({ kind: "scan", scan }, { url: false }) }}
        />
      ) : null}
    </main>
  );
}

export default Room;

/** Page title helper for /x/<chain>/<token>: "$KAIRO · Smart money is selling to the crowd." */
export function scanTitle(scan: Scan): string {
  return `${patientName(scan.meta)} · ${scan.diagnosis?.sentence ?? "x-ray"}`;
}
