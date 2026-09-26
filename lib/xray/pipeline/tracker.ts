// Call bookkeeping for one scan: every Nansen call (network, cache hit or failure) becomes a
// CallRecord tagged with the finding it serves, and is emitted as {type:'call'} on that finding's lane.
import type { NansenRequestOptions, NansenResult } from "../../nansen/client";
import { knownCost } from "../../nansen/endpoints";
import { isAbortError, MissingKeyError, NansenError, NansenSchemaError } from "../../nansen/errors";
import type { CallRecord, FindingKey, ScanEvent } from "../types";

/** Errors that must stop the whole scan instead of degrading one finding. */
export function isFatal(err: unknown): boolean {
  return isAbortError(err) || err instanceof MissingKeyError || (err instanceof NansenError && err.isAccountLevel);
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Resolves to ok/error for recoverable failures; rethrows fatal ones (abort, no key, out of credits). */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => {
      if (isFatal(error)) throw error;
      return { ok: false as const, error };
    },
  );
}

/**
 * Ordered event lanes. The scan runs its finding stages concurrently, but the stream must read
 * stage -> calls -> finding for one finding at a time. A lane buffers its events until it is opened,
 * then flushes and goes live.
 */
export class Lane {
  private buffer: ScanEvent[] = [];
  private live = false;
  constructor(private readonly out: (e: ScanEvent) => void) {}
  emit(e: ScanEvent): void {
    if (this.live) this.out(e);
    else this.buffer.push(e);
  }
  open(): void {
    if (this.live) return;
    this.live = true;
    const pending = this.buffer;
    this.buffer = [];
    for (const e of pending) this.out(e);
  }
}

export interface DateWindowLike {
  label: string;
  from: string;
  to: string;
}

export interface TrackerOptions {
  signal: AbortSignal;
  /** Where a finding's call events go (its lane). */
  emit: (finding: FindingKey, e: ScanEvent) => void;
  /**
   * Gallery mode (warm-scans): a cache hit keeps the credits and latency of the original network
   * call, and `at` advances by that latency / concurrency, so a scan re-derived from the disk cache
   * shows what its data cost and replays with the rhythm of the original scan. Live scans leave this
   * off: there a cache hit costs 0, which is what the budget settles on.
   */
  virtualClock?: boolean;
  concurrency?: number;
  /**
   * Every call as soon as it is recorded, before the lane buffers it. The budget settles on this:
   * a scan that is aborted while a later finding's calls still sit in an unopened lane has spent them.
   */
  onCall?: (call: CallRecord) => void;
}

type CallOutcome = { status: number; credits: number; ms: number; cached: boolean; origin?: NansenResult<unknown>["origin"] };

export class CallTracker {
  readonly calls: CallRecord[] = [];
  private readonly started = performance.now();
  private virtualOffset = 0;
  /** Oldest fetchedAt of a cache hit per finding (gallery mode: how old the replayed data is). */
  private readonly oldestCached = new Map<FindingKey, number>();

  constructor(private readonly opts: TrackerOptions) {}

  get signal(): AbortSignal {
    return this.opts.signal;
  }

  elapsed(): number {
    return Math.round(performance.now() - this.started + this.virtualOffset);
  }

  record(finding: FindingKey, endpoint: string, r: CallOutcome): CallRecord {
    const origin = this.opts.virtualClock && r.cached ? r.origin : undefined;
    if (origin) this.virtualOffset += origin.ms / Math.max(1, this.opts.concurrency ?? 1);
    if (r.cached && r.origin && Number.isFinite(r.origin.fetchedAt)) {
      const prev = this.oldestCached.get(finding);
      if (prev === undefined || r.origin.fetchedAt < prev) this.oldestCached.set(finding, r.origin.fetchedAt);
    }
    const call: CallRecord = {
      endpoint,
      status: r.status,
      credits: origin ? origin.credits : r.credits,
      ms: origin ? origin.ms : r.ms,
      cached: r.cached,
      at: this.elapsed(),
      finding,
    };
    this.calls.push(call);
    try {
      this.opts.onCall?.(call);
    } catch {
      /* a broken listener must not kill the scan */
    }
    this.opts.emit(finding, { type: "call", call });
    return call;
  }

  /** Oldest fetch time (unix ms) among the cache hits of these findings, or null when none came from the cache. */
  oldestCachedAt(findings: FindingKey[]): number | null {
    let oldest: number | null = null;
    for (const f of findings) {
      const t = this.oldestCached.get(f);
      if (t !== undefined && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest;
  }

  /** One call; failures with an HTTP status are recorded (and rethrown). */
  async call<T>(
    finding: FindingKey,
    endpoint: string,
    cacheKey: unknown,
    fn: (o: NansenRequestOptions) => Promise<NansenResult<T>>,
  ): Promise<NansenResult<T>> {
    try {
      const res = await fn({ signal: this.opts.signal, cacheKey });
      this.record(finding, endpoint, res);
      return res;
    } catch (err) {
      if (err instanceof NansenError) this.record(finding, endpoint, failed(err));
      else if (err instanceof NansenSchemaError) this.record(finding, endpoint, unparsable(endpoint));
      throw err;
    }
  }

  /** Tries each date window in turn while the API says the range is too wide (invalid_date_range, query_timeout). */
  async callWindows<T, W extends DateWindowLike>(
    finding: FindingKey,
    endpoint: string,
    windows: W[],
    cacheKey: (w: W) => unknown,
    fn: (w: W, o: NansenRequestOptions) => Promise<NansenResult<T>>,
  ): Promise<NansenResult<T> & { window: W }> {
    for (let i = 0; ; i++) {
      const w = windows[i];
      const last = i >= windows.length - 1;
      try {
        const res = await fn(w, { signal: this.opts.signal, cacheKey: cacheKey(w) });
        this.record(finding, endpoint, res);
        return { ...res, window: w };
      } catch (err) {
        if (err instanceof NansenSchemaError) this.record(finding, endpoint, unparsable(endpoint));
        if (!(err instanceof NansenError)) throw err;
        this.record(finding, endpoint, failed(err));
        if (!(err.shouldNarrowRange && !last)) throw err;
      }
    }
  }

  totals(): { calls: number; networkCalls: number; credits: number; cacheHits: number; durationMs: number } {
    const calls = this.calls;
    return {
      calls: calls.length,
      networkCalls: calls.filter((c) => !c.cached).length,
      credits: calls.reduce((s, c) => s + c.credits, 0),
      cacheHits: calls.filter((c) => c.cached).length,
      durationMs: this.elapsed(),
    };
  }
}

function failed(err: NansenError): CallOutcome {
  return { status: err.status, credits: err.credits, ms: err.ms, cached: false };
}

/** A 200 whose body did not parse: it was (probably) billed, so count the documented cost. */
function unparsable(endpoint: string): CallOutcome {
  return { status: 200, credits: knownCost(endpoint), ms: 0, cached: false };
}
