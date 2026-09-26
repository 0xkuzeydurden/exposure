// Finding 04 · "Is smart money in profit?": tgm/who-bought-sold BUY and SELL over 30 days filtered
// to Nansen's smart-trader labels, reduced to ONE aggregate (Nansen redistribution rules: smart-money
// data is never shown per wallet and never over windows shorter than 7 days). No address leaves here.
import type { WhoBoughtSoldRow } from "../../nansen/schemas";
import type { SmartFinding } from "../types";
import type { PipelineRules } from "./rules";
import { normalizeAddress, positive } from "./util";

export const SMART_WINDOW_DAYS = 30;
/**
 * Fewer smart wallets than this and the "aggregate" would be one or two wallets' own entry, volume and
 * stance, i.e. smart-money data per wallet (Nansen redistribution rules). Below it only the wallet
 * count is published: no entry price, no USD, no stance.
 */
export const SMART_MIN_WALLETS = 3;

interface Acc {
  boughtUsd: number;
  boughtTokens: number;
  soldUsd: number;
}

/**
 * Merges the BUY and SELL responses per address (an address can appear in both with the same
 * aggregates, so each field takes the max rather than the sum) and aggregates.
 */
export function aggregateSmart(
  chain: string,
  responses: (WhoBoughtSoldRow[] | null)[],
  priceNow: number,
  rules: PipelineRules["smart"],
): SmartFinding {
  const ok = responses.filter((r): r is WhoBoughtSoldRow[] => r !== null);
  if (!ok.length) return emptySmartFinding();

  const byAddr = new Map<string, Acc>();
  for (const rows of ok) {
    for (const r of rows) {
      if (!r.address) continue;
      const key = normalizeAddress(chain, r.address);
      const a = byAddr.get(key) ?? { boughtUsd: 0, boughtTokens: 0, soldUsd: 0 };
      a.boughtUsd = Math.max(a.boughtUsd, positive(r.bought_volume_usd) ? r.bought_volume_usd : 0);
      a.boughtTokens = Math.max(a.boughtTokens, positive(r.bought_token_volume) ? r.bought_token_volume : 0);
      a.soldUsd = Math.max(a.soldUsd, positive(r.sold_volume_usd) ? r.sold_volume_usd : 0);
      byAddr.set(key, a);
    }
  }

  let boughtUsd = 0;
  let boughtTokens = 0;
  let entryUsd = 0;
  let soldUsd = 0;
  let wallets = 0;
  for (const a of byAddr.values()) {
    if (a.boughtUsd <= 0 && a.soldUsd <= 0) continue;
    wallets++;
    boughtUsd += a.boughtUsd;
    soldUsd += a.soldUsd;
    // VWAP only over wallets with both sides of the price (USD and tokens).
    if (a.boughtUsd > 0 && a.boughtTokens > 0) {
      entryUsd += a.boughtUsd;
      boughtTokens += a.boughtTokens;
    }
  }

  if (wallets < SMART_MIN_WALLETS) {
    // Too few wallets to aggregate: publishing their numbers would expose them one by one.
    return { ...emptySmartFinding(), status: "partial", wallets };
  }

  const avgEntry = boughtTokens > 0 ? entryUsd / boughtTokens : null;
  const pnlPct = avgEntry && priceNow > 0 ? priceNow / avgEntry - 1 : null;
  const netUsd = boughtUsd - soldUsd;
  return {
    status: ok.length < responses.length ? "partial" : "ok",
    windowDays: SMART_WINDOW_DAYS,
    avgEntry,
    pnlPct,
    wallets,
    boughtUsd,
    soldUsd,
    netUsd,
    stance: smartStance(boughtUsd, soldUsd, rules),
    state: smartState(avgEntry, priceNow, rules),
  };
}

export function smartStance(boughtUsd: number, soldUsd: number, rules: PipelineRules["smart"]): SmartFinding["stance"] {
  const gross = boughtUsd + soldUsd;
  if (!(gross > 0)) return "holding";
  const r = (boughtUsd - soldUsd) / gross;
  if (r <= rules.exitingRatio) return "exiting";
  if (r <= rules.trimmingRatio) return "trimming";
  if (r >= rules.addingRatio) return "adding";
  return "holding";
}

export function smartState(avgEntry: number | null, priceNow: number, rules: PipelineRules["smart"]): SmartFinding["state"] {
  if (!avgEntry || !(avgEntry > 0) || !(priceNow > 0)) return "unknown";
  const m = priceNow / avgEntry;
  if (m >= rules.profitMultiple) return "profit";
  if (m < rules.lossMultiple) return "loss";
  return "breakeven";
}

export function emptySmartFinding(): SmartFinding {
  return {
    status: "unavailable",
    windowDays: SMART_WINDOW_DAYS,
    avgEntry: null,
    pnlPct: null,
    wallets: 0,
    boughtUsd: 0,
    soldUsd: 0,
    netUsd: 0,
    stance: "holding",
    state: "unknown",
  };
}
