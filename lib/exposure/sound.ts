// EXPOSURE sound engine: every effect is synthesised with Web Audio (no files), ported from the
// approved mockup. Safe everywhere: no-ops on the server, without AudioContext, while the context is
// suspended (before the first user gesture) and when the viewer switched sound off.
//
//   import { sound } from "@/lib/exposure/sound";
//   sound.unlock();            // inside any click/keydown handler (also done automatically on the first gesture)
//   sound.charge(); sound.shot(); sound.key(ch); sound.ding(); sound.beep(); sound.stamp();
//   const [on, setOn] = useSoundEnabled();
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "exposure:sound";

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled: boolean | null = null; // lazily read from localStorage
const listeners = new Set<() => void>();

function ctor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function readPref(): boolean {
  if (enabled !== null) return enabled;
  let on = true;
  try {
    const v = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (v === "off") on = false;
  } catch {
    /* storage blocked: default on */
  }
  enabled = on;
  return on;
}

/** Create/resume the AudioContext. Must run inside a user gesture the first time (browser autoplay rules). */
export function unlock(): void {
  if (!readPref()) return;
  const C = ctor();
  if (!C) return;
  try {
    if (!ctx) {
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
      // iOS Safari: a (silent) buffer started inside the gesture unlocks output.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {
    ctx = null;
    master = null;
  }
}

let autoInstalled = false;
/** Unlock on the first pointer/key gesture anywhere on the page. Idempotent; runs on import in the browser. */
export function installAutoUnlock(): void {
  if (autoInstalled || typeof window === "undefined") return;
  autoInstalled = true;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const handler = () => {
    unlock();
    if (ctx && ctx.state === "running") for (const e of events) window.removeEventListener(e, handler, true);
  };
  for (const e of events) window.addEventListener(e, handler, { capture: true, passive: true });
}

function live(): AudioContext | null {
  if (!readPref() || !ctx || !master || !noiseBuf) return null;
  return ctx.state === "running" ? ctx : null;
}

/* ---- primitives (identical to the mockup) ---- */

function env(g: GainNode, t: number, a: number, peak: number, dur: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function noise(c: AudioContext, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number) {
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  env(g, t, 0.002, peak, dur);
  s.connect(f).connect(g).connect(master!);
  s.start(t, Math.random() * 0.3);
  s.stop(t + dur + 0.02);
}

function tone(c: AudioContext, t: number, freq: number, dur: number, type: OscillatorType, peak: number, to?: number) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  env(g, t, 0.01, peak, dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const guard = (fn: (c: AudioContext, t: number) => void) => () => {
  const c = live();
  if (!c) return;
  try {
    fn(c, c.currentTime);
  } catch {
    /* never let a sound break the UI */
  }
};

/* ---- effects ---- */

/** X-ray tube charging: rising whine (~0.55s). */
export const charge = guard((c, t) => {
  tone(c, t, 160, 0.55, "triangle", 0.035, 1400);
  tone(c, t, 320, 0.55, "sine", 0.02, 2600);
});

/** The exposure: thump + noise burst. */
export const shot = guard((c, t) => {
  noise(c, t, 0.16, "lowpass", 900, 0.7, 0.35);
  tone(c, t, 90, 0.3, "sine", 0.45, 45);
  tone(c, t + 0.05, 55, 0.5, "sawtooth", 0.03);
});

let keyCount = 0;
let lastKey = -1;
/**
 * Typewriter key. Call it for every typed character: whitespace is silent, at most every 2nd character
 * clicks (and never closer than 24ms), with a slightly random pitch.
 */
export function key(ch?: string): void {
  if (ch !== undefined && /\s/.test(ch)) return;
  keyCount++;
  if (keyCount % 2 === 0) return;
  const c = live();
  if (!c) return;
  const t = c.currentTime;
  if (t - lastKey < 0.024) return;
  lastKey = t;
  try {
    noise(c, t, 0.028, "bandpass", 1800 + Math.random() * 1600, 1.4, 0.16);
    tone(c, t, 140 + Math.random() * 40, 0.03, "square", 0.012);
  } catch {
    /* ignore */
  }
}

/** Typewriter bell at the end of a line. */
export const ding = guard((c, t) => {
  tone(c, t, 2093, 0.9, "sine", 0.05);
  tone(c, t, 3136, 0.6, "sine", 0.02);
  noise(c, t + 0.06, 0.18, "highpass", 2500, 0.5, 0.05);
});

/** Patient-monitor beep when a marker lights. */
export const beep = guard((c, t) => {
  tone(c, t, 988, 0.13, "sine", 0.06);
});

/** Rubber stamp. */
export const stamp = guard((c, t) => {
  noise(c, t, 0.12, "lowpass", 500, 0.8, 0.4);
  tone(c, t, 110, 0.18, "sine", 0.35, 60);
});

/* ---- on/off preference ---- */

export function isSoundEnabled(): boolean {
  return readPref();
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  if (master && ctx) {
    try {
      master.gain.setValueAtTime(on ? 1 : 0, ctx.currentTime);
    } catch {
      /* ignore */
    }
  }
  if (on) unlock(); // the toggle click is a user gesture
  for (const l of listeners) l();
}

export function toggleSound(): void {
  setSoundEnabled(!readPref());
}

export function subscribeSound(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React binding for the Sound on/off button. Server snapshot is "on". */
export function useSoundEnabled(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeSound, isSoundEnabled, () => true);
  return [on, setSoundEnabled];
}

export const sound = {
  charge,
  shot,
  key,
  ding,
  beep,
  stamp,
  unlock,
  get enabled() {
    return readPref();
  },
  setEnabled: setSoundEnabled,
  toggle: toggleSound,
  subscribe: subscribeSound,
};

if (typeof window !== "undefined") installAutoUnlock();
