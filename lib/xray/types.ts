// EXPOSURE shared contract: the scan pipeline (server), the diagnosis rules, the film, the typed
// report and the lab-results drawer all speak these shapes. Changing one is a breaking change.

export type Tier = "quick" | "deep";

/** Which part of the scan a call / event belongs to. */
export type FindingKey = "context" | "buyers" | "flow" | "walls" | "smart" | "you";

export type FindingStatus = "ok" | "partial" | "unavailable";

export interface ScanMeta {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  logo?: string;
  /** Last 1h close (P0). */
  priceNow: number;
  /** Price change over the 7-day film, e.g. 0.184 = +18.4%. */
  priceChange7d: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  circulatingSupply: number | null;
  holders: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  volume24hUsd: number | null;
  deployedAt: string | null;
  /** ISO time the scan finished. */
  scannedAt: string;
  /** Monotonic per-server scan counter shown as "SCAN 0412". */
  scanNo: number;
  /** The 7-day window of the film (ISO). */
  window: { from: string; to: string };
}

export interface PricePoint {
  /** unix ms */
  t: number;
  c: number;
}

/** A large buy drawn as a dot on the film (no wallet identity, no labels). */
export interface BigBuy {
  t: number;
  price: number;
  usd: number;
}

/* ---------- 01 · How many real buyers? ---------- */

/**
 * One buyer of the week (tgm/who-bought-sold) with its first funder (profiler first-funder). Published
 * with attribution; never carries a wallet label (a buyer can be a smart-money wallet, and smart money
 * is only ever shown in aggregate). See lib/xray/redact.ts.
 */
export interface BuyerRow {
  address: string;
  /** "0x12ab…9f3c" */
  short: string;
  boughtUsd: number;
  boughtTokens: number;
  /** Funder address when traced (EVM only). */
  funder?: string;
  /** Nansen entity name of the funder when it has one, e.g. "Binance" (never a smart-money label). */
  funderLabel?: string;
  /** https://app.nansen.ai/profiler?address=…&chain=… */
  nansenUrl: string;
}

export type SourceKind = "wallet" | "exchange" | "bridge" | "self" | "untraced";

export interface SourceCluster {
  id: string;
  kind: SourceKind;
  /** "Binance", the funder's Nansen entity name, else its short address "0x7a3e…c91e"; "Untraced", "Self-funded". */
  label: string;
  /** Wallet clusters: full address of the funder that funded most members (links to Nansen). */
  funder?: string;
  wallets: number;
  boughtUsd: number;
  /** Share of the analysed buyers' buy volume, 0..1. */
  share: number;
  members: BuyerRow[];
}

export interface BuyersFinding {
  status: FindingStatus;
  windowDays: number;
  /**
   * Wallets that bought in the window: the who-bought-sold count, or (when that list was capped by
   * pagination) the larger of the listed count and token-information's 24h unique buyers.
   */
  totalBuyers: number;
  /** totalBuyers is a lower bound: who-bought-sold returned a full page (its largest buyers only). */
  totalBuyersCapped?: boolean;
  /** Buyers analysed (traced), e.g. 80. */
  topBuyers: number;
  /** Share of all buy volume done by the analysed buyers, 0..1. */
  topShare: number;
  /** Independent funding sources behind the analysed buyers (exchanges count as independent). */
  sources: number;
  untracedShare: number;
  /** Largest non-exchange source's share of analysed buy volume, 0..1. */
  biggestSourceShare: number;
  /** Buyers funded by the largest non-exchange source. */
  biggestSourceWallets: number;
  clusters: SourceCluster[];
  demand: "organic" | "mixed" | "concentrated";
  /** Set when funder tracing was skipped (Solana, quick tier): the finding falls back to concentration. */
  note?: string;
  /** Without funder tracing (clusters is empty): the week's largest buyers, largest first (up to 10). */
  largestBuyers?: BuyerRow[];
}

/* ---------- 02 · Who is selling to whom? ---------- */

/** "informed" = smart money + whales + public figures, aggregated (never shown per wallet). */
export type FlowCohort = "informed" | "fresh" | "exchange";

export interface FlowPoint {
  t: number;
  /** Cumulative net flow since the window start, as % of circulating supply (0.031 = 3.1%). */
  cumPctSupply: number;
  netUsd: number;
}

export interface FlowDay {
  /** "2026-09-21" */
  day: string;
  informedUsd: number;
  freshUsd: number | null;
  exchangeUsd: number;
}

export interface FlowFinding {
  status: FindingStatus;
  informedNetUsd: number;
  informedNetPctSupply: number | null;
  freshNetUsd: number | null;
  exchangeNetPctSupply: number | null;
  series: { cohort: FlowCohort; points: FlowPoint[] }[];
  daily: FlowDay[];
  verdict: "distributing" | "accumulating" | "quiet";
  /** Optional observation, e.g. informed money turned before the local top. */
  lead?: { t: number; text: string };
}

/* ---------- 03 · Where are sellers waiting? ---------- */

export interface Wall {
  price: number;
  movePct: number;
  tokens: number;
  supplyShare: number;
  wallToLiquidity: number | null;
  /** Share of this wall held by wallets that already sold part of their peak balance, 0..1. */
  alreadyTrimming: number;
  holders: number;
}

export interface LadderBin {
  lo: number;
  hi: number;
  tokens: number;
  supplyShare: number;
}

export interface WallsFinding {
  status: FindingStatus;
  /**
   * cost_basis = per-holder profiler pnl; recent_buyers = volume-weighted 30d buyer prices (quick tier);
   * hybrid = pnl cost basis covered < 50% of the analysed holders' tokens, so 30d buyers not costed by
   * pnl were blended in at their volume-weighted buy price.
   */
  method: "cost_basis" | "recent_buyers" | "hybrid";
  /** Holders with a profiler pnl answer (deep), plus the blended 30d buyers (hybrid); quick: 30d buyers still holding. */
  holdersAnalyzed: number;
  analyzedSupplyShare: number;
  /** Share of analysed supply with cost above today's price, 0..1. */
  underwaterShare: number;
  walls: Wall[];
  /** Supply by entry price for the film's side ladder. */
  ladder: LadderBin[];
  ceiling: "heavy" | "light";
  /** Deep: holders whose entry price is their own on-chain cost basis (profiler pnl). */
  costBasisHolders?: number;
  /** Hybrid: 30-day buyers priced at their volume-weighted buy price (not covered by pnl). */
  recentBuyers?: number;
  /**
   * Deep: share of TOTAL supply (tgm/holders ownership) held by holders read as allocations (team,
   * vesting, treasury: received by transfer, never bought; or more than the whole circulating
   * supply). They are excluded from walls, the ladder and every share above.
   */
  allocatedShare?: number;
}

/* ---------- 04 · Is smart money in profit? ---------- */

export interface SmartFinding {
  status: FindingStatus;
  /** Always >= 30: smart-money data is only shown aggregated and over >= 7 days (Nansen redistribution rules). */
  windowDays: number;
  avgEntry: number | null;
  pnlPct: number | null;
  wallets: number;
  boughtUsd: number;
  soldUsd: number;
  netUsd: number;
  stance: "adding" | "holding" | "trimming" | "exiting";
  state: "profit" | "breakeven" | "loss" | "unknown";
}

/* ---------- 05 · And you? (on demand, 1-3 credits) ---------- */

export interface WalletCheck {
  status: FindingStatus;
  address: string;
  short: string;
  cost: number | null;
  pnlPct: number | null;
  /** (cost / smart money avg entry) - 1 */
  vsSmartMoneyPct: number | null;
  /** Share of analysed supply that got in cheaper than this wallet, 0..1. */
  cheaperShare: number | null;
  holdingTokens: number | null;
}

/* ---------- Diagnosis ---------- */

export type DiagnosisCode = "insufficient" | "concentrated" | "distribution" | "capitulation" | "overhead" | "accumulation" | "normal";
export type Light = "red" | "amber" | "green";

export interface Diagnosis {
  code: DiagnosisCode;
  /** 0-based index of the rule that fired (rules are tried top to bottom). */
  rule: number;
  sentence: string;
  confidence: "high" | "medium" | "low";
  lights: { flow: Light; crowd: Light; ceiling: Light };
  /** Findings the sentence rests on (drawn as footnote markers ¹²³⁴). */
  footnotes: Exclude<FindingKey, "context" | "you">[];
}

/* ---------- Evidence ---------- */

export interface CallRecord {
  endpoint: string;
  status: number;
  credits: number;
  ms: number;
  cached: boolean;
  /** ms since the scan started (re-timed in replays). */
  at: number;
  finding: FindingKey;
}

export interface Scan {
  version: 1;
  tier: Tier;
  meta: ScanMeta;
  /** 7 days of hourly closes, oldest first. */
  price: PricePoint[];
  bigBuys: BigBuy[];
  findings: { buyers: BuyersFinding; flow: FlowFinding; walls: WallsFinding; smart: SmartFinding };
  diagnosis: Diagnosis;
  calls: CallRecord[];
  totals: { calls: number; networkCalls: number; credits: number; cacheHits: number; durationMs: number };
  /** true only for the synthetic dev fixture: the UI must show "synthetic data". */
  synthetic?: boolean;
}

/** Streamed by GET /api/scan/[chain]/[token]?tier=quick|deep and re-emitted by the replay player. */
export type ScanEvent =
  | { type: "stage"; stage: FindingKey | "diagnosis" | "done"; message: string }
  | { type: "call"; call: CallRecord }
  | { type: "meta"; meta: ScanMeta; price: PricePoint[]; bigBuys: BigBuy[] }
  | { type: "finding"; key: "buyers"; finding: BuyersFinding }
  | { type: "finding"; key: "flow"; finding: FlowFinding }
  | { type: "finding"; key: "walls"; finding: WallsFinding }
  | { type: "finding"; key: "smart"; finding: SmartFinding }
  | { type: "diagnosis"; diagnosis: Diagnosis }
  | { type: "done"; scan: Scan }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "budget"; message: string; creditsLeftToday: number; creditsRemaining: number | null };

/** Gallery entry in public/scans/index.json */
export interface GalleryEntry {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  logo?: string;
  diagnosis: string;
  code: DiagnosisCode;
  scannedAt: string;
  file: string;
  /** Sparkline of the 7d film, 24 normalised points 0..1. */
  spark: number[];
}

/* ---------- Component contracts ---------- */

/** components/exposure/Film.tsx: the x-ray film on the lightbox (SVG, no WebGL). */
export interface FilmProps {
  meta: ScanMeta | null;
  price: PricePoint[];
  bigBuys: BigBuy[];
  buyers: BuyersFinding | null;
  flow: FlowFinding | null;
  walls: WallsFinding | null;
  smart: SmartFinding | null;
  you: WalletCheck | null;
  /** 0..1: how far the scan beam has travelled; layers left of it are revealed. */
  reveal: number;
  /** Beam visible (true only while scanning). */
  beam: boolean;
  /** 0..1: funding-source dots merging from a scattered row into clusters. */
  merge: number;
  /** Markers 1..5 shown (0 = none). Marker n pulses when it first appears. */
  markers: number;
  /** Highlight one finding (hover in the report / lab results). */
  focus: 1 | 2 | 3 | 4 | 5 | null;
  onMarkerClick?: (n: 1 | 2 | 3 | 4 | 5) => void;
  className?: string;
}

/** components/exposure/Report.tsx: the typed radiology report on the clipboard. */
export interface ReportProps {
  scan: Partial<Pick<Scan, "meta" | "findings" | "diagnosis" | "totals">> | null;
  you: WalletCheck | null;
  /** "typing" plays the typewriter (with key/ding sounds); "instant" renders everything at once. */
  mode: "typing" | "instant";
  /** Called when a finding line starts typing (the film lights the matching marker) and when all typing ends. */
  onFindingStart?: (n: 1 | 2 | 3 | 4 | 5) => void;
  onDone?: () => void;
  onFindingClick?: (n: 1 | 2 | 3 | 4 | 5) => void;
  onFindingHover?: (n: 1 | 2 | 3 | 4 | 5 | null) => void;
  onWalletSubmit?: (address: string) => void;
  className?: string;
}
