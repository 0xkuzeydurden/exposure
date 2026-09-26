// Finding 03 · "Where are sellers waiting?": supply that gets back to break-even just above the
// price (sell walls), the supply-by-entry-price ladder and the underwater share.
//   deep  (method "cost_basis"):    holders' average cost from profiler/address/pnl;
//   deep  (method "hybrid"):        pnl cost basis covered < 50% of the analysed holders' tokens, so
//                                   30-day buyers without a pnl cost are blended in at their VWAP;
//   quick (method "recent_buyers"): each 30-day buyer's volume-weighted buy price
//                                   (bought_volume_usd / bought_token_volume) as a proxy cost.
// All feed the same wall math (lib/metrics findReefs / costProfile / tideSnapshot).
//
// Deep holder selection (planPnlHolders) spends the pnl budget where a cost basis exists:
//   * pool / router / bridge / burn / exchange labels are excluded (lib/pipeline/derive.ts regexes);
//   * allocations are skipped before any call on two signals only: a balance larger than the whole
//     circulating supply (it cannot be circulating), or a label that says team / foundation /
//     deployer / vesting / treasury / lock. Transfer history is NOT a signal: tgm/holders total_inflow
//     counts DEX buys too, so "received, never sent" also describes a buyer who never sold;
//   * a wallet in the 7-day or 30-day who-bought-sold BUY list is never skipped (it bought on a DEX);
//   * the rest is ranked (a) holders that are also this week's DEX buyers (fetched by finding 01
//     anyway), by balance, then (b) other holders by balance. Recent buyers take at most half the
//     budget, so the largest holders are always read too (on young tokens the holders who bought
//     this week are often dust wallets). Calls stay capped at maxHolders.
// After the calls a holder is an allocation (fog "allocation") only when pnl says bought_usd 0 and
// cost_basis_usd 0 over a window that covered the token's whole history, and it is not a known DEX
// buyer; otherwise such a record is "no_cost". Allocations are excluded from walls and reported as
// allocatedShare, a share of TOTAL supply (ownership_percentage, else balance ÷ total supply).
import { costProfile, findReefs, tideSnapshot } from "../../metrics";
import type { HolderRow, WhoBoughtSoldRow } from "../../nansen/schemas";
import {
  costInRange,
  detectOwnershipScale,
  isBurnAddress,
  isContractLabel,
  isExchangeLabel,
  selectHolders,
  type SelectedHolder,
} from "../../pipeline/derive";
import type { HolderPoint } from "../../types";
import type { LadderBin, PricePoint, Wall, WallsFinding } from "../types";
import type { PipelineRules } from "./rules";
import { clamp01, normalizeAddress, positive } from "./util";

export const DEFAULT_MAX_HOLDERS = 40;
export const MAX_HOLDERS_CAP = 200;
export const RECENT_BUYERS_WINDOW_DAYS = 30;
/** Walls are searched in (price, WALL_RANGE × price]. */
export const WALL_RANGE = 3;
export const WALL_LIMIT = 3;
export const LADDER_BINS = 24;
/** Must match the bin count lib/metrics findReefs uses (to count holders per wall). */
const REEF_BINS = 24;

/** A holder point with the (normalised) address it came from; the address never leaves the pipeline. */
export interface KeyedHolder {
  key: string;
  point: HolderPoint;
}

/** Proxy holders from 30-day buyers: cost = USD bought / tokens bought, amount = tokens still held from those buys. */
export function recentBuyerPoints(
  rows: WhoBoughtSoldRow[],
  chain: string,
  tokenAddress: string,
  supply: number | null,
  priceNow: number,
): HolderPoint[] {
  return recentBuyerEntries(rows, chain, tokenAddress, supply, priceNow).map((e) => e.point);
}

/** recentBuyerPoints with each point's buyer address (normalised), for blending with pnl holders. */
export function recentBuyerEntries(
  rows: WhoBoughtSoldRow[],
  chain: string,
  tokenAddress: string,
  supply: number | null,
  priceNow: number,
): KeyedHolder[] {
  const tokenKey = normalizeAddress(chain, tokenAddress);
  const seen = new Set<string>();
  const out: KeyedHolder[] = [];
  for (const r of rows) {
    if (!r.address) continue;
    const key = normalizeAddress(chain, r.address);
    if (seen.has(key) || key === tokenKey || isBurnAddress(chain, r.address)) continue;
    if (isContractLabel(r.address_label) || isExchangeLabel(r.address_label)) continue;
    seen.add(key);
    const bought = r.bought_token_volume;
    const usd = r.bought_volume_usd;
    if (!positive(bought) || !positive(usd)) continue;
    const sold = positive(r.sold_token_volume) ? r.sold_token_volume : 0;
    const held = bought - sold;
    if (!(held > 0)) continue;
    const cost = usd / bought;
    if (!costInRange(cost, priceNow)) continue;
    out.push({
      key,
      point: {
        id: out.length,
        cohort: "other",
        amount: held,
        supplyShare: positive(supply) ? held / supply : 0,
        cost,
        multiple: priceNow / cost,
        conviction: clamp01(held / bought),
        maxHeld: bought,
        buys: 0,
        sells: 0,
        fog: null,
      },
    });
  }
  return out;
}

/** Normalised addresses of who-bought-sold BUY rows that bought something (contracts / exchanges / the token itself dropped). */
export function buyerKeys(rows: WhoBoughtSoldRow[], chain: string, tokenAddress: string): Set<string> {
  const tokenKey = normalizeAddress(chain, tokenAddress);
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.address || !positive(r.bought_volume_usd)) continue;
    if (isContractLabel(r.address_label) || isExchangeLabel(r.address_label)) continue;
    const key = normalizeAddress(chain, r.address);
    if (key !== tokenKey && !isBurnAddress(chain, r.address)) out.add(key);
  }
  return out;
}

// ------------------------------------------------------------------ deep: who gets a pnl call

/** Below this share of the analysed holders' tokens with a pnl cost basis, 30-day buyers are blended in ("hybrid"). */
export const HYBRID_BELOW = 0.5;
/** Recent DEX buyers are asked first but take at most this share of the pnl budget. */
export const RECENT_BUYER_QUOTA = 0.5;

/**
 * Labels of wallets that hold an allocation rather than a position: team / foundation / deployer
 * wallets and vesting / treasury / lock contracts. Whole words only ("Steam", "Blockchain" stay in).
 * Pools, routers, bridges, burn addresses and exchanges are excluded as before and never count as
 * allocations.
 */
export const ALLOCATION_LABEL_RE = /\b(?:team|foundation|deployer|vesting|treasury|timelock|lock(?:er|ed|s)?)\b/i;

export function isAllocationLabel(label: string | null | undefined): boolean {
  return !!label && ALLOCATION_LABEL_RE.test(label);
}

/** "exceeds_circulating": balance > the whole circulating supply; "allocation_label": see ALLOCATION_LABEL_RE. */
export type SkipReason = "exceeds_circulating" | "allocation_label";

export interface PnlCandidate extends SelectedHolder {
  /** Also in this week's who-bought-sold BUY list. */
  recentBuyer: boolean;
}

export interface SkippedHolder {
  address: string;
  key: string;
  tokenAmount: number;
  /** Share of TOTAL supply (totalShareOf), 0..1; null when neither ownership nor the total supply is known. */
  ownership: number | null;
  reason: SkipReason;
}

export interface PnlHolderPlan {
  /** Call order: recent buyers first (largest first), then other holders (largest first). id = rank by balance among them. */
  chosen: PnlCandidate[];
  /** Allocations recognised from tgm/holders alone (no pnl call spent on them). */
  skipped: SkippedHolder[];
  /** Share of TOTAL supply held by `skipped` (holders of unknown share count 0), 0..1. */
  skippedShare: number;
  /** Divisor that turns ownership_percentage into a 0..1 share of total supply. */
  ownershipScale: number;
  /** The total supply shares were computed against: the input's, else implied by tgm/holders; null = unknown. */
  totalSupply: number | null;
  /** Eligible holders (not skipped) that are recent buyers, before the budget cut. */
  recentEligible: number;
  /** Holders that matched a skip rule but were kept because they are known DEX buyers. */
  spared: number;
  excluded: { exchange: number; contract: number };
}

export interface PlanInput {
  chain: string;
  tokenAddress: string;
  /** tgm/holders rows (all_holders, largest first). */
  rows: HolderRow[];
  /** Normalised addresses of this week's DEX buyers (buyerKeys): asked first. */
  recentBuyers: ReadonlySet<string>;
  /** Every known DEX buyer (7-day and, once read, 30-day lists): never skipped. Default recentBuyers. */
  knownBuyers?: ReadonlySet<string>;
  maxHolders: number;
  /** Supply basis of the scan (circulating when known; scanSupply). A balance above it is not circulating. */
  supply: number | null;
  /** Total supply (token-information, else the screener's FDV ÷ price): the unit of ownership_percentage. */
  totalSupply?: number | null;
}

/**
 * Holder's share of TOTAL supply: ownership_percentage in its detected unit, else balance ÷ total
 * supply, else null. Never balance ÷ circulating supply (that would mix units).
 */
export function totalShareOf(ownershipPct: number | null, scale: number, amount: number, totalSupply: number | null | undefined): number | null {
  if (ownershipPct !== null && ownershipPct > 0 && scale > 0) return clamp01(ownershipPct / scale);
  return positive(totalSupply) && amount > 0 ? clamp01(amount / totalSupply) : null;
}

/**
 * Total supply implied by tgm/holders itself: the median of balance ÷ (ownership_percentage ÷ scale)
 * over the rows that have both. null without such rows.
 */
export function impliedTotalSupply(rows: HolderRow[], scale: number): number | null {
  if (!(scale > 0)) return null;
  const totals = rows
    .filter((r) => (r.ownership_percentage ?? 0) > 0 && (r.token_amount ?? 0) > 0)
    .map((r) => (r.token_amount as number) / ((r.ownership_percentage as number) / scale))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  return totals.length ? totals[Math.floor(totals.length / 2)] : null;
}

/** Why a holder is skipped before any pnl call, or null. Known DEX buyers are never skipped. */
export function preSkipReason(label: string | null | undefined, amount: number, supply: number | null, knownBuyer: boolean): SkipReason | null {
  if (knownBuyer) return null;
  // More than the whole circulating supply cannot be circulating: locked / unvested / treasury.
  if (positive(supply) && amount > supply) return "exceeds_circulating";
  if (isAllocationLabel(label)) return "allocation_label";
  return null;
}

/** Which holders get a profiler pnl call (see the header): allocations skipped, recent buyers first. */
export function planPnlHolders(input: PlanInput): PnlHolderPlan {
  const { chain } = input;
  const known = input.knownBuyers ?? input.recentBuyers;
  const tokenKey = normalizeAddress(chain, input.tokenAddress);
  const givenTotal = positive(input.totalSupply) ? input.totalSupply : null;
  // ownership_percentage is a share of total supply: detect its unit against the total, not the
  // circulating supply (null: from the column's sum). Without a known total, the rows that carry an
  // ownership imply one, so a holder without ownership_percentage still gets a share of TOTAL supply.
  const ownershipScale = detectOwnershipScale(input.rows, givenTotal);
  const totalSupply = givenTotal ?? impliedTotalSupply(input.rows, ownershipScale);

  // One row per wallet (the largest), then the skip rules on tgm/holders alone.
  const byKey = new Map<string, HolderRow>();
  for (const r of input.rows) {
    if (!r.address) continue;
    const k = normalizeAddress(chain, r.address);
    const prev = byKey.get(k);
    if (!prev || (r.token_amount ?? 0) > (prev.token_amount ?? 0)) byKey.set(k, r);
  }
  const skipped: SkippedHolder[] = [];
  const kept: HolderRow[] = [];
  let spared = 0;
  for (const [key, r] of byKey) {
    const amount = r.token_amount ?? 0;
    const label = r.address_label;
    // The token itself, burn addresses, exchanges, and pools / routers / bridges without an
    // allocation word: excluded by selectHolders, never counted as allocations.
    const excludedLater =
      key === tokenKey || isBurnAddress(chain, r.address as string) || isExchangeLabel(label) || (isContractLabel(label) && !isAllocationLabel(label));
    const reason = !(amount > 0) || excludedLater ? null : preSkipReason(label, amount, input.supply, false);
    if (reason && known.has(key)) spared++;
    if (!reason || known.has(key)) {
      kept.push(r);
      continue;
    }
    skipped.push({ address: r.address as string, key, tokenAmount: amount, ownership: totalShareOf(r.ownership_percentage, ownershipScale, amount, totalSupply), reason });
  }

  const all = selectHolders({
    chain,
    tokenAddress: input.tokenAddress,
    allHolders: kept,
    whales: [],
    publicFigures: [],
    exchanges: [],
    smartMoney: [],
    maxHolders: kept.length,
    supply: input.supply,
    totalSupply: givenTotal,
  });
  const recent: PnlCandidate[] = [];
  const others: PnlCandidate[] = [];
  // selectHolders returns every eligible holder, largest first.
  for (const c of all.chosen) {
    const isRecent = input.recentBuyers.has(c.key);
    (isRecent ? recent : others).push({ ...c, recentBuyer: isRecent });
  }

  const max = Math.max(0, Math.floor(input.maxHolders));
  const quota = Math.floor(max * RECENT_BUYER_QUOTA);
  const takeRecent = Math.min(recent.length, Math.max(quota, max - others.length));
  const takeOthers = Math.min(others.length, max - takeRecent);
  const picked = [...recent.slice(0, takeRecent), ...others.slice(0, takeOthers)];
  const rank = new Map(
    [...picked]
      .sort((a, b) => b.tokenAmount - a.tokenAmount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((c, i) => [c.key, i] as const),
  );
  // Largest first, like tgm/holders.
  skipped.sort((a, b) => b.tokenAmount - a.tokenAmount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    chosen: picked.map((c) => ({ ...c, id: rank.get(c.key) as number })),
    skipped,
    skippedShare: clamp01(skipped.reduce((s, x) => s + (x.ownership ?? 0), 0)),
    ownershipScale,
    totalSupply,
    recentEligible: recent.length,
    spared,
    excluded: all.excluded,
  };
}

/** Share of the holders' tokens that carry a cost (the pnl coverage the hybrid switch looks at), 0..1. */
export function pnlCostCoverage(holders: HolderPoint[]): number {
  let all = 0;
  let costed = 0;
  for (const h of holders) {
    if (!(h.amount > 0)) continue;
    all += h.amount;
    if (h.cost !== null && h.cost > 0) costed += h.amount;
  }
  return all > 0 ? costed / all : 0;
}

/**
 * Hybrid walls: pnl holders plus 30-day buyers not covered by pnl. A proxy buyer whose pnl call gave
 * no cost replaces that fog point (same wallet, now priced); buyers with a pnl cost are left out, so
 * no wallet is counted twice. There is no exclusion list: a 30-day DEX buyer is never an allocation
 * (the caller hands back any pnl "allocation" that turns out to be one as a fog point).
 */
export function blendRecentBuyers(pnl: KeyedHolder[], proxy: KeyedHolder[]): { holders: HolderPoint[]; costBasisHolders: number; recentBuyers: number } {
  const costed = new Set(pnl.filter((e) => e.point.cost !== null).map((e) => e.key));
  const fogged = new Set(pnl.filter((e) => e.point.cost === null).map((e) => e.key));
  const replaced = new Set<string>();
  const added: HolderPoint[] = [];
  let nextId = pnl.reduce((m, e) => Math.max(m, e.point.id), -1) + 1;
  const seen = new Set<string>();
  for (const e of proxy) {
    if (seen.has(e.key) || costed.has(e.key)) continue;
    seen.add(e.key);
    if (fogged.has(e.key)) replaced.add(e.key);
    added.push({ ...e.point, id: nextId++ });
  }
  const kept = pnl.filter((e) => !replaced.has(e.key)).map((e) => e.point);
  return { holders: [...kept, ...added], costBasisHolders: costed.size, recentBuyers: added.length };
}

function withCost(holders: HolderPoint[]): HolderPoint[] {
  return holders.filter((h) => h.cost !== null && h.cost > 0 && Number.isFinite(h.cost) && h.amount > 0);
}

/** Amount-weighted quantile of holder costs. */
export function costQuantile(holders: HolderPoint[], q: number): number | null {
  const hs = withCost(holders).sort((a, b) => (a.cost as number) - (b.cost as number));
  const total = hs.reduce((s, h) => s + h.amount, 0);
  if (!(total > 0)) return null;
  let acc = 0;
  for (const h of hs) {
    acc += h.amount;
    if (acc >= q * total) return h.cost;
  }
  return hs[hs.length - 1].cost;
}

/** Log-spaced price range for the side ladder: the film's range widened to 5–95% of the supply by cost, within ÷20 … ×20 of the price. */
export function ladderRange(holders: HolderPoint[], price: PricePoint[], priceNow: number): { lo: number; hi: number } | null {
  if (!(priceNow > 0)) return null;
  let lo = priceNow;
  let hi = priceNow;
  for (const p of price) {
    if (p.c > 0 && p.c < lo) lo = p.c;
    if (p.c > hi) hi = p.c;
  }
  const q05 = costQuantile(holders, 0.05);
  const q95 = costQuantile(holders, 0.95);
  if (q05 !== null) lo = Math.min(lo, q05);
  if (q95 !== null) hi = Math.max(hi, q95);
  lo = Math.max(lo, priceNow / 20);
  hi = Math.min(hi, priceNow * 20);
  if (!(hi > lo * 1.01)) {
    lo = priceNow / 1.5;
    hi = priceNow * 1.5;
  }
  return { lo, hi };
}

export function buildLadder(holders: HolderPoint[], price: PricePoint[], priceNow: number, supply: number | null, bins = LADDER_BINS): LadderBin[] {
  const range = ladderRange(holders, price, priceNow);
  if (!range) return [];
  const hs = withCost(holders);
  const tokensTotal = hs.reduce((s, h) => s + h.amount, 0);
  const shareTotal = hs.reduce((s, h) => s + (h.supplyShare > 0 ? h.supplyShare : 0), 0);
  // Tokens → share of supply: exact with a supply, else the analysed holders' own ratio.
  const toShare = (tokens: number) => (positive(supply) ? tokens / supply : tokensTotal > 0 ? (tokens / tokensTotal) * shareTotal : 0);
  return costProfile(hs, bins, range.lo, range.hi).map((b) => {
    const tokens = b.byCohort.sm + b.byCohort.whale + b.byCohort.pf + b.byCohort.other;
    return { lo: b.lo, hi: b.hi, tokens, supplyShare: toShare(tokens) };
  });
}

/** Holders whose cost falls in the same findReefs bin as `wallPrice`. */
function holdersInWallBin(holders: HolderPoint[], priceNow: number, wallPrice: number): number {
  const span = Math.log(WALL_RANGE);
  const binOf = (c: number) => Math.min(REEF_BINS - 1, Math.max(0, Math.ceil((Math.log(c / priceNow) / span) * REEF_BINS) - 1));
  const target = binOf(wallPrice);
  let n = 0;
  for (const h of withCost(holders)) {
    const c = h.cost as number;
    if (c > priceNow && c <= priceNow * WALL_RANGE && binOf(c) === target) n++;
  }
  return n;
}

export function findWalls(holders: HolderPoint[], priceNow: number, liquidityUsd: number | null): Wall[] {
  if (!(priceNow > 0)) return [];
  return findReefs(holders, priceNow, priceNow, priceNow * WALL_RANGE, liquidityUsd, WALL_LIMIT).map((r) => ({
    price: r.price,
    movePct: r.movePct,
    tokens: r.amount,
    supplyShare: r.supplyShare,
    wallToLiquidity: r.wallToLiquidity,
    alreadyTrimming: clamp01(r.sellPressure),
    holders: holdersInWallBin(holders, priceNow, r.price),
  }));
}

export function classifyCeiling(
  walls: Wall[],
  underwaterShare: number,
  analysedTokens: number,
  rules: PipelineRules["ceiling"],
): WallsFinding["ceiling"] {
  if (underwaterShare >= rules.underwaterShare) return "heavy";
  for (const w of walls) {
    if (w.movePct > rules.nearMovePct) continue;
    if (w.wallToLiquidity !== null && w.wallToLiquidity >= rules.wallToLiquidity) return "heavy";
    if (analysedTokens > 0 && w.tokens / analysedTokens >= rules.wallShareOfAnalysed) return "heavy";
  }
  return "light";
}

export interface WallsInput {
  method: WallsFinding["method"];
  holders: HolderPoint[];
  /** Holders we asked about (deep: profiler calls; quick: buyers still holding). Defaults to holders.length. */
  holdersAnalyzed?: number;
  priceNow: number;
  liquidityUsd: number | null;
  supply: number | null;
  price: PricePoint[];
  /** Holder calls that failed; any failure makes the finding partial. */
  failures?: number;
  /** Carried onto the finding as is (deep tier). */
  extra?: Pick<WallsFinding, "costBasisHolders" | "recentBuyers" | "allocatedShare">;
}

function extraFields(extra: WallsInput["extra"]): Partial<WallsFinding> {
  if (!extra) return {};
  const out: Partial<WallsFinding> = {};
  if (extra.costBasisHolders !== undefined) out.costBasisHolders = extra.costBasisHolders;
  if (extra.recentBuyers !== undefined) out.recentBuyers = extra.recentBuyers;
  if (extra.allocatedShare !== undefined && extra.allocatedShare > 0) out.allocatedShare = clamp01(extra.allocatedShare);
  return out;
}

export function buildWallsFinding(input: WallsInput, rules: PipelineRules["ceiling"]): WallsFinding {
  const { holders, priceNow } = input;
  const costed = withCost(holders);
  if (!costed.length || !(priceNow > 0)) {
    return { ...emptyWallsFinding(input.method), holdersAnalyzed: input.holdersAnalyzed ?? holders.length, ...extraFields(input.extra) };
  }
  const analysedTokens = costed.reduce((s, h) => s + h.amount, 0);
  const allTokens = holders.reduce((s, h) => s + (h.amount > 0 ? h.amount : 0), 0);
  const underwaterShare = clamp01(tideSnapshot(holders, priceNow, priceNow).underwaterShare);
  const walls = findWalls(holders, priceNow, input.liquidityUsd);
  const costCoverage = allTokens > 0 ? analysedTokens / allTokens : 0;
  const status: WallsFinding["status"] =
    (input.failures ?? 0) > 0 || costCoverage < 0.6 || (input.method === "recent_buyers" && costed.length < 20) ? "partial" : "ok";
  return {
    status,
    method: input.method,
    holdersAnalyzed: input.holdersAnalyzed ?? holders.length,
    // Share of circulating supply WITH a cost basis (what lib/xray/diagnosis treats as walls coverage
    // and as the denominator of a wall's "share of analysed supply").
    analyzedSupplyShare: clamp01(costed.reduce((s, h) => s + (h.supplyShare > 0 ? h.supplyShare : 0), 0)),
    underwaterShare,
    walls,
    ladder: buildLadder(holders, input.price, priceNow, input.supply),
    ceiling: classifyCeiling(walls, underwaterShare, analysedTokens, rules),
    ...extraFields(input.extra),
  };
}

export function emptyWallsFinding(method: WallsFinding["method"]): WallsFinding {
  return {
    status: "unavailable",
    method,
    holdersAnalyzed: 0,
    analyzedSupplyShare: 0,
    underwaterShare: 0,
    walls: [],
    ladder: [],
    ceiling: "light",
  };
}
