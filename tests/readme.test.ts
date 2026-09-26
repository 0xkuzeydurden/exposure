// The README is part of the submission: its numbers must match the code, its links must resolve, and
// nothing that ships may carry local machine metadata (home-directory paths, e-mail addresses).
// Failing here means the README (or docs/) drifted from lib/, not that the code is wrong.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_COST, EP } from "../lib/nansen/endpoints";
import { budgetLimits, estimateCredits, liveScanLimits } from "../lib/xray/budget";
import { DIAGNOSIS_RULES } from "../lib/xray/diagnosis";
import { T } from "../lib/xray/thresholds";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const README = read("README.md");
/** README without HTML comments (placeholders such as the demo GIF live in comments). */
const VISIBLE = README.replace(/<!--[\s\S]*?-->/g, "");
const EM_DASH = String.fromCodePoint(0x2014);

/** 0.35 -> "35", 0.005 -> "0.5" (no float noise). */
const pct = (x: number) => String(Number((x * 100).toPrecision(6)));

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".next", ".git", ".cache", ".ledger"].includes(entry.name)) walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Text files that ship with the repository (the same roots the no-em-dash test walks, plus docs). */
function shippedTextFiles(): string[] {
  const dirs = ["app", "components", "lib", "hooks", "scripts", "tests", "public", "docs"].flatMap((d) => walk(path.join(ROOT, d)));
  const files = ["README.md", "LICENSE", ".env.example", ".gitignore", "package.json", "package-lock.json", "AGENTS.md", "CLAUDE.md"]
    .map((f) => path.join(ROOT, f))
    .filter((f) => existsSync(f) && statSync(f).isFile());
  return [...dirs, ...files].filter((f) => !readFileSync(f).includes(0));
}

describe("README, LICENSE, .env.example and docs", () => {
  it("contain no em dash (U+2014)", () => {
    const files = ["README.md", "LICENSE", ".env.example", ...walk(path.join(ROOT, "docs")).map((f) => path.relative(ROOT, f))];
    const hits = files.filter((f) => existsSync(path.join(ROOT, f)) && read(f).includes(EM_DASH));
    expect(hits).toEqual([]);
  });

  it("ship an MIT license held by the project, not a person", () => {
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License/);
    expect(license).toContain("Copyright (c) 2026 EXPOSURE contributors");
  });

  it("resolve every relative link", () => {
    const targets = [...VISIBLE.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(https?:|#|mailto:)/.test(t));
    expect(targets.length).toBeGreaterThan(0);
    const missing = targets.filter((t) => !existsSync(path.join(ROOT, t.split("#")[0])));
    expect(missing).toEqual([]);
  });
});

describe("nothing that ships carries local machine metadata", () => {
  const HOME_PATH = /(?:\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\/|[A-Za-z]:\\Users\\|\/private\/tmp\/|\/var\/folders\/)/;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  /** SSH remotes ("git@github.com:...") look like addresses but name no one. */
  const personalEmails = (text: string) => (text.match(EMAIL) ?? []).filter((m) => !/^git@/i.test(m));

  it("has no absolute home-directory or temp paths", () => {
    const hits = shippedTextFiles().filter((f) => HOME_PATH.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("has no e-mail addresses", () => {
    const hits = shippedTextFiles().filter((f) => personalEmails(readFileSync(f, "utf8")).length > 0);
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});

describe("README numbers match the code", () => {
  const ENV = [
    "EXPOSURE_LIVE_MAX_BUYERS",
    "EXPOSURE_LIVE_MAX_HOLDERS",
    "EXPOSURE_DAILY_CREDITS",
    "EXPOSURE_DEEP_DAILY_CREDITS",
    "EXPOSURE_CREDIT_FLOOR",
    "EXPOSURE_IP_TOKENS",
    "EXPOSURE_IP_SCANS",
    "EXPOSURE_IP_WALLETS",
  ];
  beforeEach(() => {
    for (const k of ENV) vi.stubEnv(k, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("quotes the quick and live deep scan costs from lib/xray/budget.ts", () => {
    const live = liveScanLimits();
    expect(README).toContain(`**${estimateCredits("quick", "base")}** on any chain`);
    expect(estimateCredits("quick", "solana")).toBe(estimateCredits("quick", "base"));
    expect(README).toContain(`**${estimateCredits("deep", "base", live)}** on EVM`);
    expect(README).toContain(`**${estimateCredits("deep", "solana", live)}** elsewhere`);
    expect(README).toContain(`live defaults of ${live.maxBuyers} buyers + ${live.maxHolders} holders`);
    // Deep = 18 + holders (+ buyers on EVM), as the README states.
    expect(estimateCredits("deep", "solana", { maxBuyers: 0, maxHolders: 0 })).toBe(18);
    expect(README).toContain("18 + holders (+ buyers on EVM)");
  });

  it("quotes the budget defaults", () => {
    const b = budgetLimits();
    expect(README).toContain(`| \`EXPOSURE_DAILY_CREDITS\` | ${b.dailyCap} |`);
    expect(README).toContain(`| \`EXPOSURE_DEEP_DAILY_CREDITS\` | ${b.deepCap} |`);
    expect(README).toContain(`| \`EXPOSURE_CREDIT_FLOOR\` | ${b.floor} |`);
    expect(README).toContain(`| ${b.ipTokens} / ${b.ipScans} / ${b.ipWallets} |`);
  });

  it("lists every endpoint it documents with its credit cost", () => {
    const used = Object.values(EP).filter((ep) => ep !== EP.profilerDexTrades);
    for (const ep of used) expect(README, ep).toContain(`| \`${ep}\` | ${CREDIT_COST[ep]} |`);
  });

  it("prints every diagnosis sentence, in rule order", () => {
    DIAGNOSIS_RULES.forEach((r, i) => {
      expect(README, r.code).toMatch(new RegExp(`\\| ${i} \\|[^\\n]*\\| ${r.sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`));
    });
  });

  it("states the thresholds from lib/xray/thresholds.ts", () => {
    const expected = [
      `analysed supply < ${pct(T.insufficient.analysedSupply)}%`,
      `fewer than ${T.insufficient.buyers} top buyers`,
      `≥ ${pct(T.demand.concentratedSourceShare)}% of the analysed buying, or ratio < ${T.demand.concentratedRatio}`,
      `ratio ≥ ${T.demand.organicRatio} and the biggest source is < ${pct(T.demand.organicMaxSourceShare)}%`,
      `top-10 share ≥ ${pct(T.demand.top10Concentrated)}% is CONCENTRATED, < ${pct(T.demand.top10Organic)}% ORGANIC`,
      `≤ -${pct(T.flow.moveShare)}%`,
      `≥ +${pct(T.flow.moveShare)}% is ACCUMULATING`,
      `≥ ${pct(T.flow.exchangeNoteShare)}% of supply`,
      `within +${pct(T.ceiling.nearMovePct)}% of the price is ≥ ${T.ceiling.wallToLiquidity}× the pool's liquidity or ≥ ${pct(T.ceiling.wallShareOfAnalysed)}% of the analysed supply`,
      `≥ ${pct(T.ceiling.underwaterShare)}% of the analysed supply is underwater`,
      `PROFIT at ≥ ${T.smart.profitMultiple}× the average entry, LOSS below ${T.smart.lossMultiple}×`,
      `≥ +${T.smart.addingRatio} ADDING, ≤ ${T.smart.trimmingRatio} TRIMMING, ≤ ${T.smart.exitingRatio} EXITING`,
      `Fewer than ${T.smart.minWallets} wallets`,
      `HIGH ≥ ${pct(T.confidence.high)}%, MEDIUM ≥ ${pct(T.confidence.medium)}%`,
      `smart-money wallets ÷ ${T.confidence.smartFullWallets}`,
      `or ${T.confidence.flowPartial} when some labelled cohorts`,
    ];
    for (const s of expected) expect(README, s).toContain(s);
  });

  it("describes every gallery scan with its diagnosis", () => {
    const index = JSON.parse(read("public/scans/index.json")) as { chain: string; tokenAddress: string; symbol: string; diagnosis: string }[];
    expect(VISIBLE).toContain(`holds ${index.length} real deep scans`);
    const lines = VISIBLE.split("\n");
    for (const e of index) {
      const row = lines.find((l) => l.includes(`\`/x/${e.chain}/${e.tokenAddress}\``));
      expect(row, e.symbol).toBeDefined();
      expect(row, e.symbol).toContain(e.symbol);
      expect(row, e.symbol).toContain(e.diagnosis);
    }
  });

  it("documents every EXPOSURE_* and NEXT_PUBLIC_* setting the code reads in .env.example", () => {
    const env = read(".env.example");
    const src = ["lib", "app", "components", "hooks"].flatMap((d) => walk(path.join(ROOT, d))).map((f) => readFileSync(f, "utf8")).join("\n");
    const names = [...new Set(src.match(/\b(?:EXPOSURE|NEXT_PUBLIC)_[A-Z_]+/g) ?? [])];
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !env.includes(n))).toEqual([]);
  });
});
