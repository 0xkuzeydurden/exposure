// The token-screener query behind scripts/trending.ts (gallery candidates). Pure, so the request body
// is tested against TokenScreenerRequest in openapi.json.
import type { ScreenerQuery } from "../../nansen/api";

export const TRENDING_CHAINS = ["base", "ethereum", "bnb", "solana"] as const;
export const SCREENER_TIMEFRAMES = ["5m", "10m", "1h", "6h", "24h", "7d", "30d"] as const;
export type ScreenerTimeframe = (typeof SCREENER_TIMEFRAMES)[number];

/** Liquid, mid-size, 1 week to 1 year old, no stablecoins. */
export const TRENDING_FILTERS = {
  liquidity: { min: 250_000 },
  market_cap_usd: { min: 5_000_000, max: 2_000_000_000 },
  token_age_days: { min: 7, max: 365 },
  include_stablecoins: false,
};

export function trendingQuery(opts: {
  chains: string[];
  timeframe?: ScreenerTimeframe;
  sort?: "volume" | "nof_buyers" | "nof_traders" | "netflow";
  perPage?: number;
  /** Cohort whose activity the screener counts; "sm" lists tokens smart money traded in the window. */
  trader?: "all" | "sm" | "whale" | "public_figure";
}): ScreenerQuery {
  if (!opts.chains.length || opts.chains.length > 5) throw new Error("token-screener takes 1 to 5 chains per call");
  return {
    chains: opts.chains,
    timeframe: opts.timeframe ?? "24h",
    perPage: Math.max(1, Math.min(1000, Math.floor(opts.perPage ?? 50))),
    // The default row shape has no buyer counts; trader_type "all" asks for the one that does.
    filters: opts.trader
      ? { ...TRENDING_FILTERS, trader_type: opts.trader }
      : opts.sort === "nof_buyers"
        ? { ...TRENDING_FILTERS, trader_type: "all" }
        : TRENDING_FILTERS,
    orderBy: [{ field: opts.sort ?? "volume", direction: "DESC" }],
  };
}
