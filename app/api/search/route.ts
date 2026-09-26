import "server-only";
import type { NextRequest } from "next/server";
import { searchGeneral } from "@/lib/nansen/api";
import { isSupportedChain } from "@/lib/nansen/chains";
import { hasNansenKey } from "@/lib/nansen/client";
import { describeError } from "@/lib/nansen/errors";
import type { SearchApiResponse, TokenSearchResult } from "@/lib/pipeline/api-types";
import { clientIp, visitorKey } from "@/lib/xray/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-visitor autocomplete requests per minute (the shared Nansen rate limit also serves live scans). */
const SEARCH_PER_MIN = 30;
const WINDOW_MS = 60_000;
const LIMITER_KEY = Symbol.for("exposure.search-limiter");

/**
 * Addresses, ENS and .sol names are never forwarded: the intake handles pasted addresses itself, and
 * address lookups are the expensive kind of search (500 credits on the MCP twin). Scans never send an
 * address to search/general either: they look a token up in token-screener (lib/xray/pipeline/context.ts).
 */
function looksLikeAddress(q: string): boolean {
  return /^0x[0-9a-f]{4,}/i.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) || /\.(eth|sol)$/i.test(q);
}

/** Sliding one-minute window per hashed visitor; true when this request may go through. */
function allow(visitor: string, now = Date.now()): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, number[]> | undefined>;
  let m = g[LIMITER_KEY];
  if (!m) {
    m = new Map();
    g[LIMITER_KEY] = m;
  }
  const recent = (m.get(visitor) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= SEARCH_PER_MIN) {
    m.set(visitor, recent);
    return false;
  }
  recent.push(now);
  m.set(visitor, recent);
  if (m.size > 5000) {
    for (const [k, ts] of m) if (!ts.some((t) => now - t < WINDOW_MS)) m.delete(k);
  }
  return true;
}

/** GET /api/search?q=pepe[&chain=base] → tokens on chains the pipeline supports (search/general, 0 credits). */
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const chainParam = (request.nextUrl.searchParams.get("chain") ?? "").trim().toLowerCase();
  const chain = chainParam && isSupportedChain(chainParam) ? chainParam : undefined;

  if (!hasNansenKey()) return Response.json({ hasKey: false, results: [] } satisfies SearchApiResponse);
  if (q.length < 2 || looksLikeAddress(q)) return Response.json({ hasKey: true, results: [] } satisfies SearchApiResponse);
  if (!allow(visitorKey(clientIp(request.headers)))) {
    return Response.json({ hasKey: true, results: [], error: "Too many searches. Try again in a minute." } satisfies SearchApiResponse, {
      status: 429,
    });
  }

  try {
    const res = await searchGeneral(q, { chain, limit: 25, signal: request.signal });
    const results: TokenSearchResult[] = res.data.tokens
      .filter((t) => t.chain && t.address && isSupportedChain(t.chain))
      .map((t) => ({
        name: t.name ?? t.symbol ?? "",
        symbol: t.symbol ?? "",
        chain: t.chain as string,
        address: t.address as string,
        priceUsd: t.price,
        marketCapUsd: t.market_cap,
        ...(t.logo ? { logo: t.logo } : {}),
      }));
    return Response.json({ hasKey: true, results } satisfies SearchApiResponse);
  } catch (err) {
    return Response.json({ hasKey: true, results: [], error: describeError(err) } satisfies SearchApiResponse);
  }
}
