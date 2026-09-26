import { describe, expect, it } from "vitest";
import { makeSyntheticScan, makeSyntheticWalletCheck } from "../lib/xray/fixtures";
import { logScale, placeLabels, squarify, textWidth } from "../components/exposure/lab/geometry";
import {
  abnormalFlag,
  biggestSource,
  buyersAnswer,
  buyersChart,
  buyersResult,
  callGroupOf,
  callWaffle,
  ceilingFlag,
  demandFlag,
  diagnosisStamp,
  ecgBeats,
  evidenceAnswer,
  evidenceFlag,
  flowAnswer,
  flowChart,
  flowFlag,
  flowResult,
  keyNumbers,
  logTicks,
  monitorChannels,
  NA,
  nearestWall,
  niceMax,
  noDash,
  smartAnswer,
  smartFlag,
  smartGauge,
  gaugePos,
  smartResult,
  smartTabFlag,
  tabFlag,
  wallsAnswer,
  wallsChart,
  wallsResult,
  youAnswer,
  youChart,
  youFlag,
  youResult,
  youTabFlag,
} from "../lib/xray/lab";
import type { BuyerRow, BuyersFinding, CallRecord, FlowFinding, SmartFinding, WalletCheck, WallsFinding } from "../lib/xray/types";

const scan = makeSyntheticScan();
const { buyers, flow, walls, smart } = scan.findings;

describe("lab flags follow each finding's own classification", () => {
  it("maps demand, flow, ceiling, smart money and the pasted wallet to lab flags", () => {
    const b = (demand: BuyersFinding["demand"]) => ({ ...buyers, demand });
    expect([demandFlag(b("concentrated")), demandFlag(b("mixed")), demandFlag(b("organic"))].map((f) => [f.text, f.tone])).toEqual([
      ["HIGH", "red"],
      ["BORDERLINE", "amber"],
      ["NORMAL", "green"],
    ]);
    expect(demandFlag(null).text).toBe("PENDING");
    expect(demandFlag({ ...buyers, status: "unavailable" }).text).toBe("NO DATA");

    const f = (verdict: FlowFinding["verdict"]) => ({ ...flow, verdict });
    expect([flowFlag(f("distributing")), flowFlag(f("quiet")), flowFlag(f("accumulating"))].map((x) => [x.text, x.tone])).toEqual([
      ["HIGH", "red"],
      ["NORMAL", "green"],
      ["LOW", "green"],
    ]);

    const w = (ceiling: WallsFinding["ceiling"]) => ({ ...walls, ceiling });
    expect([ceilingFlag(w("heavy")).text, ceilingFlag(w("light")).text]).toEqual(["HIGH", "NORMAL"]);

    const s = (state: SmartFinding["state"], stance: SmartFinding["stance"]) => smartFlag({ ...smart, state, stance });
    expect([s("profit", "trimming"), s("profit", "adding"), s("breakeven", "holding"), s("loss", "exiting"), s("loss", "holding")].map((x) => [x.text, x.tone])).toEqual([
      ["HIGH", "red"],
      ["HIGH", "green"],
      ["NORMAL", "green"],
      ["LOW", "red"],
      ["LOW", "amber"],
    ]);
    expect(smartFlag({ ...smart, wallets: 2 }).text).toBe("TOO FEW");
    expect(smartFlag({ ...smart, wallets: 0, avgEntry: null }).text).toBe("NONE");

    const you = (vs: number | null): WalletCheck => ({ ...makeSyntheticWalletCheck(scan), vsSmartMoneyPct: vs });
    expect([youFlag(you(0.51)), youFlag(you(0.05)), youFlag(you(-0.2)), youFlag(you(null)), youFlag(null)].map((x) => x.text)).toEqual([
      "HIGH",
      "NORMAL",
      "LOW",
      "NO REFERENCE",
      "NOT CHECKED",
    ]);
  });
});

describe("result blocks on the synthetic patient", () => {
  it("01 buyers: sources, the mixed verdict and the reference range", () => {
    const r = buyersResult(buyers);
    expect(r.value).toBe("23");
    expect(r.caption).toBe("real funding sources behind the top 80 buyers");
    expect(r.verdict).toBe("Mixed: 30 of the 80 buyers were funded by one wallet.");
    expect(r.flag.text).toBe("BORDERLINE");
    expect(r.reference).toBe("≥ 0.60 sources per traced buyer · biggest source < 20%");
    expect(r.measured).toBe("23 ÷ 64 traced = 0.36 · biggest source 31%");
    expect(biggestSource(buyers)?.wallets).toBe(30);
    expect(buyersResult(null).flag.text).toBe("PENDING");
  });

  it("02 flow, 03 walls, 04 smart money, 05 you", () => {
    const f = flowResult(flow, scan.meta);
    expect(f.value).toBe("−$2M");
    expect(f.verdict).toBe("Distributing: informed money sold $2M while fresh wallets bought $1.6M.");
    expect(f.flag.text).toBe("HIGH");
    expect(f.reference).toBe("Informed net flow within ±0.5% of market cap");

    const w = wallsResult(walls, scan.meta);
    expect(w.value).toBe("2.3×");
    expect(w.flag.text).toBe("HIGH");
    expect(w.verdict).toMatch(/^Heavy ceiling: sellers are waiting \+22% above the price/);
    expect(nearestWall(walls)?.price).toBe(0.0445);

    const s = smartResult(smart);
    expect(s.value).toBe("+38%");
    expect(s.flag).toEqual({ level: "high", tone: "red", text: "HIGH" });
    expect(s.verdict).toBe("In profit and trimming: bought $1.9M, sold $2.9M in 30 days.");

    expect(youResult(null).flag.text).toBe("NOT CHECKED");
    const y = youResult(makeSyntheticWalletCheck(scan));
    expect(y.value).toBe("+51%");
    expect(y.verdict).toMatch(/^You paid 51% more than smart money\./);
  });

  it("summary: five key numbers with flags and short reference ranges", () => {
    const rows = keyNumbers(scan.findings, scan.meta, null);
    expect(rows.map((r) => [r.n, r.result, r.flag.text])).toEqual([
      [1, "23 sources · 80 buyers", "BORDERLINE"],
      [2, "−$2M · −3.1% supply", "HIGH"],
      [3, "2.3× pool at +22%", "HIGH"],
      [4, "+38% · trimming", "HIGH"],
      [5, "Not checked", "NOT CHECKED"],
    ]);
    expect(rows[0].reference).toBe("≥ 0.60 sources per buyer");
    const pending = keyNumbers({ buyers: null, flow: null, walls: null, smart: null }, null, null);
    expect(pending.slice(0, 4).every((r) => r.result === "Pending" && r.flag.text === "PENDING")).toBe(true);
  });
});

describe("synthetic fixture addresses", () => {
  it("are obviously fake (0x5eed…) and published like a real scan", () => {
    const json = JSON.stringify(scan);
    const addresses = json.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    expect(addresses.length).toBeGreaterThan(80);
    expect(addresses.every((a) => a.startsWith("0x5eed"))).toBe(true);
    expect(json).not.toMatch(/Funder [A-Z]\b/);
    const wallet = buyers.clusters.filter((c) => c.kind === "wallet");
    expect(wallet.every((c) => c.funder?.startsWith("0x5eed") && c.label === `${c.funder.slice(0, 6)}…${c.funder.slice(-4)}`)).toBe(true);
    expect(buyers.clusters.reduce((s, c) => s + c.members.length, 0)).toBe(buyers.topBuyers);
  });
});

/* ============================================================== chart-ready values (the visual tabs) */

const EM_DASH = String.fromCharCode(0x2014);
const you = makeSyntheticWalletCheck(scan);
const NONE = { buyers: null, flow: null, walls: null, smart: null };

describe("tab flags in words", () => {
  it("04 names what smart money does, 05 says late / early / on par, Evidence counts failures", () => {
    const s = (state: SmartFinding["state"], stance: SmartFinding["stance"]) => smartTabFlag({ ...smart, state, stance });
    expect([s("profit", "trimming"), s("profit", "adding"), s("loss", "exiting"), s("loss", "holding"), s("breakeven", "holding")].map((f) => [f.text, f.tone])).toEqual([
      ["TAKING PROFIT", "red"],
      ["ADDING IN PROFIT", "green"],
      ["SELLING AT A LOSS", "red"],
      ["UNDERWATER", "amber"],
      ["AT BREAK-EVEN", "green"],
    ]);
    expect(smartTabFlag({ ...smart, wallets: 2 }).text).toBe("TOO FEW");
    const w = (vs: number | null): WalletCheck => ({ ...you, vsSmartMoneyPct: vs });
    expect([youTabFlag(w(0.51)), youTabFlag(w(-0.2)), youTabFlag(w(0.02)), youTabFlag(null)].map((f) => f.text)).toEqual(["LATE", "EARLY", "ON PAR", "NOT CHECKED"]);
    expect(evidenceFlag(scan.calls)).toEqual({ level: "normal", tone: "green", text: "ALL CALLS OK" });
    const failed: CallRecord[] = [...scan.calls.slice(0, 3), { ...scan.calls[0], status: 500 }];
    expect(evidenceFlag(failed)).toMatchObject({ tone: "amber", text: "1 FAILED" });
    expect(evidenceFlag([]).text).toBe("PENDING");
    expect(tabFlag(4, scan.findings, scan.meta, null, scan.calls).text).toBe("TAKING PROFIT");
    expect(tabFlag("summary", scan.findings, scan.meta, null, scan.calls).text).toBe("3 of 5 abnormal");
  });
});

describe("summary: the bedside monitor", () => {
  it("five channels read straight off the findings", () => {
    const ch = monitorChannels(scan.findings, scan.meta, null);
    expect(ch.map((c) => [c.label, c.value, c.flag.text, c.valueTone, c.trace.kind])).toEqual([
      ["Real buyers", "23", "BORDERLINE", "amber", "dots"],
      // The flow vital sign is read on the verdict's own base (market cap), not the film pulse's (supply).
      ["Informed flow", "\u22123.3%", "HIGH", "red", "ecg"],
      ["Sell wall", "2.3\u00d7", "HIGH", "red", "bar"],
      ["Smart money", "+38%", "TAKING PROFIT", "green", "bar"],
      ["You", NA, "NOT CHECKED", "grey", "check"],
    ]);
    expect(ch[0].trace).toEqual({ kind: "dots", left: 80, leftHot: 30, leftHollow: 16, right: 23, rightHot: true });
    expect(ch[1].sub).toBe("7 days, % of market cap");
    expect(monitorChannels(scan.findings, { ...scan.meta, marketCapUsd: null }, null)[1]).toMatchObject({ value: "\u22123.1%", sub: "7 days, % of supply" });
    expect(ch[2].trace).toEqual({ kind: "bar", value: walls.walls[1].wallToLiquidity, max: 3, ref: 1, refLabel: "POOL" });
    expect(ch[3].trace).toMatchObject({ kind: "bar", max: 2, ref: 1, refLabel: "ENTRY" });
    expect(abnormalFlag(ch)).toEqual({ level: "high", tone: "red", text: "3 of 5 abnormal" });

    const withYou = monitorChannels(scan.findings, scan.meta, you);
    expect(withYou[4].value).toBe("+51%");
    expect(withYou[4].flag.text).toBe("LATE");
    const marks = withYou[4].trace.kind === "marks" ? withYou[4].trace.marks : [];
    expect(marks.map((m) => m.key)).toEqual(["sm", "now", "you"]);
    expect(marks[0].x).toBeLessThan(marks[1].x);
    expect(marks[1].x).toBeLessThan(marks[2].x);
    expect(abnormalFlag(withYou).text).toBe("4 of 5 abnormal");
  });

  it("the ECG follows the informed series: 24 beats, ending at its lowest cumulative point", () => {
    const beats = ecgBeats(flow);
    expect(beats).toHaveLength(24);
    expect(beats.every((b) => Math.abs(b.base) <= 1 && Math.abs(b.spike) <= 1)).toBe(true);
    expect(beats[beats.length - 1].base).toBe(-1);
    expect(ecgBeats({ ...flow, series: [] }, 24)).toHaveLength(flow.daily.length);
    expect(ecgBeats(null)).toEqual([]);
  });

  it("pending, no data and a clean patient", () => {
    const pending = monitorChannels(NONE, null, null);
    expect(pending.every((c) => c.value === NA)).toBe(true);
    expect(abnormalFlag(pending).text).toBe("PENDING");
    const organic = monitorChannels({ ...scan.findings, buyers: { ...buyers, demand: "organic" }, flow: { ...flow, verdict: "quiet" }, walls: { ...walls, ceiling: "light" }, smart: { ...smart, stance: "adding" } }, scan.meta, null);
    expect(abnormalFlag(organic)).toMatchObject({ tone: "green", text: "0 of 5 abnormal" });
    expect(diagnosisStamp(scan.diagnosis)).toEqual({ rule: "Rule 2", confidence: "Confidence high", tone: "red" });
    expect(diagnosisStamp(null).tone).toBe("grey");
    expect(niceMax(2.31)).toBe(3);
    expect(niceMax(1.38)).toBe(2);
  });
});

describe("01 buyers: funnel + treemap", () => {
  it("one funnel dot per independent source, the biggest first; treemap tiles by buy volume", () => {
    const c = buyersChart(buyers)!;
    expect(c.traced).toBe(true);
    expect([c.walletsLabel, c.sourcesLabel, c.hot, c.hollow]).toEqual(["80 WALLETS", "23 SOURCES", 30, 16]);
    expect(c.sources).toHaveLength(buyers.sources);
    expect(c.sources[0]).toMatchObject({ kind: "biggest", wallets: 30 });
    expect(c.sources.filter((d) => d.kind === "exchange")).toHaveLength(13);
    expect(c.tiles.map((t) => [t.kind, t.label])).toEqual([
      ["biggest", biggestSource(buyers)!.label],
      ["exchange", "Binance"],
      ["exchange", "Coinbase"],
      ["exchange", "Relay"],
      ["independent", "9 independent"],
      ["untraced", "Untraced"],
    ]);
    expect(c.tiles[0].address).toBe(biggestSource(buyers)!.funder);
    expect(c.tiles.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 2);
    expect(c.tiles[4].children).toHaveLength(9);
    expect(c.legend.map((l) => l.kind)).toEqual(["biggest", "exchange", "independent", "untraced"]);
    expect(buyersAnswer(buyers)).toEqual({
      value: "23",
      tone: "amber",
      line: "of the top 80 buyers were funded independently. 41 shared a funder; one wallet funded 30 of them. 16 could not be traced.",
    });
    // The biggest source is only drawn as a warning at the thresholds (here 37% >= 35%: red).
    expect(c.bigTone).toBe(buyers.biggestSourceShare >= 0.35 ? "red" : buyers.biggestSourceShare >= 0.2 ? "amber" : "grey");
    expect(buyersChart({ ...buyers, biggestSourceShare: 0.03 })!.bigTone).toBe("grey");
    expect(buyersChart({ ...buyers, biggestSourceShare: 0.25 })!.bigTone).toBe("amber");
  });

  it("without funder tracing: the largest buyers against everyone else", () => {
    const rows: BuyerRow[] = [0, 1, 2].map((i) => ({
      address: `0x5eed${String(i).repeat(36)}`,
      short: `0x5eed…${String(i).repeat(4)}`,
      boughtUsd: 300_000 - i * 100_000,
      boughtTokens: 1,
      nansenUrl: "https://app.nansen.ai/profiler",
    }));
    const b: BuyersFinding = { ...buyers, clusters: [], sources: 0, topBuyers: 3, totalBuyers: 120, topShare: 0.6, largestBuyers: rows, demand: "mixed" };
    const c = buyersChart(b)!;
    expect(c.traced).toBe(false);
    expect(c.tiles.map((t) => t.kind)).toEqual(["buyer", "buyer", "buyer", "rest"]);
    expect(c.tiles[0].share).toBeCloseTo(0.3, 5);
    expect(c.tiles[3].share).toBeCloseTo(0.4, 5);
    expect(c.sourcesLabel).toBe("60% OF THE BUYING");
    expect(buyersAnswer(b).line).toMatch(/^of this week's buying came from the top 3 buyers/);
    expect(buyersChart(null)).toBeNull();
    expect(buyersChart({ ...buyers, status: "unavailable" })).toBeNull();
  });
});

describe("02 flow: tug of war + daily bars", () => {
  it("the knot is pulled towards whoever gets the supply; the largest outflow day is marked", () => {
    const c = flowChart(flow)!;
    expect([c.left.text, c.left.tone, c.right.text, c.right.tone]).toEqual(["sold $2M", "red", "bought $1.6M", "green"]);
    // Distributing: the supply moves to the crowd (right), and the caption points that way.
    expect(c.knot).toBeGreaterThan(0);
    expect(c.caption).toBe("SUPPLY IS MOVING TO THE CROWD \u2192");
    // A crowd 100x bigger than the seller does not pin the knot: the distance follows informed money's move.
    const small = flowChart({ ...flow, informedNetUsd: -300_000, informedNetPctSupply: -0.006, freshNetUsd: 29_000_000 }, { marketCapUsd: 50_000_000 })!;
    expect(small.knot).toBeGreaterThan(0);
    expect(small.knot).toBeLessThan(0.6);
    expect(c.exchanges).toBe("Exchanges took in 0.8% of supply");
    expect(c.days).toHaveLength(7);
    const worst = c.days[c.worst!];
    expect(worst.usd).toBe(Math.min(...c.days.map((d) => d.usd)));
    expect(worst.label).toMatch(/^(SUN|MON|TUE|WED|THU|FRI|SAT)$/);
    expect(flowAnswer(flow, scan.meta)).toEqual({ value: "\u2212$2M", tone: "red", line: "Smart money and whales sold. Fresh wallets bought $1.6M." });

    const buying = flowChart({ ...flow, informedNetUsd: 3_000_000, freshNetUsd: -500_000, verdict: "accumulating" })!;
    expect(buying.knot).toBeLessThan(0);
    expect(buying.caption).toBe("\u2190 SMART MONEY IS TAKING SUPPLY");
    const quiet = flowChart({ ...flow, informedNetUsd: -10_000, freshNetUsd: null, verdict: "quiet" })!;
    expect(quiet.right.text).toBe(NA);
    expect(Math.abs(quiet.knot)).toBeLessThanOrEqual(0.35);
  });
});

describe("03 walls: the price ladder", () => {
  it("bins as bars in pool multiples, the main wall labelled against the pool", () => {
    const c = wallsChart(walls, scan.meta)!;
    expect(c.unit).toBe("pool");
    expect(c.ticks).toEqual([0.02, 0.03, 0.04, 0.05, 0.06, 0.07]);
    expect(c.bars).toHaveLength(walls.ladder.length);
    expect(c.walls.find((x) => x.main)?.label).toBe("2.3\u00d7 POOL");
    expect(c.maxSize).toBeCloseTo(2.31, 2);
    expect(c.bars.filter((b) => b.zone === "below").every((b) => b.mid < scan.meta.priceNow)).toBe(true);
    expect(c.bars.filter((b) => b.zone !== "below").every((b) => b.mid > scan.meta.priceNow)).toBe(true);
    expect(c.method).toBe("Cost basis \u00b7 74 holders \u00b7 71% of supply analysed");
    expect(wallsAnswer(walls, scan.meta)).toEqual({
      value: "+22%",
      tone: "red",
      line: "87M tokens are back to break-even at $0.050. That wall is 2.3\u00d7 the pool.",
    });
    const noPool = wallsChart(walls, { ...scan.meta, liquidityUsd: null })!;
    expect(noPool.unit).toBe("share");
    expect(noPool.walls.find((x) => x.main)?.label).toMatch(/OF SUPPLY$/);
    expect(wallsChart(null, scan.meta)).toBeNull();
  });

  it("log ticks pick round prices", () => {
    expect(logTicks(0.018, 0.075)).toEqual([0.02, 0.03, 0.04, 0.05, 0.06, 0.07]);
    expect(logTicks(0.001, 0.4)).toEqual([0.001, 0.01, 0.1]);
    expect(logTicks(0, 1)).toEqual([]);
  });
});

describe("04 smart money: the gauge", () => {
  it("needle at the P&L, zones from the thresholds, a stance badge; grey when there is nothing to show", () => {
    const g = smartGauge(smart);
    expect(g.state).toBe("ok");
    expect(g.needle).toBeCloseTo(0.38, 2);
    expect(g.zones.map((z) => [Number(z.from.toFixed(2)), Number(z.to.toFixed(2)), z.tone])).toEqual([
      [-0.5, -0.1, "red"],
      [-0.1, 0.1, "amber"],
      [0.1, 1, "green"],
    ]);
    expect(g.stance).toEqual({ word: "TRIMMING", arrow: "\u2193", tone: "red" });
    expect(smartAnswer(smart)).toEqual({ value: "+38%", tone: "green", line: "Paid $0.030 on average. Now trimming into strength." });
    expect(g.ticks.map((t) => t.label)).toEqual(["\u221250%", "ENTRY", "+50%", "2\u00d7"]);
    // Real readings run to 3x-5x: the gauge widens (log scale) instead of pinning the needle.
    const big = smartGauge({ ...smart, pnlPct: 2.4 });
    expect(big).toMatchObject({ needle: 2.4, offScale: false, max: 4 });
    expect(big.ticks.map((t) => t.label)).toEqual(["\u221250%", "ENTRY", "2\u00d7", "5\u00d7"]);
    expect(gaugePos(big, 2.4)).toBeCloseTo(Math.log(6.8) / Math.log(10), 6);
    expect(gaugePos(big, 0)).toBeCloseTo(Math.log(2) / Math.log(10), 6);
    expect(smartGauge({ ...smart, pnlPct: 400 })).toMatchObject({ needle: 99, offScale: true });
    expect(smartGauge({ ...smart, wallets: 2 })).toMatchObject({ state: "too-few", needle: null, blank: "TOO FEW WALLETS" });
    expect(smartGauge({ ...smart, wallets: 0, avgEntry: null })).toMatchObject({ state: "none", blank: "NO SMART MONEY" });
    expect(smartGauge({ ...smart, status: "unavailable" }).blank).toBe("NO DATA");
    expect(smartGauge(null).state).toBe("pending");
    expect(smartAnswer({ ...smart, wallets: 2 }).line).toMatch(/Too few to show: an aggregate needs at least 3\.$/);
  });
});

describe("05 you: the entry distribution", () => {
  it("SM / NOW / YOU on the holders' entry prices; a ghost before a wallet is checked", () => {
    const c = youChart(you, walls, smart, scan.meta)!;
    expect([c.checked, c.sm, c.now, c.you, c.cheaperShare]).toEqual([true, smart.avgEntry, scan.meta.priceNow, you.cost, you.cheaperShare]);
    expect(c.bins).toHaveLength(walls.ladder.length);
    expect(c.bins.filter((b) => b.cheaper).every((b) => Math.sqrt(b.lo * b.hi) < you.cost!)).toBe(true);
    expect(c.lo).toBeLessThan(Math.min(smart.avgEntry!, walls.ladder[0].lo));
    expect(youAnswer(you, scan.meta)).toMatchObject({ value: "+51%", tone: "red" });

    const ghost = youChart(null, walls, smart, scan.meta)!;
    expect([ghost.checked, ghost.you, ghost.cheaperShare]).toEqual([false, null, null]);
    expect(youAnswer(null, scan.meta)).toEqual({
      value: NA,
      tone: "grey",
      line: "Paste a wallet that holds $KAIRO to put its entry on this chart. Your address is not stored.",
    });
    const derived = youChart({ ...you, cheaperShare: null }, walls, smart, scan.meta)!;
    expect(derived.cheaperShare).toBeGreaterThan(0.5);
  });
});

describe("evidence: the waffle", () => {
  it("one square per call, grouped by endpoint in a fixed order", () => {
    const w = callWaffle(scan.calls);
    expect(w.cells).toHaveLength(scan.calls.length);
    expect(w.groups.reduce((s, g) => s + g.count, 0)).toBe(scan.calls.length);
    expect(w.groups.find((g) => g.key === "funder")?.count).toBe(142);
    expect(w.groups.find((g) => g.key === "pnl")?.count).toBe(84);
    expect(w.cached).toBe(1);
    const order = w.groups.map((g) => g.key);
    const seen = w.cells.map((c) => order.indexOf(c.group));
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
    expect(callGroupOf("/api/v1/tgm/holders")).toBe("holders");
    expect(callGroupOf("tgm/flow-intelligence")).toBe("flows");
    expect(callGroupOf("profiler/address/dex-trades")).toBe("info");
    expect(callGroupOf("search/general")).toBe("other");
    expect(evidenceAnswer(scan.calls, scan.totals)).toMatchObject({ value: "248", tone: "blue" });
    expect(evidenceAnswer(scan.calls, scan.totals).line).toMatch(/^Nansen API calls \u00b7 271 credits \u00b7 \d+(\.\d)?s\. One square per call\.$/);
    expect(evidenceAnswer([], null).value).toBe("0");
  });
});

describe("layout helpers", () => {
  it("squarify keeps every area proportional and inside the box", () => {
    const items = [0.31, 0.3, 0.16, 0.14, 0.06, 0.025].map((share, i) => ({ id: i, share }));
    const box = { x: 0, y: 0, w: 440, h: 200 };
    const cells = squarify(items, box);
    expect(cells).toHaveLength(items.length);
    const total = items.reduce((s, i) => s + i.share, 0);
    for (const c of cells) {
      expect((c.w * c.h) / (box.w * box.h)).toBeCloseTo(c.item.share / total, 6);
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + c.w).toBeLessThanOrEqual(box.w + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(box.h + 1e-6);
    }
    expect(squarify([], box)).toEqual([]);
  });

  it("labels never overlap within a row; log scales map the ends", () => {
    const items = [100, 110, 118, 400].map((x) => ({ x, width: textWidth("SMART MONEY $0.030", 11, true) }));
    const placed = placeLabels(items, 440, [12, 26, 40]);
    const spans = placed.map((p, i) => ({ y: p.y, a: p.anchor === "start" ? p.x : p.x - items[i].width, b: p.anchor === "start" ? p.x + items[i].width : p.x }));
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++)
        if (spans[i].y === spans[j].y) expect(spans[i].b <= spans[j].a || spans[j].b <= spans[i].a).toBe(true);
    const s = logScale(0.01, 1, 0, 100);
    expect([s(0.01), s(0.1), s(1)]).toEqual([0, 50, 100]);
  });
});

describe("no long dash anywhere in the drawer's words", () => {
  it("every model and answer prints n/a instead", () => {
    const models = [
      monitorChannels(scan.findings, scan.meta, you),
      monitorChannels(NONE, null, null),
      monitorChannels({ buyers: { ...buyers, status: "unavailable" }, flow: { ...flow, status: "unavailable" }, walls: { ...walls, status: "unavailable" }, smart: { ...smart, status: "unavailable" } }, null, { ...you, status: "unavailable" }),
      buyersChart(buyers),
      buyersAnswer(null),
      flowChart({ ...flow, freshNetUsd: null, exchangeNetPctSupply: null }),
      flowAnswer(null, null),
      wallsChart(walls, { ...scan.meta, liquidityUsd: null }),
      wallsAnswer(null, null),
      smartGauge(null),
      smartAnswer({ ...smart, avgEntry: null, wallets: 0 }),
      youChart(null, null, null, null),
      youAnswer({ ...you, cost: null, vsSmartMoneyPct: null }, null),
      evidenceAnswer([], null),
      buyersResult(null),
      flowResult(null, null),
      wallsResult(null, null),
      smartResult(null),
      youResult(null),
      keyNumbers(NONE, null, null),
    ];
    expect(JSON.stringify(models)).not.toContain(EM_DASH);
    expect(noDash(EM_DASH)).toBe(NA);
    expect(noDash(`a ${EM_DASH} b`)).toBe("a: b");
  });
});
