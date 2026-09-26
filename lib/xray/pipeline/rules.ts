// Thresholds for the per-finding classifications (demand, flow verdict, ceiling, smart-money state).
// The pure stage functions take them as a parameter; the live values come from lib/xray/thresholds.ts
// via ./active-rules.ts (the only file that imports it). PLAN_RULES are the plan §5 defaults, used by
// tests and as the documented baseline.

export interface PipelineRules {
  demand: {
    /** sources / traced buyers at or above this (and no big source) => organic. Plan: 0.6 */
    organicRatio: number;
    /** biggest non-exchange source share must stay below this for organic. Plan: 0.20 */
    organicMaxSourceShare: number;
    /** one source at or above this share => concentrated. Plan: 0.35 */
    concentratedSourceShare: number;
    /** sources / traced buyers below this => concentrated. Plan: 0.35 */
    concentratedRatio: number;
    /** No funder tracing (quick tier, Solana): top-10 buyers' share at or above this => concentrated. Plan: 0.70 */
    top10Concentrated: number;
    /** No funder tracing: top-10 share below this => organic (else mixed). */
    top10Organic: number;
  };
  flow: {
    /** |informed 7d net| as a share of market cap (or supply) that counts as a move. Plan: 0.005 */
    moveShare: number;
  };
  ceiling: {
    /** Walls up to this move above the price are "just above". Plan: 0.30 */
    nearMovePct: number;
    /** wall value / pool liquidity at or above this => heavy. Plan: 1.5 */
    wallToLiquidity: number;
    /** wall tokens / analysed supply at or above this => heavy. Plan: 0.08 */
    wallShareOfAnalysed: number;
    /** underwater share of analysed supply at or above this => heavy. Plan: 0.60 */
    underwaterShare: number;
  };
  smart: {
    /** price / avg entry at or above this => profit. Plan: 1.1 */
    profitMultiple: number;
    /** price / avg entry below this => loss. Plan: 0.9 */
    lossMultiple: number;
    /** net / gross flow at or above this => adding. */
    addingRatio: number;
    /** net / gross flow at or below this => trimming. */
    trimmingRatio: number;
    /** net / gross flow at or below this => exiting. */
    exitingRatio: number;
  };
}

export const PLAN_RULES: PipelineRules = {
  demand: {
    organicRatio: 0.6,
    organicMaxSourceShare: 0.2,
    concentratedSourceShare: 0.35,
    concentratedRatio: 0.35,
    top10Concentrated: 0.7,
    top10Organic: 0.5,
  },
  flow: { moveShare: 0.005 },
  ceiling: { nearMovePct: 0.3, wallToLiquidity: 1.5, wallShareOfAnalysed: 0.08, underwaterShare: 0.6 },
  smart: { profitMultiple: 1.1, lossMultiple: 0.9, addingRatio: 0.15, trimmingRatio: -0.15, exitingRatio: -0.5 },
};
