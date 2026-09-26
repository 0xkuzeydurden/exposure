// Disk persistence for EXPOSURE scans (server / scripts only):
//   .cache/scan-counter.json                        monotonic "SCAN 0412" counter
//   .cache/scans/<chain>-<token>-<tier>.json        last live scan per token and tier (served for 0 credits)
//   public/scans/<chain>-<token>.json               gallery ("waiting room") scans, written by warm-scans
//   public/scans/index.json                         GalleryEntry[]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEvmChain } from "../nansen/chains";
import { projectRoot } from "../nansen/paths";
import type { GalleryEntry, PricePoint, Scan, Tier } from "./types";

export function scansCacheDir(): string {
  return path.join(projectRoot(), ".cache", "scans");
}

export function publicScansDir(): string {
  return path.join(projectRoot(), "public", "scans");
}

function counterFile(): string {
  return path.join(projectRoot(), ".cache", "scan-counter.json");
}

/** `<chain>-<address>` with the address lowercased on EVM chains. Safe as a file name. */
export function scanId(chain: string, tokenAddress: string): string {
  const c = chain.trim().toLowerCase();
  const t = tokenAddress.trim();
  const a = isEvmChain(c) ? t.toLowerCase() : t;
  return `${c}-${a.replace(/[^A-Za-z0-9_:.-]/g, "_")}`;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ scan counter

const COUNTER_KEY = Symbol.for("exposure.scan-counter");

interface CounterState {
  chain: Promise<unknown>;
}

function counterState(): CounterState {
  const g = globalThis as unknown as Record<symbol, CounterState | undefined>;
  let s = g[COUNTER_KEY];
  if (!s) {
    s = { chain: Promise.resolve() };
    g[COUNTER_KEY] = s;
  }
  return s;
}

/** Next scan number (1, 2, 3 …), persisted. Calls are serialised within the process; never throws. */
export function nextScanNo(): Promise<number> {
  const s = counterState();
  const next = s.chain.then(async () => {
    const raw = (await readJson(counterFile())) as { n?: unknown } | null;
    const cur = raw && typeof raw.n === "number" && Number.isFinite(raw.n) ? Math.floor(raw.n) : 0;
    const n = cur + 1;
    try {
      await atomicWrite(counterFile(), JSON.stringify({ n }) + "\n");
    } catch (err) {
      console.warn(`[store] scan counter not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    return n;
  });
  s.chain = next.catch(() => undefined);
  return next;
}

// ------------------------------------------------------------------ recorded scans

export function isScan(x: unknown): x is Scan {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<Scan>;
  return s.version === 1 && !!s.meta && typeof s.meta.chain === "string" && !!s.findings && !!s.diagnosis && Array.isArray(s.price);
}

export function recordedScanFile(chain: string, tokenAddress: string, tier: Tier): string {
  return path.join(scansCacheDir(), `${scanId(chain, tokenAddress)}-${tier}.json`);
}

export async function saveRecordedScan(scan: Scan): Promise<string> {
  const file = recordedScanFile(scan.meta.chain, scan.meta.tokenAddress, scan.tier);
  await atomicWrite(file, JSON.stringify(scan));
  return file;
}

export async function loadRecordedScan(chain: string, tokenAddress: string, tier: Tier): Promise<Scan | null> {
  const raw = await readJson(recordedScanFile(chain, tokenAddress, tier));
  return isScan(raw) ? raw : null;
}

export function publicScanFileName(chain: string, tokenAddress: string): string {
  return `${scanId(chain, tokenAddress)}.json`;
}

export async function loadPublicScan(chain: string, tokenAddress: string): Promise<Scan | null> {
  const raw = await readJson(path.join(publicScansDir(), publicScanFileName(chain, tokenAddress)));
  return isScan(raw) ? raw : null;
}

export function scanAgeMs(scan: Scan, now = Date.now()): number {
  const t = Date.parse(scan.meta.scannedAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
}

/**
 * The best scan on disk for a token: the newest of the recorded deep / quick scans and the gallery
 * scan, where a deep scan beats a quick one recorded less than an hour later. With tier "deep" only
 * deep scans qualify (a deep scan also answers a quick request).
 */
export async function loadLatestScan(chain: string, tokenAddress: string, opts: { tier?: Tier; includePublic?: boolean } = {}): Promise<Scan | null> {
  const tiers: Tier[] = opts.tier === "deep" ? ["deep"] : ["deep", "quick"];
  const candidates: Scan[] = [];
  for (const t of tiers) {
    const s = await loadRecordedScan(chain, tokenAddress, t);
    if (s) candidates.push(s);
  }
  if (opts.includePublic !== false) {
    const p = await loadPublicScan(chain, tokenAddress);
    if (p && (!opts.tier || opts.tier === "quick" || p.tier === "deep")) candidates.push(p);
  }
  if (!candidates.length) return null;
  // Newest first; a deep scan wins over a quick one recorded within the same hour.
  const HOUR = 3_600_000;
  const score = (s: Scan) => Date.parse(s.meta.scannedAt) + (s.tier === "deep" ? HOUR : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------------ gallery (public/scans)

/** 24 points 0..1 (min..max of the film), sampled evenly across the 7 days. */
export function sparkline(price: PricePoint[], n = 24): number[] {
  if (!price.length) return [];
  const closes = price.map((p) => p.c);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of closes) {
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const span = hi - lo;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? closes.length - 1 : Math.round((i * (closes.length - 1)) / (n - 1));
    const v = span > 0 ? (closes[idx] - lo) / span : 0.5;
    out.push(Math.round(v * 1000) / 1000);
  }
  return out;
}

export function galleryEntry(scan: Scan, file: string): GalleryEntry {
  return {
    chain: scan.meta.chain,
    tokenAddress: scan.meta.tokenAddress,
    symbol: scan.meta.symbol,
    name: scan.meta.name,
    ...(scan.meta.logo ? { logo: scan.meta.logo } : {}),
    diagnosis: scan.diagnosis.sentence,
    code: scan.diagnosis.code,
    scannedAt: scan.meta.scannedAt,
    file,
    spark: sparkline(scan.price),
  };
}

function isSyntheticFile(file: string): boolean {
  return file.startsWith("_synthetic") || file.includes("/_synthetic");
}

/** Replaces the entry with the same file (or adds it), newest scan first. Synthetic scans never enter. */
export function upsertGallery(entries: GalleryEntry[], entry: GalleryEntry): GalleryEntry[] {
  const clean = entries.filter((e) => e && typeof e.file === "string" && !isSyntheticFile(e.file) && e.file !== entry.file);
  if (!isSyntheticFile(entry.file)) clean.push(entry);
  return clean.sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0));
}

export async function readGalleryIndex(): Promise<GalleryEntry[]> {
  const raw = await readJson(path.join(publicScansDir(), "index.json"));
  return Array.isArray(raw) ? (raw as GalleryEntry[]) : [];
}

/**
 * The home page's featured patient: the first gallery scan (index.json is newest first) that loads,
 * else the synthetic preview (public/scans/_synthetic.json, marked synthetic). Never spends credits.
 */
export async function loadFeaturedScan(): Promise<Scan | null> {
  for (const e of await readGalleryIndex()) {
    if (!e || typeof e.chain !== "string" || typeof e.tokenAddress !== "string") continue;
    const scan = await loadPublicScan(e.chain, e.tokenAddress);
    if (scan) return scan;
  }
  const synthetic = await readJson(path.join(publicScansDir(), "_synthetic.json"));
  return isScan(synthetic) ? { ...synthetic, synthetic: true } : null;
}

/** Writes public/scans/<chain>-<token>.json and upserts index.json. Refuses synthetic scans. */
export async function savePublicScan(scan: Scan): Promise<{ file: string; entry: GalleryEntry }> {
  if (scan.synthetic) throw new Error("Synthetic scans are never published to the gallery");
  const file = publicScanFileName(scan.meta.chain, scan.meta.tokenAddress);
  const dir = publicScansDir();
  await atomicWrite(path.join(dir, file), JSON.stringify(scan));
  const entry = galleryEntry(scan, file);
  // Re-read right before writing so parallel warm runs do not drop each other's entries.
  const index = upsertGallery(await readGalleryIndex(), entry);
  await atomicWrite(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return { file, entry };
}
