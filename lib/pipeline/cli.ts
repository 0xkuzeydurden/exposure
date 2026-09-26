// Small helpers shared by the CLI scripts (argument parsing, number formatting, text tables).
import { isEvmChain, isSupportedChain, isValidAddress } from "../nansen/chains";

export interface TokenArg {
  chain: string;
  address: string;
}

/** "base:0xabc…" → {chain:"base", address:"0xabc…"}; throws with a helpful message otherwise. */
export function parseTokenArg(arg: string): TokenArg {
  const i = arg.indexOf(":");
  if (i <= 0) throw new Error(`Expected <chain>:<address>, got "${arg}"`);
  const chain = arg.slice(0, i).trim().toLowerCase();
  const raw = arg.slice(i + 1).trim();
  if (!isSupportedChain(chain)) throw new Error(`Unsupported chain "${chain}"`);
  if (!isValidAddress(chain, raw)) throw new Error(`Invalid ${chain} address "${raw}"`);
  return { chain, address: isEvmChain(chain) ? raw.toLowerCase() : raw };
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  const d = Math.min(digits, 2);
  if (a >= 1e9) return `${(n / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(d)}K`;
  if (a === 0) return "0";
  if (a < 0.0001) return n.toExponential(2);
  if (a < 1) return n.toPrecision(3);
  return n.toFixed(digits);
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Fixed-width text table (right-aligned numbers are the caller's job). */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
