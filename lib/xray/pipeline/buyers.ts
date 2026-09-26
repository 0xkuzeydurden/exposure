// Finding 01 · "How many real buyers?": this week's buyers (tgm/who-bought-sold BUY 7d), the
// largest N traced to their first funder (profiler/address/first-funder, EVM only), then clustered.
//
// Counting rule for `sources` (documented in the README):
//   * buyers whose first funder is an exchange or bridge (by Nansen entity name) are each counted as
//     one independent source (thousands of unrelated people withdraw from Binance). In `clusters`
//     they are grouped by exchange name ("Binance · 14 wallets") for display only;
//   * every other traced buyer is linked to its funder address; funders that are themselves buyers
//     are followed (A funds B, B funds C => one source). Each connected group is one source;
//   * untraced buyers (data: [] because an exchange / bridge / paymaster paid their first gas, or a failed
//     lookup) are excluded from `sources` and reported as `untracedShare` (share of analysed wallets).
// The published finding carries buyer and funder addresses (with attribution) but never a wallet
// label; funders go by their Nansen entity name or short address (lib/xray/redact.ts, README "Data rules").
// Pure functions only; the network part lives in ./run.ts.
import type { FirstFunderRow, WhoBoughtSoldRow } from "../../nansen/schemas";
import { isContractLabel, isExchangeLabel, isBurnAddress } from "../../pipeline/derive";
import { publicBuyer, publicClusters, publicFunderName } from "../redact";
import type { BuyerRow, BuyersFinding, SourceCluster, SourceKind } from "../types";
import type { PipelineRules } from "./rules";
import { clamp01, nansenProfilerUrl, normalizeAddress, positive, shortAddress } from "./util";

export const BUYERS_WINDOW_DAYS = 7;
export const DEFAULT_MAX_BUYERS = 60;
export const MAX_BUYERS_CAP = 200;
/** Page size of the who-bought-sold call (API max). */
export const BUYERS_PAGE = 1000;

// Exchanges, bridges and gas / relay services whose withdrawals fund many unrelated wallets: every
// buyer they funded counts as its own source. Word-bounded so "Shop" or "Aggregate" never match
// "hop" / "gate". An unlisted service looks like one wallet funding many buyers ("concentrated"):
// the smoke test prints the biggest hub and its Nansen label so it can be checked before the gallery.
const EXCHANGE_NAMES: [RegExp, string][] = [
  [/\bbinance\b/i, "Binance"],
  [/\bcoinbase\b/i, "Coinbase"],
  [/\bokx\b|\bokex\b/i, "OKX"],
  [/\bbybit\b/i, "Bybit"],
  [/\bkraken\b/i, "Kraken"],
  [/\bkucoin\b/i, "KuCoin"],
  [/\bgate(?:\.io)?\b/i, "Gate"],
  [/\bmexc\b/i, "MEXC"],
  [/\bbitget\b/i, "Bitget"],
  [/\bhtx\b|\bhuobi\b/i, "HTX"],
  [/\bcrypto\.com\b/i, "Crypto.com"],
  [/\bupbit\b/i, "Upbit"],
  [/\bbithumb\b/i, "Bithumb"],
  [/\bbitfinex\b/i, "Bitfinex"],
  [/\bgemini\b/i, "Gemini"],
  [/\bbitstamp\b/i, "Bitstamp"],
  [/\bbitmart\b/i, "BitMart"],
  [/\blbank\b/i, "LBank"],
  [/\bpoloniex\b/i, "Poloniex"],
  [/\bbitvavo\b/i, "Bitvavo"],
  [/\bbingx\b/i, "BingX"],
  [/\bwhitebit\b/i, "WhiteBIT"],
  [/\bcoinex\b/i, "CoinEx"],
  [/\bxt\.com\b|\bxt exchange\b/i, "XT.com"],
  [/\brobinhood\b/i, "Robinhood"],
  [/\brevolut\b/i, "Revolut"],
  [/\bbackpack\b/i, "Backpack"],
  [/\bbitpanda\b/i, "Bitpanda"],
  [/\bphemex\b/i, "Phemex"],
  [/\bbitflyer\b/i, "bitFlyer"],
  [/\bbitso\b/i, "Bitso"],
  [/\bderibit\b/i, "Deribit"],
  [/\bkorbit\b/i, "Korbit"],
  [/\bindodax\b/i, "Indodax"],
];

const BRIDGE_NAMES: [RegExp, string][] = [
  [/\brelay\b/i, "Relay"],
  [/\bstargate\b/i, "Stargate"],
  [/\bacross\b/i, "Across"],
  [/\bhop\b/i, "Hop"],
  [/\blayer\s?zero\b/i, "LayerZero"],
  [/\bwormhole\b/i, "Wormhole"],
  [/\bgas\.?zip\b/i, "Gas.zip"],
  [/\borbiter\b/i, "Orbiter"],
  [/debridge/i, "deBridge"],
  [/cbridge|\bceler\b/i, "cBridge"],
  [/\bsquid\b/i, "Squid"],
  [/\bsocket\b|\bbungee\b/i, "Socket"],
  [/\bli\.?fi\b|\bjumper\b/i, "LI.FI"],
  [/\bsynapse\b/i, "Synapse"],
  [/\bmayan\b/i, "Mayan"],
  [/\bowlto\b/i, "Owlto"],
  [/\brhino(?:\.fi)?\b/i, "Rhino"],
  [/\bthorchain\b|\bthorswap\b/i, "THORChain"],
  [/\bhyperliquid\b/i, "Hyperliquid"],
  [/\bchangenow\b/i, "ChangeNOW"],
  [/\bfixed\s?float\b/i, "FixedFloat"],
  [/\bsideshift\b/i, "SideShift"],
  // Any other bridge, including names like "cBridge" / "deBridge" / "XYZ Bridge".
  [/bridge/i, "Bridge"],
];

/** Generic exchange wallets ("XYZ: Hot Wallet", "XYZ Deposit") and gas / relay services, by keyword. */
const EXCHANGE_KEYWORDS = /\bhot\s?wallet\b|\bdeposit\b|\bwithdraw(?:al|als)?\b|\bcold\s?wallet\b/i;
const SERVICE_KEYWORDS = /\bpaymaster\b|\bentry\s?point\b|\brelayer\b|\bsolver\b|\brefuel\b|\bfaucet\b|\bgas\s?station\b|\bbundler\b/i;

/** "Gas.zip: Refuel" → "Gas.zip"; the entity part of a Nansen label (before ":" / "[" / "("). */
function entityName(label: string, fallback: string): string {
  const head = label.split(/[:[(]/)[0].replace(/\s+\d+$/, "").trim();
  return (head || fallback).slice(0, 24);
}

/** Exchange / bridge / service entity behind a funder label, or null for an ordinary wallet. */
export function serviceOf(label: string | null | undefined): { kind: "exchange" | "bridge"; name: string } | null {
  if (!label) return null;
  for (const [re, name] of EXCHANGE_NAMES) if (re.test(label)) return { kind: "exchange", name };
  for (const [re, name] of BRIDGE_NAMES) if (re.test(label)) return { kind: "bridge", name };
  if (EXCHANGE_KEYWORDS.test(label)) return { kind: "exchange", name: entityName(label, "Exchange") };
  if (SERVICE_KEYWORDS.test(label)) return { kind: "bridge", name: entityName(label, "Service") };
  return null;
}

export interface PreparedBuyers {
  /** All eligible buyers, largest first. */
  buyers: BuyerRow[];
  totalBuyUsd: number;
  /** The who-bought-sold page was full: there are more buyers than listed. */
  capped: boolean;
  /** Rows who-bought-sold returned (the page, before dropping pools / exchanges). */
  listed?: number;
}

/**
 * Eligible buyers from who-bought-sold rows: positive buy volume, not the token itself, not a
 * contract / pool / router / exchange label. Labels are never kept (they can be smart-money labels).
 * `isLastPage` (the response's pagination.is_last_page) overrides the full-page test when it is known.
 */
export function prepareBuyers(
  rows: WhoBoughtSoldRow[],
  chain: string,
  tokenAddress: string,
  pageSize = BUYERS_PAGE,
  isLastPage: boolean | null = null,
): PreparedBuyers {
  const tokenKey = normalizeAddress(chain, tokenAddress);
  const byKey = new Map<string, BuyerRow>();
  for (const r of rows) {
    if (!r.address || !positive(r.bought_volume_usd)) continue;
    const key = normalizeAddress(chain, r.address);
    if (key === tokenKey || isBurnAddress(chain, r.address)) continue;
    if (isContractLabel(r.address_label) || isExchangeLabel(r.address_label)) continue;
    const prev = byKey.get(key);
    const boughtUsd = r.bought_volume_usd;
    const boughtTokens = positive(r.bought_token_volume) ? r.bought_token_volume : 0;
    if (prev) {
      prev.boughtUsd = Math.max(prev.boughtUsd, boughtUsd);
      prev.boughtTokens = Math.max(prev.boughtTokens, boughtTokens);
      continue;
    }
    byKey.set(key, {
      address: r.address,
      short: shortAddress(r.address),
      boughtUsd,
      boughtTokens,
      nansenUrl: nansenProfilerUrl(r.address, chain),
    });
  }
  const buyers = [...byKey.values()].sort((a, b) => b.boughtUsd - a.boughtUsd || (a.address < b.address ? -1 : 1));
  return {
    buyers,
    totalBuyUsd: buyers.reduce((s, b) => s + b.boughtUsd, 0),
    capped: isLastPage === false ? true : isLastPage === true ? false : rows.length >= pageSize,
    listed: rows.length,
  };
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * How many wallets bought: the eligible who-bought-sold count when the list is complete. A capped list
 * (one full page, sorted by volume) holds only the week's largest buyers, so the count is a floor:
 * the larger of the listed rows and token-information's 24h unique buyers (24h is inside the week).
 */
export function buyerCount(prepared: PreparedBuyers, buyers24h?: number | null): { total: number; capped: boolean } {
  if (!prepared.capped) return { total: prepared.buyers.length, capped: false };
  const listed = Math.max(prepared.listed ?? 0, prepared.buyers.length);
  const day = positive(buyers24h) ? Math.round(buyers24h) : 0;
  return { total: Math.max(listed, day), capped: true };
}

/** Honest wording of a capped buyer list: what was read, and the 24h count when it says more. */
export function capNote(prepared: PreparedBuyers, buyers24h?: number | null): string {
  const listed = Math.max(prepared.listed ?? 0, prepared.buyers.length);
  const day = positive(buyers24h) ? Math.round(buyers24h) : 0;
  const head = `Nansen lists the week's ${fmtCount(listed)} largest buyers; smaller ones are not counted.`;
  return day > listed ? `${head} ${fmtCount(day)} wallets bought in the last 24 hours alone.` : head;
}

/** Result of one first-funder lookup. */
export type FunderLookup =
  | { status: "traced"; row: FirstFunderRow }
  /** data: [] (gas was paid by an exchange / bridge / paymaster), no attribution. */
  | { status: "untraced" }
  /** The call failed (network / 4xx / 5xx). */
  | { status: "failed" };

export function lookupFromRows(rows: FirstFunderRow[]): FunderLookup {
  const row = rows.find((r) => !!r.first_funder_address);
  return row ? { status: "traced", row } : { status: "untraced" };
}

export interface Clustering {
  clusters: SourceCluster[];
  sources: number;
  traced: number;
  untraced: number;
  failed: number;
  untracedShare: number;
  biggestSourceShare: number;
  biggestSourceWallets: number;
  /** Largest group of analysed buyers behind one funder of any kind (wallet, exchange name, bridge name), 0..1 of analysed wallets. */
  maxHubShare: number;
  maxHubLabel: string | null;
  /** The funder behind the largest wallet group (full address + its Nansen label), for the smoke test only. */
  walletHub: { address: string | null; label: string | null; wallets: number };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    for (let p = this.parent.get(root) as string; p !== root; p = this.parent.get(root) as string) root = p;
    // Path compression.
    for (let cur = x; cur !== root; ) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Clusters analysed buyers by first funder. `lookups` is keyed by the normalised buyer address;
 * buyers without an entry count as failed lookups.
 */
export function clusterBuyers(chain: string, analysed: BuyerRow[], lookups: Map<string, FunderLookup>): Clustering {
  const totalUsd = analysed.reduce((s, b) => s + b.boughtUsd, 0);
  const share = (usd: number) => (totalUsd > 0 ? usd / totalUsd : 0);

  const uf = new UnionFind();
  const wallets: BuyerRow[] = [];
  const services = new Map<string, { kind: "exchange" | "bridge"; name: string; members: BuyerRow[] }>();
  const untracedMembers: BuyerRow[] = [];
  let untraced = 0;
  let failed = 0;
  const buyerKeys = new Set(analysed.map((b) => normalizeAddress(chain, b.address)));
  /** Nansen label of each (non-service) funder, by normalised address. */
  const funderLabels = new Map<string, string>();

  for (const b of analysed) {
    const key = normalizeAddress(chain, b.address);
    const lookup = lookups.get(key) ?? { status: "failed" as const };
    if (lookup.status !== "traced") {
      if (lookup.status === "failed") failed++;
      else untraced++;
      untracedMembers.push({ ...b });
      continue;
    }
    const funderAddr = lookup.row.first_funder_address as string;
    const funderKey = normalizeAddress(chain, funderAddr);
    const service = serviceOf(lookup.row.first_funder_name);
    if (service) {
      const id = `${service.kind}:${service.name}`;
      let g = services.get(id);
      if (!g) {
        g = { ...service, members: [] };
        services.set(id, g);
      }
      g.members.push({ ...b, funder: funderAddr, funderLabel: service.name });
      continue;
    }
    // Self-funded: the first gas came from the wallet itself (should not happen, but be explicit).
    if (funderKey === key) {
      wallets.push({ ...b, funder: funderAddr });
      uf.find(`b:${key}`);
      continue;
    }
    // The funder's Nansen entity name only; smart-money / behavioural labels are dropped here.
    const name = publicFunderName(lookup.row.first_funder_name);
    wallets.push(name ? { ...b, funder: funderAddr, funderLabel: name } : { ...b, funder: funderAddr });
    if (lookup.row.first_funder_name) funderLabels.set(funderKey, lookup.row.first_funder_name);
    // A funder that is itself an analysed buyer joins that buyer's group.
    const funderNode = buyerKeys.has(funderKey) ? `b:${funderKey}` : `f:${funderKey}`;
    uf.union(`b:${key}`, funderNode);
  }

  // Group wallet-funded buyers by connected component.
  const groups = new Map<string, BuyerRow[]>();
  for (const b of wallets) {
    const root = uf.find(`b:${normalizeAddress(chain, b.address)}`);
    const list = groups.get(root);
    if (list) list.push(b);
    else groups.set(root, [b]);
  }

  const clusters: SourceCluster[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => b.boughtUsd - a.boughtUsd);
    const selfFunded = members.length === 1 && members[0].funder && normalizeAddress(chain, members[0].funder) === normalizeAddress(chain, members[0].address);
    // Label the group by the funder that funded most of its members.
    const counts = new Map<string, { addr: string; n: number }>();
    for (const m of members) {
      if (!m.funder) continue;
      const k = normalizeAddress(chain, m.funder);
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { addr: m.funder, n: 1 });
    }
    const hub = [...counts.values()].sort((a, b) => b.n - a.n || (a.addr < b.addr ? -1 : 1))[0];
    const usd = members.reduce((s, m) => s + m.boughtUsd, 0);
    const kind: SourceKind = selfFunded ? "self" : "wallet";
    const hubName = hub ? publicFunderName(funderLabels.get(normalizeAddress(chain, hub.addr))) : null;
    clusters.push({
      id: `${kind}:${hub ? normalizeAddress(chain, hub.addr) : normalizeAddress(chain, members[0].address)}`,
      kind,
      label: selfFunded ? "Self-funded" : hub ? (hubName ?? shortAddress(hub.addr)) : "Unknown",
      ...(kind === "wallet" && hub ? { funder: hub.addr } : {}),
      wallets: members.length,
      boughtUsd: usd,
      share: share(usd),
      members,
    });
  }
  for (const [id, g] of services) {
    g.members.sort((a, b) => b.boughtUsd - a.boughtUsd);
    const usd = g.members.reduce((s, m) => s + m.boughtUsd, 0);
    clusters.push({ id, kind: g.kind, label: g.name, wallets: g.members.length, boughtUsd: usd, share: share(usd), members: g.members });
  }
  clusters.sort((a, b) => b.boughtUsd - a.boughtUsd || b.wallets - a.wallets || (a.id < b.id ? -1 : 1));
  if (untracedMembers.length) {
    untracedMembers.sort((a, b) => b.boughtUsd - a.boughtUsd);
    const usd = untracedMembers.reduce((s, m) => s + m.boughtUsd, 0);
    clusters.push({
      id: "untraced",
      kind: "untraced",
      label: "Untraced",
      wallets: untracedMembers.length,
      boughtUsd: usd,
      share: share(usd),
      members: untracedMembers,
    });
  }

  const serviceFunded = [...services.values()].reduce((s, g) => s + g.members.length, 0);
  const sources = groups.size + serviceFunded;
  const walletClusters = clusters.filter((c) => c.kind === "wallet" || c.kind === "self");
  const biggest = walletClusters.reduce<SourceCluster | null>((best, c) => (!best || c.share > best.share ? c : best), null);
  const hubs = clusters.filter((c) => c.kind !== "untraced");
  const maxHub = hubs.reduce<SourceCluster | null>((best, c) => (!best || c.wallets > best.wallets ? c : best), null);
  const n = analysed.length;
  const biggestGroup = walletClusters.reduce<SourceCluster | null>((best, c) => (!best || c.wallets > best.wallets ? c : best), null);
  const hubKey = biggestGroup && biggestGroup.kind === "wallet" ? biggestGroup.id.slice("wallet:".length) : null;
  const hubAddress = hubKey ? (biggestGroup!.members.find((m) => m.funder && normalizeAddress(chain, m.funder) === hubKey)?.funder ?? hubKey) : null;

  return {
    clusters,
    sources,
    traced: n - untraced - failed,
    untraced,
    failed,
    untracedShare: n > 0 ? (untraced + failed) / n : 0,
    biggestSourceShare: biggest ? clamp01(biggest.share) : 0,
    biggestSourceWallets: biggest ? biggest.wallets : 0,
    maxHubShare: maxHub && n > 0 ? maxHub.wallets / n : 0,
    maxHubLabel: maxHub ? maxHub.label : null,
    walletHub: {
      address: hubAddress,
      label: hubKey ? (funderLabels.get(hubKey) ?? null) : null,
      wallets: biggestGroup ? biggestGroup.wallets : 0,
    },
  };
}

export function classifyDemand(
  c: { sources: number; traced: number; biggestSourceShare: number },
  rules: PipelineRules["demand"],
): BuyersFinding["demand"] {
  const ratio = c.traced > 0 ? c.sources / c.traced : 1;
  if (c.biggestSourceShare >= rules.concentratedSourceShare || ratio < rules.concentratedRatio) return "concentrated";
  if (ratio >= rules.organicRatio && c.biggestSourceShare < rules.organicMaxSourceShare) return "organic";
  return "mixed";
}

/** Demand from buy-volume concentration alone (no funder tracing). */
export function classifyConcentration(top10Share: number, rules: PipelineRules["demand"]): BuyersFinding["demand"] {
  if (top10Share >= rules.top10Concentrated) return "concentrated";
  if (top10Share < rules.top10Organic) return "organic";
  return "mixed";
}

export function topShare(prepared: PreparedBuyers, n: number): number {
  if (!(prepared.totalBuyUsd > 0)) return 0;
  return clamp01(prepared.buyers.slice(0, n).reduce((s, b) => s + b.boughtUsd, 0) / prepared.totalBuyUsd);
}

function pctText(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export type TracingSkipReason = "quick" | "non_evm" | "unavailable";

/** Finding 01 without funder tracing: how concentrated this week's buying is. */
export function concentrationFinding(
  prepared: PreparedBuyers,
  reason: TracingSkipReason,
  rules: PipelineRules["demand"],
  buyers24h?: number | null,
): BuyersFinding {
  const n = Math.min(10, prepared.buyers.length);
  const top10 = topShare(prepared, 10);
  const lead =
    reason === "non_evm"
      ? "Funding sources are not traced on this chain (first-funder is EVM-only)."
      : reason === "quick"
        ? "Funding sources are traced in the deep scan."
        : "Funder tracing was unavailable for this scan.";
  const capped = prepared.capped ? ` ${capNote(prepared, buyers24h)}` : "";
  const topOne = prepared.buyers[0] && prepared.totalBuyUsd > 0 ? prepared.buyers[0].boughtUsd / prepared.totalBuyUsd : 0;
  const count = buyerCount(prepared, buyers24h);
  return {
    status: prepared.buyers.length ? "partial" : "unavailable",
    windowDays: BUYERS_WINDOW_DAYS,
    totalBuyers: count.total,
    ...(count.capped ? { totalBuyersCapped: true } : {}),
    topBuyers: n,
    topShare: top10,
    sources: 0,
    untracedShare: 0,
    // Without tracing the "largest source" is the largest single buyer, as a share of all buying.
    biggestSourceShare: clamp01(topOne),
    biggestSourceWallets: n ? 1 : 0,
    clusters: [],
    demand: prepared.buyers.length ? classifyConcentration(top10, rules) : "mixed",
    // Addresses and amounts only (who-bought-sold labels are never kept, see prepareBuyers).
    largestBuyers: prepared.buyers.slice(0, n).map(publicBuyer),
    note: prepared.buyers.length
      ? `${lead} The top ${n} buyers did ${pctText(top10)} of this week's buying.${capped}`
      : `${lead} No DEX buyers were found in the last ${BUYERS_WINDOW_DAYS} days.`,
  };
}

/** Finding 01 from traced buyers. Falls back to concentration when too few lookups succeeded. */
export function tracedFinding(
  prepared: PreparedBuyers,
  analysed: BuyerRow[],
  clustering: Clustering,
  rules: PipelineRules["demand"],
  buyers24h?: number | null,
): BuyersFinding {
  if (clustering.traced + clustering.untraced === 0) return concentrationFinding(prepared, "unavailable", rules, buyers24h);
  const analysedUsd = analysed.reduce((s, b) => s + b.boughtUsd, 0);
  const partial = clustering.untracedShare > 0.4 || clustering.failed > 0;
  const notes: string[] = [];
  if (prepared.capped) notes.push(capNote(prepared, buyers24h));
  if (clustering.failed > 0) notes.push(`${clustering.failed} funder lookups failed and are counted as untraced.`);
  const count = buyerCount(prepared, buyers24h);
  const finding: BuyersFinding = {
    status: partial ? "partial" : "ok",
    windowDays: BUYERS_WINDOW_DAYS,
    totalBuyers: count.total,
    ...(count.capped ? { totalBuyersCapped: true } : {}),
    topBuyers: analysed.length,
    topShare: prepared.totalBuyUsd > 0 ? clamp01(analysedUsd / prepared.totalBuyUsd) : 0,
    sources: clustering.sources,
    untracedShare: clamp01(clustering.untracedShare),
    biggestSourceShare: clustering.biggestSourceShare,
    biggestSourceWallets: clustering.biggestSourceWallets,
    // Buyer and funder addresses with public funder names; no wallet labels (lib/xray/redact.ts).
    clusters: publicClusters(clustering.clusters),
    demand: classifyDemand(clustering, rules),
  };
  if (notes.length) finding.note = notes.join(" ");
  return finding;
}

export function emptyBuyersFinding(message: string): BuyersFinding {
  return {
    status: "unavailable",
    windowDays: BUYERS_WINDOW_DAYS,
    totalBuyers: 0,
    topBuyers: 0,
    topShare: 0,
    sources: 0,
    untracedShare: 0,
    biggestSourceShare: 0,
    biggestSourceWallets: 0,
    clusters: [],
    demand: "mixed",
    note: message,
  };
}
