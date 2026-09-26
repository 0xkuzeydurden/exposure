// Pure metric functions. Used by the HUD on every tide drag (must be O(N), no allocation-heavy work)
// and by the pipeline / share card. No I/O, no randomness.
import { COHORTS, MAX_LOG2, MIN_LOG2 } from "./types";
import type { Cohort, HolderPoint, Reef, TideSnapshot } from "./types";

const REEF_BINS = 24;
const DEFAULT_REEF_LIMIT = 3;

/** A holder contributes to cost-based math only with a positive, finite cost and a positive amount. */
function costOf(h: HolderPoint): number | null {
  const c = h.cost;
  return c != null && c > 0 && Number.isFinite(c) ? c : null;
}

function weight(h: HolderPoint): number {
  return h.amount > 0 && Number.isFinite(h.amount) ? h.amount : 0;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function cohortIndex(c: Cohort): number {
  switch (c) {
    case "sm":
      return 0;
    case "whale":
      return 1;
    case "pf":
      return 2;
    default:
      return 3;
  }
}

/** Column height in doublings: clamp(log2(multiple), MIN_LOG2, MAX_LOG2). Fog => null. */
export function heightOf(h: HolderPoint): number | null {
  const m = h.multiple;
  if (m == null || !(m > 0) || !Number.isFinite(m)) return null;
  const v = Math.log2(m);
  return v < MIN_LOG2 ? MIN_LOG2 : v > MAX_LOG2 ? MAX_LOG2 : v;
}

/** Water level for a what-if price: log2(priceNow / price). */
export function waterLevel(priceNow: number, price: number): number {
  return Math.log2(priceNow / price);
}

/** Price for a given water level (inverse of waterLevel). */
export function priceAtLevel(priceNow: number, level: number): number {
  return priceNow / Math.pow(2, level);
}

/**
 * Underwater = holder cost > what-if price. Shares are amount-weighted over holders WITH a cost
 * (fog excluded from numerator and denominator); fogShare is reported separately.
 */
export function tideSnapshot(holders: HolderPoint[], priceNow: number, price: number): TideSnapshot {
  let total = 0;
  let fog = 0;
  let known = 0;
  let under = 0;
  let kSm = 0, kWh = 0, kPf = 0, kOt = 0;
  let uSm = 0, uWh = 0, uPf = 0, uOt = 0;

  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const a = weight(h);
    if (a === 0) continue;
    total += a;
    const c = costOf(h);
    if (c == null) {
      fog += a;
      continue;
    }
    known += a;
    const u = c > price ? a : 0;
    under += u;
    switch (h.cohort) {
      case "sm":
        kSm += a;
        uSm += u;
        break;
      case "whale":
        kWh += a;
        uWh += u;
        break;
      case "pf":
        kPf += a;
        uPf += u;
        break;
      default:
        kOt += a;
        uOt += u;
    }
  }

  return {
    price,
    waterLevel: waterLevel(priceNow, price),
    underwaterShare: known > 0 ? under / known : 0,
    underwaterByCohort: {
      sm: kSm > 0 ? uSm / kSm : 0,
      whale: kWh > 0 ? uWh / kWh : 0,
      pf: kPf > 0 ? uPf / kPf : 0,
      other: kOt > 0 ? uOt / kOt : 0,
    },
    fogShare: total > 0 ? fog / total : 0,
  };
}

// Per-bin accumulator layout for findReefs: [amount, amount*cost, amount*(1-k), supplyShare, sm, whale, pf, other].
const F_AMT = 0;
const F_VAL = 1;
const F_TRIM = 2;
const F_SHARE = 3;
const F_COH = 4;
const STRIDE = 8;
const reefScratch = new Float64Array(REEF_BINS * STRIDE);

/**
 * Break-even reefs between `fromPrice` (exclusive) and `toPrice` (inclusive), direction-aware.
 * Uses 24 log-spaced bins over the range, returns up to `limit` local maxima by amount, sorted by
 * distance from fromPrice. For the default HUD call use fromPrice = priceNow, toPrice = 2 * priceNow.
 *
 * Reef.supplyShare is the sum of the member holders' supplyShare (share of circulating supply).
 */
export function findReefs(
  holders: HolderPoint[],
  priceNow: number,
  fromPrice: number,
  toPrice: number,
  liquidityUsd: number | null,
  limit?: number,
): Reef[] {
  const max = limit ?? DEFAULT_REEF_LIMIT;
  if (!(fromPrice > 0) || !(toPrice > 0) || fromPrice === toPrice || !(max > 0)) return [];
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice)) return [];

  const up = toPrice > fromPrice;
  const span = Math.log(toPrice / fromPrice); // negative when walking down
  const acc = reefScratch;
  acc.fill(0);

  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const c = costOf(h);
    if (c == null) continue;
    if (up ? !(c > fromPrice && c <= toPrice) : !(c < fromPrice && c >= toPrice)) continue;
    const a = weight(h);
    if (a === 0) continue;
    // Bin 0 is nearest fromPrice; t in (0, 1].
    const t = Math.log(c / fromPrice) / span;
    let b = Math.ceil(t * REEF_BINS) - 1;
    if (b < 0) b = 0;
    else if (b >= REEF_BINS) b = REEF_BINS - 1;
    const o = b * STRIDE;
    acc[o + F_AMT] += a;
    acc[o + F_VAL] += a * c;
    acc[o + F_TRIM] += a * (1 - clamp01(h.conviction));
    acc[o + F_SHARE] += h.supplyShare > 0 ? h.supplyShare : 0;
    acc[o + F_COH + cohortIndex(h.cohort)] += a;
  }

  // Local maxima: >= left neighbour, > right neighbour, so each plateau yields exactly one peak.
  const peaks: number[] = [];
  for (let b = 0; b < REEF_BINS; b++) {
    const a = acc[b * STRIDE + F_AMT];
    if (a <= 0) continue;
    const left = b > 0 ? acc[(b - 1) * STRIDE + F_AMT] : 0;
    const right = b < REEF_BINS - 1 ? acc[(b + 1) * STRIDE + F_AMT] : 0;
    if (a >= left && a > right) peaks.push(b);
  }
  if (peaks.length === 0) return [];

  // Keep the largest `max` peaks, then order them by distance from fromPrice (= bin index).
  peaks.sort((x, y) => acc[y * STRIDE + F_AMT] - acc[x * STRIDE + F_AMT] || x - y);
  const chosen = peaks.slice(0, max).sort((x, y) => x - y);

  const liq = liquidityUsd != null && liquidityUsd > 0 && Number.isFinite(liquidityUsd) ? liquidityUsd : null;
  return chosen.map((b) => {
    const o = b * STRIDE;
    const amount = acc[o + F_AMT];
    const price = acc[o + F_VAL] / amount;
    let best = 0;
    for (let k = 1; k < COHORTS.length; k++) {
      if (acc[o + F_COH + k] > acc[o + F_COH + best]) best = k;
    }
    return {
      price,
      movePct: price / priceNow - 1,
      amount,
      supplyShare: acc[o + F_SHARE],
      wallToLiquidity: liq != null ? (amount * price) / liq : null,
      sellPressure: clamp01(acc[o + F_TRIM] / amount),
      cohort: COHORTS[best],
    };
  });
}

/** Amount-weighted average cost of Smart Money holders with a cost. null if none. */
export function smPainPrice(holders: HolderPoint[]): number | null {
  let amt = 0;
  let val = 0;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    if (h.cohort !== "sm") continue;
    const c = costOf(h);
    if (c == null) continue;
    const a = weight(h);
    amt += a;
    val += a * c;
  }
  return amt > 0 ? val / amt : null;
}

/** Share of SM supply (with cost) that is underwater at `price`. null if no SM. */
export function smUnderwaterShare(holders: HolderPoint[], price: number): number | null {
  let amt = 0;
  let under = 0;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    if (h.cohort !== "sm") continue;
    const c = costOf(h);
    if (c == null) continue;
    const a = weight(h);
    amt += a;
    if (c > price) under += a;
  }
  return amt > 0 ? under / amt : null;
}

/**
 * 2D "shore profile": supply amount per log-cost bin per cohort (VPVR-like), for the inset chart
 * and the 2D fallback. Bins span [minPrice, maxPrice] log-spaced.
 *
 * Costs outside the range are clamped into the edge bins (mirroring the column-height clamp), so the
 * bins always sum to the total supply with a cost. Fog holders are excluded. Values are in tokens.
 */
export function costProfile(
  holders: HolderPoint[],
  bins: number,
  minPrice: number,
  maxPrice: number,
): { lo: number; hi: number; byCohort: Record<Cohort, number> }[] {
  const n = Math.floor(bins);
  if (!(n >= 1) || !(minPrice > 0) || !(maxPrice > minPrice) || !Number.isFinite(maxPrice)) return [];

  const ratio = maxPrice / minPrice;
  const out: { lo: number; hi: number; byCohort: Record<Cohort, number> }[] = new Array(n);
  for (let b = 0; b < n; b++) {
    out[b] = {
      lo: b === 0 ? minPrice : minPrice * Math.pow(ratio, b / n),
      hi: b === n - 1 ? maxPrice : minPrice * Math.pow(ratio, (b + 1) / n),
      byCohort: { sm: 0, whale: 0, pf: 0, other: 0 },
    };
  }

  const span = Math.log(ratio);
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const c = costOf(h);
    if (c == null) continue;
    const a = weight(h);
    if (a === 0) continue;
    let b = Math.floor((Math.log(c / minPrice) / span) * n);
    if (b < 0) b = 0;
    else if (b >= n) b = n - 1;
    const cohort: Cohort = h.cohort in out[b].byCohort ? h.cohort : "other";
    out[b].byCohort[cohort] += a;
  }
  return out;
}

/** Where a wallet with average cost `cost` sits: share of analysed supply at the same depth or deeper (cost >= this cost). */
export function drowningWithYou(holders: HolderPoint[], cost: number): number {
  if (!(cost > 0) || !Number.isFinite(cost)) return 0;
  let known = 0;
  let deeper = 0;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const c = costOf(h);
    if (c == null) continue;
    const a = weight(h);
    known += a;
    if (c >= cost) deeper += a;
  }
  return known > 0 ? deeper / known : 0;
}
