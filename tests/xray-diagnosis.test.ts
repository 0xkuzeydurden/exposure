import { describe, expect, it } from "vitest";
import {
  ceilingOf,
  confidenceOf,
  coverageOf,
  demandOf,
  diagnose,
  DIAGNOSIS_RULES,
  flowVerdictOf,
  hasLabelledFlow,
  lightsOf,
  primaryWall,
  SENTENCES,
  smartStanceOf,
  smartStateOf,
} from "@/lib/xray/diagnosis";
import { makeSyntheticScan } from "@/lib/xray/fixtures";
import { T } from "@/lib/xray/thresholds";
import type {
  BuyersFinding,
  FlowFinding,
  Scan,
  ScanMeta,
  SmartFinding,
  SourceCluster,
  Wall,
  WallsFinding,
} from "@/lib/xray/types";

/* ---------- builders: a calm, well-covered token ---------- */

function buyers(o: Partial<BuyersFinding> = {}): BuyersFinding {
  return {
    status: "ok",
    windowDays: 7,
    totalBuyers: 300,
    topBuyers: 60,
    topShare: 0.85,
    sources: 45,
    untracedShare: 0.1,
    biggestSourceShare: 0.1,
    biggestSourceWallets: 3,
    clusters: [],
    demand: "organic",
    ...o,
  };
}

function flow(o: Partial<FlowFinding> = {}): FlowFinding {
  return {
    status: "ok",
    informedNetUsd: 12_000,
    informedNetPctSupply: 0.0002,
    freshNetUsd: 5_000,
    exchangeNetPctSupply: 0.0001,
    series: [],
    daily: [{ day: "2026-09-26", informedUsd: 12_000, freshUsd: null, exchangeUsd: 0 }],
    verdict: "quiet",
    ...o,
  };
}

function wall(o: Partial<Wall> = {}): Wall {
  return { price: 1.2, movePct: 0.2, tokens: 1_000_000, supplyShare: 0.01, wallToLiquidity: 0.5, alreadyTrimming: 0.1, holders: 5, ...o };
}

function walls(o: Partial<WallsFinding> = {}): WallsFinding {
  return {
    status: "ok",
    method: "cost_basis",
    holdersAnalyzed: 60,
    analyzedSupplyShare: 0.7,
    underwaterShare: 0.3,
    walls: [],
    ladder: [],
    ceiling: "light",
    ...o,
  };
}

function smart(o: Partial<SmartFinding> = {}): SmartFinding {
  return {
    status: "ok",
    windowDays: 30,
    avgEntry: 0.8,
    pnlPct: 0.25,
    wallets: 12,
    boughtUsd: 100_000,
    soldUsd: 90_000,
    netUsd: 10_000,
    stance: "holding",
    state: "profit",
    ...o,
  };
}

function meta(o: Partial<ScanMeta> = {}): ScanMeta {
  return {
    chain: "base",
    tokenAddress: "0x5eed000000000000000000000000000000000001",
    symbol: "TEST",
    name: "Test",
    priceNow: 1,
    priceChange7d: 0.05,
    marketCapUsd: 100_000_000,
    liquidityUsd: 2_000_000,
    circulatingSupply: 100_000_000,
    holders: 1000,
    buyers24h: 100,
    sellers24h: 80,
    volume24hUsd: 1_000_000,
    deployedAt: null,
    scannedAt: "2026-09-26T14:02:00.000Z",
    scanNo: 1,
    window: { from: "2026-09-19T14:00:00.000Z", to: "2026-09-26T14:00:00.000Z" },
    ...o,
  };
}

type F = Scan["findings"];
function findings(o: Partial<F> = {}): F {
  return { buyers: buyers(), flow: flow(), walls: walls(), smart: smart(), ...o };
}

const unavailable = <X extends { status: string }>(x: X): X => ({ ...x, status: "unavailable" });
const DISTRIBUTING = flow({ verdict: "distributing", informedNetUsd: -2_000_000, informedNetPctSupply: -0.02, freshNetUsd: 1_500_000 });
const ACCUMULATING = flow({ verdict: "accumulating", informedNetUsd: 900_000, informedNetPctSupply: 0.009 });

/* ---------- the rules ---------- */

describe("diagnose: rules, top to bottom", () => {
  it("6 · a calm, well-covered token reads normal", () => {
    const d = diagnose(findings(), meta());
    expect(d).toEqual({
      code: "normal",
      rule: 6,
      sentence: "Nothing unusual under the surface.",
      confidence: "high",
      lights: { flow: "amber", crowd: "green", ceiling: "green" },
      footnotes: ["buyers", "flow", "walls", "smart"],
    });
  });

  it("0 · insufficient only when analysed supply, buyers and labelled flow are all missing", () => {
    const thin = findings({
      buyers: buyers({ topBuyers: 5, totalBuyers: 5 }),
      flow: unavailable(flow()),
      walls: walls({ analyzedSupplyShare: 0.1 }),
    });
    const d = diagnose(thin, meta());
    expect(d.code).toBe("insufficient");
    expect(d.rule).toBe(0);
    expect(d.sentence).toBe("Too few labelled wallets to read this token.");
    expect(d.confidence).toBe("low");
    expect(d.footnotes).toEqual(["buyers", "flow", "walls"]);

    // Each condition alone is not enough.
    expect(diagnose({ ...thin, walls: walls({ analyzedSupplyShare: 0.25 }) }, meta()).rule).not.toBe(0);
    expect(diagnose({ ...thin, buyers: buyers({ topBuyers: 10 }) }, meta()).rule).not.toBe(0);
    expect(diagnose({ ...thin, flow: flow() }, meta()).rule).not.toBe(0);
    // A flow that is "ok" but saw no labelled movement counts as no labelled flow.
    const silent = flow({ informedNetUsd: 0, informedNetPctSupply: 0, daily: [], series: [] });
    expect(diagnose({ ...thin, flow: silent }, meta()).rule).toBe(0);
    // Everything unavailable -> insufficient.
    const none = findings({
      buyers: unavailable(buyers()),
      flow: unavailable(flow()),
      walls: unavailable(walls()),
      smart: unavailable(smart()),
    });
    expect(diagnose(none, meta()).code).toBe("insufficient");
  });

  it("1 · concentrated demand, and it wins over distribution", () => {
    const d = diagnose(findings({ buyers: buyers({ demand: "concentrated" }) }), meta());
    expect(d.code).toBe("concentrated");
    expect(d.sentence).toBe("Most of this week's buying traces back to a handful of wallets.");
    expect(d.footnotes).toEqual(["buyers"]);
    expect(d.lights.crowd).toBe("red");
    expect(diagnose(findings({ buyers: buyers({ demand: "concentrated" }), flow: DISTRIBUTING }), meta()).rule).toBe(1);
  });

  it("2 · distributing while the price has not fallen", () => {
    const f = findings({ flow: DISTRIBUTING });
    const d = diagnose(f, meta({ priceChange7d: 0.184 }));
    expect(d.code).toBe("distribution");
    expect(d.sentence).toBe("Smart money is selling to the crowd.");
    expect(d.footnotes).toEqual(["buyers", "flow", "smart"]);
    expect(d.lights.flow).toBe("red");
    // Flat or unknown price is "not fallen".
    expect(diagnose(f, meta({ priceChange7d: 0 })).rule).toBe(2);
    expect(diagnose(f, meta({ priceChange7d: null })).rule).toBe(2);
    // Without smart-money data the sentence rests on buyers + flow only.
    expect(diagnose({ ...f, smart: smart({ avgEntry: null, wallets: 0, state: "unknown" }) }, meta()).footnotes).toEqual(["buyers", "flow"]);
  });

  it("3 · distributing into a falling price with smart money at a loss or most holders underwater", () => {
    const down = meta({ priceChange7d: -0.12 });
    const smLoss = diagnose(findings({ flow: DISTRIBUTING, smart: smart({ state: "loss", pnlPct: -0.2 }) }), down);
    expect(smLoss.code).toBe("capitulation");
    expect(smLoss.sentence).toBe("Holders are giving up.");
    expect(smLoss.footnotes).toEqual(["flow", "smart"]);

    const underwater = diagnose(findings({ flow: DISTRIBUTING, walls: walls({ underwaterShare: 0.6, ceiling: "heavy" }) }), down);
    expect(underwater.code).toBe("capitulation");
    expect(underwater.footnotes).toEqual(["flow", "walls"]);

    // Falling price but smart money in profit and holders fine: rule 3 does not fire, and informed money
    // still sold to fresh buyers, so rule 2 does (a red flow light never ends in "Nothing unusual").
    const dipSold = diagnose(findings({ flow: DISTRIBUTING }), down);
    expect(dipSold.code).toBe("distribution");
    expect(dipSold.lights.flow).toBe("red");
    expect(diagnose(findings({ flow: DISTRIBUTING, walls: walls({ ceiling: "heavy" }) }), down).code).toBe("distribution");
  });

  it("never says nothing unusual while a light is red for flow", () => {
    for (const change of [-0.4, -0.01, 0, 0.2, null]) {
      const d = diagnose(findings({ flow: DISTRIBUTING }), meta({ priceChange7d: change }));
      expect(d.lights.flow).toBe("red");
      expect(d.code).not.toBe("normal");
    }
  });

  it("4 · a heavy ceiling, and it wins over accumulation", () => {
    const d = diagnose(findings({ walls: walls({ ceiling: "heavy" }) }), meta());
    expect(d.code).toBe("overhead");
    expect(d.sentence).toBe("Sellers are waiting just above the price.");
    expect(d.footnotes).toEqual(["walls"]);
    expect(d.lights.ceiling).toBe("red");
    expect(diagnose(findings({ walls: walls({ ceiling: "heavy" }), flow: ACCUMULATING }), meta()).rule).toBe(4);
  });

  it("5 · accumulating with demand not concentrated", () => {
    const d = diagnose(findings({ flow: ACCUMULATING }), meta());
    expect(d.code).toBe("accumulation");
    expect(d.sentence).toBe("Smart money is quietly buying.");
    expect(d.footnotes).toEqual(["buyers", "flow", "smart"]);
    expect(d.lights.flow).toBe("green");
  });

  it("ignores the classification of unavailable findings", () => {
    const b = diagnose(findings({ buyers: unavailable(buyers({ demand: "concentrated" })) }), meta());
    expect(b.rule).toBe(6);
    expect(b.lights.crowd).toBe("amber");
    expect(b.confidence).toBe("low"); // "nothing unusual" without the buyers finding
    expect(b.footnotes).toEqual(["flow", "walls", "smart"]);

    const w = diagnose(findings({ walls: unavailable(walls({ ceiling: "heavy" })) }), meta());
    expect(w.rule).toBe(6);
    expect(w.lights.ceiling).toBe("amber");

    const f = diagnose(findings({ flow: unavailable(DISTRIBUTING) }), meta());
    expect(f.rule).toBe(6);
    expect(f.lights.flow).toBe("amber");
  });

  it("rule table and sentences are exactly the plan's, and never say scam", () => {
    expect(DIAGNOSIS_RULES.map((r) => r.code)).toEqual([
      "insufficient",
      "concentrated",
      "distribution",
      "capitulation",
      "overhead",
      "accumulation",
      "normal",
    ]);
    expect(SENTENCES.distribution).toBe("Smart money is selling to the crowd.");
    for (const r of DIAGNOSIS_RULES) expect(r.sentence.toLowerCase()).not.toContain("scam");
  });
});

/* ---------- confidence ---------- */

describe("confidence = weakest coverage among the findings used", () => {
  it("maps coverage to high / medium / low at 0.6 and 0.3", () => {
    expect(confidenceOf(0.6)).toBe("high");
    expect(confidenceOf(0.5999)).toBe("medium");
    expect(confidenceOf(0.3)).toBe("medium");
    expect(confidenceOf(0.2999)).toBe("low");
  });

  it("uses only the findings the rule rests on", () => {
    // Overhead rests on walls alone: weak smart-money coverage does not matter.
    const heavy = (share: number) => findings({ walls: walls({ ceiling: "heavy", analyzedSupplyShare: share }), smart: smart({ wallets: 1 }) });
    expect(diagnose(heavy(0.7), meta()).confidence).toBe("high");
    expect(diagnose(heavy(0.45), meta()).confidence).toBe("medium");
    expect(diagnose(heavy(0.26), meta()).confidence).toBe("low");

    // Distribution: buyers 0.5 x (1 - 0.2) = 0.4 -> medium.
    expect(diagnose(findings({ flow: DISTRIBUTING, buyers: buyers({ topShare: 0.5, untracedShare: 0.2 }) }), meta()).confidence).toBe("medium");
    // Distribution: 3 smart wallets -> 0.3 -> medium.
    expect(diagnose(findings({ flow: DISTRIBUTING, smart: smart({ wallets: 3 }) }), meta()).confidence).toBe("medium");
    // Fewer than 3 smart wallets are never shown, so they are not evidence either (no ⁴ footnote).
    const thin = diagnose(findings({ flow: DISTRIBUTING, smart: smart({ wallets: 2 }) }), meta());
    expect(thin.footnotes).not.toContain("smart");
    expect(thin.confidence).toBe("high");
    // Partial flow -> 0.5 -> medium.
    expect(diagnose(findings({ flow: { ...DISTRIBUTING, status: "partial" } }), meta()).confidence).toBe("medium");
  });

  it("coverage per finding", () => {
    const f = findings();
    expect(coverageOf("buyers", f)).toBeCloseTo(0.765);
    expect(coverageOf("flow", f)).toBe(1);
    expect(coverageOf("walls", f)).toBe(0.7);
    expect(coverageOf("smart", f)).toBe(1);
    expect(coverageOf("smart", { smart: smart({ wallets: 4 }) })).toBeCloseTo(0.4);
    expect(coverageOf("smart", { smart: smart({ avgEntry: null }) })).toBe(0);
    // Untraced fallback: coverage is the top buyers' volume share.
    expect(coverageOf("buyers", { buyers: buyers({ sources: 0, clusters: [], topBuyers: 10, topShare: 0.74 }) })).toBe(0.74);
    expect(coverageOf("walls", { walls: unavailable(walls()) })).toBe(0);
  });
});

/* ---------- lights ---------- */

describe("lights", () => {
  it("flow: distributing red, quiet amber, accumulating green", () => {
    expect(lightsOf({ flow: DISTRIBUTING }).flow).toBe("red");
    expect(lightsOf({ flow: flow() }).flow).toBe("amber");
    expect(lightsOf({ flow: ACCUMULATING }).flow).toBe("green");
  });
  it("crowd: concentrated red, mixed amber, organic green", () => {
    expect(lightsOf({ buyers: buyers({ demand: "concentrated" }) }).crowd).toBe("red");
    expect(lightsOf({ buyers: buyers({ demand: "mixed" }) }).crowd).toBe("amber");
    expect(lightsOf({ buyers: buyers({ demand: "organic" }) }).crowd).toBe("green");
  });
  it("ceiling: heavy red, light green, amber when walls are unavailable", () => {
    expect(lightsOf({ walls: walls({ ceiling: "heavy" }) }).ceiling).toBe("red");
    expect(lightsOf({ walls: walls({ ceiling: "light" }) }).ceiling).toBe("green");
    expect(lightsOf({ walls: unavailable(walls()) }).ceiling).toBe("amber");
    expect(lightsOf({}).ceiling).toBe("amber");
  });
});

/* ---------- classifiers (plan §5) ---------- */

const cluster = (kind: SourceCluster["kind"], wallets: number, share: number): SourceCluster => ({
  id: `${kind}-${wallets}`,
  kind,
  label: kind,
  wallets,
  boughtUsd: share * 1_000_000,
  share,
  members: [],
});

describe("demandOf", () => {
  it("ratio = sources / traced buyers; biggest non-exchange source share", () => {
    // 23 sources, 80 buyers, 20% untraced -> 23 / 64 = 0.36 -> mixed.
    expect(demandOf(buyers({ topBuyers: 80, sources: 23, untracedShare: 0.2, biggestSourceShare: 0.31 }))).toBe("mixed");
    // 20 / 64 = 0.31 < 0.35 -> concentrated.
    expect(demandOf(buyers({ topBuyers: 80, sources: 20, untracedShare: 0.2, biggestSourceShare: 0.1 }))).toBe("concentrated");
    // One source at 35% -> concentrated whatever the ratio.
    expect(demandOf(buyers({ topBuyers: 60, sources: 50, untracedShare: 0, biggestSourceShare: 0.35 }))).toBe("concentrated");
    // 40 / 60 = 0.67 and biggest 15% -> organic; biggest 20% -> mixed.
    expect(demandOf(buyers({ topBuyers: 60, sources: 40, untracedShare: 0, biggestSourceShare: 0.15 }))).toBe("organic");
    expect(demandOf(buyers({ topBuyers: 60, sources: 40, untracedShare: 0, biggestSourceShare: 0.2 }))).toBe("mixed");
  });

  it("80 buyers who all withdrew from Binance are 80 independent sources", () => {
    const b = buyers({ topBuyers: 80, sources: 80, untracedShare: 0, biggestSourceShare: 0, biggestSourceWallets: 0, clusters: [cluster("exchange", 80, 1)] });
    expect(demandOf(b)).toBe("organic");
  });

  it("falls back to top-10 concentration when funders were not traced (Solana, quick tier)", () => {
    const fallback = (top10: number) => buyers({ sources: 0, clusters: [], topBuyers: 10, topShare: top10, status: "partial", note: "Funding sources are not traced on this chain." });
    expect(demandOf(fallback(0.7))).toBe("concentrated");
    expect(demandOf(fallback(0.6))).toBe("mixed");
    expect(demandOf(fallback(0.49))).toBe("organic");
    expect(demandOf(unavailable(buyers()))).toBe("mixed");
  });
});

describe("flowVerdictOf", () => {
  const m = meta({ marketCapUsd: null });
  it("distributing needs informed <= -0.5% and fresh wallets net buying", () => {
    expect(flowVerdictOf(flow({ informedNetPctSupply: -0.005, freshNetUsd: 1 }), m)).toBe("distributing");
    expect(flowVerdictOf(flow({ informedNetPctSupply: -0.02, freshNetUsd: null }), m)).toBe("quiet");
    expect(flowVerdictOf(flow({ informedNetPctSupply: -0.02, freshNetUsd: -10 }), m)).toBe("quiet");
    expect(flowVerdictOf(flow({ informedNetPctSupply: -0.0049, freshNetUsd: 1 }), m)).toBe("quiet");
  });
  it("accumulating at >= +0.5%", () => {
    expect(flowVerdictOf(flow({ informedNetPctSupply: 0.005 }), m)).toBe("accumulating");
    expect(flowVerdictOf(flow({ informedNetPctSupply: 0.0049 }), m)).toBe("quiet");
  });
  it("prefers the market-cap share when the market cap is known", () => {
    const f = flow({ informedNetUsd: -600_000, informedNetPctSupply: null, freshNetUsd: 10 });
    expect(flowVerdictOf(f, meta({ marketCapUsd: 100_000_000 }))).toBe("distributing");
    expect(flowVerdictOf(f, meta({ marketCapUsd: 1_000_000_000 }))).toBe("quiet");
    expect(flowVerdictOf(f, m)).toBe("quiet"); // neither known
    expect(flowVerdictOf(unavailable(DISTRIBUTING), m)).toBe("quiet");
  });
  it("labelled flow detection", () => {
    expect(hasLabelledFlow(flow())).toBe(true);
    expect(hasLabelledFlow(flow({ informedNetUsd: 0, daily: [], series: [] }))).toBe(false);
    expect(hasLabelledFlow(unavailable(flow()))).toBe(false);
    expect(hasLabelledFlow(null)).toBe(false);
  });
});

describe("ceilingOf / primaryWall", () => {
  const circ = 100_000_000;
  it("a wall within +30% at >= 1.5x pool liquidity is heavy", () => {
    expect(ceilingOf(walls({ walls: [wall({ movePct: 0.3, wallToLiquidity: 1.5 })] }), circ)).toBe("heavy");
    expect(ceilingOf(walls({ walls: [wall({ movePct: 0.3, wallToLiquidity: 1.49 })] }), circ)).toBe("light");
    expect(ceilingOf(walls({ walls: [wall({ movePct: 0.31, wallToLiquidity: 3 })] }), circ)).toBe("light");
  });
  it("a wall within +30% holding >= 8% of the analysed supply is heavy", () => {
    // 5.65M tokens / (0.7 x 100M) = 8.1%; 5.5M = 7.9%.
    expect(ceilingOf(walls({ walls: [wall({ tokens: 5_650_000, wallToLiquidity: null })] }), circ)).toBe("heavy");
    expect(ceilingOf(walls({ walls: [wall({ tokens: 5_500_000, wallToLiquidity: null })] }), circ)).toBe("light");
    // Without the circulating supply: supplyShare (of circulating) / analysed share = 0.06 / 0.7 = 8.6%.
    expect(ceilingOf(walls({ walls: [wall({ supplyShare: 0.06, wallToLiquidity: null })] }))).toBe("heavy");
  });
  it(">= 60% of the analysed supply underwater is heavy", () => {
    expect(ceilingOf(walls({ underwaterShare: 0.6 }))).toBe("heavy");
    expect(ceilingOf(walls({ underwaterShare: 0.59 }))).toBe("light");
    expect(ceilingOf(unavailable(walls({ underwaterShare: 0.9 })))).toBe("light");
  });
  it("primaryWall: biggest heavy wall, else biggest within +30%, else nearest above", () => {
    const small = wall({ price: 1.05, movePct: 0.05, tokens: 100, wallToLiquidity: 0.1 });
    const heavy = wall({ price: 1.2, movePct: 0.2, tokens: 50, wallToLiquidity: 2 });
    const far = wall({ price: 1.6, movePct: 0.6, tokens: 9_999, wallToLiquidity: 9 });
    const below = wall({ price: 0.9, movePct: -0.1, tokens: 99_999 });
    expect(primaryWall(walls({ walls: [small, heavy, far, below] }))).toBe(heavy);
    expect(primaryWall(walls({ walls: [small, far] }))).toBe(small);
    expect(primaryWall(walls({ walls: [far, below] }))).toBe(far);
    expect(primaryWall(walls({ walls: [below] }))).toBeNull();
    expect(primaryWall(unavailable(walls({ walls: [heavy] })))).toBeNull();
  });
});

describe("smart money state and stance", () => {
  it("profit at >= 1.1x entry, loss below 0.9x", () => {
    expect(smartStateOf(1, 1.1)).toBe("profit");
    expect(smartStateOf(1, 1.09)).toBe("breakeven");
    expect(smartStateOf(1, 0.9)).toBe("breakeven");
    expect(smartStateOf(1, 0.89)).toBe("loss");
    expect(smartStateOf(null, 1)).toBe("unknown");
    expect(smartStateOf(0, 1)).toBe("unknown");
  });
  it("stance from net / gross flow", () => {
    expect(smartStanceOf(100, 0)).toBe("adding");
    expect(smartStanceOf(57.5, 42.5)).toBe("adding");
    expect(smartStanceOf(50, 50)).toBe("holding");
    expect(smartStanceOf(40, 60)).toBe("trimming");
    expect(smartStanceOf(20, 80)).toBe("exiting");
    expect(smartStanceOf(0, 0)).toBe("holding");
  });
});

describe("thresholds (plan §5)", () => {
  it("carries the plan's values", () => {
    expect(T.demand).toMatchObject({ organicRatio: 0.6, organicMaxSourceShare: 0.2, concentratedSourceShare: 0.35, concentratedRatio: 0.35, top10Concentrated: 0.7 });
    expect(T.flow).toMatchObject({ moveShare: 0.005, exchangeNoteShare: 0.003 });
    expect(T.ceiling).toMatchObject({ nearMovePct: 0.3, wallToLiquidity: 1.5, wallShareOfAnalysed: 0.08, underwaterShare: 0.6 });
    expect(T.smart).toMatchObject({ profitMultiple: 1.1, lossMultiple: 0.9 });
    expect(T.confidence).toMatchObject({ high: 0.6, medium: 0.3 });
    expect(T.insufficient).toMatchObject({ analysedSupply: 0.25, buyers: 10 });
  });
});

describe("synthetic scan", () => {
  it("diagnoses the mockup story: smart money selling to the crowd, high confidence", () => {
    const scan = makeSyntheticScan();
    const { buyers: b, flow: f, walls: w, smart: s } = scan.findings;
    expect(b.demand).toBe("mixed");
    expect(f.verdict).toBe("distributing");
    expect(w.ceiling).toBe("heavy");
    expect(s.state).toBe("profit");
    expect(s.stance).toBe("trimming");
    expect(scan.diagnosis).toEqual({
      code: "distribution",
      rule: 2,
      sentence: "Smart money is selling to the crowd.",
      confidence: "high",
      lights: { flow: "red", crowd: "amber", ceiling: "red" },
      footnotes: ["buyers", "flow", "smart"],
    });
    expect(diagnose(scan.findings, scan.meta)).toEqual(scan.diagnosis);
    // The recorded classifications agree with the classifiers.
    expect(demandOf(b)).toBe(b.demand);
    expect(flowVerdictOf(f, scan.meta)).toBe(f.verdict);
    expect(ceilingOf(w, scan.meta.circulatingSupply)).toBe(w.ceiling);
    expect(smartStateOf(s.avgEntry, scan.meta.priceNow)).toBe(s.state);
  });
});
