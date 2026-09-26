import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokenScreener } from "../lib/nansen/api";
import { configureNansenClient } from "../lib/nansen/client";
import type { FirstFunderRow, TgmDexTradeRow, TgmFlowRow, WhoBoughtSoldRow } from "../lib/nansen/schemas";
import type { HolderPoint } from "../lib/types";
import { admitScan, admitWalletCheck, estimateBreakdown, estimateCredits, flushBudget, settleTicket } from "../lib/xray/budget";
import {
  classifyDemand,
  clusterBuyers,
  concentrationFinding,
  lookupFromRows,
  prepareBuyers,
  serviceOf,
  tracedFinding,
  type FunderLookup,
} from "../lib/xray/pipeline/buyers";
import { bigBuysFromTrades, priceChange, pricePoints } from "../lib/xray/pipeline/context";
import {
  aggregateCohorts,
  balanceSeries,
  buildFlowFinding,
  dailyFlows,
  flowVerdict,
  informedFromIntel,
  informedSeriesPublishable,
  leadObservation,
} from "../lib/xray/pipeline/flow";
import { isRestrictedLabel, publicBuyer, publicClusters, publicFunderName } from "../lib/xray/redact";
import { clientIp } from "../lib/xray/budget";
import { PLAN_RULES } from "../lib/xray/pipeline/rules";
import { runScanDetailed } from "../lib/xray/pipeline/run";
import { aggregateSmart, smartStance, smartState } from "../lib/xray/pipeline/smart";
import { Lane } from "../lib/xray/pipeline/tracker";
import { trendingQuery } from "../lib/xray/pipeline/trending";
import { cheaperShareFromLadder, walletFromPnl } from "../lib/xray/pipeline/wallet";
import { buildLadder, buildWallsFinding, classifyCeiling, recentBuyerPoints } from "../lib/xray/pipeline/walls";
import { sparkline, upsertGallery } from "../lib/xray/store";
import type { FlowPoint, GalleryEntry, PricePoint, ScanEvent } from "../lib/xray/types";

const TOKEN = "0x1111111111111111111111111111111111111111";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = Date.parse("2026-09-26T02:00:00Z");
const HOUR = 3_600_000;

function wbs(address: string, boughtUsd: number, boughtTokens: number, extra: Partial<WhoBoughtSoldRow> = {}): WhoBoughtSoldRow {
  return {
    address,
    address_label: null,
    bought_token_volume: boughtTokens,
    sold_token_volume: null,
    token_trade_volume: null,
    bought_volume_usd: boughtUsd,
    sold_volume_usd: null,
    trade_volume_usd: null,
    ...extra,
  };
}

function funder(wallet: string, funderAddress: string, name: string | null = null): FirstFunderRow {
  return {
    wallet_address: wallet,
    first_funder_address: funderAddress,
    first_funder_name: name,
    transaction_hash: "0xabc",
    block_timestamp: "2026-01-01T00:00:00Z",
    chain: "base",
  };
}

function flowRow(t: number, amount: number, price = 1): TgmFlowRow {
  return {
    date: new Date(t).toISOString(),
    bucket_end: null,
    is_complete: true,
    price_usd: price,
    token_amount: amount,
    value_usd: amount * price,
    holders_count: 10,
    total_inflows_count: null,
    total_outflows_count: null,
    total_inflows_dex: null,
    total_outflows_dex: null,
    total_inflows_cex: null,
    total_outflows_cex: null,
  };
}

function holder(id: number, amount: number, cost: number | null, conviction = 1, supply = 1_000_000, priceNow = 1): HolderPoint {
  return {
    id,
    cohort: "other",
    amount,
    supplyShare: amount / supply,
    cost,
    multiple: cost ? priceNow / cost : null,
    conviction,
    maxHeld: amount,
    buys: 1,
    sells: 0,
    fog: cost === null ? "no_cost" : null,
  };
}

const hourly = (n: number, f: (i: number) => number, end = NOW): PricePoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * HOUR, c: f(i) }));

// ------------------------------------------------------------------ 01 buyers

describe("buyers: preparation and funder clustering", () => {
  it("drops pools, exchanges, the token itself and zero buys; sorts by USD; flags a full page", () => {
    const rows = [
      wbs(addr(1), 100, 100),
      wbs(addr(2), 500, 400),
      wbs(addr(3), 900, 900, { address_label: "Uniswap V3: Pool" }),
      wbs(addr(4), 900, 900, { address_label: "Binance 14" }),
      wbs(TOKEN, 900, 900),
      wbs(addr(5), 0, 10),
      wbs(addr(2).toUpperCase().replace("0X", "0x"), 300, 300),
    ];
    const p = prepareBuyers(rows, "base", TOKEN, 1000);
    expect(p.buyers.map((b) => b.address)).toEqual([addr(2), addr(1)]);
    expect(p.buyers[0].boughtUsd).toBe(500);
    expect(p.totalBuyUsd).toBe(600);
    expect(p.capped).toBe(false);
    expect(p.buyers[0].nansenUrl).toBe(`https://app.nansen.ai/profiler?address=${addr(2)}&chain=base`);
    expect(prepareBuyers(rows, "base", TOKEN, 7).capped).toBe(true);
  });

  it("recognises exchanges and bridges by name only", () => {
    expect(serviceOf("Binance 14")).toEqual({ kind: "exchange", name: "Binance" });
    expect(serviceOf("Coinbase: Hot Wallet")).toEqual({ kind: "exchange", name: "Coinbase" });
    expect(serviceOf("Relay: Solver")).toEqual({ kind: "bridge", name: "Relay" });
    expect(serviceOf("Base: Bridge")).toEqual({ kind: "bridge", name: "Bridge" });
    expect(serviceOf("Shop wallet")).toBeNull();
    expect(serviceOf("Aggregated deployer")).toBeNull();
    expect(serviceOf(null)).toBeNull();
    // Bridges and gas / relay services beyond the big names (an unlisted one looks like concentration).
    expect(serviceOf("Celer: cBridge")).toEqual({ kind: "bridge", name: "cBridge" });
    expect(serviceOf("deBridge: Solver")).toEqual({ kind: "bridge", name: "deBridge" });
    expect(serviceOf("Gas.zip: Refuel")).toEqual({ kind: "bridge", name: "Gas.zip" });
    expect(serviceOf("Orbiter Finance: Maker 1")).toEqual({ kind: "bridge", name: "Orbiter" });
    expect(serviceOf("Mayan Swift")).toEqual({ kind: "bridge", name: "Mayan" });
    expect(serviceOf("Some Protocol: Paymaster")).toEqual({ kind: "bridge", name: "Some Protocol" });
    expect(serviceOf("ERC-4337: EntryPoint v0.7")).toEqual({ kind: "bridge", name: "ERC-4337" });
    expect(serviceOf("Bitvavo 3")).toEqual({ kind: "exchange", name: "Bitvavo" });
    expect(serviceOf("NewEx: Hot Wallet")).toEqual({ kind: "exchange", name: "NewEx" });
    expect(serviceOf("Acme Exchange 12: Withdrawal")).toEqual({ kind: "exchange", name: "Acme Exchange" });
    expect(serviceOf("Token Deployer")).toBeNull();
  });

  it("publishes buyer and funder addresses with public funder names, never a smart-money label", () => {
    const p = prepareBuyers(
      Array.from({ length: 7 }, (_, i) => wbs(addr(0x300 + i), 100 * (10 - i), 100)),
      "base",
      TOKEN,
    );
    const b = (i: number) => addr(0x300 + i);
    const lookups = new Map<string, FunderLookup>([
      [b(0), lookupFromRows([funder(b(0), addr(0xf9))])],
      [b(1), lookupFromRows([funder(b(1), addr(0xf9))])],
      [b(2), lookupFromRows([funder(b(2), addr(0xfa), "Wintermute: Market Maker 3")])],
      [b(3), lookupFromRows([funder(b(3), addr(0xbb), "Binance 14")])],
      [b(4), lookupFromRows([])],
      [b(5), lookupFromRows([funder(b(5), b(5))])],
      [b(6), lookupFromRows([funder(b(6), addr(0xfc), "🤓 30D Smart Trader")])],
    ]);
    const c = clusterBuyers("base", p.buyers, lookups);
    expect(c.walletHub).toEqual({ address: addr(0xf9), label: null, wallets: 2 });
    const f = tracedFinding(p, p.buyers, c, PLAN_RULES.demand);
    const json = JSON.stringify(f);
    // Buyers and funders are published (with attribution in the UI)…
    for (let i = 0; i < 7; i++) expect(json).toContain(b(i));
    for (const x of [addr(0xf9), addr(0xfa), addr(0xbb), addr(0xfc)]) expect(json).toContain(x);
    // …smart-money labels never are, not even as a funder's name.
    expect(json).not.toMatch(/smart|trader/i);
    expect(f.clusters.map((x) => x.label)).toEqual(["0x0000…00f9", "Wintermute", "Binance", "Self-funded", "0x0000…00fc", "Untraced"]);
    expect(f.clusters[0].funder).toBe(addr(0xf9));
    expect(f.clusters[1].funder).toBe(addr(0xfa));
    expect(f.clusters.find((x) => x.kind === "exchange")!.funder).toBeUndefined();
    expect(f.clusters[1].members.map((m) => m.funderLabel)).toEqual(["Wintermute"]);
    expect(f.clusters[4].members.map((m) => [m.funder, m.funderLabel])).toEqual([[addr(0xfc), undefined]]);
    const allowed = new Set(["address", "short", "boughtUsd", "boughtTokens", "funder", "funderLabel", "nansenUrl"]);
    for (const m of f.clusters.flatMap((x) => x.members)) {
      expect(Object.keys(m).every((k) => allowed.has(k))).toBe(true);
      expect(m.nansenUrl).toBe(`https://app.nansen.ai/profiler?address=${m.address}&chain=base`);
    }
    expect(new Set(f.clusters.map((x) => x.id)).size).toBe(f.clusters.length);
    expect(f.clusters.reduce((s, x) => s + x.wallets, 0)).toBe(7);
    expect(f.clusters.reduce((s, x) => s + x.members.length, 0)).toBe(7);
    // Publishing is idempotent and never touches counts or shares.
    expect(publicClusters(f.clusters)).toEqual(f.clusters);
    const again = publicClusters(c.clusters);
    expect(again.map((x) => [x.wallets, x.share])).toEqual(c.clusters.map((x) => [x.wallets, x.share]));
  });

  it("keeps a funder's Nansen entity name and drops smart-money and behavioural labels", () => {
    expect(publicFunderName("🏦 Binance 14: Hot Wallet")).toBe("Binance");
    expect(publicFunderName("Wintermute: Market Maker 3")).toBe("Wintermute");
    expect(publicFunderName("[Disperse.app]")).toBe("Disperse.app");
    for (const label of ["🤓 30D Smart Trader", "Smart Trader: 0xabc", "Fund: Paradigm", "🐳 Whale", "Token Millionaire", "MEV Bot 3", "Public Figure: Someone"]) {
      expect(publicFunderName(label)).toBeNull();
      expect(isRestrictedLabel(label)).toBe(true);
    }
    expect(publicFunderName("0x1234…abcd")).toBeNull();
    expect(publicFunderName(`[${addr(0xabc)}]`)).toBeNull();
    expect(publicFunderName(null)).toBeNull();
    expect(publicFunderName("   ")).toBeNull();
    // Only whitelisted fields survive (a label smuggled onto a row is dropped).
    const row = { address: addr(1), short: "", boughtUsd: 1, boughtTokens: 2, nansenUrl: "u", funder: addr(2), funderLabel: "Smart Fund", label: "🤓 Smart Trader" };
    expect(publicBuyer(row)).toEqual({ address: addr(1), short: "0x0000…0001", boughtUsd: 1, boughtTokens: 2, nansenUrl: "u", funder: addr(2) });
  });

  it("counts exchange-funded buyers one source each, follows funder chains, excludes untraced", () => {
    const p = prepareBuyers(
      Array.from({ length: 12 }, (_, i) => wbs(addr(0x100 + i), 1000 * (30 - i), 1000 * (30 - i))),
      "base",
      TOKEN,
    );
    const b = (i: number) => addr(0x100 + i);
    const F1 = addr(0xf1);
    const lookups = new Map<string, FunderLookup>();
    for (const i of [0, 1, 2, 3]) lookups.set(b(i), lookupFromRows([funder(b(i), F1)]));
    lookups.set(b(4), lookupFromRows([funder(b(4), addr(0xbb), "Binance 14")]));
    lookups.set(b(5), lookupFromRows([funder(b(5), addr(0xbc), "Binance 7")]));
    lookups.set(b(6), lookupFromRows([funder(b(6), b(0))])); // funded by another buyer → same source
    lookups.set(b(7), lookupFromRows([]));
    lookups.set(b(8), lookupFromRows([]));
    lookups.set(b(9), { status: "failed" });
    lookups.set(b(10), lookupFromRows([funder(b(10), addr(0xf2))]));
    lookups.set(b(11), lookupFromRows([funder(b(11), addr(0xf3))]));

    const c = clusterBuyers("base", p.buyers, lookups);
    expect(c.sources).toBe(5); // F1 group + 2 Binance + F2 + F3
    expect(c.traced).toBe(9);
    expect(c.untraced).toBe(2);
    expect(c.failed).toBe(1);
    expect(c.untracedShare).toBeCloseTo(3 / 12);
    const f1 = c.clusters.find((x) => x.kind === "wallet" && x.wallets === 5)!;
    expect(f1.label).toBe("0x0000…00f1");
    expect(f1.share).toBeCloseTo((30 + 29 + 28 + 27 + 24) / 294);
    expect(c.biggestSourceShare).toBeCloseTo(f1.share);
    expect(c.biggestSourceWallets).toBe(5);
    const binance = c.clusters.find((x) => x.kind === "exchange")!;
    expect(binance.label).toBe("Binance");
    expect(binance.wallets).toBe(2);
    expect(binance.members.every((m) => m.funderLabel === "Binance")).toBe(true);
    expect(c.clusters[c.clusters.length - 1].kind).toBe("untraced");
    expect(c.clusters.reduce((s, x) => s + x.wallets, 0)).toBe(12);
    // A funder without a Nansen name keeps no label (its group goes by the short address) and is linked.
    expect(f1.members.every((m) => m.funderLabel === undefined)).toBe(true);
    expect(f1.funder).toBe(F1);

    const finding = tracedFinding(p, p.buyers, c, PLAN_RULES.demand);
    expect(finding.status).toBe("partial"); // one failed lookup
    expect(finding.demand).toBe("concentrated"); // biggest source 47% >= 35%
    expect(finding.topBuyers).toBe(12);
    expect(finding.topShare).toBe(1);
  });

  it("classifies demand with the plan thresholds", () => {
    const d = PLAN_RULES.demand;
    expect(classifyDemand({ sources: 50, traced: 60, biggestSourceShare: 0.1 }, d)).toBe("organic");
    expect(classifyDemand({ sources: 50, traced: 60, biggestSourceShare: 0.25 }, d)).toBe("mixed");
    expect(classifyDemand({ sources: 30, traced: 60, biggestSourceShare: 0.1 }, d)).toBe("mixed");
    expect(classifyDemand({ sources: 20, traced: 60, biggestSourceShare: 0.1 }, d)).toBe("concentrated");
    expect(classifyDemand({ sources: 55, traced: 60, biggestSourceShare: 0.4 }, d)).toBe("concentrated");
  });

  it("falls back to top-10 concentration without tracing (quick tier, Solana)", () => {
    const rows = [wbs(addr(1), 8000, 1), ...Array.from({ length: 20 }, (_, i) => wbs(addr(10 + i), 100, 1))];
    const p = prepareBuyers(rows, "base", TOKEN);
    const f = concentrationFinding(p, "quick", PLAN_RULES.demand);
    expect(f.topBuyers).toBe(10);
    expect(f.topShare).toBeCloseTo(8900 / 10000);
    expect(f.demand).toBe("concentrated");
    expect(f.sources).toBe(0);
    expect(f.clusters).toEqual([]);
    expect(f.status).toBe("partial");
    expect(f.note).toMatch(/deep scan.*top 10 buyers did 89%/);
    // The largest buyers are listed by address, without who-bought-sold labels.
    expect(f.largestBuyers?.map((x) => x.address)).toEqual(p.buyers.slice(0, 10).map((x) => x.address));
    expect(f.largestBuyers?.[0]).toEqual({ address: addr(1), short: "0x0000…0001", boughtUsd: 8000, boughtTokens: 1, nansenUrl: `https://app.nansen.ai/profiler?address=${addr(1)}&chain=base` });
    const sol = concentrationFinding(p, "non_evm", PLAN_RULES.demand);
    expect(sol.note).toMatch(/EVM-only/);
  });
});

// ------------------------------------------------------------------ context

describe("context: film and big buys", () => {
  it("keeps BUYs only, one per transaction, the largest N, oldest first, without wallets", () => {
    const price = hourly(10, () => 1);
    const trade = (tx: string, t: number, usd: number, action = "BUY", px = 1): TgmDexTradeRow => ({
      block_timestamp: new Date(t).toISOString(),
      transaction_hash: tx,
      trader_address: addr(9),
      trader_address_label: "🤓 Smart Trader",
      action,
      token_address: TOKEN,
      token_name: "T",
      token_amount: usd / px,
      traded_token_address: null,
      traded_token_name: null,
      traded_token_amount: null,
      estimated_swap_price_usd: px,
      estimated_value_usd: usd,
    });
    const rows = [
      trade("a", NOW - 5 * HOUR, 500),
      trade("a", NOW - 5 * HOUR, 700),
      trade("b", NOW - 2 * HOUR, 900),
      trade("c", NOW - 8 * HOUR, 100),
      trade("d", NOW - 3 * HOUR, 5000, "SELL"),
      trade("e", NOW - 1 * HOUR, 800, "BUY", 50), // quote 50x off the film → bad quote
    ];
    const out = bigBuysFromTrades(rows, price, 2);
    expect(out).toEqual([
      { t: NOW - 5 * HOUR, price: 1, usd: 700 },
      { t: NOW - 2 * HOUR, price: 1, usd: 900 },
    ]);
    expect(JSON.stringify(out)).not.toContain(addr(9));
  });

  it("builds hourly closes oldest first and the 7-day change", () => {
    const candles = [
      { interval_start: "2026-09-25T10:00:00Z", open: null, high: null, low: null, close: 2.2, volume: null, volume_usd: null },
      { interval_start: "2026-09-25T09:00:00Z", open: null, high: null, low: null, close: 2.0, volume: null, volume_usd: null },
      { interval_start: "2026-09-10T09:00:00Z", open: null, high: null, low: null, close: 9, volume: null, volume_usd: null },
    ];
    const pts = pricePoints(candles, Date.parse("2026-09-19T00:00:00Z"));
    expect(pts.map((p) => p.c)).toEqual([2.0, 2.2]);
    expect(priceChange(pts)).toBeCloseTo(0.1);
    expect(priceChange(pts.slice(0, 1))).toBeNull();
  });
});

// ------------------------------------------------------------------ 02 flow

describe("flow: informed-money aggregation", () => {
  const t0 = NOW - 3 * HOUR;
  it("sums cohort balances on the union of timestamps and derives net flows", () => {
    const sm = balanceSeries([flowRow(t0, 100), flowRow(t0 + HOUR, 90), flowRow(t0 + 2 * HOUR, 80)]);
    const whale = balanceSeries([flowRow(t0 + HOUR, 50), flowRow(t0 + 3 * HOUR, 70)]);
    const price = hourly(4, () => 2, t0 + 3 * HOUR);
    const { points, netTokens } = aggregateCohorts([sm, whale], 1000, price);
    expect(points.map((p) => p.t)).toEqual([t0, t0 + HOUR, t0 + 2 * HOUR, t0 + 3 * HOUR]);
    // whale carried backward (50) before its first bucket, forward after.
    expect(points.map((p) => p.cumPctSupply)).toEqual([0, -0.01, -0.02, 0]);
    expect(points.map((p) => p.netUsd)).toEqual([0, -20, -20, 40]);
    expect(netTokens).toBe(0);
  });

  it("groups daily USD and never invents fresh-wallet days", () => {
    const pts: FlowPoint[] = [
      { t: Date.parse("2026-09-24T23:00:00Z"), cumPctSupply: 0, netUsd: -5 },
      { t: Date.parse("2026-09-25T01:00:00Z"), cumPctSupply: 0, netUsd: -7 },
      { t: Date.parse("2026-09-25T02:00:00Z"), cumPctSupply: 0, netUsd: 2 },
    ];
    expect(dailyFlows(pts, [])).toEqual([
      { day: "2026-09-24", informedUsd: -5, freshUsd: null, exchangeUsd: 0 },
      { day: "2026-09-25", informedUsd: -5, freshUsd: null, exchangeUsd: 0 },
    ]);
  });

  it("verdict: distributing needs a buyer on the other side", () => {
    const r = PLAN_RULES.flow;
    const base = { informedNetUsd: -20_000, informedNetPctSupply: -0.01, marketCapUsd: 2e6, freshNetUsd: 5000, crowdNetTokens: null };
    expect(flowVerdict(base, r)).toBe("distributing");
    expect(flowVerdict({ ...base, freshNetUsd: -1 }, r)).toBe("quiet");
    expect(flowVerdict({ ...base, freshNetUsd: null, crowdNetTokens: 300 }, r)).toBe("distributing");
    expect(flowVerdict({ ...base, freshNetUsd: null, crowdNetTokens: null }, r)).toBe("quiet");
    expect(flowVerdict({ ...base, informedNetUsd: 15_000 }, r)).toBe("accumulating");
    expect(flowVerdict({ ...base, informedNetUsd: -5_000 }, r)).toBe("quiet");
    // no market cap: the supply share decides
    expect(flowVerdict({ ...base, marketCapUsd: null, informedNetPctSupply: 0.006 }, r)).toBe("accumulating");
  });

  it("builds the finding: flow-intelligence headline, balance-derived pulse, exchange share", () => {
    const hours = 168;
    const start = NOW - (hours - 1) * HOUR;
    const series = (f: (i: number) => number) => Array.from({ length: hours }, (_, i) => flowRow(start + i * HOUR, f(i)));
    const price = hourly(hours, () => 1);
    const finding = buildFlowFinding(
      {
        rows: {
          smart_money: series((i) => 100_000 - (10_000 * i) / (hours - 1)),
          whale: series(() => 50_000),
          public_figure: series((i) => 10_000 + (2_000 * i) / (hours - 1)),
          exchange: series((i) => 200_000 + (5_000 * i) / (hours - 1)),
        },
        intel: {
          smart_trader_net_flow_usd: -15_000,
          whale_net_flow_usd: -1_000,
          public_figure_net_flow_usd: 2_000,
          fresh_wallets_net_flow_usd: 6_000,
        } as never,
        intelOk: true,
        supply: 1_000_000,
        marketCapUsd: 2_000_000,
        price,
      },
      PLAN_RULES.flow,
    );
    expect(finding.status).toBe("ok");
    expect(finding.informedNetUsd).toBe(-14_000);
    expect(finding.freshNetUsd).toBe(6_000);
    expect(finding.informedNetPctSupply).toBeCloseTo(-0.008);
    expect(finding.exchangeNetPctSupply).toBeCloseTo(0.005);
    expect(finding.verdict).toBe("distributing");
    expect(finding.series.map((s) => s.cohort)).toEqual(["informed", "exchange"]);
    expect(finding.series[0].points).toHaveLength(hours);
    expect(finding.daily.reduce((s, d) => s + d.informedUsd, 0)).toBeCloseTo(-8_000);
  });

  it("never publishes a smart-money-only pulse; drops the live bucket", () => {
    const hours = 48;
    const start = NOW - (hours - 1) * HOUR;
    const series = (f: (i: number) => number) => Array.from({ length: hours }, (_, i) => flowRow(start + i * HOUR, f(i)));
    const price = hourly(hours, () => 1);
    const base = { intelOk: true, supply: 1_000_000, marketCapUsd: 2_000_000, price };
    const smOnly = buildFlowFinding(
      {
        ...base,
        rows: { smart_money: series((i) => 100_000 - 500 * i), whale: [], public_figure: [], exchange: series(() => 5_000) },
        intel: { smart_trader_net_flow_usd: -20_000, whale_net_flow_usd: null, public_figure_net_flow_usd: null } as never,
      },
      PLAN_RULES.flow,
    );
    expect(smOnly.series).toEqual([]);
    expect(smOnly.daily).toEqual([]);
    expect(smOnly.lead).toBeUndefined();
    expect(smOnly.informedNetPctSupply).toBeNull();
    expect(smOnly.status).toBe("unavailable");
    // Two segments of flow-intelligence make a mix: the 7-day headline is kept, the hourly line is not.
    const withIntel = buildFlowFinding(
      {
        ...base,
        rows: { smart_money: series((i) => 100_000 - 500 * i), whale: [], public_figure: [], exchange: series(() => 5_000) },
        intel: { smart_trader_net_flow_usd: -20_000, whale_net_flow_usd: -1_000, public_figure_net_flow_usd: null } as never,
      },
      PLAN_RULES.flow,
    );
    expect(withIntel.status).toBe("partial");
    expect(withIntel.informedNetUsd).toBe(-21_000);
    expect(withIntel.series.some((x) => x.cohort === "informed")).toBe(false);
    // Smart money + whales: a real mix, published.
    const mixed = buildFlowFinding(
      { ...base, rows: { smart_money: series((i) => 100_000 - 500 * i), whale: series(() => 50_000), exchange: series(() => 5_000) }, intel: null },
      PLAN_RULES.flow,
    );
    expect(mixed.series[0].cohort).toBe("informed");
    expect(informedSeriesPublishable(["smart_money"])).toBe(false);
    expect(informedSeriesPublishable(["whale"])).toBe(true);
    expect(informedSeriesPublishable(["smart_money", "public_figure"])).toBe(true);
    expect(informedFromIntel({ smart_trader_net_flow_usd: -5, whale_net_flow_usd: null, public_figure_net_flow_usd: null } as never)).toBeNull();
    // The still-filling last bucket is not a data point.
    const rows = [flowRow(start, 10), flowRow(start + HOUR, 20), { ...flowRow(start + 2 * HOUR, 99), is_complete: false }];
    expect(balanceSeries(rows).map((p) => p.amount)).toEqual([10, 20]);
  });

  it("describes (never predicts) who moved before the local top", () => {
    const n = 72;
    const price = hourly(n, (i) => (i <= 40 ? 1 + i / 40 : 2 - (i - 40) / 40));
    const informed: FlowPoint[] = price.map((p, i) => ({ t: p.t, cumPctSupply: i <= 20 ? i * 0.001 : 0.02 - (i - 20) * 0.0005, netUsd: 0 }));
    const lead = leadObservation(informed, price)!;
    expect(lead.t).toBe(price[20].t);
    expect(lead.text).toBe("Informed money started selling 20h before the price peaked.");
    expect(leadObservation(informed.slice(0, 10), price.slice(0, 10))).toBeUndefined();
  });
});

// ------------------------------------------------------------------ 03 walls

describe("walls: cost-basis and quick-tier proxy", () => {
  it("turns 30-day buyers into proxy holders (VWAP cost, tokens still held)", () => {
    const rows = [
      wbs(addr(1), 1200, 1000, { sold_token_volume: 200 }), // cost 1.2, holds 800
      wbs(addr(2), 500, 1000, { sold_token_volume: 1000 }), // sold everything → no wall
      wbs(addr(3), 900, 1000, { address_label: "Aerodrome: Router" }),
      wbs(addr(4), 5, 1_000_000), // cost 0.000005 → out of range
    ];
    const pts = recentBuyerPoints(rows, "base", TOKEN, 1_000_000, 1);
    expect(pts).toHaveLength(1);
    expect(pts[0].cost).toBeCloseTo(1.2);
    expect(pts[0].amount).toBe(800);
    expect(pts[0].conviction).toBeCloseTo(0.8);
    expect(pts[0].supplyShare).toBeCloseTo(0.0008);
  });

  it("finds walls above the price with holder counts, a ladder and the ceiling", () => {
    const holders = [
      holder(0, 50_000, 1.2, 0.5),
      holder(1, 40_000, 1.19), // same findReefs bin as 1.2
      holder(2, 30_000, 0.5),
      holder(3, 20_000, 2.5),
      holder(4, 10_000, null),
    ];
    const f = buildWallsFinding(
      { method: "cost_basis", holders, priceNow: 1, liquidityUsd: 250_000, supply: 1_000_000, price: hourly(24, () => 1) },
      PLAN_RULES.ceiling,
    );
    expect(f.status).toBe("ok");
    expect(f.holdersAnalyzed).toBe(5);
    expect(f.analyzedSupplyShare).toBeCloseTo(0.14); // holders with a cost only
    expect(f.underwaterShare).toBeCloseTo(110 / 140);
    const near = f.walls[0];
    expect(near.price).toBeGreaterThan(1.19);
    expect(near.price).toBeLessThan(1.2);
    expect(near.tokens).toBe(90_000);
    expect(near.holders).toBe(2);
    expect(near.supplyShare).toBeCloseTo(0.09);
    expect(near.alreadyTrimming).toBeCloseTo(25_000 / 90_000);
    expect(near.wallToLiquidity).toBeCloseTo((90_000 * near.price) / 250_000);
    expect(f.ceiling).toBe("heavy");
    const ladderTokens = f.ladder.reduce((s, b) => s + b.tokens, 0);
    expect(ladderTokens).toBeCloseTo(140_000);
    expect(f.ladder[0].lo).toBeLessThanOrEqual(0.5);
    expect(f.ladder[f.ladder.length - 1].hi).toBeGreaterThanOrEqual(2.5);
  });

  it("ceiling: light when walls are far, small and people are in profit", () => {
    const r = PLAN_RULES.ceiling;
    const wall = { price: 1.5, movePct: 0.5, tokens: 50_000, supplyShare: 0.05, wallToLiquidity: 3, alreadyTrimming: 0, holders: 3 };
    expect(classifyCeiling([wall], 0.2, 100_000, r)).toBe("light"); // +50% is not "just above"
    expect(classifyCeiling([{ ...wall, movePct: 0.2 }], 0.2, 100_000, r)).toBe("heavy");
    expect(classifyCeiling([{ ...wall, movePct: 0.2, wallToLiquidity: 0.1, tokens: 5_000 }], 0.2, 100_000, r)).toBe("light");
    expect(classifyCeiling([], 0.65, 100_000, r)).toBe("heavy");
  });

  it("ladder converts tokens to supply share even without a known supply", () => {
    const hs = [holder(0, 100, 1, 1, 1000), holder(1, 300, 2, 1, 1000)];
    const ladder = buildLadder(hs, [], 1.5, null, 4);
    expect(ladder).toHaveLength(4);
    expect(ladder.reduce((s, b) => s + b.supplyShare, 0)).toBeCloseTo(0.4);
  });

  it("empty input is unavailable, never a throw", () => {
    const f = buildWallsFinding({ method: "recent_buyers", holders: [], priceNow: 1, liquidityUsd: null, supply: null, price: [] }, PLAN_RULES.ceiling);
    expect(f.status).toBe("unavailable");
    expect(f.walls).toEqual([]);
  });
});

// ------------------------------------------------------------------ 04 smart money

describe("smart money: one aggregate, no wallets", () => {
  const SM = [addr(0xa1), addr(0xa2), addr(0xa3)];
  it("merges BUY/SELL per address (max, not sum) and averages the entry", () => {
    const buy = [
      wbs(SM[0], 800, 1000, { sold_volume_usd: 2000 }),
      wbs(SM[1], 1600, 2000),
      wbs(SM[2], 2400, 3000),
    ];
    const sell = [wbs(SM[0], 800, 1000, { sold_volume_usd: 2000 })];
    const f = aggregateSmart("base", [buy, sell], 1, PLAN_RULES.smart);
    expect(f.status).toBe("ok");
    expect(f.windowDays).toBe(30);
    expect(f.wallets).toBe(3);
    expect(f.avgEntry).toBeCloseTo(0.8);
    expect(f.pnlPct).toBeCloseTo(0.25);
    expect(f.boughtUsd).toBe(4800);
    expect(f.soldUsd).toBe(2000);
    expect(f.netUsd).toBe(2800);
    expect(f.stance).toBe("adding");
    expect(f.state).toBe("profit");
    const json = JSON.stringify(f);
    for (const a of SM) expect(json).not.toContain(a);
  });

  it("publishes nothing but the count below three wallets (never one wallet's numbers)", () => {
    for (const n of [1, 2]) {
      const rows = SM.slice(0, n).map((a, i) => wbs(a, 1000 * (i + 1), 2000, { sold_volume_usd: 500 }));
      const f = aggregateSmart("base", [rows, rows], 1, PLAN_RULES.smart);
      expect(f).toMatchObject({ status: "partial", wallets: n, avgEntry: null, pnlPct: null, boughtUsd: 0, soldUsd: 0, netUsd: 0 });
      expect(f.stance).toBe("holding");
      expect(f.state).toBe("unknown");
    }
    expect(aggregateSmart("base", [SM.map((a) => wbs(a, 1000, 2000)), []], 1, PLAN_RULES.smart).avgEntry).toBeCloseTo(0.5);
  });

  it("degrades instead of throwing", () => {
    expect(aggregateSmart("base", [null, null], 1, PLAN_RULES.smart).status).toBe("unavailable");
    const one = aggregateSmart("base", [[wbs(SM[0], 100, 100)], null], 1, PLAN_RULES.smart);
    expect(one.status).toBe("partial");
    expect(aggregateSmart("base", [[], []], 1, PLAN_RULES.smart).state).toBe("unknown");
  });

  it("stance and state thresholds", () => {
    const r = PLAN_RULES.smart;
    expect(smartStance(100, 100, r)).toBe("holding");
    expect(smartStance(100, 150, r)).toBe("trimming");
    expect(smartStance(100, 400, r)).toBe("exiting");
    expect(smartStance(0, 0, r)).toBe("holding");
    expect(smartState(1, 1.1, r)).toBe("profit");
    expect(smartState(1, 0.95, r)).toBe("breakeven");
    expect(smartState(1, 0.89, r)).toBe("loss");
    expect(smartState(null, 1, r)).toBe("unknown");
  });
});

// ------------------------------------------------------------------ 05 wallet

describe("wallet check", () => {
  const ladder = [
    { lo: 0.5, hi: 1, tokens: 100, supplyShare: 0.1 },
    { lo: 1, hi: 2, tokens: 100, supplyShare: 0.1 },
  ];
  it("cheaper share interpolates inside the bin", () => {
    expect(cheaperShareFromLadder(ladder, 1)).toBeCloseTo(0.5);
    expect(cheaperShareFromLadder(ladder, Math.SQRT2)).toBeCloseTo(0.75);
    expect(cheaperShareFromLadder(ladder, 5)).toBe(1);
    expect(cheaperShareFromLadder([], 1)).toBeNull();
  });

  it("compares the wallet's cost with smart money and the ladder", () => {
    const rows = [
      {
        token_address: TOKEN,
        token_price: 1.5,
        holding_amount: 1000,
        holding_usd: 1500,
        pnl_usd_unrealised: 300,
        max_balance_held: 1000,
      },
    ] as never;
    const w = walletFromPnl(rows, "base", TOKEN, addr(0xbeef), { priceNow: 1.5, smartAvgEntry: 0.8, ladder });
    expect(w.status).toBe("ok");
    expect(w.cost).toBeCloseTo(1.2);
    expect(w.pnlPct).toBeCloseTo(0.25);
    expect(w.vsSmartMoneyPct).toBeCloseTo(0.5);
    expect(w.holdingTokens).toBe(1000);
    expect(w.short).toBe("0x0000…beef");
    expect(walletFromPnl(null, "base", TOKEN, addr(1)).status).toBe("unavailable");
    expect(walletFromPnl([], "base", TOKEN, addr(1)).status).toBe("unavailable");
  });
});

// ------------------------------------------------------------------ misc

describe("estimates, lanes, gallery", () => {
  it("documents the credit cost per tier", () => {
    // Context: 3 calls + the token-screener lookup (1 credit) reserved for tokens token-information knows too little about.
    expect(estimateBreakdown("quick", "base").context).toBe(3 + 1);
    expect(estimateCredits("quick", "base")).toBe(13);
    expect(estimateCredits("quick", "solana")).toBe(13);
    // Deep walls: holders (5) + one pnl per holder + the 30-day buyer list (skip check / hybrid / fallback, at most once).
    expect(estimateCredits("deep", "base", { maxBuyers: 20, maxHolders: 20 })).toBe(58);
    expect(estimateCredits("deep", "solana", { maxBuyers: 20, maxHolders: 20 })).toBe(38);
    expect(estimateBreakdown("deep", "base").total).toBe(4 + 61 + 5 + 46 + 2);
    expect(estimateBreakdown("deep", "base", { maxHolders: 15 }).walls).toBe(5 + 15 + 1);
    // Live deep scans (15 buyers, 15 holders) stay inside the 50-credit deep cap.
    expect(estimateCredits("deep", "base", { maxBuyers: 15, maxHolders: 15 })).toBe(48);
    expect(estimateCredits("deep", "solana", { maxBuyers: 15, maxHolders: 15 })).toBe(33);
  });

  it("a lane buffers until opened, then streams", () => {
    const out: string[] = [];
    const lane = new Lane((e) => out.push(e.type === "stage" ? e.message : e.type));
    lane.emit({ type: "stage", stage: "flow", message: "a" });
    expect(out).toEqual([]);
    lane.open();
    lane.emit({ type: "stage", stage: "flow", message: "b" });
    expect(out).toEqual(["a", "b"]);
  });

  it("sparkline has 24 normalised points; gallery keeps newest first, no synthetic", () => {
    const s = sparkline(hourly(168, (i) => i));
    expect(s).toHaveLength(24);
    expect(s[0]).toBe(0);
    expect(s[23]).toBe(1);
    const e = (file: string, scannedAt: string): GalleryEntry => ({
      chain: "base",
      tokenAddress: TOKEN,
      symbol: "T",
      name: "T",
      diagnosis: "x",
      code: "normal",
      scannedAt,
      file,
      spark: [],
    });
    let idx = upsertGallery([], e("a.json", "2026-09-25T00:00:00Z"));
    idx = upsertGallery(idx, e("b.json", "2026-09-26T00:00:00Z"));
    idx = upsertGallery(idx, e("a.json", "2026-09-26T01:00:00Z"));
    expect(idx.map((x) => x.file)).toEqual(["a.json", "b.json"]);
    expect(upsertGallery(idx, e("_synthetic-1.json", "2026-09-27T00:00:00Z"))).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ the whole scan against a mocked API

// Untyped JSON (the OpenAPI document, mocked request bodies).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const SPEC_FILE = process.env.NANSEN_OPENAPI_SPEC ?? path.join(process.cwd(), ".cache", "nansen-openapi.json");
const spec = existsSync(SPEC_FILE) ? (JSON.parse(readFileSync(SPEC_FILE, "utf8")) as Record<string, Loose>) : null;

/** Minimal JSON-schema check of a request body against the OpenAPI spec (types, enums, required, unknown fields). */
function validateBody(endpoint: string, body: unknown): string[] {
  if (!spec) return [];
  const op = spec.paths[`/api/v1/${endpoint}`]?.post;
  if (!op) return [`${endpoint}: not in the spec`];
  const errors: string[] = [];
  const resolve = (s: Loose): Loose => {
    let x = s;
    while (x && x.$ref) x = spec.components.schemas[String(x.$ref).split("/").pop()!];
    return x;
  };
  const check = (value: unknown, schemaIn: Loose, at: string, errs: string[]): void => {
    const schema = resolve(schemaIn);
    if (!schema) return;
    if (schema.anyOf) {
      const ok = schema.anyOf.some((alt: Loose) => {
        const e: string[] = [];
        check(value, alt, at, e);
        return e.length === 0;
      });
      if (!ok) errs.push(`${at}: matches no allowed shape (${JSON.stringify(value)})`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errs.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
      return;
    }
    const type = schema.type ?? (schema.properties ? "object" : undefined);
    if (type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return void errs.push(`${at}: expected object`);
      for (const r of schema.required ?? []) if (!(r in (value as object))) errs.push(`${at}.${r}: required`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const ps = schema.properties?.[k];
        if (!ps) {
          if (schema.additionalProperties === false) errs.push(`${at}.${k}: unknown field`);
          continue;
        }
        check(v, ps, `${at}.${k}`, errs);
      }
    } else if (type === "array") {
      if (!Array.isArray(value)) return void errs.push(`${at}: expected array`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
      value.forEach((v, i) => check(v, schema.items, `${at}[${i}]`, errs));
    } else if (type === "string") {
      if (typeof value !== "string") errs.push(`${at}: expected string`);
    } else if (type === "integer" || type === "number") {
      if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) errs.push(`${at}: expected ${type}`);
      else {
        if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: > ${schema.maximum}`);
        if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: < ${schema.minimum}`);
      }
    } else if (type === "boolean") {
      if (typeof value !== "boolean") errs.push(`${at}: expected boolean`);
    } else if (type === "null") {
      if (value !== null) errs.push(`${at}: expected null`);
    }
  };
  check(body, op.requestBody?.content?.["application/json"]?.schema, endpoint, errors);
  return errors;
}

describe("runScan (mocked Nansen API, no network)", () => {
  const saved = {
    key: process.env.NANSEN_API_KEY,
    cache: process.env.NANSEN_CACHE,
    ledger: process.env.NANSEN_LEDGER,
    root: process.env.EXPOSURE_ROOT,
    live: process.env.EXPOSURE_LIVE,
  };
  let root = "";
  const bodyErrors: string[] = [];
  const seen: { endpoint: string; body: Loose }[] = [];
  const b = (i: number) => addr(0x100 + i);
  const H = (i: number) => addr(0x200 + i);
  const SMW = [addr(0xa1), addr(0xa2), addr(0xa3)];
  /** A young token whose token-information is all "" and 0. */
  const EMPTY = addr(0x77);
  /** A token whose holders' pnl covers < 50% of their tokens (hybrid walls). */
  const HYB = addr(0x78);
  const ALLOC = addr(0x3a);
  const WHALE = addr(0x3b);
  const start = NOW - 167 * HOUR;

  function respond(status: number, body: unknown, credits = 1) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-nansen-credits-used": String(status < 300 ? credits : 0) },
    });
  }
  const series = (f: (i: number) => number) => Array.from({ length: 168 }, (_, i) => flowRow(start + i * HOUR, f(i)));

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const endpoint = String(url).replace(/^https?:\/\/[^/]+\/api\/v1\//, "");
    if (endpoint === "account") return respond(200, { user_id: "u", plan: "pro", credits_remaining: 1500 }, 0);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ endpoint, body });
    bodyErrors.push(...validateBody(endpoint, body));
    switch (endpoint) {
      case "search/general":
        // Scans must never call it (address lookups may cost 500 credits on the MCP twin).
        return respond(500, { code: "unexpected", message: "search/general is not used by scans", status: 500 }, 0);
      case "tgm/token-information":
        if (body.token_address === EMPTY) {
          return respond(200, {
            data: {
              name: "",
              symbol: "",
              logo: "",
              token_details: { token_deployment_date: "", market_cap_usd: 0, fdv_usd: 0, circulating_supply: 0, total_supply: 0 },
              spot_metrics: { liquidity_usd: 0, total_holders: 50, unique_buyers: 5, unique_sellers: 2 },
            },
          });
        }
        return respond(200, {
          data: {
            name: "Patient",
            symbol: "PTNT",
            logo: "https://logo",
            token_details: { token_deployment_date: "2026-06-01T00:00:00Z", circulating_supply: 1_000_000, market_cap_usd: 2_000_000 },
            spot_metrics: { liquidity_usd: 250_000, total_holders: 4000, unique_buyers: 300, unique_sellers: 200, volume_total_usd: 90_000 },
          },
        });
      case "tgm/token-ohlcv":
        return respond(200, {
          data: Array.from({ length: 169 }, (_, i) => ({
            interval_start: new Date(NOW - (168 - i) * HOUR).toISOString(),
            close: 1 + 0.3 * Math.sin((Math.PI * i) / 168),
          })),
        });
      case "tgm/dex-trades":
        return respond(200, {
          data: [
            { block_timestamp: new Date(NOW - 5 * HOUR).toISOString(), transaction_hash: "0x1", trader_address: b(0), action: "BUY", estimated_swap_price_usd: 1.1, estimated_value_usd: 9000, token_amount: 8000 },
            { block_timestamp: new Date(NOW - 9 * HOUR).toISOString(), transaction_hash: "0x2", trader_address: b(1), action: "BUY", estimated_swap_price_usd: 1.2, estimated_value_usd: 7000, token_amount: 6000 },
          ],
          pagination: {},
        });
      case "tgm/who-bought-sold": {
        if (body.filters?.include_smart_money_labels) {
          const rows =
            body.buy_or_sell === "BUY"
              ? [
                  { address: SMW[0], bought_volume_usd: 800, bought_token_volume: 1000, sold_volume_usd: 2000 },
                  { address: SMW[1], bought_volume_usd: 1600, bought_token_volume: 2000 },
                  { address: SMW[2], bought_volume_usd: 2400, bought_token_volume: 3000 },
                ]
              : [{ address: SMW[0], bought_volume_usd: 800, bought_token_volume: 1000, sold_volume_usd: 2000 }];
          return respond(200, { data: rows, pagination: {} });
        }
        const days = Math.round((Date.parse(body.date.to) - Date.parse(body.date.from)) / 86_400_000);
        if (days === 7) {
          return respond(200, {
            data: [
              { address: addr(0xee), address_label: "Uniswap V3: Pool", bought_volume_usd: 99_999, bought_token_volume: 1 },
              ...Array.from({ length: 12 }, (_, i) => ({
                address: b(i),
                // A buyer that happens to be a smart-money wallet: its label must never be published.
                address_label: i === 10 ? "🤓 30D Smart Trader" : null,
                bought_volume_usd: 1000 * (30 - i),
                bought_token_volume: 1000 * (30 - i),
              })),
            ],
            pagination: {},
          });
        }
        if (body.token_address === HYB) {
          // H(2) had no pnl cost: its proxy replaces it. H(1) is costed by pnl: skipped.
          return respond(200, {
            data: [
              { address: H(2), bought_volume_usd: 1500, bought_token_volume: 1000 },
              { address: H(1), bought_volume_usd: 9000, bought_token_volume: 1000 },
              ...Array.from({ length: 5 }, (_, i) => ({ address: b(50 + i), bought_volume_usd: 1200, bought_token_volume: 1000 })),
            ],
            pagination: {},
          });
        }
        // 30-day buyers for the quick-tier walls: cost 1.2 (still holding), 0.6 (still holding)
        return respond(200, {
          data: [
            ...Array.from({ length: 15 }, (_, i) => ({ address: b(50 + i), bought_volume_usd: 1200, bought_token_volume: 1000 })),
            ...Array.from({ length: 10 }, (_, i) => ({ address: b(80 + i), bought_volume_usd: 600, bought_token_volume: 1000 })),
          ],
          pagination: {},
        });
      }
      case "profiler/address/first-funder": {
        const a = body.address as string;
        const i = Number.parseInt(a.slice(-3), 16) - 0x100;
        if ([0, 1, 2, 3].includes(i)) return respond(200, { data: [funder(a, addr(0xf1))], pagination: {} });
        if (i === 4 || i === 5) return respond(200, { data: [funder(a, addr(0xbb), "Binance 14")], pagination: {} });
        if (i === 6) return respond(200, { data: [funder(a, b(0))], pagination: {} });
        if (i === 7 || i === 8) return respond(200, { data: [], pagination: {} });
        if (i === 9) return respond(422, { code: "invalid_address_format", message: "bad", status: 422 });
        return respond(200, { data: [funder(a, addr(0xf000 + i))], pagination: {} });
      }
      case "tgm/flows": {
        const f: Record<string, (i: number) => number> = {
          smart_money: (i) => 100_000 - (10_000 * i) / 167,
          whale: () => 50_000,
          public_figure: (i) => 10_000 + (2_000 * i) / 167,
          exchange: (i) => 200_000 + (5_000 * i) / 167,
        };
        return respond(200, { data: series(f[body.label]).reverse(), pagination: { is_last_page: true } });
      }
      case "tgm/flow-intelligence":
        return respond(200, {
          data: [{ smart_trader_net_flow_usd: -15_000, whale_net_flow_usd: -1_000, public_figure_net_flow_usd: 2_000, fresh_wallets_net_flow_usd: 6_000 }],
        });
      case "token-screener":
        if (body.filters?.token_address === EMPTY) {
          return respond(200, {
            data: [
              // A lookalike on another chain first: the match is on chain + address.
              { chain: "ethereum", token_address: EMPTY, token_symbol: "FAKE", price_usd: 9, market_cap_usd: 9 },
              {
                chain: "base",
                token_address: EMPTY.toUpperCase().replace("0X", "0x"),
                token_symbol: "EMPT",
                token_deployment_date: "2026-09-01T12:00:00",
                price_usd: 2,
                market_cap_usd: 4_000_000,
                fdv: 20_000_000,
                liquidity: 300_000,
              },
            ],
            pagination: {},
          });
        }
        return respond(200, { data: [], pagination: {} });
      case "tgm/holders":
        if (body.token_address === HYB) {
          return respond(
            200,
            {
              data: [
                // 40% of supply in a team wallet: an allocation by its label, skipped before any pnl call.
                { address: ALLOC, address_label: "Patient: Team", token_amount: 400_000, total_inflow: 400_000, total_outflow: 0, ownership_percentage: 0.4 },
                // Received once and never sent, like any DEX buyer who never sold: asked, and pnl shows the buy.
                { address: WHALE, token_amount: 5_000, total_inflow: 5_000, total_outflow: 0, ownership_percentage: 0.005 },
                { address: H(0), token_amount: 50_000 },
                { address: H(1), token_amount: 40_000 },
                { address: H(2), token_amount: 30_000 },
                { address: H(3), token_amount: 20_000 },
                { address: H(4), token_amount: 10_000 },
              ],
              pagination: {},
            },
            5,
          );
        }
        return respond(
          200,
          {
            data: [
              { address: addr(0xef), address_label: "Uniswap V3: Pool", token_amount: 300_000 },
              { address: H(0), token_amount: 50_000 },
              { address: H(1), token_amount: 40_000 },
              { address: H(2), token_amount: 30_000 },
              { address: H(3), token_amount: 20_000 },
              { address: H(4), token_amount: 10_000 },
            ],
            pagination: {},
          },
          5,
        );
      case "profiler/address/pnl": {
        if (body.filters?.token_address === HYB) {
          const rec = (r: Record<string, number | null>) => respond(200, { data: [{ token_address: HYB, ...r }], pagination: {} });
          if (body.address === H(0)) return rec({ holding_amount: 50_000, holding_usd: 50_000, pnl_usd_unrealised: 50_000, cost_basis_usd: 0, bought_usd: 0 });
          if (body.address === H(1)) return rec({ holding_amount: 40_000, holding_usd: 40_000, pnl_usd_unrealised: 40_000 - 40_000 * 1.2 });
          if (body.address === H(2) || body.address === H(3)) return rec({ holding_amount: body.address === H(2) ? 30_000 : 20_000, holding_usd: null, pnl_usd_unrealised: null });
          if (body.address === WHALE) return rec({ holding_amount: 5_000, holding_usd: 5_000, pnl_usd_unrealised: 5_000 - 5_000 * 1.25, bought_usd: 6_250, cost_basis_usd: 1.25 });
          return respond(200, { data: [], pagination: {} });
        }
        const costs: Record<string, number> = { [H(0)]: 1.2, [H(1)]: 1.19, [H(2)]: 0.5, [H(3)]: 2.5 };
        const c = costs[body.address];
        if (c === undefined) return respond(200, { data: [], pagination: {} }); // H(4): no history
        const amt = { [H(0)]: 50_000, [H(1)]: 40_000, [H(2)]: 30_000, [H(3)]: 20_000 }[body.address]!;
        return respond(200, {
          data: [{ token_address: TOKEN, holding_amount: amt, holding_usd: amt, pnl_usd_unrealised: amt - amt * c, max_balance_held: amt }],
          pagination: {},
        });
      }
      default:
        return respond(404, { code: "not_found", message: endpoint, status: 404 });
    }
  });

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "exposure-test-"));
    process.env.EXPOSURE_ROOT = root;
    process.env.NANSEN_API_KEY = "test-key";
    process.env.NANSEN_CACHE = "off";
    process.env.NANSEN_LEDGER = "off";
    process.env.EXPOSURE_LIVE = "1";
    configureNansenClient({ ratePerMin: 60_000, concurrency: 4 });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("NANSEN_API_KEY", saved.key);
    restore("NANSEN_CACHE", saved.cache);
    restore("NANSEN_LEDGER", saved.ledger);
    restore("EXPOSURE_ROOT", saved.root);
    restore("EXPOSURE_LIVE", saved.live);
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!spec)("the spec check itself catches unknown fields, bad enums and missing fields", () => {
    expect(validateBody("tgm/flows", { chain: "base", token_address: TOKEN, date: { from: "a", to: "b" }, bogus: 1 })).toEqual([
      "tgm/flows.bogus: unknown field",
    ]);
    expect(validateBody("tgm/flows", { chain: "base", token_address: TOKEN, date: {}, label: "smart" })[0]).toMatch(/label/);
    expect(validateBody("profiler/address/first-funder", { chain: "all" })).toEqual(["profiler/address/first-funder.address: required"]);
  });

  it("trending: the token-screener body matches the spec", async () => {
    const before = seen.length;
    await tokenScreener(trendingQuery({ chains: ["base", "ethereum", "bnb", "solana"], sort: "nof_buyers" })).catch(() => undefined);
    const call = seen.slice(before).find((s) => s.endpoint === "token-screener");
    expect(call?.body).toMatchObject({ chains: ["base", "ethereum", "bnb", "solana"], timeframe: "24h" });
    expect(call?.body.filters.token_age_days).toEqual({ min: 7, max: 365 });
    expect(bodyErrors).toEqual([]);
    expect(() => trendingQuery({ chains: ["a", "b", "c", "d", "e", "f"] })).toThrow();
  });

  it("deep: streams stage → calls → finding in order and assembles the scan", async () => {
    seen.length = 0;
    const events: ScanEvent[] = [];
    let onCalls = 0;
    let onCallCredits = 0;
    let atMeta: { onCalls: number; callEvents: number } | null = null;
    const { scan, debug } = await runScanDetailed("base", TOKEN, {
      tier: "deep",
      maxBuyers: 12,
      maxHolders: 10,
      scanNo: 412,
      now: new Date(NOW),
      onCall: (c) => {
        onCalls++;
        onCallCredits += c.credits;
      },
      onEvent: (e) => {
        if (e.type === "meta") atMeta = { onCalls, callEvents: events.filter((x) => x.type === "call").length };
        events.push(e);
      },
    });
    // The budget hook sees each call when it is made, before the ordered stream releases it.
    expect(atMeta).toEqual({ onCalls: 3, callEvents: 0 });
    expect(onCalls).toBe(scan.calls.length);
    expect(onCallCredits).toBe(scan.totals.credits);
    // Buyer and funder addresses are published in finding 01 only; smart money never, per wallet or by label.
    const published = JSON.stringify(scan);
    const buyersJson = JSON.stringify(scan.findings.buyers);
    for (let i = 0; i < 12; i++) expect(buyersJson).toContain(b(i));
    for (const f of [addr(0xf1), addr(0xbb)]) expect(buyersJson).toContain(f);
    const outsideBuyers = JSON.stringify({ ...scan, findings: { ...scan.findings, buyers: null } });
    for (let i = 0; i < 12; i++) expect(outsideBuyers).not.toContain(b(i));
    for (const a of SMW) expect(published).not.toContain(a);
    expect(published).not.toMatch(/smart trader/i);
    expect(scan.findings.buyers.clusters.find((c) => c.kind === "wallet" && c.wallets === 5)).toMatchObject({ label: "0x0000…00f1", funder: addr(0xf1) });
    expect(debug.buyers.walletHub.address).toBe(addr(0xf1));

    // --- order: stage(context) meta context-calls | per finding: stage calls finding | diagnosis | done
    const kinds = events.map((e) => (e.type === "stage" ? `stage:${e.stage}` : e.type === "finding" ? `finding:${e.key}` : e.type));
    expect(kinds[0]).toBe("stage:context");
    expect(kinds[1]).toBe("meta");
    const order = ["buyers", "flow", "walls", "smart"];
    let current = "context";
    for (const e of events) {
      if (e.type === "stage") current = e.stage;
      if (e.type === "call") expect(e.call.finding).toBe(current);
    }
    const stageIdx = order.map((k) => kinds.indexOf(`stage:${k}`));
    const findingIdx = order.map((k) => kinds.indexOf(`finding:${k}`));
    for (let i = 0; i < order.length; i++) {
      expect(stageIdx[i]).toBeGreaterThan(1);
      expect(findingIdx[i]).toBeGreaterThan(stageIdx[i]);
      if (i) expect(stageIdx[i]).toBeGreaterThan(findingIdx[i - 1]);
    }
    expect(kinds.slice(-4)).toEqual(["stage:diagnosis", "diagnosis", "stage:done", "done"]);

    // --- request bodies match the spec; no restricted calls
    expect(bodyErrors).toEqual([]);
    expect(seen.some((s) => s.endpoint === "tgm/holders" && s.body.label_type === "smart_money")).toBe(false);
    const sm = seen.filter((s) => s.body.filters?.include_smart_money_labels);
    expect(sm).toHaveLength(2);
    for (const s of sm) {
      expect(s.body.filters.include_smart_money_labels).toEqual(["Smart Trader", "30D Smart Trader", "90D Smart Trader", "180D Smart Trader"]);
      expect(Date.parse(s.body.date.to) - Date.parse(s.body.date.from)).toBeGreaterThanOrEqual(30 * 86_400_000 - 60_000);
    }
    const flows = seen.filter((s) => s.endpoint === "tgm/flows");
    expect(flows.map((s) => s.body.label).sort()).toEqual(["exchange", "public_figure", "smart_money", "whale"]);
    expect(flows.every((s) => s.body.pagination.per_page >= 169)).toBe(true);
    // Strictly inside 7 days, so the API keeps hourly buckets.
    expect(flows.every((s) => Date.parse(s.body.date.to) - Date.parse(s.body.date.from) < 7 * 86_400_000)).toBe(true);
    expect(seen.find((s) => s.endpoint === "tgm/flow-intelligence")!.body.timeframe).toBe("7d");

    // --- meta & film
    expect(scan.tier).toBe("deep");
    expect(scan.meta).toMatchObject({ symbol: "PTNT", scanNo: 412, holders: 4000, buyers24h: 300, liquidityUsd: 250_000 });
    expect(scan.meta.priceNow).toBeCloseTo(1);
    expect(scan.price.length).toBeGreaterThanOrEqual(168);
    expect(scan.price[0].t).toBeLessThan(scan.price[1].t);
    expect(scan.bigBuys.map((x) => x.usd)).toEqual([7000, 9000]);

    // --- 01
    const buyers = scan.findings.buyers;
    expect(buyers.sources).toBe(5);
    expect(buyers.untracedShare).toBeCloseTo(0.25);
    expect(buyers.demand).toBe("concentrated");
    expect(buyers.clusters.find((c) => c.kind === "exchange")?.wallets).toBe(2);
    expect(debug.buyers).toMatchObject({ mode: "traced", analysed: 12, traced: 9, untraced: 2, failed: 1 });

    // --- 02
    const flow = scan.findings.flow;
    expect(flow.status).toBe("ok");
    expect(flow.verdict).toBe("distributing");
    expect(flow.informedNetUsd).toBe(-14_000);
    expect(flow.informedNetPctSupply).toBeCloseTo(-0.008);
    expect(debug.flows.smart_money.buckets).toBe(168);

    // --- 03
    const walls = scan.findings.walls;
    expect(walls.method).toBe("cost_basis");
    expect(walls.holdersAnalyzed).toBe(5);
    expect(walls.ceiling).toBe("heavy");
    expect(walls.walls[0].tokens).toBe(90_000);
    expect(debug.walls).toMatchObject({ requested: 5, pnlOk: 5, withCost: 4, noHistory: 1 });

    // --- 04
    expect(scan.findings.smart).toMatchObject({ wallets: 3, stance: "adding", state: "profit" });
    expect(scan.findings.smart.avgEntry).toBeCloseTo(0.8);
    expect(JSON.stringify(scan.findings.smart)).not.toContain(SMW[0]);
    expect(JSON.stringify(scan.bigBuys)).not.toContain(b(0));

    // --- evidence
    expect(scan.totals.calls).toBe(scan.calls.length);
    expect(scan.totals.credits).toBe(scan.calls.reduce((s, c) => s + c.credits, 0));
    expect(scan.calls.filter((c) => c.endpoint === "profiler/address/first-funder")).toHaveLength(12);
    expect(scan.diagnosis.sentence.length).toBeGreaterThan(0);
  });

  it("quick: 12 calls, concentration fallback, 30-day buyer walls", async () => {
    const { scan } = await runScanDetailed("base", TOKEN, { tier: "quick", scanNo: 1, now: new Date(NOW) });
    expect(scan.calls).toHaveLength(12);
    // token-information was complete: the reserved token-screener lookup was not needed.
    expect(scan.totals.credits).toBe(estimateCredits("quick", "base") - 1);
    expect(scan.findings.buyers.note).toMatch(/deep scan/);
    expect(scan.findings.buyers.clusters).toEqual([]);
    expect(scan.findings.walls.method).toBe("recent_buyers");
    expect(scan.findings.walls.walls[0].price).toBeCloseTo(1.2);
    expect(scan.calls.some((c) => c.endpoint === "profiler/address/first-funder" || c.endpoint === "tgm/holders")).toBe(false);
    expect(bodyErrors).toEqual([]);
  });

  it("empty token-information: one token-screener lookup by address (1 credit, body per spec) fills the meta; never search/general", async () => {
    seen.length = 0;
    const { scan } = await runScanDetailed("base", EMPTY, { tier: "quick", scanNo: 3, now: new Date(NOW) });
    expect(seen.some((s) => s.endpoint === "search/general")).toBe(false);
    const lookup = seen.filter((s) => s.endpoint === "token-screener");
    expect(lookup).toHaveLength(1);
    expect(lookup[0].body).toEqual({
      chains: ["base"],
      timeframe: "24h",
      pagination: { page: 1, per_page: 10 },
      filters: { token_address: EMPTY, include_native_tokens: true },
    });
    expect(bodyErrors).toEqual([]);
    // The screener has no name: it falls back to the symbol.
    expect(scan.meta).toMatchObject({ symbol: "EMPT", name: "EMPT", marketCapUsd: 4_000_000, liquidityUsd: 300_000, deployedAt: "2026-09-01T12:00:00.000Z" });
    // Market cap ÷ the price the screener computed it with.
    expect(scan.meta.circulatingSupply).toBe(2_000_000);
    expect(scan.calls.find((c) => c.endpoint === "token-screener")).toMatchObject({ finding: "context", credits: 1 });
    expect(scan.calls).toHaveLength(13);
    // The reserved lookup credit was spent: exactly the estimate.
    expect(scan.totals.credits).toBe(estimateCredits("quick", "base"));
    // A complete token-information never looks the token up.
    seen.length = 0;
    await runScanDetailed("base", TOKEN, { tier: "quick", scanNo: 4, now: new Date(NOW) });
    expect(seen.some((s) => s.endpoint === "token-screener" || s.endpoint === "search/general")).toBe(false);
    // Hints that cover the gaps skip the lookup too.
    seen.length = 0;
    const hinted = await runScanDetailed("base", EMPTY, {
      tier: "quick",
      scanNo: 5,
      now: new Date(NOW),
      hints: { symbol: "EMPT", marketCapUsd: 4_000_000, priceUsd: 2, liquidityUsd: 300_000 },
    });
    expect(seen.some((s) => s.endpoint === "token-screener")).toBe(false);
    expect(hinted.scan.meta).toMatchObject({ symbol: "EMPT", liquidityUsd: 300_000, circulatingSupply: 2_000_000 });
  });

  it("deep: pnl covering < 50% blends this month's buyers in (hybrid); allocations never reach the walls", async () => {
    seen.length = 0;
    const { scan, debug } = await runScanDetailed("base", HYB, { tier: "deep", maxBuyers: 1, maxHolders: 10, scanNo: 5, now: new Date(NOW) });
    const pnlAsked = seen.filter((s) => s.endpoint === "profiler/address/pnl").map((s) => s.body.address);
    // The team wallet is skipped by its label; the "received, never sent" whale is asked (a DEX buy is inflow too).
    expect(pnlAsked).not.toContain(ALLOC);
    expect(pnlAsked.sort()).toEqual([WHALE, H(0), H(1), H(2), H(3), H(4)].sort());
    // The 30-day list is read once: before the skip (to spare its buyers), then reused by the blend.
    const month = seen.filter((s) => s.endpoint === "tgm/who-bought-sold" && !s.body.filters && Date.parse(s.body.date.to) - Date.parse(s.body.date.from) > 20 * 86_400_000);
    expect(month).toHaveLength(1);
    expect(scan.calls.filter((c) => c.finding === "walls" && c.endpoint === "tgm/who-bought-sold")).toHaveLength(1);
    expect(debug.walls).toMatchObject({ method: "hybrid", skipped: 1, monthForSkips: true, allocations: 1, withCost: 2, noHistory: 1, proxyBuyers: 6 });
    // H(1) 40k and the whale 5k have a cost, of 95k analysed tokens.
    expect(debug.walls.pnlCoverage).toBeCloseTo(45 / 95);
    const w = scan.findings.walls;
    expect(w).toMatchObject({ method: "hybrid", costBasisHolders: 2, recentBuyers: 6, holdersAnalyzed: 6 + 6 });
    // Team wallet (label, 40%) + H(0) (pnl: bought_usd 0 over the whole history, 5%), of TOTAL supply.
    expect(w.allocatedShare).toBeCloseTo(0.45);
    // Supply with a cost: H(1) 40k and the whale 5k (pnl) + H(2) 1k and five buyers 1k each (proxy) of 1M.
    expect(w.analyzedSupplyShare).toBeCloseTo(0.051);
    expect(scan.totals.credits).toBeLessThanOrEqual(estimateCredits("deep", "base", { maxBuyers: 1, maxHolders: 10 }));
    expect(bodyErrors).toEqual([]);
  });

  it("rejects an invalid token with one error event and no calls", async () => {
    const events: ScanEvent[] = [];
    const before = seen.length;
    await expect(runScanDetailed("base", "0x123", { tier: "quick", scanNo: 1, onEvent: (e) => events.push(e) })).rejects.toThrow();
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("not a valid base token address"), retryable: false }]);
    expect(seen.length).toBe(before);
  });

  it("budget: reserves the estimate, enforces the daily cap and settles with real spend", async () => {
    const a = await admitScan({ ip: "1.2.3.4", chain: "base", token: TOKEN, tier: "quick", estimate: 12 });
    expect(a.ok).toBe(true);
    const big = await admitScan({ ip: "1.2.3.5", chain: "base", token: addr(7), tier: "deep", estimate: 75 });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(["daily_cap", "deep_cap"]).toContain(big.reason);
    if (a.ok) {
      expect(a.creditsLeftToday).toBe(80 - 12);
      await settleTicket(a.ticket, 3);
    }
    const w = await admitWalletCheck({ ip: "1.2.3.4" });
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.creditsLeftToday).toBe(80 - 3 - 1);
    await flushBudget();
    const saved = JSON.parse(readFileSync(path.join(root, ".cache", "budget.json"), "utf8"));
    expect(saved).toMatchObject({ spent: 4, scans: 1, walletChecks: 1 });
    expect(JSON.stringify(saved)).not.toContain("1.2.3.4");
  });
});

describe("visitor identity", () => {
  it("prefers platform headers, else the right-most X-Forwarded-For hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4", "fly-client-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "6.6.6.6" }))).toBe("5.5.5.5");
    expect(clientIp(new Headers())).toBe("local");
  });
});
