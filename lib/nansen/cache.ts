// Disk cache for successful Nansen responses: .cache/nansen/<sha1(endpoint + stableJSON(key))>.json
// NANSEN_CACHE=snapshot never expires entries (gallery warm-up); NANSEN_CACHE=refresh ignores what is
// on disk but still writes fresh responses (re-warm on recording day); NANSEN_CACHE=off bypasses it.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheTtlFor } from "./endpoints";
import { nansenCacheDir } from "./paths";

export type CacheMode = "default" | "snapshot" | "refresh" | "off";

export interface CacheEntry<T = unknown> {
  v: 1;
  endpoint: string;
  /** unix ms when the network response was received */
  fetchedAt: number;
  status: number;
  /** Credits the original network call cost. */
  credits: number;
  /** Latency of the original network call. */
  ms: number;
  data: T;
}

export function cacheMode(): CacheMode {
  const v = (process.env.NANSEN_CACHE ?? "").trim().toLowerCase();
  if (v === "snapshot") return "snapshot";
  if (v === "refresh") return "refresh";
  if (v === "off" || v === "0" || v === "false") return "off";
  return "default";
}

export function cacheTtlMs(endpoint: string): number {
  return cacheTtlFor(endpoint);
}

/** JSON with object keys sorted recursively, so key order never changes the cache key. */
export function stableJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJSON(obj[k])}`).join(",")}}`;
}

export function cacheKey(endpoint: string, keyBody: unknown): string {
  return createHash("sha1").update(endpoint).update(stableJSON(keyBody)).digest("hex");
}

function fileFor(key: string): string {
  return path.join(nansenCacheDir(), `${key}.json`);
}

/** Endpoints with TTL 0 (e.g. `account`) are never cached, even in snapshot mode. */
export function isCacheable(endpoint: string, mode: CacheMode = cacheMode()): boolean {
  return mode !== "off" && cacheTtlMs(endpoint) > 0;
}

export async function readCache<T>(
  endpoint: string,
  keyBody: unknown,
  mode: CacheMode = cacheMode(),
): Promise<CacheEntry<T> | null> {
  if (mode === "refresh" || !isCacheable(endpoint, mode)) return null;
  let entry: CacheEntry<T>;
  try {
    entry = JSON.parse(await readFile(fileFor(cacheKey(endpoint, keyBody)), "utf8")) as CacheEntry<T>;
  } catch {
    return null;
  }
  if (entry?.v !== 1 || entry.endpoint !== endpoint) return null;
  if (mode === "snapshot") return entry;
  return Date.now() - entry.fetchedAt <= cacheTtlMs(endpoint) ? entry : null;
}

let dirReady = false;

/** Atomic write (tmp + rename); failures are logged and swallowed: the cache is best-effort. */
export async function writeCache<T>(
  endpoint: string,
  keyBody: unknown,
  entry: Omit<CacheEntry<T>, "v" | "endpoint">,
  mode: CacheMode = cacheMode(),
): Promise<void> {
  if (!isCacheable(endpoint, mode)) return;
  const file = fileFor(cacheKey(endpoint, keyBody));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload: CacheEntry<T> = { v: 1, endpoint, ...entry };
  try {
    if (!dirReady) {
      await mkdir(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, file);
  } catch (err) {
    console.warn(`[cache] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
