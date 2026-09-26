import { describe, expect, it } from "vitest";
import { logScale, nearestIndex, priceDomain, priceTicks, prng, timeScale } from "@/lib/exposure/filmScale";
import {
  binAt,
  buildFilmGeometry,
  dotsPath,
  readoutAt,
  tagBox,
  V,
  type FilmInput,
} from "@/components/exposure/film/geometry";
import type {
  BuyersFinding,
  FlowFinding,
  LadderBin,
  ScanMeta,
  SmartFinding,
  WallsFinding,
  WalletCheck,
} from "@/lib/xray/types";

describe("filmScale", () => {
  it("priceDomain covers the series and extra levels with padding", () => {
    const d = priceDomain([0.03, 0.05, 0.04], [0.06, 0.02]);
    expect(d.lo).toBeLessThan(0.02);
    expect(d.hi).toBeGreaterThan(0.06);
  });

  it("priceDomain clamps far-away levels to the reach", () => {
    const d = priceDomain([1, 2], [100], { pad: 0, reach: 4 });
    expect(d.hi).toBeCloseTo(8, 6);
    expect(d.lo).toBeCloseTo(1, 6);
  });

  it("priceDomain widens a flat series and ignores junk", () => {
    const d = priceDomain([5, 5, 5, NaN, -1, 0], [], { pad: 0, minRatio: 1.21 });
    expect(d.hi / d.lo).toBeCloseTo(1.21, 6);
    expect(Math.sqrt(d.hi * d.lo)).toBeCloseTo(5, 6);
    expect(priceDomain([], [])).toEqual({ lo: 0.9, hi: 1.1 });
    const onlyExtra = priceDomain([], [2, 4], { pad: 0 });
    expect(onlyExtra).toEqual({ lo: 2, hi: 4 });
  });

  it("logScale maps hi to top, lo to bottom, and inverts", () => {
    const y = logScale({ lo: 0.018, hi: 0.074 }, 118, 520);
    expect(y(0.074)).toBeCloseTo(118, 6);
    expect(y(0.018)).toBeCloseTo(520, 6);
    expect(y.invert(y(0.0412))).toBeCloseTo(0.0412, 6); // coordinates are rounded to 1/100 px
    expect(y.clamped(1)).toBe(118);
    expect(y.clamped(0.0001)).toBe(520);
    expect(y(0)).toBe(520);
  });

  it("timeScale is linear and inverts", () => {
    const x = timeScale(1000, 2000, 96, 1150);
    expect(x(1000)).toBe(96);
    expect(x(2000)).toBe(1150);
    expect(x.invert(x(1500))).toBeCloseTo(1500, 6);
    expect(timeScale(5, 5, 0, 100)(5)).toBe(50);
  });

  it("priceTicks are round, in range and not crowded", () => {
    const y = logScale({ lo: 0.018, hi: 0.074 }, 118, 520);
    const ticks = priceTicks(y);
    expect(ticks).toEqual([0.07, 0.06, 0.05, 0.04, 0.03, 0.02]);
    const wide = logScale({ lo: 0.0003, hi: 0.2 }, 118, 520);
    const wt = priceTicks(wide);
    expect(wt.length).toBeGreaterThan(2);
    for (let i = 1; i < wt.length; i++) expect(wide(wt[i]) - wide(wt[i - 1])).toBeGreaterThanOrEqual(22);
  });

  it("nearestIndex and prng", () => {
    expect(nearestIndex([1, 3, 5, 9], 4.2)).toBe(2);
    expect(nearestIndex([1, 3, 5, 9], -10)).toBe(0);
    expect(nearestIndex([1, 3, 5, 9], 100)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
    const a = prng(7);
    const b = prng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

/* ---------------------------------------------------------------- geometry */

const H = 3_600_000;
const T1 = Date.UTC(2026, 8, 26, 14);
const T0 = T1 - 167 * H;

function input(over: Partial<FilmInput> = {}): FilmInput {
  const price = Array.from({ length: 168 }, (_, i) => ({
    t: T0 + i * H,
    c: 0.03 + 0.012 * Math.sin(i / 30) + i * 0.00005,
  }));
  const meta: ScanMeta = {
    chain: "base",
    tokenAddress: "0xabc",
    symbol: "kairo",
    name: "Kairo",
    priceNow: price[167].c,
    priceChange7d: 0.1,
    marketCapUsd: null,
    liquidityUsd: null,
    circulatingSupply: 1e9,
    holders: null,
    buyers24h: null,
    sellers24h: null,
    volume24hUsd: null,
    deployedAt: null,
    scannedAt: new Date(T1).toISOString(),
    scanNo: 412,
    window: { from: new Date(T0).toISOString(), to: new Date(T1).toISOString() },
  };
  const ladder: LadderBin[] = [];
  for (let v = 0.015; v < 0.08; v *= 1.06)
    ladder.push({ lo: v, hi: v * 1.06, tokens: 1e6, supplyShare: v > 0.048 && v < 0.053 ? 0.08 : 0.01 });
  const walls: WallsFinding = {
    status: "ok",
    method: "cost_basis",
    holdersAnalyzed: 60,
    analyzedSupplyShare: 0.7,
    underwaterShare: 0.5,
    walls: [
      {
        price: 0.05,
        movePct: 0.2,
        tokens: 9e6,
        supplyShare: 0.09,
        wallToLiquidity: 2,
        alreadyTrimming: 0.2,
        holders: 30,
      },
    ],
    ladder,
    ceiling: "heavy",
  };
  const buyers: BuyersFinding = {
    status: "ok",
    windowDays: 7,
    totalBuyers: 400,
    topBuyers: 80,
    topShare: 0.9,
    sources: 23,
    untracedShare: 0.1,
    biggestSourceShare: 0.37,
    biggestSourceWallets: 30,
    clusters: [
      { id: "a", kind: "wallet", label: "0x1", wallets: 30, boughtUsd: 1, share: 0.37, members: [] },
      { id: "b", kind: "exchange", label: "Binance", wallets: 14, boughtUsd: 1, share: 0.2, members: [] },
      ...Array.from({ length: 36 }, (_, i) => ({
        id: `s${i}`,
        kind: "wallet" as const,
        label: "x",
        wallets: 1,
        boughtUsd: 1,
        share: 0.01,
        members: [],
      })),
    ],
    demand: "concentrated",
  };
  const flow: FlowFinding = {
    status: "ok",
    informedNetUsd: -2e6,
    informedNetPctSupply: -0.031,
    freshNetUsd: 1.6e6,
    exchangeNetPctSupply: null,
    series: [
      {
        cohort: "informed",
        points: Array.from({ length: 168 }, (_, i) => ({
          t: T0 + i * H,
          cumPctSupply: i < 60 ? i * 0.0001 : 0.006 - (i - 60) * 0.0003,
          netUsd: 0,
        })),
      },
    ],
    daily: [],
    verdict: "distributing",
  };
  const smart: SmartFinding = {
    status: "ok",
    windowDays: 30,
    avgEntry: 0.03,
    pnlPct: 0.38,
    wallets: 10,
    boughtUsd: 1,
    soldUsd: 1,
    netUsd: 0,
    stance: "trimming",
    state: "profit",
  };
  const you: WalletCheck = {
    status: "ok",
    address: "0xme",
    short: "0xme",
    cost: 0.045,
    pnlPct: null,
    vsSmartMoneyPct: null,
    cheaperShare: null,
    holdingTokens: null,
  };
  return {
    meta,
    price,
    bigBuys: [{ t: T0 + 50 * H, price: 0.035, usd: 40_000 }],
    buyers,
    flow,
    walls,
    smart,
    you,
    ...over,
  };
}

const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

describe("film geometry", () => {
  it("lays out every layer and all five markers from full data", () => {
    const g = buildFilmGeometry(input());
    expect(g.plate.name).toBe("$KAIRO · BASE");
    expect(g.plate.sub).toBe("SCAN 0412 · 26 SEP 2026 · 7-DAY");
    expect(g.pricePath.startsWith("M96.0 ")).toBe(true);
    expect(g.markers.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
    expect(g.markers.find((m) => m.n === 1)!.tag).toBe("23/80 INDEPENDENT");
    expect(g.markers.find((m) => m.n === 2)!.tag).toBe("PULSE −3.1%");
    expect(g.markers.find((m) => m.n === 3)!.tag).toMatch(/^SELL WALL \+\d+%$/);
    expect(g.markers.find((m) => m.n === 4)!.tag).toBe("SM ENTRY $0.030");
    expect(g.markers.find((m) => m.n === 5)!.tag).toBe("YOU");
    expect(g.walls!.bands.some((b) => b.warm)).toBe(true);
    expect(g.walls!.ladder.length).toBeGreaterThan(5);
    expect(g.sources?.mode).toBe("clusters");
    expect(g.pulse?.d.startsWith(`M${V.EX0} ${V.EB}`)).toBe(true);
    expect(g.status.missing).toEqual([]);
  });

  it("keeps markers, tags and dots inside the film and tags apart", () => {
    const g = buildFilmGeometry(input());
    const boxes = g.markers.map(tagBox);
    for (const b of boxes) {
      expect(within(b.x, 0, V.W) && within(b.x + b.w, 0, V.W)).toBe(true);
      expect(within(b.y, 0, V.H) && within(b.y + b.h, 0, V.H)).toBe(true);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    const src = g.sources!;
    if (src.mode !== "clusters") throw new Error("expected clusters");
    const n = src.groups.reduce((s, gr) => s + gr.pts.length / 4, 0);
    expect(n).toBe(80);
    for (const gr of src.groups)
      for (let i = 0; i < gr.pts.length; i += 4) {
        expect(within(gr.pts[i + 2], V.SRC_X0 - 4, V.EX0 - 10)).toBe(true);
        expect(within(gr.pts[i + 3], V.STRIP_Y + 10, V.LABEL_Y - 10)).toBe(true);
      }
  });

  it("labels clusters by funder: short address as printed, entity names in capitals, truncated to fit", () => {
    const base = input();
    const g = buildFilmGeometry({
      ...base,
      buyers: {
        ...base.buyers!,
        clusters: [
          { id: "a", kind: "wallet", label: "0x5eed…9f3c", funder: `0x5eed${"0".repeat(30)}009f3c`, wallets: 30, boughtUsd: 1, share: 0.37, members: [] },
          { id: "b", kind: "exchange", label: "Binance", wallets: 14, boughtUsd: 1, share: 0.2, members: [] },
          { id: "c", kind: "wallet", label: "Extremely Long Entity Name", wallets: 12, boughtUsd: 1, share: 0.1, members: [] },
          { id: "u", kind: "untraced", label: "Untraced", wallets: 10, boughtUsd: 1, share: 0.1, members: [] },
        ],
      },
    });
    const src = g.sources!;
    if (src.mode !== "clusters") throw new Error("expected clusters");
    expect(src.labels.map((l) => l.text)).toEqual(["0x5eed…9f3c", "BINANCE", "EXTREMELY L…", "UNTRACED"]);
    expect(src.labels.every((l) => l.text.length <= 12)).toBe(true);
  });

  it("merge interpolates dots from the row to the clusters", () => {
    const d0 = dotsPath([10, 20, 110, 220], 0, 3);
    const d1 = dotsPath([10, 20, 110, 220], 1, 3);
    expect(d0.startsWith("M7.0 20.0")).toBe(true);
    expect(d1.startsWith("M107.0 220.0")).toBe(true);
  });

  it("hides unavailable findings and lists them on the plate", () => {
    const base = input();
    const g = buildFilmGeometry({
      ...base,
      flow: { ...base.flow!, status: "unavailable" },
      smart: { ...base.smart!, status: "unavailable", avgEntry: null },
      you: null,
    });
    expect(g.pulse).toBeNull();
    expect(g.pulseMissing).toBe(true);
    expect(g.smY).toBeNull();
    expect(g.markers.map((m) => m.n)).toEqual([1, 3]);
    expect(g.status.missing).toEqual(["02 FLOW", "04 SMART MONEY"]);
  });

  it("falls back to buying concentration without clusters", () => {
    const base = input();
    const g = buildFilmGeometry({
      ...base,
      buyers: { ...base.buyers!, clusters: [], sources: 0, topBuyers: 10, topShare: 0.63 },
    });
    expect(g.sources?.mode).toBe("concentration");
    expect(g.markers.find((m) => m.n === 1)!.tag).toBe("TOP 10 · 63%");
  });

  it("renders an empty film while waiting for data", () => {
    const g = buildFilmGeometry({
      meta: null,
      price: [],
      bigBuys: [],
      buyers: null,
      flow: null,
      walls: null,
      smart: null,
      you: null,
    });
    expect(g.hasMeta).toBe(false);
    expect(g.plate.name).toBe("AWAITING PATIENT");
    expect(g.markers).toEqual([]);
    expect(g.pricePath).toBe("");
  });

  it("partial data: only meta + price streams in first", () => {
    const base = input();
    const g = buildFilmGeometry({ ...base, buyers: null, flow: null, walls: null, smart: null, you: null });
    expect(g.markers).toEqual([]);
    expect(g.pricePath.length).toBeGreaterThan(100);
    expect(g.status.missing).toEqual([]);
  });

  it("crosshair readout reads time, level and ladder supply", () => {
    const g = buildFilmGeometry(input());
    const y = g.y(0.05);
    const r = readoutAt(g, 600, y)!;
    expect(r.lines[0]).toMatch(/^[A-Z]{3} \d\d SEP \d\d:00 · \$/);
    expect(r.lines[1]).toMatch(/^LEVEL \$0\.0/);
    expect(r.lines[2]).toMatch(/^ENTERED HERE 8\.0%/);
    expect(readoutAt(g, 20, 20)).toBeNull();
    expect(binAt(g.walls!.bins, 0.0001)).toBeNull();
  });
});
