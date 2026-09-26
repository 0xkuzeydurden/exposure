// Finding 05 · "And you?": one profiler/address/pnl call for a pasted wallet, measured against the
// scan it was pasted on (smart-money average entry, supply-by-entry-price ladder).
import { getAddressPnl } from "../../nansen/api";
import { isEvmChain, isValidAddress } from "../../nansen/chains";
import { EP } from "../../nansen/endpoints";
import { NansenError } from "../../nansen/errors";
import type { PnlRow } from "../../nansen/schemas";
import { costFromPnl, costInRange, pickPnlRecord, pnlWindows } from "../../pipeline/derive";
import type { CallRecord, LadderBin, Scan, WalletCheck } from "../types";
import { CallTracker, isFatal } from "./tracker";
import { clamp01, normalizeAddress, positive, shortAddress } from "./util";

/** Share of the ladder's supply that got in cheaper than `cost` (log-interpolated inside the bin that contains it). */
export function cheaperShareFromLadder(ladder: LadderBin[], cost: number): number | null {
  const total = ladder.reduce((s, b) => s + (b.tokens > 0 ? b.tokens : 0), 0);
  if (!(total > 0) || !(cost > 0)) return null;
  let cheaper = 0;
  for (const b of ladder) {
    if (!(b.tokens > 0)) continue;
    if (b.hi <= cost) cheaper += b.tokens;
    else if (b.lo < cost) cheaper += b.tokens * (Math.log(cost / b.lo) / Math.log(b.hi / b.lo));
  }
  return clamp01(cheaper / total);
}

export interface WalletContext {
  priceNow?: number | null;
  smartAvgEntry?: number | null;
  ladder?: LadderBin[] | null;
}

/** Pure: pnl rows (null = the call failed) → WalletCheck. */
export function walletFromPnl(rows: PnlRow[] | null, chain: string, tokenAddress: string, wallet: string, ctx: WalletContext = {}): WalletCheck {
  const base: WalletCheck = {
    status: "unavailable",
    address: wallet,
    short: shortAddress(wallet),
    cost: null,
    pnlPct: null,
    vsSmartMoneyPct: null,
    cheaperShare: null,
    holdingTokens: null,
  };
  if (!rows) return base;
  const rec = pickPnlRecord(rows, chain, tokenAddress);
  if (!rec) return base;
  const priceNow = positive(ctx.priceNow) ? ctx.priceNow : positive(rec.token_price) ? rec.token_price : null;
  let cost = costFromPnl(rec);
  if (cost !== null && priceNow !== null && !costInRange(cost, priceNow)) cost = null;
  const holding = rec.holding_amount !== null && rec.holding_amount >= 0 ? rec.holding_amount : null;
  if (cost === null) return { ...base, status: "partial", holdingTokens: holding };
  return {
    ...base,
    status: "ok",
    cost,
    pnlPct: priceNow !== null ? priceNow / cost - 1 : null,
    vsSmartMoneyPct: positive(ctx.smartAvgEntry) ? cost / ctx.smartAvgEntry - 1 : null,
    cheaperShare: ctx.ladder && ctx.ladder.length ? cheaperShareFromLadder(ctx.ladder, cost) : null,
    holdingTokens: holding,
  };
}

export interface CheckWalletOptions {
  signal?: AbortSignal;
  /** Every Nansen call (finding "you"), e.g. for the evidence tab. */
  onCall?: (call: CallRecord) => void;
  now?: Date;
}

/**
 * One profiler/address/pnl call (narrowed to 90d / 30d windows only if the API rejects the range).
 * Uses the same cache key as the deep scan's holder calls, so a top holder costs 0 credits.
 * Never throws for missing data; throws for invalid input, aborts and account-level API errors.
 */
export async function checkWallet(
  chain: string,
  tokenAddress: string,
  wallet: string,
  scan?: Scan | null,
  opts: CheckWalletOptions = {},
): Promise<WalletCheck> {
  chain = chain.trim().toLowerCase();
  const token = isEvmChain(chain) ? tokenAddress.trim().toLowerCase() : tokenAddress.trim();
  const address = wallet.trim();
  if (!isValidAddress(chain, token)) throw new Error("Invalid token address");
  if (!isValidAddress(chain, address)) throw new Error("Invalid wallet address");

  const tracker = new CallTracker({
    signal: opts.signal ?? new AbortController().signal,
    emit: (_finding, e) => {
      if (e.type === "call") opts.onCall?.(e.call);
    },
  });
  const windows = pnlWindows(scan?.meta.deployedAt ?? null, opts.now ?? new Date());
  let rows: PnlRow[] | null = null;
  try {
    const res = await tracker.callWindows(
      "you",
      EP.addressPnl,
      windows,
      (w) => ({ chain, token, address: normalizeAddress(chain, address), window: w.label }),
      (w, o) => getAddressPnl(chain, address, token, { from: w.from, to: w.to }, o),
    );
    rows = res.data.data;
  } catch (err) {
    // Account-level problems (no key, out of credits) and aborts surface; anything else is "no data".
    if (isFatal(err)) throw err;
    if (!(err instanceof NansenError)) console.warn(`[wallet] pnl unusable: ${err instanceof Error ? err.message : String(err)}`);
    rows = null;
  }
  return walletFromPnl(rows, chain, token, address, {
    priceNow: scan?.meta.priceNow ?? null,
    smartAvgEntry: scan?.findings.smart.avgEntry ?? null,
    ladder: scan?.findings.walls.ladder ?? null,
  });
}
