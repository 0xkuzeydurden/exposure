// Typed errors for the Nansen client. Kept free of Node imports so UI code can `instanceof` them.

/** Thrown lazily when a network call is needed and NANSEN_API_KEY is not configured. */
export class MissingKeyError extends Error {
  readonly name = "MissingKeyError";
  constructor(message = "NANSEN_API_KEY is not set") {
    super(message);
  }
}

/** Non-2xx response from the Nansen API (after retries were exhausted or not applicable). */
export class NansenError extends Error {
  readonly name = "NansenError";
  /** HTTP status, or 0 for network / timeout failures. */
  readonly status: number;
  /** Stable machine-readable code from the error envelope (e.g. "invalid_date_range"). */
  readonly code: string | null;
  readonly endpoint: string;
  /** Parsed JSON body when available, otherwise the raw text. */
  readonly body: unknown;
  /** Credits the failed request was billed (usually 0). */
  readonly credits: number;
  /** Latency of the last attempt. */
  readonly ms: number;
  readonly requestId: string | null;

  constructor(init: {
    endpoint: string;
    status: number;
    code?: string | null;
    message: string;
    body?: unknown;
    credits?: number;
    ms?: number;
    requestId?: string | null;
  }) {
    super(init.message);
    this.endpoint = init.endpoint;
    this.status = init.status;
    this.code = init.code ?? null;
    this.body = init.body;
    this.credits = init.credits ?? 0;
    this.ms = init.ms ?? 0;
    this.requestId = init.requestId ?? null;
  }

  get isInvalidDateRange(): boolean {
    if (this.code === "invalid_date_range") return true;
    const text = typeof this.body === "string" ? this.body : JSON.stringify(this.body ?? "");
    return /invalid_date_range/i.test(text);
  }

  /** The query was too wide for the API: retry with a narrower date window. */
  get shouldNarrowRange(): boolean {
    return this.isInvalidDateRange || this.code === "query_timeout" || this.code === "query_too_large";
  }

  /** Key / plan / credit problems: every further call would fail the same way. */
  get isAccountLevel(): boolean {
    return (
      this.status === 401 ||
      this.status === 402 ||
      ["unauthenticated", "insufficient_credits", "plan_upgrade_required", "geo_blocked"].includes(this.code ?? "")
    );
  }

  /**
   * 403: the plan cannot use this endpoint (or the credit limit is exceeded). Fatal for an endpoint
   * the build depends on, but optional endpoints (e.g. flow-intelligence) may simply be skipped.
   */
  get isForbidden(): boolean {
    return this.status === 403 || this.code === "forbidden";
  }

  /** Worth retrying later (rate limit, upstream trouble, network). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The response did not match the (lenient) schema, usually an API shape change. */
export class NansenSchemaError extends Error {
  readonly name = "NansenSchemaError";
  constructor(
    readonly endpoint: string,
    readonly issues: string,
  ) {
    super(`Unexpected response shape from ${endpoint}: ${issues}`);
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name: string }).name === "AbortError")
  );
}

/** Short human-readable description for logs / SSE error events. Never includes secrets. */
export function describeError(err: unknown): string {
  if (err instanceof NansenError) {
    const code = err.code ? ` ${err.code}` : "";
    return `${err.endpoint} failed (${err.status || "network"}${code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
