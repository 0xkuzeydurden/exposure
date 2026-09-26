// Gallery candidates from Nansen's token screener (1 credit per call).
//
// Usage: npm run trending -- [--sort=volume|buyers] [--chains=base,ethereum,bnb,solana] [--per-chain]
//                            [--limit=15] [--timeframe=24h]
// Default: ONE call over base, ethereum, bnb and solana (the endpoint takes at most 5 chains), 24h,
// liquidity > $250k, market cap $5M–$2B, token age 7–365 days, stablecoins excluded, sorted by
// 24h volume. --per-chain makes one call per chain instead (so no chain crowds out the others).
// Request body verified against TokenScreenerRequest / TokenScreenerFilters in openapi.json.
import { tokenScreener } from "../lib/nansen/api";
import { isSupportedChain } from "../lib/nansen/chains";
import { hasNansenKey } from "../lib/nansen/client";
import { describeError } from "../lib/nansen/errors";
import { flushLedger } from "../lib/nansen/ledger";
import type { TokenScreenerRow } from "../lib/nansen/schemas";
import { fmtNum, table, truncate } from "../lib/pipeline/cli";
import { intFlag, parseArgs } from "../lib/xray/pipeline/cli";
import { SCREENER_TIMEFRAMES, TRENDING_CHAINS, trendingQuery, type ScreenerTimeframe } from "../lib/xray/pipeline/trending";

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const sortFlag = flags.get("sort") ?? "volume";
  const sortField =
    sortFlag === "buyers" || sortFlag === "nof_buyers" ? "nof_buyers" : sortFlag === "traders" ? "nof_traders" : sortFlag === "netflow" ? "netflow" : "volume";
  const traderFlag = flags.get("trader");
  const trader = traderFlag === "sm" || traderFlag === "whale" || traderFlag === "public_figure" || traderFlag === "all" ? traderFlag : undefined;
  const chains = (flags.get("chains") ?? TRENDING_CHAINS.join(","))
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const limit = intFlag(flags, "limit", 15);
  const tf = (flags.get("timeframe") ?? "24h") as ScreenerTimeframe;
  if (!SCREENER_TIMEFRAMES.includes(tf)) throw new Error(`--timeframe must be one of ${SCREENER_TIMEFRAMES.join(", ")}`);
  const perChain = flags.has("per-chain");
  if (!perChain && chains.length > 5) throw new Error("token-screener takes at most 5 chains per call (use --per-chain)");
  if (!hasNansenKey()) {
    console.error("NANSEN_API_KEY is not set.");
    process.exit(1);
  }

  const groups = perChain ? chains.map((c) => [c]) : [chains];
  console.log(`token-screener · ${groups.length} call${groups.length === 1 ? "" : "s"} (${groups.length} credit${groups.length === 1 ? "" : "s"}) · ${tf} · sort ${sortField}`);
  const rows: TokenScreenerRow[] = [];
  for (const g of groups) {
    try {
      const res = await tokenScreener(
        trendingQuery({ chains: g, timeframe: tf, sort: sortField, trader, perPage: perChain ? Math.max(limit, 20) : Math.max(limit * 3, 50) }),
      );
      console.log(`  ${g.join(",")}: ${res.data.data.length} rows · ${res.credits} credits${res.cached ? " (cached)" : ""}`);
      rows.push(...res.data.data);
    } catch (err) {
      console.error(`  ✗ ${g.join(",")}: ${describeError(err)}`);
    }
  }

  const key = (r: TokenScreenerRow) => (sortField === "nof_buyers" ? (r.nof_buyers ?? 0) : (r.volume ?? 0));
  const top = rows
    .filter((r) => r.chain && r.token_address)
    .sort((a, b) => key(b) - key(a))
    .slice(0, perChain ? limit * groups.length : limit);

  console.log("");
  console.log(
    table(
      ["#", "chain", "symbol", "address", "age d", "liq", "mcap", "vol 24h", "buyers", "price Δ", "pipeline"],
      top.map((r, i) => [
        String(i + 1),
        r.chain ?? "",
        truncate(r.token_symbol, 12),
        r.token_address ?? "",
        r.token_age_days !== null ? String(Math.round(r.token_age_days)) : "n/a",
        fmtNum(r.liquidity),
        fmtNum(r.market_cap_usd),
        fmtNum(r.volume),
        r.nof_buyers !== null ? String(r.nof_buyers) : "n/a",
        // Raw value: the spec does not say whether it is a fraction or a percentage.
        r.price_change !== null ? fmtNum(r.price_change) : "n/a",
        r.chain && isSupportedChain(r.chain) ? "yes" : "no",
      ]),
    ),
  );
  const picks = top.filter((r) => r.chain && isSupportedChain(r.chain)).slice(0, 7);
  if (picks.length) {
    console.log(`\nWarm the gallery (asks before spending):\n  npm run warm -- ${picks.map((r) => `${r.chain}:${r.token_address}`).join(" ")}`);
  }
  await flushLedger();
}

main().catch(async (err) => {
  console.error(describeError(err));
  await flushLedger();
  process.exit(1);
});
