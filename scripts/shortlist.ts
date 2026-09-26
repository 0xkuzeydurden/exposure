// Candidate tokens for the gallery via token-screener (1 credit per chain).
// Usage: npm run shortlist [-- --chains=base,ethereum,solana] [--per-chain=7] [--holders]
//   --holders also calls token-information for each printed token (+1 credit each) to show holder counts.
import { getTokenInformation, tokenScreener } from "../lib/nansen/api";
import { hasNansenKey } from "../lib/nansen/client";
import { describeError } from "../lib/nansen/errors";
import { flushLedger, ledgerCounters } from "../lib/nansen/ledger";
import type { TokenScreenerRow } from "../lib/nansen/schemas";
import { fmtNum, table } from "../lib/pipeline/cli";

const MIN_LIQUIDITY = 300_000;
const MAX_AGE_DAYS = 365;

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  if (!hasNansenKey()) {
    console.error("NANSEN_API_KEY is not set. Add it to .env.local and re-run.");
    process.exit(1);
  }
  const chains = (flag("chains") ?? "base,ethereum,solana").split(",").map((c) => c.trim()).filter(Boolean);
  const perChain = Math.max(1, Number.parseInt(flag("per-chain") ?? "7", 10) || 7);
  const withHolders = process.argv.includes("--holders");

  const picked: (TokenScreenerRow & { holders?: number | null })[] = [];
  for (const chain of chains) {
    try {
      const res = await tokenScreener({
        chains: [chain],
        timeframe: "24h",
        perPage: 50,
        filters: {
          liquidity: { min: MIN_LIQUIDITY },
          token_age_days: { max: MAX_AGE_DAYS },
          include_stablecoins: false,
          include_native_tokens: false,
        },
        orderBy: [{ field: "volume", direction: "DESC" }],
      });
      const rows = res.data.data.filter(
        (r) => r.token_address && (r.liquidity ?? 0) >= MIN_LIQUIDITY && (r.token_age_days ?? 0) <= MAX_AGE_DAYS,
      );
      console.log(`${chain}: ${res.data.data.length} rows from token-screener, ${rows.length} pass filters`);
      picked.push(...rows.slice(0, perChain).map((r) => ({ ...r, chain: r.chain ?? chain })));
    } catch (err) {
      console.error(`${chain}: ${describeError(err)}`);
    }
  }

  if (withHolders) {
    await Promise.all(
      picked.map(async (r) => {
        try {
          const info = await getTokenInformation(r.chain!, r.token_address!, {
            cacheKey: { chain: r.chain, token: r.token_address, timeframe: "1d" },
          });
          r.holders = info.data.data.spot_metrics.total_holders;
        } catch {
          r.holders = null;
        }
      }),
    );
    picked.sort((a, b) => (b.holders ?? 0) - (a.holders ?? 0));
  } else {
    picked.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  }

  console.log(
    "\n" +
      table(
        ["chain", "symbol", "address", "age_d", "liquidity", "mcap", "vol_24h", "traders", "holders"],
        picked.map((r) => [
          r.chain ?? "",
          r.token_symbol ?? "",
          r.token_address ?? "",
          fmtNum(r.token_age_days, 0),
          fmtNum(r.liquidity),
          fmtNum(r.market_cap_usd),
          fmtNum(r.volume),
          fmtNum(r.nof_traders, 0),
          withHolders ? fmtNum(r.holders ?? null, 0) : "(--holders)",
        ]),
      ),
  );
  const c = ledgerCounters();
  console.log(`\n${c.networkCalls} network calls · ${c.cacheHits} cache hits · ${c.credits} credits`);
  console.log(`Next: npm run smoke -- ${picked.slice(0, 2).map((r) => `${r.chain}:${r.token_address}`).join(" ")}`);
  await flushLedger();
}

main().catch(async (err) => {
  console.error(describeError(err));
  await flushLedger();
  process.exit(1);
});
