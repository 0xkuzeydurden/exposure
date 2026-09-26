// Live-usage guard for credit-spending scans and wallet checks (server only).
//
//   * Live scans run by default under `next dev` / scripts; a production server needs EXPOSURE_LIVE=1
//     (EXPOSURE_LIVE=0 always disables them), mirroring lib/pipeline/live.ts.
//   * Daily credit cap (UTC day): EXPOSURE_DAILY_CREDITS, default 80. Deep scans (holder cost basis +
//     funder tracing) also share a smaller cap: EXPOSURE_DEEP_DAILY_CREDITS, default 50 (plan §8).
//   * Floor: when the account would have fewer than EXPOSURE_CREDIT_FLOOR (default 400) credits left
//     after this scan and every scan still running (their reservations), live scans stop (gallery
//     only). The balance comes from the free GET /account, cached 5 min, and from the
//     X-Nansen-Credits-Remaining header of the last paid call, whichever is lower. An unknown balance
//     refuses (fails closed).
//   * Per visitor (IP, stored hashed): EXPOSURE_IP_TOKENS (default 1) new tokens, EXPOSURE_IP_SCANS
//     (default 3) live scans (repeats of the same token included) and EXPOSURE_IP_WALLETS (default 3)
//     wallet checks per day, enforced in production or with EXPOSURE_VISITOR_LIMITS=1.
// Admission reserves the estimate (written to .cache/budget.json straight away, so a crash never
// under-counts); settle() replaces it with what the scan really spent. A scan answered entirely from
// the disk cache (0 credits) gives the visitor's slot back.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAccount } from "../nansen/api";
import { isEvmChain } from "../nansen/chains";
import { hasNansenKey } from "../nansen/client";
import { describeError } from "../nansen/errors";
import { ledgerCounters } from "../nansen/ledger";
import { projectRoot } from "../nansen/paths";
import { DEFAULT_MAX_BUYERS, MAX_BUYERS_CAP } from "./pipeline/buyers";
import { DEFAULT_MAX_HOLDERS, MAX_HOLDERS_CAP } from "./pipeline/walls";
import type { ScanEvent, Tier } from "./types";

export const LIVE_DISABLED_MESSAGE = "Live scans are switched off on this server. The waiting room still works.";

function envNumber(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** EXPOSURE_LIVE=1/true forces on, 0/false forces off; otherwise on everywhere except production. */
export function liveScansAllowed(): boolean {
  const flag = (process.env.EXPOSURE_LIVE ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export interface BudgetLimits {
  dailyCap: number;
  deepCap: number;
  floor: number;
  ipTokens: number;
  ipScans: number;
  ipWallets: number;
}

/**
 * Per-visitor limits apply in production, or anywhere with EXPOSURE_VISITOR_LIMITS=1 (in development
 * every request comes from the same machine; the daily cap still applies).
 */
export function visitorLimitsEnforced(): boolean {
  const flag = (process.env.EXPOSURE_VISITOR_LIMITS ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function budgetLimits(): BudgetLimits {
  return {
    dailyCap: envNumber("EXPOSURE_DAILY_CREDITS", 80),
    deepCap: envNumber("EXPOSURE_DEEP_DAILY_CREDITS", 50),
    floor: envNumber("EXPOSURE_CREDIT_FLOOR", 400),
    ipTokens: envNumber("EXPOSURE_IP_TOKENS", 1),
    ipScans: envNumber("EXPOSURE_IP_SCANS", 3),
    ipWallets: envNumber("EXPOSURE_IP_WALLETS", 3),
  };
}

/**
 * Buyer / holder fan-out used by live (visitor-triggered) deep scans. Scripts pass their own.
 * 15 + 15 keeps a live deep scan at 48 credits on EVM (33 elsewhere), inside the 50-credit deep cap.
 */
export function liveScanLimits(): { maxBuyers: number; maxHolders: number } {
  return {
    maxBuyers: Math.min(MAX_BUYERS_CAP, Math.max(1, Math.floor(envNumber("EXPOSURE_LIVE_MAX_BUYERS", 15)))),
    maxHolders: Math.min(MAX_HOLDERS_CAP, Math.max(1, Math.floor(envNumber("EXPOSURE_LIVE_MAX_HOLDERS", 15)))),
  };
}

// ------------------------------------------------------------------ estimates

export interface CreditEstimate {
  context: number;
  buyers: number;
  flow: number;
  walls: number;
  smart: number;
  total: number;
}

/** token-screener lookup by address when token-information lacks symbol / market cap / supply / liquidity. */
export const TOKEN_LOOKUP_CREDITS = 1;

/**
 * Documented credit cost of one scan (an upper bound: disk-cache hits cost 0, and pnl calls that
 * need a narrower date window cost one extra credit each).
 *   context  token-information + token-ohlcv + dex-trades                              3
 *            + token-screener by token address, only when token-information lacks     +1
 *              symbol / market cap / supply / liquidity and no hints cover them
 *              (reserved on every scan: admission cannot know in advance)
 *   buyers   who-bought-sold BUY 7d                                                    1
 *            + deep, EVM: first-funder per traced buyer                                +maxBuyers
 *   flow     tgm/flows × 4 labels + flow-intelligence 7d                               5
 *   walls    quick: who-bought-sold BUY 30d                                            1
 *            deep:  tgm/holders (5) + profiler pnl per holder (capped at maxHolders)   5 + maxHolders
 *                   + who-bought-sold BUY 30d, fetched at most once: to spare its        +1
 *                     buyers from an allocation skip, for the hybrid blend (pnl covers
 *                     < 50%) or for the fallback without a holder list
 *   smart    who-bought-sold smart-money BUY + SELL 30d                                2
 * Quick = 13 on any chain. Deep = 18 + maxHolders (+ maxBuyers on EVM). The deep walls reuse the
 * 7-day buyer list finding 01 already fetched to rank holders (no extra call). search/general is
 * never called by a scan.
 */
export function estimateBreakdown(tier: Tier, chain: string, opts: { maxBuyers?: number; maxHolders?: number } = {}): CreditEstimate {
  const maxBuyers = Math.max(0, Math.floor(opts.maxBuyers ?? DEFAULT_MAX_BUYERS));
  const maxHolders = Math.max(0, Math.floor(opts.maxHolders ?? DEFAULT_MAX_HOLDERS));
  const deep = tier === "deep";
  const e = {
    context: 3 + TOKEN_LOOKUP_CREDITS,
    buyers: 1 + (deep && isEvmChain(chain) ? maxBuyers : 0),
    flow: 5,
    walls: deep ? 5 + maxHolders + 1 : 1,
    smart: 2,
  };
  return { ...e, total: e.context + e.buyers + e.flow + e.walls + e.smart };
}

export function estimateCredits(tier: Tier, chain: string, opts: { maxBuyers?: number; maxHolders?: number } = {}): number {
  return estimateBreakdown(tier, chain, opts).total;
}

// ------------------------------------------------------------------ account (free GET /account, cached 5 min)

const ACCOUNT_TTL_MS = 5 * 60_000;

export interface AccountSnapshot {
  creditsRemaining: number | null;
  plan: string | null;
  fetchedAt: number;
  error?: string;
}

interface BudgetGlobals {
  account: AccountSnapshot | null;
  accountInflight: Promise<AccountSnapshot> | null;
  state: BudgetState | null;
  loading: Promise<BudgetState> | null;
  writeChain: Promise<void>;
  seq: number;
  /** Credits reserved by admitted scans / wallet checks that have not settled yet (this process). */
  outstanding: number;
}

const GLOBAL_KEY = Symbol.for("exposure.budget");

function globals(): BudgetGlobals {
  const g = globalThis as unknown as Record<symbol, BudgetGlobals | undefined>;
  let s = g[GLOBAL_KEY];
  if (!s) {
    s = { account: null, accountInflight: null, state: null, loading: null, writeChain: Promise.resolve(), seq: 0, outstanding: 0 };
    g[GLOBAL_KEY] = s;
  }
  return s;
}

/** Account plan and credits (0 credits). Never throws; `creditsRemaining` is null when unknown. */
export async function accountSnapshot(opts: { force?: boolean } = {}): Promise<AccountSnapshot> {
  const g = globals();
  const ledgerRemaining = ledgerCounters().creditsRemaining;
  const merge = (a: AccountSnapshot): AccountSnapshot => {
    // The last paid call's header is fresher than a cached /account read (credits only go down in between).
    const values = [a.creditsRemaining, ledgerRemaining].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return { ...a, creditsRemaining: values.length ? Math.min(...values) : null };
  };
  if (!hasNansenKey()) return { creditsRemaining: null, plan: null, fetchedAt: Date.now(), error: "NANSEN_API_KEY is not set" };
  if (!opts.force && g.account && Date.now() - g.account.fetchedAt < ACCOUNT_TTL_MS) return merge(g.account);
  if (!g.accountInflight) {
    g.accountInflight = getAccount()
      .then((res) => ({ creditsRemaining: res.data.credits_remaining, plan: res.data.plan, fetchedAt: Date.now() }))
      .catch((err: unknown) => ({
        creditsRemaining: g.account?.creditsRemaining ?? null,
        plan: g.account?.plan ?? null,
        // Retry a failed read after 30s rather than 5 min.
        fetchedAt: Date.now() - ACCOUNT_TTL_MS + 30_000,
        error: describeError(err),
      }))
      .then((snap: AccountSnapshot) => {
        g.account = snap;
        return snap;
      })
      .finally(() => {
        g.accountInflight = null;
      });
  }
  return merge(await g.accountInflight);
}

// ------------------------------------------------------------------ persistent daily state

interface VisitorDay {
  tokens: string[];
  /** Live scans admitted today (repeats of the same token included). */
  scans?: number;
  wallets: number;
}

interface BudgetState {
  version: 1;
  /** UTC day "2026-09-26" the counters belong to. */
  day: string;
  /** Credits spent (or reserved) today by live scans and wallet checks. */
  spent: number;
  /** Part of `spent` that came from deep scans. */
  deepSpent: number;
  scans: number;
  walletChecks: number;
  visitors: Record<string, VisitorDay>;
}

function budgetFile(): string {
  return path.join(projectRoot(), ".cache", "budget.json");
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function freshState(day: string): BudgetState {
  return { version: 1, day, spent: 0, deepSpent: 0, scans: 0, walletChecks: 0, visitors: {} };
}

async function loadState(): Promise<BudgetState> {
  const g = globals();
  const today = utcDay();
  if (g.state) {
    if (g.state.day !== today) g.state = freshState(today);
    return g.state;
  }
  if (!g.loading) {
    g.loading = (async () => {
      let s: BudgetState = freshState(today);
      try {
        const raw = JSON.parse(await readFile(budgetFile(), "utf8")) as Partial<BudgetState>;
        if (raw && raw.version === 1 && raw.day === today) {
          s = {
            ...freshState(today),
            spent: Number(raw.spent) || 0,
            deepSpent: Number(raw.deepSpent) || 0,
            scans: Number(raw.scans) || 0,
            walletChecks: Number(raw.walletChecks) || 0,
            visitors: raw.visitors && typeof raw.visitors === "object" ? raw.visitors : {},
          };
        }
      } catch {
        /* first run */
      }
      g.state = s;
      return s;
    })().finally(() => {
      g.loading = null;
    });
  }
  return g.loading;
}

function persist(): Promise<void> {
  const g = globals();
  const snapshot = JSON.stringify(g.state);
  g.writeChain = g.writeChain
    .then(async () => {
      const file = budgetFile();
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, snapshot + "\n", "utf8");
      await rename(tmp, file);
    })
    .catch((err) => {
      console.warn(`[budget] could not save: ${err instanceof Error ? err.message : String(err)}`);
    });
  return g.writeChain;
}

/** Resolves once every queued write of .cache/budget.json has landed (scripts / tests). */
export async function flushBudget(): Promise<void> {
  await globals().writeChain;
}

/** Visitor key: a short hash, so raw IPs never touch the disk. */
export function visitorKey(ip: string): string {
  return createHash("sha256").update(`exposure:${ip}`).digest("hex").slice(0, 16);
}

/**
 * Best-effort client IP ("local" in development). Headers the hosting platform sets itself come first
 * (Fly-Client-IP, CF-Connecting-IP, X-Real-IP); X-Forwarded-For is last, and read from the right: a
 * client can put anything at its start, while proxies append the address they saw.
 */
export function clientIp(headers: Headers): string {
  for (const name of ["fly-client-ip", "cf-connecting-ip", "x-real-ip"]) {
    const v = headers.get(name)?.trim();
    if (v) return v;
  }
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "local";
}

// ------------------------------------------------------------------ admission

export type RefusalReason =
  | "live_disabled"
  | "no_key"
  | "floor"
  | "balance_unknown"
  | "daily_cap"
  | "deep_cap"
  | "visitor_tokens"
  | "visitor_scans"
  | "visitor_wallets";

export interface BudgetTicket {
  id: number;
  kind: "scan" | "wallet";
  tier: Tier | null;
  visitor: string;
  tokenKey: string | null;
  reserved: number;
  day: string;
  settled: boolean;
}

export type Admission =
  | { ok: true; ticket: BudgetTicket; estimate: number; creditsLeftToday: number; creditsRemaining: number | null }
  | { ok: false; reason: RefusalReason; message: string; estimate: number; creditsLeftToday: number; creditsRemaining: number | null };

function tokenKeyOf(chain: string, token: string): string {
  const c = chain.trim().toLowerCase();
  return `${c}:${isEvmChain(c) ? token.trim().toLowerCase() : token.trim()}`;
}

function refuse(reason: RefusalReason, message: string, estimate: number, left: number, remaining: number | null): Admission {
  return { ok: false, reason, message, estimate, creditsLeftToday: Math.max(0, left), creditsRemaining: remaining };
}

/**
 * Floor check; must run in the synchronous section right before the reservation. `outstanding` covers
 * scans admitted earlier that are still running (their spend is not in the balance yet). An unknown
 * balance refuses: without it the floor cannot be enforced.
 */
function floorRefusal(remaining: number | null, estimate: number, left: number, limits: BudgetLimits): Admission | null {
  if (remaining === null) {
    return refuse("balance_unknown", "The credit balance could not be read, so live scans are paused. The waiting room still works.", estimate, left, null);
  }
  if (remaining - globals().outstanding - estimate < limits.floor) {
    return refuse("floor", "Credits are running low, so live scans are paused. The waiting room still works.", estimate, left, remaining);
  }
  return null;
}

/** Admits (and reserves) a live scan for this visitor, or explains why not. */
export async function admitScan(req: { ip: string; chain: string; token: string; tier: Tier; estimate: number }): Promise<Admission> {
  const limits = budgetLimits();
  const estimate = Math.max(0, Math.ceil(req.estimate));
  const before = await loadState();
  if (!liveScansAllowed()) return refuse("live_disabled", LIVE_DISABLED_MESSAGE, estimate, limits.dailyCap - before.spent, null);
  if (!hasNansenKey()) return refuse("no_key", "NANSEN_API_KEY is not set. The waiting room still works.", estimate, limits.dailyCap - before.spent, null);
  const remaining = (await accountSnapshot()).creditsRemaining;

  // Everything below is synchronous: check and reserve atomically.
  const state = await loadState();
  const left = limits.dailyCap - state.spent;
  const floor = floorRefusal(remaining, estimate, left, limits);
  if (floor) return floor;
  const visitor = visitorKey(req.ip);
  const tokenKey = tokenKeyOf(req.chain, req.token);
  const v = state.visitors[visitor] ?? { tokens: [], wallets: 0 };
  if (visitorLimitsEnforced() && !v.tokens.includes(tokenKey) && v.tokens.length >= limits.ipTokens) {
    return refuse(
      "visitor_tokens",
      `One new token per visitor per day${limits.ipTokens === 1 ? "" : ` (limit ${limits.ipTokens})`}. Scans in the waiting room are free.`,
      estimate,
      left,
      remaining,
    );
  }
  if (visitorLimitsEnforced() && (v.scans ?? 0) >= limits.ipScans) {
    return refuse("visitor_scans", `${limits.ipScans} live x-rays per visitor per day. Scans in the waiting room are free.`, estimate, left, remaining);
  }
  if (state.spent + estimate > limits.dailyCap) {
    return refuse("daily_cap", `Today's live budget is used up (${Math.max(0, left)} of ${limits.dailyCap} credits left). Try the waiting room.`, estimate, left, remaining);
  }
  if (req.tier === "deep" && state.deepSpent + estimate > limits.deepCap) {
    return refuse("deep_cap", "Today's deep-scan budget is used up. A quick scan still works.", estimate, left, remaining);
  }
  const g = globals();
  const ticket: BudgetTicket = {
    id: ++g.seq,
    kind: "scan",
    tier: req.tier,
    visitor,
    tokenKey,
    reserved: estimate,
    day: state.day,
    settled: false,
  };
  state.spent += estimate;
  if (req.tier === "deep") state.deepSpent += estimate;
  state.scans += 1;
  if (!v.tokens.includes(tokenKey)) v.tokens.push(tokenKey);
  v.scans = (v.scans ?? 0) + 1;
  state.visitors[visitor] = v;
  g.outstanding += estimate;
  void persist();
  return { ok: true, ticket, estimate, creditsLeftToday: Math.max(0, limits.dailyCap - state.spent), creditsRemaining: remaining };
}

/** Admits (and reserves 1 credit for) a wallet check. */
export async function admitWalletCheck(req: { ip: string }): Promise<Admission> {
  const limits = budgetLimits();
  const estimate = 1;
  const before = await loadState();
  if (!liveScansAllowed()) return refuse("live_disabled", LIVE_DISABLED_MESSAGE, estimate, limits.dailyCap - before.spent, null);
  if (!hasNansenKey()) return refuse("no_key", "NANSEN_API_KEY is not set.", estimate, limits.dailyCap - before.spent, null);
  const remaining = (await accountSnapshot()).creditsRemaining;

  // Synchronous from here: check and reserve atomically.
  const state = await loadState();
  const left = limits.dailyCap - state.spent;
  const floor = floorRefusal(remaining, estimate, left, limits);
  if (floor) return floor;
  const visitor = visitorKey(req.ip);
  const v = state.visitors[visitor] ?? { tokens: [], wallets: 0 };
  if (visitorLimitsEnforced() && v.wallets >= limits.ipWallets) {
    return refuse("visitor_wallets", `${limits.ipWallets} wallet checks per visitor per day. Come back tomorrow.`, estimate, left, remaining);
  }
  if (state.spent + estimate > limits.dailyCap) {
    return refuse("daily_cap", "Today's live budget is used up.", estimate, left, remaining);
  }
  const g = globals();
  const ticket: BudgetTicket = { id: ++g.seq, kind: "wallet", tier: null, visitor, tokenKey: null, reserved: estimate, day: state.day, settled: false };
  state.spent += estimate;
  state.walletChecks += 1;
  v.wallets += 1;
  state.visitors[visitor] = v;
  g.outstanding += estimate;
  void persist();
  return { ok: true, ticket, estimate, creditsLeftToday: Math.max(0, limits.dailyCap - state.spent), creditsRemaining: remaining };
}

/**
 * Replaces the reservation with the credits really spent. 0 credits (everything came from the disk
 * cache, or the scan failed before any paid call) also returns the visitor's slot.
 */
export async function settleTicket(ticket: BudgetTicket, actualCredits: number): Promise<void> {
  if (ticket.settled) return;
  ticket.settled = true;
  const g = globals();
  g.outstanding = Math.max(0, g.outstanding - ticket.reserved);
  const state = await loadState();
  if (state.day !== ticket.day) return; // a new day started; yesterday's counters are gone
  const actual = Math.max(0, Number.isFinite(actualCredits) ? actualCredits : ticket.reserved);
  const delta = actual - ticket.reserved;
  state.spent = Math.max(0, state.spent + delta);
  if (ticket.kind === "scan" && ticket.tier === "deep") state.deepSpent = Math.max(0, state.deepSpent + delta);
  if (actual === 0) {
    const v = state.visitors[ticket.visitor];
    if (v) {
      if (ticket.kind === "wallet") v.wallets = Math.max(0, v.wallets - 1);
      else {
        v.scans = Math.max(0, (v.scans ?? 1) - 1);
        if (ticket.tokenKey) v.tokens = v.tokens.filter((t) => t !== ticket.tokenKey);
      }
    }
  }
  await persist();
}

export interface BudgetStatus {
  liveEnabled: boolean;
  hasKey: boolean;
  plan: string | null;
  creditsRemaining: number | null;
  dailyCap: number;
  dailyLeft: number;
  deepCap: number;
  deepLeft: number;
  floor: number;
  /** false when the floor has been reached (gallery-only mode). */
  aboveFloor: boolean;
  scansToday: number;
  walletChecksToday: number;
  accountError?: string;
}

export async function budgetStatus(): Promise<BudgetStatus> {
  const limits = budgetLimits();
  const state = await loadState();
  const acct = await accountSnapshot();
  const remaining = acct.creditsRemaining;
  // Same test as a quick scan's admission (reservations of running scans included).
  const aboveFloor = remaining !== null && remaining - globals().outstanding - estimateCredits("quick", "base") >= limits.floor;
  const status: BudgetStatus = {
    liveEnabled: liveScansAllowed() && hasNansenKey() && aboveFloor,
    hasKey: hasNansenKey(),
    plan: acct.plan,
    creditsRemaining: remaining,
    dailyCap: limits.dailyCap,
    dailyLeft: Math.max(0, limits.dailyCap - state.spent),
    deepCap: limits.deepCap,
    deepLeft: Math.max(0, Math.min(limits.deepCap - state.deepSpent, limits.dailyCap - state.spent)),
    floor: limits.floor,
    aboveFloor,
    scansToday: state.scans,
    walletChecksToday: state.walletChecks,
  };
  if (acct.error && hasNansenKey()) status.accountError = acct.error;
  return status;
}

/** The SSE event for a refused admission. */
export function budgetEvent(a: Extract<Admission, { ok: false }>): Extract<ScanEvent, { type: "budget" }> {
  return { type: "budget", message: a.message, creditsLeftToday: a.creditsLeftToday, creditsRemaining: a.creditsRemaining };
}
