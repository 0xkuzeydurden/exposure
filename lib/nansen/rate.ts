// FIFO token bucket: `ratePerMin` sustained requests with a small burst, plus a global pause
// after a 429 (the limit is per API key, so every caller must back off together).

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly capacity: number;
  private readonly perMs: number;

  constructor(readonly ratePerMin: number, capacity?: number) {
    this.perMs = ratePerMin / 60_000;
    this.capacity = capacity ?? Math.max(1, Math.min(20, Math.round((ratePerMin / 60) * 2)));
    this.tokens = this.capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
  }

  /** Stop handing out tokens until `until` (unix ms). */
  pause(until: number): void {
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.tokens = 0;
    }
  }

  /** Resolves when one request may be sent. Waiters are served in arrival order. */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.take(signal));
    // A cancelled waiter must not block the ones behind it.
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now, signal);
        this.last = Date.now();
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.tokens) / this.perMs), signal);
    }
  }
}
