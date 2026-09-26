// Response shapes of the app/api/* JSON routes (import these from client components).
import type { FogReason } from "../types";

export interface TokenSearchResult {
  name: string;
  symbol: string;
  chain: string;
  address: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  logo?: string;
}

/** GET /api/search?q=…[&chain=…]: always 200; `results` is [] without a key. */
export interface SearchApiResponse {
  hasKey: boolean;
  results: TokenSearchResult[];
  error?: string;
}

/** GET /api/account: never includes the key itself. */
export interface AccountApiResponse {
  hasKey: boolean;
  /** Whether this server runs live builds / wallet probes (key set and live builds allowed). */
  liveBuilds: boolean;
  /** Documented credit cost of one live build at the server's MAX_HOLDERS. */
  creditsPerBuild: number;
  plan?: string;
  creditsRemaining?: number;
  /** Calls/credits spent by this server process (from the ledger counters). */
  session?: { calls: number; networkCalls: number; cacheHits: number; credits: number };
  error?: string;
}

/** POST /api/wallet {chain, token, wallet, priceNow?} */
export interface WalletApiResponse {
  cost: number | null;
  multiple: number | null;
  amount: number;
  conviction: number;
  maxHeld: number;
  fog: FogReason | null;
  priceNow: number;
}

export interface ApiErrorResponse {
  error: string;
}
