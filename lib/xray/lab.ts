// LAB RESULTS: the flag, the big number, the one short line and the chart-ready values of every tab
// of the lab-results drawer (Summary monitor, 01 funnel + treemap, 02 tug of war + daily bars, 03 price
// ladder, 04 gauge, 05 entry distribution, Evidence waffle), plus the older result blocks and key
// numbers the tests pin down. Pure, English only, numbers through lib/format; nothing here is
// hardcoded to the synthetic patient. Flags read each finding's own classification (demand, verdict,
// ceiling, state), which the pipeline computed from lib/xray/thresholds.ts, so a flag never disagrees
// with the report or the lights. Empty values read "n/a".
import { formatAmount, formatMs, formatMultiple, formatPct, formatSignedPct, formatUsdCompact } from "../format";
import { buyerFunding, fundingSentence, patientName, priceShort, sourceName, untracedReason, type FindingNo } from "./copy";
import {
  hasSmartData,
  informedMove,
  isAvailable,
  isHeavyWall,
  isTraced,
  primaryWall,
  tooFewSmartWallets,
  top10Share,
  tracedBuyers,
  wallAnalysedShare,
} from "./diagnosis";
import { T } from "./thresholds";
import type {
  BuyerRow,
  BuyersFinding,
  CallRecord,
  Diagnosis,
  FlowFinding,
  LadderBin,
  Scan,
  ScanMeta,
  SmartFinding,
  SourceCluster,
  WalletCheck,
  Wall,
  WallsFinding,
} from "./types";

/* ---------------------------------------------------------------------------------- flags */

export type FlagLevel = "high" | "borderline" | "normal" | "low" | "none" | "pending";
/** red = a warning for someone buying today, amber = borderline, green = within range, grey = no reading. */
export type FlagTone = "red" | "amber" | "green" | "grey";

export interface LabFlag {
  level: FlagLevel;
  tone: FlagTone;
  /** "HIGH", "BORDERLINE", "NORMAL", "LOW", "NO DATA", "PENDING", ... */
  text: string;
}

const FLAG_TEXT: Record<FlagLevel, string> = {
  high: "HIGH",
  borderline: "BORDERLINE",
  normal: "NORMAL",
  low: "LOW",
  none: "NO DATA",
  pending: "PENDING",
};

export function labFlag(level: FlagLevel, tone: FlagTone, text = FLAG_TEXT[level]): LabFlag {
  return { level, tone, text };
}

export const PENDING_FLAG: LabFlag = labFlag("pending", "grey");
export const NO_DATA_FLAG: LabFlag = labFlag("none", "grey");

/** Funding concentration: CONCENTRATED is high, MIXED borderline, ORGANIC normal. */
export function demandFlag(b: BuyersFinding | null | undefined): LabFlag {
  if (!b) return PENDING_FLAG;
  if (!isAvailable(b)) return NO_DATA_FLAG;
  if (b.demand === "concentrated") return labFlag("high", "red");
  if (b.demand === "organic") return labFlag("normal", "green");
  return labFlag("borderline", "amber");
}

/** Informed-money selling: DISTRIBUTING is high, QUIET normal, ACCUMULATING low (they are buying). */
export function flowFlag(f: FlowFinding | null | undefined): LabFlag {
  if (!f) return PENDING_FLAG;
  if (!isAvailable(f)) return NO_DATA_FLAG;
  if (f.verdict === "distributing") return labFlag("high", "red");
  if (f.verdict === "accumulating") return labFlag("low", "green");
  return labFlag("normal", "green");
}

/** Supply waiting above the price: HEAVY is high, LIGHT normal. */
export function ceilingFlag(w: WallsFinding | null | undefined): LabFlag {
  if (!w) return PENDING_FLAG;
  if (!isAvailable(w)) return NO_DATA_FLAG;
  return w.ceiling === "heavy" ? labFlag("high", "red") : labFlag("normal", "green");
}

/**
 * Price vs smart money's average entry: PROFIT is high, BREAKEVEN normal, LOSS low. The colour follows
 * what they do about it: trimming / exiting is red, holding amber, adding green.
 */
export function smartFlag(s: SmartFinding | null | undefined): LabFlag {
  if (!s) return PENDING_FLAG;
  if (!isAvailable(s)) return NO_DATA_FLAG;
  if (tooFewSmartWallets(s)) return labFlag("none", "grey", "TOO FEW");
  if (!hasSmartData(s)) return labFlag("none", "grey", "NONE");
  const tone: FlagTone = s.stance === "trimming" || s.stance === "exiting" ? "red" : s.stance === "adding" ? "green" : "amber";
  if (s.state === "profit") return labFlag("high", tone);
  if (s.state === "loss") return labFlag("low", tone);
  if (s.state === "breakeven") return labFlag("normal", tone === "red" ? "amber" : "green");
  return NO_DATA_FLAG;
}

/** The pasted wallet's entry vs smart money's: above 1.1x is high (red), below 0.9x low (green). */
export function youFlag(you: WalletCheck | null | undefined): LabFlag {
  if (!you) return labFlag("none", "grey", "NOT CHECKED");
  if (!isAvailable(you)) return NO_DATA_FLAG;
  const vs = you.vsSmartMoneyPct;
  if (!finite(vs)) return labFlag("none", "grey", "NO REFERENCE");
  const m = 1 + vs;
  if (m >= T.smart.profitMultiple) return labFlag("high", "red");
  if (m < T.smart.lossMultiple) return labFlag("low", "green");
  return labFlag("normal", "green");
}

/** Tab 04's flag in words: "TAKING PROFIT", "IN PROFIT", "UNDERWATER", ... (same level and tone as smartFlag). */
export function smartTabFlag(s: SmartFinding | null | undefined): LabFlag {
  const f = smartFlag(s);
  if (!s || f.tone === "grey") return f;
  const selling = s.stance === "trimming" || s.stance === "exiting";
  let text: string;
  if (s.state === "profit") text = selling ? "TAKING PROFIT" : s.stance === "adding" ? "ADDING IN PROFIT" : "IN PROFIT";
  else if (s.state === "loss") text = selling ? "SELLING AT A LOSS" : s.stance === "adding" ? "BUYING THE DIP" : "UNDERWATER";
  else text = "AT BREAK-EVEN";
  return { ...f, text };
}

/** Tab 05's flag in words: "LATE" (paid 1.1x+ smart money's entry), "EARLY" (below 0.9x), "ON PAR". */
export function youTabFlag(you: WalletCheck | null | undefined): LabFlag {
  const f = youFlag(you);
  if (f.level === "high") return { ...f, text: "LATE" };
  if (f.level === "low") return { ...f, text: "EARLY" };
  if (f.level === "normal") return { ...f, text: "ON PAR" };
  return f;
}

/** Evidence: "ALL CALLS OK", "3 FAILED" (amber: failed calls count as missing data), PENDING. */
export function evidenceFlag(calls: readonly CallRecord[]): LabFlag {
  if (!calls.length) return PENDING_FLAG;
  const failed = calls.filter((c) => c.status >= 400).length;
  return failed ? labFlag("borderline", "amber", `${failed} FAILED`) : labFlag("normal", "green", "ALL CALLS OK");
}

export type LabTabId = "summary" | FindingNo | "evidence";

export interface TabFlagInput {
  buyers: BuyersFinding | null | undefined;
  flow: FlowFinding | null | undefined;
  walls: WallsFinding | null | undefined;
  smart: SmartFinding | null | undefined;
}

/** The flag in the corner of each tab (and its dot on the tab strip). */
export function tabFlag(
  tab: LabTabId,
  findings: TabFlagInput,
  meta: Pick<ScanMeta, "priceNow" | "liquidityUsd" | "circulatingSupply" | "marketCapUsd"> | null | undefined,
  you: WalletCheck | null | undefined,
  calls: readonly CallRecord[],
): LabFlag {
  switch (tab) {
    case 1:
      return demandFlag(findings.buyers);
    case 2:
      return flowFlag(findings.flow);
    case 3:
      return ceilingFlag(findings.walls);
    case 4:
      return smartTabFlag(findings.smart);
    case 5:
      return youTabFlag(you);
    case "evidence":
      return evidenceFlag(calls);
    default:
      return abnormalFlag(monitorChannels(findings, meta, you));
  }
}

/* ---------------------------------------------------------------------------------- helpers */

/** What an empty value reads everywhere in the drawer. */
export const NA = "n/a";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number) => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct0 = (x: number) => formatPct(x, 0);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + (finite(x) ? x : 0), 0);

/**
 * Text from other modules (lib/format, lib/xray/copy, pipeline notes) prints a long dash for a missing
 * value; the drawer prints "n/a" instead, and ": " where the dash separates two phrases.
 */
export function noDash(s: string): string {
  return s.replace(/\s\u2014\s/g, ": ").replace(/\u2014+/g, NA);
}

function count(n: number): string {
  return finite(n) ? Math.round(n).toLocaleString("en-US") : NA;
}

/** "+$1.6M", "−$2.0M", "$0"; "n/a" when unknown. */
export function signedUsd(v: number | null | undefined): string {
  if (!finite(v)) return NA;
  return v > 0 ? `+${formatUsdCompact(v)}` : formatUsdCompact(v);
}

/** Short price, "n/a" when unknown. */
export function price(p: number | null | undefined): string {
  return finite(p) && p > 0 ? priceShort(p) : NA;
}

/** "$KAIRO", "n/a" before the patient is known. */
export function symbolText(meta: Pick<ScanMeta, "symbol" | "name"> | null | undefined): string {
  return meta ? patientName(meta) : NA;
}

/** "0.36" */
function ratioText(x: number): string {
  return x.toFixed(2);
}

/** Independent sources per traced buyer, or null when funders were not traced. */
export function sourcesPerBuyer(b: BuyersFinding): number | null {
  if (!isTraced(b)) return null;
  const traced = tracedBuyers(b);
  return traced > 0 ? b.sources / traced : null;
}

/** The biggest non-exchange source (the one behind biggestSourceShare), or null. */
export function biggestSource(b: BuyersFinding | null | undefined): SourceCluster | null {
  if (!b) return null;
  const own = b.clusters.filter((c) => c.kind === "wallet" || c.kind === "self");
  return own.reduce<SourceCluster | null>((best, c) => (!best || c.share > best.share ? c : best), null);
}

/** "1,000+" when who-bought-sold was capped (the count is a floor), else "412". */
export function buyersTotalText(b: Pick<BuyersFinding, "totalBuyers" | "totalBuyersCapped">): string {
  return `${count(b.totalBuyers)}${b.totalBuyersCapped ? "+" : ""}`;
}

/** The method of finding 03: cost basis, recent buyers, or both (hybrid). */
export function wallsMethod(w: Pick<WallsFinding, "method" | "costBasisHolders" | "recentBuyers">): { value: string; sub: string } {
  if (w.method === "hybrid") {
    return {
      value: "Hybrid",
      sub: `${count(w.costBasisHolders ?? 0)} holders' P&L + ${count(w.recentBuyers ?? 0)} recent buyers`,
    };
  }
  return w.method === "cost_basis" ? { value: "Cost basis", sub: "holders' profiler P&L" } : { value: "Recent buyers", sub: "30-day buyers, estimate" };
}

/** Who the analysed supply belongs to: "40 holders", or "14 holders + 38 buyers" (hybrid). */
export function wallsAnalysedWho(w: Pick<WallsFinding, "method" | "holdersAnalyzed" | "costBasisHolders" | "recentBuyers">): string {
  if (w.method === "hybrid") {
    const h = w.costBasisHolders ?? 0;
    const r = w.recentBuyers ?? 0;
    return `${count(h)} ${plural(h, "holder", "holders")} + ${count(r)} ${plural(r, "buyer", "buyers")}`;
  }
  if (w.method === "recent_buyers") return `${count(w.holdersAnalyzed)} recent ${plural(w.holdersAnalyzed, "buyer", "buyers")}`;
  return `${count(w.holdersAnalyzed)} ${plural(w.holdersAnalyzed, "holder", "holders")}`;
}

/** The wall closest above today's price, or null. */
export function nearestWall(w: WallsFinding | null | undefined): Wall | null {
  if (!w) return null;
  const above = w.walls.filter((x) => finite(x.movePct) && x.movePct > 0 && x.tokens > 0);
  return above.reduce<Wall | null>((best, x) => (!best || x.movePct < best.movePct ? x : best), null);
}

/* ---------------------------------------------------------------------------------- results */

/** The older RESULT block of a finding (kept for the report wording and the tests). */
export interface LabResult {
  /** The big number: "23", "−$2.0M", "2.3x". */
  value: string;
  /** What the number counts: "real funding sources behind the top 80 buyers". */
  caption: string;
  /** One plain-English line. */
  verdict: string;
  flag: LabFlag;
  /** The normal range, e.g. "at least 0.60 sources per traced buyer, biggest source < 20%". */
  reference: string | null;
  /** This scan against that range, e.g. "23 / 64 = 0.36, biggest source 31%". */
  measured: string | null;
}

const PENDING_RESULT = (what: string): LabResult => ({
  value: NA,
  caption: `${what} is still being read`,
  verdict: "It appears here as soon as the scan reaches it.",
  flag: PENDING_FLAG,
  reference: null,
  measured: null,
});

export const BUYERS_REFERENCE = `≥ ${ratioText(T.demand.organicRatio)} sources per traced buyer · biggest source < ${pct0(T.demand.organicMaxSourceShare)}`;
export const BUYERS_REFERENCE_UNTRACED = `Top 10 buyers < ${pct0(T.demand.top10Organic)} of the buying (≥ ${pct0(T.demand.top10Concentrated)} is concentrated)`;
export const WALLS_REFERENCE = `No wall within +${pct0(T.ceiling.nearMovePct)} worth ≥ ${formatMultiple(T.ceiling.wallToLiquidity)} the pool or ≥ ${pct0(T.ceiling.wallShareOfAnalysed)} of analysed supply · < ${pct0(T.ceiling.underwaterShare)} underwater`;
export const SMART_REFERENCE = `Price ${T.smart.lossMultiple.toFixed(1)}×–${T.smart.profitMultiple.toFixed(1)}× smart money's average entry`;
export const YOU_REFERENCE = `Entry ${T.smart.lossMultiple.toFixed(1)}×–${T.smart.profitMultiple.toFixed(1)}× smart money's average entry`;

function flowBase(meta: Pick<ScanMeta, "marketCapUsd"> | null | undefined): "market cap" | "supply" {
  return finite(meta?.marketCapUsd) && (meta?.marketCapUsd ?? 0) > 0 ? "market cap" : "supply";
}

export function flowReference(meta: Pick<ScanMeta, "marketCapUsd"> | null | undefined): string {
  return `Informed net flow within ±${formatPct(T.flow.moveShare, 1)} of ${flowBase(meta)}`;
}

export function buyersResult(b: BuyersFinding | null | undefined): LabResult {
  if (!b) return PENDING_RESULT("Buyer data");
  const flag = demandFlag(b);
  if (!isAvailable(b)) {
    return { value: NA, caption: "no buyer data for this scan", verdict: noDash(b.note ?? "Buyer data was not available."), flag, reference: null, measured: null };
  }
  const n = b.topBuyers;
  if (!isTraced(b)) {
    const share = top10Share(b) ?? clamp01(b.topShare);
    const how =
      b.demand === "concentrated"
        ? "a handful of wallets did most of the buying."
        : b.demand === "organic"
          ? "the buying is spread across many wallets."
          : "the buying leans on its largest wallets.";
    return {
      value: pct0(share),
      caption: `of this week's buying came from the top ${count(n)} ${plural(n, "buyer", "buyers")}`,
      verdict: `${b.demand[0].toUpperCase()}${b.demand.slice(1)}: ${how}`,
      flag,
      reference: BUYERS_REFERENCE_UNTRACED,
      measured: `Top ${count(n)}: ${pct0(share)}`,
    };
  }
  const traced = tracedBuyers(b);
  const ratio = sourcesPerBuyer(b);
  const biggest = clamp01(b.biggestSourceShare);
  let verdict: string;
  if (b.sources <= 0) verdict = `None of the top ${count(n)} buyers could be traced to a funder.`;
  else if (b.demand === "concentrated") {
    verdict =
      biggest >= T.demand.concentratedSourceShare
        ? `Concentrated: one source funded ${pct0(biggest)} of the analysed buying.`
        : `Concentrated: only ${count(b.sources)} ${plural(b.sources, "source", "sources")} behind ${count(traced)} traced buyers.`;
  } else if (b.demand === "organic") {
    verdict = `Organic: ${count(b.sources)} independent sources; no funder is behind more than ${pct0(biggest)} of the buying.`;
  } else {
    verdict =
      b.biggestSourceWallets >= 2
        ? `Mixed: ${count(b.biggestSourceWallets)} of the ${count(n)} buyers were funded by one wallet.`
        : `Mixed: ${count(b.sources)} sources behind ${count(traced)} traced buyers.`;
  }
  return {
    value: count(b.sources),
    caption: `real funding ${plural(b.sources, "source", "sources")} behind the top ${count(n)} ${plural(n, "buyer", "buyers")}`,
    verdict,
    flag,
    reference: BUYERS_REFERENCE,
    measured: ratio !== null ? `${count(b.sources)} ÷ ${count(traced)} traced = ${ratioText(ratio)} · biggest source ${pct0(biggest)}` : null,
  };
}

export function flowResult(f: FlowFinding | null | undefined, meta: Pick<ScanMeta, "marketCapUsd"> | null | undefined): LabResult {
  if (!f) return PENDING_RESULT("Flow data");
  const flag = flowFlag(f);
  const reference = flowReference(meta);
  if (!isAvailable(f)) {
    return { value: NA, caption: "no labelled flow this week", verdict: "No labelled flow data for this token this week.", flag, reference, measured: null };
  }
  const usd = finite(f.informedNetUsd) ? f.informedNetUsd : 0;
  const abs = formatUsdCompact(Math.abs(usd));
  const move = informedMove(f, meta?.marketCapUsd);
  const base = flowBase(meta);
  const who = "smart money, whales and public figures";
  const caption = usd < 0 ? `net sold by ${who} in 7 days` : usd > 0 ? `net bought by ${who} in 7 days` : `net flow of ${who} in 7 days`;
  let verdict: string;
  if (f.verdict === "distributing") {
    verdict =
      finite(f.freshNetUsd) && f.freshNetUsd > 0
        ? `Distributing: informed money sold ${abs} while fresh wallets bought ${formatUsdCompact(f.freshNetUsd)}.`
        : `Distributing: informed money sold ${abs} into other buyers.`;
  } else if (f.verdict === "accumulating") {
    verdict = `Accumulating: informed money bought ${abs} net this week.`;
  } else if (move !== null && move <= -T.flow.moveShare) {
    verdict = `Quiet: informed money sold ${abs}, but fresh wallets did not buy the other side.`;
  } else {
    verdict = `Quiet: informed money moved less than ${formatPct(T.flow.moveShare, 1)} of ${base}.`;
  }
  return {
    value: usd === 0 ? "$0" : signedUsd(usd),
    caption,
    verdict,
    flag,
    reference,
    measured: move !== null ? `${formatSignedPct(move)} of ${base}` : null,
  };
}

export function wallsResult(w: WallsFinding | null | undefined, meta: Pick<ScanMeta, "circulatingSupply"> | null | undefined): LabResult {
  if (!w) return PENDING_RESULT("Holder cost data");
  const flag = ceilingFlag(w);
  if (!isAvailable(w)) {
    return { value: NA, caption: "holders' entry prices were not available", verdict: "Holders' entry prices were not available.", flag, reference: WALLS_REFERENCE, measured: null };
  }
  const supply = meta?.circulatingSupply ?? null;
  const main = primaryWall(w, supply);
  const heavyWall = main !== null && isHeavyWall(main, w, supply);
  const underwater = w.underwaterShare >= T.ceiling.underwaterShare;
  const at = main ? `${priceShort(main.price)} (${formatSignedPct(main.movePct)})` : "";
  const mainShare = main ? wallAnalysedShare(main, w, supply) : null;

  let value: string;
  let caption: string;
  if (underwater && !heavyWall) {
    value = pct0(w.underwaterShare);
    caption = "of the analysed supply is underwater";
  } else if (main && finite(main.wallToLiquidity)) {
    value = formatMultiple(main.wallToLiquidity);
    caption = `the pool's liquidity waits to break even at ${at}`;
  } else if (main && mainShare !== null) {
    value = pct0(mainShare);
    caption = `of the analysed supply waits to break even at ${at}`;
  } else {
    value = "None";
    caption = "no sell wall above today's price";
  }

  let verdict: string;
  if (w.ceiling === "heavy") {
    verdict =
      heavyWall && main
        ? `Heavy ceiling: sellers are waiting ${formatSignedPct(main.movePct)} above the price, at ${priceShort(main.price)}.`
        : `Heavy ceiling: ${pct0(w.underwaterShare)} of the analysed supply is underwater.`;
  } else if (!main) {
    verdict = "Light ceiling: no sell wall sits above today's price.";
  } else if (main.movePct > T.ceiling.nearMovePct) {
    verdict = `Light ceiling: the main wall is ${formatSignedPct(main.movePct)} away, beyond the +${pct0(T.ceiling.nearMovePct)} that counts.`;
  } else {
    verdict = "Light ceiling: the walls just above the price are small next to the pool.";
  }

  const measured =
    underwater && !heavyWall
      ? `${pct0(w.underwaterShare)} underwater`
      : main && finite(main.wallToLiquidity)
        ? `${formatMultiple(main.wallToLiquidity)} the pool at ${formatSignedPct(main.movePct)}${mainShare !== null ? ` · ${pct0(mainShare)} of analysed supply` : ""}`
        : main && mainShare !== null
          ? `${pct0(mainShare)} of analysed supply at ${formatSignedPct(main.movePct)}`
          : `${pct0(w.underwaterShare)} underwater`;
  return { value, caption, verdict, flag, reference: WALLS_REFERENCE, measured };
}

const STANCE: Record<SmartFinding["stance"], string> = {
  adding: "still adding",
  holding: "holding",
  trimming: "trimming",
  exiting: "heading for the exit",
};

const STATE: Record<SmartFinding["state"], string> = {
  profit: "In profit",
  breakeven: "Near break-even",
  loss: "At a loss",
  unknown: "Entry known",
};

export function smartResult(s: SmartFinding | null | undefined): LabResult {
  if (!s) return PENDING_RESULT("Smart-money data");
  const flag = smartFlag(s);
  if (!isAvailable(s)) {
    return { value: NA, caption: "smart-money data was not available", verdict: "Smart money data was not available.", flag, reference: SMART_REFERENCE, measured: null };
  }
  if (tooFewSmartWallets(s)) {
    return {
      value: count(s.wallets),
      caption: `smart-money ${plural(s.wallets, "wallet", "wallets")} traded it in ${s.windowDays} days`,
      verdict: `Too few to show: an aggregate needs at least ${T.smart.minWallets} wallets, so their numbers stay hidden.`,
      flag,
      reference: SMART_REFERENCE,
      measured: null,
    };
  }
  if (!hasSmartData(s)) {
    return {
      value: "0",
      caption: `smart-money wallets traded it in ${s.windowDays} days`,
      verdict: `No smart money traded this token in the last ${s.windowDays} days.`,
      flag,
      reference: SMART_REFERENCE,
      measured: null,
    };
  }
  const pnl = finite(s.pnlPct) ? s.pnlPct : null;
  return {
    value: pnl !== null ? formatSignedPct(pnl) : NA,
    caption: `price vs smart money's average entry (${price(s.avgEntry)}, ${s.windowDays} days)`,
    verdict: `${STATE[s.state]} and ${STANCE[s.stance]}: bought ${formatUsdCompact(s.boughtUsd)}, sold ${formatUsdCompact(s.soldUsd)} in ${s.windowDays} days.`,
    flag,
    reference: SMART_REFERENCE,
    measured: pnl !== null ? `${(1 + pnl).toFixed(2)}× their entry` : null,
  };
}

export function youResult(you: WalletCheck | null | undefined): LabResult {
  const flag = youFlag(you);
  if (!you) {
    return {
      value: NA,
      caption: "no wallet checked yet",
      verdict: "Paste a wallet below to put its entry next to smart money's.",
      flag,
      reference: YOU_REFERENCE,
      measured: null,
    };
  }
  if (!isAvailable(you) || !finite(you.cost) || you.cost <= 0) {
    return { value: NA, caption: `no DEX entry found for ${you.short}`, verdict: `No position in this token found for ${you.short}.`, flag, reference: YOU_REFERENCE, measured: null };
  }
  const cheaper = finite(you.cheaperShare) ? ` ${pct0(you.cheaperShare)} of the analysed supply was bought cheaper.` : "";
  const vs = you.vsSmartMoneyPct;
  if (finite(vs)) {
    const head =
      Math.abs(vs) < 0.005
        ? "Your entry matches smart money's."
        : vs > 0
          ? `You paid ${pct0(vs)} more than smart money.`
          : `You got in ${pct0(-vs)} cheaper than smart money.`;
    return {
      value: formatSignedPct(vs),
      caption: `your entry (${priceShort(you.cost)}) vs smart money's average entry`,
      verdict: head + cheaper,
      flag,
      reference: YOU_REFERENCE,
      measured: `${(1 + vs).toFixed(2)}× their entry`,
    };
  }
  return {
    value: finite(you.pnlPct) ? formatSignedPct(you.pnlPct) : priceShort(you.cost),
    caption: finite(you.pnlPct) ? `now vs your entry (${priceShort(you.cost)})` : "your average entry",
    verdict: `No smart-money entry to compare with.${cheaper}`,
    flag,
    reference: YOU_REFERENCE,
    measured: null,
  };
}

/* ---------------------------------------------------------------------------------- key numbers */

/** One row of the older Summary lab table (kept for the tests and any text export). */
export interface KeyNumber {
  n: FindingNo;
  /** "Real funding sources" */
  test: string;
  /** "23 sources · 80 buyers" */
  result: string;
  flag: LabFlag;
  /** Short normal range: "at least 0.60 sources per buyer". */
  reference: string;
}

export type KeyNumberInput = TabFlagInput;

function pendingOr(f: unknown, text: () => string): string {
  if (!f) return "Pending";
  return isAvailable(f as { status: "ok" | "partial" | "unavailable" }) ? text() : "No data";
}

export function keyNumbers(
  findings: KeyNumberInput,
  meta: Pick<ScanMeta, "marketCapUsd" | "circulatingSupply"> | null | undefined,
  you: WalletCheck | null | undefined,
): KeyNumber[] {
  const { buyers: b, flow: f, walls: w, smart: s } = findings;
  const supply = meta?.circulatingSupply ?? null;
  const main = w ? primaryWall(w, supply) : null;
  return [
    {
      n: 1,
      test: "Real funding sources",
      result: pendingOr(b, () =>
        isTraced(b!)
          ? `${count(b!.sources)} ${plural(b!.sources, "source", "sources")} · ${count(b!.topBuyers)} buyers`
          : `Top ${count(b!.topBuyers)} did ${pct0(top10Share(b!) ?? b!.topShare)}`,
      ),
      flag: demandFlag(b),
      reference: b && !isTraced(b) ? `Top 10 < ${pct0(T.demand.top10Organic)}` : `≥ ${ratioText(T.demand.organicRatio)} sources per buyer`,
    },
    {
      n: 2,
      test: "Informed-money flow · 7d",
      result: pendingOr(f, () =>
        finite(f!.informedNetPctSupply) ? `${signedUsd(f!.informedNetUsd)} · ${formatSignedPct(f!.informedNetPctSupply)} supply` : signedUsd(f!.informedNetUsd),
      ),
      flag: flowFlag(f),
      reference: `±${formatPct(T.flow.moveShare, 1)} of ${flowBase(meta) === "market cap" ? "mcap" : "supply"}`,
    },
    {
      n: 3,
      test: "Sell wall above price",
      result: pendingOr(w, () => {
        if (w!.underwaterShare >= T.ceiling.underwaterShare && !(main && isHeavyWall(main, w!, supply))) return `${pct0(w!.underwaterShare)} underwater`;
        if (!main) return "No wall above";
        return finite(main.wallToLiquidity)
          ? `${formatMultiple(main.wallToLiquidity)} pool at ${formatSignedPct(main.movePct)}`
          : `${priceShort(main.price)} (${formatSignedPct(main.movePct)})`;
      }),
      flag: ceilingFlag(w),
      reference: `< ${formatMultiple(T.ceiling.wallToLiquidity)} pool within +${pct0(T.ceiling.nearMovePct)}`,
    },
    {
      n: 4,
      test: "Price vs smart-money entry",
      result: pendingOr(s, () => {
        if (tooFewSmartWallets(s)) return `Too few wallets (${count(s!.wallets)})`;
        if (!hasSmartData(s)) return "No smart money";
        return finite(s!.pnlPct) ? `${formatSignedPct(s!.pnlPct)} · ${s!.stance}` : s!.stance;
      }),
      flag: smartFlag(s),
      reference: `${T.smart.lossMultiple.toFixed(1)}×–${T.smart.profitMultiple.toFixed(1)}× entry`,
    },
    {
      n: 5,
      test: "Your entry vs smart money",
      result: !you
        ? "Not checked"
        : !isAvailable(you)
          ? "No position"
          : finite(you.vsSmartMoneyPct)
            ? formatSignedPct(you.vsSmartMoneyPct)
            : you.cost
              ? `Entry ${priceShort(you.cost)}`
              : "No entry",
      flag: youFlag(you),
      reference: `${T.smart.lossMultiple.toFixed(1)}×–${T.smart.profitMultiple.toFixed(1)}× SM entry`,
    },
  ];
}

/* ============================================================================ chart-ready values */

/** Every tab: one big number, its colour, and one short line. */
export interface LabAnswer {
  value: string;
  tone: FlagTone | "blue";
  line: string;
}

/** Colour of a price-vs-entry reading: in profit green, at a loss red, near break-even amber. */
function pnlTone(state: SmartFinding["state"]): FlagTone {
  return state === "profit" ? "green" : state === "loss" ? "red" : state === "breakeven" ? "amber" : "grey";
}

/** A scale maximum that leaves the reference line and the value comfortably inside: 2, 2.5, 3, ... */
export function niceMax(v: number, floor = 2): number {
  if (!finite(v) || v <= 0) return floor;
  return Math.max(floor, Math.ceil(v * 1.25 * 2) / 2);
}

/* ---------------------------------------------------------------- Summary: the bedside monitor */

export type MonitorTrace =
  /** 01: `left` wallet dots (the first `leftHot` highlighted, the last `leftHollow` untraced) -> `right` source dots. */
  | { kind: "dots"; left: number; leftHot: number; leftHollow: number; right: number | null; rightHot: boolean }
  /** 02: an ECG drawn from the informed-money series; base = cumulative (-1..1), spike = that stretch's net (-1..1). */
  | { kind: "ecg"; beats: { base: number; spike: number }[] }
  /** 03 / 04: a bar against a dashed reference (POOL, ENTRY, LIMIT). */
  | { kind: "bar"; value: number; max: number; ref: number; refLabel: string }
  /** 05: SM / NOW / YOU on one log price line, x in 0..1. */
  | { kind: "marks"; marks: { key: "sm" | "now" | "you"; label: string; x: number }[] }
  /** 05 before a wallet is checked. */
  | { kind: "check" }
  | { kind: "blank"; text: string };

export interface MonitorChannel {
  n: FindingNo;
  /** "Real buyers" */
  label: string;
  /** "80 wallets → sources" */
  sub: string;
  /** "23" */
  value: string;
  /** Colour of the value (smart money: the P&L; everywhere else the flag's). */
  valueTone: FlagTone;
  flag: LabFlag;
  trace: MonitorTrace;
}

/** The ECG of channel 02: the informed series bucketed into `buckets` beats (daily bars as a fallback). */
export function ecgBeats(f: FlowFinding | null | undefined, buckets = 24): { base: number; spike: number }[] {
  if (!f || !isAvailable(f)) return [];
  const pts = f.series.find((s) => s.cohort === "informed")?.points ?? [];
  let nets: number[] = [];
  let cums: number[] = [];
  if (pts.length >= 2) {
    const k = Math.max(1, Math.min(buckets, pts.length));
    for (let i = 0; i < k; i++) {
      const a = Math.floor((i * pts.length) / k);
      const z = Math.max(a + 1, Math.floor(((i + 1) * pts.length) / k));
      nets.push(sum(pts.slice(a, z).map((p) => p.netUsd)));
      const last = pts[z - 1].cumPctSupply;
      cums.push(finite(last) ? last : 0);
    }
  } else if (f.daily.length) {
    let run = 0;
    nets = f.daily.map((d) => (finite(d.informedUsd) ? d.informedUsd : 0));
    cums = nets.map((v) => (run += v));
  } else return [];
  const maxNet = Math.max(1e-12, ...nets.map((v) => Math.abs(v)));
  const maxCum = Math.max(1e-12, ...cums.map((v) => Math.abs(v)));
  return nets.map((v, i) => ({ base: cums[i] / maxCum, spike: v / maxNet }));
}

/** x (0..1) of each price on a shared log line, padded so no mark sits on the edge. */
function logPositions(prices: number[]): number[] {
  const ok = prices.filter((p) => finite(p) && p > 0);
  if (!ok.length) return prices.map(() => 0.5);
  const lo = Math.min(...ok) / 1.3;
  const hi = Math.max(...ok) * 1.3;
  const span = Math.log(hi / lo) || 1;
  return prices.map((p) => (finite(p) && p > 0 ? Math.log(p / lo) / span : 0.5));
}

type MonitorMeta = Pick<ScanMeta, "priceNow" | "liquidityUsd" | "circulatingSupply" | "marketCapUsd"> | null | undefined;

export function monitorChannels(findings: TabFlagInput, meta: MonitorMeta, you: WalletCheck | null | undefined): MonitorChannel[] {
  const { buyers: b, flow: f, walls: w, smart: s } = findings;
  const channels: MonitorChannel[] = [];

  /* 01 · real buyers */
  {
    const flag = demandFlag(b);
    const base = { n: 1 as const, label: "Real buyers", flag, valueTone: flag.tone };
    if (!b) channels.push({ ...base, sub: "tracing funders", value: NA, trace: { kind: "blank", text: "WAITING FOR DATA" } });
    else if (!isAvailable(b)) channels.push({ ...base, sub: "no buyer data", value: NA, trace: { kind: "blank", text: "NO DATA" } });
    else if (isTraced(b)) {
      const big = biggestSource(b);
      const hot = big && big.wallets > 1 ? big.wallets : 0;
      const fund = buyerFunding(b);
      channels.push({
        ...base,
        sub: `of ${count(fund.buyers)} funded independently`,
        value: count(fund.independent),
        trace: { kind: "dots", left: b.topBuyers, leftHot: hot, leftHollow: Math.round(b.topBuyers * clamp01(b.untracedShare)), right: b.sources, rightHot: hot > 0 },
      });
    } else {
      const share = top10Share(b) ?? clamp01(b.topShare);
      channels.push({
        ...base,
        sub: `top ${count(b.topBuyers)} of ${buyersTotalText(b)} buyers`,
        value: pct0(share),
        trace: { kind: "dots", left: Math.max(b.totalBuyers, b.topBuyers), leftHot: b.topBuyers, leftHollow: 0, right: null, rightHot: false },
      });
    }
  }

  /* 02 · informed flow */
  {
    const flag = flowFlag(f);
    const base = { n: 2 as const, label: "Informed flow", flag, valueTone: flag.tone };
    if (!f) channels.push({ ...base, sub: "7 days", value: NA, trace: { kind: "blank", text: "WAITING FOR DATA" } });
    else if (!isAvailable(f)) channels.push({ ...base, sub: "no labelled flow", value: NA, trace: { kind: "blank", text: "NO DATA" } });
    else {
      // The number the flag was read from: the net move as a share of market cap (else of supply), so a
      // "+1.0%" never sits next to NORMAL because the verdict used another base.
      const move = informedMove(f, meta?.marketCapUsd);
      const base2 = flowBase(meta);
      // A rounded "0.0%" reads like missing data; below the "barely moved" line it is "about zero".
      const flat = move !== null && Math.abs(move) < T.copy.quietFlow;
      channels.push({
        ...base,
        sub: move !== null ? `7 days, % of ${base2}` : "7 days, net USD",
        value: flat ? "≈0%" : move !== null ? formatSignedPct(move) : signedUsd(f.informedNetUsd),
        trace: { kind: "ecg", beats: ecgBeats(f) },
      });
    }
  }

  /* 03 · sell wall */
  {
    const flag = ceilingFlag(w);
    const base = { n: 3 as const, label: "Sell wall", flag, valueTone: flag.tone };
    if (!w) channels.push({ ...base, sub: "vs pool liquidity", value: NA, trace: { kind: "blank", text: "WAITING FOR DATA" } });
    else if (!isAvailable(w)) channels.push({ ...base, sub: "no entry prices", value: NA, trace: { kind: "blank", text: "NO DATA" } });
    else {
      const supply = meta?.circulatingSupply ?? null;
      const main = primaryWall(w, supply);
      const heavyWall = !!main && isHeavyWall(main, w, supply);
      const share = main ? wallAnalysedShare(main, w, supply) : null;
      // Heavy by its share of the analysed supply while small next to the pool: show the share (the
      // reason it is flagged), not a short bar under the pool line next to a red HIGH.
      const heavyByShare =
        heavyWall && share !== null && !(finite(main!.wallToLiquidity) && main!.wallToLiquidity >= T.ceiling.wallToLiquidity);
      if (heavyByShare) {
        const lim = T.ceiling.wallShareOfAnalysed;
        channels.push({
          ...base,
          sub: "of analysed supply",
          value: pct0(share!),
          trace: { kind: "bar", value: share!, max: Math.max(lim * 2, share! * 1.25), ref: lim, refLabel: "LIMIT" },
        });
      } else if (w.underwaterShare >= T.ceiling.underwaterShare && !heavyWall) {
        channels.push({
          ...base,
          sub: "supply underwater",
          value: pct0(w.underwaterShare),
          trace: { kind: "bar", value: clamp01(w.underwaterShare), max: 1, ref: T.ceiling.underwaterShare, refLabel: "LIMIT" },
        });
      } else if (main && finite(main.wallToLiquidity)) {
        channels.push({
          ...base,
          sub: "vs pool liquidity",
          value: formatMultiple(main.wallToLiquidity),
          trace: { kind: "bar", value: main.wallToLiquidity, max: niceMax(main.wallToLiquidity), ref: 1, refLabel: "POOL" },
        });
      } else if (main && share !== null) {
        const lim = T.ceiling.wallShareOfAnalysed;
        channels.push({
          ...base,
          sub: "of analysed supply",
          value: pct0(share),
          trace: { kind: "bar", value: share, max: Math.max(lim * 2, share * 1.25), ref: lim, refLabel: "LIMIT" },
        });
      } else {
        channels.push({ ...base, sub: "nothing above the price", value: "none", trace: { kind: "bar", value: 0, max: 2, ref: 1, refLabel: "POOL" } });
      }
    }
  }

  /* 04 · smart money */
  {
    const flag = smartTabFlag(s);
    const base = { n: 4 as const, label: "Smart money", flag };
    if (!s) channels.push({ ...base, valueTone: "grey", sub: "price vs their entry", value: NA, trace: { kind: "blank", text: "WAITING FOR DATA" } });
    else if (!isAvailable(s)) channels.push({ ...base, valueTone: "grey", sub: "no smart-money data", value: NA, trace: { kind: "blank", text: "NO DATA" } });
    else if (tooFewSmartWallets(s)) {
      channels.push({ ...base, valueTone: "grey", sub: `${count(s.wallets)} ${plural(s.wallets, "wallet", "wallets")}, too few to show`, value: NA, trace: { kind: "blank", text: "AGGREGATE HIDDEN" } });
    } else if (!hasSmartData(s) || !finite(s.pnlPct)) {
      channels.push({ ...base, valueTone: "grey", sub: `none in ${s.windowDays} days`, value: NA, trace: { kind: "blank", text: "NO SMART MONEY" } });
    } else {
      const m = 1 + s.pnlPct;
      channels.push({
        ...base,
        valueTone: pnlTone(s.state),
        sub: "price vs their entry",
        value: formatSignedPct(s.pnlPct),
        trace: { kind: "bar", value: Math.max(0, m), max: niceMax(m), ref: 1, refLabel: "ENTRY" },
      });
    }
  }

  /* 05 · you */
  {
    const flag = youTabFlag(you);
    const base = { n: 5 as const, label: "You", flag, valueTone: flag.tone };
    if (!you) channels.push({ ...base, sub: "your entry vs smart money", value: NA, trace: { kind: "check" } });
    else if (!isAvailable(you) || !finite(you.cost) || you.cost <= 0) {
      channels.push({ ...base, sub: `no position for ${you.short}`, value: NA, trace: { kind: "blank", text: "NO POSITION" } });
    } else {
      const sm = hasSmartData(s) ? (s!.avgEntry as number) : null;
      const now = finite(meta?.priceNow) && (meta?.priceNow ?? 0) > 0 ? (meta!.priceNow as number) : null;
      const keys: { key: "sm" | "now" | "you"; label: string; p: number }[] = [];
      if (sm !== null) keys.push({ key: "sm", label: "SM", p: sm });
      if (now !== null) keys.push({ key: "now", label: "NOW", p: now });
      keys.push({ key: "you", label: "YOU", p: you.cost });
      const xs = logPositions(keys.map((k) => k.p));
      channels.push({
        ...base,
        sub: "your entry vs smart money",
        value: finite(you.vsSmartMoneyPct) ? formatSignedPct(you.vsSmartMoneyPct) : price(you.cost),
        trace: { kind: "marks", marks: keys.map((k, i) => ({ key: k.key, label: k.label, x: xs[i] })) },
      });
    }
  }
  return channels;
}

/**
 * The Summary chip: how many channels carry a red flag (red = a warning for someone buying today).
 * "3 of 5 abnormal"; amber when none is red but one is borderline; PENDING (grey) while no channel has
 * a reading yet, NO DATA when none will.
 */
export function abnormalFlag(channels: readonly Pick<MonitorChannel, "flag">[]): LabFlag {
  const read = channels.filter((c) => c.flag.level !== "pending" && c.flag.level !== "none");
  if (!read.length) return channels.some((c) => c.flag.level === "pending") ? labFlag("pending", "grey") : labFlag("none", "grey");
  const n = channels.filter((c) => c.flag.tone === "red").length;
  const tone: FlagTone = n > 0 ? "red" : channels.some((c) => c.flag.tone === "amber") ? "amber" : "green";
  return labFlag(n > 0 ? "high" : "normal", tone, `${n} of ${channels.length} abnormal`);
}

/** The rubber stamp under the monitor: "Diagnosis / Rule 2 / Confidence high". */
export function diagnosisStamp(d: Diagnosis | null | undefined): { rule: string; confidence: string; tone: FlagTone } {
  if (!d) return { rule: "Pending", confidence: "Awaiting scan", tone: "grey" };
  const tone: FlagTone = d.code === "normal" ? "green" : d.code === "insufficient" ? "grey" : "red";
  return { rule: `Rule ${d.rule}`, confidence: `Confidence ${d.confidence}`, tone };
}

/* ---------------------------------------------------------------- 01 · funnel + treemap */

export type TileKind = "biggest" | "exchange" | "independent" | "untraced" | "buyer" | "rest";

export interface TreeLeaf {
  id: string;
  kind: TileKind;
  /** Share of the analysed buy volume (0..1); for untraced scans a share of all buying. */
  share: number;
  /** "Binance", "0x5eed…1599", "Untraced", "9 independent" */
  label: string;
  wallets: number;
  /** The funder's full address (biggest source) or the buyer's (untraced scans). */
  address?: string;
  usd: number;
}

export interface TreeTile extends TreeLeaf {
  /** Independent sources inside their group tile. */
  children?: TreeLeaf[];
}

export interface FunnelDot {
  kind: "biggest" | "exchange" | "independent";
  wallets: number;
  label: string;
}

export interface BuyersChart {
  traced: boolean;
  /** Wallet dots on the left of the funnel. */
  wallets: number;
  /** "80 WALLETS", "412 WALLETS" */
  walletsLabel: string;
  /** Highlighted wallet dots: funded by the biggest source (traced), or the top buyers (untraced). */
  hot: number;
  /** Untraced wallets (drawn hollow). */
  hollow: number;
  /** One dot per independent funding source (traced scans). */
  sources: FunnelDot[];
  /** "23 SOURCES" (traced) or "72% OF THE BUYING" (untraced). */
  sourcesLabel: string;
  /** Untraced scans: the top buyers' share of all buying. */
  topShare: number | null;
  /**
   * How loud the biggest single source is drawn: red only at the CONCENTRATED line, amber at the
   * ORGANIC limit, grey (a neutral dark tile) below it, where it is just the largest of many.
   */
  bigTone: FlagTone;
  tiles: TreeTile[];
  legend: { kind: TileKind; label: string }[];
}

function shareOf(c: SourceCluster, total: number): number {
  return finite(c.share) && c.share > 0 ? c.share : total > 0 ? c.boughtUsd / total : 0;
}

export function buyersChart(b: BuyersFinding | null | undefined): BuyersChart | null {
  if (!b || !isAvailable(b)) return null;
  if (isTraced(b) && b.clusters.length) {
    const total = sum(b.clusters.map((c) => c.boughtUsd));
    const big = biggestSource(b);
    const hot = big && big.wallets > 1 ? big.wallets : 0;
    const dots: FunnelDot[] = [];
    if (big) dots.push({ kind: "biggest", wallets: big.wallets, label: sourceName(big) });
    for (const c of b.clusters) {
      if (c === big) continue;
      if (c.kind === "exchange" || c.kind === "bridge") for (let i = 0; i < c.wallets; i++) dots.push({ kind: "exchange", wallets: 1, label: sourceName(c) });
    }
    const own = b.clusters.filter((c) => c !== big && (c.kind === "wallet" || c.kind === "self")).sort((x, y) => y.wallets - x.wallets);
    for (const c of own) dots.push({ kind: "independent", wallets: c.wallets, label: sourceName(c) });

    const tiles: TreeTile[] = [];
    if (big) tiles.push({ id: big.id, kind: "biggest", share: shareOf(big, total), label: sourceName(big), wallets: big.wallets, address: big.funder, usd: big.boughtUsd });
    for (const c of b.clusters) {
      if (c.kind === "exchange" || c.kind === "bridge") tiles.push({ id: c.id, kind: "exchange", share: shareOf(c, total), label: sourceName(c), wallets: c.wallets, usd: c.boughtUsd });
    }
    if (own.length) {
      const children: TreeLeaf[] = own
        .map((c) => ({ id: c.id, kind: "independent" as const, share: shareOf(c, total), label: sourceName(c), wallets: c.wallets, address: c.funder, usd: c.boughtUsd }))
        .sort((x, y) => y.share - x.share);
      tiles.push({
        id: "independent",
        kind: "independent",
        share: sum(children.map((c) => c.share)),
        label: `${count(own.length)} independent`,
        wallets: sum(own.map((c) => c.wallets)),
        usd: sum(own.map((c) => c.boughtUsd)),
        children,
      });
    }
    const untraced = b.clusters.filter((c) => c.kind === "untraced");
    if (untraced.length) {
      tiles.push({
        id: "untraced",
        kind: "untraced",
        share: sum(untraced.map((c) => shareOf(c, total))),
        label: "Untraced",
        wallets: sum(untraced.map((c) => c.wallets)),
        usd: sum(untraced.map((c) => c.boughtUsd)),
      });
    }
    const bigShare = clamp01(b.biggestSourceShare);
    const bigTone: FlagTone =
      bigShare >= T.demand.concentratedSourceShare ? "red" : bigShare >= T.demand.organicMaxSourceShare ? "amber" : "grey";
    const legend: BuyersChart["legend"] = [];
    if (big) legend.push({ kind: "biggest", label: big.wallets > 1 ? `one wallet funded ${count(big.wallets)} buyers` : "biggest single source" });
    if (tiles.some((t) => t.kind === "exchange")) legend.push({ kind: "exchange", label: "exchange or bridge" });
    if (own.length) legend.push({ kind: "independent", label: "independent" });
    if (untraced.length) legend.push({ kind: "untraced", label: "untraced" });
    return {
      traced: true,
      wallets: b.topBuyers,
      walletsLabel: `${count(b.topBuyers)} ${plural(b.topBuyers, "WALLET", "WALLETS")}`,
      hot,
      hollow: Math.round(b.topBuyers * clamp01(b.untracedShare)),
      sources: dots,
      sourcesLabel: `${count(b.sources)} ${plural(b.sources, "SOURCE", "SOURCES")}`,
      topShare: null,
      bigTone,
      tiles: tiles.filter((t) => t.share > 0),
      legend,
    };
  }

  // Funders were not traced: the week's largest buyers against everyone else.
  const share = top10Share(b) ?? clamp01(b.topShare);
  const rows: BuyerRow[] = b.largestBuyers ?? [];
  const topUsd = sum(rows.map((r) => r.boughtUsd));
  const allUsd = share > 0 ? topUsd / share : topUsd;
  const tiles: TreeTile[] = rows
    .filter((r) => r.boughtUsd > 0)
    .map((r) => ({ id: r.address, kind: "buyer" as const, share: allUsd > 0 ? r.boughtUsd / allUsd : 0, label: r.short, wallets: 1, address: r.address, usd: r.boughtUsd }));
  const rest = 1 - sum(tiles.map((t) => t.share));
  const others = Math.max(0, b.totalBuyers - rows.length);
  const more = b.totalBuyersCapped ? "+" : "";
  if (rest > 0.001) tiles.push({ id: "rest", kind: "rest", share: rest, label: `${count(others)}${more} other ${plural(others, "buyer", "buyers")}`, wallets: others, usd: Math.max(0, allUsd - topUsd) });
  const wallets = Math.max(b.totalBuyers, b.topBuyers);
  return {
    traced: false,
    wallets,
    walletsLabel: `${buyersTotalText(b)} ${plural(wallets, "WALLET", "WALLETS")}`,
    hot: b.topBuyers,
    hollow: 0,
    sources: [],
    sourcesLabel: `${pct0(share)} OF THE BUYING`,
    topShare: share,
    bigTone: "grey",
    tiles: tiles.filter((t) => t.share > 0),
    legend: [
      ...(tiles.some((t) => t.kind === "buyer") ? [{ kind: "buyer" as const, label: "largest buyers" }] : []),
      ...(tiles.some((t) => t.kind === "rest") ? [{ kind: "rest" as const, label: "everyone else" }] : []),
    ],
  };
}

export function buyersAnswer(b: BuyersFinding | null | undefined): LabAnswer {
  if (!b) return { value: NA, tone: "grey", line: "Buyer data is still being read." };
  const tone = demandFlag(b).tone;
  if (!isAvailable(b)) return { value: NA, tone: "grey", line: noDash(b.note ?? "Buyer data was not available for this scan.") };
  const n = b.topBuyers;
  if (!isTraced(b)) {
    const share = top10Share(b) ?? clamp01(b.topShare);
    const top1 = clamp01(b.biggestSourceShare);
    const largest = n > 1 && top1 > 0 ? ` The largest alone did ${pct0(top1)}.` : "";
    return {
      value: pct0(share),
      tone,
      line: `of this week's buying came from the top ${count(n)} ${plural(n, "buyer", "buyers")}.${largest} ${untracedReason(b)}`,
    };
  }
  if (b.sources <= 0) return { value: "0", tone, line: `None of the top ${count(n)} buyers could be traced to a funder.` };
  // "88" + "of the top 90 buyers were funded independently. 1 shared a funder ...": the big number is
  // the first word of the sentence the report types.
  const f = buyerFunding(b);
  const rest = fundingSentence(b).split(/(?<=\.) /).slice(1).join(" ");
  const head = `of the top ${count(f.buyers)} ${plural(f.buyers, "buyer", "buyers")} ${f.independent === 1 ? "was" : "were"} funded independently.`;
  return { value: count(f.independent), tone, line: rest ? `${head} ${rest}` : head };
}

/* ---------------------------------------------------------------- 02 · tug of war + daily bars */

export interface FlowSide {
  /** "SMART MONEY + WHALES", "FRESH WALLETS" */
  who: string;
  usd: number | null;
  /** "sold $2M", "bought $1.6M", "n/a" */
  text: string;
  /** red = sold, green = bought, grey = unknown or flat */
  tone: FlagTone;
}

export interface FlowChart {
  left: FlowSide;
  right: FlowSide;
  /**
   * Knot offset, -1 (all the way to the informed side) .. +1 (to the fresh side): the rope is pulled
   * towards whoever ends up with the supply (fresh wallets when informed money distributes, informed
   * money when it accumulates), as far as informed money's net move against the flow threshold.
   */
  knot: number;
  /** "← SUPPLY IS MOVING TO THE CROWD" */
  caption: string;
  /** "Exchanges took in 0.8% of supply", or null. */
  exchanges: string | null;
  days: { day: string; label: string; usd: number }[];
  /** Index into days of the largest net outflow, or null. */
  worst: number | null;
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-21" -> "MON" */
export function weekday(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day.slice(5) : WEEKDAYS[d.getUTCDay()];
}

/** "2026-09-21" -> "Mon 21 Sep" */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const wd = WEEKDAYS[d.getUTCDay()];
  return `${wd[0]}${wd.slice(1).toLowerCase()} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function side(who: string, usd: number | null | undefined): FlowSide {
  if (!finite(usd)) return { who, usd: null, text: NA, tone: "grey" };
  if (usd === 0) return { who, usd: 0, text: "flat", tone: "grey" };
  return { who, usd, text: `${usd < 0 ? "sold" : "bought"} ${formatUsdCompact(Math.abs(usd))}`, tone: usd < 0 ? "red" : "green" };
}

export function flowChart(f: FlowFinding | null | undefined, meta?: Pick<ScanMeta, "marketCapUsd"> | null): FlowChart | null {
  if (!f || !isAvailable(f)) return null;
  const left = side("SMART MONEY + WHALES", f.informedNetUsd);
  const right = side("FRESH WALLETS", f.freshNetUsd);
  // Direction: where the supply goes. Informed selling moves it to the crowd (right), informed buying
  // to smart money (left). Distance: informed money's net move against the flow threshold (a week at
  // 5x the threshold pulls all the way), so a $29M crowd next to a $289K seller does not pin the knot
  // just because the crowd is bigger; a quiet week barely moves it.
  const usd = finite(f.informedNetUsd) ? f.informedNetUsd : 0;
  const move = informedMove(f, meta?.marketCapUsd);
  const dir = f.verdict === "distributing" ? 1 : f.verdict === "accumulating" ? -1 : usd < 0 ? 1 : usd > 0 ? -1 : 0;
  const strength = move !== null ? clamp01(Math.abs(move) / (T.flow.moveShare * 5)) : usd !== 0 ? 0.5 : 0;
  let knot = dir * Math.sqrt(strength);
  if (f.verdict === "quiet") knot *= 0.35;
  else if (dir !== 0) knot = dir * Math.max(0.25, Math.abs(knot));
  const text =
    f.verdict === "distributing" ? "SUPPLY IS MOVING TO THE CROWD" : f.verdict === "accumulating" ? "SMART MONEY IS TAKING SUPPLY" : "QUIET WEEK · NO CLEAR PULL";
  // A quiet week has no direction to point at, whatever small drift the knot shows.
  const caption = f.verdict === "quiet" ? text : knot < -0.02 ? `← ${text}` : knot > 0.02 ? `${text} →` : text;

  const x = f.exchangeNetPctSupply;
  const exchanges = !finite(x)
    ? null
    : Math.abs(x) < 0.0005
      ? "Exchanges barely moved"
      : x > 0
        ? `Exchanges took in ${formatPct(x, 1)} of supply`
        : `Exchanges sent out ${formatPct(-x, 1)} of supply`;

  const days = [...f.daily]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((d) => ({ day: d.day, label: weekday(d.day), usd: finite(d.informedUsd) ? d.informedUsd : 0 }));
  let worst: number | null = null;
  days.forEach((d, i) => {
    if (d.usd < 0 && (worst === null || d.usd < days[worst].usd)) worst = i;
  });
  return { left, right, knot: clamp(knot, -1, 1), caption, exchanges, days, worst };
}

export function flowAnswer(f: FlowFinding | null | undefined, meta: Pick<ScanMeta, "marketCapUsd"> | null | undefined): LabAnswer {
  if (!f) return { value: NA, tone: "grey", line: "Flow data is still being read." };
  if (!isAvailable(f)) return { value: NA, tone: "grey", line: "No labelled flow data for this token this week." };
  const usd = finite(f.informedNetUsd) ? f.informedNetUsd : 0;
  const tone = flowFlag(f).tone;
  const value = usd === 0 ? "$0" : signedUsd(usd);
  const move = informedMove(f, meta?.marketCapUsd);
  let line: string;
  if (f.verdict === "distributing") {
    line = finite(f.freshNetUsd) && f.freshNetUsd > 0 ? `Smart money and whales sold. Fresh wallets bought ${formatUsdCompact(f.freshNetUsd)}.` : "Smart money and whales sold into other buyers.";
  } else if (f.verdict === "accumulating") {
    line = "Smart money and whales bought on net this week.";
  } else if (move !== null && move <= -T.flow.moveShare) {
    line = "Smart money and whales sold, but fresh wallets did not buy the other side.";
  } else {
    line = `Smart money and whales moved less than ${formatPct(T.flow.moveShare, 1)} of ${flowBase(meta)}.`;
  }
  return { value, tone, line };
}

/* ---------------------------------------------------------------- 03 · the price ladder */

export type LadderZone = "above" | "band" | "below";

export interface LadderBar {
  lo: number;
  hi: number;
  mid: number;
  tokens: number;
  supplyShare: number;
  /** USD at its entry price / pool liquidity; null without liquidity. */
  ratio: number | null;
  /** Bar length in the chart's unit (ratio with liquidity, share of supply without). */
  size: number;
  zone: LadderZone;
}

export interface WallBar {
  price: number;
  movePct: number;
  tokens: number;
  ratio: number | null;
  size: number;
  main: boolean;
  /** "2.3× POOL", "12% OF SUPPLY" */
  label: string;
}

export interface WallsChart {
  now: number | null;
  /** Log price axis. */
  lo: number;
  hi: number;
  /**
   * Share of the chart's height above today's price (a split log axis: each side log-scaled on its
   * own), or null for one plain log axis. Real ladders run 20-40x below the price and only +30% above
   * it, so on one axis the walls (the question of this tab) got a sliver; they get at least 38%.
   */
  split: number | null;
  ticks: number[];
  bars: LadderBar[];
  walls: WallBar[];
  /** "pool": sizes are multiples of the pool (a dashed POOL LIQUIDITY line at 1); "share": of supply. */
  unit: "pool" | "share";
  /** Largest size on the chart. */
  maxSize: number;
  /** "Cost basis · 74 holders · 71% of supply analysed" */
  method: string;
}

/** Round prices on a log axis: the densest set of 1-2-5 style steps with at most `max` ticks inside [lo, hi]. */
export function logTicks(lo: number, hi: number, max = 6): number[] {
  return roundTicks(lo, hi, max, 2);
}

function roundTicks(lo: number, hi: number, max: number, minCount: number): number[] {
  if (!(lo > 0) || !(hi > lo)) return [];
  const sets = [[1], [1, 2, 5], [1, 2, 3, 5], [1, 2, 3, 4, 5, 6, 7, 8, 9]];
  const all = sets.map((mult) => {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of mult) {
        const v = Number((m * 10 ** e).toPrecision(6));
        if (v >= lo && v <= hi) out.push(v);
      }
    }
    return out;
  });
  const fit = all.filter((t) => t.length <= max);
  const best = fit.length ? fit[fit.length - 1] : all[0];
  if (best.length >= minCount) return best;
  return [Number(lo.toPrecision(2)), Number(hi.toPrecision(2))].filter((v) => v >= lo && v <= hi);
}

/** Price -> y on the ladder's axis (split at today's price when chart.split is set). */
export function ladderScale(chart: Pick<WallsChart, "lo" | "hi" | "now" | "split">, bottom: number, top: number): (p: number) => number {
  const L = (p: number) => Math.log(Math.max(p, 1e-300));
  const { lo, hi, now, split } = chart;
  const span = (a: number, b: number) => L(b) - L(a) || 1;
  if (now === null || split === null || !(now > lo && now < hi)) {
    return (p) => bottom - ((L(p) - L(lo)) / span(lo, hi)) * (bottom - top);
  }
  const yNow = top + split * (bottom - top);
  return (p) => (p >= now ? yNow - ((L(p) - L(now)) / span(now, hi)) * (yNow - top) : bottom - ((L(p) - L(lo)) / span(lo, now)) * (bottom - yNow));
}

export function wallsChart(w: WallsFinding | null | undefined, meta: Pick<ScanMeta, "priceNow" | "liquidityUsd" | "circulatingSupply"> | null | undefined): WallsChart | null {
  if (!w || !isAvailable(w)) return null;
  const now = finite(meta?.priceNow) && (meta?.priceNow ?? 0) > 0 ? (meta!.priceNow as number) : null;
  const liq = finite(meta?.liquidityUsd) && (meta?.liquidityUsd ?? 0) > 0 ? (meta!.liquidityUsd as number) : null;
  const unit: WallsChart["unit"] = liq ? "pool" : "share";
  const main = primaryWall(w, meta?.circulatingSupply ?? null);
  const above = w.walls.filter((x) => finite(x.price) && x.price > 0 && x.tokens > 0 && finite(x.movePct) && x.movePct > 0);

  const bins = w.ladder.filter((b: LadderBin) => b.lo > 0 && b.hi > b.lo && finite(b.tokens) && b.tokens >= 0);
  const bars: LadderBar[] = bins.map((b) => {
    const mid = Math.sqrt(b.lo * b.hi);
    const ratio = liq ? (b.tokens * mid) / liq : null;
    const isAbove = now !== null ? mid > now : false;
    const band = isAbove && above.some((x) => x.price >= b.lo && x.price < b.hi);
    return {
      lo: b.lo,
      hi: b.hi,
      mid,
      tokens: b.tokens,
      supplyShare: finite(b.supplyShare) ? b.supplyShare : 0,
      ratio,
      size: unit === "pool" ? (ratio ?? 0) : finite(b.supplyShare) ? b.supplyShare : 0,
      zone: band ? "band" : isAbove ? "above" : "below",
    };
  });
  const walls: WallBar[] = above.map((x) => {
    const ratio = finite(x.wallToLiquidity) ? x.wallToLiquidity : liq ? (x.tokens * x.price) / liq : null;
    const size = unit === "pool" ? (ratio ?? 0) : finite(x.supplyShare) ? x.supplyShare : 0;
    return {
      price: x.price,
      movePct: x.movePct,
      tokens: x.tokens,
      ratio,
      size,
      main: x === main,
      label: unit === "pool" && ratio !== null ? `${formatMultiple(ratio)} POOL` : `${formatPct(finite(x.supplyShare) ? x.supplyShare : 0, 1)} OF SUPPLY`,
    };
  });

  const prices = [...bins.flatMap((b) => [b.lo, b.hi]), ...above.map((x) => x.price), ...(now !== null ? [now] : [])];
  if (!prices.length) return null;
  const lo = Math.min(...prices) / 1.04;
  const hi = Math.max(...prices) * 1.04;
  const m = wallsMethod(w);
  const somethingAbove = now !== null && (above.length > 0 || bins.some((b) => b.tokens > 0 && b.hi > now * 1.001));
  const natural = now !== null && hi > now && now > lo ? Math.log(hi / now) / Math.log(hi / lo) : null;
  const split = somethingAbove && natural !== null ? clamp(natural, 0.38, 0.62) : null;
  const ticks =
    split !== null && now !== null
      ? [...new Set([...roundTicks(lo, now, 4, 2), ...roundTicks(now, hi, 3, 1)])].sort((a, b) => a - b)
      : logTicks(lo, hi);
  return {
    now,
    lo,
    hi,
    split,
    ticks,
    bars,
    walls,
    unit,
    maxSize: Math.max(1e-12, ...bars.map((b) => b.size), ...walls.map((x) => x.size)),
    method: `${m.value} · ${wallsAnalysedWho(w)} · ${pct0(clamp01(w.analyzedSupplyShare))} of supply analysed`,
  };
}

export function wallsAnswer(w: WallsFinding | null | undefined, meta: Pick<ScanMeta, "circulatingSupply" | "liquidityUsd"> | null | undefined): LabAnswer {
  if (!w) return { value: NA, tone: "grey", line: "Holders' entry prices are still being read." };
  if (!isAvailable(w)) return { value: NA, tone: "grey", line: "Holders' entry prices were not available." };
  const tone = ceilingFlag(w).tone;
  const supply = meta?.circulatingSupply ?? null;
  const main = primaryWall(w, supply);
  const heavyWall = !!main && isHeavyWall(main, w, supply);
  if (w.underwaterShare >= T.ceiling.underwaterShare && !heavyWall) {
    return { value: pct0(w.underwaterShare), tone, line: "of the analysed supply was bought above today's price. Those holders are underwater." };
  }
  if (!main) return { value: "None", tone, line: "No sell wall sits above today's price." };
  const share = wallAnalysedShare(main, w, supply);
  const byLiquidity = finite(main.wallToLiquidity) && main.wallToLiquidity >= T.ceiling.wallToLiquidity;
  // Heavy because of its share of the analysed supply (not the pool): say so next to the pool multiple.
  const byShare = heavyWall && !byLiquidity && share !== null;
  const size = finite(main.wallToLiquidity)
    ? byShare
      ? ` That wall is ${formatMultiple(main.wallToLiquidity)} the pool and ${pct0(share!)} of the analysed supply.`
      : ` That wall is ${formatMultiple(main.wallToLiquidity)} the pool.`
    : share !== null
      ? ` That is ${pct0(share)} of the analysed supply.`
      : "";
  const far = main.movePct > T.ceiling.nearMovePct ? ` It is beyond the +${pct0(T.ceiling.nearMovePct)} that counts.` : "";
  const thin = w.analyzedSupplyShare < T.insufficient.analysedSupply ? ` Only ${pct0(clamp01(w.analyzedSupplyShare))} of supply has a known entry.` : "";
  return {
    value: formatSignedPct(main.movePct),
    tone,
    line: `${formatAmount(main.tokens)} tokens are back to break-even at ${priceShort(main.price)}.${size}${far}${thin}`,
  };
}

/* ---------------------------------------------------------------- 04 · the gauge */

export interface SmartGauge {
  state: "ok" | "too-few" | "none" | "unavailable" | "pending";
  /** Gauge range relative to smart money's average entry (P&L fractions: -0.5 = -50%, 4 = 5x). */
  min: number;
  max: number;
  /** The loss / break-even / profit zones. */
  zones: { from: number; to: number; tone: FlagTone }[];
  /** Round readings printed around the arc ("-50%", "ENTRY", "2×", "5×"). */
  ticks: { v: number; label: string }[];
  /** pnlPct clamped into [min, max], or null (grey gauge). */
  needle: number | null;
  /** The reading was beyond the scale. */
  offScale: boolean;
  stance: { word: string; arrow: string; tone: FlagTone } | null;
  /** Text in a grey gauge: "TOO FEW WALLETS", "NO SMART MONEY", "NO DATA", "PENDING". */
  blank: string | null;
}

const STANCE_BADGE: Record<SmartFinding["stance"], { word: string; arrow: string; tone: FlagTone }> = {
  adding: { word: "ADDING", arrow: "↑", tone: "green" },
  holding: { word: "HOLDING", arrow: "→", tone: "amber" },
  trimming: { word: "TRIMMING", arrow: "↓", tone: "red" },
  exiting: { word: "EXITING", arrow: "↓↓", tone: "red" },
};

/** Gauge ends as price multiples of the entry: at least 0.5x..2x, widened to fit real readings (5x, 20x). */
const GAUGE_TOPS = [2, 3, 5, 10, 20, 50, 100];
const GAUGE_BOTTOMS = [0.5, 0.25, 0.1];

/** "−50%", "ENTRY", "+50%", "2×", "12×" */
function gaugeLabel(v: number): string {
  if (Math.abs(v) < 1e-9) return "ENTRY";
  const m = 1 + v;
  return m >= 2 ? `${Number(m.toPrecision(3))}×` : formatSignedPct(v, 0);
}

/**
 * Where a P&L reading sits on the gauge, 0 (left end) .. 1 (right end): the arc is logarithmic in the
 * price multiple, so -50% and 2x sit at the same distance from the entry and a 5x reading still fits.
 */
export function gaugePos(g: Pick<SmartGauge, "min" | "max">, v: number): number {
  const L = (x: number) => Math.log(Math.max(1e-6, 1 + x));
  const span = L(g.max) - L(g.min) || 1;
  return clamp((L(v) - L(g.min)) / span, 0, 1);
}

export function smartGauge(s: SmartFinding | null | undefined): SmartGauge {
  const pnl = s && finite(s.pnlPct) ? s.pnlPct : null;
  const m = pnl !== null ? 1 + pnl : 1;
  const top = GAUGE_TOPS.find((t) => m * 1.12 <= t) ?? GAUGE_TOPS[GAUGE_TOPS.length - 1];
  const bottom = GAUGE_BOTTOMS.find((b) => m >= b * 1.12) ?? GAUGE_BOTTOMS[GAUGE_BOTTOMS.length - 1];
  const min = bottom - 1;
  const max = top - 1;
  const loss = T.smart.lossMultiple - 1;
  const profit = T.smart.profitMultiple - 1;
  const zones = [
    { from: min, to: loss, tone: "red" as const },
    { from: loss, to: profit, tone: "amber" as const },
    { from: profit, to: max, tone: "green" as const },
  ];
  // Ends, the entry, and round readings on the profit side (+50% on a 2x gauge; else up to two of
  // 2x / 5x / 10x ... below the top, e.g. 2x and 5x on a 10x gauge).
  const mids = top > 2 ? [2, 5, 10, 20, 50].filter((x) => x < top).slice(-2).map((x) => x - 1) : [0.5];
  const ticks = [min, 0, ...mids, max].map((v) => ({ v, label: gaugeLabel(v) }));
  const grey = (state: SmartGauge["state"], blank: string): SmartGauge => ({ state, min, max, zones, ticks, needle: null, offScale: false, stance: null, blank });
  if (!s) return grey("pending", "PENDING");
  if (!isAvailable(s)) return grey("unavailable", "NO DATA");
  if (tooFewSmartWallets(s)) return grey("too-few", "TOO FEW WALLETS");
  if (!hasSmartData(s) || pnl === null) return grey("none", "NO SMART MONEY");
  return {
    state: "ok",
    min,
    max,
    zones,
    ticks,
    needle: clamp(pnl, min, max),
    offScale: pnl < min || pnl > max,
    stance: STANCE_BADGE[s.stance],
    blank: null,
  };
}

export function smartAnswer(s: SmartFinding | null | undefined): LabAnswer {
  if (!s) return { value: NA, tone: "grey", line: "Smart-money data is still being read." };
  if (!isAvailable(s)) return { value: NA, tone: "grey", line: "Smart-money data was not available for this token." };
  if (tooFewSmartWallets(s)) {
    return {
      value: count(s.wallets),
      tone: "grey",
      line: `smart-money ${plural(s.wallets, "wallet", "wallets")} traded it in ${s.windowDays} days. Too few to show: an aggregate needs at least ${T.smart.minWallets}.`,
    };
  }
  if (!hasSmartData(s) || !finite(s.pnlPct)) return { value: "0", tone: "grey", line: `No smart money traded this token in the last ${s.windowDays} days.` };
  const now =
    s.stance === "trimming"
      ? s.state === "profit"
        ? "trimming into strength"
        : "trimming"
      : s.stance === "exiting"
        ? "heading for the exit"
        : s.stance === "adding"
          ? "still adding"
          : "holding";
  return { value: formatSignedPct(s.pnlPct), tone: pnlTone(s.state), line: `Paid ${price(s.avgEntry)} on average. Now ${now}.` };
}

/* ---------------------------------------------------------------- 05 · your entry vs the holders */

export interface YouChart {
  checked: boolean;
  /** Log price axis. */
  lo: number;
  hi: number;
  bins: { lo: number; hi: number; tokens: number; cheaper: boolean }[];
  sm: number | null;
  now: number | null;
  you: number | null;
  /** Share of the analysed supply bought cheaper than your entry, 0..1. */
  cheaperShare: number | null;
}

export function youChart(
  you: WalletCheck | null | undefined,
  w: WallsFinding | null | undefined,
  s: SmartFinding | null | undefined,
  meta: Pick<ScanMeta, "priceNow"> | null | undefined,
): YouChart | null {
  const cost = you && isAvailable(you) && finite(you.cost) && you.cost > 0 ? you.cost : null;
  const sm = hasSmartData(s) ? (s!.avgEntry as number) : null;
  const now = finite(meta?.priceNow) && (meta?.priceNow ?? 0) > 0 ? (meta!.priceNow as number) : null;
  const ladder = w && isAvailable(w) ? w.ladder.filter((b) => b.lo > 0 && b.hi > b.lo && finite(b.tokens) && b.tokens >= 0) : [];
  const prices = [...ladder.flatMap((b) => [b.lo, b.hi]), ...[sm, now, cost].filter((p): p is number => p !== null)];
  if (!prices.length) return null;
  const lo = Math.min(...prices) / 1.06;
  const hi = Math.max(...prices) * 1.06;
  const bins = ladder.map((b) => ({ lo: b.lo, hi: b.hi, tokens: b.tokens, cheaper: cost !== null && Math.sqrt(b.lo * b.hi) < cost }));
  let cheaperShare: number | null = you && finite(you.cheaperShare) ? clamp01(you.cheaperShare) : null;
  if (cheaperShare === null && cost !== null) {
    const total = sum(bins.map((b) => b.tokens));
    cheaperShare = total > 0 ? sum(bins.filter((b) => b.cheaper).map((b) => b.tokens)) / total : null;
  }
  return { checked: cost !== null, lo, hi, bins, sm, now, you: cost, cheaperShare: cost !== null ? cheaperShare : null };
}

export function youAnswer(you: WalletCheck | null | undefined, meta: Pick<ScanMeta, "symbol" | "name"> | null | undefined): LabAnswer {
  if (!you) {
    return { value: NA, tone: "grey", line: `Paste a wallet that holds ${meta ? patientName(meta) : "this token"} to put its entry on this chart. Your address is not stored.` };
  }
  const r = youResult(you);
  const tone = youFlag(you).tone;
  return { value: r.value, tone, line: r.verdict };
}

/* ---------------------------------------------------------------- Evidence: the waffle */

export type CallGroupKey = "info" | "who" | "funder" | "flows" | "holders" | "pnl" | "other";

/** Endpoint groups of the waffle, in drawing order, each with its square colour. */
export const CALL_GROUPS: readonly { key: CallGroupKey; label: string; color: string }[] = [
  { key: "info", label: "token info · price · trades", color: "#1f3a8a" },
  { key: "who", label: "who bought / sold", color: "#3d6fb6" },
  { key: "funder", label: "first funder", color: "#c0322a" },
  { key: "flows", label: "flows", color: "#c98512" },
  { key: "holders", label: "holders", color: "#1c1d22" },
  { key: "pnl", label: "cost basis (pnl)", color: "#2f8f6b" },
  { key: "other", label: "search · other", color: "#8b877c" },
];

export function callGroupOf(endpoint: string): CallGroupKey {
  const e = endpoint.replace(/^\/?(api\/v1\/)?/, "");
  if (e.startsWith("profiler/address/first-funder")) return "funder";
  if (e.startsWith("profiler/address/pnl")) return "pnl";
  if (e.startsWith("tgm/who-bought-sold")) return "who";
  if (e.startsWith("tgm/flows") || e.startsWith("tgm/flow-intelligence")) return "flows";
  if (e.startsWith("tgm/holders")) return "holders";
  if (e.startsWith("tgm/token-information") || e.startsWith("tgm/token-ohlcv") || e.includes("dex-trades") || e.startsWith("token-screener")) return "info";
  return "other";
}

export interface WaffleCell {
  /** 0-based position in the call log. */
  index: number;
  group: CallGroupKey;
  color: string;
  failed: boolean;
  cached: boolean;
  call: CallRecord;
}

export interface Waffle {
  cells: WaffleCell[];
  groups: { key: CallGroupKey; label: string; color: string; count: number; credits: number }[];
  failed: number;
  cached: number;
}

/** One square per call, grouped by endpoint (groups in CALL_GROUPS order, calls in log order inside). */
export function callWaffle(calls: readonly CallRecord[]): Waffle {
  const order = new Map(CALL_GROUPS.map((g, i) => [g.key, i]));
  const color = new Map(CALL_GROUPS.map((g) => [g.key, g.color]));
  const cells: WaffleCell[] = calls.map((c, index) => {
    const group = callGroupOf(c.endpoint);
    return { index, group, color: color.get(group) ?? "#8b877c", failed: c.status >= 400, cached: !!c.cached, call: c };
  });
  cells.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0) || a.index - b.index);
  const groups = CALL_GROUPS.map((g) => {
    const mine = cells.filter((c) => c.group === g.key);
    return { ...g, count: mine.length, credits: sum(mine.map((c) => c.call.credits)) };
  }).filter((g) => g.count > 0);
  return { cells, groups, failed: cells.filter((c) => c.failed).length, cached: cells.filter((c) => c.cached).length };
}

/** Totals of a scan, rebuilt from the call log while it is still running. */
export function callTotals(calls: readonly CallRecord[], totals: Scan["totals"] | null | undefined): Scan["totals"] {
  return (
    totals ?? {
      calls: calls.length,
      networkCalls: calls.filter((c) => !c.cached).length,
      credits: sum(calls.map((c) => c.credits)),
      cacheHits: calls.filter((c) => c.cached).length,
      durationMs: calls.reduce((m, c) => Math.max(m, finite(c.at) ? c.at : 0), 0),
    }
  );
}

export function evidenceAnswer(calls: readonly CallRecord[], totals: Scan["totals"] | null | undefined): LabAnswer {
  if (!calls.length) return { value: "0", tone: "grey", line: "No Nansen API calls recorded yet." };
  const t = callTotals(calls, totals);
  const failed = calls.filter((c) => c.status >= 400).length;
  const time = finite(t.durationMs) && t.durationMs > 0 ? ` · ${formatMs(t.durationMs)}` : "";
  return {
    value: count(t.calls),
    tone: "blue",
    line: `Nansen API ${plural(t.calls, "call", "calls")} · ${count(t.credits)} ${plural(t.credits, "credit", "credits")}${time}. One square per call.${failed ? ` ${failed} failed and count as missing data.` : ""}`,
  };
}
