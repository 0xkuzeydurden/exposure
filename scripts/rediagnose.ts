// Re-reads every recorded x-ray in public/scans/ with the current rules and thresholds, offline:
//   npx tsx scripts/rediagnose.ts           rewrite the scans and public/scans/index.json
//   npx tsx scripts/rediagnose.ts --check   print what would change, write nothing (exit 1 if anything would)
//   npx tsx scripts/rediagnose.ts --include-cache
//                                           also re-read the local recordings in .cache/scans/ (not shipped;
//                                           /x/<chain>/<token> prefers them over the gallery file when as new)
//
// Pure: no network, no API key, no credits. For each scan it re-derives the per-finding classes from
// the numbers the recording already holds (demand, flow verdict, ceiling, smart-money state and stance,
// with the classifiers of lib/xray/diagnosis.ts that read lib/xray/thresholds.ts), then the diagnosis
// with diagnose(). Nothing else in a recording changes; each file keeps its own formatting.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ceilingOf, demandOf, diagnose, flowVerdictOf, isAvailable, smartStanceOf, smartStateOf } from "../lib/xray/diagnosis";
import type { GalleryEntry, Scan } from "../lib/xray/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scansDir = join(root, "public", "scans");
const indexPath = join(scansDir, "index.json");
const check = process.argv.includes("--check");
const includeCache = process.argv.includes("--include-cache");
const cacheDir = join(root, ".cache", "scans");

/** Re-serialises like the file was written: pretty (2 spaces) or compact, trailing newline or not. */
function serialise(value: unknown, like: string): string {
  const pretty = /^\s*[[{]\s*\n/.test(like);
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return like.endsWith("\n") ? `${body}\n` : body;
}

function isScan(v: unknown): v is Scan {
  const s = v as Partial<Scan> | null;
  return !!s && typeof s === "object" && !!s.meta && !!s.findings && !!s.findings.buyers && !!s.findings.flow && !!s.findings.walls && !!s.findings.smart;
}

/** The finding classes recomputed from the recording's own numbers; returns the fields that changed. */
function reclassify(scan: Scan): string[] {
  const { buyers, flow, walls, smart } = scan.findings;
  const changed: string[] = [];
  const set = <K extends string>(label: string, obj: Record<K, unknown>, key: K, next: unknown) => {
    if (obj[key] !== next) {
      changed.push(`${label} ${String(obj[key])} -> ${String(next)}`);
      obj[key] = next;
    }
  };
  if (isAvailable(buyers)) set("demand", buyers as unknown as Record<"demand", unknown>, "demand", demandOf(buyers));
  if (isAvailable(flow)) set("flow", flow as unknown as Record<"verdict", unknown>, "verdict", flowVerdictOf(flow, scan.meta));
  if (isAvailable(walls)) set("ceiling", walls as unknown as Record<"ceiling", unknown>, "ceiling", ceilingOf(walls, scan.meta.circulatingSupply));
  if (isAvailable(smart)) {
    set("smart state", smart as unknown as Record<"state", unknown>, "state", smartStateOf(smart.avgEntry, scan.meta.priceNow));
    set("smart stance", smart as unknown as Record<"stance", unknown>, "stance", smartStanceOf(smart.boughtUsd, smart.soldUsd));
  }
  return changed;
}

const files = readdirSync(scansDir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .sort()
  .map((f) => ({ dir: scansDir, file: f }));
if (includeCache && existsSync(cacheDir)) {
  for (const f of readdirSync(cacheDir).filter((x) => x.endsWith(".json")).sort()) files.push({ dir: cacheDir, file: f });
}

const byFile = new Map<string, Scan>();
let changedFiles = 0;
for (const { dir, file: name } of files) {
  const file = dir === scansDir ? name : `.cache/scans/${name}`;
  const path = join(dir, name);
  const raw = readFileSync(path, "utf8");
  const scan: unknown = JSON.parse(raw);
  if (!isScan(scan)) {
    console.log(`skip  ${file} (not a scan)`);
    continue;
  }
  const before = JSON.stringify(scan.diagnosis);
  const classes = reclassify(scan);
  const next = diagnose(scan.findings, scan.meta);
  const diagChanged = JSON.stringify(next) !== before;
  scan.diagnosis = next;
  if (dir === scansDir) byFile.set(name, scan);
  const tag = `${scan.meta.symbol} (${scan.meta.chain})`;
  if (!classes.length && !diagChanged) {
    console.log(`same  ${file}  ${tag}: rule ${next.rule} ${next.code}, confidence ${next.confidence}`);
    continue;
  }
  changedFiles++;
  const old = JSON.parse(before) as Scan["diagnosis"];
  console.log(`${check ? "would" : "wrote"} ${file}  ${tag}`);
  for (const c of classes) console.log(`        ${c}`);
  if (diagChanged) {
    console.log(`        diagnosis rule ${old.rule} ${old.code} (${old.confidence}) -> rule ${next.rule} ${next.code} (${next.confidence})`);
    console.log(`        "${next.sentence}" lights ${JSON.stringify(next.lights)} footnotes ${next.footnotes.join(",")}`);
  }
  if (!check) writeFileSync(path, serialise(scan, raw));
}

// The gallery index carries each patient's sentence and code.
const indexRaw = readFileSync(indexPath, "utf8");
const index = JSON.parse(indexRaw) as GalleryEntry[];
let indexChanged = false;
for (const entry of index) {
  const scan = byFile.get(entry.file);
  if (!scan) {
    console.log(`index ${entry.file}: no such scan, left as is`);
    continue;
  }
  if (entry.diagnosis !== scan.diagnosis.sentence || entry.code !== scan.diagnosis.code) {
    console.log(`index ${entry.symbol}: "${entry.diagnosis}" -> "${scan.diagnosis.sentence}"`);
    entry.diagnosis = scan.diagnosis.sentence;
    entry.code = scan.diagnosis.code;
    indexChanged = true;
  }
}
if (indexChanged && !check) writeFileSync(indexPath, serialise(index, indexRaw));

console.log(
  `${changedFiles} of ${files.length} scans ${check ? "would change" : "rewritten"}; index.json ${indexChanged ? (check ? "would change" : "updated") : "unchanged"}.`,
);
if (check && (changedFiles || indexChanged)) process.exitCode = 1;
