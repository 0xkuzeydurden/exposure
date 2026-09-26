// Typed wrappers for the endpoints EXPOSURE uses. Each builds the request body exactly as the
// OpenAPI spec names it and parses the response with a lenient schema.
import type { z } from "zod";
import { nansenGet, nansenPost, type NansenRequestOptions, type NansenResult } from "./client";
import { EP } from "./endpoints";
import {
  AccountResponse,
  AddressPnlResponse,
  FirstFunderResponse,
  FlowIntelligenceResponse,
  HoldersResponse,
  parseResponse,
  SearchGeneralResponse,
  TgmDexTradesResponse,
  TgmFlowsResponse,
  TokenInformationResponse,
  TokenOhlcvResponse,
  TokenScreenerResponse,
  WhoBoughtSoldResponse,
} from "./schemas";

export type HolderList = "all_holders" | "whale" | "public_figure" | "exchange";

/** tgm/holders requires the labels filter to match label_type (spec note on `label_type`). */
const HOLDER_LIST_LABEL: Record<Exclude<HolderList, "all_holders">, string> = {
  whale: "Whale",
  public_figure: "Public Figure",
  exchange: "Exchange",
};

/** Smart-money labels for who-bought-sold. "Fund" is deprecated (changelog 23-09-2026). */
export const SMART_MONEY_LABELS = ["Smart Trader", "30D Smart Trader", "90D Smart Trader", "180D Smart Trader"] as const;

export interface DateRange {
  from: string;
  to: string;
}

async function post<S extends z.ZodType>(
  endpoint: string,
  schema: S,
  body: unknown,
  opts?: NansenRequestOptions,
): Promise<NansenResult<z.output<S>>> {
  const res = await nansenPost<unknown>(endpoint, body, opts);
  return { ...res, data: parseResponse(endpoint, schema, res.data) };
}

export function getAccount(opts?: NansenRequestOptions): Promise<NansenResult<AccountResponse>> {
  return nansenGet<unknown>(EP.account, { ...opts, cache: "off" }).then((res) => ({
    ...res,
    data: parseResponse(EP.account, AccountResponse, res.data),
  }));
}

export function getTokenInformation(
  chain: string,
  tokenAddress: string,
  opts?: NansenRequestOptions,
): Promise<NansenResult<TokenInformationResponse>> {
  return post(EP.tokenInformation, TokenInformationResponse, { chain, token_address: tokenAddress, timeframe: "1d" }, opts);
}

/** 1h candles over `date` (ISO datetimes). */
export function getTokenOhlcv(
  chain: string,
  tokenAddress: string,
  date: DateRange,
  opts?: NansenRequestOptions,
): Promise<NansenResult<TokenOhlcvResponse>> {
  return post(EP.tokenOhlcv, TokenOhlcvResponse, { chain, token_address: tokenAddress, timeframe: "1h", date }, opts);
}

export function holdersBody(chain: string, tokenAddress: string, list: HolderList, perPage = 1000) {
  return {
    chain,
    token_address: tokenAddress,
    label_type: list,
    pagination: { page: 1, per_page: perPage },
    order_by: [{ field: "token_amount", direction: "DESC" }],
    ...(list === "all_holders" ? {} : { filters: { include_smart_money_labels: [HOLDER_LIST_LABEL[list]] } }),
  };
}

/** One page of tgm/holders. Never called with label_type "smart_money" (restricted redistribution). */
export function getHolders(
  chain: string,
  tokenAddress: string,
  list: HolderList,
  perPage = 1000,
  opts?: NansenRequestOptions,
): Promise<NansenResult<HoldersResponse>> {
  return post(EP.holders, HoldersResponse, holdersBody(chain, tokenAddress, list, perPage), opts);
}

export function getWhoBoughtSold(
  chain: string,
  tokenAddress: string,
  side: "BUY" | "SELL",
  date: DateRange,
  opts?: NansenRequestOptions,
): Promise<NansenResult<WhoBoughtSoldResponse>> {
  return post(
    EP.whoBoughtSold,
    WhoBoughtSoldResponse,
    {
      chain,
      token_address: tokenAddress,
      buy_or_sell: side,
      date,
      filters: { include_smart_money_labels: [...SMART_MONEY_LABELS] },
      pagination: { page: 1, per_page: 1000 },
      order_by: [{ field: side === "BUY" ? "bought_volume_usd" : "sold_volume_usd", direction: "DESC" }],
    },
    opts,
  );
}

/** profiler/address/pnl keeps the `address` field (the 24-09-2026 rename only hit pnl-summary / related-wallets). */
export function getAddressPnl(
  chain: string,
  wallet: string,
  tokenAddress: string,
  date: DateRange,
  opts?: NansenRequestOptions,
): Promise<NansenResult<AddressPnlResponse>> {
  return post(
    EP.addressPnl,
    AddressPnlResponse,
    {
      address: wallet,
      chain,
      date,
      filters: { token_address: tokenAddress },
      pagination: { page: 1, per_page: 10 },
    },
    opts,
  );
}

export function getFlowIntelligence(
  chain: string,
  tokenAddress: string,
  opts?: NansenRequestOptions,
): Promise<NansenResult<FlowIntelligenceResponse>> {
  return post(EP.flowIntelligence, FlowIntelligenceResponse, { chain, token_address: tokenAddress, timeframe: "1d" }, opts);
}

export function searchGeneral(
  query: string,
  opts?: NansenRequestOptions & { chain?: string; limit?: number },
): Promise<NansenResult<SearchGeneralResponse>> {
  const body = {
    search_query: query,
    result_type: "token",
    limit: Math.max(1, Math.min(50, opts?.limit ?? 20)),
    ...(opts?.chain ? { chain: opts.chain } : {}),
  };
  return post(EP.searchGeneral, SearchGeneralResponse, body, opts);
}

export interface ScreenerQuery {
  chains: string[];
  timeframe: "5m" | "10m" | "1h" | "6h" | "24h" | "7d" | "30d";
  perPage?: number;
  filters?: Record<string, unknown>;
  orderBy?: { field: string; direction: "ASC" | "DESC" }[];
}

export function tokenScreenerBody(q: ScreenerQuery) {
  return {
    chains: q.chains,
    timeframe: q.timeframe,
    pagination: { page: 1, per_page: Math.max(1, Math.min(1000, Math.floor(q.perPage ?? 50))) },
    ...(q.filters ? { filters: q.filters } : {}),
    ...(q.orderBy ? { order_by: q.orderBy } : {}),
  };
}

export function tokenScreener(q: ScreenerQuery, opts?: NansenRequestOptions): Promise<NansenResult<TokenScreenerResponse>> {
  return post(EP.tokenScreener, TokenScreenerResponse, tokenScreenerBody(q), opts);
}

/** Chains token-screener accepts (TokenScreenerChain in the Nansen OpenAPI spec). */
export const SCREENER_CHAINS: ReadonlySet<string> = new Set([
  "arbitrum",
  "arc",
  "avalanche",
  "base",
  "bitcoin",
  "bnb",
  "citrea",
  "ethereum",
  "hyperevm",
  "injective",
  "iotaevm",
  "linea",
  "mantle",
  "mantra",
  "monad",
  "near",
  "optimism",
  "plasma",
  "polygon",
  "robinhood",
  "sei",
  "solana",
  "sonic",
  "starknet",
  "sui",
  "ton",
  "tron",
]);

/**
 * token-screener narrowed to one token (TokenScreenerRequest: `chains` 1..5 items, `timeframe` required,
 * `filters.token_address` a string). Native / wrapped-native tokens are excluded by default, so they
 * are let in; stablecoins are in by default. 1 credit, cached 60 minutes (lib/nansen/endpoints).
 */
export function tokenLookupBody(chain: string, tokenAddress: string) {
  return tokenScreenerBody({
    chains: [chain],
    timeframe: "24h",
    perPage: 10,
    filters: { token_address: tokenAddress, include_native_tokens: true },
  });
}

/** One token's screener row(s): symbol, price, market cap, FDV, liquidity, age / deployment date. */
export function lookupTokenScreener(chain: string, tokenAddress: string, opts?: NansenRequestOptions): Promise<NansenResult<TokenScreenerResponse>> {
  return post(EP.tokenScreener, TokenScreenerResponse, tokenLookupBody(chain, tokenAddress), opts);
}

// ================================================================ EXPOSURE wrappers
// Request bodies verified against the Nansen OpenAPI spec (TGMFlowsRequest,
// TGMDexTradesRequest, TGMWhoBoughtSoldRequest, ProfilerAddressFirstFunderRequest,
// TGMFlowIntelligenceRequest). All of them are `additionalProperties: false`: never add fields.

export type FlowLabel = "smart_money" | "whale" | "public_figure" | "exchange" | "top_100_holders";
export type IntelTimeframe = "5m" | "1h" | "6h" | "12h" | "1d" | "7d";

export function tgmFlowsBody(chain: string, tokenAddress: string, label: FlowLabel, date: DateRange, perPage = 200) {
  return {
    chain,
    token_address: tokenAddress,
    date,
    label,
    // per_page defaults to 10; 7 days of hourly buckets is 168 (+1 live bucket). Max 1000.
    pagination: { page: 1, per_page: Math.max(1, Math.min(1000, Math.floor(perPage))) },
    order_by: [{ field: "date", direction: "ASC" }],
  };
}

/** tgm/flows: hourly cohort balance snapshots for ranges <= 7 days (daily beyond). 1 credit. */
export function getTgmFlows(
  chain: string,
  tokenAddress: string,
  label: FlowLabel,
  date: DateRange,
  perPage = 200,
  opts?: NansenRequestOptions,
): Promise<NansenResult<TgmFlowsResponse>> {
  return post(EP.tgmFlows, TgmFlowsResponse, tgmFlowsBody(chain, tokenAddress, label, date, perPage), opts);
}

export interface DexTradesQuery {
  action?: "BUY" | "SELL";
  perPage?: number;
  orderBy?: { field: string; direction: "ASC" | "DESC" }[];
  traderAddress?: string | string[];
  onlySmartMoney?: boolean;
}

export function tgmDexTradesBody(chain: string, tokenAddress: string, date: DateRange, q: DexTradesQuery = {}) {
  const filters: Record<string, unknown> = {};
  if (q.action) filters.action = q.action;
  if (q.traderAddress) filters.trader_address = q.traderAddress;
  return {
    chain,
    token_address: tokenAddress,
    date,
    ...(q.onlySmartMoney ? { only_smart_money: true } : {}),
    pagination: { page: 1, per_page: Math.max(1, Math.min(1000, Math.floor(q.perPage ?? 40))) },
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(q.orderBy ? { order_by: q.orderBy } : {}),
  };
}

/** tgm/dex-trades: individual DEX trades of one token. 1 credit per page. */
export function getTgmDexTrades(
  chain: string,
  tokenAddress: string,
  date: DateRange,
  q: DexTradesQuery = {},
  opts?: NansenRequestOptions,
): Promise<NansenResult<TgmDexTradesResponse>> {
  return post(EP.tgmDexTrades, TgmDexTradesResponse, tgmDexTradesBody(chain, tokenAddress, date, q), opts);
}

export interface TradersQuery {
  perPage?: number;
  /** LabelType values for filters.include_smart_money_labels; omitted = every trader. */
  labels?: readonly string[];
}

export function whoBoughtSoldBody(chain: string, tokenAddress: string, side: "BUY" | "SELL", date: DateRange, q: TradersQuery = {}) {
  return {
    chain,
    token_address: tokenAddress,
    buy_or_sell: side,
    date,
    ...(q.labels && q.labels.length ? { filters: { include_smart_money_labels: [...q.labels] } } : {}),
    pagination: { page: 1, per_page: Math.max(1, Math.min(1000, Math.floor(q.perPage ?? 1000))) },
    order_by: [{ field: side === "BUY" ? "bought_volume_usd" : "sold_volume_usd", direction: "DESC" }],
  };
}

/** tgm/who-bought-sold without the fixed smart-money filter of getWhoBoughtSold (all traders by default). 1 credit. */
export function getTokenTraders(
  chain: string,
  tokenAddress: string,
  side: "BUY" | "SELL",
  date: DateRange,
  q: TradersQuery = {},
  opts?: NansenRequestOptions,
): Promise<NansenResult<WhoBoughtSoldResponse>> {
  return post(EP.whoBoughtSold, WhoBoughtSoldResponse, whoBoughtSoldBody(chain, tokenAddress, side, date, q), opts);
}

/** profiler/address/first-funder: the wallet that first sent native gas (EVM only, chain fixed to "all"). 1 credit. */
export function getFirstFunder(address: string, opts?: NansenRequestOptions): Promise<NansenResult<FirstFunderResponse>> {
  return post(EP.firstFunder, FirstFunderResponse, { address, chain: "all" }, opts);
}

/** tgm/flow-intelligence over a chosen timeframe (fresh_wallets_* only exist for 1d / 7d). 1 credit. */
export function getFlowIntelligenceWindow(
  chain: string,
  tokenAddress: string,
  timeframe: IntelTimeframe,
  opts?: NansenRequestOptions,
): Promise<NansenResult<FlowIntelligenceResponse>> {
  return post(EP.flowIntelligence, FlowIntelligenceResponse, { chain, token_address: tokenAddress, timeframe }, opts);
}
