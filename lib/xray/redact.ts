// What leaves the server about this week's buyers (README "Data rules", Nansen redistribution rules):
//   * buyer wallets (tgm/who-bought-sold) and their first funders (profiler first-funder) are published
//     with attribution: short form on screen, the full address for copy and "Open in Nansen";
//   * a funder goes by its Nansen entity name ("Binance", "Wintermute") when it has one, else by its
//     short address; exchanges and bridges by their entity name;
//   * no wallet label is ever published for a buyer, and a funder name that is a smart-money or
//     behavioural label ("30D Smart Trader", "Fund", "Whale", …) is dropped. Smart money is only ever
//     shown as an aggregate (finding 04), never per wallet.
// Counts, USD and shares are kept. Pure (the synthetic fixture runs in the browser).
import { shortAddress } from "../nansen/chains";
import type { BuyerRow, SourceCluster } from "./types";

/**
 * Nansen labels that are never published, not even as a funder's name: smart-money labels (Smart
 * Trader, Fund) and behavioural / cohort labels that would single a wallet out as "informed".
 */
const RESTRICTED_LABEL =
  /smart|\btrader\b|\bfunds?\b|\bwhales?\b|millionaire|billionaire|high balance|profiter|airdrop|hunter|sniper|farmer|\bbots?\b|\bmev\b|public figure|\bholder\b|deployer|influencer|\bkol\b/i;

/** "0x12ab…9f3c", a full EVM address or a Solana address. */
const ADDRESS_LIKE = /^0x[0-9a-f]{2,}…[0-9a-f]{2,}$|0x[0-9a-f]{40}|^[1-9A-HJ-NP-Za-km-z]{32,44}$/i;

/** Emoji, symbols and punctuation in front of a Nansen label ("🏦 Binance", "[Bot] …"). */
const LEADING_SYMBOLS = /^(?:[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E\u00A0-\u00BF\u2000-\u2BFF\u200D\uFE0F]|[\uD800-\uDBFF][\uDC00-\uDFFF])+/;

export function isRestrictedLabel(label: string | null | undefined): boolean {
  return !!label && RESTRICTED_LABEL.test(label);
}

/**
 * A funder's Nansen name as published: the entity part of the label ("🏦 Binance 14: Hot Wallet" →
 * "Binance"), or null when there is none, it is only an address, or it is a restricted label.
 */
export function publicFunderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(LEADING_SYMBOLS, "").trim();
  if (!clean || isRestrictedLabel(clean)) return null;
  const head = clean
    .split(/[:[\]()]/)[0]
    .replace(/\s+\d+$/, "")
    .trim();
  if (!head || ADDRESS_LIKE.test(head)) return null;
  return head.slice(0, 24);
}

/** A buyer row as published: address, amounts, funder and the funder's public name. Nothing else survives. */
export function publicBuyer(b: BuyerRow): BuyerRow {
  const row: BuyerRow = {
    address: b.address,
    short: b.short || shortAddress(b.address),
    boughtUsd: b.boughtUsd,
    boughtTokens: b.boughtTokens,
    nansenUrl: b.nansenUrl,
  };
  if (b.funder) row.funder = b.funder;
  const name = publicFunderName(b.funderLabel);
  if (name) row.funderLabel = name;
  return row;
}

/** The funder that funded most members (ties: the lowest address), or undefined. */
function hubOf(members: BuyerRow[]): string | undefined {
  const counts = new Map<string, { addr: string; n: number }>();
  for (const m of members) {
    if (!m.funder) continue;
    const k = m.funder.toLowerCase();
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { addr: m.funder, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || (a.addr < b.addr ? -1 : 1))[0]?.addr;
}

/** Published label of a cluster: entity name, else the funder's short address. */
function clusterLabel(c: SourceCluster, members: BuyerRow[], funder: string | undefined): string {
  switch (c.kind) {
    case "untraced":
      return "Untraced";
    case "self":
      return "Self-funded";
    case "exchange":
    case "bridge":
      return publicFunderName(c.label) ?? (c.kind === "exchange" ? "Exchange" : "Bridge / service");
    case "wallet": {
      const key = funder?.toLowerCase();
      const named = key ? members.find((m) => m.funder?.toLowerCase() === key && m.funderLabel)?.funderLabel : undefined;
      if (named) return named;
      if (funder) return shortAddress(funder);
      const fromLabel = publicFunderName(c.label);
      return fromLabel ?? (ADDRESS_LIKE.test(c.label) ? c.label : "Wallet");
    }
  }
}

/** Published copy of the funding clusters: sanitised members and labels, the hub funder kept. Order is kept. */
export function publicClusters(clusters: SourceCluster[]): SourceCluster[] {
  return clusters.map((c): SourceCluster => {
    const members = c.members.map(publicBuyer);
    const funder = c.kind === "wallet" ? (c.funder ?? hubOf(members)) : undefined;
    const out: SourceCluster = {
      id: c.id,
      kind: c.kind,
      label: clusterLabel(c, members, funder),
      wallets: c.wallets,
      boughtUsd: c.boughtUsd,
      share: c.share,
      members,
    };
    if (funder) out.funder = funder;
    return out;
  });
}
