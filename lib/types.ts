// Shared contract between the data pipeline (server), metrics, the 3D scene and the HUD.
// Changing a shape here is a breaking change for every module: keep it stable.

export type Cohort = "sm" | "whale" | "pf" | "other";

export const COHORTS: Cohort[] = ["sm", "whale", "pf", "other"];

export const COHORT_LABEL: Record<Cohort, string> = {
  sm: "Smart Money",
  whale: "Whale",
  pf: "Public Figure",
  other: "Other holders",
};

/**
 * Why a holder has no usable on-chain cost basis. Fog holders are drawn as mist, not columns.
 * "allocation": profiler pnl reports cost_basis_usd 0 and bought_usd 0: the balance was received by
 * transfer (team / vesting / treasury), so it has no entry price at all (not a zero one).
 */
export type FogReason = "no_cost" | "out_of_range" | "pnl_error" | "allocation";

/**
 * One analysed holder. Public scenes never contain addresses: `id` is the rank among
 * analysed holders (0 = largest balance).
 */
export interface HolderPoint {
  id: number;
  cohort: Cohort;
  /** Current token balance (from profiler pnl `holding_amount`, falling back to tgm/holders `token_amount`). */
  amount: number;
  /** Share of circulating supply, 0..1. */
  supplyShare: number;
  /** Average cost per token in USD: (holding_usd - pnl_usd_unrealised) / holding_amount. null => fog. */
  cost: number | null;
  /** priceNow / cost. null => fog. */
  multiple: number | null;
  /** holding_amount / max_balance_held, clamped 0..1 (1 = never sold). */
  conviction: number;
  /** max_balance_held in tokens (ghost ring). */
  maxHeld: number;
  /** Number of buys/inflows reported by Nansen (string in API, parsed). */
  buys: number;
  sells: number;
  fog: FogReason | null;
  /** Short display label ONLY for live local mode, e.g. "0x12ab…9f3c" or a Nansen entity name. Omitted in public scenes. */
  tag?: string;
}

export interface OhlcvPoint {
  /** unix ms of interval start */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface SceneMeta {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  logo?: string;
  /** Last 1h close from token-ohlcv (P0). All multiples are relative to this. */
  priceNow: number;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  circulatingSupply: number | null;
  totalHolders: number | null;
  deployedAt: string | null;
  /** ISO date range used for profiler pnl calls. */
  pnlFrom: string;
  pnlTo: string;
  generatedAt: string;
}

export interface CohortFlow {
  cohort: Cohort | "fresh" | "exchange";
  netFlowUsd: number;
  walletCount: number;
}

export interface Coverage {
  /** Holders analysed with a profiler pnl call. */
  holdersAnalyzed: number;
  /** Sum of analysed holders' supply share, 0..1. */
  analyzedSupplyShare: number;
  /** Share of analysed supply that is fog (no usable cost), 0..1. */
  fogShare: number;
  /** Supply sitting on exchange-labelled holders, 0..1 (excluded from the terrain). */
  exchangeShare: number;
  /** Supply sitting on LP / router / bridge / lock / burn holders, 0..1 (excluded). */
  contractShare: number;
  /** Supply held by analysed holders whose fog reason is "allocation", 0..1 (present when > 0). */
  allocatedShare?: number;
}

/** One line of the call rail. Recorded during a live build and replayed in demo mode. */
export interface CallRecord {
  /** e.g. "profiler/address/pnl" */
  endpoint: string;
  status: number;
  credits: number;
  ms: number;
  cached: boolean;
  /** ms since the build started (used to re-time replays). */
  at: number;
  /** Holder id this call produced, if any (profiler pnl calls). */
  holderId?: number;
}

export interface Scene {
  version: 1;
  meta: SceneMeta;
  holders: HolderPoint[];
  coverage: Coverage;
  /** Last ~30 days of 1h candles, oldest first. */
  ohlcv: OhlcvPoint[];
  flows: CohortFlow[];
  calls: CallRecord[];
  totals: { calls: number; networkCalls: number; credits: number; cacheHits: number; durationMs: number };
  /** true only for the synthetic dev fixture: UI must show a "synthetic data" badge. */
  synthetic?: boolean;
}

/** Server-sent events emitted by /api/scene/[chain]/[token] and re-emitted by the replay player. */
export type SceneEvent =
  | { type: "stage"; stage: "info" | "holders" | "cohorts" | "costbasis" | "flows" | "done"; message: string }
  | { type: "call"; call: CallRecord }
  | { type: "meta"; meta: SceneMeta; ohlcv: OhlcvPoint[] }
  | { type: "cohorts"; counts: Record<Cohort, number>; coverage: Omit<Coverage, "fogShare" | "analyzedSupplyShare" | "holdersAnalyzed"> }
  | { type: "holder"; holder: HolderPoint }
  | { type: "done"; scene: Scene }
  | { type: "error"; message: string; retryable: boolean };

/** A cluster of break-even supply between the current price and a what-if price. */
export interface Reef {
  /** Price (USD) at the centre of the cluster. */
  price: number;
  /** % move from priceNow to reach this reef, e.g. 0.22 = +22%. */
  movePct: number;
  /** Tokens whose holders get back to break-even inside this cluster. */
  amount: number;
  supplyShare: number;
  /** amount * price / liquidityUsd, null if liquidity unknown. */
  wallToLiquidity: number | null;
  /** Share of this reef's supply held by wallets that already trimmed (1 - conviction), 0..1. */
  sellPressure: number;
  /** Dominant cohort in the reef. */
  cohort: Cohort;
}

export interface TideSnapshot {
  /** What-if price the water is set to. */
  price: number;
  /** log2(priceNow / price): water height in "doublings". 0 = today. */
  waterLevel: number;
  underwaterShare: number;
  underwaterByCohort: Record<Cohort, number>;
  /** Share of analysed supply that is fog. */
  fogShare: number;
}

/** Props contract for components/TideScene.tsx (vanilla three.js inside a client component). */
export interface TideSceneProps {
  holders: HolderPoint[];
  priceNow: number;
  /** What-if price. Water plane sits at log2(priceNow / tidePrice) * UNIT. */
  tidePrice: number;
  reefs: Reef[];
  /** Weighted average cost of Smart Money holders; red chain on the SM island. null if no SM. */
  smPainPrice: number | null;
  /** true once the build is complete: islands re-sort into ranked spirals. */
  settled: boolean;
  /** Vertical drag on the canvas moves the tide. Called with the new what-if price. */
  onTideDrag?: (price: number) => void;
  onHover?: (holder: HolderPoint | null, screen: { x: number; y: number } | null) => void;
  /** Scripted camera path for screen recordings (?director=1). */
  director?: boolean;
  className?: string;
}

/** Visual scale shared by the scene and the 2D profile: world units per doubling of profit. */
export const UNIT = 1.6;
/** Height encoding clamp: -90% .. 20x. */
export const MIN_LOG2 = Math.log2(0.1);
export const MAX_LOG2 = Math.log2(20);
