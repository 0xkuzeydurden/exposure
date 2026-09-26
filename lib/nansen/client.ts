// Nansen API client: disk cache → token bucket → bounded concurrency → fetch with timeout/retries.
// Server-side only (reads the API key from the environment). No 'server-only' import here because
// the CLI scripts run it under tsx; the app/api route files import 'server-only' instead.
import pLimit, { type LimitFunction } from "p-limit";
import { cacheMode, readCache, writeCache, type CacheMode } from "./cache";
import { knownCost, normalizeEndpoint } from "./endpoints";
import { MissingKeyError, NansenError } from "./errors";
import { recordCall, setCreditsRemaining } from "./ledger";
import { sleep, TokenBucket } from "./rate";

export interface NansenRequestOptions {
  /** Caller cancellation (e.g. the SSE client disconnected). */
  signal?: AbortSignal;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Retries for 5xx / network / timeout failures. Default 3. */
  retries?: number;
  /** Overrides NANSEN_CACHE for this call. */
  cache?: CacheMode;
  /**
   * Stable identity for the disk cache when the body contains volatile values (e.g. "today").
   * Defaults to the request body.
   */
  cacheKey?: unknown;
}

export interface NansenResult<T> {
  data: T;
  /** Credits charged for this call (0 for cache hits). */
  credits: number;
  /** Latency of the successful attempt, or of the cache read. */
  ms: number;
  cached: boolean;
  status: number;
  requestId: string | null;
  /** For cache hits: what the original network call cost. */
  origin?: { fetchedAt: number; credits: number; ms: number };
}

interface ClientState {
  bucket: TokenBucket;
  limit: LimitFunction;
}

const STATE_KEY = Symbol.for("exposure.nansen.client");
const DEFAULT_BASE = "https://api.nansen.ai";
const MAX_RATE_LIMIT_RETRIES = 8;
/**
 * A request we abandoned on timeout may still be billed server-side: it is never retried (a retry
 * could bill twice), and it is counted at its documented cost so the budget stays conservative.
 */
const MAX_TIMEOUT_RETRIES = 0;
/** Errors that mean "this query is too wide": the caller narrows the date window instead of retrying. */
const NARROW_RANGE_CODES = new Set(["query_timeout", "query_too_large", "invalid_date_range"]);

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Shared on globalThis so all route bundles in one Next.js server respect a single rate limit.
function clientState(): ClientState {
  const g = globalThis as unknown as Record<symbol, ClientState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = {
      bucket: new TokenBucket(envInt("NANSEN_RATE_PER_MIN", 280)),
      limit: pLimit(envInt("NANSEN_CONCURRENCY", 6)),
    };
    g[STATE_KEY] = s;
  }
  return s;
}

/** Scripts may override the env-derived limits before the first call. */
export function configureNansenClient(opts: { ratePerMin?: number; concurrency?: number }): void {
  const s = clientState();
  if (opts.ratePerMin && opts.ratePerMin > 0) s.bucket = new TokenBucket(opts.ratePerMin);
  if (opts.concurrency && opts.concurrency > 0) s.limit.concurrency = opts.concurrency;
}

export function nansenConcurrency(): number {
  return clientState().limit.concurrency;
}

export function hasNansenKey(): boolean {
  return (process.env.NANSEN_API_KEY ?? "").trim().length > 0;
}

function apiKey(): string {
  const key = (process.env.NANSEN_API_KEY ?? "").trim();
  if (!key) throw new MissingKeyError();
  return key;
}

function baseUrl(): string {
  return (process.env.NANSEN_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Credits actually deducted if reported, else the quoted cost, else the documented cost. */
function creditsFor(headers: Headers, endpoint: string, ok: boolean): number {
  const used = headerNumber(headers, "x-nansen-credits-used");
  if (used !== null) return used;
  if (!ok) return 0;
  return headerNumber(headers, "x-nansen-credits-cost") ?? knownCost(endpoint);
}

/** Seconds to wait from Retry-After (delta or HTTP date), the body, or the RateLimit-Reset headers. */
function retryAfterMs(headers: Headers, body: unknown): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (body && typeof body === "object" && "retry_after" in body) {
    const secs = Number((body as { retry_after: unknown }).retry_after);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  const reset = headerNumber(headers, "ratelimit-reset") ?? headerNumber(headers, "x-ratelimit-reset");
  return reset !== null ? Math.max(0, reset * 1000) : null;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string" && b.message) return b.message;
    if (typeof b.detail === "string" && b.detail) return b.detail;
    if (b.detail !== undefined) return JSON.stringify(b.detail).slice(0, 400);
    if (typeof b.error === "string" && b.error) return b.error;
  }
  if (typeof body === "string" && body) return body.slice(0, 400);
  return fallback;
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") {
    return (body as { code: string }).code;
  }
  return null;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

type Attempt =
  | { kind: "response"; status: number; headers: Headers; body: unknown; ms: number }
  | { kind: "network"; error: unknown; ms: number; timedOut: boolean };

async function attemptOnce(
  method: "GET" | "POST",
  url: string,
  key: string,
  body: unknown,
  opts: NansenRequestOptions,
): Promise<Attempt> {
  const { bucket } = clientState();
  await bucket.acquire(opts.signal);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: key,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal,
      cache: "no-store",
    });
    const text = await res.text();
    return {
      kind: "response",
      status: res.status,
      headers: res.headers,
      body: parseBody(text),
      ms: Math.round(performance.now() - t0),
    };
  } catch (error) {
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    return { kind: "network", error, ms: Math.round(performance.now() - t0), timedOut: timeout.aborted };
  }
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: NansenRequestOptions = {},
): Promise<NansenResult<T>> {
  const endpoint = normalizeEndpoint(path);
  const mode = opts.cache ?? cacheMode();
  const keyBody = opts.cacheKey ?? body ?? null;
  if (opts.signal?.aborted) throw abortReason(opts.signal);

  const t0 = performance.now();
  const hit = await readCache<T>(endpoint, keyBody, mode);
  if (hit) {
    const ms = Math.round(performance.now() - t0);
    recordCall({ endpoint, status: hit.status, credits: 0, ms, cached: true });
    return {
      data: hit.data,
      credits: 0,
      ms,
      cached: true,
      status: hit.status,
      requestId: null,
      origin: { fetchedAt: hit.fetchedAt, credits: hit.credits, ms: hit.ms },
    };
  }

  const key = apiKey();
  const url = `${baseUrl()}/api/v1/${endpoint}`;
  const maxRetries = opts.retries ?? 3;
  let serverRetries = 0;
  let rateRetries = 0;
  let timeoutRetries = 0;

  for (;;) {
    const attempt = await clientState().limit(() => attemptOnce(method, url, key, body, opts));

    if (attempt.kind === "network") {
      const code = attempt.timedOut ? "timeout" : "network";
      // A timed-out request reached the server and may have been billed: count its documented cost.
      const maybeBilled = attempt.timedOut ? knownCost(endpoint) : 0;
      recordCall({ endpoint, status: 0, credits: maybeBilled, ms: attempt.ms, cached: false, code });
      const canRetry = attempt.timedOut ? timeoutRetries++ < MAX_TIMEOUT_RETRIES : true;
      if (canRetry && serverRetries < maxRetries) {
        await sleep(backoffMs(serverRetries++), opts.signal);
        continue;
      }
      const reason = attempt.timedOut
        ? `no response within ${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s`
        : attempt.error instanceof Error
          ? attempt.error.message
          : String(attempt.error);
      throw new NansenError({ endpoint, status: 0, code, message: `Network error: ${reason}`, credits: maybeBilled, ms: attempt.ms });
    }

    const { status, headers, body: resBody, ms } = attempt;
    const ok = status >= 200 && status < 300;
    const credits = creditsFor(headers, endpoint, ok);
    const code = ok ? undefined : (errorCode(resBody) ?? undefined);
    recordCall({ endpoint, status, credits, ms, cached: false, ...(code ? { code } : {}) });
    setCreditsRemaining(headerNumber(headers, "x-nansen-credits-remaining"));
    const requestId = headers.get("x-request-id");

    if (ok) {
      if (typeof resBody === "string") {
        throw new NansenError({ endpoint, status, code: "invalid_json", message: "Response was not JSON", body: resBody, credits, ms, requestId });
      }
      await writeCache(endpoint, keyBody, { fetchedAt: Date.now(), status, credits, ms, data: resBody }, mode);
      return { data: resBody as T, credits, ms, cached: false, status, requestId };
    }

    if (status === 429 && rateRetries < MAX_RATE_LIMIT_RETRIES) {
      const wait = retryAfterMs(headers, resBody) ?? Math.min(30_000, 2_000 * 2 ** rateRetries);
      rateRetries++;
      clientState().bucket.pause(Date.now() + wait);
      await sleep(wait + Math.random() * 250, opts.signal);
      continue;
    }

    // A query that timed out or was too large upstream fails the same way again: let the caller narrow it.
    if (status >= 500 && serverRetries < maxRetries && !NARROW_RANGE_CODES.has(code ?? "")) {
      const wait = retryAfterMs(headers, resBody) ?? backoffMs(serverRetries);
      serverRetries++;
      await sleep(wait, opts.signal);
      continue;
    }

    throw new NansenError({
      endpoint,
      status,
      code: errorCode(resBody),
      message: errorMessage(resBody, `HTTP ${status}`),
      body: resBody,
      credits,
      ms,
      requestId,
    });
  }
}

function backoffMs(n: number): number {
  return Math.min(10_000, 500 * 2 ** n) + Math.random() * 250;
}

export function nansenPost<T = unknown>(path: string, body: unknown, opts?: NansenRequestOptions): Promise<NansenResult<T>> {
  return request<T>("POST", path, body, opts);
}

export function nansenGet<T = unknown>(path: string, opts?: NansenRequestOptions): Promise<NansenResult<T>> {
  return request<T>("GET", path, undefined, opts);
}
