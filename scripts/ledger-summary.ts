// Summarises .ledger/calls.ndjson as a README-ready markdown table.
// Usage: npm run ledger [-- --since=2026-09-25]
import { readLedger } from "../lib/nansen/ledger";
import { ledgerFile } from "../lib/nansen/paths";

/** Free lookups that do not count towards the "1,000 API calls" requirement. */
const NOT_COUNTED = new Set(["search/general", "account"]);

interface Row {
  endpoint: string;
  ok: number;
  errors: number;
  cacheHits: number;
  credits: number;
}

async function main() {
  const sinceArg = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
  const since = sinceArg ? Date.parse(sinceArg) : NaN;
  const entries = (await readLedger()).filter((e) => !Number.isFinite(since) || Date.parse(e.ts) >= since);
  if (!entries.length) {
    console.log(`No ledger entries in ${ledgerFile()}${sinceArg ? ` since ${sinceArg}` : ""}.`);
    return;
  }

  const rows = new Map<string, Row>();
  for (const e of entries) {
    const r = rows.get(e.endpoint) ?? { endpoint: e.endpoint, ok: 0, errors: 0, cacheHits: 0, credits: 0 };
    if (e.cached) r.cacheHits++;
    else if (e.status >= 200 && e.status < 300) r.ok++;
    else r.errors++;
    r.credits += Number(e.credits) || 0;
    rows.set(e.endpoint, r);
  }

  const sorted = [...rows.values()].sort((a, b) => b.ok - a.ok || a.endpoint.localeCompare(b.endpoint));
  const total = sorted.reduce(
    (t, r) => ({ ok: t.ok + r.ok, errors: t.errors + r.errors, cacheHits: t.cacheHits + r.cacheHits, credits: t.credits + r.credits }),
    { ok: 0, errors: 0, cacheHits: 0, credits: 0 },
  );
  const counted = sorted.filter((r) => !NOT_COUNTED.has(r.endpoint)).reduce((s, r) => s + r.ok, 0);
  const first = entries[0].ts.slice(0, 16).replace("T", " ");
  const last = entries[entries.length - 1].ts.slice(0, 16).replace("T", " ");

  const lines = [
    `| Endpoint | Network calls (2xx) | Errors / retries | Cache hits | Credits |`,
    `|---|---:|---:|---:|---:|`,
    ...sorted.map((r) => `| \`${r.endpoint}\` | ${r.ok} | ${r.errors} | ${r.cacheHits} | ${r.credits} |`),
    `| **Total** | **${total.ok}** | **${total.errors}** | **${total.cacheHits}** | **${total.credits}** |`,
    "",
    `Successful Nansen API calls (excluding free \`search/general\` and \`account\`): **${counted}** · ` +
      `ledger window ${first} → ${last} UTC.`,
  ];
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
