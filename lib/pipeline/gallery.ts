// Gallery index (public/scenes/index.json) shared by scripts/warm.ts and the landing page.
import type { HolderPoint } from "../types";

export interface SceneIndexEntry {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  logo?: string;
  /** Amount-weighted share of analysed supply (with a cost) that is underwater at priceNow. */
  underwaterShare: number;
  holdersAnalyzed: number;
  generatedAt: string;
  /** File name inside public/scenes, e.g. "base-0xabc….json"; fetch it from `/scenes/${file}`. */
  file: string;
}

export function isSyntheticFile(file: string): boolean {
  return file.startsWith("_synthetic") || file.includes("/_synthetic");
}

/** Replaces the entry with the same file (or appends it); synthetic fixtures never enter the index. */
export function upsertIndexEntry(entries: SceneIndexEntry[], entry: SceneIndexEntry): SceneIndexEntry[] {
  const clean = entries.filter((e) => e && typeof e.file === "string" && !isSyntheticFile(e.file));
  if (isSyntheticFile(entry.file)) return clean;
  const i = clean.findIndex((e) => e.file === entry.file);
  if (i >= 0) clean[i] = entry;
  else clean.push(entry);
  return clean;
}

/** Fallback for lib/metrics tideSnapshot(...).underwaterShare at price = priceNow. */
export function underwaterShareAt(holders: HolderPoint[], price: number): number {
  let total = 0;
  let under = 0;
  for (const h of holders) {
    if (h.cost === null || h.fog) continue;
    total += h.amount;
    if (h.cost > price) under += h.amount;
  }
  return total > 0 ? under / total : 0;
}
