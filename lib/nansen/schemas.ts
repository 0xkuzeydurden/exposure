// Lenient zod v4 schemas for the Nansen responses EXPOSURE reads. Field names verified against
// the Nansen OpenAPI spec. Numbers may arrive as strings or null; rows that are not objects
// are dropped instead of failing the whole response.
import { z } from "zod";
import { NansenSchemaError } from "./errors";

const num = z
  .unknown()
  .optional()
  .transform((v): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const str = z
  .unknown()
  .optional()
  .transform((v): string | null => {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  });

const bool = z
  .unknown()
  .optional()
  .transform((v): boolean | null => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null));

/** Array of rows; invalid rows are skipped, a missing array becomes []. */
function rows<S extends z.ZodType>(schema: S) {
  return z
    .unknown()
    .optional()
    .transform((v): z.output<S>[] =>
      Array.isArray(v)
        ? v.flatMap((r) => {
            const p = schema.safeParse(r);
            return p.success ? [p.data] : [];
          })
        : [],
    );
}

/** Nested object whose fields are all lenient; a missing/invalid object (or an array) parses as all-null. */
function nested<S extends z.ZodType>(schema: S) {
  return z
    .unknown()
    .optional()
    .transform((v): z.output<S> => {
      const parsed = schema.safeParse(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      return parsed.success ? parsed.data : schema.parse({});
    });
}

const stringList = z
  .unknown()
  .optional()
  .transform((v): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));

const Pagination = z.object({ page: num, per_page: num, is_last_page: bool });

// ---------------------------------------------------------------- account (GET /account)
export const AccountResponse = z.object({
  user_id: str,
  plan: str,
  credits_remaining: num,
});
export type AccountResponse = z.output<typeof AccountResponse>;

// ---------------------------------------------------------------- tgm/token-information
const TokenDetails = z.object({
  token_deployment_date: str,
  website: str,
  x: str,
  telegram: str,
  market_cap_usd: num,
  fdv_usd: num,
  circulating_supply: num,
  total_supply: num,
});

const SpotMetrics = z.object({
  volume_total_usd: num,
  buy_volume_usd: num,
  sell_volume_usd: num,
  total_buys: num,
  total_sells: num,
  unique_buyers: num,
  unique_sellers: num,
  liquidity_usd: num,
  total_holders: num,
});

export const TokenInformationResponse = z.object({
  data: nested(
    z.object({
      name: str,
      symbol: str,
      contract_address: str,
      logo: str,
      token_details: nested(TokenDetails),
      spot_metrics: nested(SpotMetrics),
    }),
  ),
});
export type TokenInformationResponse = z.output<typeof TokenInformationResponse>;

// ---------------------------------------------------------------- tgm/token-ohlcv (single token)
export const OhlcvCandle = z.object({
  interval_start: str,
  open: num,
  high: num,
  low: num,
  close: num,
  volume: num,
  volume_usd: num,
});
export type OhlcvCandle = z.output<typeof OhlcvCandle>;

export const TokenOhlcvResponse = z.object({
  chain: str,
  token_address: str,
  timeframe: str,
  data: rows(OhlcvCandle),
  truncated: bool,
});
export type TokenOhlcvResponse = z.output<typeof TokenOhlcvResponse>;

// ---------------------------------------------------------------- tgm/holders
export const HolderRow = z.object({
  address: str,
  address_label: str,
  token_amount: num,
  total_outflow: num,
  total_inflow: num,
  balance_change_24h: num,
  balance_change_7d: num,
  balance_change_30d: num,
  ownership_percentage: num,
  value_usd: num,
});
export type HolderRow = z.output<typeof HolderRow>;

export const HoldersResponse = z.object({
  data: rows(HolderRow),
  pagination: nested(Pagination),
  warnings: stringList,
});
export type HoldersResponse = z.output<typeof HoldersResponse>;

// ---------------------------------------------------------------- tgm/who-bought-sold
export const WhoBoughtSoldRow = z.object({
  address: str,
  address_label: str,
  bought_token_volume: num,
  sold_token_volume: num,
  token_trade_volume: num,
  bought_volume_usd: num,
  sold_volume_usd: num,
  trade_volume_usd: num,
});
export type WhoBoughtSoldRow = z.output<typeof WhoBoughtSoldRow>;

export const WhoBoughtSoldResponse = z.object({
  data: rows(WhoBoughtSoldRow),
  pagination: nested(Pagination),
});
export type WhoBoughtSoldResponse = z.output<typeof WhoBoughtSoldResponse>;

// ---------------------------------------------------------------- profiler/address/pnl
export const PnlRow = z.object({
  token_address: str,
  token_symbol: str,
  token_price: num,
  roi_percent_realised: num,
  pnl_usd_realised: num,
  pnl_usd_unrealised: num,
  roi_percent_unrealised: num,
  bought_amount: num,
  bought_usd: num,
  cost_basis_usd: num,
  sold_amount: num,
  sold_usd: num,
  avg_sold_price_usd: num,
  holding_amount: num,
  holding_usd: num,
  /** String in the API ("12"). */
  nof_buys: str,
  nof_sells: str,
  max_balance_held: num,
  max_balance_held_usd: num,
});
export type PnlRow = z.output<typeof PnlRow>;

export const AddressPnlResponse = z.object({
  data: rows(PnlRow),
  pagination: nested(Pagination),
});
export type AddressPnlResponse = z.output<typeof AddressPnlResponse>;

// ---------------------------------------------------------------- tgm/flow-intelligence
export const FlowIntelligenceRow = z.object({
  public_figure_net_flow_usd: num,
  public_figure_avg_flow_usd: num,
  public_figure_wallet_count: num,
  top_pnl_net_flow_usd: num,
  top_pnl_avg_flow_usd: num,
  top_pnl_wallet_count: num,
  whale_net_flow_usd: num,
  whale_avg_flow_usd: num,
  whale_wallet_count: num,
  smart_trader_net_flow_usd: num,
  smart_trader_avg_flow_usd: num,
  smart_trader_wallet_count: num,
  exchange_net_flow_usd: num,
  exchange_avg_flow_usd: num,
  exchange_wallet_count: num,
  fresh_wallets_net_flow_usd: num,
  fresh_wallets_avg_flow_usd: num,
  fresh_wallets_wallet_count: num,
});
export type FlowIntelligenceRow = z.output<typeof FlowIntelligenceRow>;

export const FlowIntelligenceResponse = z.object({
  data: rows(FlowIntelligenceRow),
  warnings: stringList,
});
export type FlowIntelligenceResponse = z.output<typeof FlowIntelligenceResponse>;

// ---------------------------------------------------------------- search/general
export const SearchToken = z.object({
  name: str,
  symbol: str,
  chain: str,
  address: str,
  price: num,
  volume_24h: num,
  market_cap: num,
  rank: num,
  /** Not in the spec; kept if the API ever includes it. */
  logo: str,
});
export type SearchToken = z.output<typeof SearchToken>;

export const SearchGeneralResponse = z.object({
  tokens: rows(SearchToken),
  entities: rows(z.object({ name: str, tags: stringList, rank: num })),
  total_results: num,
});
export type SearchGeneralResponse = z.output<typeof SearchGeneralResponse>;

// ---------------------------------------------------------------- token-screener
// The row shape varies with filters.trader_type; every field is optional here.
export const TokenScreenerRow = z.object({
  chain: str,
  token_address: str,
  token_symbol: str,
  token_age_days: num,
  token_age_hours: num,
  token_deployment_date: str,
  market_cap_usd: num,
  liquidity: num,
  price_usd: num,
  price_change: num,
  fdv: num,
  fdv_mc_ratio: num,
  buy_volume: num,
  sell_volume: num,
  volume: num,
  netflow: num,
  inflow_fdv_ratio: num,
  outflow_fdv_ratio: num,
  nof_traders: num,
  nof_buyers: num,
  nof_sellers: num,
  nof_buys: num,
  nof_sells: num,
});
export type TokenScreenerRow = z.output<typeof TokenScreenerRow>;

export const TokenScreenerResponse = z.object({
  data: rows(TokenScreenerRow),
  pagination: nested(Pagination),
});
export type TokenScreenerResponse = z.output<typeof TokenScreenerResponse>;

// ---------------------------------------------------------------- tgm/flows (EXPOSURE)
// Hourly snapshots for ranges <= 7 days. `token_amount` is the cohort's total balance at the bucket,
// so a net flow is the difference between two buckets. DEX/CEX fields only for label=exchange.
export const TgmFlowRow = z.object({
  date: str,
  bucket_end: str,
  is_complete: bool,
  price_usd: num,
  token_amount: num,
  value_usd: num,
  holders_count: num,
  total_inflows_count: num,
  total_outflows_count: num,
  total_inflows_dex: num,
  total_outflows_dex: num,
  total_inflows_cex: num,
  total_outflows_cex: num,
});
export type TgmFlowRow = z.output<typeof TgmFlowRow>;

export const TgmFlowsResponse = z.object({
  data: rows(TgmFlowRow),
  pagination: nested(Pagination),
  warnings: stringList,
});
export type TgmFlowsResponse = z.output<typeof TgmFlowsResponse>;

// ---------------------------------------------------------------- tgm/dex-trades (EXPOSURE)
export const TgmDexTradeRow = z.object({
  block_timestamp: str,
  transaction_hash: str,
  trader_address: str,
  trader_address_label: str,
  action: str,
  token_address: str,
  token_name: str,
  token_amount: num,
  traded_token_address: str,
  traded_token_name: str,
  traded_token_amount: num,
  estimated_swap_price_usd: num,
  estimated_value_usd: num,
});
export type TgmDexTradeRow = z.output<typeof TgmDexTradeRow>;

export const TgmDexTradesResponse = z.object({
  data: rows(TgmDexTradeRow),
  pagination: nested(Pagination),
});
export type TgmDexTradesResponse = z.output<typeof TgmDexTradesResponse>;

// ---------------------------------------------------------------- profiler/address/first-funder (EXPOSURE)
// EVM only; `data: []` (a normal 200) when an exchange / bridge / paymaster paid the first gas.
export const FirstFunderRow = z.object({
  wallet_address: str,
  first_funder_address: str,
  first_funder_name: str,
  transaction_hash: str,
  block_timestamp: str,
  chain: str,
});
export type FirstFunderRow = z.output<typeof FirstFunderRow>;

export const FirstFunderResponse = z.object({
  data: rows(FirstFunderRow),
  pagination: nested(Pagination),
});
export type FirstFunderResponse = z.output<typeof FirstFunderResponse>;

// ---------------------------------------------------------------- error envelope
export const ErrorEnvelope = z.object({
  error: str,
  message: str,
  code: str,
  status: num,
  request_id: str,
  doc_url: str,
  param: str,
  retry_after: num,
});

/** Validates `data` against a lenient schema; throws NansenSchemaError on a top-level mismatch. */
export function parseResponse<S extends z.ZodType>(endpoint: string, schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new NansenSchemaError(endpoint, z.prettifyError(r.error));
  return r.data;
}
