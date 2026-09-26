// Diagnosis rules: turns the four findings into one plain sentence. Pure, deterministic, tested.
// Thresholds live in ./thresholds.ts and are documented in the README.
//
// diagnose() reads each finding's own classification (buyers.demand, flow.verdict, walls.ceiling,
// smart.state) as the pipeline computed it from the same thresholds, so the three lights always agree
// with the findings on screen. The classifiers below (demandOf, flowVerdictOf, ceilingOf, ...) restate
// plan §5 for the synthetic fixture, tests and the UI; the pipeline has equivalent copies in
// lib/xray/pipeline/*.ts that read the same T.
import type {
  BuyersFinding,
  Diagnosis,
  DiagnosisCode,
  FindingStatus,
  FlowFinding,
  Light,
  Scan,
  ScanMeta,
  SmartFinding,
  Wall,
  WallsFinding,
} from "./types";
import { T } from "./thresholds";

type Findings = Scan["findings"];
export type EvidenceKey = Diagnosis["footnotes"][number];

/** Report / film order of the four findings (1..4). */
export const FINDING_ORDER: readonly EvidenceKey[] = ["buyers", "flow", "walls", "smart"];

/** Rules in the order they are tried; the index is Diagnosis.rule. */
export const DIAGNOSIS_RULES: readonly { code: DiagnosisCode; sentence: string }[] = [
  { code: "insufficient", sentence: "Too few labelled wallets to read this token." },
  { code: "concentrated", sentence: "Most of this week's buying traces back to a handful of wallets." },
  { code: "distribution", sentence: "Smart money is selling to the crowd." },
  { code: "capitulation", sentence: "Holders are giving up." },
  { code: "overhead", sentence: "Sellers are waiting just above the price." },
  { code: "accumulation", sentence: "Smart money is quietly buying." },
  { code: "normal", sentence: "Nothing unusual under the surface." },
];

export const SENTENCES: Record<DiagnosisCode, string> = Object.fromEntries(
  DIAGNOSIS_RULES.map((r) => [r.code, r.sentence]),
) as Record<DiagnosisCode, string>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number) => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** A finding that exists and was not marked unavailable. */
export function isAvailable(f: { status: FindingStatus } | null | undefined): boolean {
  return !!f && f.status !== "unavailable";
}

/* ---------------- 01 · demand ---------------- */

/** Funder tracing ran (EVM deep scan). Without it the finding falls back to buy-volume concentration. */
export function isTraced(b: BuyersFinding): boolean {
  return b.sources > 0 || b.clusters.length > 0;
}

/** Analysed buyers whose funder was found (untracedShare is a share of analysed wallets). */
export function tracedBuyers(b: BuyersFinding): number {
  return Math.max(0, Math.round(b.topBuyers * (1 - clamp01(b.untracedShare))));
}

/** Top-10 buyers' share of the week's buy volume, when the finding carries it (untraced fallback). */
export function top10Share(b: BuyersFinding): number | null {
  if (isTraced(b) || !(b.topBuyers > 0) || b.topBuyers > 10 || !finite(b.topShare)) return null;
  return clamp01(b.topShare);
}

export function demandOf(b: BuyersFinding): BuyersFinding["demand"] {
  if (!isAvailable(b)) return "mixed";
  const d = T.demand;
  if (!isTraced(b)) {
    const top10 = top10Share(b);
    if (top10 === null) return "mixed";
    if (top10 >= d.top10Concentrated) return "concentrated";
    if (top10 < d.top10Organic) return "organic";
    return "mixed";
  }
  const traced = tracedBuyers(b);
  const ratio = traced > 0 ? b.sources / traced : 1;
  const biggest = clamp01(b.biggestSourceShare);
  if (biggest >= d.concentratedSourceShare || ratio < d.concentratedRatio) return "concentrated";
  if (ratio >= d.organicRatio && biggest < d.organicMaxSourceShare) return "organic";
  return "mixed";
}

/* ---------------- 02 · flow ---------------- */

/** Informed 7d net flow as a share of market cap, else of circulating supply; null when neither is known. */
export function informedMove(f: FlowFinding, marketCapUsd?: number | null): number | null {
  if (finite(marketCapUsd) && marketCapUsd > 0 && finite(f.informedNetUsd)) return f.informedNetUsd / marketCapUsd;
  return finite(f.informedNetPctSupply) ? f.informedNetPctSupply : null;
}

export function flowVerdictOf(f: FlowFinding, meta?: Pick<ScanMeta, "marketCapUsd"> | null): FlowFinding["verdict"] {
  if (!isAvailable(f)) return "quiet";
  const move = informedMove(f, meta?.marketCapUsd);
  if (move === null) return "quiet";
  if (move <= -T.flow.moveShare) return finite(f.freshNetUsd) && f.freshNetUsd > 0 ? "distributing" : "quiet";
  if (move >= T.flow.moveShare) return "accumulating";
  return "quiet";
}

/** Any labelled cohort (informed or exchange) moved this week. */
export function hasLabelledFlow(f: FlowFinding | null | undefined): boolean {
  if (!f || !isAvailable(f)) return false;
  if (finite(f.informedNetUsd) && f.informedNetUsd !== 0) return true;
  if (f.series.some((s) => s.points.some((p) => p.netUsd !== 0 || p.cumPctSupply !== 0))) return true;
  return f.daily.some((d) => d.informedUsd !== 0 || d.exchangeUsd !== 0);
}

/* ---------------- 03 · ceiling ---------------- */

/**
 * A wall's tokens as a share of the analysed supply. Wall.supplyShare is a share of circulating supply
 * (as in lib/metrics findReefs), so without the circulating supply it is divided by analyzedSupplyShare.
 */
export function wallAnalysedShare(wall: Wall, w: WallsFinding, circulatingSupply?: number | null): number | null {
  if (finite(circulatingSupply) && circulatingSupply > 0 && w.analyzedSupplyShare > 0) {
    return wall.tokens / (w.analyzedSupplyShare * circulatingSupply);
  }
  if (w.analyzedSupplyShare > 0 && finite(wall.supplyShare)) return wall.supplyShare / w.analyzedSupplyShare;
  return null;
}

/** Within +30% of the price and either >= 1.5x pool liquidity or >= 8% of the analysed supply. */
export function isHeavyWall(wall: Wall, w: WallsFinding, circulatingSupply?: number | null): boolean {
  const c = T.ceiling;
  if (!finite(wall.movePct) || wall.movePct < 0 || wall.movePct > c.nearMovePct) return false;
  if (finite(wall.wallToLiquidity) && wall.wallToLiquidity >= c.wallToLiquidity) return true;
  const share = wallAnalysedShare(wall, w, circulatingSupply);
  return share !== null && share >= c.wallShareOfAnalysed;
}

/**
 * The wall the report and the film talk about: the biggest heavy wall within +30%, else the biggest
 * wall within +30%, else the nearest wall above the price; null when nothing sits above the price.
 */
export function primaryWall(w: WallsFinding | null | undefined, circulatingSupply?: number | null): Wall | null {
  if (!w || !isAvailable(w)) return null;
  const above = w.walls.filter((x) => finite(x.movePct) && x.movePct > 0 && finite(x.price) && x.tokens > 0);
  if (!above.length) return null;
  const biggest = (xs: Wall[]) => xs.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  const heavy = above.filter((x) => isHeavyWall(x, w, circulatingSupply));
  if (heavy.length) return biggest(heavy);
  const near = above.filter((x) => x.movePct <= T.ceiling.nearMovePct);
  if (near.length) return biggest(near);
  return above.reduce((a, b) => (b.movePct < a.movePct ? b : a));
}

export function ceilingOf(w: WallsFinding, circulatingSupply?: number | null): WallsFinding["ceiling"] {
  if (!isAvailable(w)) return "light";
  if (w.underwaterShare >= T.ceiling.underwaterShare) return "heavy";
  return w.walls.some((x) => isHeavyWall(x, w, circulatingSupply)) ? "heavy" : "light";
}

/* ---------------- 04 · smart money ---------------- */

export function smartStateOf(avgEntry: number | null | undefined, priceNow: number | null | undefined): SmartFinding["state"] {
  if (!finite(avgEntry) || avgEntry <= 0 || !finite(priceNow) || priceNow <= 0) return "unknown";
  const m = priceNow / avgEntry;
  if (m >= T.smart.profitMultiple) return "profit";
  if (m < T.smart.lossMultiple) return "loss";
  return "breakeven";
}

export function smartStanceOf(boughtUsd: number, soldUsd: number): SmartFinding["stance"] {
  const gross = (finite(boughtUsd) ? boughtUsd : 0) + (finite(soldUsd) ? soldUsd : 0);
  if (!(gross > 0)) return "holding";
  const r = ((finite(boughtUsd) ? boughtUsd : 0) - (finite(soldUsd) ? soldUsd : 0)) / gross;
  if (r <= T.smart.exitingRatio) return "exiting";
  if (r <= T.smart.trimmingRatio) return "trimming";
  if (r >= T.smart.addingRatio) return "adding";
  return "holding";
}

/** Smart money was actually seen: an average entry aggregated over at least T.smart.minWallets wallets. */
export function hasSmartData(s: SmartFinding | null | undefined): boolean {
  return !!s && isAvailable(s) && finite(s.avgEntry) && s.avgEntry > 0 && s.wallets >= T.smart.minWallets;
}

/** Some smart money traded, but too few wallets to publish an aggregate. */
export function tooFewSmartWallets(s: SmartFinding | null | undefined): boolean {
  return !!s && isAvailable(s) && s.wallets > 0 && s.wallets < T.smart.minWallets;
}

/* ---------------- coverage, confidence, lights ---------------- */

/**
 * How much of what a finding looks at was actually resolved, 0..1:
 *   buyers: share of buy volume analysed x share of analysed buyers traced (volume share alone when untraced)
 *   flow:   1, or 0.5 when only some labelled cohorts answered
 *   walls:  share of circulating supply with a cost basis
 *   smart:  smart wallets / 10, capped at 1 (0 without an average entry)
 */
export function coverageOf(key: EvidenceKey, findings: Partial<Findings>): number {
  switch (key) {
    case "buyers": {
      const b = findings.buyers;
      if (!b || !isAvailable(b)) return 0;
      return isTraced(b) ? clamp01(b.topShare * (1 - clamp01(b.untracedShare))) : clamp01(b.topShare);
    }
    case "flow": {
      const f = findings.flow;
      if (!f || !isAvailable(f)) return 0;
      return f.status === "partial" ? T.confidence.flowPartial : 1;
    }
    case "walls": {
      const w = findings.walls;
      return w && isAvailable(w) ? clamp01(w.analyzedSupplyShare) : 0;
    }
    case "smart": {
      const s = findings.smart;
      return hasSmartData(s) ? clamp01(s!.wallets / T.confidence.smartFullWallets) : 0;
    }
  }
}

export function confidenceOf(coverage: number): Diagnosis["confidence"] {
  if (coverage >= T.confidence.high) return "high";
  if (coverage >= T.confidence.medium) return "medium";
  return "low";
}

/** Flow · Crowd · Ceiling. Amber whenever a finding is unavailable. */
export function lightsOf(findings: Partial<Findings>): Diagnosis["lights"] {
  const { buyers, flow, walls } = findings;
  const flowLight: Light =
    !flow || !isAvailable(flow) ? "amber" : flow.verdict === "distributing" ? "red" : flow.verdict === "accumulating" ? "green" : "amber";
  const crowd: Light =
    !buyers || !isAvailable(buyers) ? "amber" : buyers.demand === "concentrated" ? "red" : buyers.demand === "organic" ? "green" : "amber";
  const ceiling: Light = !walls || !isAvailable(walls) ? "amber" : walls.ceiling === "heavy" ? "red" : "green";
  return { flow: flowLight, crowd, ceiling };
}

/* ---------------- the diagnosis ---------------- */

export function diagnose(findings: Scan["findings"], meta: ScanMeta): Diagnosis {
  const { buyers, flow, walls, smart } = findings;
  const has = {
    buyers: isAvailable(buyers),
    flow: isAvailable(flow),
    walls: isAvailable(walls),
    smart: hasSmartData(smart),
  };

  const concentrated = has.buyers && buyers.demand === "concentrated";
  const distributing = has.flow && flow.verdict === "distributing";
  const accumulating = has.flow && flow.verdict === "accumulating";
  const heavy = has.walls && walls.ceiling === "heavy";
  const underwater = has.walls && walls.underwaterShare >= T.ceiling.underwaterShare;
  const smartLoss = has.smart && smart.state === "loss";
  const priceFell = finite(meta?.priceChange7d) && meta.priceChange7d < T.price.fellBelow;
  // Rule 3's case: informed money sold into a falling price while holders sit at a loss.
  const capitulating = distributing && priceFell && (smartLoss || underwater);

  const analysedSupply = has.walls ? walls.analyzedSupplyShare : 0;
  const buyersRead = has.buyers ? buyers.topBuyers : 0;

  // `used`: every finding the rule rests on (confidence = the weakest of them).
  let rule: number;
  let used: EvidenceKey[];
  const optional = (...keys: EvidenceKey[]) => keys.filter((k) => has[k]);

  if (analysedSupply < T.insufficient.analysedSupply && buyersRead < T.insufficient.buyers && !hasLabelledFlow(flow)) {
    rule = 0;
    used = ["buyers", "flow", "walls"];
  } else if (concentrated) {
    rule = 1;
    used = ["buyers"];
  } else if (distributing && !capitulating) {
    // "the crowd" = this week's buyers, "selling" = informed flow, "smart money" = the smart-money entry.
    // A falling price alone does not change that: informed money still sold while fresh wallets bought
    // (a red flow light must never end in "Nothing unusual"); only rule 3's case reads differently.
    rule = 2;
    used = ["flow", ...optional("buyers", "smart")];
  } else if (capitulating) {
    rule = 3;
    used = ["flow", ...(smartLoss ? (["smart"] as EvidenceKey[]) : []), ...(underwater ? (["walls"] as EvidenceKey[]) : [])];
  } else if (heavy) {
    rule = 4;
    used = ["walls"];
  } else if (accumulating && !concentrated) {
    rule = 5;
    used = ["flow", ...optional("buyers", "smart")];
  } else {
    rule = 6;
    // "Nothing unusual" claims we looked: a missing buyers / flow / walls finding counts as 0 coverage.
    used = ["buyers", "flow", "walls", ...optional("smart")];
  }

  const ordered = FINDING_ORDER.filter((k) => used.includes(k));
  const coverage = Math.min(...ordered.map((k) => coverageOf(k, findings)));
  // Rule 0 points at all three gaps; otherwise only at findings that have evidence to show.
  const footnotes = rule === 0 ? ordered : ordered.filter((k) => (k === "smart" ? has.smart : has[k]));

  const { code, sentence } = DIAGNOSIS_RULES[rule];
  return {
    code,
    rule,
    sentence,
    confidence: confidenceOf(coverage),
    lights: lightsOf(findings),
    footnotes,
  };
}
