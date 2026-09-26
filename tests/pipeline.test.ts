import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureNansenClient } from "../lib/nansen/client";
import type { HolderRow, PnlRow } from "../lib/nansen/schemas";
import { buildScene, BuildError, NO_KEY_MESSAGE } from "../lib/pipeline/build";
import {
  assignCohort,
  computeCoverage,
  conviction,
  costFromPnl,
  deriveHolder,
  detectOwnershipScale,
  isContractLabel,
  mapFlows,
  ohlcvToPoints,
  pickPnlRecord,
  pnlWindows,
  selectHolders,
  type DeriveInput,
} from "../lib/pipeline/derive";
import { upsertIndexEntry, type SceneIndexEntry } from "../lib/pipeline/gallery";
import { toPublicScene } from "../lib/pipeline/sanitize";
import type { SceneEvent } from "../lib/types";

const TOKEN = "0x1111111111111111111111111111111111111111";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function holderRow(address: string, amount: number, label: string | null = null, ownership: number | null = null): HolderRow {
  return {
    address,
    address_label: label,
    token_amount: amount,
    total_outflow: null,
    total_inflow: null,
    balance_change_24h: null,
    balance_change_7d: null,
    balance_change_30d: null,
    ownership_percentage: ownership,
    value_usd: null,
  };
}

function pnlRow(p: Partial<PnlRow>): PnlRow {
  return {
    token_address: TOKEN,
    token_symbol: "TIDE",
    token_price: null,
    roi_percent_realised: null,
    pnl_usd_realised: null,
    pnl_usd_unrealised: null,
    roi_percent_unrealised: null,
    bought_amount: null,
    bought_usd: null,
    cost_basis_usd: null,
    sold_amount: null,
    sold_usd: null,
    avg_sold_price_usd: null,
    holding_amount: null,
    holding_usd: null,
    nof_buys: null,
    nof_sells: null,
    max_balance_held: null,
    max_balance_held_usd: null,
    ...p,
  };
}

function derive(p: Partial<DeriveInput>) {
  return deriveHolder({
    id: 0,
    cohort: "other",
    chain: "base",
    tokenAddress: TOKEN,
    address: addr(9),
    label: null,
    tokenAmount: 100,
    ownershipPct: null,
    ownershipScale: 100,
    supply: 1_000_000,
    priceNow: 2,
    pnlRows: [],
    ...p,
  });
}

describe("cost basis, fog and conviction", () => {
  it("derives cost = (holding_usd − unrealised) / holding_amount and the multiple", () => {
    // 1000 tokens worth $2000 now with +$1500 unrealised → cost basis $500 → $0.50 per token → 4x.
    const h = derive({
      pnlRows: [pnlRow({ holding_amount: 1000, holding_usd: 2000, pnl_usd_unrealised: 1500, max_balance_held: 4000, nof_buys: "7", nof_sells: "3" })],
    });
    expect(h.cost).toBeCloseTo(0.5);
    expect(h.multiple).toBeCloseTo(4);
    expect(h.fog).toBeNull();
    expect(h.amount).toBe(1000);
    expect(h.conviction).toBeCloseTo(0.25);
    expect(h.maxHeld).toBe(4000);
    expect(h.buys).toBe(7);
    expect(h.sells).toBe(3);
    expect(h.supplyShare).toBeCloseTo(0.001);
    expect(h.tag).toBeUndefined();
  });

  it("marks underwater holders correctly (cost above price)", () => {
    const h = derive({ pnlRows: [pnlRow({ holding_amount: 100, holding_usd: 200, pnl_usd_unrealised: -300 })] });
    expect(h.cost).toBeCloseTo(5);
    expect(h.multiple).toBeCloseTo(0.4);
  });

  it("fogs non-positive or missing costs as no_cost", () => {
    expect(derive({ pnlRows: [pnlRow({ holding_amount: 100, holding_usd: 200, pnl_usd_unrealised: 250 })] }).fog).toBe("no_cost");
    expect(derive({ pnlRows: [pnlRow({ holding_amount: 100, holding_usd: 200, pnl_usd_unrealised: null })] }).fog).toBe("no_cost");
    expect(derive({ pnlRows: [pnlRow({ holding_amount: 0, holding_usd: 0, pnl_usd_unrealised: 0 })] }).fog).toBe("no_cost");
    const empty = derive({ pnlRows: [] });
    expect(empty.fog).toBe("no_cost");
    expect(empty.cost).toBeNull();
    expect(empty.multiple).toBeNull();
    expect(empty.amount).toBe(100); // falls back to tgm/holders token_amount
  });

  it("fogs costs more than 1000x away from the price as out_of_range", () => {
    const tooCheap = derive({ pnlRows: [pnlRow({ holding_amount: 1e6, holding_usd: 2e6, pnl_usd_unrealised: 2e6 - 1 })] });
    expect(tooCheap.fog).toBe("out_of_range");
    expect(tooCheap.cost).toBeNull();
    const tooDear = derive({ pnlRows: [pnlRow({ holding_amount: 1, holding_usd: 2, pnl_usd_unrealised: -5000 })] });
    expect(tooDear.fog).toBe("out_of_range");
  });

  it("fogs failed pnl calls as pnl_error", () => {
    const h = derive({ pnlRows: null });
    expect(h.fog).toBe("pnl_error");
    expect(h.conviction).toBe(1);
  });

  it("clamps conviction and defaults to 1 without max_balance_held", () => {
    expect(conviction(50, 100)).toBe(0.5);
    expect(conviction(150, 100)).toBe(1);
    expect(conviction(50, null)).toBe(1);
    expect(conviction(50, 0)).toBe(1);
  });

  it("picks the pnl record for the token case-insensitively", () => {
    const rows = [pnlRow({ token_address: addr(5), holding_amount: 1 }), pnlRow({ token_address: TOKEN.toUpperCase().replace("0X", "0x"), holding_amount: 2 })];
    expect(pickPnlRecord(rows, "base", TOKEN)?.holding_amount).toBe(2);
    expect(pickPnlRecord(rows, "base", addr(7))).toBeNull();
    expect(costFromPnl(null)).toBeNull();
  });

  it("takes a lone pnl row as the token's record (the request is already filtered by token)", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const lone = [pnlRow({ token_address: "0xdeadbeef", holding_amount: 3 })];
    expect(pickPnlRecord(lone, "solana", mint)?.holding_amount).toBe(3);
    expect(pickPnlRecord([], "solana", mint)).toBeNull();
  });

  it("adds a short tag only when asked", () => {
    expect(derive({ includeTags: true, label: "Some Fund" }).tag).toBe("Some Fund");
    expect(derive({ includeTags: true, label: null, address: TOKEN }).tag).toBe("0x1111…1111");
  });
});

describe("exclusions and cohorts", () => {
  it("recognises contract-like labels as whole words, keeping team wallets and look-alike names", () => {
    for (const l of [
      "Uniswap V3: TIDE-WETH Pool",
      "UniswapV2Pair",
      "Team Finance: Timelock",
      "Unicrypt Locker",
      "Wormhole Bridge",
      "Burn Address",
      "Aerodrome: Router",
      "pump.fun Bonding Curve",
      "Raydium Liquidity Pool V4",
      "Orca Whirlpool",
    ]) {
      expect(isContractLabel(l), l).toBe(true);
    }
    for (const l of [
      "Blockchain Capital",
      "Wintermute",
      "vitalik.eth",
      "Gnosis Safe Multisig",
      "Token Deployer",
      "Liverpool Fan Token Whale",
      "Repair DAO",
      "Bridgewater",
      "Porcaro",
      "Deadpool Collector",
      null,
    ]) {
      expect(isContractLabel(l), String(l)).toBe(false);
    }
  });

  it("assigns cohorts with priority SM > PF > Whale > Other", () => {
    expect(assignCohort({ sm: true, pf: true, whale: true })).toBe("sm");
    expect(assignCohort({ pf: true, whale: true })).toBe("pf");
    expect(assignCohort({ whale: true })).toBe("whale");
    expect(assignCohort({})).toBe("other");
  });

  it("selects the top holders by balance and excludes exchanges/contracts", () => {
    const sm = addr(0xa);
    const whale = addr(0xb);
    const pf = addr(0xc);
    const cex = addr(0xd);
    const pool = addr(0xe);
    const smallSm = addr(0xf);
    const all = [
      holderRow(pool, 50_000, "Uniswap V3: Pool"),
      holderRow(cex, 40_000, "Binance 14"),
      holderRow(TOKEN, 5_000),
      holderRow(addr(1), 30_000),
      holderRow(addr(2), 20_000),
      holderRow(whale.toUpperCase().replace("0X", "0x"), 10_000),
      holderRow(sm, 9_000),
      holderRow(pf, 8_000),
      holderRow(addr(3), 7_000),
      holderRow(smallSm, 10),
      holderRow("0x000000000000000000000000000000000000dEaD", 4_000),
    ];
    const res = selectHolders({
      chain: "base",
      tokenAddress: TOKEN,
      allHolders: all,
      whales: [holderRow(whale, 10_000), holderRow(sm, 9_000)],
      publicFigures: [holderRow(pf, 8_000)],
      exchanges: [holderRow(addr(0x77), 1_000)],
      smartMoney: [sm.toUpperCase().replace("0X", "0x"), smallSm, addr(0x99)],
      maxHolders: 5,
      supply: 1_000_000,
    });

    const byAddr = new Map(res.chosen.map((c) => [c.key, c]));
    expect(res.chosen).toHaveLength(5);
    // With a cap of 5 the labelled quota rounds down to 0: plain top 5 by balance.
    expect(byAddr.get(sm)?.cohort).toBe("sm");
    expect(byAddr.get(whale)?.cohort).toBe("whale");
    expect(byAddr.get(pf)?.cohort).toBe("pf");
    expect(byAddr.get(addr(1))?.cohort).toBe("other");
    expect(byAddr.get(addr(2))?.cohort).toBe("other");
    expect(byAddr.has(smallSm)).toBe(false);
    expect(byAddr.has(pool) || byAddr.has(cex) || byAddr.has(TOKEN)).toBe(false);
    // Ids are ranks by balance.
    expect(res.chosen.map((c) => c.id)).toEqual([0, 1, 2, 3, 4]);
    expect(res.chosen.map((c) => c.key)).toEqual([addr(1), addr(2), whale, sm, pf]);
    expect(res.counts).toEqual({ sm: 1, whale: 1, pf: 1, other: 2 });
    // CEX: Binance label (40k) + exchange list (1k); contracts: pool + token itself + dead address.
    expect(res.exchangeShare).toBeCloseTo(0.041);
    expect(res.contractShare).toBeCloseTo(0.059);
    expect(res.excluded).toEqual({ exchange: 2, contract: 3 });
  });

  it("lets small labelled holders take at most 15% of the slots", () => {
    const others = Array.from({ length: 40 }, (_, i) => holderRow(addr(0x100 + i), 100_000 - i));
    const smallSm = Array.from({ length: 5 }, (_, i) => addr(0x200 + i));
    const res = selectHolders({
      chain: "base",
      tokenAddress: TOKEN,
      allHolders: [...others, ...smallSm.map((a, i) => holderRow(a, 50 - i))],
      whales: [],
      publicFigures: [],
      exchanges: [],
      smartMoney: smallSm,
      maxHolders: 20,
      supply: 10_000_000,
    });
    expect(res.chosen).toHaveLength(20);
    // floor(20 × 0.15) = 3 reserved slots: the 3 largest small SM wallets replace the 3 smallest others.
    expect(res.counts).toEqual({ sm: 3, whale: 0, pf: 0, other: 17 });
    expect(res.chosen.slice(0, 17).map((c) => c.key)).toEqual(others.slice(0, 17).map((r) => r.address));
    expect(res.chosen.slice(17).map((c) => c.key)).toEqual(smallSm.slice(0, 3));
    expect(res.chosen.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("detects ownership_percentage units", () => {
    const pctRows = [holderRow(addr(1), 100, null, 10), holderRow(addr(2), 50, null, 5)];
    expect(detectOwnershipScale(pctRows, 1000)).toBe(100);
    const fracRows = [holderRow(addr(1), 100, null, 0.1), holderRow(addr(2), 50, null, 0.05)];
    expect(detectOwnershipScale(fracRows, 1000)).toBe(1);
    expect(detectOwnershipScale(pctRows, null)).toBe(100);
    expect(detectOwnershipScale(fracRows, null)).toBe(1);
  });
});

describe("coverage, flows, candles and dates", () => {
  it("computes coverage with an amount-weighted fog share", () => {
    const a = derive({ id: 0, pnlRows: [pnlRow({ holding_amount: 300, holding_usd: 600, pnl_usd_unrealised: 300 })] });
    const b = derive({ id: 1, pnlRows: null, tokenAmount: 100 });
    const c = computeCoverage([a, b], 0.1, 0.2);
    expect(c.holdersAnalyzed).toBe(2);
    expect(c.fogShare).toBeCloseTo(0.25);
    expect(c.analyzedSupplyShare).toBeCloseTo(0.0004);
    expect(c.exchangeShare).toBe(0.1);
    expect(c.contractShare).toBe(0.2);
  });

  it("maps flow-intelligence segments to cohorts", () => {
    const flows = mapFlows({
      smart_trader_net_flow_usd: 1000,
      smart_trader_wallet_count: 3,
      whale_net_flow_usd: -500,
      whale_wallet_count: 2,
      public_figure_net_flow_usd: null,
      fresh_wallets_net_flow_usd: 42,
      exchange_net_flow_usd: -7,
    } as never);
    expect(flows).toEqual([
      { cohort: "sm", netFlowUsd: 1000, walletCount: 3 },
      { cohort: "whale", netFlowUsd: -500, walletCount: 2 },
      { cohort: "fresh", netFlowUsd: 42, walletCount: 0 },
      { cohort: "exchange", netFlowUsd: -7, walletCount: 0 },
    ]);
    expect(mapFlows(undefined)).toEqual([]);
  });

  it("orders candles oldest first and carries open forward", () => {
    const pts = ohlcvToPoints([
      { interval_start: "2026-09-25T02:00:00Z", open: null, high: 3, low: 1, close: 2, volume: null, volume_usd: null },
      { interval_start: "2026-09-25T01:00:00Z", open: null, high: 1.5, low: 0.9, close: 1, volume: null, volume_usd: null },
      { interval_start: "bad", open: 1, high: 1, low: 1, close: 1, volume: null, volume_usd: null },
    ]);
    expect(pts.map((p) => p.c)).toEqual([1, 2]);
    expect(pts[1].o).toBe(1);
    expect(pts[0].o).toBe(1);
  });

  it("builds pnl windows capped at 364 days with narrower fallbacks", () => {
    const now = new Date("2026-09-25T12:34:56Z");
    const old = pnlWindows("2020-01-01T00:00:00Z", now);
    expect(old.map((w) => w.label)).toEqual(["full", "90d", "30d"]);
    expect(old[0].from).toBe("2025-09-26T00:00:00Z");
    expect(old[0].to).toBe("2026-09-25T12:34:00Z");
    const young = pnlWindows("2026-09-01T08:00:00Z", now);
    expect(young.map((w) => w.label)).toEqual(["full"]);
    expect(young[0].from).toBe("2026-09-01T00:00:00Z");
    expect(pnlWindows(null, now)).toHaveLength(3);
  });
});

describe("public scenes and gallery index", () => {
  it("rounds public balances to two significant figures", () => {
    const h = { ...derive({}), amount: 1_234_567, maxHeld: 2_345_678, supplyShare: 0.0123456 };
    const scene = {
      version: 1 as const,
      meta: {
        chain: "base",
        tokenAddress: TOKEN,
        symbol: "TIDE",
        name: "Tide",
        priceNow: 2,
        liquidityUsd: null,
        marketCapUsd: null,
        circulatingSupply: null,
        totalHolders: null,
        deployedAt: null,
        pnlFrom: "2025-09-26",
        pnlTo: "2026-09-25",
        generatedAt: "2026-09-25T00:00:00Z",
      },
      holders: [h],
      coverage: computeCoverage([h], 0, 0),
      ohlcv: [],
      flows: [],
      calls: [],
      totals: { calls: 0, networkCalls: 0, credits: 0, cacheHits: 0, durationMs: 0 },
    };
    const [pub] = toPublicScene(scene).holders;
    expect(pub.amount).toBe(1_200_000);
    expect(pub.maxHeld).toBe(2_300_000);
    expect(pub.supplyShare).toBe(0.012);
    expect(pub.cost).toBe(h.cost);
  });

  it("strips tags and wallet addresses but keeps the token address", () => {
    const h = derive({ includeTags: true, label: "whale.eth" });
    const scene = {
      version: 1 as const,
      meta: {
        chain: "base",
        tokenAddress: TOKEN,
        symbol: "TIDE",
        name: `Tide ${addr(0x42)}`,
        logo: `https://img/${TOKEN}.png`,
        priceNow: 2,
        liquidityUsd: null,
        marketCapUsd: null,
        circulatingSupply: null,
        totalHolders: null,
        deployedAt: null,
        pnlFrom: "2025-09-26",
        pnlTo: "2026-09-25",
        generatedAt: "2026-09-25T00:00:00Z",
      },
      holders: [h],
      coverage: computeCoverage([h], 0, 0),
      ohlcv: [],
      flows: [],
      calls: [],
      totals: { calls: 0, networkCalls: 0, credits: 0, cacheHits: 0, durationMs: 0 },
    };
    const pub = toPublicScene(scene);
    expect(pub.holders[0].tag).toBeUndefined();
    expect(pub.meta.tokenAddress).toBe(TOKEN);
    expect(pub.meta.logo).toBe(`https://img/${TOKEN}.png`);
    expect(pub.meta.name).toBe("Tide [redacted]");
    expect(JSON.stringify(pub)).not.toContain(addr(0x42));
    expect(scene.holders[0].tag).toBe("whale.eth"); // input untouched
  });

  it("upserts index entries and keeps synthetic fixtures out", () => {
    const e = (file: string, symbol = "A"): SceneIndexEntry => ({
      chain: "base",
      tokenAddress: TOKEN,
      symbol,
      name: symbol,
      underwaterShare: 0.4,
      holdersAnalyzed: 10,
      generatedAt: "2026-09-25T00:00:00Z",
      file,
    });
    let idx = upsertIndexEntry([e("_synthetic.json")], e("base-a.json"));
    expect(idx.map((x) => x.file)).toEqual(["base-a.json"]);
    idx = upsertIndexEntry(idx, e("base-a.json", "B"));
    expect(idx).toHaveLength(1);
    expect(idx[0].symbol).toBe("B");
    expect(upsertIndexEntry(idx, e("_synthetic-x.json"))).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ pipeline with a mocked API

describe("buildScene (mocked Nansen API, no network)", () => {
  const savedEnv = { key: process.env.NANSEN_API_KEY, cache: process.env.NANSEN_CACHE, ledger: process.env.NANSEN_LEDGER };
  const violations: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) violations.push(msg);
  };
  let outOfCredits = false;
  let pnlForbidden = false;
  let wbsTimesOut = false;
  let deployDate = "2024-01-01T00:00:00Z";
  const emptyPnl = new Set<string>();
  const SM = addr(0xa);
  const FAIL = addr(0xb);
  const NARROW = addr(0xc);

  function respond(status: number, body: unknown, credits = 1) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-nansen-credits-used": String(status < 300 ? credits : 0) },
    });
  }

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api\/v1\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    switch (path) {
      case "tgm/token-information":
        return respond(200, {
          data: {
            name: "Tide",
            symbol: "TIDE",
            logo: "https://logo",
            token_details: { token_deployment_date: deployDate, circulating_supply: "1000000", market_cap_usd: 2e6 },
            spot_metrics: { liquidity_usd: 250000, total_holders: 5000 },
          },
        });
      case "tgm/token-ohlcv":
        return respond(200, {
          chain: "base",
          token_address: TOKEN,
          timeframe: "1h",
          data: [
            { interval_start: "2026-09-25T10:00:00Z", open: null, high: 2.1, low: 1.9, close: 2.0, market_cap: {} },
            { interval_start: "2026-09-25T09:00:00Z", open: null, high: 1.9, low: 1.7, close: 1.8, market_cap: {} },
          ],
        });
      case "tgm/holders": {
        check(body.label_type !== "smart_money", "tgm/holders called with label_type smart_money");
        check(body.premium_labels === undefined, "premium_labels must be omitted");
        if (body.label_type === "all_holders") {
          return respond(200, {
            data: [
              { address: addr(0xe), address_label: "Uniswap V3: Pool", token_amount: 100000 },
              { address: SM, token_amount: 50000 },
              { address: FAIL, token_amount: 40000 },
              { address: NARROW, token_amount: 30000 },
            ],
            pagination: { page: 1, per_page: 1000, is_last_page: true },
          }, 5);
        }
        check(body.filters?.include_smart_money_labels?.length === 1, `labels filter missing for ${body.label_type}`);
        if (body.label_type === "exchange") return respond(200, { data: [{ address: addr(0xd), token_amount: 20000 }], pagination: {} }, 5);
        return respond(200, { data: [], pagination: {} }, 5);
      }
      case "tgm/who-bought-sold": {
        check(!body.filters.include_smart_money_labels.includes("Fund"), "deprecated Fund label used");
        const days = (Date.parse(body.date.to) - Date.parse(body.date.from)) / 86_400_000;
        if (wbsTimesOut && days > 100) {
          return respond(504, { code: "query_timeout", message: "Query took too long", status: 504, retry_after: 30 });
        }
        return respond(200, { data: body.buy_or_sell === "BUY" ? [{ address: SM }] : [], pagination: {} });
      }
      case "profiler/address/pnl": {
        check(body.filters.token_address === TOKEN && typeof body.address === "string", "pnl body shape");
        if (outOfCredits) return respond(402, { code: "insufficient_credits", message: "Not enough credits", status: 402 });
        if (pnlForbidden) return respond(403, { code: "forbidden", message: "Plan has no profiler access", status: 403 });
        if (emptyPnl.has(body.address)) return respond(200, { data: [], pagination: {} });
        if (body.address === FAIL) return respond(422, { code: "invalid_address_format", message: "bad", status: 422 });
        const days = (Date.parse(body.date.to) - Date.parse(body.date.from)) / 86_400_000;
        if (body.address === NARROW && days > 100) {
          return respond(400, { code: "invalid_date_range", message: "Range too long for this address", status: 400 });
        }
        return respond(200, {
          data: [{ token_address: TOKEN, token_symbol: "TIDE", holding_amount: 1000, holding_usd: 2000, pnl_usd_unrealised: 1000, max_balance_held: 2000, nof_buys: "2", nof_sells: "1" }],
          pagination: {},
        });
      }
      case "tgm/flow-intelligence":
        return respond(403, { code: "forbidden", message: "no access", status: 403 });
      default:
        return respond(404, { code: "not_found", message: path, status: 404 });
    }
  });

  beforeAll(() => {
    process.env.NANSEN_API_KEY = "test-key";
    process.env.NANSEN_CACHE = "off";
    process.env.NANSEN_LEDGER = "off";
    configureNansenClient({ ratePerMin: 60_000, concurrency: 4 });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("NANSEN_API_KEY", savedEnv.key);
    restore("NANSEN_CACHE", savedEnv.cache);
    restore("NANSEN_LEDGER", savedEnv.ledger);
  });

  it("streams events and assembles a scene", async () => {
    const events: SceneEvent[] = [];
    const scene = await buildScene("base", TOKEN, { maxHolders: 10, onEvent: (e) => events.push(e), now: new Date("2026-09-25T12:00:00Z") });

    expect(scene.meta.priceNow).toBe(2);
    expect(scene.ohlcv.map((p) => p.c)).toEqual([1.8, 2]);
    expect(scene.meta.pnlFrom).toBe("2025-09-26");
    expect(scene.holders.map((h) => h.id)).toEqual([0, 1, 2]);
    const [sm, failed, narrow] = scene.holders;
    expect(sm.cohort).toBe("sm");
    expect(sm.cost).toBeCloseTo(1);
    expect(sm.multiple).toBeCloseTo(2);
    expect(sm.conviction).toBeCloseTo(0.5);
    expect(failed.fog).toBe("pnl_error");
    expect(narrow.fog).toBeNull(); // succeeded on the 90d window after invalid_date_range
    expect(scene.coverage.contractShare).toBeCloseTo(0.1);
    expect(scene.coverage.exchangeShare).toBeCloseTo(0.02);
    expect(scene.flows).toEqual([]); // flow-intelligence failure is non-fatal

    const pnlCalls = scene.calls.filter((c) => c.endpoint === "profiler/address/pnl");
    expect(pnlCalls).toHaveLength(4); // 3 holders + 1 invalid_date_range retry
    expect(pnlCalls.filter((c) => c.holderId !== undefined).map((c) => c.holderId).sort()).toEqual([0, 1, 2]);
    expect(scene.totals.calls).toBe(scene.calls.length);
    expect(scene.totals.credits).toBe(2 + 4 * 5 + 2 + 2);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stage");
    expect(types.indexOf("meta")).toBeLessThan(types.indexOf("cohorts"));
    expect(types.indexOf("cohorts")).toBeLessThan(types.indexOf("holder"));
    expect(types.filter((t) => t === "holder")).toHaveLength(3);
    expect(types[types.length - 1]).toBe("done");
    const stages = events.flatMap((e) => (e.type === "stage" ? [e.stage] : []));
    expect(stages).toEqual(["info", "holders", "cohorts", "costbasis", "flows", "done"]);
    expect(violations).toEqual([]);
  });

  it("stops the whole build when the account runs out of credits", async () => {
    outOfCredits = true;
    const events: SceneEvent[] = [];
    await expect(buildScene("base", TOKEN, { onEvent: (e) => events.push(e) })).rejects.toBeInstanceOf(BuildError);
    outOfCredits = false;
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && /Not enough credits/.test(err.message)).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("stops the build when the profiler answers 403 instead of fogging every holder", async () => {
    pnlForbidden = true;
    const events: SceneEvent[] = [];
    await expect(buildScene("base", TOKEN, { onEvent: (e) => events.push(e) })).rejects.toBeInstanceOf(BuildError);
    pnlForbidden = false;
    expect(events.some((e) => e.type === "error" && /profiler/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "holder")).toBe(false);
  });

  it("narrows who-bought-sold at once on a 5xx query_timeout instead of waiting to retry", async () => {
    wbsTimesOut = true;
    const t0 = Date.now();
    const scene = await buildScene("base", TOKEN, { maxHolders: 10, now: new Date("2026-09-25T12:00:00Z") });
    wbsTimesOut = false;
    expect(Date.now() - t0).toBeLessThan(3000);
    const wbs = scene.calls.filter((c) => c.endpoint === "tgm/who-bought-sold").map((c) => c.status);
    expect(wbs.sort()).toEqual([200, 200, 504, 504]);
    expect(scene.holders.find((h) => h.id === 0)?.cohort).toBe("sm");
  });

  it("drops holders with no pnl history when the window covers the token's whole life", async () => {
    deployDate = "2026-06-01T00:00:00Z";
    emptyPnl.add(NARROW);
    try {
      const young = await buildScene("base", TOKEN, { maxHolders: 10, now: new Date("2026-09-25T12:00:00Z") });
      expect(young.holders.map((h) => h.id)).toEqual([0, 1]);
      // Pool (10%) + the history-less holder (3%) both count as contract supply.
      expect(young.coverage.contractShare).toBeCloseTo(0.13);

      deployDate = "2024-01-01T00:00:00Z";
      const old = await buildScene("base", TOKEN, { maxHolders: 10, now: new Date("2026-09-25T12:00:00Z") });
      // A 364-day window may miss an old position: that holder stays, as fog.
      expect(old.holders.find((h) => h.id === 2)?.fog).toBe("no_cost");
      expect(old.coverage.contractShare).toBeCloseTo(0.1);
    } finally {
      deployDate = "2024-01-01T00:00:00Z";
      emptyPnl.clear();
    }
  });

  it("fails with the no-key message when the key is missing", async () => {
    delete process.env.NANSEN_API_KEY;
    const events: SceneEvent[] = [];
    await expect(buildScene("base", TOKEN, { onEvent: (e) => events.push(e) })).rejects.toBeInstanceOf(BuildError);
    expect(events).toContainEqual({ type: "error", message: NO_KEY_MESSAGE, retryable: false });
    process.env.NANSEN_API_KEY = "test-key";
  });

  it("rejects unsupported chains and malformed addresses", async () => {
    await expect(buildScene("tron", TOKEN)).rejects.toThrow(/not supported/);
    await expect(buildScene("base", "0x123")).rejects.toThrow(/not a valid/);
  });
});
