// Writes the deterministic synthetic EXPOSURE scan used for keyless UI work (offline, 0 credits):
//   npx tsx scripts/make-scan-fixture.ts        -> public/scans/_synthetic.json
//   npx tsx scripts/make-scan-fixture.ts 11     -> same, with another seed
// Also creates public/scans/index.json as [] when it does not exist yet.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confidenceLine, evidenceLine, footnoteMarks, reportLines } from "../lib/xray/copy";
import { makeSyntheticScan, makeSyntheticWalletCheck } from "../lib/xray/fixtures";
import { replayDurationMs } from "../lib/xray/replay";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scansDir = join(root, "public", "scans");
mkdirSync(scansDir, { recursive: true });

const seedArg = process.argv[2];
const seed = seedArg != null && Number.isFinite(Number(seedArg)) ? Number(seedArg) : undefined;
const scan = makeSyntheticScan(seed);

const out = join(scansDir, "_synthetic.json");
writeFileSync(out, JSON.stringify(scan, null, 2) + "\n");

const index = join(scansDir, "index.json");
if (!existsSync(index)) writeFileSync(index, "[]\n");

const { meta, findings, diagnosis, totals, price } = scan;
const peak = price.reduce((a, b) => (b.c > a.c ? b : a));
const low = price.reduce((a, b) => (b.c < a.c ? b : a));
console.log(`wrote ${out}`);
console.log(`  ${meta.symbol} · ${meta.chain} · scan ${meta.scanNo} · ${meta.scannedAt}`);
console.log(`  price ${price[0].c} -> ${meta.priceNow} (${meta.priceChange7d}) · peak ${peak.c} · low ${low.c}`);
console.log(`  supply ${meta.circulatingSupply} · mcap ${meta.marketCapUsd} · liquidity ${meta.liquidityUsd}`);
console.log(`  ${evidenceLine(totals)} · ${totals.networkCalls} network · ${totals.cacheHits} cached · ${(totals.durationMs / 1000).toFixed(1)}s`);
console.log(`  replay at default speed: ${(replayDurationMs(scan) / 1000).toFixed(1)}s`);
console.log(`  demand ${findings.buyers.demand} · flow ${findings.flow.verdict} · ceiling ${findings.walls.ceiling} · smart ${findings.smart.state}/${findings.smart.stance}`);
console.log(`  underwater ${findings.walls.underwaterShare} · lead: ${findings.flow.lead?.text ?? "none"}`);
for (const line of reportLines(findings, makeSyntheticWalletCheck(scan))) {
  console.log(`  ${line.n}. ${line.title}: ${line.text}   [${line.tag}]`);
}
console.log(`  IMPRESSION: ${diagnosis.sentence} ${footnoteMarks(diagnosis)} · ${confidenceLine(diagnosis)} · lights ${JSON.stringify(diagnosis.lights)}`);
