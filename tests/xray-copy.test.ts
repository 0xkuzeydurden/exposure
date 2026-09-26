import { describe, expect, it } from "vitest";
import {
  allocationNote,
  buyerFunding,
  chainLabel,
  confidenceLine,
  evidenceLine,
  examLabel,
  FINDING_KEYS,
  FINDING_TITLES,
  findingNo,
  footnoteMarks,
  lineFor,
  noteFor,
  patientName,
  PENDING,
  plateLine,
  priceShort,
  reportDate,
  reportLines,
  scanNoLabel,
  smallGroupsLabels,
  stageMessage,
  stampLines,
  tagFor,
  UNIQUE_FUNDERS,
  youLine,
} from "@/lib/xray/copy";
import { makeSyntheticScan, makeSyntheticWalletCheck } from "@/lib/xray/fixtures";
import type { BuyersFinding, FlowFinding, SmartFinding, WalletCheck, WallsFinding } from "@/lib/xray/types";

const SCAN = makeSyntheticScan();
const { buyers: B, flow: F, walls: W, smart: S } = SCAN.findings;
const YOU = makeSyntheticWalletCheck(SCAN);

const unavailable = <X extends { status: string }>(x: X): X => ({ ...x, status: "unavailable" });
const all: string[] = [];
const seen = (s: string) => {
  all.push(s);
  return s;
};

describe("synthetic scan reads like the mockup", () => {
  it("film tags", () => {
    expect(seen(tagFor(1, B))).toBe("23/80 INDEPENDENT");
    expect(seen(tagFor(2, F))).toBe("PULSE −3.1%");
    expect(seen(tagFor(3, W))).toBe("SELL WALL +22%");
    expect(seen(tagFor(4, S))).toBe("SM ENTRY $0.030");
    expect(seen(tagFor(5, YOU))).toBe("YOU");
  });

  it("report lines", () => {
    expect(seen(lineFor(1, B))).toBe(
      "23 of the top 80 buyers were funded independently. 41 shared a funder; one wallet funded 30 of them. 16 could not be traced.",
    );
    expect(seen(lineFor(2, F))).toBe(
      "Smart money and whales sold $2M this week. Fresh wallets bought $1.6M. 0.8% of supply moved onto exchanges.",
    );
    expect(seen(lineFor(3, W))).toBe("87M tokens get back to break-even at $0.050 (+22%). That is 2.3× the pool's liquidity.");
    expect(seen(lineFor(4, S))).toBe("Average entry $0.030. Now +38% and trimming into strength.");
    expect(seen(lineFor(5, YOU))).toBe("Your entry is 51% above smart money. 83% of the analysed supply was bought cheaper.");
    expect(youLine(YOU)).toBe(lineFor(5, YOU));
  });

  it("reportLines bundles all five with titles and tags", () => {
    const lines = reportLines(SCAN.findings, YOU);
    expect(lines.map((l) => `${l.n}. ${l.title}: `)).toEqual([
      "1. REAL BUYERS: ",
      "2. FLOW: ",
      "3. SELL WALL: ",
      "4. SMART MONEY: ",
      "5. YOU: ",
    ]);
    expect(lines.map((l) => l.key)).toEqual(["buyers", "flow", "walls", "smart", "you"]);
    expect(lines[0].tag).toBe("23/80 INDEPENDENT");
    expect(lines[4].text).toBe(youLine(YOU));
    // Before any data: pending lines, empty tags, and the wallet prompt.
    const empty = reportLines(null);
    expect(empty.slice(0, 4).every((l) => l.text === PENDING && l.tag === "")).toBe(true);
    expect(empty[4].text).toBe("Paste your wallet to see where you stand.");
    expect(empty[4].tag).toBe("YOU");
  });

  it("impression furniture", () => {
    expect(footnoteMarks(SCAN.diagnosis)).toBe("¹ ² ⁴");
    expect(confidenceLine(SCAN.diagnosis)).toBe("Confidence: HIGH");
    expect(stampLines(SCAN.diagnosis)).toEqual(["Reviewed", "Confidence high"]);
    expect(patientName(SCAN.meta)).toBe("$KAIRO");
    expect(patientName({ symbol: "kairo", name: "x" })).toBe("$KAIRO");
    expect(patientName({ symbol: "", name: "Some Token" })).toBe("SOME TOKEN");
    expect(chainLabel(SCAN.meta.chain)).toBe("BASE");
    expect(chainLabel("bnb")).toBe("BNB CHAIN");
    expect(scanNoLabel(SCAN.meta.scanNo)).toBe("0412");
    expect(reportDate(SCAN.meta.scannedAt)).toBe("26 SEP 2026 14:02");
    expect(reportDate("nope")).toBe("n/a");
    expect(scanNoLabel(Number.NaN)).toBe("n/a");
    expect(plateLine(SCAN.meta)).toBe("SCAN 0412 · 26 SEP 2026 · 7-DAY");
    expect(examLabel("deep")).toBe("7-DAY RADIOGRAPH");
    expect(examLabel("quick")).toBe("7-DAY RADIOGRAPH · QUICK");
    expect(evidenceLine(SCAN.totals)).toBe("248 Nansen API calls · 271 credits");
    expect(evidenceLine({ calls: 1, credits: 1 })).toBe("1 Nansen API call · 1 credit");
  });

  it("numbering helpers", () => {
    expect(FINDING_KEYS[3]).toBe("walls");
    expect(findingNo("smart")).toBe(4);
    expect(findingNo("context")).toBeNull();
    expect(FINDING_TITLES[1]).toBe("REAL BUYERS");
  });
});

describe("01 · buyers variants", () => {
  const b = (o: Partial<BuyersFinding>): BuyersFinding => ({ ...B, ...o });

  it("untraced fallback (Solana / quick tier)", () => {
    const f = b({ sources: 0, clusters: [], topBuyers: 10, topShare: 0.74, biggestSourceShare: 0.17, status: "partial", note: "Funding sources are not traced on this chain (first-funder is EVM-only)." });
    expect(seen(tagFor(1, f))).toBe("TOP 10 · 74%");
    expect(seen(lineFor(1, f))).toBe("The top 10 buyers did 74% of this week's buying, the largest alone 17%. Funders are not traced on this chain.");
    // The quick tier traces funders in the deep scan, not "never on this chain".
    expect(seen(lineFor(1, { ...f, note: "Funding sources are traced in the deep scan." }))).toBe(
      "The top 10 buyers did 74% of this week's buying, the largest alone 17%. Funders are traced in the deep scan.",
    );
    expect(seen(noteFor(1, f))).toBe("Funding sources are not traced on this chain (first-funder is EVM-only).");
  });

  it("singular sources, no shared funder, heavy untraced share", () => {
    expect(seen(tagFor(1, b({ sources: 1 })))).toBe("1/80 INDEPENDENT");
    // Every traced buyer on its own funder: nothing shared, the untraced ones counted.
    const own = B.clusters.filter((c) => c.kind === "exchange" || c.kind === "bridge").slice(0, 1);
    expect(seen(lineFor(1, b({ sources: 56, clusters: own, biggestSourceWallets: 1, untracedShare: 0.3 })))).toBe(
      "56 of the top 80 buyers were funded independently. 24 could not be traced.",
    );
    expect(seen(lineFor(1, b({ sources: 80, clusters: own, biggestSourceWallets: 1, untracedShare: 0 })))).toBe(
      "All 80 top buyers were funded independently.",
    );
    // Pairs only: "shared a funder with another buyer", never "no wallet funded more than one".
    const pairs = [
      { id: "w1", kind: "wallet" as const, label: "0xe9c4f6", funder: `0xe9c4f6${"0".repeat(28)}ab8e`, wallets: 2, boughtUsd: 1, share: 0.01, members: [] },
      { id: "w2", kind: "wallet" as const, label: "Binance", wallets: 1, boughtUsd: 1, share: 0.5, members: [] },
    ];
    expect(seen(lineFor(1, b({ topBuyers: 90, sources: 88, clusters: pairs, biggestSourceWallets: 1, untracedShare: 1 / 90 })))).toBe(
      "88 of the top 90 buyers were funded independently. 1 shared a funder with another buyer. 1 could not be traced.",
    );
    expect(seen(lineFor(1, b({ sources: 0, clusters: [{ ...B.clusters[B.clusters.length - 1] }] })))).toBe(
      "None of the top 80 buyers could be traced to a funder.",
    );
  });

  it("independent sources and unique funders are two different counts, with two different words", () => {
    // Independent: one per source, every exchange- or bridge-funded buyer its own (the headline, tag, lab).
    // Unique funders: buyers whose funder paid for no other top buyer (the film's grid): the Binance and
    // Coinbase buyers share their exchange, so they are not in it.
    const f = buyerFunding(B);
    expect(f.independent).toBe(23);
    expect(f.unique).toBe(B.clusters.filter((c) => c.kind !== "untraced" && c.wallets === 1).length);
    expect(f.unique).toBe(5);
    expect(UNIQUE_FUNDERS).toBe("UNIQUE FUNDERS");
    expect(tagFor(1, B)).not.toMatch(/UNIQUE/);
    expect(smallGroupsLabels(3)).toEqual(["SMALL GROUPS · 3 FUNDERS", "3 SMALL GROUPS", "SMALL GROUPS"]);
    for (const s of [UNIQUE_FUNDERS, ...smallGroupsLabels(3)]) seen(s);
  });

  it("unavailable and pending", () => {
    expect(seen(tagFor(1, unavailable(B)))).toBe("NO BUYER DATA");
    expect(seen(lineFor(1, unavailable(b({ note: undefined }))))).toBe("Buyer data was not available for this scan.");
    expect(seen(lineFor(1, unavailable(b({ note: "No DEX buyers were found in the last 7 days" }))))).toBe(
      "No DEX buyers were found in the last 7 days.",
    );
    expect(tagFor(1, null)).toBe("");
    expect(lineFor(1, null)).toBe(PENDING);
  });

  it("lab note carries the honesty line", () => {
    expect(seen(noteFor(1, B))).toBe(
      "412 wallets bought in 7 days; the top 80 did 91% of the buying. 20% of them could not be traced. A funder is the wallet that paid a buyer's first gas, not necessarily the source of its money.",
    );
  });
});

describe("02 · flow variants", () => {
  const f = (o: Partial<FlowFinding>): FlowFinding => ({ ...F, ...o });
  it("informed buying, no fresh data, small exchange flow", () => {
    expect(seen(lineFor(2, f({ informedNetUsd: 1_240_000, informedNetPctSupply: 0.012, freshNetUsd: null, exchangeNetPctSupply: 0.001 })))).toBe(
      "Smart money and whales bought $1.2M this week.",
    );
    expect(seen(tagFor(2, f({ informedNetPctSupply: 0.012 })))).toBe("PULSE +1.2%");
  });
  it("barely moved, fresh selling", () => {
    expect(seen(lineFor(2, f({ informedNetUsd: 800, informedNetPctSupply: 0.0001, freshNetUsd: -45_000, exchangeNetPctSupply: null })))).toBe(
      "Smart money and whales barely moved this week. Fresh wallets sold $45K.",
    );
  });
  it("tag falls back to USD without a supply", () => {
    expect(seen(tagFor(2, f({ informedNetPctSupply: null })))).toBe("PULSE −$2M");
    expect(seen(tagFor(2, f({ informedNetPctSupply: null, informedNetUsd: 350_000 })))).toBe("PULSE +$350K");
  });
  it("unavailable, pending, lab note", () => {
    expect(seen(tagFor(2, unavailable(F)))).toBe("NO FLOW DATA");
    expect(seen(lineFor(2, unavailable(F)))).toBe("No labelled flow data for this token this week.");
    expect(lineFor(2, null)).toBe(PENDING);
    expect(seen(noteFor(2, F))).toBe(
      `Informed money = smart money, whales and public figures, aggregated and never shown per wallet. ${F.lead!.text}`,
    );
  });
});

describe("03 · walls variants", () => {
  const w = (o: Partial<WallsFinding>): WallsFinding => ({ ...W, ...o });
  it("no wall above the price", () => {
    const none = w({ walls: [], ceiling: "light" });
    expect(seen(tagFor(3, none))).toBe("NO SELL WALL");
    expect(seen(lineFor(3, none))).toBe("No sell wall sits above the price.");
  });
  it("quick tier (recent buyers), unknown liquidity, most supply underwater, partial coverage", () => {
    const quick = w({
      method: "recent_buyers",
      status: "partial",
      analyzedSupplyShare: 0.41,
      underwaterShare: 0.64,
      walls: [{ ...W.walls[1], wallToLiquidity: null }],
    });
    expect(seen(lineFor(3, quick))).toBe(
      "87M tokens bought in the last 30 days break even at $0.050 (+22%). That is 15% of the analysed supply. 64% of the analysed supply is underwater. Based on 41% of supply.",
    );
    expect(seen(noteFor(3, quick))).toBe(
      "Entry prices are this month's buyers' average prices (quick scan). They cover 41% of supply; 64% of it is underwater.",
    );
  });
  it("unavailable and pending", () => {
    expect(seen(tagFor(3, unavailable(W)))).toBe("NO WALL DATA");
    expect(seen(lineFor(3, unavailable(W)))).toBe("Holders' entry prices were not available.");
    expect(tagFor(3, undefined)).toBe("");
    expect(seen(noteFor(3, W))).toBe("Entry prices come from 74 holders' profit-and-loss records. They cover 71% of supply; 20% of it is underwater.");
  });
});

describe("04 · smart money variants", () => {
  const s = (o: Partial<SmartFinding>): SmartFinding => ({ ...S, ...o });
  it("stances", () => {
    expect(seen(lineFor(4, s({ avgEntry: 0.05, pnlPct: -0.176, stance: "adding", state: "loss" })))).toBe(
      "Average entry $0.050. Now −18% and still adding.",
    );
    expect(seen(lineFor(4, s({ stance: "exiting", pnlPct: -0.3 })))).toBe("Average entry $0.030. Now −30% and exiting at a loss.");
    expect(seen(lineFor(4, s({ stance: "exiting" })))).toBe("Average entry $0.030. Now +38% and heading for the exit.");
    expect(seen(lineFor(4, s({ stance: "holding", pnlPct: 0.04 })))).toBe("Average entry $0.030. Now +4.0% and holding.");
    expect(seen(lineFor(4, s({ stance: "trimming", pnlPct: null })))).toBe("Average entry $0.030. Trimming.");
  });
  it("no smart money, unavailable, pending", () => {
    const none = s({ avgEntry: null, pnlPct: null, wallets: 0, state: "unknown" });
    expect(seen(tagFor(4, none))).toBe("NO SMART MONEY");
    expect(seen(lineFor(4, none))).toBe("No smart money traded this token in the last 30 days.");
    expect(seen(tagFor(4, unavailable(S)))).toBe("NO SM DATA");
    expect(seen(lineFor(4, unavailable(S)))).toBe("Smart money data was not available.");
    expect(lineFor(4, null)).toBe(PENDING);
    expect(seen(noteFor(4, S))).toBe("Aggregated over 30 days across 14 smart-money wallets; never shown per wallet.");
  });
});

describe("05 · you variants", () => {
  const y = (o: Partial<WalletCheck>): WalletCheck => ({ ...YOU, ...o });
  it("cheaper than smart money, matching, no smart money", () => {
    expect(seen(youLine(y({ vsSmartMoneyPct: -0.2, cheaperShare: 0.1 })))).toBe(
      "Your entry is 20% below smart money. 10% of the analysed supply was bought cheaper.",
    );
    expect(seen(youLine(y({ vsSmartMoneyPct: 0.001, cheaperShare: null })))).toBe("Your entry matches smart money's.");
    expect(seen(youLine(y({ vsSmartMoneyPct: null, cheaperShare: null })))).toBe("Your entry is $0.045, now −8.6%.");
    expect(seen(youLine(y({ vsSmartMoneyPct: null, pnlPct: null, cheaperShare: null })))).toBe("Your entry is $0.045.");
  });
  it("no DEX entry, no position, nothing pasted", () => {
    expect(seen(youLine(y({ cost: null })))).toBe("No DEX entry found for 0x5eed…caf0. It holds 412K tokens.");
    expect(seen(youLine(y({ cost: null, holdingTokens: 0 })))).toBe("No position in this token found for 0x5eed…caf0.");
    expect(seen(youLine(unavailable(YOU)))).toBe("No position in this token found for 0x5eed…caf0.");
    expect(seen(youLine(null))).toBe("Paste your wallet to see where you stand.");
    expect(tagFor(5, null)).toBe("YOU");
  });
});

describe("formatting", () => {
  it("priceShort: two significant digits under $1, lib/format elsewhere", () => {
    expect(priceShort(0.03)).toBe("$0.030");
    expect(priceShort(0.02985)).toBe("$0.030");
    expect(priceShort(0.0503)).toBe("$0.050");
    expect(priceShort(0.42)).toBe("$0.42");
    expect(priceShort(1.2346)).toBe("$1.235");
    expect(priceShort(0.00001234)).toBe("$0.0₄1234");
    expect(priceShort(null)).toBe("n/a");
  });

  it("stage messages", () => {
    expect(stageMessage("context", SCAN)).toBe("Positioning $KAIRO: price, holders, liquidity");
    expect(stageMessage("buyers", SCAN)).toBe("Tracing who funded the top buyers");
    expect(stageMessage("buyers", { ...SCAN, findings: { ...SCAN.findings, buyers: { ...B, sources: 0, clusters: [] } } })).toBe(
      "Reading this week's top buyers",
    );
    expect(stageMessage("walls", SCAN)).toBe("Reading holders' entry prices");
    expect(stageMessage("done", SCAN)).toBe("Exposure complete · 248 Nansen API calls · 271 credits");
    expect(stageMessage("done")).toBe("Exposure complete");
  });

  it("allocations: a share of TOTAL supply, never claimed as bought-nothing team tokens only", () => {
    expect(allocationNote({})).toBe("");
    expect(allocationNote({ allocatedShare: 0 })).toBe("");
    const note = seen(allocationNote({ allocatedShare: 0.92 }));
    expect(note).toBe(
      "92% of total supply is left out: tokens received, not bought on a DEX (team, vesting, airdrops or exchange withdrawals), or held outside the circulating supply.",
    );
    expect(note).not.toMatch(/received rather than bought|allocations \(/);
    expect(seen(allocationNote({ allocatedShare: 0.004 }))).toMatch(/^0\.4% of total supply is left out:/);
    expect(seen(noteFor(3, { ...W, allocatedShare: 0.5 }))).toContain("50% of total supply is left out");
  });

  it("never says scam, never prints an em dash, and negative numbers use a true minus", () => {
    expect(all.length).toBeGreaterThan(40);
    for (const s of all) {
      expect(s.toLowerCase()).not.toContain("scam");
      expect(s).not.toContain("\u2014");
      expect(s).not.toMatch(/(^|[\s($])-\d/);
    }
  });
});
