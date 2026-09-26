// Every sentence EXPOSURE prints about a scan: the typed report's finding lines, the film's marker
// tags, the lab-results caveats, the form fields and the replay's stage messages. Pure functions,
// English only, numbers through lib/format. Never says "scam"; the term is "funding concentration".
import {
  formatAmount,
  formatMultiple,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatUsdCompact,
} from "../format";
import {
  hasSmartData,
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
  BuyersFinding,
  Diagnosis,
  FindingKey,
  FlowFinding,
  Scan,
  ScanMeta,
  SmartFinding,
  SourceCluster,
  Tier,
  WalletCheck,
  WallsFinding,
} from "./types";

export type FindingNo = 1 | 2 | 3 | 4 | 5;
type AnyFinding = BuyersFinding | FlowFinding | WallsFinding | SmartFinding | WalletCheck;
type Findings = Scan["findings"];

/** Film marker / report line number -> finding. */
export const FINDING_KEYS = { 1: "buyers", 2: "flow", 3: "walls", 4: "smart", 5: "you" } as const satisfies Record<
  FindingNo,
  FindingKey
>;

export function findingNo(key: FindingKey): FindingNo | null {
  switch (key) {
    case "buyers":
      return 1;
    case "flow":
      return 2;
    case "walls":
      return 3;
    case "smart":
      return 4;
    case "you":
      return 5;
    default:
      return null;
  }
}

/** Bold key typed after the number: "1. REAL BUYERS: ..." */
export const FINDING_TITLES: Record<FindingNo, string> = {
  1: "REAL BUYERS",
  2: "FLOW",
  3: "SELL WALL",
  4: "SMART MONEY",
  5: "YOU",
};

/** The plain question each finding answers (lab-results headings). */
export const FINDING_QUESTIONS: Record<FindingNo, string> = {
  1: "How many real buyers?",
  2: "Who is selling to whom?",
  3: "Where are sellers waiting?",
  4: "Is smart money in profit?",
  5: "And you?",
};

export const LIGHT_LABELS = { flow: "Flow", crowd: "Crowd", ceiling: "Ceiling" } as const;

/** Shown in a finding's slot until its data arrives. */
export const PENDING = "Pending.";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number) => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);
const pct0 = (x: number) => formatPct(x, 0);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Shown where a number is missing (never a dash). */
export const EMPTY_CELL = "n/a";

function count(n: number): string {
  if (!finite(n)) return EMPTY_CELL;
  const r = Math.round(n);
  return Math.abs(r) < 10_000 ? String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : formatAmount(r);
}

function sentence(s: string): string {
  const t = s.trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

function signedUsd(v: number): string {
  return v > 0 ? `+${formatUsdCompact(v)}` : formatUsdCompact(v);
}

/**
 * Short price for tags and report lines: two significant digits below $1 ("$0.030", "$0.050"),
 * lib/format's formatPrice otherwise (>= $1, or below $0.001 where it uses subscript zeros).
 */
export function priceShort(p: number | null | undefined): string {
  if (!finite(p)) return EMPTY_CELL;
  if (p <= 0 || p >= 1 || p < 0.001) return formatPrice(p);
  return `$${p.toPrecision(2)}`;
}

/** Axis tick price: formatPrice without trailing zeros ("$5", "$0.5", "$0.025", "$0.0₄12"). */
export function priceTick(p: number | null | undefined): string {
  if (!finite(p)) return EMPTY_CELL;
  const s = formatPrice(Number(p.toPrecision(3)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "0x12ab…9f3c" (EVM) / "G4G5Sz…xZbU" (Solana), like the pipeline's short addresses. */
export function shortAddress(address: string): string {
  const a = address.trim();
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** The pipeline cuts funder names at this many characters (lib/xray/redact.ts publicFunderName). */
const FUNDER_NAME_MAX = 24;

/**
 * A funder's name for display, or null when there is none worth printing: Nansen sometimes names an
 * unlabelled wallet after its own address ("0xe9c4f6"), which reads like a broken address, so those
 * fall back to the short address. Stray quotes of a cut label ('BAZINGA" HL Referral Cod') are dropped
 * and a name the pipeline cut ends in "…".
 */
export function funderName(label: string | null | undefined): string | null {
  if (!label) return null;
  let s = label.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^0x[0-9a-f]{2,}(…[0-9a-f]{2,})?$/i.test(s)) return null;
  if (/^[1-9A-HJ-NP-Za-km-z]{3,}…[1-9A-HJ-NP-Za-km-z]{3,}$/.test(s)) return null;
  if (label.length === FUNDER_NAME_MAX && !s.endsWith("…")) s = `${s.replace(/[\s·,.:;-]+$/, "")}…`;
  return s;
}

/** A funding source's name: an exchange / entity name, else the funder's short address. */
export function sourceName(c: Pick<SourceCluster, "kind" | "label" | "funder">): string {
  if (c.kind === "self") return "Self-funded";
  if (c.kind === "untraced") return "Untraced";
  const name = funderName(c.label);
  if (name && !/^Funder [A-Z]+$/.test(name)) return name;
  return c.funder ? shortAddress(c.funder) : c.label || "One wallet";
}

export interface BuyerFunding {
  /** Analysed buyers. */
  buyers: number;
  /** One per independent funding source (an exchange- or bridge-funded buyer is its own source). */
  independent: number;
  /** Traced buyers whose funder also funded another analysed buyer (beyond the first). */
  shared: number;
  untraced: number;
  /** Most analysed buyers one funding wallet paid for (1 = nobody funded two). */
  mostFromOneWallet: number;
}

/**
 * How the analysed buyers split by funding: `independent + shared + untraced = buyers`. Reads the
 * clusters when they are there (biggestSourceWallets is the largest source by VOLUME, which need not be
 * the wallet that funded the most buyers).
 */
export function buyerFunding(b: BuyersFinding): BuyerFunding {
  const buyers = Math.max(0, Math.round(b.topBuyers));
  const traced = Math.min(buyers, tracedBuyers(b));
  const independent = Math.max(0, Math.min(traced, Math.round(b.sources)));
  const groups = b.clusters.filter((c) => c.kind === "wallet").map((c) => c.wallets);
  const most = groups.length ? Math.max(...groups) : Math.max(1, Math.round(b.biggestSourceWallets || 1));
  return { buyers, independent, shared: traced - independent, untraced: buyers - traced, mostFromOneWallet: Math.max(1, most) };
}

/* ================= 01 · REAL BUYERS ================= */

function buyersTag(b: BuyersFinding | null | undefined): string {
  if (!b) return "";
  if (!isAvailable(b)) return "NO BUYER DATA";
  if (isTraced(b)) {
    const f = buyerFunding(b);
    return `${count(f.independent)}/${count(f.buyers)} INDEPENDENT`;
  }
  const t10 = top10Share(b);
  return `TOP ${count(b.topBuyers)} · ${pct0(t10 ?? b.topShare)}`;
}

/** "88 of the top 90 buyers were funded independently. 1 shared a funder with another buyer. 1 could not be traced." */
export function fundingSentence(b: BuyersFinding): string {
  const f = buyerFunding(b);
  const n = f.buyers;
  const parts = [
    f.independent >= n
      ? n === 1
        ? "The top buyer was funded independently."
        : `All ${count(n)} top buyers were funded independently.`
      : `${count(f.independent)} of the top ${count(n)} buyers ${f.independent === 1 ? "was" : "were"} funded independently.`,
  ];
  if (f.shared > 0) {
    parts.push(
      f.mostFromOneWallet >= 3
        ? `${count(f.shared)} shared a funder; one wallet funded ${count(f.mostFromOneWallet)} of them.`
        : `${count(f.shared)} shared a funder with another buyer.`,
    );
  }
  if (f.untraced > 0) parts.push(`${count(f.untraced)} could not be traced.`);
  return parts.join(" ");
}

/** Why finding 01 has no funders, in one short sentence (the pipeline's note says which case it is). */
export function untracedReason(b: Pick<BuyersFinding, "note">): string {
  const note = b.note ?? "";
  if (/not traced on this chain/i.test(note)) return "Funders are not traced on this chain.";
  if (/deep scan/i.test(note)) return "Funders are traced in the deep scan.";
  if (/unavailable/i.test(note)) return "Funder tracing was unavailable for this scan.";
  return "Funders were not traced.";
}

function buyersLine(b: BuyersFinding | null | undefined): string {
  if (!b) return PENDING;
  if (!isAvailable(b)) return b.note ? sentence(b.note) : "Buyer data was not available for this scan.";
  const n = b.topBuyers;
  const who = n === 1 ? "The top buyer" : `The top ${count(n)} buyers`;
  if (!isTraced(b)) {
    const top1 = clamp01(b.biggestSourceShare);
    const largest = n > 1 && top1 > 0 ? `, the largest alone ${pct0(top1)}` : "";
    return `${who} did ${pct0(b.topShare)} of this week's buying${largest}. ${untracedReason(b)}`;
  }
  if (b.sources <= 0) return `None of the top ${count(n)} buyers could be traced to a funder.`;
  return fundingSentence(b);
}

function buyersNote(b: BuyersFinding | null | undefined): string {
  if (!b) return "";
  if (!isAvailable(b) || !isTraced(b)) return b.note ? sentence(b.note) : "Funding sources were not traced.";
  // A capped who-bought-sold list holds only the week's largest buyers: the count is a floor.
  const parts = [
    b.totalBuyersCapped
      ? `At least ${count(b.totalBuyers)} wallets bought in ${b.windowDays} days; the top ${count(b.topBuyers)} did ${pct0(b.topShare)} of the listed buying.`
      : `${count(b.totalBuyers)} wallets bought in ${b.windowDays} days; the top ${count(b.topBuyers)} did ${pct0(b.topShare)} of the buying.`,
    `${pct0(b.untracedShare)} of them could not be traced.`,
    "A funder is the wallet that paid a buyer's first gas, not necessarily the source of its money.",
  ];
  if (b.note) parts.push(sentence(b.note));
  return parts.join(" ");
}

/* ================= 02 · FLOW ================= */

function flowTag(f: FlowFinding | null | undefined): string {
  if (!f) return "";
  if (!isAvailable(f)) return "NO FLOW DATA";
  // Below the "barely moved" line a rounded "0.0%" reads like missing data: say it is flat.
  if (finite(f.informedNetPctSupply)) {
    return Math.abs(f.informedNetPctSupply) < T.copy.quietFlow ? "PULSE FLAT" : `PULSE ${formatSignedPct(f.informedNetPctSupply)}`;
  }
  return `PULSE ${signedUsd(f.informedNetUsd)}`;
}

function flowLine(f: FlowFinding | null | undefined): string {
  if (!f) return PENDING;
  if (!isAvailable(f)) return "No labelled flow data for this token this week.";
  const parts: string[] = [];
  const usd = finite(f.informedNetUsd) ? f.informedNetUsd : 0;
  const barely = finite(f.informedNetPctSupply) ? Math.abs(f.informedNetPctSupply) < T.copy.quietFlow : Math.abs(usd) < 1_000;
  if (barely || usd === 0) parts.push("Smart money and whales barely moved this week.");
  else parts.push(`Smart money and whales ${usd < 0 ? "sold" : "bought"} ${formatUsdCompact(Math.abs(usd))} this week.`);
  if (finite(f.freshNetUsd) && f.freshNetUsd !== 0) {
    parts.push(`Fresh wallets ${f.freshNetUsd > 0 ? "bought" : "sold"} ${formatUsdCompact(Math.abs(f.freshNetUsd))}.`);
  }
  if (finite(f.exchangeNetPctSupply) && f.exchangeNetPctSupply >= T.flow.exchangeNoteShare) {
    parts.push(`${formatPct(f.exchangeNetPctSupply, 1)} of supply moved onto exchanges.`);
  }
  return parts.join(" ");
}

function flowNote(f: FlowFinding | null | undefined): string {
  if (!f) return "";
  const parts = ["Informed money = smart money, whales and public figures, aggregated and never shown per wallet."];
  if (f.status === "partial") parts.push("Some labelled cohorts returned no data.");
  if (f.lead) parts.push(sentence(f.lead.text));
  return parts.join(" ");
}

/* ================= 03 · SELL WALL ================= */

function wallsTag(w: WallsFinding | null | undefined): string {
  if (!w) return "";
  if (!isAvailable(w)) return "NO WALL DATA";
  const wall = primaryWall(w);
  return wall ? `SELL WALL ${formatSignedPct(wall.movePct)}` : "NO SELL WALL";
}

function wallsLine(w: WallsFinding | null | undefined): string {
  if (!w) return PENDING;
  if (!isAvailable(w)) return "Holders' entry prices were not available.";
  const parts: string[] = [];
  const wall = primaryWall(w);
  if (wall) {
    const at = `${priceShort(wall.price)} (${formatSignedPct(wall.movePct)})`;
    parts.push(
      w.method === "recent_buyers"
        ? `${formatAmount(wall.tokens)} tokens bought in the last 30 days break even at ${at}.`
        : `${formatAmount(wall.tokens)} tokens get back to break-even at ${at}.`,
    );
    // A wall can be heavy by its share of the analysed supply while small next to the pool: say which.
    const share = wallAnalysedShare(wall, w);
    const bySize =
      isHeavyWall(wall, w) && !(finite(wall.wallToLiquidity) && wall.wallToLiquidity >= T.ceiling.wallToLiquidity) && share !== null
        ? share
        : null;
    if (finite(wall.wallToLiquidity)) {
      parts.push(
        bySize !== null
          ? `That is ${formatMultiple(wall.wallToLiquidity)} the pool's liquidity and ${pct0(bySize)} of the analysed supply.`
          : `That is ${formatMultiple(wall.wallToLiquidity)} the pool's liquidity.`,
      );
    } else if (bySize !== null) {
      parts.push(`That is ${pct0(bySize)} of the analysed supply.`);
    }
  } else {
    parts.push("No sell wall sits above the price.");
  }
  if (w.underwaterShare >= T.ceiling.underwaterShare) parts.push(`${pct0(w.underwaterShare)} of the analysed supply is underwater.`);
  // Thin coverage is said out loud: the walls rest on the holders whose entry is known.
  if (w.status === "partial" || w.analyzedSupplyShare < T.insufficient.analysedSupply) parts.push(`Based on ${pct0(w.analyzedSupplyShare)} of supply.`);
  return parts.join(" ");
}

/** Where finding 03's entry prices come from, one sentence per method. */
export function wallsSource(w: Pick<WallsFinding, "method" | "holdersAnalyzed" | "costBasisHolders" | "recentBuyers">): string {
  if (w.method === "recent_buyers") return "Entry prices are this month's buyers' average prices (quick scan).";
  if (w.method === "hybrid") {
    const h = w.costBasisHolders ?? 0;
    const r = w.recentBuyers ?? 0;
    return `Entry prices from ${count(h)} ${plural(h, "holder's", "holders'")} on-chain cost basis and ${count(r)} recent ${plural(r, "buyer's", "buyers'")} average prices.`;
  }
  const n = w.costBasisHolders ?? w.holdersAnalyzed;
  return `Entry prices come from ${count(n)} ${plural(n, "holder's", "holders'")} profit-and-loss records.`;
}

/**
 * "85% of total supply is left out: tokens received, not bought on a DEX (team, vesting, airdrops or
 * exchange withdrawals), or held outside the circulating supply." or "". allocatedShare is a share of
 * TOTAL supply; it mixes pnl answers with no recorded buy (bought_usd 0 over the token's whole
 * history) and wallets skipped without a pnl call (a balance above the circulating supply, or a
 * team / vesting / treasury / lock label), so the sentence claims neither "team" nor "never bought"
 * for all of it.
 */
export function allocationNote(w: Pick<WallsFinding, "allocatedShare">): string {
  const a = w.allocatedShare;
  if (!finite(a) || a <= 0) return "";
  const share = a < 0.01 ? formatPct(a, 1) : pct0(a);
  return `${share} of total supply is left out: tokens received, not bought on a DEX (team, vesting, airdrops or exchange withdrawals), or held outside the circulating supply.`;
}

function wallsNote(w: WallsFinding | null | undefined): string {
  if (!w) return "";
  const alloc = allocationNote(w);
  if (!isAvailable(w)) return alloc ? `Holders' entry prices were not available. ${alloc}` : "Holders' entry prices were not available.";
  const parts = [wallsSource(w), `They cover ${pct0(w.analyzedSupplyShare)} of supply; ${pct0(w.underwaterShare)} of it is underwater.`];
  if (alloc) parts.push(alloc);
  return parts.join(" ");
}

/* ================= 04 · SMART MONEY ================= */

function smartTag(s: SmartFinding | null | undefined): string {
  if (!s) return "";
  if (!isAvailable(s)) return "NO SM DATA";
  if (tooFewSmartWallets(s)) return "SM: TOO FEW";
  if (!hasSmartData(s)) return "NO SMART MONEY";
  return `SM ENTRY ${priceShort(s.avgEntry)}`;
}

function stancePhrase(s: SmartFinding, pnl: number | null): string {
  switch (s.stance) {
    case "adding":
      return "still adding";
    case "holding":
      return "holding";
    case "trimming":
      return pnl !== null && pnl > 0 ? "trimming into strength" : "trimming";
    case "exiting":
      return pnl !== null && pnl < 0 ? "exiting at a loss" : "heading for the exit";
  }
}

function smartLine(s: SmartFinding | null | undefined): string {
  if (!s) return PENDING;
  if (!isAvailable(s)) return "Smart money data was not available.";
  if (tooFewSmartWallets(s)) {
    return `Only ${count(s.wallets)} smart-money ${plural(s.wallets, "wallet", "wallets")} traded it in ${s.windowDays} days, too few to show as an aggregate.`;
  }
  if (!hasSmartData(s)) return `No smart money traded this token in the last ${s.windowDays} days.`;
  const entry = `Average entry ${priceShort(s.avgEntry)}.`;
  const pnl = finite(s.pnlPct) ? s.pnlPct : null;
  const stance = stancePhrase(s, pnl);
  if (pnl === null) return `${entry} ${stance[0].toUpperCase()}${stance.slice(1)}.`;
  return `${entry} Now ${formatSignedPct(pnl)} and ${stance}.`;
}

function smartNote(s: SmartFinding | null | undefined): string {
  if (!s) return "";
  if (!hasSmartData(s)) {
    return `Smart money is read over ${s.windowDays} days and shown only as an aggregate of at least ${T.smart.minWallets} wallets.`;
  }
  return `Aggregated over ${s.windowDays} days across ${count(s.wallets)} smart-money ${plural(s.wallets, "wallet", "wallets")}; never shown per wallet.`;
}

/* ================= 05 · YOU ================= */

/** Finding 5. Null (no wallet pasted yet) returns the prompt. */
export function youLine(w: WalletCheck | null | undefined): string {
  if (!w) return "Paste your wallet to see where you stand.";
  if (!isAvailable(w)) return `No position in this token found for ${w.short}.`;
  if (!finite(w.cost) || w.cost <= 0) {
    return finite(w.holdingTokens) && w.holdingTokens > 0
      ? `No DEX entry found for ${w.short}. It holds ${formatAmount(w.holdingTokens)} tokens.`
      : `No position in this token found for ${w.short}.`;
  }
  const parts: string[] = [];
  if (finite(w.vsSmartMoneyPct)) {
    const v = w.vsSmartMoneyPct;
    parts.push(Math.abs(v) < 0.005 ? "Your entry matches smart money's." : `Your entry is ${pct0(Math.abs(v))} ${v > 0 ? "above" : "below"} smart money.`);
  } else if (finite(w.pnlPct)) {
    parts.push(`Your entry is ${priceShort(w.cost)}, now ${formatSignedPct(w.pnlPct)}.`);
  } else {
    parts.push(`Your entry is ${priceShort(w.cost)}.`);
  }
  if (finite(w.cheaperShare)) parts.push(`${pct0(w.cheaperShare)} of the analysed supply was bought cheaper.`);
  return parts.join(" ");
}

function youNote(w: WalletCheck | null | undefined): string {
  return w ? "Checked on demand with 1-3 Nansen API calls." : "";
}

/* ================= dispatch ================= */

/** Film marker tag ("23 SOURCES", "PULSE −3.1%", "SELL WALL +22%", "SM ENTRY $0.030", "YOU"). "" while pending. */
export function tagFor(n: 1, f: BuyersFinding | null | undefined): string;
export function tagFor(n: 2, f: FlowFinding | null | undefined): string;
export function tagFor(n: 3, f: WallsFinding | null | undefined): string;
export function tagFor(n: 4, f: SmartFinding | null | undefined): string;
export function tagFor(n: 5, f: WalletCheck | null | undefined): string;
export function tagFor(n: FindingNo, f: AnyFinding | null | undefined): string;
export function tagFor(n: FindingNo, f: AnyFinding | null | undefined): string {
  switch (n) {
    case 1:
      return buyersTag(f as BuyersFinding | null | undefined);
    case 2:
      return flowTag(f as FlowFinding | null | undefined);
    case 3:
      return wallsTag(f as WallsFinding | null | undefined);
    case 4:
      return smartTag(f as SmartFinding | null | undefined);
    case 5:
      return "YOU";
  }
}

/** The report's plain-English line for a finding (the text after "1. REAL BUYERS: "). */
export function lineFor(n: 1, f: BuyersFinding | null | undefined): string;
export function lineFor(n: 2, f: FlowFinding | null | undefined): string;
export function lineFor(n: 3, f: WallsFinding | null | undefined): string;
export function lineFor(n: 4, f: SmartFinding | null | undefined): string;
export function lineFor(n: 5, f: WalletCheck | null | undefined): string;
export function lineFor(n: FindingNo, f: AnyFinding | null | undefined): string;
export function lineFor(n: FindingNo, f: AnyFinding | null | undefined): string {
  switch (n) {
    case 1:
      return buyersLine(f as BuyersFinding | null | undefined);
    case 2:
      return flowLine(f as FlowFinding | null | undefined);
    case 3:
      return wallsLine(f as WallsFinding | null | undefined);
    case 4:
      return smartLine(f as SmartFinding | null | undefined);
    case 5:
      return youLine(f as WalletCheck | null | undefined);
  }
}

/** Caveats for the lab-results drawer (coverage, method, aggregation). "" while pending. */
export function noteFor(n: FindingNo, f: AnyFinding | null | undefined): string {
  switch (n) {
    case 1:
      return buyersNote(f as BuyersFinding | null | undefined);
    case 2:
      return flowNote(f as FlowFinding | null | undefined);
    case 3:
      return wallsNote(f as WallsFinding | null | undefined);
    case 4:
      return smartNote(f as SmartFinding | null | undefined);
    case 5:
      return youNote(f as WalletCheck | null | undefined);
  }
}

/** Picks finding n out of a (possibly partial) scan. */
export function findingAt(n: FindingNo, findings: Partial<Findings> | null | undefined, you?: WalletCheck | null): AnyFinding | null {
  if (n === 5) return you ?? null;
  return (findings?.[FINDING_KEYS[n]] as AnyFinding | undefined) ?? null;
}

export interface ReportLine {
  n: FindingNo;
  key: (typeof FINDING_KEYS)[FindingNo];
  /** "REAL BUYERS" */
  title: string;
  /** Film tag, "" while pending. */
  tag: string;
  text: string;
}

/** The five FINDINGS lines, ready to type: `${n}. ` + `${title}: ` + text. */
export function reportLines(findings: Partial<Findings> | null | undefined, you?: WalletCheck | null): ReportLine[] {
  return ([1, 2, 3, 4, 5] as const).map((n) => {
    const f = findingAt(n, findings, you);
    return { n, key: FINDING_KEYS[n], title: FINDING_TITLES[n], tag: tagFor(n, f), text: lineFor(n, f) };
  });
}

/* ================= impression, stamp, form ================= */

const SUPERSCRIPT: Record<FindingNo, string> = { 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵" };

/** "¹ ² ⁴" for the impression's footnotes. */
export function footnoteMarks(d: Pick<Diagnosis, "footnotes">): string {
  return d.footnotes.map((k) => SUPERSCRIPT[findingNo(k) ?? 1]).join(" ");
}

/** "Confidence: HIGH" */
export function confidenceLine(d: Pick<Diagnosis, "confidence">): string {
  return `Confidence: ${d.confidence.toUpperCase()}`;
}

/** Rubber stamp: ["Reviewed", "Confidence high"] (the stamp's CSS uppercases it). */
export function stampLines(d: Pick<Diagnosis, "confidence">): [string, string] {
  return ["Reviewed", `Confidence ${d.confidence}`];
}

/** "$KAIRO": exactly one leading "$", whatever the symbol arrived as. */
export function patientName(meta: Pick<ScanMeta, "symbol" | "name">): string {
  const s = (meta.symbol || "").replace(/^\$+/, "").trim().toUpperCase();
  return s ? `$${s}` : (meta.name || "UNKNOWN").toUpperCase();
}

const CHAIN_LABELS: Record<string, string> = { bnb: "BNB CHAIN", avalanche: "AVALANCHE C-CHAIN" };

/** "BASE", "ETHEREUM", "BNB CHAIN". */
export function chainLabel(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain.toUpperCase();
}

/** 412 -> "0412" */
export function scanNoLabel(scanNo: number): string {
  return finite(scanNo) ? String(Math.max(0, Math.round(scanNo))).padStart(4, "0") : EMPTY_CELL;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "26 SEP 2026 14:02" (UTC, locale-independent). Pass withTime=false for "26 SEP 2026". */
export function reportDate(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY_CELL;
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime ? `${day} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : day;
}

/** Form field "Exam". */
export function examLabel(tier: Tier): string {
  return tier === "quick" ? "7-DAY RADIOGRAPH · QUICK" : "7-DAY RADIOGRAPH";
}

/** Film name plate, second line: "SCAN 0412 · 26 SEP 2026 · 7-DAY". */
export function plateLine(meta: Pick<ScanMeta, "scanNo" | "scannedAt">): string {
  return `SCAN ${scanNoLabel(meta.scanNo)} · ${reportDate(meta.scannedAt, false)} · 7-DAY`;
}

/** "248 Nansen API calls · 271 credits" */
export function evidenceLine(totals: Pick<Scan["totals"], "calls" | "credits">): string {
  return `${count(totals.calls)} Nansen API ${plural(totals.calls, "call", "calls")} · ${count(totals.credits)} ${plural(totals.credits, "credit", "credits")}`;
}

/* ================= replay / live stage messages ================= */

export type StageKey = FindingKey | "diagnosis" | "done";

export function stageMessage(stage: StageKey, scan?: Pick<Scan, "meta" | "findings" | "totals"> | null): string {
  switch (stage) {
    case "context":
      return scan?.meta ? `Positioning ${patientName(scan.meta)}: price, holders, liquidity` : "Positioning the patient: price, holders, liquidity";
    case "buyers":
      return scan?.findings?.buyers && !isTraced(scan.findings.buyers) ? "Reading this week's top buyers" : "Tracing who funded the top buyers";
    case "flow":
      return "Reading informed-money flows";
    case "walls":
      return scan?.findings?.walls?.method === "recent_buyers" ? "Reading recent buyers' entry prices" : "Reading holders' entry prices";
    case "smart":
      return "Reading smart money's average entry";
    case "you":
      return "Checking your wallet";
    case "diagnosis":
      return "Writing the impression";
    case "done":
      return scan?.totals ? `Exposure complete · ${evidenceLine(scan.totals)}` : "Exposure complete";
  }
}
