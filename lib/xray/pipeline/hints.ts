// Token facts a caller already holds, passed to runScan (opts.hints) so the context stage can fill
// what tgm/token-information left empty (young tokens often come back with name "", symbol "",
// market cap 0, supply 0, liquidity 0) without another call. The usual source is the token-screener
// row the gallery shortlist already paid for: scripts/warm-scans.ts --hints=<file> | --hints=cache.
// Without hints the scan looks the token up in token-screener itself (1 credit, see ./context.ts);
// both paths turn a screener row into hints with hintsFromScreenerRow.
// Parsing is pure; the two loaders only read local JSON files (never the network).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isEvmChain } from "../../nansen/chains";
import { TokenScreenerRow } from "../../nansen/schemas";
import { parseTime } from "./util";

export interface ScanHints {
  symbol?: string | null;
  name?: string | null;
  logo?: string | null;
  /** Price the market cap below was computed with (a consistent pair gives the circulating supply). */
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  circulatingSupply?: number | null;
  /** Total supply (the unit of tgm/holders ownership_percentage); the screener's FDV / price. */
  totalSupply?: number | null;
  /** ISO datetime; a zoneless "2026-08-18T07:24:58" is read as UTC. */
  deployedAt?: string | null;
}

const HINT_KEYS = ["symbol", "name", "logo", "priceUsd", "marketCapUsd", "liquidityUsd", "circulatingSupply", "totalSupply", "deployedAt"] as const;

/** "bnb:0xabc…": the address lowercased on EVM chains. */
export function hintKey(chain: string, address: string): string {
  const c = chain.trim().toLowerCase();
  const a = address.trim();
  return `${c}:${isEvmChain(c) ? a.toLowerCase() : a}`;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pos(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function iso(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const t = parseTime(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Keeps only usable values: non-empty strings, positive numbers, parseable dates. */
export function cleanHints(h: Record<string, unknown> | null | undefined): ScanHints {
  if (!h || typeof h !== "object") return {};
  const out: ScanHints = {};
  const set = <K extends keyof ScanHints>(k: K, v: ScanHints[K] | null) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  set("symbol", text(h.symbol));
  set("name", text(h.name));
  set("logo", text(h.logo));
  set("priceUsd", pos(h.priceUsd));
  set("marketCapUsd", pos(h.marketCapUsd));
  set("liquidityUsd", pos(h.liquidityUsd));
  set("circulatingSupply", pos(h.circulatingSupply));
  set("totalSupply", pos(h.totalSupply));
  set("deployedAt", iso(h.deployedAt));
  return out;
}

/**
 * A token-screener row → hints (the screener has no name or logo). The circulating supply is left to
 * buildMeta (market cap ÷ this price); the total supply is FDV ÷ price.
 */
export function hintsFromScreenerRow(r: TokenScreenerRow): ScanHints {
  const price = pos(r.price_usd);
  const fdv = pos(r.fdv);
  return cleanHints({
    symbol: r.token_symbol,
    priceUsd: r.price_usd,
    marketCapUsd: r.market_cap_usd,
    liquidityUsd: r.liquidity,
    totalSupply: price !== null && fdv !== null ? fdv / price : null,
    deployedAt: r.token_deployment_date,
  });
}

/**
 * Field by field: `primary` where it has a value, else `fallback`; null when neither has anything.
 * The market cap and the price it was computed at stay a pair (together they give the circulating
 * supply), so both come from whichever side supplies the market cap.
 */
export function mergeHints(primary: ScanHints | null | undefined, fallback: ScanHints | null | undefined): ScanHints | null {
  if (!primary && !fallback) return null;
  const out: ScanHints = {};
  for (const k of HINT_KEYS) {
    const v = primary?.[k] ?? fallback?.[k];
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  const capSide = pos(primary?.marketCapUsd) !== null ? primary : pos(fallback?.marketCapUsd) !== null ? fallback : null;
  if (capSide) {
    delete out.priceUsd;
    if (pos(capSide.priceUsd) !== null) out.priceUsd = capSide.priceUsd;
  }
  return out;
}

function addRows(out: Map<string, ScanHints>, rows: unknown[]): void {
  for (const raw of rows) {
    const p = TokenScreenerRow.safeParse(raw);
    if (!p.success || !p.data.chain || !p.data.token_address) continue;
    const key = hintKey(p.data.chain, p.data.token_address);
    // First occurrence wins (callers pass the newest data first).
    if (!out.has(key)) out.set(key, hintsFromScreenerRow(p.data));
  }
}

/**
 * Accepts any of:
 *   * a disk-cache entry of token-screener: {"endpoint": "token-screener", "data": {"data": [rows]}}
 *   * a token-screener response {"data": [rows]} or a bare array of rows;
 *   * a map {"bnb:0xTOKEN": {"symbol": "DGAI", "marketCapUsd": 154000000, "liquidityUsd": 1600000, ...}}.
 * Anything unrecognised yields an empty map (hints are optional, never fatal).
 */
export function parseHints(json: unknown): Map<string, ScanHints> {
  const out = new Map<string, ScanHints>();
  if (Array.isArray(json)) {
    addRows(out, json);
    return out;
  }
  if (!json || typeof json !== "object") return out;
  const obj = json as Record<string, unknown>;
  const inner = obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>).data : undefined;
  if (Array.isArray(inner)) {
    addRows(out, inner);
    return out;
  }
  if (Array.isArray(obj.data)) {
    addRows(out, obj.data);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const i = k.indexOf(":");
    if (i <= 0 || !v || typeof v !== "object") continue;
    const hints = cleanHints(v as Record<string, unknown>);
    if (Object.keys(hints).length) out.set(hintKey(k.slice(0, i), k.slice(i + 1)), hints);
  }
  return out;
}

export async function loadHintsFile(file: string): Promise<Map<string, ScanHints>> {
  return parseHints(JSON.parse(await readFile(file, "utf8")) as unknown);
}

/** Every token-screener response in the Nansen disk cache (newest first wins). Reads files only. */
export async function loadScreenerCacheHints(dir: string): Promise<Map<string, ScanHints>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return new Map();
  }
  const entries: { fetchedAt: number; data: unknown }[] = [];
  for (const name of names) {
    try {
      const e = JSON.parse(await readFile(path.join(dir, name), "utf8")) as { endpoint?: unknown; fetchedAt?: unknown; data?: unknown };
      if (e?.endpoint === "token-screener") entries.push({ fetchedAt: Number(e.fetchedAt) || 0, data: e.data });
    } catch {
      /* not a cache entry */
    }
  }
  entries.sort((a, b) => b.fetchedAt - a.fetchedAt);
  const out = new Map<string, ScanHints>();
  for (const e of entries) for (const [k, v] of parseHints(e.data)) if (!out.has(k)) out.set(k, v);
  return out;
}
