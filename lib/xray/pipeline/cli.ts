// Shared bits of the EXPOSURE CLI scripts (xray-smoke, trending, warm-scans).
import { createInterface } from "node:readline/promises";
import { parseTokenArg, type TokenArg } from "../../pipeline/cli";

const CHAIN_ALIASES: Record<string, string> = {
  eth: "ethereum",
  mainnet: "ethereum",
  bsc: "bnb",
  sol: "solana",
  arb: "arbitrum",
  op: "optimism",
  poly: "polygon",
  matic: "polygon",
  avax: "avalanche",
};

/** "eth:0xabc…" / "base:0x…" / "sol:MINT" → {chain, address}; throws with a helpful message. */
export function parseTarget(arg: string): TokenArg {
  const i = arg.indexOf(":");
  if (i > 0) {
    const chain = arg.slice(0, i).trim().toLowerCase();
    const alias = CHAIN_ALIASES[chain];
    if (alias) return parseTokenArg(`${alias}:${arg.slice(i + 1)}`);
  }
  return parseTokenArg(arg);
}

/** --name=value flags and positional arguments (npm's "--" separator is ignored). */
export function parseArgs(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else flags.set(a.slice(2), "true");
    } else positional.push(a);
  }
  return { flags, positional };
}

export function intFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const v = flags.get(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

/** y/N prompt on a TTY; false (and a hint) when stdin is not interactive. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question} (not an interactive terminal: pass --yes to proceed)`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
