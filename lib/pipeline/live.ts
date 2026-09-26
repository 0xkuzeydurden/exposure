// Guards around live (credit-spending) builds: an explicit opt-in outside development, and one
// shared build per token so extra tabs or a quick reload attach to the build already running.
import type { SceneEvent } from "../types";
import { BuildError } from "./build";

export const LIVE_DISABLED_MESSAGE =
  "Live builds are switched off on this server (set EXPOSURE_LIVE=1 to allow them). Gallery replays still work.";

/**
 * Live builds and wallet probes spend Nansen credits. They run by default in development
 * (`next dev`, CLI scripts); a production server needs EXPOSURE_LIVE=1. EXPOSURE_LIVE=0 always
 * disables them.
 */
export function liveBuildsAllowed(): boolean {
  const flag = (process.env.EXPOSURE_LIVE ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

/** How long a build with no connected client keeps running before it is cancelled. */
const DETACHED_GRACE_MS = 15_000;

interface SharedBuild {
  events: SceneEvent[];
  listeners: Set<LiveListener>;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

export interface LiveListener {
  event(e: SceneEvent): void;
  /** The build settled (after its terminal `done` / `error` event, if any). */
  end(): void;
}

const REGISTRY_KEY = Symbol.for("exposure.live.builds");

// On globalThis so every route bundle in one server process shares the same registry.
function registry(): Map<string, SharedBuild> {
  const g = globalThis as unknown as Record<symbol, Map<string, SharedBuild> | undefined>;
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

/**
 * Subscribes to the build identified by `key`, starting it with `run` if none is in flight. A late
 * subscriber first receives every event emitted so far. Returns an unsubscribe function; when the
 * last subscriber leaves, the build is cancelled after a short grace period.
 */
export function joinLiveBuild(
  key: string,
  run: (onEvent: (e: SceneEvent) => void, signal: AbortSignal) => Promise<unknown>,
  listener: LiveListener,
): () => void {
  const builds = registry();
  let build = builds.get(key);

  if (!build) {
    const entry: SharedBuild = { events: [], listeners: new Set(), abort: new AbortController(), idle: null, finished: false };
    builds.set(key, entry);
    const emit = (e: SceneEvent) => {
      entry.events.push(e);
      for (const l of [...entry.listeners]) deliver(() => l.event(e));
    };
    run(emit, entry.abort.signal)
      .catch((err: unknown) => {
        if (entry.abort.signal.aborted || err instanceof BuildError) return;
        emit({ type: "error", message: err instanceof Error ? err.message : String(err), retryable: true });
      })
      .finally(() => {
        entry.finished = true;
        if (entry.idle) clearTimeout(entry.idle);
        if (builds.get(key) === entry) builds.delete(key);
        for (const l of [...entry.listeners]) deliver(() => l.end());
        entry.listeners.clear();
      });
    build = entry;
  }

  const shared = build;
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
