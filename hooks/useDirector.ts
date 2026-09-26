"use client";

// Recording mode player (?rec=1): runs the script from components/exposure/DirectorScript against the
// room with no user input, using only recorded gallery scans (0 credits). One clock drives it: script
// time = real time since the start (or the "Click to start" plate) times the config's speed. Cues fire
// once, in order; the overlay view (title card, captions, ring, end card) is derived from that time.
//
// Tempo: the room's own animations (overlay flash, beam, typing, CSS animations) are sped up without
// touching their code by a page clock (TimeWarp) patched over performance.now, requestAnimationFrame,
// setTimeout and setInterval, installed only while a rate other than 1 is needed and removed on unmount.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LabTab } from "@/components/exposure/LabResults";
import type { Patient } from "@/components/exposure/WaitingRoom";
import {
  buildScript,
  directorView,
  pickSecond,
  REC,
  sameView,
  TimeWarp,
  type DirectorAction,
  type DirectorConfig,
  type DirectorScript,
  type DirectorView,
} from "@/components/exposure/DirectorScript";
import { sound } from "@/lib/exposure/sound";
import type { Scan } from "@/lib/xray/types";

export type { DirectorConfig } from "@/components/exposure/DirectorScript";

/** What the director may do in the room (Room.tsx hands these over; nothing else is touched). */
export interface DirectorRoom {
  patients: Patient[];
  /** The page's server-read scan (home: the featured patient). */
  initialScan: Scan | null;
  getScan: (p: Patient) => Promise<Scan | null>;
  /** One exposure of a recorded scan (flash, eyelids, beam, typed report); never syncs the URL. */
  exposeScan: (scan: Scan) => unknown;
  openLab: (tab: LabTab) => void;
  closeLab: () => void;
  setFocus: (n: 1 | 2 | 3 | 4 | 5 | null) => void;
}

export type DirectorPhase = "loading" | "ready" | "running" | "done" | "failed";

export interface DirectorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DirectorControls {
  phase: DirectorPhase;
  view: DirectorView;
  /** Patient B's waiting-room card (for the ring), measured when it is picked. */
  ring: DirectorRect | null;
  /** Title-card price line of patient A (0..1). */
  spark: number[];
  /** Starts the script (from the plate's click: the gesture also unlocks the sound). */
  start: () => void;
}

/* ------------------------------------------------------------------ clocks */

/** The real clock, even while performance.now is warped. */
function realNow(): number {
  if (typeof window === "undefined" || typeof Performance === "undefined") return Date.now();
  return Performance.prototype.now.call(window.performance);
}

export interface WarpHandle {
  readonly rate: number;
  setRate: (rate: number) => void;
  uninstall: () => void;
}

let activeWarp: WarpHandle | null = null;

/**
 * Patches the page clock so everything timed by performance.now, requestAnimationFrame, setTimeout or
 * setInterval runs `rate` times faster. Idempotent (a second call only changes the rate).
 */
export function installTimeWarp(rate: number): WarpHandle | null {
  if (typeof window === "undefined") return null;
  if (activeWarp) {
    activeWarp.setRate(rate);
    return activeWarp;
  }
  const w = window;
  const perf = w.performance;
  const hadOwnNow = Object.prototype.hasOwnProperty.call(perf, "now");
  const origNow = perf.now;
  const origTimeout = w.setTimeout;
  const origInterval = w.setInterval;
  const origRaf = w.requestAnimationFrame;
  const warp = new TimeWarp(realNow(), rate);

  const now = () => warp.map(realNow());
  const timeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]): number =>
    Reflect.apply(origTimeout, w, [handler, warp.delay(Number(ms) || 0), ...args])) as unknown as typeof w.setTimeout;
  const interval = ((handler: TimerHandler, ms?: number, ...args: unknown[]): number =>
    Reflect.apply(origInterval, w, [handler, warp.delay(Number(ms) || 0), ...args])) as unknown as typeof w.setInterval;
  const raf = ((cb: FrameRequestCallback) => origRaf.call(w, (ts: number) => cb(warp.map(ts)))) as typeof w.requestAnimationFrame;

  perf.now = now;
  w.setTimeout = timeout;
  w.setInterval = interval;
  w.requestAnimationFrame = raf;

  const handle: WarpHandle = {
    get rate() {
      return warp.rate;
    },
    setRate: (r: number) => warp.setRate(r, realNow()),
    uninstall: () => {
      if (perf.now === now) {
        if (hadOwnNow) perf.now = origNow;
        else Reflect.deleteProperty(perf, "now");
      }
      if (w.setTimeout === timeout) w.setTimeout = origTimeout;
      if (w.setInterval === interval) w.setInterval = origInterval;
      if (w.requestAnimationFrame === raf) w.requestAnimationFrame = origRaf;
      if (activeWarp === handle) activeWarp = null;
    },
  };
  activeWarp = handle;
  return handle;
}

/** CSS animations and transitions follow the page tempo (the director's own elements excepted). */
function syncAnimations(rate: number, exclude: Element | null): void {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return;
  for (const a of document.getAnimations()) {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    if (exclude && target && exclude.contains(target)) continue;
    if (a.playbackRate !== rate) a.playbackRate = rate;
  }
}

/* ------------------------------------------------------------------ the hook */

interface Cast {
  a: Scan;
  b: Scan | null;
  /** Patient B's index in the waiting room (-1 without B). */
  bIndex: number;
  script: DirectorScript;
}

const EMPTY_SCRIPT: DirectorScript = { duration: REC.duration, cues: [], captions: [], spark: [], hasB: false };

async function firstScan(patients: Patient[], getScan: DirectorRoom["getScan"]): Promise<Scan | null> {
  for (const p of patients) {
    const s = await getScan(p);
    if (s) return s;
  }
  return null;
}

/** `rootRef`: the director's own elements (their CSS animations are never sped up). */
export function useDirector(config: DirectorConfig, room: DirectorRoom, rootRef?: RefObject<HTMLElement | null>): DirectorControls {
  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  });

  const [cast, setCast] = useState<Cast | null>(null);
  const [failed, setFailed] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [view, setView] = useState<DirectorView>(() => directorView(EMPTY_SCRIPT, 0));
  const [ring, setRing] = useState<DirectorRect | null>(null);

  /** Cue indexes already fired (kept across effect re-runs so nothing fires twice). */
  const fired = useRef(new Set<number>());
  /** The tempo of the room relative to the script (the last "tempo" cue). */
  const tempo = useRef(1);

  // Cast: patient A (the page's scan) and B (the first waiting-room patient with a different
  // diagnosis), both recorded files. Autostart begins as soon as they are in.
  const patients = room.patients;
  const autostart = config.autostart;
  useEffect(() => {
    if (cast || !patients.length) return;
    let cancelled = false;
    void (async () => {
      const r = roomRef.current;
      try {
        const a = r.initialScan ?? (await firstScan(patients, r.getScan));
        if (!a) throw new Error("no recorded scan");
        const i = pickSecond(patients, { chain: a.meta.chain, tokenAddress: a.meta.tokenAddress, code: a.diagnosis?.code ?? null });
        const b = i >= 0 ? await r.getScan(patients[i]) : null;
        if (cancelled) return;
        setCast({ a, b, bIndex: b ? i : -1, script: buildScript(a, b) });
        if (autostart) setStartedAt(realNow());
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patients, cast, autostart]);

  const start = useCallback(() => {
    if (!cast || startedAt !== null) return;
    sound.unlock();
    setStartedAt(realNow());
  }, [cast, startedAt]);

  // The clock: one rAF loop from the start to the end card.
  const speed = config.speed;
  useEffect(() => {
    if (startedAt === null || !cast) return;
    const { script, a, b, bIndex } = cast;
    let warp: WarpHandle | null = null;
    let pageRate = speed * tempo.current;
    let synced = false;
    const applyRate = () => {
      if (pageRate !== 1 || warp) warp = installTimeWarp(pageRate);
      synced = false;
    };
    applyRate();

    const run = (action: DirectorAction) => {
      const r = roomRef.current;
      switch (action.type) {
        case "expose": {
          const scan = action.patient === "a" ? a : b;
          if (scan) void Promise.resolve(r.exposeScan(scan)).catch(() => {});
          return;
        }
        case "focus":
          r.setFocus(action.n);
          return;
        case "lab":
          r.openLab(action.tab);
          return;
        case "closeLab":
          r.closeLab();
          return;
        case "pick": {
          const card = bIndex >= 0 ? document.querySelectorAll<HTMLElement>(".queue .chart")[bIndex] : undefined;
          const box = card?.getBoundingClientRect();
          setRing(box ? { x: box.left, y: box.top, w: box.width, h: box.height } : null);
          return;
        }
        case "tempo":
          tempo.current = action.rate;
          pageRate = speed * action.rate;
          applyRate();
          return;
      }
    };

    let raf = 0;
    const tick = () => {
      const t = ((realNow() - startedAt) / 1000) * speed;
      script.cues.forEach((c, i) => {
        if (c.at > t || fired.current.has(i)) return;
        fired.current.add(i);
        run(c.action);
      });
      if (warp && (!synced || pageRate !== 1)) {
        syncAnimations(pageRate, rootRef?.current ?? null);
        synced = true;
      }
      const v = directorView(script, t);
      setView((prev) => (sameView(prev, v) ? prev : v));
      if (t > script.duration + 0.5) {
        setDone(true);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
      if (warp) {
        syncAnimations(1, null);
        warp.uninstall();
      }
    };
  }, [startedAt, cast, speed, rootRef]);

  const phase: DirectorPhase = failed ? "failed" : !cast ? "loading" : startedAt === null ? "ready" : done ? "done" : "running";
  return { phase, view, ring, spark: cast?.script.spark ?? [], start };
}
