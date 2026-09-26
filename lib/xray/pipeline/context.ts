// Stage "context": token profile, the 7-day hourly price film and the week's big buys. Pure helpers.
//
// Token profile: tgm/token-information first. Young tokens often come back with name "", symbol "",
// market cap / supply / liquidity 0 (spot metrics filled): every 0 or "" counts as missing. Gaps are
// filled from the caller's hints (the token-screener row warm-scans already has, ./hints.ts). When
// something is still missing, the scan asks token-screener ONCE with filters.token_address = the token
// (1 credit, cached 60 min; matched on chain + address): symbol, price, market cap, FDV, liquidity,
// deployment date. The circulating supply is market cap ÷ price, the total supply FDV ÷ price.
// search/general is never used for an address (address lookups may cost 500 credits on the MCP twin).
// Missing meta never throws: the symbol falls back to "?".
import type { OhlcvCandle, TgmDexTradeRow, TokenInformationResponse, TokenScreenerRow } from "../../nansen/schemas";
import { fallbackPrice, ohlcvToPoints, supplyBasis } from "../../pipeline/derive";
import type { BigBuy, PricePoint, ScanMeta } from "../types";
import type { ScanHints } from "./hints";
import { normalizeAddress, parseTime, positive } from "./util";

export const BIG_BUYS_LIMIT = 40;

/** Hourly closes, oldest first, from `fromMs` on (candles before it are dropped). */
export function pricePoints(candles: OhlcvCandle[], fromMs = -Infinity): PricePoint[] {
  return ohlcvToPoints(candles)
    .filter((p) => p.t >= fromMs)
    .map((p) => ({ t: p.t, c: p.c }));
}

/** last / first − 1 over the film, null with fewer than two points. */
export function priceChange(points: PricePoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].c;
  const last = points[points.length - 1].c;
  return first > 0 ? last / first - 1 : null;
}

/**
 * Big buys for the film: BUY trades only, deduplicated per transaction, the `limit` largest by USD,
 * returned oldest first. Wallet addresses and labels are deliberately dropped (smart-money labels
 * must never be shown per wallet). Prices far outside the film's range are treated as bad quotes.
 */
export function bigBuysFromTrades(rows: TgmDexTradeRow[], price: PricePoint[], limit = BIG_BUYS_LIMIT): BigBuy[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of price) {
    if (p.c < lo) lo = p.c;
    if (p.c > hi) hi = p.c;
  }
  const bounded = Number.isFinite(lo) && lo > 0;
  const byTx = new Map<string, BigBuy>();
  let anon = 0;
  for (const r of rows) {
    if (r.action && r.action.toUpperCase() !== "BUY") continue;
    const t = parseTime(r.block_timestamp);
    const usd = r.estimated_value_usd;
    let px = r.estimated_swap_price_usd;
    if (!positive(px) && positive(usd) && positive(r.token_amount)) px = usd / r.token_amount;
    if (!Number.isFinite(t) || !positive(usd) || !positive(px)) continue;
    if (bounded && (px < lo / 3 || px > hi * 3)) continue;
    const key = r.transaction_hash ?? `anon-${anon++}`;
    const prev = byTx.get(key);
    if (!prev || usd > prev.usd) byTx.set(key, { t, price: px, usd });
  }
  return [...byTx.values()]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.t - b.t);
}

type InfoData = TokenInformationResponse["data"];

export interface MetaInput {
  chain: string;
  tokenAddress: string;
  info: InfoData | null;
  price: PricePoint[];
  scanNo: number;
  now: Date;
  windowFrom: string;
  windowTo: string;
  /** Caller-supplied facts, then the token-screener lookup (mergeHints), used where token-information is empty. */
  hints?: ScanHints | null;
}

/** Non-empty trimmed string, else null ("" from the API means "unknown"). */
function text(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Positive finite number, else null (0 from the API means "unknown"). */
function pos(v: number | null | undefined): number | null {
  return positive(v) ? v : null;
}

function isoDate(v: string | null | undefined): string | null {
  const s = text(v);
  if (!s) return null;
  const t = parseTime(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const CHAIN_ALIASES: Record<string, string> = { bsc: "bnb", eth: "ethereum", sol: "solana", matic: "polygon", avax: "avalanche" };

function sameChain(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return (CHAIN_ALIASES[x] ?? x) === (CHAIN_ALIASES[y] ?? y);
}

/** The token-screener row for exactly this token (same chain and address), or null. */
export function screenerMatch(rows: TokenScreenerRow[] | null | undefined, chain: string, tokenAddress: string): TokenScreenerRow | null {
  if (!rows) return null;
  const key = normalizeAddress(chain, tokenAddress);
  return rows.find((r) => !!r.token_address && sameChain(r.chain, chain) && normalizeAddress(chain, r.token_address) === key) ?? null;
}

/** What token-information (then the hints) left unknown. */
export function missingMeta(info: InfoData | null, hints?: ScanHints | null): { symbol: boolean; name: boolean; marketCap: boolean; supply: boolean; liquidity: boolean } {
  const d = info?.token_details;
  const marketCap = !pos(d?.market_cap_usd) && !pos(hints?.marketCapUsd);
  return {
    symbol: !text(info?.symbol) && !text(hints?.symbol),
    name: !text(info?.name) && !text(hints?.name),
    marketCap,
    // A market cap with its price gives the circulating supply (buildMeta).
    supply: !pos(d?.circulating_supply) && !pos(hints?.circulatingSupply) && !pos(d?.total_supply) && !pos(hints?.totalSupply) && marketCap,
    liquidity: !pos(info?.spot_metrics?.liquidity_usd) && !pos(hints?.liquidityUsd),
  };
}

/**
 * One token-screener lookup (1 credit) is worth it when the symbol, market cap, supply or liquidity is
 * still unknown. A missing name alone does not trigger it: the screener has no name (it falls back to
 * the symbol). Hints that already cover these (warm-scans --hints) skip the call.
 */
export function needsTokenLookup(info: InfoData | null, hints?: ScanHints | null): boolean {
  const m = missingMeta(info, hints);
  return m.symbol || m.marketCap || m.supply || m.liquidity;
}

/** Last close, else market cap / circulating (then FDV / total supply), else the hints' price. */
export function resolvePriceNow(price: PricePoint[], info: InfoData | null, hints?: ScanHints | null): number | null {
  if (price.length) return price[price.length - 1].c;
  const fromInfo = info ? fallbackPrice(info.token_details) : null;
  return pos(fromInfo) ?? pos(hints?.priceUsd) ?? null;
}

/** Total supply (the unit of tgm/holders ownership_percentage): token-information, else the hints (FDV ÷ price). */
export function totalSupplyOf(info: InfoData | null, hints?: ScanHints | null): number | null {
  return pos(info?.token_details?.total_supply) ?? pos(hints?.totalSupply) ?? null;
}

export function buildMeta(i: MetaInput): ScanMeta {
  const info = i.info;
  const details = info?.token_details;
  const spot = info?.spot_metrics;
  const hints = i.hints ?? null;
  const priceNow = resolvePriceNow(i.price, info, hints) ?? 0;
  const symbol = text(info?.symbol) ?? text(hints?.symbol);
  const name = text(info?.name) ?? text(hints?.name) ?? symbol;
  const logo = text(info?.logo) ?? text(hints?.logo);

  // Market cap with the price it was computed at (a consistent pair gives the circulating supply).
  const caps: { cap: number | null; price: number | null }[] = [
    { cap: pos(details?.market_cap_usd), price: null },
    { cap: pos(hints?.marketCapUsd), price: pos(hints?.priceUsd) },
  ];
  const cap = caps.find((x) => x.cap !== null) ?? null;
  const circulatingKnown = pos(details?.circulating_supply) ?? pos(hints?.circulatingSupply);
  const capPrice = cap ? (cap.price ?? pos(priceNow)) : null;
  const circulatingSupply =
    circulatingKnown ?? (cap && capPrice ? (cap.cap as number) / capPrice : null) ?? pos(details?.total_supply) ?? null;
  const marketCapUsd = cap?.cap ?? (circulatingKnown !== null && positive(priceNow) ? circulatingKnown * priceNow : null);

  return {
    chain: i.chain,
    tokenAddress: i.tokenAddress,
    symbol: symbol ?? "?",
    name: name ?? i.tokenAddress,
    ...(logo ? { logo } : {}),
    priceNow,
    priceChange7d: priceChange(i.price),
    marketCapUsd,
    liquidityUsd: pos(spot?.liquidity_usd) ?? pos(hints?.liquidityUsd),
    circulatingSupply,
    holders: spot?.total_holders ?? null,
    buyers24h: spot?.unique_buyers ?? null,
    sellers24h: spot?.unique_sellers ?? null,
    volume24hUsd: spot?.volume_total_usd ?? null,
    deployedAt: isoDate(details?.token_deployment_date) ?? isoDate(hints?.deployedAt),
    scannedAt: i.now.toISOString(),
    scanNo: i.scanNo,
    window: { from: i.windowFrom, to: i.windowTo },
  };
}

/** Supply used for every "% of supply" number: circulating, else total, else market cap / price (0 = unknown). */
export function scanSupply(meta: ScanMeta, info: InfoData | null): number | null {
  const d = info?.token_details;
  return supplyBasis(pos(d?.circulating_supply) ?? pos(meta.circulatingSupply), pos(d?.total_supply), pos(meta.marketCapUsd), meta.priceNow);
}
