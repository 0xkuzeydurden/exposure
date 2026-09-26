// Response shapes of the EXPOSURE JSON routes (safe to import from client components: types only).
import type { CallRecord, Tier, WalletCheck } from "../types";

/** GET /api/account: never includes the key. The legacy fields are kept for the old pages. */
export interface ExposureAccountResponse {
  hasKey: boolean;
  /** Live scans possible right now: key set, allowed on this server, account above the credit floor. */
  liveEnabled: boolean;
  plan: string | null;
  /** Account credits (free GET /account, cached 5 min; the last paid call's header when lower). */
  creditsRemaining: number | null;
  /** Credits left in today's live budget (UTC day). */
  dailyLeft: number;
  dailyCap: number;
  deepLeft: number;
  floor: number;
  /** Documented credit cost per tier with the server's live limits (upper bound; cache hits are free). `deep` is the EVM figure. */
  estimates: Record<Tier, number>;
  /** Deep-scan estimate by chain kind: funder tracing (first-funder) only runs on EVM chains. */
  deepByChain: { evm: number; other: number };
  /** Calls / credits spent by this server process (ledger counters). */
  session?: { calls: number; networkCalls: number; cacheHits: number; credits: number };
  error?: string;
  /** @deprecated legacy field */
  liveBuilds?: boolean;
  /** @deprecated legacy field */
  creditsPerBuild?: number;
}

/** POST /api/wallet {chain, token, wallet} → 200 */
export type WalletApiResult = WalletCheck & {
  /** The Nansen calls this check made (finding "you"), for the evidence tab. */
  calls: CallRecord[];
  credits: number;
  /** scannedAt of the scan the wallet was compared with, when one was on disk. */
  comparedWith: string | null;
};

/** Non-2xx JSON body of the EXPOSURE routes. `budget` is set when the live budget refused the request. */
export interface ExposureApiError {
  error: string;
  budget?: { creditsLeftToday: number; creditsRemaining: number | null };
}
