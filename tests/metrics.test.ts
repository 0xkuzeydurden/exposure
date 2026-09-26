import { describe, expect, it } from "vitest";
import { makeSyntheticScene } from "@/lib/fixtures/synthetic";
import {
  costProfile,
  drowningWithYou,
  findReefs,
  heightOf,
  priceAtLevel,
  smPainPrice,
  smUnderwaterShare,
  tideSnapshot,
  waterLevel,
} from "@/lib/metrics";
import { COHORTS, MAX_LOG2, MIN_LOG2, type Cohort, type HolderPoint } from "@/lib/types";

let nextId = 0;
function holder(cohort: Cohort, amount: number, cost: number | null, conviction = 1, priceNow = 1): HolderPoint {
  return {
    id: nextId++,
    cohort,
    amount,
    supplyShare: amount / 10_000,
    cost,
    multiple: cost == null ? null : priceNow / cost,
    conviction,
    maxHeld: amount / conviction,
    buys: 1,
    sells: conviction < 1 ? 1 : 0,
    fog: cost == null ? "no_cost" : null,
  };
}

describe("heightOf / waterLevel", () => {
  it("encodes log2 of the profit multiple, clamped", () => {
    expect(heightOf(holder("sm", 1, 0.25))).toBeCloseTo(2);
    expect(heightOf(holder("sm", 1, 2))).toBeCloseTo(-1);
    expect(heightOf(holder("sm", 1, 1 / 100))).toBe(MAX_LOG2);
    expect(heightOf(holder("sm", 1, 100))).toBe(MIN_LOG2);
    expect(heightOf(holder("sm", 1, null))).toBeNull();
  });

  it("water rises as the price falls and inverts cleanly", () => {
    expect(waterLevel(2, 1)).toBeCloseTo(1);
    expect(waterLevel(2, 4)).toBeCloseTo(-1);
    expect(waterLevel(2, 2)).toBe(0);
    expect(priceAtLevel(2, 1)).toBeCloseTo(1);
    expect(priceAtLevel(0.0421, waterLevel(0.0421, 0.0333))).toBeCloseTo(0.0333, 12);
  });
});

describe("tideSnapshot", () => {
  const hs = [
    holder("sm", 100, 2),
    holder("whale", 300, 0.5),
    holder("other", 600, 1.5),
    holder("other", 1000, null),
  ];

  it("weights underwater supply by amount over holders with a cost", () => {
    const s = tideSnapshot(hs, 2, 1);
    expect(s.price).toBe(1);
    expect(s.waterLevel).toBeCloseTo(1);
    expect(s.underwaterShare).toBeCloseTo(0.7);
    expect(s.fogShare).toBeCloseTo(0.5);
    expect(s.underwaterByCohort).toEqual({ sm: 1, whale: 0, pf: 0, other: 1 });
  });

  it("treats cost == price as break-even, not underwater", () => {
    const s = tideSnapshot(hs, 2, 1.5);
    expect(s.underwaterShare).toBeCloseTo(0.1);
    expect(s.underwaterByCohort.other).toBe(0);
  });

  it("excludes fog from numerator and denominator", () => {
    const withMoreFog = [...hs, holder("sm", 50_000, null), holder("whale", 7, null)];
    const a = tideSnapshot(hs, 2, 1);
    const b = tideSnapshot(withMoreFog, 2, 1);
    expect(b.underwaterShare).toBeCloseTo(a.underwaterShare);
    expect(b.underwaterByCohort.sm).toBeCloseTo(1);
    expect(b.fogShare).toBeCloseTo(51_007 / 52_007);
  });

  it("handles empty input", () => {
    const s = tideSnapshot([], 1, 1);
    expect(s.underwaterShare).toBe(0);
    expect(s.fogShare).toBe(0);
  });
});

describe("findReefs", () => {
  // Bins over (1, 2] have width 2^(1/24) ≈ 2.93%.
  const hs = [
    holder("other", 999, 1), // exactly at fromPrice: excluded
    holder("other", 100, 1.1), // bin 3
    holder("whale", 50, 1.105, 0.5), // bin 3
    holder("other", 10, 1.2), // bin 6, isolated small peak
    holder("other", 5, 1.47), // bin 13, shoulder
    holder("sm", 200, 1.5), // bin 14
    holder("other", 40, 1.52), // bin 14
    holder("pf", 30, 2), // bin 23 (toPrice inclusive)
    holder("whale", 400, 2.5), // beyond toPrice
    holder("other", 1000, null), // fog
  ];

  it("returns the largest local maxima ordered by distance", () => {
    const reefs = findReefs(hs, 1, 1, 2, 1000);
    expect(reefs).toHaveLength(3);

    const [a, b, c] = reefs;
    expect(a.amount).toBeCloseTo(150);
    expect(a.price).toBeCloseTo((100 * 1.1 + 50 * 1.105) / 150);
    expect(a.movePct).toBeCloseTo(a.price - 1);
    expect(a.sellPressure).toBeCloseTo((50 * 0.5) / 150);
    expect(a.cohort).toBe("other");
    expect(a.supplyShare).toBeCloseTo(0.015);
    expect(a.wallToLiquidity).toBeCloseTo((110 + 55.25) / 1000);

    expect(b.amount).toBeCloseTo(240);
    expect(b.price).toBeCloseTo((200 * 1.5 + 40 * 1.52) / 240);
    expect(b.cohort).toBe("sm");
    expect(b.sellPressure).toBe(0);

    expect(c.amount).toBeCloseTo(30);
    expect(c.price).toBeCloseTo(2);
    expect(c.movePct).toBeCloseTo(1);
    expect(c.cohort).toBe("pf");
  });

  it("respects the limit and a missing liquidity", () => {
    const reefs = findReefs(hs, 1, 1, 2, null, 2);
    expect(reefs.map((r) => Math.round(r.amount))).toEqual([150, 240]);
    expect(reefs.every((r) => r.wallToLiquidity === null)).toBe(true);
  });

  it("measures movePct against priceNow, not fromPrice", () => {
    const [a] = findReefs(hs, 0.5, 1, 2, null);
    expect(a.movePct).toBeCloseTo(a.price / 0.5 - 1);
  });

  it("walks downward for support shelves", () => {
    const down = [
      holder("sm", 100, 0.9),
      holder("whale", 300, 0.6),
      holder("other", 20, 0.5),
      holder("other", 500, 1.2),
      holder("other", 70, 0.4),
      holder("other", 999, 1),
    ];
    const reefs = findReefs(down, 1, 1, 0.5, null);
    expect(reefs.map((r) => r.price)).toEqual([expect.closeTo(0.9), expect.closeTo(0.6), expect.closeTo(0.5)]);
    expect(reefs.map((r) => r.amount)).toEqual([100, 300, 20]);
    expect(reefs.map((r) => r.movePct)).toEqual([
      expect.closeTo(-0.1),
      expect.closeTo(-0.4),
      expect.closeTo(-0.5),
    ]);

    const up = findReefs(down, 1, 1, 2, null);
    expect(up).toHaveLength(1);
    expect(up[0].price).toBeCloseTo(1.2);
  });

  it("counts a single dominant bin and resolves plateaus to one peak", () => {
    expect(findReefs([holder("other", 5, 1.3)], 1, 1, 2, null)).toHaveLength(1);
    // 1.1 and 1.13 fall in adjacent bins (3 and 4) with equal amounts.
    const plateau = findReefs([holder("other", 10, 1.1), holder("other", 10, 1.13)], 1, 1, 2, null);
    expect(plateau).toHaveLength(1);
  });

  it("returns nothing for a degenerate range", () => {
    expect(findReefs(hs, 1, 1, 1, null)).toEqual([]);
    expect(findReefs(hs, 1, 0, 2, null)).toEqual([]);
    expect(findReefs([], 1, 1, 2, null)).toEqual([]);
  });
});

describe("Smart Money pain line", () => {
  const hs = [
    holder("sm", 100, 1),
    holder("sm", 300, 2),
    holder("sm", 1000, null),
    holder("whale", 500, 10),
  ];

  it("is the amount-weighted SM cost, ignoring fog and other cohorts", () => {
    expect(smPainPrice(hs)).toBeCloseTo(1.75);
    expect(smPainPrice([holder("whale", 1, 1)])).toBeNull();
    expect(smPainPrice([holder("sm", 1, null)])).toBeNull();
  });

  it("reports the underwater SM share", () => {
    expect(smUnderwaterShare(hs, 1.5)).toBeCloseTo(0.75);
    expect(smUnderwaterShare(hs, 0.5)).toBeCloseTo(1);
    expect(smUnderwaterShare(hs, 2)).toBe(0);
    expect(smUnderwaterShare([holder("pf", 1, 1)], 1)).toBeNull();
  });
});

describe("costProfile", () => {
  it("bins supply by log cost per cohort, clamping outliers into edge bins", () => {
    const hs = [
      holder("sm", 10, 1.5),
      holder("whale", 20, 3),
      holder("other", 5, 0.5),
      holder("pf", 7, 8),
      holder("other", 100, null),
    ];
    const bins = costProfile(hs, 2, 1, 4);
    expect(bins).toHaveLength(2);
    expect(bins[0].lo).toBe(1);
    expect(bins[0].hi).toBeCloseTo(2);
    expect(bins[1].lo).toBeCloseTo(2);
    expect(bins[1].hi).toBe(4);
    expect(bins[0].byCohort).toEqual({ sm: 10, whale: 0, pf: 0, other: 5 });
    expect(bins[1].byCohort).toEqual({ sm: 0, whale: 20, pf: 7, other: 0 });
  });

  it("sums to all supply with a cost", () => {
    const scene = makeSyntheticScene();
    const P = scene.meta.priceNow;
    const bins = costProfile(scene.holders, 40, P / 20, P * 10);
    const binned = bins.reduce((s, b) => s + COHORTS.reduce((t, c) => t + b.byCohort[c], 0), 0);
    const withCost = scene.holders.reduce((s, h) => s + (h.cost == null ? 0 : h.amount), 0);
    expect(binned).toBeCloseTo(withCost, 2);
  });

  it("rejects invalid ranges", () => {
    expect(costProfile([], 0, 1, 2)).toEqual([]);
    expect(costProfile([], 4, 2, 1)).toEqual([]);
    expect(costProfile([], 4, 0, 1)).toEqual([]);
  });
});

describe("drowningWithYou", () => {
  const hs = [holder("sm", 100, 1), holder("whale", 200, 2), holder("other", 300, 3), holder("other", 400, null)];

  it("is the share of costed supply at the same depth or deeper", () => {
    expect(drowningWithYou(hs, 2)).toBeCloseTo(500 / 600);
    expect(drowningWithYou(hs, 0.5)).toBe(1);
    expect(drowningWithYou(hs, 3.5)).toBe(0);
    expect(drowningWithYou(hs, 0)).toBe(0);
  });
});

describe("synthetic fixture", () => {
  const scene = makeSyntheticScene();

  it("is deterministic", () => {
    expect(makeSyntheticScene()).toEqual(scene);
    expect(makeSyntheticScene(8)).not.toEqual(scene);
  });

  it("has the planned cohorts, fog and story", () => {
    const counts = { sm: 0, whale: 0, pf: 0, other: 0 };
    for (const h of scene.holders) counts[h.cohort]++;
    expect(counts).toEqual({ sm: 26, whale: 34, pf: 8, other: 162 });
    expect(scene.holders.filter((h) => h.fog).length).toBe(21);
    expect(scene.synthetic).toBe(true);

    const P = scene.meta.priceNow;
    for (const [i, h] of scene.holders.entries()) {
      expect(h.id).toBe(i);
      if (i > 0) expect(h.amount).toBeLessThanOrEqual(scene.holders[i - 1].amount);
      expect((h.cost == null) === (h.fog != null)).toBe(true);
      if (h.cost != null) expect(h.multiple!).toBeCloseTo(P / h.cost, 3);
      expect(h.conviction).toBeGreaterThan(0);
      expect(h.conviction).toBeLessThanOrEqual(1);
    }

    expect(smUnderwaterShare(scene.holders, P)!).toBeLessThan(0.1);
    expect(tideSnapshot(scene.holders, P, P).underwaterByCohort.other).toBeGreaterThan(0.6);
    const moves = findReefs(scene.holders, P, P, 2 * P, scene.meta.liquidityUsd).map((r) => r.movePct);
    expect(moves.some((m) => m > 0.12 && m < 0.24)).toBe(true);
    expect(moves.some((m) => m > 0.38 && m < 0.55)).toBe(true);
  });

  it("keeps coverage, candles, calls and totals consistent", () => {
    const { coverage, holders, ohlcv, calls, totals, meta } = scene;
    const analysed = holders.reduce((s, h) => s + h.amount, 0);
    expect(coverage.holdersAnalyzed).toBe(holders.length);
    expect(coverage.analyzedSupplyShare).toBeCloseTo(analysed / meta.circulatingSupply!, 4);
    expect(coverage.fogShare).toBeCloseTo(tideSnapshot(holders, meta.priceNow, meta.priceNow).fogShare, 4);

    expect(ohlcv).toHaveLength(720);
    expect(ohlcv.at(-1)!.c).toBe(meta.priceNow);
    for (let i = 1; i < ohlcv.length; i++) expect(ohlcv[i].t - ohlcv[i - 1].t).toBe(3_600_000);
    for (const c of ohlcv) expect(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)).toBe(true);

    expect(totals.calls).toBe(calls.length);
    expect(totals.credits).toBe(calls.reduce((s, c) => s + c.credits, 0));
    expect(totals.networkCalls + totals.cacheHits).toBe(calls.length);
    expect(totals.durationMs).toBeGreaterThanOrEqual(calls.at(-1)!.at);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at).toBeGreaterThanOrEqual(calls[i - 1].at);

    const pnlIds = calls.filter((c) => c.endpoint === "profiler/address/pnl").map((c) => c.holderId);
    expect(new Set(pnlIds).size).toBe(holders.length);
    expect(calls.filter((c) => c.endpoint === "tgm/holders")).toHaveLength(4);
  });
});
