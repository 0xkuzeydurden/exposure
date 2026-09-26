// Endpoint names (without the /api/v1 prefix), documented credit costs and cache TTLs.
// Costs come from `x-credit-cost` in the OpenAPI spec; the live `X-Nansen-Credits-*` headers win.

export const EP = {
  account: "account",
  tokenInformation: "tgm/token-information",
  tokenOhlcv: "tgm/token-ohlcv",
  holders: "tgm/holders",
  whoBoughtSold: "tgm/who-bought-sold",
  flowIntelligence: "tgm/flow-intelligence",
  addressPnl: "profiler/address/pnl",
  searchGeneral: "search/general",
  tokenScreener: "token-screener",
  tgmFlows: "tgm/flows",
  tgmDexTrades: "tgm/dex-trades",
  firstFunder: "profiler/address/first-funder",
  profilerDexTrades: "profiler/address/dex-trades",
} as const;

export type Endpoint = (typeof EP)[keyof typeof EP];

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CREDIT_COST: Record<string, number> = {
  [EP.account]: 0,
  [EP.tokenInformation]: 1,
  [EP.tokenOhlcv]: 1,
  [EP.holders]: 5,
  [EP.whoBoughtSold]: 1,
  [EP.flowIntelligence]: 1,
  [EP.addressPnl]: 1,
  [EP.searchGeneral]: 0,
  [EP.tokenScreener]: 1,
  [EP.tgmFlows]: 1,
  [EP.tgmDexTrades]: 1,
  [EP.firstFunder]: 1,
  [EP.profilerDexTrades]: 1,
};

/**
 * Lifetime of the expensive, slow-moving responses (holder lists, who-bought-sold, profiler pnl):
 * cost basis barely moves within a day, and re-opening a token should not re-spend ~225 credits.
 * NANSEN_CACHE_TTL_HOURS overrides the 24h default.
 */
function slowTtlMs(): number {
  const hours = Number(process.env.NANSEN_CACHE_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * HOUR : 24 * HOUR;
}

/** Disk-cache TTL per endpoint (ms). 0 = never cached. Unknown endpoints get 30 min so a new wrapper can never re-spend credits on every visit. */
export function cacheTtlFor(endpoint: string): number {
  switch (endpoint) {
    case EP.account:
      return 0;
    case EP.tokenInformation:
    case EP.tokenOhlcv:
      return 15 * MIN;
    case EP.flowIntelligence:
    case EP.tgmFlows:
    case EP.tgmDexTrades:
      return 60 * MIN;
    case EP.firstFunder:
      // A wallet's first funder never changes.
      return 30 * 24 * HOUR;
    case EP.profilerDexTrades:
    case EP.holders:
    case EP.whoBoughtSold:
    case EP.addressPnl:
      return slowTtlMs();
    case EP.searchGeneral:
    case EP.tokenScreener:
      return 60 * MIN;
    default:
      return 30 * MIN;
  }
}

/** "/api/v1/tgm/holders", "tgm/holders" and "/tgm/holders" all normalise to "tgm/holders". */
export function normalizeEndpoint(path: string): string {
  return path
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v1\//, "")
    .replace(/\/+$/, "");
}

export function knownCost(endpoint: string): number {
  return CREDIT_COST[endpoint] ?? 1;
}
