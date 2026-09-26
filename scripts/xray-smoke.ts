// EXPOSURE GO/NO-GO data test. Runs a small deep scan on 1 or 2 tokens and prints what the data covers:
// first-funder traced share and the biggest funding hub (the roots module), tgm/flows buckets per
// cohort, profiler-pnl cost coverage and smart-money wallets found.
//
// Usage: npm run smoke -- base:0xTOKEN [eth:0xTOKEN] [--buyers=20] [--holders=20] [--yes] [--force] [--refresh]
// Estimated spend ≈ 58 credits per EVM token at 20/20 (≈ 38 on Solana); refuses above 70 (the plan's
// smoke budget) without --force, and asks before spending anything unless --yes is given.
// Responses are cached with NANSEN_CACHE=snapshot semantics, so the gallery warm-up reuses them and a
// re-run costs 0 credits (--refresh fetches again). Account credits are read before/after (free call).
import { getAccount } from "../lib/nansen/api";
import { hasNansenKey } from "../lib/nansen/client";
import { describeError } from "../lib/nansen/errors";
import { flushLedger } from "../lib/nansen/ledger";
import { fmtNum, fmtPct, table } from "../lib/pipeline/cli";
import { estimateBreakdown } from "../lib/xray/budget";
import { confirm, intFlag, parseArgs, parseTarget } from "../lib/xray/pipeline/cli";
import { runScanDetailed, ScanError, type ScanDebug } from "../lib/xray/pipeline/run";
import { saveRecordedScan } from "../lib/xray/store";
import type { Scan } from "../lib/xray/types";

/** The build plan budgets ~70 credits for the smoke tests. */
const MAX_WITHOUT_FORCE = 70;
/** Roots module GO: at least this share of analysed buyers traced to a first funder ... */
const GO_TRACED = 0.6;
/** ... and no single non-exchange funder behind more than this share of them. */
const GO_MAX_HUB = 0.3;

async function credits(): Promise<number | null> {
  try {
    return (await getAccount()).data.credits_remaining;
  } catch (err) {
    console.warn(`  (account read failed: ${describeError(err)})`);
    return null;
  }
}

function coverage(scan: Scan, debug: ScanDebug): { rows: string[][]; go: string } {
  const b = debug.buyers;
  const buyers = scan.findings.buyers;
  const tracedShare = b.analysed > 0 ? b.traced / b.analysed : 0;
  // The debug record keeps the hub's full address and raw Nansen label (the published label drops smart-money labels).
  const hub = b.walletHub;
  const walletHub = {
    share: b.analysed > 0 ? hub.wallets / b.analysed : 0,
    label: hub.address ? `${hub.address}${hub.label ? ` (${hub.label})` : " (no Nansen label)"}` : "n/a",
  };
  const f = debug.flows;
  const w = debug.walls;
  const s = scan.findings.smart;
  const rows: string[][] = [
    ["context", "hourly candles / big buys", `${scan.price.length} / ${scan.bigBuys.length}`, `price ${fmtNum(scan.meta.priceNow, 6)} · mcap ${fmtNum(scan.meta.marketCapUsd)}`],
    ["01 buyers", "eligible / analysed", `${b.eligible} / ${b.analysed}`, `mode ${b.mode}`],
    ["01 buyers", "first-funder traced", b.analysed ? fmtPct(tracedShare) : "n/a", `${b.traced} traced · ${b.untraced} data:[] · ${b.failed} failed`],
    ["01 buyers", "biggest wallet hub", fmtPct(walletHub.share), walletHub.label],
    ["01 buyers", "biggest hub (any kind)", fmtPct(b.maxHubShare), b.maxHubLabel ?? "n/a"],
    ["01 buyers", "sources / demand", `${buyers.sources} / ${buyers.demand}`, buyers.note ?? ""],
  ];
  for (const label of ["smart_money", "whale", "public_figure", "exchange"] as const) {
    const x = f[label];
    rows.push(["02 flow", `tgm/flows ${label}`, x.ok ? `${x.buckets} buckets` : "failed", `${x.movingHours} hours with a balance change`]);
  }
  rows.push(["02 flow", "flow-intelligence 7d", f.intel ? "ok" : "missing", `informed ${fmtNum(scan.findings.flow.informedNetUsd)} USD · verdict ${scan.findings.flow.verdict}`]);
  rows.push([
    "03 walls",
    `pnl cost coverage (${w.method})`,
    w.requested ? fmtPct(w.withCost / w.requested) : "n/a",
    `${w.withCost} with cost / ${w.requested} asked (${w.recentBuyerHolders} this week's buyers) · ${w.allocations} allocations · ` +
      `${w.zeroCostKept} zero-cost kept as no_cost · ${w.noHistory} no history · ${w.failures} failed · ` +
      `analysed supply ${fmtPct(scan.findings.walls.analyzedSupplyShare)}`,
  ]);
  rows.push([
    "03 walls",
    "allocations left out",
    fmtPct(w.allocatedShare),
    `of total supply · ${w.skipped} skipped before pnl (${w.spared} spared as DEX buyers${w.monthForSkips ? ", 30d list read" : ""}), ` +
      `${w.allocations} found by pnl · pnl covers ${fmtPct(w.pnlCoverage)} of analysed tokens` +
      (w.proxyBuyers ? ` · ${w.proxyBuyers} 30d buyers blended in (hybrid)` : ""),
  ]);
  rows.push(["04 smart", "smart-money wallets (30d)", String(s.wallets), `avg entry ${fmtNum(s.avgEntry, 6)} · ${s.state} · ${s.stance}`]);

  let go: string;
  if (b.mode !== "traced") go = `roots: NO-GO (${b.mode === "non_evm" ? "not traceable on this chain" : "no funder data"})`;
  else if (tracedShare >= GO_TRACED && walletHub.share <= GO_MAX_HUB) {
    go = `roots: GO (traced ${fmtPct(tracedShare)} >= ${fmtPct(GO_TRACED, 0)}, biggest wallet hub ${fmtPct(walletHub.share)} <= ${fmtPct(GO_MAX_HUB, 0)})`;
  } else {
    const why: string[] = [];
    if (tracedShare < GO_TRACED) why.push(`traced ${fmtPct(tracedShare)} < ${fmtPct(GO_TRACED, 0)}`);
    if (walletHub.share > GO_MAX_HUB) why.push(`one wallet funds ${fmtPct(walletHub.share)} of buyers (${walletHub.label}); check it on Nansen: a solver / service or real concentration?`);
    go = `roots: NO-GO (${why.join("; ")})`;
  }
  return { rows, go };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const refresh = flags.has("refresh");
  if ((process.env.NANSEN_CACHE ?? "").toLowerCase() !== "off") process.env.NANSEN_CACHE = refresh ? "refresh" : "snapshot";
  const maxBuyers = intFlag(flags, "buyers", 20);
  const maxHolders = intFlag(flags, "holders", 20);
  const targets = positional.map(parseTarget);
  if (!targets.length || targets.length > 2) {
    console.error("Usage: npm run smoke -- base:0xTOKEN [eth:0xTOKEN] [--buyers=20] [--holders=20] [--yes] [--force] [--refresh]");
    process.exit(1);
  }
  if (!hasNansenKey()) {
    console.error("NANSEN_API_KEY is not set.");
    process.exit(1);
  }

  let estimate = 0;
  for (const t of targets) {
    const e = estimateBreakdown("deep", t.chain, { maxBuyers, maxHolders });
    estimate += e.total;
    console.log(
      `${t.chain}:${t.address}: up to ${e.total} credits (context ${e.context} · buyers ${e.buyers} · flow ${e.flow} · walls ${e.walls} · smart ${e.smart})`,
    );
  }
  console.log(`Estimated spend: up to ${estimate} credits (cache hits are free).`);
  if (estimate > MAX_WITHOUT_FORCE && !flags.has("force")) {
    console.error(`Refusing: estimate ${estimate} > ${MAX_WITHOUT_FORCE}. Lower --buyers/--holders, scan one token, or pass --force.`);
    process.exit(1);
  }
  if (!flags.has("yes") && !(await confirm(`Spend up to ${estimate} Nansen credits?`))) {
    console.log("Nothing spent.");
    process.exit(0);
  }

  const before = await credits();
  console.log(`Account credits before: ${before ?? "unknown"}`);
  let failures = 0;
  let spent = 0;

  for (const t of targets) {
    console.log(`\n▶ ${t.chain}:${t.address} · deep · buyers ${maxBuyers} · holders ${maxHolders}`);
    try {
      const { scan, debug } = await runScanDetailed(t.chain, t.address, {
        tier: "deep",
        maxBuyers,
        maxHolders,
        onEvent: (e) => {
          if (e.type === "stage") console.log(`  · ${e.message}`);
          else if (e.type === "meta") console.log(`  · ${e.meta.symbol} (${e.meta.name}) @ ${fmtNum(e.meta.priceNow, 6)} · ${e.price.length} hourly closes`);
          else if (e.type === "call" && e.call.status >= 400) console.log(`    ✗ ${e.call.endpoint} ${e.call.status}`);
          else if (e.type === "error") console.error(`  ✗ ${e.message}`);
        },
      });
      spent += scan.totals.credits;
      await saveRecordedScan(scan).catch(() => undefined);
      const { rows, go } = coverage(scan, debug);
      console.log("");
      console.log(table(["finding", "metric", "value", "detail"], rows));
      console.log(`\n  DIAGNOSIS: ${scan.diagnosis.sentence} (rule ${scan.diagnosis.rule}, confidence ${scan.diagnosis.confidence})`);
      console.log(`  ${go}`);
      console.log(
        `  ${scan.totals.calls} calls · ${scan.totals.networkCalls} network · ${scan.totals.cacheHits} cached · ${scan.totals.credits} credits · ${(scan.totals.durationMs / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      failures++;
      if (!(err instanceof ScanError)) console.error(`  ✗ ${describeError(err)}`);
    }
  }

  await flushLedger();
  const after = await credits();
  console.log(`\nAccount credits after: ${after ?? "unknown"}${before !== null && after !== null ? ` (−${before - after})` : ""} · ledger says ${spent} credits this run`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(describeError(err));
  await flushLedger();
  process.exit(1);
});
