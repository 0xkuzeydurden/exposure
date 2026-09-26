// The radiology report's typewriter: async, cancellable, character by character. Pure (no DOM, no
// audio): the key sound is injected through onKey (the report passes lib/exposure/sound's `key`,
// which clicks on every 2nd non-space character).

/** ms per character for findings (the mockup's 13ms). */
export const TYPE_SPEED_MS = 13;
/** ms per character for the impression sentence (slower, weightier). */
export const IMPRESSION_SPEED_MS = 38;
/** "." and ":" hold the carriage this many times longer (only at a sentence/label end). */
export const PAUSE_FACTOR = 5;
/** Caret lingers at a line end, then the bell rings, then this pause. */
export const LINE_END_CARET_MS = 140;
export const LINE_END_AFTER_BELL_MS = 160;

export class TypingCancelled extends Error {
  constructor() {
    super("typing cancelled");
    this.name = "TypingCancelled";
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof TypingCancelled || (err instanceof Error && err.name === "TypingCancelled");
}

/** setTimeout as a promise that rejects with TypingCancelled when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TypingCancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TypingCancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves once `pred()` is true (polled), rejects with TypingCancelled on abort. */
export async function waitFor(pred: () => boolean, signal?: AbortSignal, pollMs = 60): Promise<void> {
  while (!pred()) await sleep(pollMs, signal);
}

/** Delay after character i of `text`: long on "." / ":" that end a sentence or label, else `speed`. */
export function charDelay(text: string, i: number, speed: number): number {
  const ch = text[i];
  if (ch !== "." && ch !== ":") return speed;
  const next = text[i + 1];
  // "$0.030" or "2.3×" must not stall mid-number.
  return next === undefined || /\s/.test(next) ? speed * PAUSE_FACTOR : speed;
}

export interface TypeOptions {
  /** ms per character; default TYPE_SPEED_MS. */
  speed?: number;
  signal?: AbortSignal;
  /** Called after each character with how many characters of `text` are now visible. */
  onProgress: (shown: number) => void;
  /** Called for every character typed (sound.key thins it to every 2nd non-space character). */
  onKey?: (ch: string) => void;
  /** Start from this many characters already shown (resume). */
  from?: number;
}

/** Types `text` one character at a time. Resolves when complete; rejects with TypingCancelled on abort. */
export async function typeText(text: string, opts: TypeOptions): Promise<void> {
  const speed = opts.speed ?? TYPE_SPEED_MS;
  for (let i = Math.max(0, opts.from ?? 0); i < text.length; i++) {
    if (opts.signal?.aborted) throw new TypingCancelled();
    opts.onProgress(i + 1);
    opts.onKey?.(text[i]);
    await sleep(charDelay(text, i, speed), opts.signal);
  }
}

/** Total time typeText needs for `text` (for timelines / tests). */
export function typingDuration(text: string, speed = TYPE_SPEED_MS): number {
  let ms = 0;
  for (let i = 0; i < text.length; i++) ms += charDelay(text, i, speed);
  return ms;
}
