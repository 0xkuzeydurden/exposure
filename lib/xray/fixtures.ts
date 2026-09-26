// Deterministic synthetic scan for building the UI without spending credits. Always synthetic: true.
//
// It restates the approved mockup ($KAIRO on Base, "Synthetic preview"): price $0.0412, +18.4% over
// the 7-day film (slow climb, pump, bleed, small recovery); informed money (smart money + whales +
// public figures) net sold ~$2.0M = -3.1% of supply while fresh wallets bought $1.6M and exchanges
// took in +0.8%; a sell wall at $0.050 (+22%, 2.3x the pool); smart money's average entry $0.030
// (+38%, trimming); the top 80 buyers trace back to 23 funding sources, 30 of them funded by one wallet.
//
// Source counting follows the pipeline (lib/xray/pipeline/buyers.ts): exchange- or bridge-funded
// buyers count one source EACH (Binance is not one person) and untraced buyers count none. With the
// mockup's "Binance 14 + Coinbase 9" that could never add up to 23, so the clusters are: one wallet 30,
// Binance 8, Coinbase 4, Relay 1, five small wallet groups (6/4/3/2/2), four lone wallets and 16
// untraced (20% of the 80) => 10 wallet sources + 13 service-funded buyers = 23; 23 / 64 traced = 0.36,
// so demand reads MIXED and the diagnosis is rule 2, "Smart money is selling to the crowd."
// Every address starts with 0x5eed ("seed") and is fake: it shows as "0x5eed…1a2b" on screen.
import { shortAddress } from "../nansen/chains";
import { EP } from "../nansen/endpoints";
import { ceilingOf, demandOf, diagnose, flowVerdictOf, smartStanceOf, smartStateOf } from "./diagnosis";
import { publicClusters } from "./redact";
import type {
  BigBuy,
  BuyerRow,
  BuyersFinding,
  CallRecord,
  FindingKey,
  FlowDay,
  FlowFinding,
  FlowPoint,
  LadderBin,
  PricePoint,
  Scan,
  ScanMeta,
  SmartFinding,
  SourceCluster,
  SourceKind,
  Wall,
  WalletCheck,
  WallsFinding,
} from "./types";

export const SYNTHETIC_SEED = 7;
export const SYNTHETIC_TOKEN = `0x5eed${"0".repeat(30)}c0ffee`;
export const SYNTHETIC_WALLET = `0x5eed${"0".repeat(30)}decaf0`;

const CHAIN = "base";
const PRICE_NOW = 0.0412;
const CHANGE_7D = 0.184;
const LIQUIDITY_USD = 1_900_000;
const HOUR = 3_600_000;
const HOURS = 168;
/** Last hourly close of the film. */
const END_MS = Date.UTC(2026, 8, 26, 14, 0, 0);
/** The scan started at 14:01:20 UTC and finishes about a minute later. */
const START_MS = END_MS + 80_000;
const SCAN_NO = 412;

// 02 · flow
const INFORMED_NET_USD = -2_000_000;
/** Informed money buys until this hour, then turns net seller (~20h before the price top). */
const INFORMED_TURN_HOUR = 58;
const INFORMED_EARLY_USD = 350_000;
const INFORMED_NET_PCT = -0.031;
const FRESH_NET_USD = 1_600_000;
const FRESH_LAST_DAY_USD = 410_000;
const EXCHANGE_NET_PCT = 0.008;

// 01 · buyers
const TOTAL_BUYERS = 412;
const TOP_SHARE = 0.91;
const ANALYSED_BUY_USD = 5_280_000;

// 03 · walls
const ANALYSED_SUPPLY = 0.71;
const HOLDERS_SELECTED = 80;
const HOLDERS_ANALYSED = 74;

// 04 · smart money (30-day window, aggregated)
const SM_ENTRY = 0.02985;
const SM_WALLETS = 14;
const SM_BOUGHT_USD = 1_900_000;
const SM_SOLD_USD = 2_900_000;

// Nansen client model (lib/nansen/client.ts): 280 requests/min token bucket, burst 9, 6 in flight.
const RATE_PER_MIN = 280;
const BURST = 9;
const CONCURRENCY = 6;

/* ---------------- rng + helpers ---------------- */

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
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function fakeAddress(r: Rng): string {
  let s = "0x5eed";
  for (let i = 0; i < 36; i++) s += "0123456789abcdef"[Math.floor(r.next() * 16)];
  return s;
}

const profilerUrl = (address: string) => `https://app.nansen.ai/profiler?address=${address}&chain=${CHAIN}`;

/**
 * Scales one side of arr[from..to) so the slice sums exactly to `target`: the positives when the
 * target is a net inflow, the negatives when it is a net outflow.
 */
function scaleNet(arr: number[], from: number, to: number, target: number): void {
  let pos = 0;
  let neg = 0;
  for (let i = from; i < to; i++) {
    if (arr[i] > 0) pos += arr[i];
    else neg -= arr[i];
  }
  const mid = Math.floor((from + to) / 2);
  if (target >= 0) {
    if (pos === 0) {
      arr[mid] += target + neg;
      return;
    }
    const k = (target + neg) / pos;
    for (let i = from; i < to; i++) if (arr[i] > 0) arr[i] *= k;
  } else {
    if (neg === 0) {
      arr[mid] += target - pos;
      return;
    }
    const k = (-target + pos) / neg;
    for (let i = from; i < to; i++) if (arr[i] < 0) arr[i] *= k;
  }
}

/* ---------------- film: price + big buys ---------------- */

function makePrice(r: Rng): PricePoint[] {
  const logs = [0];
  for (let i = 1; i < HOURS; i++) {
    const t = i / (HOURS - 1);
    const drift = t < 0.38 ? 0.0026 : t < 0.47 ? 0.024 : t < 0.8 ? -0.0085 : 0.0036;
    logs.push(logs[i - 1] + drift + r.normal(0, 0.011));
  }
  // Pin both ends: first close = now / 1.184, last close = $0.0412.
  const start = Math.log(PRICE_NOW / (1 + CHANGE_7D));
  const err = logs[HOURS - 1] - Math.log(1 + CHANGE_7D);
  return logs.map((l, i) => ({
    t: END_MS - (HOURS - 1 - i) * HOUR,
    c: sig(Math.exp(start + l - (err * i) / (HOURS - 1)), 5),
  }));
}

function makeBigBuys(r: Rng, price: PricePoint[]): BigBuy[] {
  const out: BigBuy[] = [];
  for (let n = 0; n < 34; n++) {
    const i = Math.min(HOURS - 1, Math.floor(Math.pow(r.next(), 0.8) * HOURS));
    out.push({
      t: price[i].t - r.int(0, 59) * 60_000,
      price: sig(price[i].c * (1 + r.normal(0, 0.006)), 5),
      usd: Math.round(Math.exp(r.range(Math.log(8_000), Math.log(140_000)))),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------------- 01 · buyers ---------------- */

interface SourceSpec {
  kind: SourceKind;
  name?: string;
  wallets: number;
  /** Share of the analysed buyers' buy volume. */
  share: number;
}

const SOURCES: SourceSpec[] = [
  { kind: "wallet", wallets: 30, share: 0.31 },
  { kind: "exchange", name: "Binance", wallets: 8, share: 0.14 },
  { kind: "wallet", wallets: 6, share: 0.08 },
  { kind: "exchange", name: "Coinbase", wallets: 4, share: 0.06 },
  { kind: "wallet", wallets: 4, share: 0.06 },
  { kind: "wallet", wallets: 3, share: 0.045 },
  { kind: "wallet", wallets: 2, share: 0.03 },
  { kind: "wallet", wallets: 2, share: 0.025 },
  { kind: "bridge", name: "Relay", wallets: 1, share: 0.025 },
  { kind: "wallet", wallets: 1, share: 0.02 },
  { kind: "wallet", wallets: 1, share: 0.018 },
  { kind: "wallet", wallets: 1, share: 0.015 },
  { kind: "wallet", wallets: 1, share: 0.012 },
  { kind: "untraced", wallets: 16, share: 0.16 },
];

function makeBuyers(r: Rng): BuyersFinding {
  const clusters: SourceCluster[] = [];
  let walletGroups = 0;
  for (const spec of SOURCES) {
    const usdTotal = Math.round(spec.share * ANALYSED_BUY_USD);
    const weights = Array.from({ length: spec.wallets }, () => Math.exp(r.normal(0, 0.55)));
    const wsum = sum(weights);
    // Root funder of a wallet group, or the exchange / bridge hot wallet.
    const root = spec.kind === "untraced" ? undefined : fakeAddress(r);
    let left = usdTotal;
    const members: BuyerRow[] = [];
    weights.forEach((w, j) => {
      const usd = j === weights.length - 1 ? left : Math.round((usdTotal * w) / wsum);
      left -= usd;
      const address = fakeAddress(r);
      const row: BuyerRow = {
        address,
        short: shortAddress(address),
        boughtUsd: usd,
        boughtTokens: Math.round(usd / (0.046 * Math.exp(r.normal(0, 0.12)))),
        nansenUrl: profilerUrl(address),
      };
      if (root) {
        // Inside a wallet group some buyers were funded by an earlier buyer (A funds B, B funds C).
        const viaMember = spec.kind === "wallet" && j >= 3 && r.chance(0.4);
        row.funder = viaMember ? members[r.int(0, members.length - 1)].address : root;
        if (spec.name) row.funderLabel = spec.name;
      }
      members.push(row);
    });
    members.sort((a, b) => b.boughtUsd - a.boughtUsd);
    const id =
      spec.kind === "wallet" ? `wallet-${++walletGroups}` : spec.kind === "untraced" ? "untraced" : `${spec.kind}-${spec.name!.toLowerCase()}`;
    clusters.push({
      id,
      kind: spec.kind,
      label: spec.kind === "untraced" ? "Untraced" : (spec.name ?? shortAddress(root!)),
      ...(spec.kind === "wallet" && root ? { funder: root } : {}),
      wallets: members.length,
      boughtUsd: usdTotal,
      share: 0,
      members,
    });
  }

  const analysedUsd = sum(clusters.map((c) => c.boughtUsd));
  for (const c of clusters) c.share = round(c.boughtUsd / analysedUsd, 4);
  // Pipeline order: traced sources by volume, the untraced group last.
  clusters.sort((a, b) => {
    if ((a.kind === "untraced") !== (b.kind === "untraced")) return a.kind === "untraced" ? 1 : -1;
    return b.boughtUsd - a.boughtUsd || b.wallets - a.wallets;
  });

  const topBuyers = sum(clusters.map((c) => c.wallets));
  const untraced = sum(clusters.filter((c) => c.kind === "untraced").map((c) => c.wallets));
  const walletSources = clusters.filter((c) => c.kind === "wallet" || c.kind === "self");
  const serviceFunded = sum(clusters.filter((c) => c.kind === "exchange" || c.kind === "bridge").map((c) => c.wallets));
  const biggest = walletSources.reduce((a, b) => (b.share > a.share ? b : a));

  const finding: BuyersFinding = {
    status: "ok",
    windowDays: 7,
    totalBuyers: TOTAL_BUYERS,
    topBuyers,
    topShare: TOP_SHARE,
    sources: walletSources.length + serviceFunded,
    untracedShare: round(untraced / topBuyers, 4),
    biggestSourceShare: biggest.share,
    biggestSourceWallets: biggest.wallets,
    // Published like a real scan: buyer and funder addresses, no wallet labels (lib/xray/redact.ts).
    clusters: publicClusters(clusters),
    demand: "mixed",
  };
  finding.demand = demandOf(finding);
  return finding;
}

/* ---------------- 02 · flow ---------------- */

function hoursText(ms: number): string {
  const h = Math.round(ms / HOUR);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h}h`;
}

function makeFlow(r: Rng, price: PricePoint[]): { flow: FlowFinding; supply: number } {
  // Informed money: sporadic hourly spikes, net buying until the turn, net selling after it.
  const informedUsd = new Array<number>(HOURS).fill(0);
  for (let h = 1; h < HOURS; h++) {
    if (!r.chance(0.5)) continue;
    const early = h < INFORMED_TURN_HOUR;
    const main = early ? 1 : -1;
    informedUsd[h] = (r.chance(0.8) ? main : -main) * Math.exp(r.normal(Math.log(22_000), 0.8));
  }
  scaleNet(informedUsd, 1, INFORMED_TURN_HOUR, INFORMED_EARLY_USD);
  scaleNet(informedUsd, INFORMED_TURN_HOUR, HOURS, INFORMED_NET_USD - INFORMED_EARLY_USD);
  for (let h = 0; h < HOURS; h++) informedUsd[h] = Math.round(informedUsd[h]);
  // Rounding residue goes to the biggest selling hour so the week nets exactly -$2.0M.
  const residue = INFORMED_NET_USD - sum(informedUsd);
  const worst = informedUsd.reduce((best, v, i) => (v < informedUsd[best] ? i : best), 0);
  informedUsd[worst] += residue;

  const informedTokens = informedUsd.map((u, h) => u / price[h].c);
  const informedCum: number[] = [];
  informedTokens.reduce((acc, x, h) => (informedCum[h] = acc + x), 0);
  // Circulating supply chosen so the week's informed net is exactly -3.1% of it.
  const supply = Math.round(informedCum[HOURS - 1] / INFORMED_NET_PCT / 1e5) * 1e5;

  // Exchanges: inflows pick up during the bleed and net +0.8% of supply.
  const exchangeTokens = new Array<number>(HOURS).fill(0);
  for (let h = 1; h < HOURS; h++) {
    if (!r.chance(h > 70 ? 0.4 : 0.15)) continue;
    exchangeTokens[h] = (r.chance(0.72) ? 1 : -1) * Math.exp(r.normal(Math.log(600_000), 0.7));
  }
  scaleNet(exchangeTokens, 1, HOURS, EXCHANGE_NET_PCT * supply);
  const exchangeCum: number[] = [];
  exchangeTokens.reduce((acc, x, h) => (exchangeCum[h] = acc + x), 0);

  const informed: FlowPoint[] = price.map((p, h) => ({
    t: p.t,
    cumPctSupply: round(informedCum[h] / supply, 6),
    netUsd: informedUsd[h],
  }));
  const exchange: FlowPoint[] = price.map((p, h) => ({
    t: p.t,
    cumPctSupply: round(exchangeCum[h] / supply, 6),
    netUsd: Math.round(exchangeTokens[h] * p.c),
  }));

  const daily: FlowDay[] = [];
  for (let d = 0; d < 7; d++) {
    const hs = Array.from({ length: 24 }, (_, k) => d * 24 + k);
    daily.push({
      day: iso(price[hs[23]].t).slice(0, 10),
      informedUsd: sum(hs.map((h) => informed[h].netUsd)),
      // flow-intelligence only reports fresh wallets for 1d / 7d windows: today is the one day we know.
      freshUsd: d === 6 ? FRESH_LAST_DAY_USD : null,
      exchangeUsd: sum(hs.map((h) => exchange[h].netUsd)),
    });
  }

  const flow: FlowFinding = {
    status: "ok",
    informedNetUsd: sum(informedUsd),
    informedNetPctSupply: round(informedCum[HOURS - 1] / supply, 5),
    freshNetUsd: FRESH_NET_USD,
    exchangeNetPctSupply: round(exchangeCum[HOURS - 1] / supply, 5),
    series: [
      { cohort: "informed", points: informed },
      { cohort: "exchange", points: exchange },
    ],
    daily,
    verdict: "quiet",
  };

  // Same rule as the pipeline's leadObservation: informed money peaked >= 6h before the price top.
  const pTop = price.reduce((a, b) => (b.c > a.c ? b : a));
  const iTop = informed.reduce((a, b) => (b.cumPctSupply > a.cumPctSupply ? b : a));
  if (pTop.t < END_MS - 6 * HOUR && iTop.t <= pTop.t - 6 * HOUR) {
    flow.lead = { t: iTop.t, text: `Informed money started selling ${hoursText(pTop.t - iTop.t)} before the price peaked.` };
  }
  return { flow, supply };
}

/* ---------------- 03 · walls ---------------- */

interface WallSpec {
  price: number;
  lo: number;
  hi: number;
  /** Wall value / pool liquidity. */
  liquidityMultiple: number;
  alreadyTrimming: number;
  holders: number;
}

const WALLS: WallSpec[] = [
  { price: 0.0445, lo: 0.0428, hi: 0.0458, liquidityMultiple: 0.66, alreadyTrimming: 0.12, holders: 9 },
  { price: 0.0503, lo: 0.0472, hi: 0.0532, liquidityMultiple: 2.31, alreadyTrimming: 0.34, holders: 23 },
  { price: 0.061, lo: 0.0575, hi: 0.0645, liquidityMultiple: 1.62, alreadyTrimming: 0.58, holders: 11 },
];

/** Holders in profit (share of analysed supply): the cool bands under the price. */
const COOL_BANDS = [
  { lo: 0.0212, hi: 0.0238, share: 0.04 },
  { lo: 0.0272, hi: 0.0322, share: 0.14 },
  { lo: 0.0338, hi: 0.0382, share: 0.06 },
];

/** The side ladder spans the film's price range; the cheaper early entries sit below it. */
const LADDER_LO = 0.018;
const LADDER_STEP = 1.05;
const LADDER_BINS = 29;

function makeWalls(r: Rng, supply: number): WallsFinding {
  const analysedTokens = ANALYSED_SUPPLY * supply;
  const bins = Array.from({ length: LADDER_BINS }, (_, k) => ({
    lo: LADDER_LO * LADDER_STEP ** k,
    hi: LADDER_LO * LADDER_STEP ** (k + 1),
    tokens: 0,
  }));
  const mid = (b: { lo: number; hi: number }) => Math.sqrt(b.lo * b.hi);

  const walls: Wall[] = WALLS.map((w) => {
    const tokens = Math.round((w.liquidityMultiple * LIQUIDITY_USD) / w.price);
    return {
      price: w.price,
      movePct: round(w.price / PRICE_NOW - 1, 4),
      tokens,
      supplyShare: round(tokens / supply, 5),
      wallToLiquidity: round((tokens * w.price) / LIQUIDITY_USD, 3),
      alreadyTrimming: w.alreadyTrimming,
      holders: w.holders,
    };
  });

  const bands = [
    ...WALLS.map((w, i) => ({ lo: w.lo, hi: w.hi, tokens: walls[i].tokens })),
    ...COOL_BANDS.map((b) => ({ lo: b.lo, hi: b.hi, tokens: b.share * analysedTokens })),
  ];
  const owner = bins.map((b) => bands.findIndex((band) => mid(b) >= band.lo && mid(b) <= band.hi));
  bands.forEach((band, bi) => {
    let idx = owner.flatMap((o, k) => (o === bi ? [k] : []));
    if (!idx.length) {
      const centre = Math.sqrt(band.lo * band.hi);
      const k = bins.findIndex((b) => centre >= b.lo && centre < b.hi);
      if (k >= 0) {
        owner[k] = bi;
        idx = [k];
      }
    }
    const weights = idx.map(() => 1 + r.range(0, 0.4));
    const wsum = sum(weights);
    idx.forEach((k, j) => (bins[k].tokens += (band.tokens * weights[j]) / wsum));
  });
  bins.forEach((b, k) => {
    if (owner[k] < 0) b.tokens = analysedTokens * r.range(0.004, 0.008);
  });

  const ladder: LadderBin[] = bins.map((b) => {
    const tokens = Math.round(b.tokens);
    return { lo: sig(b.lo, 5), hi: sig(b.hi, 5), tokens, supplyShare: round(tokens / supply, 6) };
  });
  const underwater = sum(ladder.filter((b) => mid(b) > PRICE_NOW).map((b) => b.tokens)) / analysedTokens;

  const finding: WallsFinding = {
    status: "ok",
    method: "cost_basis",
    holdersAnalyzed: HOLDERS_ANALYSED,
    analyzedSupplyShare: ANALYSED_SUPPLY,
    underwaterShare: round(underwater, 3),
    walls,
    ladder,
    ceiling: "light",
  };
  finding.ceiling = ceilingOf(finding, supply);
  return finding;
}

/* ---------------- 04 · smart money ---------------- */

function makeSmart(): SmartFinding {
  return {
    status: "ok",
    windowDays: 30,
    avgEntry: SM_ENTRY,
    pnlPct: round(PRICE_NOW / SM_ENTRY - 1, 4),
    wallets: SM_WALLETS,
    boughtUsd: SM_BOUGHT_USD,
    soldUsd: SM_SOLD_USD,
    netUsd: SM_BOUGHT_USD - SM_SOLD_USD,
    stance: smartStanceOf(SM_BOUGHT_USD, SM_SOLD_USD),
    state: smartStateOf(SM_ENTRY, PRICE_NOW),
  };
}

/* ---------------- evidence: the call log ---------------- */

interface Task {
  endpoint: string;
  finding: FindingKey;
  credits: number;
  ms: number;
  cached?: boolean;
}

const tasks = (n: number, endpoint: string, finding: FindingKey, credits: number, ms: () => number): Task[] =>
  Array.from({ length: n }, () => ({ endpoint, finding, credits, ms: ms() }));

/**
 * A deep scan, stage by stage (each stage waits for the previous one):
 *   context  5  token-information 1d + 7d, token-ohlcv 1h, flow-intelligence 1d + 7d
 *   buyers 145  who-bought-sold BUY 7d, tgm/dex-trades x2 (first buys), first-funder x80 (one cached) + 62 second hops
 *   flow     4  tgm/flows: smart money, whale, public figure, exchange (7d hourly)
 *   walls   92  tgm/holders x6 (5 credits each), who-bought-sold whale + public figure, profiler pnl x84 (80 holders + 4 narrowed retries)
 *   smart    2  who-bought-sold smart money BUY + SELL 30d
 *   = 248 calls, 247 network, 1 cache hit, 271 credits.
 */
function makeCalls(r: Rng): { calls: CallRecord[]; durationMs: number } {
  const ms = (lo: number, hi: number) => () => r.int(lo, hi);
  const firstFunders = tasks(HOLDERS_SELECTED, EP.firstFunder, "buyers", 1, ms(140, 320));
  const cachedAt = 17;
  firstFunders[cachedAt] = { ...firstFunders[cachedAt], credits: 0, ms: r.int(2, 4), cached: true };
  const stages: Task[][] = [
    [
      ...tasks(2, EP.tokenInformation, "context", 1, ms(210, 330)),
      ...tasks(1, EP.tokenOhlcv, "context", 1, ms(180, 300)),
      ...tasks(2, EP.flowIntelligence, "context", 1, ms(260, 380)),
    ],
    tasks(1, EP.whoBoughtSold, "buyers", 1, ms(380, 640)),
    tasks(2, EP.tgmDexTrades, "buyers", 1, ms(300, 520)),
    firstFunders,
    tasks(62, EP.firstFunder, "buyers", 1, ms(140, 320)),
    tasks(4, EP.tgmFlows, "flow", 1, ms(280, 460)),
    [...tasks(6, EP.holders, "walls", 5, ms(520, 880)), ...tasks(2, EP.whoBoughtSold, "walls", 1, ms(380, 640))],
    tasks(HOLDERS_SELECTED + 4, EP.addressPnl, "walls", 1, ms(120, 420)),
    tasks(2, EP.whoBoughtSold, "smart", 1, ms(380, 640)),
  ];

  const perMs = RATE_PER_MIN / 60_000;
  let bucket = BURST;
  let bucketAt = 0;
  let stageStart = r.int(15, 30);
  const calls: CallRecord[] = [];
  for (const stage of stages) {
    const free = new Array<number>(CONCURRENCY).fill(stageStart);
    let stageEnd = stageStart;
    for (const task of stage) {
      let slot = 0;
      for (let s = 1; s < free.length; s++) if (free[s] < free[slot]) slot = s;
      let start = free[slot];
      if (!task.cached) {
        // FIFO token bucket shared by every request of the key.
        start = Math.max(start, bucketAt);
        let tokens = Math.min(BURST, bucket + (start - bucketAt) * perMs);
        if (tokens < 1) {
          start += (1 - tokens) / perMs;
          tokens = 1;
        }
        bucket = tokens - 1;
        bucketAt = start;
      }
      const done = Math.round(start + task.ms);
      free[slot] = done + r.int(1, 5);
      stageEnd = Math.max(stageEnd, done);
      calls.push({
        endpoint: task.endpoint,
        status: 200,
        credits: task.credits,
        ms: task.ms,
        cached: !!task.cached,
        at: done,
        finding: task.finding,
      });
    }
    stageStart = stageEnd + r.int(8, 20);
  }
  calls.sort((a, b) => a.at - b.at);
  return { calls, durationMs: calls[calls.length - 1].at + r.int(30, 60) };
}

/* ---------------- the scan ---------------- */

export function makeSyntheticScan(seed: number = SYNTHETIC_SEED): Scan {
  const r = makeRng(seed);
  const price = makePrice(r);
  const bigBuys = makeBigBuys(r, price);
  const buyers = makeBuyers(r);
  const { flow, supply } = makeFlow(r, price);
  const walls = makeWalls(r, supply);
  const smart = makeSmart();
  const { calls, durationMs } = makeCalls(r);

  const meta: ScanMeta = {
    chain: CHAIN,
    tokenAddress: SYNTHETIC_TOKEN,
    symbol: "$KAIRO",
    name: "Synthetic preview",
    priceNow: price[HOURS - 1].c,
    priceChange7d: round(price[HOURS - 1].c / price[0].c - 1, 3),
    marketCapUsd: Math.round(supply * PRICE_NOW),
    liquidityUsd: LIQUIDITY_USD,
    circulatingSupply: supply,
    holders: 18_204,
    buyers24h: 1_284,
    sellers24h: 911,
    volume24hUsd: 3_140_000,
    deployedAt: "2026-06-02T09:12:00.000Z",
    scannedAt: iso(START_MS + durationMs),
    scanNo: SCAN_NO,
    window: { from: iso(END_MS - HOURS * HOUR), to: iso(END_MS) },
  };
  flow.verdict = flowVerdictOf(flow, meta);

  const findings = { buyers, flow, walls, smart };
  return {
    version: 1,
    tier: "deep",
    meta,
    price,
    bigBuys,
    findings,
    diagnosis: diagnose(findings, meta),
    calls,
    totals: {
      calls: calls.length,
      networkCalls: calls.filter((c) => !c.cached).length,
      credits: sum(calls.map((c) => c.credits)),
      cacheHits: calls.filter((c) => c.cached).length,
      durationMs,
    },
    synthetic: true,
  };
}

/**
 * Finding 05 for the synthetic scan: a wallet that bought at $0.0451, 51% above smart money's entry.
 * cheaperShare is read off the scan's own ladder (everything below the ladder counts as cheaper).
 */
export function makeSyntheticWalletCheck(scan: Scan = makeSyntheticScan()): WalletCheck {
  const cost = 0.0451;
  const { walls, smart } = scan.findings;
  const supply = scan.meta.circulatingSupply ?? 0;
  const analysedTokens = walls.analyzedSupplyShare * supply;
  const dearer = sum(walls.ladder.filter((b) => Math.sqrt(b.lo * b.hi) >= cost).map((b) => b.tokens));
  return {
    status: "ok",
    address: SYNTHETIC_WALLET,
    short: shortAddress(SYNTHETIC_WALLET),
    cost,
    pnlPct: round(scan.meta.priceNow / cost - 1, 4),
    vsSmartMoneyPct: smart.avgEntry ? round(cost / smart.avgEntry - 1, 4) : null,
    cheaperShare: analysedTokens > 0 ? round(1 - dearer / analysedTokens, 3) : null,
    holdingTokens: 412_000,
  };
}
