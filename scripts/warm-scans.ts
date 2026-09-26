// Records gallery ("waiting room") scans: a deep scan per token → public/scans/<chain>-<token>.json
// and public/scans/index.json (also .cache/scans, so /api/scan replays them for 0 credits).
//
// Usage: npm run warm -- base:0xTOKEN eth:0xTOKEN sol:MINT … [--buyers=60] [--holders=40]
//                              [--tier=deep|quick] [--hints=cache|<file.json>] [--yes] [--refresh]
// Responses are cached with NANSEN_CACHE=snapshot semantics: a token warmed before (or probed by
// xray-smoke) is re-derived from disk for 0 credits; --refresh fetches everything again. The total
// estimate (an upper bound) is confirmed before anything is spent unless --yes is given.
//
// --hints fills symbol / market cap / liquidity / deployment date where tgm/token-information comes
// back empty (young tokens), from token-screener rows already fetched (no extra call):
//   --hints=cache          every token-screener response in .cache/nansen (e.g. from `npm run trending`)
//   --hints=<file.json>    a token-screener cache entry or response, an array of screener rows, or a map
//                          {"bnb:0xTOKEN": {"symbol": "DGAI", "marketCapUsd": 154000000, "liquidityUsd": 1600000,
//                          "priceUsd": 1.03, "circulatingSupply": 150000000, "totalSupply": 1000000000,
//                          "name": "...", "deployedAt": "..."}}
// When the hints do not cover what token-information lacks, the scan looks the token up in
// token-screener by address itself (1 credit, cached 60 min; counted in the estimate below).
import { getAccount } from "../lib/nansen/api";
import { hasNansenKey } from "../lib/nansen/client";
import { describeError } from "../lib/nansen/errors";
import { flushLedger } from "../lib/nansen/ledger";
import { nansenCacheDir } from "../lib/nansen/paths";
import { fmtNum } from "../lib/pipeline/cli";
import { estimateCredits } from "../lib/xray/budget";
import { DEFAULT_MAX_BUYERS } from "../lib/xray/pipeline/buyers";
import { confirm, intFlag, parseArgs, parseTarget } from "../lib/xray/pipeline/cli";
import { hintKey, loadHintsFile, loadScreenerCacheHints, type ScanHints } from "../lib/xray/pipeline/hints";
import { runScan, ScanError } from "../lib/xray/pipeline/run";
import { DEFAULT_MAX_HOLDERS } from "../lib/xray/pipeline/walls";
import { saveRecordedScan, savePublicScan } from "../lib/xray/store";
import type { Tier } from "../lib/xray/types";

async function credits(): Promise<number | null> {
  try {
    return (await getAccount()).data.credits_remaining;
  } catch {
    return null;
  }
}

/** --hints=cache | <file>: token facts by "chain:address" (reads local files only). */
async function loadHints(flag: string | undefined): Promise<Map<string, ScanHints>> {
  if (!flag) return new Map();
  if (flag === "cache" || flag === "true") return loadScreenerCacheHints(nansenCacheDir());
  return loadHintsFile(flag);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const refresh = flags.has("refresh");
  if ((process.env.NANSEN_CACHE ?? "").toLowerCase() !== "off") process.env.NANSEN_CACHE = refresh ? "refresh" : "snapshot";
  const tier: Tier = flags.get("tier") === "quick" ? "quick" : "deep";
  const maxBuyers = intFlag(flags, "buyers", DEFAULT_MAX_BUYERS);
  const maxHolders = intFlag(flags, "holders", DEFAULT_MAX_HOLDERS);
  const targets = positional.map(parseTarget);
  if (!targets.length) {
    console.error("Usage: npm run warm -- base:0xTOKEN [eth:0xTOKEN …] [--buyers=60] [--holders=40] [--tier=deep] [--hints=cache|<file>] [--yes] [--refresh]");
    process.exit(1);
  }
  if (!hasNansenKey()) console.warn("NANSEN_API_KEY is not set: only fully cached tokens can be re-derived.");
  const hints = await loadHints(flags.get("hints"));
  if (flags.has("hints")) {
    const found = targets.filter((t) => hints.has(hintKey(t.chain, t.address))).length;
    console.log(`Hints: ${hints.size} tokens loaded, ${found} of ${targets.length} targets covered.`);
  }

  let total = 0;
  for (const t of targets) {
    const e = estimateCredits(tier, t.chain, { maxBuyers, maxHolders });
    total += e;
    console.log(`  ${t.chain}:${t.address} · ${tier} · up to ${e} credits`);
  }
  console.log(
    `Estimate: up to ${total} credits for ${targets.length} token${targets.length === 1 ? "" : "s"} (buyers ${maxBuyers}, holders ${maxHolders}; ` +
      `${refresh ? "--refresh: nothing comes from the cache" : "cached responses are free"}).`,
  );
  if (!flags.has("yes") && !(await confirm(`Spend up to ${total} Nansen credits?`))) {
    console.log("Nothing spent.");
    process.exit(0);
  }

  const before = hasNansenKey() ? await credits() : null;
  if (before !== null) console.log(`Account credits before: ${before}`);
  let failures = 0;
  const sum = { calls: 0, networkCalls: 0, cacheHits: 0, credits: 0 };

  for (const t of targets) {
    console.log(`\n▶ ${t.chain}:${t.address}`);
    try {
      const scan = await runScan(t.chain, t.address, {
        tier,
        maxBuyers,
        maxHolders,
        hints: hints.get(hintKey(t.chain, t.address)) ?? null,
        virtualClock: true,
        onEvent: (e) => {
          if (e.type === "stage") console.log(`  · ${e.message}`);
          else if (e.type === "meta") console.log(`  · ${e.meta.symbol} @ ${fmtNum(e.meta.priceNow, 6)} · ${e.price.length} hourly closes · ${e.bigBuys.length} big buys`);
          else if (e.type === "error") console.error(`  ✗ ${e.message}`);
        },
      });
      const { file } = await savePublicScan(scan);
      await saveRecordedScan(scan).catch(() => undefined);
      const { totals, findings, diagnosis } = scan;
      // With the virtual clock a cache hit carries its original cost; only network calls were paid now.
      const paidNow = scan.calls.filter((c) => !c.cached).reduce((s, c) => s + c.credits, 0);
      sum.calls += totals.calls;
      sum.networkCalls += totals.networkCalls;
      sum.cacheHits += totals.cacheHits;
      sum.credits += paidNow;
      console.log(
        `  ✓ public/scans/${file} · "${diagnosis.sentence}" · buyers ${findings.buyers.status} · flow ${findings.flow.status} · ` +
          `walls ${findings.walls.status} · smart ${findings.smart.status}`,
      );
      console.log(
        `    ${totals.calls} calls (${totals.networkCalls} network, ${totals.cacheHits} cached) · ${paidNow} credits spent now · ` +
          `${totals.credits} credits of data in the scan · ${(totals.durationMs / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      failures++;
      if (!(err instanceof ScanError)) console.error(`  ✗ ${describeError(err)}`);
    }
  }

  await flushLedger();
  const after = hasNansenKey() ? await credits() : null;
  console.log(
    `\nTotal: ${sum.calls} calls · ${sum.networkCalls} network · ${sum.cacheHits} cached · ${sum.credits} credits spent now` +
      (before !== null && after !== null ? ` · account ${before} → ${after}` : ""),
  );
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(describeError(err));
  await flushLedger();
  process.exit(1);
});
