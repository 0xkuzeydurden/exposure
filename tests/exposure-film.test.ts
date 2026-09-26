import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { logScale, nearestIndex, priceDomain, priceTicks, prng, timeScale } from "@/lib/exposure/filmScale";
import {
  binAt,
  buildFilmGeometry,
  dotsPath,
  FS,
  intersects,
  readoutAt,
  tagBox,
  textWidth,
  V,
  zoneBox,
  type Box,
  type FilmGeometry,
  type FilmInput,
} from "@/components/exposure/film/geometry";
import { filmGuide, filmZones, pulseNet } from "@/lib/xray/copy";
import type {
  BuyersFinding,
  FlowFinding,
  LadderBin,
  Scan,
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
    for (let i = 1; i < wt.length; i++) expect(wide(wt[i]) - wide(wt[i - 1])).toBeGreaterThanOrEqual(34);
  });

  it("priceTicks gives 4 to 6 ticks on a 6x range (it used to drop to two)", () => {
    // GSTOCK's film: a smart-money entry far below the week pulls the scale to ~6.5x.
    const y = logScale({ lo: 0.00616, hi: 0.0403 }, V.Y0, V.Y1);
    const t = priceTicks(y);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < t.length; i++) expect(y(t[i]) - y(t[i - 1])).toBeGreaterThanOrEqual(34);
    for (const v of [0.0005, 0.003, 0.2, 7.9]) {
      const s = logScale({ lo: v / 1.4, hi: v * 1.4 }, V.Y0, V.Y1);
      const n = priceTicks(s).length;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(6);
    }
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
    expect(g.pricePath.startsWith(`M${V.X0}.0 `)).toBe(true);
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
        expect(within(gr.pts[i + 3], V.STRIP_Y + 10, V.NUM_Y - 20)).toBe(true);
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
    expect(src.labels.map((l) => l.name)).toEqual(["0x5eed…9f3c", "BINANCE", "EXTREMELY L…", "UNTRACED"]);
    expect(src.labels.map((l) => l.count)).toEqual(["30", "14", "12", "10"]);
    expect(src.labels.every((l) => l.name.length <= 12)).toBe(true);
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

/* ---------------------------------------------------------------- readability layer */

describe("film zones, guide and pulse copy", () => {
  const walls = (over: Partial<WallsFinding> = {}): WallsFinding => ({
    ...(input().walls as WallsFinding),
    ...over,
  });

  it("splits the analysed supply at today's price, adding up to 100%", () => {
    const z = filmZones(walls({ underwaterShare: 0.374 }))!;
    expect(z.loss).toEqual({ pct: "37%", text: " OF ANALYSED SUPPLY AT A LOSS ↑" });
    expect(z.profit).toEqual({ pct: "63%", text: " IN PROFIT ↓" });
    expect(z.note).toBe("");
    // 12.5% rounds to 13%, so profit is 87% (not a rounded 88%).
    expect(filmZones(walls({ underwaterShare: 0.125 }))!.profit.pct).toBe("87%");
    expect(filmZones(walls({ underwaterShare: 0.003 }))!.loss.pct).toBe("<1%");
    expect(filmZones(walls({ underwaterShare: 0.003 }))!.profit.pct).toBe(">99%");
    expect(filmZones(walls({ underwaterShare: 0 }))!.profit.pct).toBe("100%");
  });

  it("says so when the split rests on thin coverage or blended entry prices", () => {
    expect(filmZones(walls({ analyzedSupplyShare: 0.05 }))!.note).toBe("BASED ON 5% OF SUPPLY");
    expect(filmZones(walls({ status: "partial", analyzedSupplyShare: 0.4 }))!.note).toBe("BASED ON 40% OF SUPPLY");
    expect(filmZones(walls({ method: "hybrid" }))!.note).toBe("SOME ENTRIES FROM 30-DAY BUYS");
    expect(filmZones(walls({ method: "recent_buyers" }))!.loss.text).toBe(" OF RECENT BUYERS' TOKENS AT A LOSS ↑");
    expect(filmZones(walls({ status: "unavailable" }))).toBeNull();
    expect(filmZones(null)).toBeNull();
  });

  it("reading guide lists only what the film shows", () => {
    expect(filmGuide({ zones: true, smart: true, buys: true }).map((g) => g.lead + g.text).join(" · ")).toBe(
      "Above the price: holders waiting to break even · Below: holders in profit · Dashed: smart money's average entry · Dots: large buys",
    );
    expect(filmGuide({ zones: false, smart: false, buys: true }).map((g) => g.lead)).toEqual(["Dots:"]);
  });

  it("pulse net reads as a share of supply over the week", () => {
    const f = input().flow!;
    expect(pulseNet(f)).toEqual({ text: "−3.1% OF SUPPLY · 7D", tone: "sell" });
    expect(pulseNet({ ...f, informedNetPctSupply: 0.007 })).toEqual({ text: "+0.7% OF SUPPLY · 7D", tone: "buy" });
    expect(pulseNet({ ...f, informedNetPctSupply: 0.00001 })!.tone).toBe("flat");
    expect(pulseNet({ ...f, informedNetPctSupply: null })!.text).toBe("−$2M · 7D");
    expect(pulseNet({ ...f, status: "unavailable" })).toBeNull();
  });
});

describe("film geometry: readability layer", () => {
  it("draws both zones with their labels on either side of today's price", () => {
    const g = buildFilmGeometry(input());
    const w = g.walls!;
    expect(w.zones).not.toBeNull();
    expect(w.loss!.pct).toBe("50%");
    expect(w.profit!.pct).toBe("50%");
    expect(zoneBox(w.loss!).y + zoneBox(w.loss!).h).toBeLessThanOrEqual(g.now!.y + 1);
    expect(zoneBox(w.profit!).y).toBeGreaterThanOrEqual(g.now!.y - 1);
    expect(g.guide.map((x) => x.lead)).toEqual(["Above the price:", "Below:", "Dashed:", "Dots:"]);
    expect(g.now!.label).toMatch(/^NOW \$0\.030/);
    expect(g.now!.tag.x + g.now!.tag.w).toBeLessThanOrEqual(V.LX - 4);
  });

  it("ladder bars are thick, tinted by side of the price, and the wall's bar carries its share", () => {
    const g = buildFilmGeometry(input());
    const w = g.walls!;
    for (const b of w.ladder) expect(b.h).toBeGreaterThanOrEqual(8);
    const nowY = g.now!.y;
    for (const b of w.ladder) {
      if (b.y + b.h < nowY - 2) expect(b.warm).toBe(true);
      if (b.y > nowY + 2) expect(b.warm).toBe(false);
    }
    expect(w.ladder.filter((b) => b.wall)).toHaveLength(1);
    expect(w.wallLabel!.text).toBe("9.0%");
    expect(Math.max(...w.ladder.map((b) => b.w))).toBeLessThanOrEqual(V.LB);
  });

  it("the pulse has a closed fill along the zero line and a net label", () => {
    const g = buildFilmGeometry(input());
    expect(g.pulse!.area.endsWith(`L${V.EX1} ${V.EB} Z`)).toBe(true);
    expect(g.pulse!.net).toEqual({ text: "−3.1% OF SUPPLY · 7D", tone: "sell" });
  });

  it("a quiet week draws a near-flat pulse instead of stretching it to full height", () => {
    const base = input();
    const quiet = buildFilmGeometry({
      ...base,
      flow: {
        ...base.flow!,
        informedNetPctSupply: 0.00001,
        series: [
          {
            cohort: "informed",
            points: Array.from({ length: 168 }, (_, i) => ({ t: T0 + i * H, cumPctSupply: (i % 7) * 0.000002, netUsd: 0 })),
          },
        ],
      },
    });
    const ys = [...quiet.pulse!.d.matchAll(/ (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(8);
  });

  it("the headline counts independent buyers and flags one funder paying for many", () => {
    const g = buildFilmGeometry(input());
    const src = g.sources!;
    if (src.mode !== "clusters") throw new Error("expected clusters");
    expect(src.counter).toEqual({ from: 80, to: 23 });
    expect(src.extra).toBe(" · ONE WALLET FUNDED 30");
  });
});

/* ---------------------------------------------------------------- every recorded patient */

const SCANS = fileURLToPath(new URL("../public/scans/", import.meta.url));

function layoutProblems(g: FilmGeometry): string[] {
  const out: string[] = [];
  const inside = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= V.W && b.y + b.h <= V.H;
  const tags = g.markers.map((m) => ({ n: m.n, box: tagBox(m) }));
  const rings = g.markers.map((m) => ({ n: m.n, box: { x: m.cx - 17, y: m.cy - 17, w: 34, h: 34 } }));
  for (const t of tags) if (!inside(t.box)) out.push(`tag ${t.n} outside the film`);
  for (let i = 0; i < tags.length; i++)
    for (let j = 0; j < tags.length; j++) {
      if (i === j) continue;
      if (j > i && intersects(tags[i].box, tags[j].box)) out.push(`tags ${tags[i].n}/${tags[j].n} overlap`);
      if (intersects(tags[i].box, rings[j].box)) out.push(`tag ${tags[i].n} covers ring ${rings[j].n}`);
    }
  const fixed: { what: string; box: Box }[] = [];
  if (g.now) {
    const t = g.now.tag;
    if (t.x + t.w > V.LX - 4) out.push("NOW tag runs into the ladder");
    fixed.push({ what: "NOW tag", box: t });
  }
  const w = g.walls;
  for (const [what, l] of [
    ["loss label", w?.loss],
    ["profit label", w?.profit],
  ] as const) {
    if (!l) continue;
    const b = zoneBox(l);
    if (b.x < V.X0 - 8 || b.x + b.w > V.X1 + 8) out.push(`${what} leaves the chart`);
    for (const o of [...tags, ...rings]) if (intersects(b, o.box)) out.push(`${what} hits marker ${o.n}`);
    for (const f of fixed) if (intersects(b, f.box)) out.push(`${what} hits ${f.what}`);
    fixed.push({ what, box: b });
  }
  for (const f of fixed.slice(0, 1)) for (const o of [...tags, ...rings]) if (intersects(f.box, o.box)) out.push(`NOW tag hits marker ${o.n}`);
  if (w?.loss && g.now && zoneBox(w.loss).y + zoneBox(w.loss).h > g.now.y + 1) out.push("loss label below the price");
  if (w?.profit && g.now && zoneBox(w.profit).y < g.now.y - 1) out.push("profit label above the price");
  if (w?.wallLabel && w.wallLabel.x + textWidth(w.wallLabel.text, FS.wallPct) > V.W - 8) out.push("wall share clipped");

  for (let i = 1; i < g.ticks.length; i++) if (g.ticks[i].y - g.ticks[i - 1].y < 30) out.push("ticks crowd");
  if (g.ticks.length < 3) out.push(`only ${g.ticks.length} ticks`);
  const guide = g.guide.map((x, i) => (i ? " · " : "") + x.lead + x.text).join("");
  if (40 + textWidth(guide, FS.guide) > V.W - 40) out.push("guide too long");

  const src = g.sources;
  if (src?.mode === "clusters") {
    const hn = (l: (typeof src.labels)[number]) => textWidth(l.count, FS.num) / 2;
    const ht = (l: (typeof src.labels)[number]) => textWidth(l.name, FS.name, 1) / 2;
    src.labels.forEach((l, i) => {
      const half = Math.max(hn(l), ht(l));
      if (l.x - half < 20 || l.x + half > V.EX0 - 20) out.push(`source label ${l.name || l.count} clipped`);
      const n = src.labels[i + 1];
      if (!n) return;
      // Numerals at least 10 apart; two names at least 20 apart.
      if (l.x + hn(l) + 10 > n.x - hn(n)) out.push(`source counts ${l.count}/${n.count} too close`);
      if (l.name && n.name && l.x + ht(l) + 20 > n.x - ht(n)) out.push(`source names ${l.name}/${n.name} too close`);
      // A bare count never sits over a neighbour's name (it would read as that name's count).
      if (l.name && l.x + ht(l) + 8 > n.x - hn(n)) out.push(`count ${n.count} under name ${l.name}`);
      if (n.name && l.x + hn(l) + 8 > n.x - ht(n)) out.push(`count ${l.count} over name ${n.name}`);
    });
    const head = `${src.counter.from} OF ${src.counter.from} ${src.short ? "" : "BUYERS "}FUNDED INDEPENDENTLY`;
    if (40 + textWidth(head, FS.head, 0.5) + textWidth(src.extra, FS.headExtra, 0.5) > V.EX0 - 40) out.push("headline too long");
  } else if (src?.mode === "concentration") {
    if (40 + textWidth(src.head, FS.head, 0.5) > V.EX0 - 40) out.push("headline too long");
    if (src.note && 40 + textWidth(src.note, FS.name, 1) > V.EX0 - 20) out.push("note too long");
  }
  if (g.pulse?.net && V.EX0 + textWidth(g.pulse.net.text, FS.net, 0.5) > V.EX1) out.push("pulse net too long");
  return out;
}

describe("every recorded patient reads cleanly", () => {
  const files = readdirSync(SCANS).filter((f) => f.endsWith(".json") && f !== "index.json");

  it("has the recorded patients", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const f of files) {
    it(`${f}: no overlaps, nothing clipped`, () => {
      const scan = JSON.parse(readFileSync(`${SCANS}${f}`, "utf8")) as Scan;
      const F = scan.findings;
      const base: FilmInput = {
        meta: scan.meta,
        price: scan.price,
        bigBuys: scan.bigBuys ?? [],
        buyers: F.buyers,
        flow: F.flow,
        walls: F.walls,
        smart: F.smart,
        you: null,
      };
      const g = buildFilmGeometry(base);
      expect(layoutProblems(g)).toEqual([]);
      expect(g.walls?.loss && g.walls.profit).toBeTruthy();
      expect(g.ticks.length).toBeGreaterThanOrEqual(4);
      // With a wallet pasted (entry 10% above today's price), marker 5 must fit as well.
      const cost = scan.meta.priceNow * 1.1;
      const you: WalletCheck = {
        status: "ok",
        address: "0xme",
        short: "0xme",
        cost,
        pnlPct: null,
        vsSmartMoneyPct: null,
        cheaperShare: null,
        holdingTokens: null,
      };
      const gy = buildFilmGeometry({ ...base, you });
      expect(gy.markers.map((m) => m.n)).toContain(5);
      expect(layoutProblems(gy)).toEqual([]);
    });
  }
});
