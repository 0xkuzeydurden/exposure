// Append-only call ledger (.ledger/calls.ndjson) plus in-process counters for the credit meter.
// Every HTTP attempt and every cache hit is one line. NANSEN_LEDGER=off disables the file (tests).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ledgerFile } from "./paths";

export interface LedgerEntry {
  ts: string;
  endpoint: string;
  status: number;
  credits: number;
  ms: number;
  cached: boolean;
  /** Error code from the Nansen error envelope, when the call failed. */
  code?: string;
}

export interface EndpointCounters {
  calls: number;
  networkCalls: number;
  cacheHits: number;
  errors: number;
  credits: number;
}

export interface LedgerCounters extends EndpointCounters {
  /** Last `X-Nansen-Credits-Remaining` header seen in this process. */
  creditsRemaining: number | null;
  byEndpoint: Record<string, EndpointCounters>;
  since: string;
}

interface LedgerState {
  counters: LedgerCounters;
  writeChain: Promise<void>;
  dirReady: boolean;
}

const STATE_KEY = Symbol.for("exposure.nansen.ledger");

function emptyCounters(): EndpointCounters {
  return { calls: 0, networkCalls: 0, cacheHits: 0, errors: 0, credits: 0 };
}

// Stored on globalThis so every Next.js route bundle shares one set of counters.
function state(): LedgerState {
  const g = globalThis as unknown as Record<symbol, LedgerState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = {
      counters: { ...emptyCounters(), creditsRemaining: null, byEndpoint: {}, since: new Date().toISOString() },
      writeChain: Promise.resolve(),
      dirReady: false,
    };
    g[STATE_KEY] = s;
  }
  return s;
}

function ledgerEnabled(): boolean {
  return (process.env.NANSEN_LEDGER ?? "").toLowerCase() !== "off";
}

function bump(c: EndpointCounters, e: Omit<LedgerEntry, "ts">): void {
  c.calls += 1;
  if (e.cached) c.cacheHits += 1;
  else c.networkCalls += 1;
  if (e.status < 200 || e.status >= 300) c.errors += 1;
  c.credits += e.credits;
}

/** Records one call. File writes are serialised and never throw into the caller. */
export function recordCall(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
  const line: LedgerEntry = { ts: new Date().toISOString(), ...entry };
  const s = state();
  bump(s.counters, entry);
  const ep = (s.counters.byEndpoint[entry.endpoint] ??= emptyCounters());
  bump(ep, entry);

  if (ledgerEnabled()) {
    const file = ledgerFile();
    s.writeChain = s.writeChain
      .then(async () => {
        if (!s.dirReady) {
          await mkdir(path.dirname(file), { recursive: true });
          s.dirReady = true;
        }
        await appendFile(file, JSON.stringify(line) + "\n", "utf8");
      })
      .catch((err) => {
        console.warn(`[ledger] write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
  return line;
}

export function setCreditsRemaining(n: number | null): void {
  if (n !== null && Number.isFinite(n)) state().counters.creditsRemaining = n;
}

/** Snapshot of the process-wide counters (safe to serialise). */
export function ledgerCounters(): LedgerCounters {
  const c = state().counters;
  return JSON.parse(JSON.stringify(c)) as LedgerCounters;
}

/** Resolves once every queued ledger line has been written (call before a script exits). */
export async function flushLedger(): Promise<void> {
  await state().writeChain;
}

/** Reads and parses the ledger file; malformed lines are skipped. */
export async function readLedger(file = ledgerFile()): Promise<LedgerEntry[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (typeof e.endpoint === "string") out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}
