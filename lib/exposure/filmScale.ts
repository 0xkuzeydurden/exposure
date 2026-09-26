// Pure scale helpers for the EXPOSURE x-ray film: log price -> y, time -> x, nice price ticks, easing.
// No DOM, no React: everything here is deterministic and unit-tested (tests/exposure-filmScale.test.ts).

export interface PriceRange {
  lo: number;
  hi: number;
}

export interface PriceDomainOptions {
  /** Fraction of the log span added above and below the data. Default 0.08. */
  pad?: number;
  /**
   * How far (as a price ratio) an extra level (a wall, SM entry, YOU) may pull the domain away from the
   * price series before it is clamped to that reach. Keeps a far-away wall from flattening the line.
   * Default 4 (up to 4x above the series max / 4x below its min).
   */
  reach?: number;
  /** Minimum hi/lo ratio of the unpadded domain, so a flat series still gets a readable scale. Default 1.12. */
  minRatio?: number;
}

const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Price domain for the film's log scale.
 * `core` is the 7-day price series (always fully inside); `extra` are the levels drawn on top of it
 * (walls, smart-money entry, YOU). Non-positive and non-finite values are ignored.
 */
export function priceDomain(
  core: readonly number[],
  extra: readonly number[] = [],
  opts: PriceDomainOptions = {},
): PriceRange {
  const pad = opts.pad ?? 0.08;
  const reach = Math.max(1, opts.reach ?? 4);
  const minRatio = Math.max(1.0001, opts.minRatio ?? 1.12);

  let cMin = Infinity;
  let cMax = -Infinity;
  for (const v of core) {
    if (!isPos(v)) continue;
    if (v < cMin) cMin = v;
    if (v > cMax) cMax = v;
  }
  const extras = extra.filter(isPos);
  if (!Number.isFinite(cMin)) {
    // No price series: build the domain from the extra levels alone.
    if (extras.length === 0) return { lo: 0.9, hi: 1.1 };
    cMin = Math.min(...extras);
    cMax = Math.max(...extras);
  }

  let lo = cMin;
  let hi = cMax;
  const floor = cMin / reach;
  const ceil = cMax * reach;
  for (const v of extras) {
    const c = clamp(v, floor, ceil);
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }

  // Minimum spread around the geometric middle.
  if (hi / lo < minRatio) {
    const mid = Math.sqrt(hi * lo);
    const half = Math.sqrt(minRatio);
    lo = mid / half;
    hi = mid * half;
  }

  const span = Math.log(hi) - Math.log(lo);
  return { lo: lo * Math.exp(-span * pad), hi: hi * Math.exp(span * pad) };
}

export interface LogScale {
  /** Price -> y (unclamped). Non-positive prices map to the bottom edge. */
  (price: number): number;
  domain: PriceRange;
  /** [top, bottom] in px. */
  range: readonly [number, number];
  /** y -> price. */
  invert(y: number): number;
  /** Price -> y clamped to the range. */
  clamped(price: number): number;
  inDomain(price: number): boolean;
}

const px = (v: number) => Math.round(v * 100) / 100;

/** Log price scale: `domain.hi` maps to `yTop`, `domain.lo` to `yBottom`. */
export function logScale(domain: PriceRange, yTop: number, yBottom: number): LogScale {
  const lhi = Math.log(domain.hi);
  const llo = Math.log(domain.lo);
  const span = lhi - llo || 1;
  const h = yBottom - yTop;
  // Rounded to 1/100 px: Math.log differs in the last bits between Node and browsers, and the film is
  // server-rendered, so unrounded coordinates cause hydration mismatches.
  const f = ((p: number) =>
    p > 0 && Number.isFinite(p) ? px(yTop + ((lhi - Math.log(p)) / span) * h) : yBottom) as LogScale;
  f.domain = domain;
  f.range = [yTop, yBottom] as const;
  f.invert = (y: number) => Math.exp(lhi - ((y - yTop) / h) * span);
  f.clamped = (p: number) => clamp(f(p), Math.min(yTop, yBottom), Math.max(yTop, yBottom));
  f.inDomain = (p: number) => p >= domain.lo && p <= domain.hi;
  return f;
}

export interface TimeScale {
  (t: number): number;
  t0: number;
  t1: number;
  range: readonly [number, number];
  invert(x: number): number;
}

/** Linear time scale (unix ms -> px). A zero-length window maps everything to the middle. */
export function timeScale(t0: number, t1: number, x0: number, x1: number): TimeScale {
  const dt = t1 - t0;
  const f = ((t: number) => px(dt > 0 ? x0 + ((t - t0) / dt) * (x1 - x0) : (x0 + x1) / 2)) as TimeScale;
  f.t0 = t0;
  f.t1 = t1;
  f.range = [x0, x1] as const;
  f.invert = (x: number) => (x1 !== x0 ? t0 + ((x - x0) / (x1 - x0)) * dt : t0);
  return f;
}

const tidy = (v: number) => Number(v.toPrecision(12));

/** Mantissa sets per decade for log-spaced ticks, simplest first. */
const LOG_SETS: readonly (readonly number[])[] = [
  [1],
  [1, 2, 5],
  [1, 2, 3, 5],
  [1, 1.5, 2, 3, 5, 7],
  [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8],
];

/**
 * Round price levels for the scale ticks: `minTicks`..`maxTicks` of them (when the range allows),
 * never closer than `minGapPx` on the given scale. Candidates are linear "nice" steps (1, 2, 2.5, 5 x
 * 10^k) and log-spaced decade sets (1-2-5, 1-2-3-5, ...) for wide ranges; after thinning, the simplest
 * set with a count in range and the most even spacing wins. A 6x range no longer drops to two ticks.
 */
export function priceTicks(scale: LogScale, maxTicks = 6, minGapPx = 34, minTicks = 4): number[] {
  const { lo, hi } = scale.domain;
  if (!(hi > lo) || !(lo > 0)) return [];

  const thin = (ticks: number[]): number[] => {
    ticks.sort((a, b) => b - a);
    const kept: number[] = [];
    let lastY = -Infinity;
    for (const v of ticks) {
      const y = scale(v);
      if (y - lastY >= minGapPx) {
        kept.push(v);
        lastY = y;
      }
    }
    return kept;
  };

  const cands: { ticks: number[]; cost: number }[] = [];
  // Linear steps.
  const span = hi - lo;
  const mag0 = Math.pow(10, Math.floor(Math.log10(span / Math.max(2, maxTicks))));
  for (const k of [0.1, 1, 10]) {
    ([1, 2, 2.5, 5] as const).forEach((m, mi) => {
      const step = tidy(m * mag0 * k);
      if (!(step > 0) || span / step > 60) return;
      const ticks: number[] = [];
      for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi * (1 + 1e-12); i++) {
        const v = tidy(i * step);
        if (v > 0 && v >= lo) ticks.push(v);
      }
      cands.push({ ticks: thin(ticks), cost: mi === 2 ? 1.5 : mi * 0.5 });
    });
  }
  // Log-spaced decades (wide ranges, where linear ticks crowd at the bottom).
  if (hi / lo > 2.5) {
    LOG_SETS.forEach((set, si) => {
      const ticks: number[] = [];
      for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
        for (const m of set) {
          const v = tidy(m * Math.pow(10, e));
          if (v >= lo && v <= hi) ticks.push(v);
        }
      }
      cands.push({ ticks: thin(ticks), cost: 0.5 + si * 0.75 });
    });
  }

  let best: number[] = [];
  let bestScore = Infinity;
  for (const c of cands) {
    const n = c.ticks.length;
    if (n === 0) continue;
    const ys = c.ticks.map((v) => scale(v));
    let gMin = Infinity;
    let gMax = 0;
    for (let i = 1; i < n; i++) {
      const g = ys[i] - ys[i - 1];
      gMin = Math.min(gMin, g);
      gMax = Math.max(gMax, g);
    }
    const uneven = n > 2 ? (gMax - gMin) / gMax : 0;
    const miss = n < minTicks ? (minTicks - n) * 4 : n > maxTicks ? (n - maxTicks) * 4 : 0;
    // Ticks should reach both ends of the scale, not bunch in one half of it.
    const [top, bottom] = scale.range;
    const reach = n > 1 ? 1 - (ys[n - 1] - ys[0]) / Math.abs(bottom - top) : 1;
    const score = miss + c.cost + uneven * 2 + reach * 3;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = c.ticks;
    }
  }
  return best.slice(0, maxTicks + 1);
}

/** Index of the element of `sorted` (ascending) nearest to `v`; -1 when empty. */
export function nearestIndex(sorted: ArrayLike<number>, v: number): number {
  const n = sorted.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[hi] - v) < Math.abs(sorted[lo] - v) ? hi : lo;
}

/** Deterministic PRNG (mulberry32) for layout jitter/shuffles that must not change between renders. */
export function prng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Easing (same curves as the approved mockup). */
export const ease = {
  linear: (t: number) => t,
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
};
