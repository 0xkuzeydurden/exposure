// The only file of the pipeline that reads lib/xray/thresholds.ts (owned by the diagnosis rules),
// so a renamed threshold is a one-line fix here.
import { T } from "../thresholds";
import type { PipelineRules } from "./rules";

export const RULES: PipelineRules = {
  demand: {
    organicRatio: T.demand.organicRatio,
    organicMaxSourceShare: T.demand.organicMaxSourceShare,
    concentratedSourceShare: T.demand.concentratedSourceShare,
    concentratedRatio: T.demand.concentratedRatio,
    top10Concentrated: T.demand.top10Concentrated,
    top10Organic: T.demand.top10Organic,
  },
  flow: {
    moveShare: T.flow.moveShare,
  },
  ceiling: {
    nearMovePct: T.ceiling.nearMovePct,
    wallToLiquidity: T.ceiling.wallToLiquidity,
    wallShareOfAnalysed: T.ceiling.wallShareOfAnalysed,
    underwaterShare: T.ceiling.underwaterShare,
  },
  smart: {
    profitMultiple: T.smart.profitMultiple,
    lossMultiple: T.smart.lossMultiple,
    addingRatio: T.smart.addingRatio,
    trimmingRatio: T.smart.trimmingRatio,
    exitingRatio: T.smart.exitingRatio,
  },
};
