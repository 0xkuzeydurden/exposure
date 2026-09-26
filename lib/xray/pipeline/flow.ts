// Finding 02 · "Who is selling to whom?": informed money (smart money + whales + public figures,
// aggregated, never per wallet) and exchanges over the film's 7 days.
//
// Sources: tgm/flows (hourly cohort balance snapshots; a net flow is the change of the cohort's
// balance) for the pulse line, and tgm/flow-intelligence 7d for the USD headline and fresh wallets.
// The headline uses flow-intelligence when it answered (Nansen's own net-flow metric, not affected
// by wallets entering / leaving a cohort); the balance-derived USD is the fallback.
//
// Redistribution rule: the hourly pulse, the daily bars and the "moved first" note are published only
// when they are a real mix. With smart money as the only cohort that has data, they would be a raw
// hourly smart-money balance line, so then only the 7-day total is kept and the finding is partial.
// The last, still-filling bucket (is_complete = false) is dropped: no live smart-money feed.
import type { FlowIntelligenceRow, TgmFlowRow } from "../../nansen/schemas";
import type { FlowDay, FlowFinding, FlowPoint, PricePoint } from "../types";
import type { PipelineRules } from "./rules";
import { dayKey, finite, HOUR_MS, parseTime, positive } from "./util";

export const INFORMED_LABELS = ["smart_money", "whale", "public_figure"] as const;
export type InformedLabel = (typeof INFORMED_LABELS)[number];
export const FLOW_LABELS = [...INFORMED_LABELS, "exchange"] as const;
export type ScanFlowLabel = (typeof FLOW_LABELS)[number];
/** Page size for tgm/flows: 7 days of hourly buckets is 168 (+1 live bucket); the API max is 1000. */
export const FLOWS_PAGE = 200;

export interface BalancePoint {
  t: number;
  amount: number;
  price: number | null;
}

/** Cohort balance snapshots, oldest first; buckets without a balance, and incomplete (live) buckets, are skipped. */
export function balanceSeries(rows: TgmFlowRow[]): BalancePoint[] {
  const out: BalancePoint[] = [];
  const parsed = rows
    .filter((r) => r.is_complete !== false)
    .map((r) => ({ t: parseTime(r.date), r }))
    .filter((x) => Number.isFinite(x.t) && finite(x.r.token_amount))
    .sort((a, b) => a.t - b.t);
  for (const { t, r } of parsed) {
    if (out.length && out[out.length - 1].t === t) continue;
    out.push({ t, amount: r.token_amount as number, price: positive(r.price_usd) ? r.price_usd : null });
  }
  return out;
}

/** Hourly close at or before t (else the first close); null without a film. */
export function priceAt(price: PricePoint[], t: number): number | null {
  if (!price.length) return null;
  let lo = 0;
  let hi = price.length - 1;
  if (t < price[0].t) return price[0].c;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (price[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return price[lo].c;
}

/**
 * Sums several cohort balance series on the union of their timestamps (carrying each series'
 * last value forward, and its first value backward) and turns it into net-flow points.
 * cumPctSupply is the change since the first bucket as a share of `supply` (0 when unknown).
 */
export function aggregateCohorts(series: BalancePoint[][], supply: number | null, price: PricePoint[]): { points: FlowPoint[]; netTokens: number } {
  const usable = series.filter((s) => s.length > 0);
  if (!usable.length) return { points: [], netTokens: 0 };
  const times = [...new Set(usable.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const idx = usable.map(() => 0);
  const totals: { t: number; amount: number; price: number | null }[] = [];
  for (const t of times) {
    let amount = 0;
    let px: number | null = null;
    usable.forEach((s, k) => {
      while (idx[k] + 1 < s.length && s[idx[k] + 1].t <= t) idx[k]++;
      const p = s[idx[k]];
      amount += p.amount;
      if (px === null && p.t === t && p.price !== null) px = p.price;
    });
    totals.push({ t, amount, price: priceAt(price, t) ?? px });
  }
  const base = totals[0].amount;
  const points: FlowPoint[] = totals.map((x, i) => {
    const delta = i === 0 ? 0 : x.amount - totals[i - 1].amount;
    return {
      t: x.t,
      cumPctSupply: positive(supply) ? (x.amount - base) / supply : 0,
      netUsd: x.price !== null ? delta * x.price : 0,
    };
  });
  return { points, netTokens: totals[totals.length - 1].amount - base };
}

export function dailyFlows(informed: FlowPoint[], exchange: FlowPoint[]): FlowDay[] {
  const days = new Map<string, FlowDay>();
  const get = (t: number) => {
    const k = dayKey(t);
    let d = days.get(k);
    if (!d) {
      d = { day: k, informedUsd: 0, freshUsd: null, exchangeUsd: 0 };
      days.set(k, d);
    }
    return d;
  };
  for (const p of informed) get(p.t).informedUsd += p.netUsd;
  for (const p of exchange) get(p.t).exchangeUsd += p.netUsd;
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * smart trader + whale + public figure net flow (USD) from flow-intelligence; null unless at least two
 * of the three segments are reported (one segment alone would be a single cohort, e.g. smart money).
 */
export function informedFromIntel(row: FlowIntelligenceRow | null | undefined): number | null {
  if (!row) return null;
  const parts = [row.smart_trader_net_flow_usd, row.whale_net_flow_usd, row.public_figure_net_flow_usd].filter(finite);
  return parts.length >= 2 ? parts.reduce((s, x) => s + x, 0) : null;
}

/**
 * The informed-money series may be published when it mixes at least two cohorts, or when its only
 * cohort is not smart money (a whale-only line is not smart-money data).
 */
export function informedSeriesPublishable(withData: readonly InformedLabel[]): boolean {
  return withData.length >= 2 || (withData.length === 1 && withData[0] !== "smart_money");
}

export interface VerdictInput {
  informedNetUsd: number;
  informedNetPctSupply: number | null;
  marketCapUsd: number | null;
  freshNetUsd: number | null;
  /** Tokens that went to wallets outside the tracked cohorts (−informed − exchange), null if unknown. */
  crowdNetTokens: number | null;
}

export function flowVerdict(v: VerdictInput, rules: PipelineRules["flow"]): FlowFinding["verdict"] {
  const move = positive(v.marketCapUsd) ? v.informedNetUsd / v.marketCapUsd : v.informedNetPctSupply;
  if (move === null || !Number.isFinite(move)) return "quiet";
  if (move <= -rules.moveShare) {
    // Distribution needs a buyer on the other side: fresh wallets, else the unlabelled crowd
    // (tokens that left informed wallets and exchanges). Unknown counts as no buyer.
    const counterparty = v.freshNetUsd ?? v.crowdNetTokens;
    return counterparty !== null && counterparty > 0 ? "distributing" : "quiet";
  }
  if (move >= rules.moveShare) return "accumulating";
  return "quiet";
}

function hoursText(ms: number): string {
  const h = Math.round(ms / HOUR_MS);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h}h`;
}

/**
 * Descriptive "who moved first this week" note (never a prediction, never changes the diagnosis):
 * informed money peaked at least 6h before a local price top it then sold into, or bottomed at
 * least 6h before a local price bottom it then bought into.
 */
export function leadObservation(informed: FlowPoint[], price: PricePoint[], minMovePct = 0.001): FlowFinding["lead"] | undefined {
  if (informed.length < 24 || price.length < 24) return undefined;
  const end = price[price.length - 1].t;
  const argBy = <T>(xs: T[], better: (a: T, b: T) => boolean) => xs.reduce((best, x) => (better(x, best) ? x : best), xs[0]);
  const last = informed[informed.length - 1].cumPctSupply;
  const minGap = 6 * HOUR_MS;

  const pTop = argBy(price, (a, b) => a.c > b.c);
  const iTop = argBy(informed, (a, b) => a.cumPctSupply > b.cumPctSupply);
  if (pTop.t < end - minGap && iTop.t <= pTop.t - minGap && iTop.cumPctSupply - last >= minMovePct) {
    return { t: iTop.t, text: `Informed money started selling ${hoursText(pTop.t - iTop.t)} before the price peaked.` };
  }
  const pLow = argBy(price, (a, b) => a.c < b.c);
  const iLow = argBy(informed, (a, b) => a.cumPctSupply < b.cumPctSupply);
  if (pLow.t < end - minGap && iLow.t <= pLow.t - minGap && last - iLow.cumPctSupply >= minMovePct) {
    return { t: iLow.t, text: `Informed money started buying ${hoursText(pLow.t - iLow.t)} before the price bottomed.` };
  }
  return undefined;
}

export interface FlowInput {
  /** Rows per label; null = the call failed. */
  rows: Partial<Record<ScanFlowLabel, TgmFlowRow[] | null>>;
  intel: FlowIntelligenceRow | null;
  intelOk: boolean;
  supply: number | null;
  marketCapUsd: number | null;
  price: PricePoint[];
}

export function buildFlowFinding(input: FlowInput, rules: PipelineRules["flow"]): FlowFinding {
  const informedSeries = INFORMED_LABELS.map((l) => (input.rows[l] ? balanceSeries(input.rows[l]!) : []));
  const exchangeRows = input.rows.exchange;
  const exchangeSeries = exchangeRows ? balanceSeries(exchangeRows) : [];
  const withData = INFORMED_LABELS.filter((_, i) => informedSeries[i].length > 0);
  const publishable = informedSeriesPublishable(withData);
  const informed = publishable ? aggregateCohorts(informedSeries, input.supply, input.price) : { points: [] as FlowPoint[], netTokens: 0 };
  const exchange = aggregateCohorts([exchangeSeries], input.supply, input.price);

  const informedLabelsOk = withData.length;
  const intelInformed = informedFromIntel(input.intel);
  const balanceUsd = informed.points.reduce((s, p) => s + p.netUsd, 0);
  const haveFlows = informed.points.length > 1;
  const informedNetUsd = intelInformed ?? (haveFlows ? balanceUsd : 0);
  const informedNetPctSupply = haveFlows && positive(input.supply) ? informed.points[informed.points.length - 1].cumPctSupply : null;
  const exchangeNetPctSupply =
    exchange.points.length > 1 && positive(input.supply) ? exchange.points[exchange.points.length - 1].cumPctSupply : null;
  const freshNetUsd = input.intel && finite(input.intel.fresh_wallets_net_flow_usd) ? input.intel.fresh_wallets_net_flow_usd : null;
  const crowdNetTokens = haveFlows && exchange.points.length > 1 ? -(informed.netTokens + exchange.netTokens) : null;

  const status: FlowFinding["status"] =
    !haveFlows && intelInformed === null
      ? "unavailable"
      : informedLabelsOk === INFORMED_LABELS.length && exchange.points.length > 1 && input.intelOk && positive(input.supply)
        ? "ok"
        : "partial";

  const series: FlowFinding["series"] = [];
  if (informed.points.length) series.push({ cohort: "informed", points: informed.points });
  if (exchange.points.length && status !== "unavailable") series.push({ cohort: "exchange", points: exchange.points });

  const finding: FlowFinding = {
    status,
    informedNetUsd,
    informedNetPctSupply,
    freshNetUsd,
    exchangeNetPctSupply,
    series,
    // Without a publishable informed series the daily table would show a misleading $0 informed column.
    daily: informed.points.length ? dailyFlows(informed.points, exchange.points) : [],
    verdict:
      status === "unavailable"
        ? "quiet"
        : flowVerdict({ informedNetUsd, informedNetPctSupply, marketCapUsd: input.marketCapUsd, freshNetUsd, crowdNetTokens }, rules),
  };
  const lead = leadObservation(informed.points, input.price);
  if (lead) finding.lead = lead;
  return finding;
}

export function emptyFlowFinding(): FlowFinding {
  return {
    status: "unavailable",
    informedNetUsd: 0,
    informedNetPctSupply: null,
    freshNetUsd: null,
    exchangeNetPctSupply: null,
    series: [],
    daily: [],
    verdict: "quiet",
  };
}
