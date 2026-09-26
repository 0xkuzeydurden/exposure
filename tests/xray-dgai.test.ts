// DGAI (bnb:0x10d4…bd5e): the real smoke test that exposed two data problems:
//   1. tgm/token-information came back with name "", symbol "", market cap / FDV / supply / liquidity 0;
//   2. of the 20 holders asked for profiler pnl only 6 had a usable cost: four top holders are
//      allocations (cost_basis_usd 0, bought_usd 0) and 9 returned data: [].
// Every payload here is copied from the smoke test's disk cache (.cache/nansen, 2026-09-26) into
// tests/fixtures/dgai-bnb-cache.json, keyed by the request hash the client computes (large lists trimmed
// to the fields the pipeline reads: holders to the top 300, numbers to 10 significant digits).
// Nothing here touches the network: the offline replay serves the fixture through the real disk cache
// and a strict fetch stub (the token-screener lookup, the 30-day buyer list and the never-fetched pnl
// calls are stubs, noted below; search/general must never be called).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cacheKey } from "../lib/nansen/cache";
import { configureNansenClient } from "../lib/nansen/client";
import { tokenLookupBody } from "../lib/nansen/api";
import {
  AddressPnlResponse,
  HoldersResponse,
  TokenInformationResponse,
  TokenScreenerRow,
  WhoBoughtSoldResponse,
  type HolderRow,
  type PnlRow,
} from "../lib/nansen/schemas";
import { deriveHolder, isAllocationRecord, pickPnlRecord, selectHolders } from "../lib/pipeline/derive";
import type { HolderPoint } from "../lib/types";
import { lineFor, noteFor, stageMessage } from "../lib/xray/copy";
import { buyersTotalText, wallsAnalysedWho, wallsMethod } from "../lib/xray/lab";
import { buyerCount, capNote, prepareBuyers } from "../lib/xray/pipeline/buyers";
import { estimateCredits } from "../lib/xray/budget";
import { allocationNote } from "../lib/xray/copy";
import { buildMeta, missingMeta, needsTokenLookup, scanSupply, screenerMatch, totalSupplyOf } from "../lib/xray/pipeline/context";
import { hintKey, hintsFromScreenerRow, loadScreenerCacheHints, mergeHints, parseHints } from "../lib/xray/pipeline/hints";
import { PLAN_RULES } from "../lib/xray/pipeline/rules";
import { runScanDetailed } from "../lib/xray/pipeline/run";
import {
  blendRecentBuyers,
  buildWallsFinding,
  buyerKeys,
  isAllocationLabel,
  planPnlHolders,
  pnlCostCoverage,
  preSkipReason,
  recentBuyerEntries,
  totalShareOf,
  type KeyedHolder,
} from "../lib/xray/pipeline/walls";
import type { PricePoint, WallsFinding } from "../lib/xray/types";

// Untyped JSON (the fixture file, mocked request bodies).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const CHAIN = "bnb";
const TOKEN = "0x10d4183389e99233db3cc981c43443ebd28ebd5e";
const FIXTURE = JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "dgai-bnb-cache.json"), "utf8")) as {
  entries: Record<string, { endpoint: string; fetchedAt: number; data: Loose }>;
};
const ENTRIES = Object.values(FIXTURE.entries);
const entry = (endpoint: string, pick: (d: Loose) => boolean = () => true) => {
  const e = ENTRIES.find((x) => x.endpoint === endpoint && pick(x.data));
  if (!e) throw new Error(`fixture has no ${endpoint}`);
  return e.data;
};

const INFO = TokenInformationResponse.parse(entry("tgm/token-information")).data;
const HOLDERS = HoldersResponse.parse(entry("tgm/holders")).data;
const WEEK = WhoBoughtSoldResponse.parse(entry("tgm/who-bought-sold", (d) => d.data.length > 100));
/** The cached token-screener row (from the trending shortlist): the same row a lookup by address returns. */
const SCREENER_RAW = entry("token-screener").data[0];
const SCREENER = TokenScreenerRow.parse(SCREENER_RAW);
/** The film's last close in the smoke test (tgm/token-ohlcv). */
const PRICE_NOW = 1.031566627;
const FILM: PricePoint[] = [{ t: Date.parse("2026-09-26T00:00:00Z"), c: PRICE_NOW }];
const CIRCULATING = (SCREENER.market_cap_usd as number) / (SCREENER.price_usd as number);
/** FDV ÷ price: the 1B total supply that ownership_percentage is a share of. */
const TOTAL = (SCREENER.fdv as number) / (SCREENER.price_usd as number);

/** The 20 holders the smoke test asked for profiler pnl (the top 20 by balance), with their cached answers. */
const ASKED = HOLDERS.slice(0, 20).map((h) => {
  const key = (h.address as string).toLowerCase();
  const hit = FIXTURE.entries[cacheKey("profiler/address/pnl", { chain: CHAIN, token: TOKEN, address: key, window: "full" })];
  if (!hit) throw new Error(`no cached pnl for ${key}`);
  return { row: h, key, pnl: AddressPnlResponse.parse(hit.data).data as PnlRow[] };
});

function derived(a: (typeof ASKED)[number], i: number, supply: number | null, allocationAllowed?: boolean): HolderPoint {
  const scale = 1; // ownership_percentage arrives as a 0..1 fraction here
  return deriveHolder({
    allocationAllowed,
    id: i,
    cohort: "other",
    chain: CHAIN,
    tokenAddress: TOKEN,
    address: a.row.address as string,
    label: a.row.address_label,
    tokenAmount: a.row.token_amount as number,
    ownershipPct: a.row.ownership_percentage,
    ownershipScale: scale,
    supply,
    priceNow: PRICE_NOW,
    pnlRows: a.pnl,
  });
}

// ------------------------------------------------------------------ 1 · meta fallback

describe("DGAI · meta fallback (token-information returned \"\" and 0)", () => {
  it("treats every \"\" and 0 as missing and asks token-screener once", () => {
    expect(INFO.symbol).toBe("");
    expect(INFO.token_details.market_cap_usd).toBe(0);
    expect(missingMeta(INFO)).toEqual({ symbol: true, name: true, marketCap: true, supply: true, liquidity: true });
    expect(needsTokenLookup(INFO)).toBe(true);
    // The screener row already has symbol, market cap (so supply) and liquidity: no lookup needed.
    expect(needsTokenLookup(INFO, hintsFromScreenerRow(SCREENER))).toBe(false);
    // Liquidity alone is still worth the lookup; a missing name alone is not (the screener has no name).
    expect(needsTokenLookup(INFO, { symbol: "DGAI", marketCapUsd: 150_000_000, priceUsd: 1 })).toBe(true);
    expect(needsTokenLookup(INFO, { symbol: "DGAI", marketCapUsd: 150_000_000, priceUsd: 1, liquidityUsd: 1_600_000 })).toBe(false);
  });

  const base = { chain: CHAIN, tokenAddress: TOKEN, info: INFO, price: FILM, scanNo: 2, now: new Date("2026-09-26T00:54:00Z"), windowFrom: "a", windowTo: "b" };

  it("before: token-information alone gives no symbol and no supply (never 0, never a throw)", () => {
    const meta = buildMeta(base);
    expect(meta).toMatchObject({ symbol: "?", name: TOKEN, marketCapUsd: null, circulatingSupply: null, liquidityUsd: null, deployedAt: null });
    expect(meta.logo).toBeUndefined();
    expect(meta).toMatchObject({ holders: 7189, buyers24h: 467, sellers24h: 563 });
    expect(scanSupply(meta, INFO)).toBeNull();
    expect(totalSupplyOf(INFO)).toBeNull();
  });

  it("the token-screener row is matched on chain + address and fills symbol, market cap, supply, liquidity and the deployment date", () => {
    const rows = [
      { ...SCREENER, chain: "ethereum", market_cap_usd: 9 },
      { ...SCREENER, token_address: "0x10d4183389e99233db3cc981c43443ebd28ebd5f", token_symbol: "DGAl" },
      { ...SCREENER, token_address: TOKEN.toUpperCase().replace("0X", "0x") },
    ];
    expect(screenerMatch(rows, CHAIN, TOKEN)?.token_symbol).toBe("DGAI");
    expect(screenerMatch(rows, CHAIN, TOKEN)?.chain).toBe("bnb");
    expect(screenerMatch(rows.slice(0, 2), CHAIN, TOKEN)).toBeNull(); // wrong chain, lookalike address
    expect(screenerMatch([{ ...SCREENER, chain: "bsc" }], CHAIN, TOKEN)).not.toBeNull();
    expect(screenerMatch(null, CHAIN, TOKEN)).toBeNull();
    const hints = mergeHints(null, hintsFromScreenerRow(screenerMatch(rows, CHAIN, TOKEN)!));
    const meta = buildMeta({ ...base, hints });
    expect(meta).toMatchObject({ symbol: "DGAI", name: "DGAI", deployedAt: "2026-08-18T07:24:58.000Z" });
    expect(meta.marketCapUsd).toBeCloseTo(154_422_060.67, 0);
    // circulating = market cap ÷ the price it was computed at (≈ 15% of the 1B total supply).
    expect(meta.circulatingSupply).toBeCloseTo(CIRCULATING, 0);
    expect(meta.circulatingSupply! / 1e6).toBeCloseTo(150.04, 1);
    expect(meta.liquidityUsd).toBeCloseTo(1_624_306.54, 1);
    expect(scanSupply(meta, INFO)).toBeCloseTo(CIRCULATING, 0);
    // total = FDV ÷ price: the unit of ownership_percentage.
    expect(totalSupplyOf(INFO, hints)! / 1e9).toBeCloseTo(1, 3);
  });

  it("mergeHints: the caller's hints win, the lookup fills the gaps, a market cap keeps its own price", () => {
    const merged = mergeHints({ symbol: "MINE", marketCapUsd: 150_000_000 }, hintsFromScreenerRow(SCREENER));
    expect(merged).toMatchObject({ symbol: "MINE", marketCapUsd: 150_000_000, deployedAt: "2026-08-18T07:24:58.000Z" });
    expect(merged?.liquidityUsd).toBeCloseTo(1_624_306.54, 1);
    // The caller's market cap came without a price: the screener's price must not be paired with it.
    expect(merged?.priceUsd).toBeUndefined();
    expect(mergeHints(null, hintsFromScreenerRow(SCREENER))?.priceUsd).toBeCloseTo(SCREENER.price_usd as number);
    expect(mergeHints(null, null)).toBeNull();
  });

  it("market cap ÷ priceNow when the source has no price of its own", () => {
    const meta = buildMeta({ ...base, hints: { symbol: "DGAI", marketCapUsd: 150_000_000 } });
    expect(meta.circulatingSupply).toBeCloseTo(150_000_000 / PRICE_NOW, 0);
  });

  it("hints from the cached token-screener row fill liquidity and the deployment date too", () => {
    const hints = hintsFromScreenerRow(SCREENER);
    expect(hints).toMatchObject({ symbol: "DGAI", deployedAt: "2026-08-18T07:24:58.000Z" });
    const meta = buildMeta({ ...base, hints });
    expect(meta.symbol).toBe("DGAI");
    expect(meta.liquidityUsd).toBeCloseTo(1_624_306.54, 1);
    expect(meta.deployedAt).toBe("2026-08-18T07:24:58.000Z");
    expect(meta.circulatingSupply).toBeCloseTo(CIRCULATING, 0);
  });

  it("without a film the hints' price is the last resort; nothing throws on empty meta", () => {
    expect(buildMeta({ ...base, price: [], hints: { priceUsd: 1.02 } }).priceNow).toBe(1.02);
    expect(buildMeta({ ...base, price: [], hints: hintsFromScreenerRow(SCREENER) }).priceNow).toBeCloseTo(SCREENER.price_usd as number);
    expect(buildMeta({ ...base, info: null, price: [] })).toMatchObject({ symbol: "?", priceNow: 0, circulatingSupply: null });
  });

  it("hints parse from a screener cache entry, a row array or a map; the cache loader reads files only", async () => {
    const fromEntry = parseHints(ENTRIES.find((e) => e.endpoint === "token-screener"));
    expect(fromEntry.get(hintKey("bnb", TOKEN.toUpperCase().replace("0X", "0x")))).toMatchObject({ symbol: "DGAI" });
    expect(parseHints([entry("token-screener").data[0]]).size).toBe(1);
    const map = parseHints({ [`bnb:${TOKEN}`]: { symbol: " DGAI ", marketCapUsd: 0, liquidityUsd: "1600000", bogus: 1 }, junk: 1 });
    expect(map.get(`bnb:${TOKEN}`)).toEqual({ symbol: "DGAI", liquidityUsd: 1_600_000 });
    expect(parseHints("nope").size).toBe(0);
    const dir = mkdtempSync(path.join(tmpdir(), "dgai-hints-"));
    try {
      for (const [hash, e] of Object.entries(FIXTURE.entries)) if (e.endpoint === "token-screener") writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(e));
      writeFileSync(path.join(dir, "junk.json"), "{");
      const loaded = await loadScreenerCacheHints(dir);
      expect(loaded.get(`bnb:${TOKEN}`)?.marketCapUsd).toBeCloseTo(154_422_060.67, 0);
      expect((await loadScreenerCacheHints(path.join(dir, "missing"))).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ 2 · walls coverage

const holderRow = (address: string, amount: number, extra: Partial<HolderRow> = {}): HolderRow => ({
  address,
  address_label: null,
  token_amount: amount,
  total_inflow: null,
  total_outflow: null,
  balance_change_24h: null,
  balance_change_7d: null,
  balance_change_30d: null,
  ownership_percentage: null,
  value_usd: null,
  ...extra,
});
const hex = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("DGAI · walls on the same 20 holders the smoke test asked", () => {
  it("an allocation needs bought_usd 0 and cost_basis_usd 0 over the whole history: 4 of the 20 answers", () => {
    const alloc = ASKED.flatMap((a, i) => (isAllocationRecord(pickPnlRecord(a.pnl, CHAIN, TOKEN), PRICE_NOW) ? [i] : []));
    // #1-#3: 150M / 100M / 100M received once; #4 received 70M and has been selling.
    expect(alloc).toEqual([1, 2, 3, 4]);
    expect(derived(ASKED[1], 1, null).fog).toBe("allocation");
    // #6 recorded $0.001 of buys (a dust cost of 4e-11): any recorded buy rules out "allocation".
    expect(pickPnlRecord(ASKED[6].pnl, CHAIN, TOKEN)?.bought_usd).toBeGreaterThan(0);
    expect(derived(ASKED[6], 6, null).fog).toBe("out_of_range");
    // #0 holds 500M, more than the circulating supply, but bought $33M at $0.067: not "received".
    expect(isAllocationRecord(pickPnlRecord(ASKED[0].pnl, CHAIN, TOKEN), PRICE_NOW)).toBe(false);
    // Over a window shorter than the token's life (or for a known DEX buyer) the same zero record is "no_cost".
    expect(derived(ASKED[1], 1, null, false)).toMatchObject({ fog: "no_cost", cost: null });
    expect(ASKED.filter((a) => a.pnl.length === 0)).toHaveLength(9);
  });

  it("before → after: only the non-circulating holder is skipped, pnl finds the allocations, the rest keep their cost", () => {
    // Before (the smoke test): no supply (market cap 0), every answer a holder.
    const beforeHolders = ASKED.map((a, i) => derived(a, i, null));
    const before = buildWallsFinding(
      { method: "cost_basis", holders: beforeHolders, holdersAnalyzed: 20, priceNow: PRICE_NOW, liquidityUsd: null, supply: null, price: FILM },
      PLAN_RULES.ceiling,
    );
    expect(beforeHolders.filter((h) => h.cost !== null)).toHaveLength(6);
    expect(before.analyzedSupplyShare).toBeCloseTo(0.549, 3); // what the smoke test printed
    expect(pnlCostCoverage(beforeHolders)).toBeCloseTo(0.55, 2);
    expect(before.status).toBe("partial");

    // After: supply known (≈150M circulating). #0 holds 500M (> circulating): skipped before pnl.
    const supply = CIRCULATING;
    const skipped = ASKED.flatMap((a, i) => (preSkipReason(a.row.address_label, a.row.token_amount as number, supply, false) ? [i] : []));
    expect(skipped).toEqual([0]);
    expect(preSkipReason(null, 500_000_000, supply, false)).toBe("exceeds_circulating");
    expect(preSkipReason(null, 500_000_000, supply, true)).toBeNull(); // a known DEX buyer is never skipped
    // #1 received its balance once and never sent any, exactly like a DEX buyer who never sold
    // (total_inflow counts DEX buys): transfer history alone skips nobody; pnl decides.
    expect(ASKED[1].row).toMatchObject({ total_inflow: 150_000_000, total_outflow: 0 });
    expect(preSkipReason(ASKED[1].row.address_label, 150_000_000, supply, false)).toBeNull();
    const after = ASKED.map((a, i) => ({ i, h: derived(a, i, supply) })).filter(({ i, h }) => !skipped.includes(i) && h.fog !== "allocation");
    expect(after.map((x) => x.i)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const afterHolders = after.map((x) => x.h);
    // Share of TOTAL supply: ownership_percentage (0..1 here) of #0 (skipped) and #1-#4 (pnl).
    const allocatedShare = [0, 1, 2, 3, 4].reduce((s, i) => s + (totalShareOf(ASKED[i].row.ownership_percentage, 1, ASKED[i].row.token_amount as number, TOTAL) ?? 0), 0);
    expect(allocatedShare).toBeCloseTo(0.8955, 3);
    const walls = buildWallsFinding(
      {
        method: "cost_basis",
        holders: afterHolders,
        holdersAnalyzed: 19,
        priceNow: PRICE_NOW,
        liquidityUsd: SCREENER.liquidity,
        supply,
        price: FILM,
        extra: { costBasisHolders: 5, allocatedShare },
      },
      PLAN_RULES.ceiling,
    );
    expect(afterHolders.filter((h) => h.cost !== null)).toHaveLength(5);
    expect(afterHolders.some((h) => h.fog === "allocation")).toBe(false);
    // Now a share of the ≈150M circulating supply (before: of the 1B total).
    expect(walls.analyzedSupplyShare).toBeCloseTo(0.3285, 3);
    expect(walls.allocatedShare).toBeCloseTo(0.8955, 3);
    // #6 (24M tokens, dust cost) stays fog, so the 9 empty answers decide the coverage: with the
    // deployment date (token-screener) they are contracts without history and leave the denominator.
    expect(pnlCostCoverage(afterHolders)).toBeCloseTo(0.494, 2);
    expect(pnlCostCoverage(afterHolders.filter((h) => h.fog !== "no_cost"))).toBeCloseTo(0.67, 2);
  });

  it("plans the next 20 pnl calls: only the non-circulating holder skipped, this week's DEX buyers first, the largest holders too", () => {
    const recent = buyerKeys(WEEK.data, CHAIN, TOKEN);
    const input = { chain: CHAIN, tokenAddress: TOKEN, rows: HOLDERS, recentBuyers: recent, maxHolders: 20, supply: CIRCULATING, totalSupply: TOTAL };
    const plan = planPnlHolders(input);
    expect(plan.skipped.map((s) => [s.key, s.reason])).toEqual([[ASKED[0].key, "exceeds_circulating"]]);
    expect(plan.skippedShare).toBeCloseTo(0.5, 3);
    expect(plan.ownershipScale).toBe(1);
    expect(plan.spared).toBe(0);
    expect(plan.chosen).toHaveLength(20);
    // (a) recent buyers by balance (half the budget: here they are dust wallets), then (b) the rest by balance.
    const a = plan.chosen.slice(0, 10);
    const b = plan.chosen.slice(10);
    expect(a.every((h) => h.recentBuyer && recent.has(h.key))).toBe(true);
    expect(a.map((h) => h.tokenAmount)).toEqual([...a.map((h) => h.tokenAmount)].sort((x, y) => y - x));
    expect(a[0].key).toBe((HOLDERS[28].address as string).toLowerCase());
    // #1-#3 ("received once, never sent") are asked now: pnl, not transfer history, decides.
    expect(b.map((h) => h.key)).toEqual(ASKED.slice(1, 11).map((x) => x.key));
    expect(plan.recentEligible).toBeGreaterThan(10);
    // ids rank the chosen holders by balance (0 = largest).
    expect(plan.chosen.find((h) => h.key === ASKED[1].key)?.id).toBe(0);
    expect(new Set(plan.chosen.map((h) => h.id)).size).toBe(20);

    // A holder in the 30-day buyer list is spared: asked (still capped at 20 calls), never skipped.
    const spared = planPnlHolders({ ...input, knownBuyers: new Set([...recent, ASKED[0].key]) });
    expect(spared.skipped).toEqual([]);
    expect(spared.spared).toBe(1);
    expect(spared.chosen).toHaveLength(20);
    expect(spared.chosen.find((h) => h.key === ASKED[0].key)?.id).toBe(0);

    // Without a supply nothing here can be skipped (no allocation labels among DGAI's holders).
    expect(planPnlHolders({ ...input, supply: null }).skipped).toEqual([]);
  });

  it("allocation labels skip team / foundation / deployer wallets and vesting / treasury / lock contracts, never a buyer", () => {
    for (const l of ["DGAI: Team", "Arbitrum Foundation", "Token Deployer", "Team Vesting", "DAO Treasury", "Team Finance: Lock", "Unicrypt Locker"]) {
      expect(isAllocationLabel(l)).toBe(true);
    }
    for (const l of ["Steam Collector", "Blockchain Capital", "Token Millionaire", "PancakeSwap V3: Pool", null]) expect(isAllocationLabel(l)).toBe(false);
    const rows = [
      holderRow(hex(1), 5000, { address_label: "DGAI: Team Vesting", ownership_percentage: 0.05 }),
      holderRow(hex(2), 4000, { address_label: "Token Deployer" }),
      holderRow(hex(3), 3000, { address_label: "PancakeSwap V3: Pool" }),
      holderRow(hex(4), 2500, { address_label: "Binance 14" }),
      holderRow(hex(5), 2000, { address_label: "Deployer Wallet" }),
      holderRow(hex(6), 1000),
    ];
    // hex(5) is a known DEX buyer: never skipped, whatever its label.
    const plan = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows, recentBuyers: new Set(), knownBuyers: new Set([hex(5)]), maxHolders: 10, supply: null, totalSupply: 100_000 });
    expect(plan.skipped.map((x) => [x.key, x.reason, x.ownership])).toEqual([
      [hex(1), "allocation_label", 0.05],
      // No ownership_percentage: balance ÷ TOTAL supply (never ÷ circulating).
      [hex(2), "allocation_label", 0.04],
    ]);
    expect(plan.skippedShare).toBeCloseTo(0.09);
    expect(plan.spared).toBe(1);
    // Pools and exchanges stay plain exclusions: not asked, not counted as allocations.
    expect(plan.chosen.map((h) => h.key)).toEqual([hex(5), hex(6)]);
    expect(plan.excluded).toEqual({ exchange: 1, contract: 1 });
    // Without a total supply, the rows that carry an ownership imply it (5,000 at 5% = 100,000)...
    const implied = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows, recentBuyers: new Set(), maxHolders: 10, supply: 50_000, totalSupply: null });
    expect(implied.totalSupply).toBe(100_000);
    expect(implied.skipped.find((x) => x.key === hex(2))?.ownership).toBeCloseTo(0.04);
    // ... and without any ownership the share is unknown (counted 0), never balance ÷ circulating supply.
    const bare = rows.map((r) => ({ ...r, ownership_percentage: null }));
    const blind = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows: bare, recentBuyers: new Set(), maxHolders: 10, supply: 50_000, totalSupply: null });
    expect(blind.totalSupply).toBeNull();
    expect(blind.skipped.map((x) => [x.key, x.ownership])).toEqual([[hex(1), null], [hex(2), null], [hex(5), null]]);
    expect(blind.skippedShare).toBe(0);
    expect(totalShareOf(null, 1, 4000, null)).toBeNull();
    expect(totalShareOf(2, 100, 4000, 1_000_000)).toBe(0.02);
  });

  it("budget split: unused recent-buyer slots go to the largest holders and vice versa", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => holderRow(hex(n), 1000 * (7 - n), n === 6 ? { address_label: "PancakeSwap V3: Pool" } : {}));
    const one = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows, recentBuyers: new Set([hex(5)]), maxHolders: 4, supply: null });
    expect(one.chosen.map((h) => h.key)).toEqual([hex(5), hex(1), hex(2), hex(3)]);
    const many = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows, recentBuyers: new Set([hex(2), hex(3), hex(4), hex(5)]), maxHolders: 4, supply: null });
    expect(many.chosen.map((h) => h.key)).toEqual([hex(2), hex(3), hex(4), hex(1)]);
    // A pool is never asked.
    expect(many.chosen.some((h) => h.key === hex(6))).toBe(false);
    // selectHolders is untouched: the legacy scene still takes the top N by balance.
    expect(selectHolders({ chain: CHAIN, tokenAddress: TOKEN, allHolders: rows, whales: [], publicFigures: [], exchanges: [], smartMoney: [], maxHolders: 2, supply: null }).chosen.map((c) => c.key)).toEqual([hex(1), hex(2)]);
  });

  it("review probe: a 3% whale that bought on a DEX 12 days ago and never sold is asked, priced, and kept in the blend", () => {
    const whale = hex(0xa11);
    // tgm/holders: received its whole balance, never sent any (a DEX buy counts as inflow).
    const rows = [holderRow(whale, 30_000, { total_inflow: 30_000, total_outflow: 0, ownership_percentage: 0.03 }), holderRow(hex(0xb1), 1000), holderRow(hex(0xb2), 500)];
    const month = WhoBoughtSoldResponse.parse({ data: [{ address: whale, bought_token_volume: 30_000, bought_volume_usd: 36_000 }], pagination: {} }).data;
    const known = buyerKeys(month, CHAIN, TOKEN);
    // Not a 7-day buyer, and the transfer history is no reason to skip it: it gets a pnl call.
    for (const knownBuyers of [undefined, known]) {
      const plan = planPnlHolders({ chain: CHAIN, tokenAddress: TOKEN, rows, recentBuyers: new Set(), knownBuyers, maxHolders: 2, supply: 1_000_000, totalSupply: 1_000_000 });
      expect(plan.skipped).toEqual([]);
      expect(plan.chosen[0].key).toBe(whale);
    }
    const pnl = (r: Partial<PnlRow>): PnlRow[] => AddressPnlResponse.parse({ data: [{ token_address: TOKEN, holding_amount: 30_000, ...r }] }).data;
    const ask = (rowsIn: PnlRow[], allocationAllowed: boolean) =>
      deriveHolder({ id: 0, cohort: "other", chain: CHAIN, tokenAddress: TOKEN, address: whale, label: null, tokenAmount: 30_000, ownershipPct: 0.03, ownershipScale: 1, supply: 1_000_000, priceNow: 1, pnlRows: rowsIn, allocationAllowed });
    // pnl records the buy: a cost basis, never an allocation.
    const bought = ask(pnl({ holding_usd: 30_000, pnl_usd_unrealised: 30_000 - 36_000, bought_usd: 36_000, cost_basis_usd: 1.2 }), true);
    expect(bought).toMatchObject({ fog: null, cost: 1.2 });
    // A zero record for a known buyer (e.g. a 90-day fallback window) is "no_cost", and the 30-day proxy prices it.
    const zero = ask(pnl({ holding_usd: 30_000, pnl_usd_unrealised: 30_000, bought_usd: 0, cost_basis_usd: 0 }), false);
    expect(zero.fog).toBe("no_cost");
    const blend = blendRecentBuyers([{ key: whale, point: zero }], recentBuyerEntries(month, CHAIN, TOKEN, 1_000_000, 1));
    expect(blend).toMatchObject({ recentBuyers: 1, costBasisHolders: 0 });
    expect(blend.holders).toHaveLength(1);
    expect(blend.holders[0]).toMatchObject({ amount: 30_000, cost: 1.2 });
  });
});

// ------------------------------------------------------------------ 2b · hybrid walls

function point(id: number, amount: number, cost: number | null, fog: HolderPoint["fog"] = cost === null ? "no_cost" : null): HolderPoint {
  return { id, cohort: "other", amount, supplyShare: amount / 1_000_000, cost, multiple: cost ? 1 / cost : null, conviction: 1, maxHeld: amount, buys: 1, sells: 0, fog };
}

describe("hybrid walls (pnl covers < 50%)", () => {
  const pnl: KeyedHolder[] = [
    { key: "a", point: point(0, 1_000, 1.2) },
    { key: "b", point: point(1, 9_000, null) },
  ];
  const proxy: KeyedHolder[] = [
    { key: "a", point: point(0, 800, 1.5) }, // already costed by pnl: skipped
    { key: "b", point: point(1, 500, 1.1) }, // pnl had no cost: the proxy replaces the fog point
    { key: "c", point: point(2, 2_000, 1.3) },
    { key: "c", point: point(3, 2_000, 1.3) }, // duplicate row
    { key: "d", point: point(4, 7_000, 1.25) }, // a 30-day buyer pnl never saw: blended in (nothing is excluded)
  ];

  it("blends in only buyers pnl did not price, never counting a wallet twice", () => {
    expect(pnlCostCoverage(pnl.map((e) => e.point))).toBeCloseTo(0.1);
    const blend = blendRecentBuyers(pnl, proxy);
    expect(blend.costBasisHolders).toBe(1);
    expect(blend.recentBuyers).toBe(3);
    expect(blend.holders.map((h) => [h.amount, h.cost])).toEqual([
      [1_000, 1.2],
      [500, 1.1],
      [2_000, 1.3],
      [7_000, 1.25],
    ]);
    expect(new Set(blend.holders.map((h) => h.id)).size).toBe(4);
  });

  it("the finding and every UI string say hybrid", () => {
    const blend = blendRecentBuyers(pnl, proxy);
    const w = buildWallsFinding(
      {
        method: "hybrid",
        holders: blend.holders,
        holdersAnalyzed: 2 + blend.recentBuyers,
        priceNow: 1,
        liquidityUsd: 10_000,
        supply: 1_000_000,
        price: [],
        extra: { costBasisHolders: blend.costBasisHolders, recentBuyers: blend.recentBuyers, allocatedShare: 0.42 },
      },
      PLAN_RULES.ceiling,
    );
    expect(w).toMatchObject({ method: "hybrid", costBasisHolders: 1, recentBuyers: 3, allocatedShare: 0.42, holdersAnalyzed: 5 });
    expect(w.walls.length).toBeGreaterThan(0);

    const example: WallsFinding = { ...w, costBasisHolders: 14, recentBuyers: 38 };
    expect(noteFor(3, example)).toMatch(
      /^Entry prices from 14 holders' on-chain cost basis and 38 recent buyers' average prices\. They cover \d+% of supply; \d+% of it is underwater\. 42% of total supply is left out: tokens received, not bought on a DEX \(team, vesting, airdrops or exchange withdrawals\), or held outside the circulating supply\.$/,
    );
    expect(noteFor(3, { ...example, costBasisHolders: 1, recentBuyers: 1, allocatedShare: 0.004 })).toMatch(
      /^Entry prices from 1 holder's on-chain cost basis and 1 recent buyer's average prices\..* 0\.4% of total supply is left out:/,
    );
    // Never "received rather than bought" for all of it: part of it is skipped without a pnl answer.
    expect(allocationNote(example)).not.toMatch(/rather than bought|allocations \(/);
    expect(lineFor(3, example)).toMatch(/get back to break-even at/);
    expect(stageMessage("walls", { findings: { walls: example } } as never)).toBe("Reading holders' entry prices");
    expect(wallsMethod(example)).toEqual({ value: "Hybrid", sub: "14 holders' P&L + 38 recent buyers" });
    expect(wallsAnalysedWho(example)).toBe("14 holders + 38 buyers");
    expect(wallsMethod({ method: "cost_basis" })).toEqual({ value: "Cost basis", sub: "holders' profiler P&L" });
    expect(wallsMethod({ method: "recent_buyers" }).value).toBe("Recent buyers");
    // cost_basis names the holders that actually had a cost basis.
    expect(noteFor(3, { ...example, method: "cost_basis", holdersAnalyzed: 20, costBasisHolders: 6, allocatedShare: undefined })).toMatch(
      /^Entry prices come from 6 holders' profit-and-loss records\./,
    );
  });
});

// ------------------------------------------------------------------ 3 · buyer count

describe("DGAI · the buyer count behind \"capped at 1,000\"", () => {
  it("a full who-bought-sold page is a floor: max(listed, 24h unique buyers), worded honestly", () => {
    expect(WEEK.data).toHaveLength(1000);
    expect(WEEK.pagination.is_last_page).toBe(false);
    const prepared = prepareBuyers(WEEK.data, CHAIN, TOKEN, 1000, WEEK.pagination.is_last_page);
    expect(prepared.capped).toBe(true);
    expect(buyerCount(prepared, INFO.spot_metrics.unique_buyers)).toEqual({ total: 1000, capped: true });
    expect(capNote(prepared, 467)).toBe("Nansen lists the week's 1,000 largest buyers; smaller ones are not counted.");
    expect(buyerCount(prepared, 3200)).toEqual({ total: 3200, capped: true });
    expect(capNote(prepared, 3200)).toBe("Nansen lists the week's 1,000 largest buyers; smaller ones are not counted. 3,200 wallets bought in the last 24 hours alone.");
    // A complete list is exact, whatever the 24h count says.
    const small = prepareBuyers(WEEK.data.slice(0, 40), CHAIN, TOKEN, 1000, true);
    expect(buyerCount(small, 467)).toEqual({ total: small.buyers.length, capped: false });
    expect(buyersTotalText({ totalBuyers: 1000, totalBuyersCapped: true })).toBe("1,000+");
    expect(buyersTotalText({ totalBuyers: 412 })).toBe("412");
  });
});

// ------------------------------------------------------------------ 4 · the whole scan, offline

describe("DGAI · offline replay of the deep scan (fixture cache, no network)", () => {
  const saved = { ...process.env };
  const roots: string[] = [];
  const network: { endpoint: string; body: Loose }[] = [];
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-nansen-credits-used": "0" } });

  const DAY = 86_400_000;
  // Only these requests may miss the fixture cache; anything else answers 404 and fails the tests below.
  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const endpoint = String(url).replace(/^https?:\/\/[^/]+\/api\/v1\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    network.push({ endpoint, body });
    if (endpoint === "token-screener" && body.filters?.token_address === TOKEN) {
      // The lookup by address was never made in the smoke test: answered with the cached screener row.
      return respond(200, { data: [SCREENER_RAW], pagination: { page: 1, per_page: 10, is_last_page: true } });
    }
    if (endpoint === "tgm/who-bought-sold" && !body.filters && Date.parse(body.date.to) - Date.parse(body.date.from) > 20 * DAY) {
      // The 30-day buyer list (read before skipping the non-circulating holder) was never fetched in
      // the smoke test: stubbed with the cached 7-day list, which it contains.
      return respond(200, { data: WEEK.data, pagination: { page: 1, per_page: 1000, is_last_page: false } });
    }
    if (endpoint === "profiler/address/pnl") {
      // The 10 recent buyers the new plan asks were never asked in the smoke test: stub their pnl from
      // their cached who-bought-sold row (volume-weighted cost, tokens still held).
      const r = WEEK.data.find((x) => x.address?.toLowerCase() === String(body.address).toLowerCase());
      if (!r?.bought_token_volume || !r.bought_volume_usd) return respond(200, { data: [], pagination: {} });
      const held = r.bought_token_volume - (r.sold_token_volume ?? 0);
      const cost = r.bought_volume_usd / r.bought_token_volume;
      return respond(200, {
        data: [{ token_address: TOKEN, holding_amount: held, holding_usd: held, pnl_usd_unrealised: held * (1 - cost), cost_basis_usd: cost, bought_usd: r.bought_volume_usd, max_balance_held: r.bought_token_volume }],
        pagination: {},
      });
    }
    return respond(404, { code: "not_cached", message: `offline test: ${endpoint} is not in the fixture` });
  });

  function freshCache(): void {
    const root = mkdtempSync(path.join(tmpdir(), "dgai-offline-"));
    roots.push(root);
    const dir = path.join(root, ".cache", "nansen");
    mkdirSync(dir, { recursive: true });
    for (const [hash, e] of Object.entries(FIXTURE.entries)) writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(e));
    process.env.EXPOSURE_ROOT = root;
    process.env.NANSEN_CACHE_DIR = dir;
    network.length = 0;
  }

  beforeAll(() => {
    process.env.NANSEN_CACHE = "snapshot";
    process.env.NANSEN_LEDGER = "off";
    process.env.NANSEN_API_KEY = "offline-test"; // reaches only the stub above
    configureNansenClient({ ratePerMin: 60_000, concurrency: 4 });
    vi.stubGlobal("fetch", fetchStub);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of ["NANSEN_CACHE", "NANSEN_LEDGER", "NANSEN_API_KEY", "NANSEN_CACHE_DIR", "EXPOSURE_ROOT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  const run = (hints: Parameters<typeof runScanDetailed>[2]["hints"] = null) =>
    runScanDetailed(CHAIN, TOKEN, { tier: "deep", maxBuyers: 20, maxHolders: 20, scanNo: 2, now: new Date("2026-09-26T00:54:00Z"), hints });
  const countBy = () => network.reduce<Record<string, number>>((m, n) => ({ ...m, [n.endpoint]: (m[n.endpoint] ?? 0) + 1 }), {});

  it("without hints: one token-screener lookup fills the meta, pnl decides the allocations, the cached holders keep their cost", async () => {
    freshCache();
    const { scan, debug } = await run();
    expect(countBy()).toEqual({ "token-screener": 1, "tgm/who-bought-sold": 1, "profiler/address/pnl": 10 });
    // Never search/general for an address; the lookup body is the one lib/nansen/api builds (1 credit).
    expect(network.find((n) => n.endpoint === "token-screener")?.body).toEqual(tokenLookupBody(CHAIN, TOKEN));
    expect(tokenLookupBody(CHAIN, TOKEN)).toEqual({
      chains: ["bnb"],
      timeframe: "24h",
      pagination: { page: 1, per_page: 10 },
      filters: { token_address: TOKEN, include_native_tokens: true },
    });
    expect(scan.calls.find((c) => c.endpoint === "token-screener")).toMatchObject({ finding: "context", cached: false });
    // Everything else (the smoke test's other calls) came from the fixture cache.
    expect(scan.calls.filter((c) => c.cached)).toHaveLength(42);
    expect(scan.calls.filter((c) => c.endpoint === "profiler/address/pnl")).toHaveLength(20);
    expect(scan.calls.filter((c) => c.endpoint === "profiler/address/pnl" && c.cached)).toHaveLength(10);
    // Network calls this time: the lookup, the 30-day list and 10 pnl calls, all inside the deep estimate.
    expect(scan.calls.filter((c) => !c.cached)).toHaveLength(12);
    expect(estimateCredits("deep", CHAIN, { maxBuyers: 20, maxHolders: 20 })).toBe(58);

    expect(scan.meta).toMatchObject({ symbol: "DGAI", name: "DGAI", deployedAt: "2026-08-18T07:24:58.000Z", buyers24h: 467 });
    expect(scan.meta.liquidityUsd).toBeCloseTo(1_624_306.54, 1);
    expect(scan.meta.marketCapUsd).toBeCloseTo(154_422_060.67, 0);
    expect(scan.meta.circulatingSupply).toBeCloseTo(CIRCULATING, 0);

    const w = scan.findings.walls;
    // #0 (500M > circulating) is the only skip; the 30-day list was read first to make sure it is not a buyer.
    expect(debug.walls).toMatchObject({
      method: "cost_basis",
      requested: 20,
      pnlOk: 20,
      skipped: 1,
      spared: 0,
      monthForSkips: true,
      allocations: 4,
      zeroCostKept: 0,
      recentBuyerHolders: 10,
      withCost: 13,
      noHistory: 2,
      failures: 0,
    });
    expect(debug.walls.pnlCoverage).toBeCloseTo(0.66, 2);
    expect(debug.walls.allocatedShare).toBeCloseTo(0.8955, 3);
    expect(w).toMatchObject({ method: "cost_basis", status: "ok", costBasisHolders: 13, holdersAnalyzed: 20 });
    expect(w.allocatedShare).toBeCloseTo(0.8955, 3);
    expect(w.analyzedSupplyShare).toBeCloseTo(0.31, 2);
    expect(w.walls[0]?.wallToLiquidity).not.toBeNull();

    expect(scan.findings.buyers).toMatchObject({ totalBuyers: 1000, totalBuyersCapped: true, topBuyers: 20 });
    expect(scan.findings.buyers.note).toBe("Nansen lists the week's 1,000 largest buyers; smaller ones are not counted.");
    expect(noteFor(1, scan.findings.buyers)).toMatch(/^At least 1,000 wallets bought in 7 days; the top 20 did \d+% of the listed buying\./);
    expect(noteFor(3, w)).toMatch(/^Entry prices come from 13 holders' profit-and-loss records\. .* 90% of total supply is left out: tokens received, not bought on a DEX/);
    // The supply-based flow percentages exist again.
    expect(scan.findings.flow.informedNetPctSupply).not.toBeNull();
  });

  it("with the screener hints: no lookup call, the same meta and walls", async () => {
    freshCache();
    const { scan, debug } = await run(hintsFromScreenerRow(SCREENER));
    expect(countBy()).toEqual({ "tgm/who-bought-sold": 1, "profiler/address/pnl": 10 });
    expect(scan.meta).toMatchObject({ symbol: "DGAI", deployedAt: "2026-08-18T07:24:58.000Z" });
    expect(scan.meta.liquidityUsd).toBeCloseTo(1_624_306.54, 1);
    expect(debug.walls).toMatchObject({ noHistory: 2, allocations: 4, withCost: 13, skipped: 1 });
    expect(scan.findings.walls.walls[0]?.wallToLiquidity).not.toBeNull();
  });

  it("without a deployment date no zero record can be called an allocation: it stays no_cost", async () => {
    freshCache();
    const { debug } = await run({ ...hintsFromScreenerRow(SCREENER), deployedAt: null });
    expect(debug.walls).toMatchObject({ allocations: 0, zeroCostKept: 4, noHistory: 0, skipped: 1 });
    // Only the skipped non-circulating holder is left out.
    expect(debug.walls.allocatedShare).toBeCloseTo(0.5, 3);
  });
});
