// One live scan per (token, tier) per server: extra tabs or a quick reload attach to the scan already
// running (and first receive every event emitted so far) instead of spending credits again.
// Same pattern as lib/pipeline/live.ts, typed for ScanEvent.
import type { ScanEvent } from "../types";
import { ScanError } from "./run";

/** How long a scan with no connected client keeps running before it is cancelled. */
const DETACHED_GRACE_MS = 15_000;

interface SharedScan {
  events: ScanEvent[];
  listeners: Set<ScanListener>;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

export interface ScanListener {
  event(e: ScanEvent): void;
  /** The scan settled (after its terminal done / error event, if any). */
  end(): void;
}

const REGISTRY_KEY = Symbol.for("exposure.shared-scans");

function registry(): Map<string, SharedScan> {
  const g = globalThis as unknown as Record<symbol, Map<string, SharedScan> | undefined>;
  let m = g[REGISTRY_KEY];
  if (!m) {
    m = new Map();
    g[REGISTRY_KEY] = m;
  }
  return m;
}

function deliver(fn: () => void): void {
  try {
    fn();
  } catch {
    /* one broken stream must not affect the others */
  }
}

export function sharedScanKey(chainTokenId: string, tier: string): string {
  return `${chainTokenId}|${tier}`;
}

/** True while a scan for `key` is in flight (joining it spends nothing). */
export function hasSharedScan(key: string): boolean {
  const s = registry().get(key);
  return !!s && !s.finished;
}

/**
 * Subscribes to the scan identified by `key`, starting it with `run` if none is in flight. Returns an
 * unsubscribe function; when the last subscriber leaves, the scan is cancelled after a grace period.
 */
export function joinSharedScan(
  key: string,
  run: (onEvent: (e: ScanEvent) => void, signal: AbortSignal) => Promise<unknown>,
  listener: ScanListener,
): () => void {
  const scans = registry();
  let scan = scans.get(key);

  if (!scan) {
    const entry: SharedScan = { events: [], listeners: new Set(), abort: new AbortController(), idle: null, finished: false };
    scans.set(key, entry);
    const emit = (e: ScanEvent) => {
      entry.events.push(e);
      for (const l of [...entry.listeners]) deliver(() => l.event(e));
    };
    run(emit, entry.abort.signal)
      .catch((err: unknown) => {
        if (entry.abort.signal.aborted || err instanceof ScanError) return;
        emit({ type: "error", message: err instanceof Error ? err.message : String(err), retryable: true });
      })
      .finally(() => {
        entry.finished = true;
        if (entry.idle) clearTimeout(entry.idle);
        if (scans.get(key) === entry) scans.delete(key);
        for (const l of [...entry.listeners]) deliver(() => l.end());
        entry.listeners.clear();
      });
    scan = entry;
  }

  const shared = scan;
  if (shared.idle) {
    clearTimeout(shared.idle);
    shared.idle = null;
  }
  for (const e of shared.events) deliver(() => listener.event(e));
  if (shared.finished) {
    deliver(() => listener.end());
    return () => {};
  }
  shared.listeners.add(listener);

  return () => {
    if (!shared.listeners.delete(listener) || shared.finished || shared.listeners.size > 0) return;
    shared.idle = setTimeout(() => {
      shared.idle = null;
      if (shared.listeners.size === 0 && !shared.finished) shared.abort.abort();
    }, DETACHED_GRACE_MS);
  };
}
