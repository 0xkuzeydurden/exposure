"use client";
// The "exposure" transition from the approved mockup: the tube charges (room dims), a white-blue
// flash fires, the content is swapped behind it, then the viewer wakes up: black eyelids part a
// little, droop once (a sleepy blink), then open fully while blur and darkness lift from the room.
//
//   const room = useRef<HTMLDivElement>(null);
//   const exposure = useExposure();
//   <div ref={room}>…the room…</div>
//   <ExposureOverlay ref={exposure.ref} target={room} />
//   await exposure.run(() => setPatient(next));   // resolves when the eyes are fully open
//
// The blur/brightness filter is applied to `target` (the room content), never to the overlay. Render
// the overlay OUTSIDE `target` (a sibling): a filter on an ancestor would blur the lids too and turn
// `position: fixed` into position-relative-to-the-room.
// With prefers-reduced-motion the sequence is skipped: onSwap runs and the promise resolves at once.
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type RefObject,
} from "react";
import { sound } from "@/lib/exposure/sound";
import { ease } from "@/lib/exposure/filmScale";

export type ExposurePhase = "charge" | "flash" | "swap" | "wake" | "done";

export interface ExposureHandle {
  /**
   * Play the sequence. `onSwap` runs at peak flash (a returned promise is awaited while the flash holds).
   * Calls made while a run is in flight do not restart it: before the swap they replace the pending
   * onSwap (latest wins), after it they run onSwap immediately. Every call resolves with the run.
   */
  run(onSwap: () => void | Promise<void>): Promise<void>;
  /** Jump to the end (swap if still pending, clear filters, resolve). */
  cancel(): void;
  readonly running: boolean;
}

export interface ExposureOverlayProps {
  ref?: Ref<ExposureHandle>;
  /** The element that gets blurred and darkened (the room content). */
  target: RefObject<HTMLElement | null>;
  /** "fixed" covers the viewport (default); "absolute" covers the nearest positioned ancestor. */
  position?: "fixed" | "absolute";
  zIndex?: number;
  onPhase?: (phase: ExposurePhase) => void;
  onRunningChange?: (running: boolean) => void;
  className?: string;
}

const LID_EDGE = 110; // soft gradient below/above each lid

function lidTransform(open: number, dir: -1 | 1): string {
  const pct = (dir * open * 101).toFixed(2);
  const px = (open * (LID_EDGE + 6)).toFixed(1);
  return `translate3d(0, calc(${pct}% ${dir < 0 ? "-" : "+"} ${px}px), 0)`;
}

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface EngineParts {
  root: RefObject<HTMLDivElement | null>;
  flash: RefObject<HTMLDivElement | null>;
  top: RefObject<HTMLDivElement | null>;
  bot: RefObject<HTMLDivElement | null>;
  /** Latest props (updated after every render). */
  props: RefObject<Pick<ExposureOverlayProps, "target" | "onPhase" | "onRunningChange">>;
}

/** Imperative sequence, kept outside React: it only writes styles on DOM nodes. */
class ExposureEngine implements ExposureHandle {
  private token = 0;
  private swapped = false;
  private pending: null | (() => void | Promise<void>) = null;
  private promise: Promise<void> | null = null;
  private _running = false;

  constructor(private readonly parts: EngineParts) {}

  get running() {
    return this._running;
  }

  private target(): HTMLElement | null {
    return this.parts.props.current.target.current;
  }

  private phase(p: ExposurePhase) {
    this.parts.props.current.onPhase?.(p);
  }

  private setRunning(on: boolean) {
    this._running = on;
    this.parts.props.current.onRunningChange?.(on);
  }

  private apply(lids: number | null, blur: number | null, bright: number | null, flash: number | null) {
    if (lids !== null) {
      const top = this.parts.top.current;
      const bot = this.parts.bot.current;
      if (top) top.style.transform = lidTransform(lids, -1);
      if (bot) bot.style.transform = lidTransform(lids, 1);
    }
    const fl = this.parts.flash.current;
    if (flash !== null && fl) fl.style.opacity = flash.toFixed(3);
    const t = this.target();
    if (t && (blur !== null || bright !== null)) {
      const f: string[] = [];
      if (blur !== null && blur > 0.01) f.push(`blur(${blur.toFixed(2)}px)`);
      if (bright !== null) f.push(`brightness(${bright.toFixed(3)})`);
      t.style.filter = f.join(" ");
    }
  }

  private reset() {
    const t = this.target();
    if (t) {
      t.style.filter = "";
      t.style.willChange = "";
    }
    this.apply(1, null, null, 0);
    const root = this.parts.root.current;
    if (root) root.style.visibility = "hidden";
  }

  private async swap() {
    if (this.swapped) return;
    this.swapped = true;
    const fn = this.pending;
    this.pending = null;
    this.phase("swap");
    if (fn) await fn();
  }

  /** rAF tween; resolves early (without calling fn) once the run was cancelled. */
  private tween(token: number, ms: number, fn: (k: number) => void, curve: (t: number) => number = ease.linear) {
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (this.token !== token) return resolve();
        const t = Math.min(1, (now - t0) / ms);
        fn(curve(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private async sequence(token: number) {
    const alive = () => this.token === token;
    const t = this.target();
    const root = this.parts.root.current;
    if (reducedMotion() || !t || !root) {
      await this.swap();
      return;
    }
    root.style.visibility = "visible";
    t.style.willChange = "filter";

    // 0. the tube charges; the room dims
    this.phase("charge");
    sound.charge();
    await this.tween(token, 420, (k) => this.apply(null, null, 1 - 0.5 * k, null));
    if (!alive()) return;

    // 1. the exposure: flash, swap the content behind it
    this.phase("flash");
    sound.shot();
    await this.tween(token, 100, (k) => this.apply(null, null, null, k));
    if (!alive()) return;
    await this.swap();
    if (!alive()) return;
    this.apply(0, 16, 0.3, 1);
    await this.wait(90);
    if (!alive()) return;
    await this.tween(token, 420, (k) => this.apply(null, null, null, 1 - k), ease.inOutCubic);
    if (!alive()) return;

    // 2. waking up: part, droop (one sleepy blink), pause, open while the room comes into focus
    this.phase("wake");
    await this.tween(token, 700, (k) => this.apply(0.22 * k, 16 - 5 * k, 0.3 + 0.16 * k, null), ease.inOutCubic);
    if (!alive()) return;
    await this.tween(
      token,
      260,
      (k) => this.apply(0.22 - 0.12 * k, 11 + 2 * k, 0.46 - 0.08 * k, null),
      ease.inOutCubic,
    );
    if (!alive()) return;
    await this.wait(120);
    if (!alive()) return;
    await this.tween(
      token,
      1300,
      (k) => this.apply(0.1 + 0.9 * k, 13 * (1 - k), 0.38 + 0.62 * k, null),
      ease.inOutCubic,
    );
  }

  run(onSwap: () => void | Promise<void>): Promise<void> {
    if (this._running && this.promise) {
      const inflight = this.promise;
      if (this.swapped)
        return Promise.resolve()
          .then(onSwap)
          .then(() => inflight);
      this.pending = onSwap;
      return inflight;
    }
    const token = ++this.token;
    this.swapped = false;
    this.pending = onSwap;
    this.setRunning(true);
    const p = this.sequence(token)
      .catch((err) => {
        console.error("[exposure] transition failed", err);
        return this.swap();
      })
      .finally(() => {
        if (this.token !== token) return;
        this.finish();
      });
    this.promise = p;
    return p;
  }

  private finish() {
    this.reset();
    this.promise = null;
    this.setRunning(false);
    this.phase("done");
  }

  cancel() {
    if (!this._running) return;
    this.token++; // pending tweens see the new token and resolve on their next frame
    void this.swap().finally(() => this.finish());
  }

  /** Unmount: stop without calling back into React, leave the room unfiltered. */
  dispose() {
    this.token++;
    this._running = false;
    this.promise = null;
    const t = this.target();
    if (t) {
      t.style.filter = "";
      t.style.willChange = "";
    }
  }
}

export function ExposureOverlay({
  ref,
  target,
  position = "fixed",
  zIndex = 60,
  onPhase,
  onRunningChange,
  className,
}: ExposureOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bot = useRef<HTMLDivElement>(null);
  const props = useRef({ target, onPhase, onRunningChange });
  useEffect(() => {
    props.current = { target, onPhase, onRunningChange };
  });

  const engine = useRef<ExposureEngine | null>(null);
  const getEngine = useCallback(() => {
    if (!engine.current) engine.current = new ExposureEngine({ root, flash, top, bot, props });
    return engine.current;
  }, []);
  useEffect(() => () => engine.current?.dispose(), []);

  useImperativeHandle(
    ref,
    () => ({
      run: (onSwap) => getEngine().run(onSwap),
      cancel: () => getEngine().cancel(),
      get running() {
        return engine.current?.running ?? false;
      },
    }),
    [getEngine],
  );

  const lid = (isTop: boolean): CSSProperties => ({
    position: "absolute",
    left: 0,
    right: 0,
    height: "50.5%",
    top: isTop ? 0 : undefined,
    bottom: isTop ? undefined : 0,
    background: "#010203",
    transform: lidTransform(1, isTop ? -1 : 1),
    willChange: "transform",
  });
  const edge = (isTop: boolean): CSSProperties => ({
    position: "absolute",
    left: 0,
    right: 0,
    height: LID_EDGE,
    top: isTop ? undefined : -LID_EDGE,
    bottom: isTop ? -LID_EDGE : undefined,
    background: isTop ? "linear-gradient(#010203, transparent)" : "linear-gradient(transparent, #010203)",
  });

  return (
    <div
      ref={root}
      aria-hidden="true"
      className={className}
      style={{ position, inset: 0, zIndex, pointerEvents: "none", overflow: "hidden", visibility: "hidden" }}
    >
      <div
        ref={flash}
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0,
          background: "radial-gradient(ellipse at 40% 42%, #ffffff 0%, #eef6ff 28%, #bcd3ea 60%, #5b7690 100%)",
        }}
      />
      <div ref={top} style={lid(true)}>
        <div style={edge(true)} />
      </div>
      <div ref={bot} style={lid(false)}>
        <div style={edge(false)} />
      </div>
    </div>
  );
}

/** Hook form: `const x = useExposure(); <ExposureOverlay ref={x.ref} target={room} />; await x.run(swap)`. */
export function useExposure(): {
  ref: RefObject<ExposureHandle | null>;
  run: (onSwap: () => void | Promise<void>) => Promise<void>;
  cancel: () => void;
  running: boolean;
} {
  const ref = useRef<ExposureHandle | null>(null);
  const [running, setRunning] = useState(false);
  const run = useCallback(async (onSwap: () => void | Promise<void>) => {
    const h = ref.current;
    if (!h) {
      await onSwap();
      return;
    }
    setRunning(true);
    try {
      await h.run(onSwap);
    } finally {
      if (!h.running) setRunning(false);
    }
  }, []);
  const cancel = useCallback(() => ref.current?.cancel(), []);
  return { ref, run, cancel, running };
}

export default ExposureOverlay;
