// Pure derivation helpers for the scene pipeline: holder selection, cohorts, exclusions, cost basis,
// fog, conviction, coverage and flows. No I/O: everything here is unit-tested with mocked payloads.
import { normalizeAddress, shortAddress, isEvmChain } from "../nansen/chains";
import type { FlowIntelligenceRow, HolderRow, OhlcvCandle, PnlRow } from "../nansen/schemas";
import type { Cohort, CohortFlow, Coverage, FogReason, HolderPoint, OhlcvPoint } from "../types";

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ exclusions

/**
 * Labels that mark a holder as a contract / LP / lock / burn rather than a person. Whole words only
 * ("Liverpool", "Repair", "Bridgewater" stay in); DEX names match as prefixes ("UniswapV2Pair").
 * Team wallets (deployer, multisig) are deliberately kept: they are real, usually low-cost positions.
 */
export const CONTRACT_LABEL_RE =
  /\b(?:pools?|pairs?|routers?|bridge|timelock|lock(?:er|ed|s)?|vesting|treasury|burn(?:ed|er)?|dead|staking|vaults?|orca|null|bonding)\b|\b(?:uniswap|pancake|aerodrome|raydium|meteora|pump\.fun|liquidity)/i;

/** Centralised-exchange names, as a backstop for exchange wallets missing from the exchange list. */
export const EXCHANGE_LABEL_RE =
  /\b(binance|coinbase|okx|kraken|bybit|kucoin|gate\.io|htx|huobi|bitget|mexc|crypto\.com|upbit|bithumb|bitfinex|gemini|bitstamp|bitmart|lbank|poloniex)\b/i;

const SOLANA_BURN = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);

export function isBurnAddress(chain: string, address: string): boolean {
  if (!isEvmChain(chain)) return SOLANA_BURN.has(address);
  const a = address.toLowerCase();
  return /^0x0{40}$/.test(a) || /^0x0{36}dead$/.test(a) || a.startsWith("0xdead000000000000000042069420694206942069");
}

export function isContractLabel(label: string | null | undefined): boolean {
  return !!label && CONTRACT_LABEL_RE.test(label);
}

export function isExchangeLabel(label: string | null | undefined): boolean {
  return !!label && EXCHANGE_LABEL_RE.test(label);
}

export function looksLikeAddress(s: string): boolean {
  return /0x[0-9a-fA-F]{40}/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

// ------------------------------------------------------------------ cohorts & selection

/** Priority SM > Public Figure > Whale > Other. */
export function assignCohort(flags: { sm?: boolean; pf?: boolean; whale?: boolean }): Cohort {
  if (flags.sm) return "sm";
  if (flags.pf) return "pf";
  if (flags.whale) return "whale";
  return "other";
}

/**
 * tgm/holders `ownership_percentage` units are not documented (historical endpoint uses 0..1).
 * Returns the divisor that turns it into a 0..1 fraction: 100 if the values are percentages.
 * `supply` should be the TOTAL supply (ownership is a share of it): with a circulating supply the
 * ratio is off by circulating / total. null falls back to the sum of the column.
 */
export function detectOwnershipScale(rows: HolderRow[], supply: number | null): number {
  if (supply && supply > 0) {
    const ratios = rows
      .filter((r) => (r.ownership_percentage ?? 0) > 0 && (r.token_amount ?? 0) > 0)
      .map((r) => r.ownership_percentage! / (r.token_amount! / supply))
      .sort((a, b) => a - b);
    if (ratios.length) return ratios[Math.floor(ratios.length / 2)] > 10 ? 100 : 1;
  }
  const sum = rows.reduce((s, r) => s + (r.ownership_percentage ?? 0), 0);
  return sum > 1.0001 ? 100 : 1;
}

export interface HolderCandidate {
  /** Address as returned by the API. */
  address: string;
  /** Normalised address (lowercase on EVM). */
  key: string;
  label: string | null;
  /** Balance from tgm/holders. */
  tokenAmount: number;
  ownershipPct: number | null;
  cohort: Cohort;
}

export interface SelectedHolder extends HolderCandidate {
  /** Rank by tokenAmount among the chosen holders (0 = largest). */
  id: number;
}

export interface SelectionInput {
  chain: string;
  tokenAddress: string;
  allHolders: HolderRow[];
  whales: HolderRow[];
  publicFigures: HolderRow[];
  exchanges: HolderRow[];
  /** Addresses seen in who-bought-sold with smart-money labels. */
  smartMoney: Iterable<string>;
  maxHolders: number;
  /** Supply used for shares (circulating, else total, else mcap / price); null → ownership_percentage. */
  supply: number | null;
  /**
   * Total supply, the unit of ownership_percentage, for detecting that column's scale (like with like).
   * When the key is absent `supply` is used (the legacy scene's behaviour); null = unknown.
   */
  totalSupply?: number | null;
}

export interface SelectionResult {
  chosen: SelectedHolder[];
  counts: Record<Cohort, number>;
  exchangeShare: number;
  contractShare: number;
  excluded: { exchange: number; contract: number };
  /** Divisor for ownership_percentage → fraction. */
  ownershipScale: number;
}

interface Merged {
  address: string;
  key: string;
  label: string | null;
  tokenAmount: number;
  ownershipPct: number | null;
  whale: boolean;
  pf: boolean;
  exchange: boolean;
}

export function shareOf(
  amount: number,
  ownershipPct: number | null,
  supply: number | null,
  ownershipScale: number,
): number {
  if (supply && supply > 0) return amount / supply;
  if (ownershipPct !== null && ownershipPct > 0) return ownershipPct / ownershipScale;
  return 0;
}

/** Largest share of the holder cap that may go to labelled holders below the top N by balance. */
export const LABELLED_QUOTA = 0.15;

export function selectHolders(input: SelectionInput): SelectionResult {
  const { chain } = input;
  const tokenKey = normalizeAddress(chain, input.tokenAddress);
  const sm = new Set<string>();
  for (const a of input.smartMoney) if (a) sm.add(normalizeAddress(chain, a));

  const merged = new Map<string, Merged>();
  const add = (rows: HolderRow[], flag?: "whale" | "pf" | "exchange") => {
    for (const r of rows) {
      if (!r.address) continue;
      const key = normalizeAddress(chain, r.address);
      const amount = r.token_amount ?? 0;
      let m = merged.get(key);
      if (!m) {
        m = {
          address: r.address,
          key,
          label: r.address_label ?? null,
          tokenAmount: amount,
          ownershipPct: r.ownership_percentage ?? null,
          whale: false,
          pf: false,
          exchange: false,
        };
        merged.set(key, m);
      } else {
        if (amount > m.tokenAmount) {
          m.tokenAmount = amount;
          m.ownershipPct = r.ownership_percentage ?? m.ownershipPct;
        }
        if (!m.label && r.address_label) m.label = r.address_label;
      }
      if (flag) m[flag] = true;
    }
  };
  add(input.allHolders);
  add(input.whales, "whale");
  add(input.publicFigures, "pf");
  add(input.exchanges, "exchange");

  const allRows = [...input.allHolders, ...input.whales, ...input.publicFigures, ...input.exchanges];
  const ownershipScale = detectOwnershipScale(allRows, input.totalSupply !== undefined ? input.totalSupply : input.supply);

  let exchangeShare = 0;
  let contractShare = 0;
  const excluded = { exchange: 0, contract: 0 };
  const eligible: HolderCandidate[] = [];

  for (const m of merged.values()) {
    if (!(m.tokenAmount > 0)) continue;
    const share = shareOf(m.tokenAmount, m.ownershipPct, input.supply, ownershipScale);
    if (m.exchange || isExchangeLabel(m.label)) {
      exchangeShare += share;
      excluded.exchange += 1;
      continue;
    }
    if (m.key === tokenKey || isBurnAddress(chain, m.address) || isContractLabel(m.label)) {
      contractShare += share;
      excluded.contract += 1;
      continue;
    }
    eligible.push({
      address: m.address,
      key: m.key,
      label: m.label,
      tokenAmount: m.tokenAmount,
      ownershipPct: m.ownershipPct,
      cohort: assignCohort({ sm: sm.has(m.key), pf: m.pf, whale: m.whale }),
    });
  }

  const byAmount = (a: HolderCandidate, b: HolderCandidate) =>
    b.tokenAmount - a.tokenAmount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const max = Math.max(0, Math.floor(input.maxHolders));
  // Top N by balance. Labelled holders (SM / PF / whale) that miss the cut may take the last few
  // slots, capped at LABELLED_QUOTA of N, so a cohort island is not empty just because it is small.
  const ranked = eligible.sort(byAmount);
  const labelledOutside = ranked.slice(max).filter((c) => c.cohort !== "other").length;
  const reserve = Math.min(Math.floor(max * LABELLED_QUOTA), labelledOutside);
  const tail = ranked
    .slice(max - reserve)
    .filter((c) => c.cohort !== "other")
    .slice(0, reserve);
  const picked = [...ranked.slice(0, max - reserve), ...tail];

  const counts: Record<Cohort, number> = { sm: 0, whale: 0, pf: 0, other: 0 };
  const chosen = picked.map((c, id) => {
    counts[c.cohort] += 1;
    return { ...c, id };
  });

  return {
    chosen,
    counts,
    exchangeShare: clamp01(exchangeShare),
    contractShare: clamp01(contractShare),
    excluded,
    ownershipScale,
  };
}

// ------------------------------------------------------------------ cost basis & fog

/**
 * The pnl record for this token (case-insensitive fallback, since EVM casing varies). The request is
 * already filtered by token_address, so a single row is taken as-is even if its address is formatted
 * differently (e.g. non-EVM chains).
 */
export function pickPnlRecord(rows: PnlRow[], chain: string, tokenAddress: string): PnlRow | null {
  const key = normalizeAddress(chain, tokenAddress);
  const exact = rows.find((r) => r.token_address && normalizeAddress(chain, r.token_address) === key);
  if (exact) return exact;
  const lower = tokenAddress.toLowerCase();
  return rows.find((r) => r.token_address?.toLowerCase() === lower) ?? (rows.length === 1 ? rows[0] : null);
}

/** Average cost per token: (holding_usd − pnl_usd_unrealised) / holding_amount. null if unusable. */
export function costFromPnl(rec: PnlRow | null): number | null {
  if (!rec) return null;
  const h = rec.holding_amount;
  const usd = rec.holding_usd;
  const u = rec.pnl_usd_unrealised;
  if (h === null || usd === null || u === null || !(h > 0)) return null;
  const cost = (usd - u) / h;
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

/**
 * A balance that was received, not bought on a DEX: profiler pnl reports bought_usd 0 and
 * cost_basis_usd 0 for the tokens still held (team / vesting allocations, airdrops, exchange
 * withdrawals). Such a holder has no entry price, which is not the same as a zero one.
 * Any recorded buy (bought_usd > 0, however small) disqualifies it. The cost basis is an average and
 * may carry float residue: below a millionth of the price it counts as zero.
 * Only meaningful when the pnl window covered the token's whole history (see DeriveInput.allocationAllowed):
 * a holder whose buys predate the window also shows bought_usd 0.
 */
export function isAllocationRecord(rec: PnlRow | null, priceNow: number): boolean {
  if (!rec) return false;
  const held = rec.holding_amount;
  const basis = rec.cost_basis_usd;
  const bought = rec.bought_usd;
  if (held === null || !(held > 0) || basis === null || bought === null) return false;
  const zeroBasis = priceNow > 0 ? basis <= priceNow * 1e-6 : basis <= 0;
  return zeroBasis && bought <= 0;
}

/**
 * Costs more than 1000x away from the current price are treated as data errors. Deliberately wide:
 * we only hold 30 days of candles but up to 364 days of pnl, so a tight [30d low, 30d high] band
 * would fog genuine early buyers and bag holders. The scene clamps heights to −90% .. 20x anyway.
 */
export function costInRange(cost: number, priceNow: number): boolean {
  return priceNow > 0 && cost >= priceNow / 1000 && cost <= priceNow * 1000;
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function conviction(holdingAmount: number | null, maxBalanceHeld: number | null): number {
  if (maxBalanceHeld === null || !(maxBalanceHeld > 0) || holdingAmount === null) return 1;
  return clamp01(holdingAmount / maxBalanceHeld);
}

export function parseCount(v: string | null | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface DeriveInput {
  id: number;
  cohort: Cohort;
  chain: string;
  tokenAddress: string;
  address: string;
  label: string | null;
  /** Balance from tgm/holders (fallback when pnl has no holding_amount). */
  tokenAmount: number;
  ownershipPct: number | null;
  ownershipScale: number;
  supply: number | null;
  priceNow: number;
  /** Rows from profiler/address/pnl; null when the call failed. */
  pnlRows: PnlRow[] | null;
  includeTags?: boolean;
  /**
   * May a zero-cost record (isAllocationRecord) be read as an allocation? Pass false when the pnl
   * window did not cover the token's whole history or the wallet is a known DEX buyer: the record is
   * then "no_cost". Default true (the legacy scene's behaviour).
   */
  allocationAllowed?: boolean;
}

export function deriveHolder(i: DeriveInput): HolderPoint {
  const rec = i.pnlRows ? pickPnlRecord(i.pnlRows, i.chain, i.tokenAddress) : null;
  const holding = rec?.holding_amount ?? null;
  const amount = holding !== null && holding > 0 ? holding : i.tokenAmount;

  let fog: FogReason | null = null;
  let cost: number | null = null;
  if (!i.pnlRows) {
    fog = "pnl_error";
  } else if (isAllocationRecord(rec, i.priceNow)) {
    fog = i.allocationAllowed === false ? "no_cost" : "allocation";
  } else {
    const c = costFromPnl(rec);
    if (c === null) fog = "no_cost";
    else if (!costInRange(c, i.priceNow)) fog = "out_of_range";
    else cost = c;
  }

  const maxBal = rec?.max_balance_held ?? null;
  const point: HolderPoint = {
    id: i.id,
    cohort: i.cohort,
    amount,
    supplyShare: shareOf(amount, i.ownershipPct, i.supply, i.ownershipScale),
    cost,
    multiple: cost !== null ? i.priceNow / cost : null,
    conviction: conviction(holding ?? amount, maxBal),
    maxHeld: maxBal !== null && maxBal > amount ? maxBal : amount,
    buys: parseCount(rec?.nof_buys),
    sells: parseCount(rec?.nof_sells),
    fog,
  };
  if (i.includeTags) point.tag = i.label && !looksLikeAddress(i.label) ? i.label : shortAddress(i.address);
  return point;
}

// ------------------------------------------------------------------ coverage, flows, prices, dates

export function computeCoverage(holders: HolderPoint[], exchangeShare: number, contractShare: number): Coverage {
  let total = 0;
  let fog = 0;
  let share = 0;
  let allocated = 0;
  for (const h of holders) {
    total += h.amount;
    share += h.supplyShare;
    if (h.fog) fog += h.amount;
    if (h.fog === "allocation") allocated += h.supplyShare;
  }
  return {
    holdersAnalyzed: holders.length,
    analyzedSupplyShare: clamp01(share),
    fogShare: total > 0 ? fog / total : 0,
    exchangeShare: clamp01(exchangeShare),
    contractShare: clamp01(contractShare),
    ...(allocated > 0 ? { allocatedShare: clamp01(allocated) } : {}),
  };
}

export function mapFlows(row: FlowIntelligenceRow | undefined | null): CohortFlow[] {
  if (!row) return [];
  const pairs: [CohortFlow["cohort"], number | null, number | null][] = [
    ["sm", row.smart_trader_net_flow_usd, row.smart_trader_wallet_count],
    ["whale", row.whale_net_flow_usd, row.whale_wallet_count],
    ["pf", row.public_figure_net_flow_usd, row.public_figure_wallet_count],
    ["fresh", row.fresh_wallets_net_flow_usd, row.fresh_wallets_wallet_count],
    ["exchange", row.exchange_net_flow_usd, row.exchange_wallet_count],
  ];
  return pairs
    .filter(([, net]) => typeof net === "number")
    .map(([cohort, net, count]) => ({ cohort, netFlowUsd: net as number, walletCount: count ?? 0 }));
}

/** Candles → points, oldest first; missing open carries the previous close forward. */
export function ohlcvToPoints(candles: OhlcvCandle[]): OhlcvPoint[] {
  const parsed = candles
    .map((c) => ({ t: c.interval_start ? Date.parse(c.interval_start) : NaN, c }))
    .filter((x) => Number.isFinite(x.t) && x.c.close !== null && x.c.close > 0)
    .sort((a, b) => a.t - b.t);
  const out: OhlcvPoint[] = [];
  let prev: number | null = null;
  for (const { t, c } of parsed) {
    if (out.length && out[out.length - 1].t === t) continue;
    const close = c.close as number;
    const open = c.open ?? prev ?? close;
    out.push({
      t,
      o: open,
      h: c.high ?? Math.max(open, close),
      l: c.low ?? Math.min(open, close),
      c: close,
    });
    prev = close;
  }
  return out;
}

/** Price fallback when OHLCV is unavailable: market cap / circulating, then FDV / total supply. */
export function fallbackPrice(d: {
  market_cap_usd: number | null;
  circulating_supply: number | null;
  fdv_usd: number | null;
  total_supply: number | null;
}): number | null {
  if (d.market_cap_usd && d.circulating_supply) return d.market_cap_usd / d.circulating_supply;
  if (d.fdv_usd && d.total_supply) return d.fdv_usd / d.total_supply;
  return null;
}

export function supplyBasis(
  circulating: number | null,
  total: number | null,
  marketCapUsd: number | null,
  priceNow: number,
): number | null {
  if (circulating && circulating > 0) return circulating;
  if (total && total > 0) return total;
  if (marketCapUsd && marketCapUsd > 0 && priceNow > 0) return marketCapUsd / priceNow;
  return null;
}

export interface DateWindow {
  label: "full" | "90d" | "30d";
  /** ISO datetime (start of day, UTC). */
  from: string;
  /** ISO datetime (now, minute precision). */
  to: string;
}

function isoMinute(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoDayStart(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
}

/**
 * Profiler pnl windows, widest first: from = max(deployment, now − 364 days); then 90d and 30d
 * fallbacks (used after `invalid_date_range`), only when narrower than the first window.
 */
export function pnlWindows(deployedAt: string | null, now: Date): DateWindow[] {
  const nowMs = now.getTime();
  const to = isoMinute(nowMs);
  const yearAgo = nowMs - 364 * DAY_MS;
  const deployMs = deployedAt ? Date.parse(deployedAt) : NaN;
  const fullFrom = Number.isFinite(deployMs) ? Math.max(deployMs, yearAgo) : yearAgo;
  const windows: DateWindow[] = [{ label: "full", from: isoDayStart(fullFrom), to }];
  for (const [label, days] of [["90d", 90], ["30d", 30]] as const) {
    const from = nowMs - days * DAY_MS;
    if (from > fullFrom + DAY_MS) windows.push({ label, from: isoDayStart(from), to });
  }
  return windows;
}

/**
 * True when the window reaches back to the token's deployment, i.e. an empty pnl response means the
 * address never traded or received the token in a way Nansen tracks (a contract / PDA / mint target).
 */
export function windowCoversHistory(w: DateWindow, deployedAt: string | null): boolean {
  const deployMs = deployedAt ? Date.parse(deployedAt) : NaN;
  const fromMs = Date.parse(w.from);
  return Number.isFinite(deployMs) && Number.isFinite(fromMs) && fromMs <= deployMs;
}

/** Last `days` of hourly candles. */
export function ohlcvRange(now: Date, days = 30): { from: string; to: string } {
  const nowMs = now.getTime();
  return { from: isoMinute(nowMs - days * DAY_MS), to: isoMinute(nowMs) };
}
