// Small pure helpers shared by the EXPOSURE scan stages (time windows, numbers, addresses).
import { normalizeAddress, shortAddress } from "../../nansen/chains";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** ISO datetime truncated to the minute, without milliseconds: "2026-09-26T02:00:00Z". */
export function isoMinute(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface Window {
  from: string;
  to: string;
}

/** The last `days` days ending at `now` (minute precision). */
export function lastDays(now: Date, days: number): Window {
  const to = now.getTime();
  return { from: isoMinute(to - days * DAY_MS), to: isoMinute(to) };
}

/** "2026-09-21" (UTC) */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function finite(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function positive(x: number | null | undefined): x is number {
  return finite(x) && x > 0;
}

export function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) if (Number.isFinite(x)) s += x;
  return s;
}

export function nansenProfilerUrl(address: string, chain: string): string {
  return `https://app.nansen.ai/profiler?address=${encodeURIComponent(address)}&chain=${encodeURIComponent(chain)}`;
}

export { normalizeAddress, shortAddress };

/** Parses an ISO timestamp from the API; returns NaN when missing / invalid. */
export function parseTime(s: string | null | undefined): number {
  if (!s) return NaN;
  // Some endpoints return "2026-09-21 14:00:00" without a zone: treat as UTC.
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.parse(s);
}
