// Deterministic synthetic scene for keyless development and as the UI's last-resort fallback.
// Every number is fabricated but shaped like a real build: a token that pumped ~6x inside the last
// month and bled back, early Smart Money deep in profit, bagholders from the top, and two dense
// break-even shelves above the price so reefs appear. The UI must badge it (`synthetic: true`).
import type { CallRecord, Cohort, CohortFlow, FogReason, HolderPoint, OhlcvPoint, Scene, SceneMeta } from "../types";

const PRICE_NOW = 0.0421;
const CIRCULATING = 1_000_000_000;
const LIQUIDITY_USD = 1_900_000;
const ANALYZED_SHARE = 0.612;
const EXCHANGE_SHARE = 0.1184;
const CONTRACT_SHARE = 0.0791;
const END_MS = Date.UTC(2026, 8, 25, 12, 0, 0);
const DEPLOYED_MS = Date.UTC(2025, 10, 4, 9, 12, 0);
const HOUR = 3_600_000;
const CANDLES = 30 * 24;
const CONCURRENCY = 6;

type Rng = {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  normal(mean?: number, sd?: number): number;
  chance(p: number): boolean;
};

function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    normal: (mean = 0, sd = 1) => {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    chance: (p) => next() < p,
  };
}

const sig = (x: number, digits: number) => Number(x.toPrecision(digits));
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

interface Draft {
  cohort: Cohort;
  weight: number;
  /** log2(profit multiple); null for fog. */
  logM: number | null;
  conviction: number;
  fog: FogReason | null;
  buys: number;
  sells: number;
}

/** A group of holders sharing one cost story. */
interface Segment {
  cohort: Cohort;
  count: number;
  /** Median balance before normalisation, and log-normal spread. */
  size: [median: number, sigma: number];
  logM: () => number;
  /** Probability the wallet never sold, and the trimmed conviction range otherwise. */
  holdP: number;
  trimmed: [number, number];
}

function segments(r: Rng): Segment[] {
  const breakEvenCluster = (move: number) => () => -Math.log2(move) + r.normal(0, 0.018);
  return [
    // Smart Money: early entries deep in profit, plus a cluster that bought the recent dip.
    { cohort: "sm", count: 19, size: [2.6e6, 0.8], logM: () => r.normal(1.9, 0.8), holdP: 0.55, trimmed: [0.35, 0.95] },
    { cohort: "sm", count: 7, size: [2.2e6, 0.6], logM: () => r.normal(0.2, 0.06), holdP: 0.85, trimmed: [0.6, 0.95] },
    // Whales: mixed, a few caught in the break-even shelves.
    { cohort: "whale", count: 31, size: [6e6, 0.6], logM: () => r.normal(1.0, 1.1), holdP: 0.45, trimmed: [0.25, 0.95] },
    { cohort: "whale", count: 1, size: [6e6, 0.3], logM: breakEvenCluster(1.18), holdP: 1, trimmed: [1, 1] },
    { cohort: "whale", count: 2, size: [6e6, 0.3], logM: breakEvenCluster(1.46), holdP: 0.2, trimmed: [0.3, 0.7] },
    // Public figures: late, mostly underwater.
    { cohort: "pf", count: 8, size: [1.4e6, 0.7], logM: () => r.normal(-0.5, 0.9), holdP: 0.5, trimmed: [0.3, 0.9] },
    // Other holders: bagholders from the top, two dense break-even shelves, a profitable minority.
    { cohort: "other", count: 30, size: [1.6e6, 0.7], logM: breakEvenCluster(1.18), holdP: 0.6, trimmed: [0.4, 0.9] },
    { cohort: "other", count: 24, size: [1.6e6, 0.7], logM: breakEvenCluster(1.46), holdP: 0.4, trimmed: [0.2, 0.8] },
    {
      cohort: "other",
      count: 68,
      size: [1.1e6, 0.9],
      logM: () => clamp(r.normal(-1.15, 0.5), -1.6, -0.03),
      holdP: 0.7,
      trimmed: [0.5, 0.95],
    },
    { cohort: "other", count: 40, size: [1.1e6, 0.9], logM: () => r.normal(0.9, 0.7), holdP: 0.4, trimmed: [0.2, 0.9] },
  ];
}

/** Which segments can be fog, and how many: CEX withdrawals and airdrops leave no on-chain cost. */
const FOG_PLAN: { segment: number; count: number }[] = [
  { segment: 0, count: 1 },
  { segment: 2, count: 3 },
  { segment: 5, count: 1 },
  { segment: 8, count: 10 },
  { segment: 9, count: 6 },
];
const FOG_REASONS: FogReason[] = [
  ...Array<FogReason>(14).fill("no_cost"),
  ...Array<FogReason>(5).fill("out_of_range"),
  ...Array<FogReason>(2).fill("pnl_error"),
];

function makeHolders(r: Rng): HolderPoint[] {
  const segs = segments(r);
  const drafts: Draft[] = [];
  const bySegment: Draft[][] = segs.map(() => []);

  segs.forEach((s, si) => {
    for (let i = 0; i < s.count; i++) {
      const hold = r.chance(s.holdP);
      const conviction = hold ? 1 : r.range(s.trimmed[0], s.trimmed[1]);
      const d: Draft = {
        cohort: s.cohort,
        weight: s.size[0] * Math.exp(r.normal(0, s.size[1])),
        logM: s.logM(),
        conviction,
        fog: null,
        buys: s.cohort === "sm" ? r.int(3, 18) : r.int(1, 30),
        sells: hold ? 0 : r.int(1, s.cohort === "whale" ? 22 : 12),
      };
      drafts.push(d);
      bySegment[si].push(d);
    }
  });

  // Fog: pick members of the planned segments (largest-first for whales so the fog is visible).
  let reason = 0;
  for (const { segment, count } of FOG_PLAN) {
    const pool = [...bySegment[segment]];
    if (segs[segment].cohort === "whale") pool.sort((a, b) => b.weight - a.weight);
    for (let i = 0; i < count && pool.length > 0; i++) {
      const idx = segs[segment].cohort === "whale" ? i * 2 : r.int(0, pool.length - 1);
      const d = pool.splice(Math.min(idx, pool.length - 1), 1)[0];
      d.fog = FOG_REASONS[reason++ % FOG_REASONS.length];
      d.logM = null;
      if (d.fog === "pnl_error") {
        d.conviction = 1;
        d.buys = 0;
        d.sells = 0;
      }
    }
  }

  drafts.sort((a, b) => b.weight - a.weight);
  const total = drafts.reduce((s, d) => s + d.weight, 0);
  const scale = (ANALYZED_SHARE * CIRCULATING) / total;

  return drafts.map((d, id) => {
    const amount = round(d.weight * scale, 2);
    const maxHeld = round(amount / d.conviction, 2);
    const cost = d.logM == null ? null : sig(PRICE_NOW / 2 ** d.logM, 6);
    return {
      id,
      cohort: d.cohort,
      amount,
      supplyShare: sig(amount / CIRCULATING, 8),
      cost,
      multiple: cost == null ? null : sig(PRICE_NOW / cost, 6),
      conviction: round(clamp(amount / maxHeld, 0, 1), 4),
      maxHeld,
      buys: d.buys,
      sells: d.sells,
      fog: d.fog,
    };
  });
}

/** Log-price anchors (hour index, price): slow grind, a ~6x pump, lower high, two shelves, capitulation, bounce. */
const PRICE_ANCHORS: [number, number][] = [
  [0, 0.018],
  [120, 0.0205],
  [190, 0.0232],
  [230, 0.061],
  [262, 0.118],
  [290, 0.093],
  [322, 0.104],
  [370, 0.07],
  [400, 0.0622],
  [470, 0.0612],
  [505, 0.056],
  [530, 0.0501],
  [590, 0.0494],
  [625, 0.042],
  [668, 0.0362],
  [700, 0.0395],
  [CANDLES - 1, PRICE_NOW],
];

function makeOhlcv(r: Rng): OhlcvPoint[] {
  const base: number[] = [];
  for (let k = 0; k < PRICE_ANCHORS.length - 1; k++) {
    const [h0, p0] = PRICE_ANCHORS[k];
    const [h1, p1] = PRICE_ANCHORS[k + 1];
    for (let h = h0; h < h1; h++) {
      const u = (h - h0) / (h1 - h0);
      const e = (1 - Math.cos(Math.PI * u)) / 2;
      base.push(Math.log(p0) + (Math.log(p1) - Math.log(p0)) * e);
    }
  }
  base.push(Math.log(PRICE_NOW));

  const start = END_MS - CANDLES * HOUR;
  const out: OhlcvPoint[] = [];
  let noise = 0;
  let prevClose = PRICE_ANCHORS[0][1];
  for (let i = 0; i < CANDLES; i++) {
    // Volatility is highest around the pump.
    const vol = i > 185 && i < 330 ? 0.02 : 0.011;
    noise = 0.9 * noise + r.normal(0, vol);
    const taper = Math.min(1, (CANDLES - 1 - i) / 10);
    const close = i === CANDLES - 1 ? PRICE_NOW : Math.exp(base[i] + noise * taper);
    const open = i === 0 ? close * (1 + r.normal(0, 0.004)) : prevClose;
    const wick = vol * 0.45;
    const high = Math.max(open, close) * (1 + Math.abs(r.normal(0, wick)));
    const low = Math.min(open, close) * (1 - Math.abs(r.normal(0, wick)));
    out.push({ t: start + i * HOUR, o: sig(open, 6), h: sig(high, 6), l: sig(low, 6), c: sig(close, 6) });
    prevClose = close;
  }
  return out;
}

interface Task {
  endpoint: string;
  credits: number;
  ms: number;
  status: number;
  holderId?: number;
}

/** Runs tasks through a fixed-size pool in dispatch order; each record's `at` is its completion time. */
function runPool(r: Rng, tasks: Task[], startAt: number): { records: CallRecord[]; endAt: number } {
  const free = Array<number>(CONCURRENCY).fill(startAt);
  const records: CallRecord[] = [];
  for (const task of tasks) {
    let slot = 0;
    for (let s = 1; s < free.length; s++) if (free[s] < free[slot]) slot = s;
    const done = free[slot] + task.ms;
    free[slot] = done + r.int(1, 6);
    const rec: CallRecord = {
      endpoint: task.endpoint,
      status: task.status,
      credits: task.credits,
      ms: task.ms,
      cached: false,
      at: done,
    };
    if (task.holderId != null) rec.holderId = task.holderId;
    records.push(rec);
  }
  records.sort((a, b) => a.at - b.at);
  return { records, endAt: Math.max(startAt, ...records.map((c) => c.at)) };
}

function makeCalls(r: Rng, holders: HolderPoint[]): { calls: CallRecord[]; durationMs: number } {
  const setup: Task[] = [
    ...[0, 1, 2, 3].map(() => ({ endpoint: "tgm/holders", credits: 5, ms: r.int(520, 880), status: 200 })),
    ...[0, 1].map(() => ({ endpoint: "tgm/who-bought-sold", credits: 1, ms: r.int(380, 640), status: 200 })),
    { endpoint: "tgm/token-information", credits: 1, ms: r.int(210, 330), status: 200 },
    { endpoint: "tgm/token-ohlcv", credits: 1, ms: r.int(180, 300), status: 200 },
  ];
  const phase1 = runPool(r, setup, 0);

  const fanOut: Task[] = holders.map((h) =>
    h.fog === "pnl_error"
      ? { endpoint: "profiler/address/pnl", credits: 0, ms: r.int(900, 1400), status: 500, holderId: h.id }
      : { endpoint: "profiler/address/pnl", credits: 1, ms: r.int(120, 420), status: 200, holderId: h.id },
  );
  fanOut.push({ endpoint: "tgm/flow-intelligence", credits: 1, ms: r.int(260, 380), status: 200 });
  const phase2 = runPool(r, fanOut, phase1.endAt + r.int(12, 24));

  return { calls: [...phase1.records, ...phase2.records], durationMs: phase2.endAt + r.int(30, 60) };
}

function makeFlows(r: Rng): CohortFlow[] {
  const jitter = (v: number) => Math.round(v * r.range(0.9, 1.1));
  return [
    { cohort: "sm", netFlowUsd: jitter(186_000), walletCount: 6 },
    { cohort: "whale", netFlowUsd: jitter(-1_240_000), walletCount: 11 },
    { cohort: "pf", netFlowUsd: jitter(-42_000), walletCount: 2 },
    { cohort: "fresh", netFlowUsd: jitter(318_000), walletCount: 47 },
    { cohort: "exchange", netFlowUsd: jitter(2_060_000), walletCount: 5 },
  ];
}

export function makeSyntheticScene(seed = 7): Scene {
  const r = makeRng(seed);
  const holders = makeHolders(r);
  const ohlcv = makeOhlcv(r);
  const flows = makeFlows(r);
  const { calls, durationMs } = makeCalls(r, holders);

  const analyzed = holders.reduce((s, h) => s + h.amount, 0);
  const fog = holders.reduce((s, h) => s + (h.cost == null ? h.amount : 0), 0);

  const meta: SceneMeta = {
    chain: "base",
    tokenAddress: "0x000000000000000000000000000000000000de70",
    symbol: "DEMO",
    name: "Synthetic preview",
    priceNow: PRICE_NOW,
    liquidityUsd: LIQUIDITY_USD,
    marketCapUsd: Math.round(PRICE_NOW * CIRCULATING),
    circulatingSupply: CIRCULATING,
    totalHolders: 18_437,
    deployedAt: new Date(DEPLOYED_MS).toISOString(),
    pnlFrom: new Date(DEPLOYED_MS).toISOString(),
    pnlTo: new Date(END_MS).toISOString(),
    generatedAt: new Date(END_MS).toISOString(),
  };

  return {
    version: 1,
    meta,
    holders,
    coverage: {
      holdersAnalyzed: holders.length,
      analyzedSupplyShare: sig(analyzed / CIRCULATING, 6),
      fogShare: sig(fog / analyzed, 6),
      exchangeShare: EXCHANGE_SHARE,
      contractShare: CONTRACT_SHARE,
    },
    ohlcv,
    flows,
    calls,
    totals: {
      calls: calls.length,
      networkCalls: calls.filter((c) => !c.cached).length,
      credits: calls.reduce((s, c) => s + c.credits, 0),
      cacheHits: calls.filter((c) => c.cached).length,
      durationMs,
    },
    synthetic: true,
  };
}
