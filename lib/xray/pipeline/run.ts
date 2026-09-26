// The EXPOSURE scan: context → 01 buyers · 02 flow · 03 walls · 04 smart money → diagnosis.
// Streams ScanEvents in a fixed order (stage/meta, then per finding: stage → its calls → finding,
// then diagnosis, then done). After the context stage the four finding stages run concurrently;
// ordered lanes (./tracker.ts) buffer each stage's call events until it is that stage's turn.
// Missing data never throws: a finding degrades to status "partial" / "unavailable". Only fatal
// problems (invalid token, no price, no key, out of credits, abort) end the scan with an error event.
import {
  getAddressPnl,
  getFirstFunder,
  getFlowIntelligenceWindow,
  getHolders,
  getTgmDexTrades,
  getTgmFlows,
  getTokenInformation,
  getTokenOhlcv,
  getTokenTraders,
  lookupTokenScreener,
  SCREENER_CHAINS,
  SMART_MONEY_LABELS,
} from "../../nansen/api";
import { isEvmChain, isSupportedChain, isValidAddress, SUPPORTED_CHAINS } from "../../nansen/chains";
import { nansenConcurrency } from "../../nansen/client";
import { EP } from "../../nansen/endpoints";
import { describeError, isAbortError, MissingKeyError, NansenError } from "../../nansen/errors";
import type { NansenResult } from "../../nansen/client";
import type { FlowIntelligenceRow, PnlRow, TgmFlowRow, WhoBoughtSoldResponse, WhoBoughtSoldRow } from "../../nansen/schemas";
import { deriveHolder, isAllocationRecord, pickPnlRecord, pnlWindows, windowCoversHistory, type DateWindow } from "../../pipeline/derive";
import type { HolderPoint } from "../../types";
import { stageMessage } from "../copy";
import { diagnose } from "../diagnosis";
import { nextScanNo } from "../store";
import type {
  BigBuy,
  BuyersFinding,
  CallRecord,
  Diagnosis,
  FindingKey,
  FlowFinding,
  PricePoint,
  Scan,
  ScanEvent,
  ScanMeta,
  SmartFinding,
  Tier,
  WallsFinding,
} from "../types";
import { RULES } from "./active-rules";
import {
  BUYERS_PAGE,
  BUYERS_WINDOW_DAYS,
  clusterBuyers,
  concentrationFinding,
  DEFAULT_MAX_BUYERS,
  emptyBuyersFinding,
  lookupFromRows,
  MAX_BUYERS_CAP,
  prepareBuyers,
  tracedFinding,
  type FunderLookup,
} from "./buyers";
import {
  bigBuysFromTrades,
  BIG_BUYS_LIMIT,
  buildMeta,
  needsTokenLookup,
  pricePoints,
  resolvePriceNow,
  scanSupply,
  screenerMatch,
  totalSupplyOf,
} from "./context";
import { buildFlowFinding, emptyFlowFinding, FLOW_LABELS, FLOWS_PAGE, type ScanFlowLabel } from "./flow";
import type { PipelineRules } from "./rules";
import { hintsFromScreenerRow, mergeHints, type ScanHints } from "./hints";
import { aggregateSmart, SMART_WINDOW_DAYS } from "./smart";
import { CallTracker, isFatal, Lane, settle, type Settled } from "./tracker";
import { clamp01, DAY_MS, HOUR_MS, isoMinute, lastDays, normalizeAddress } from "./util";
import {
  blendRecentBuyers,
  buildWallsFinding,
  buyerKeys,
  DEFAULT_MAX_HOLDERS,
  emptyWallsFinding,
  HYBRID_BELOW,
  MAX_HOLDERS_CAP,
  planPnlHolders,
  pnlCostCoverage,
  recentBuyerEntries,
  RECENT_BUYERS_WINDOW_DAYS,
  totalShareOf,
  type KeyedHolder,
  type PlanInput,
} from "./walls";

export const NO_KEY_MESSAGE = "NANSEN_API_KEY is not set. The waiting room still works.";
/** Consecutive failed fan-out calls (before any success) after which the endpoint is given up. */
const FANOUT_BREAKER = 8;
const FILM_DAYS = 7;
export const FILM_WINDOW_MS = FILM_DAYS * DAY_MS;
/**
 * tgm/flows returns hourly buckets for ranges of seven days or less and daily ones beyond. Exactly
 * 7×24h sits on that boundary (an aligned first bucket or an inclusive end would tip it over), so the
 * flows window is one hour shorter.
 */
const FLOWS_HOURS = FILM_DAYS * 24 - 1;
/** The big-buys dex-trades query (7 days sorted by value) is the slowest call: give it more time. */
const BIG_BUYS_TIMEOUT_MS = 60_000;

export interface RunScanOptions {
  tier: Tier;
  onEvent?: (e: ScanEvent) => void;
  signal?: AbortSignal;
  /** Deep tier, EVM: buyers traced with first-funder (1 credit each). Default 60, max 200. */
  maxBuyers?: number;
  /** Deep tier: holders analysed with profiler pnl (1 credit each). Default 40, max 200. */
  maxHolders?: number;
  /** "SCAN 0412"; defaults to the next value of the persistent counter (lib/xray/store). */
  scanNo?: number;
  /** Override "now" (tests / reproducible snapshots). */
  now?: Date;
  /** Gallery mode (warm-scans): cache hits keep their original credits and latency (see CallTracker). */
  virtualClock?: boolean;
  /** Classification thresholds; default lib/xray/thresholds.ts. */
  rules?: PipelineRules;
  /**
   * Token facts the caller already has (e.g. the token-screener row, see ./hints.ts): fill symbol, name,
   * market cap, liquidity, supply and deployment date where token-information returns "" or 0. Hints
   * that cover what token-information lacks save the token-screener lookup (1 credit).
   */
  hints?: ScanHints | null;
  /**
   * Every Nansen call as soon as it is made (before the ordered stream releases it). The live route
   * settles the credit budget on this, so an aborted scan still counts what it spent.
   */
  onCall?: (call: CallRecord) => void;
}

/** Coverage numbers the GO/NO-GO smoke test prints (not part of the Scan contract). */
export interface ScanDebug {
  buyers: {
    mode: "traced" | "quick" | "non_evm" | "unavailable";
    eligible: number;
    analysed: number;
    traced: number;
    untraced: number;
    failed: number;
    maxHubShare: number;
    maxHubLabel: string | null;
    /** Full address of the funder behind the largest wallet group (printed by the smoke test, never published). */
    walletHub: { address: string | null; label: string | null; wallets: number };
  };
  flows: Record<ScanFlowLabel, { ok: boolean; buckets: number; movingHours: number }> & { intel: boolean };
  walls: {
    method: WallsFinding["method"];
    /** pnl calls planned (deep) / 30-day buyers still holding (quick). */
    requested: number;
    pnlOk: number;
    withCost: number;
    noHistory: number;
    failures: number;
    /** Allocations recognised from tgm/holders alone (balance > circulating supply, allocation label): no pnl call. */
    skipped: number;
    /** Holders that matched a skip rule but were asked anyway because they are 7d / 30d DEX buyers. */
    spared: number;
    /** Someone matched a skip rule, so the 30-day buyer list was requested before the pnl calls (to spare its buyers). */
    monthForSkips: boolean;
    /** pnl answers with bought_usd 0 and cost_basis_usd 0 over the token's whole history (received, never bought). */
    allocations: number;
    /** Zero-cost pnl answers NOT read as allocations (window shorter than the history, or a known DEX buyer): "no_cost". */
    zeroCostKept: number;
    /** Share of total supply held by skipped + allocation holders (WallsFinding.allocatedShare). */
    allocatedShare: number;
    /** Planned holders that are also this week's DEX buyers. */
    recentBuyerHolders: number;
    /** Share of the pnl-analysed holders' tokens with a cost basis (hybrid below HYBRID_BELOW). */
    pnlCoverage: number;
    /** 30-day buyers blended in (hybrid). */
    proxyBuyers: number;
  };
  smart: { wallets: number; callsOk: number };
}

/** Fatal scan failure. The matching {type:'error'} event has already been emitted. */
export class ScanError extends Error {
  readonly name = "ScanError";
  constructor(
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function clampInt(v: number | undefined, fallback: number, max: number): number {
  const n = Math.floor(v ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

/**
 * Runs `fn` over items with at most `concurrency` in flight; stops starting new items once `stop()` is
 * true or one item threw. Waits for every call already in flight before rethrowing the first error, so
 * the calls they made are recorded (and counted by the budget).
 */
async function pool<T>(items: T[], concurrency: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let broken = false;
  const worker = async () => {
    while (next < items.length && !stop() && !broken) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        broken = true;
        throw err;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Promise.all that waits for every promise before rejecting with the first failure. */
async function allSettledOrThrow<T extends readonly unknown[] | []>(ps: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(ps as readonly unknown[]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

/** A diagnosis must exist even if the rules module fails; this one says so honestly. */
function safeDiagnose(findings: Scan["findings"], meta: ScanMeta): Diagnosis {
  try {
    return diagnose(findings, meta);
  } catch (err) {
    console.warn(`[scan] diagnose() failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      code: "insufficient",
      rule: 0,
      sentence: "Too few labelled wallets to read this token.",
      confidence: "low",
      lights: { flow: "amber", crowd: "amber", ceiling: "amber" },
      footnotes: [],
    };
  }
}

export async function runScan(chain: string, tokenAddress: string, opts: RunScanOptions): Promise<Scan> {
  return (await runScanDetailed(chain, tokenAddress, opts)).scan;
}

export async function runScanDetailed(chain: string, tokenAddress: string, opts: RunScanOptions): Promise<{ scan: Scan; debug: ScanDebug }> {
  const callerSignal = opts.signal;
  const internal = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, internal.signal]) : internal.signal;
  const out = (e: ScanEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* a broken listener must not kill the scan */
    }
  };
  const fail = (message: string, retryable: boolean, cause?: unknown): never => {
    out({ type: "error", message, retryable });
    throw new ScanError(message, retryable, cause);
  };

  // First fatal error of a concurrent stage: it aborts the others, whose AbortErrors must not hide it.
  let firstFatal: unknown = null;
  const onStageError = (err: unknown) => {
    if (isFatal(err) && !isAbortError(err) && firstFatal === null) {
      firstFatal = err;
      internal.abort();
    }
  };
  /** The concurrent finding stages once started: a failed scan waits for them so their calls are counted. */
  let running: Promise<unknown>[] = [];

  try {
    return await run();
  } catch (caught) {
    internal.abort();
    if (running.length) await Promise.allSettled(running);
    const err = isAbortError(caught) && firstFatal !== null && !callerSignal?.aborted ? firstFatal : caught;
    if (err instanceof ScanError || isAbortError(err) || callerSignal?.aborted) throw err;
    if (err instanceof MissingKeyError) return fail(NO_KEY_MESSAGE, false, err);
    return fail(describeError(err), err instanceof NansenError ? err.retryable : false, err);
  } finally {
    internal.abort();
  }

  async function run(): Promise<{ scan: Scan; debug: ScanDebug }> {
    const c = chain.trim().toLowerCase();
    const raw = tokenAddress.trim();
    if (!isSupportedChain(c)) return fail(`Chain "${c}" is not supported. Try one of: ${SUPPORTED_CHAINS.join(", ")}`, false);
    if (!isValidAddress(c, raw)) return fail(`"${raw}" is not a valid ${c} token address`, false);
    const token = isEvmChain(c) ? raw.toLowerCase() : raw;
    const tier = opts.tier;
    const deep = tier === "deep";
    const rules = opts.rules ?? RULES;
    const now = opts.now ?? new Date();
    const maxBuyers = clampInt(opts.maxBuyers, DEFAULT_MAX_BUYERS, MAX_BUYERS_CAP);
    const maxHolders = clampInt(opts.maxHolders, DEFAULT_MAX_HOLDERS, MAX_HOLDERS_CAP);
    const concurrency = Math.max(1, nansenConcurrency());
    const film = lastDays(now, FILM_DAYS);

    // ---- lanes & call tracking -------------------------------------------------------------
    const lanes: Record<FindingKey, Lane> = {
      context: new Lane(out),
      buyers: new Lane(out),
      flow: new Lane(out),
      walls: new Lane(out),
      smart: new Lane(out),
      you: new Lane(out),
    };
    // Context calls are released right after the meta event (same order as the replay player).
    lanes.you.open();
    const tracker = new CallTracker({
      signal,
      emit: (finding, e) => lanes[finding].emit(e),
      virtualClock: opts.virtualClock,
      concurrency,
      onCall: opts.onCall,
    });

    const debug: ScanDebug = {
      buyers: {
        mode: "unavailable",
        eligible: 0,
        analysed: 0,
        traced: 0,
        untraced: 0,
        failed: 0,
        maxHubShare: 0,
        maxHubLabel: null,
        walletHub: { address: null, label: null, wallets: 0 },
      },
      flows: {
        smart_money: { ok: false, buckets: 0, movingHours: 0 },
        whale: { ok: false, buckets: 0, movingHours: 0 },
        public_figure: { ok: false, buckets: 0, movingHours: 0 },
        exchange: { ok: false, buckets: 0, movingHours: 0 },
        intel: false,
      },
      walls: {
        method: deep ? "cost_basis" : "recent_buyers",
        requested: 0,
        pnlOk: 0,
        withCost: 0,
        noHistory: 0,
        failures: 0,
        skipped: 0,
        spared: 0,
        monthForSkips: false,
        allocations: 0,
        zeroCostKept: 0,
        allocatedShare: 0,
        recentBuyerHolders: 0,
        pnlCoverage: 0,
        proxyBuyers: 0,
      },
      smart: { wallets: 0, callsOk: 0 },
    };

    // ---- context ------------------------------------------------------------------------------
    out({ type: "stage", stage: "context", message: stageMessage("context") });
    const [infoRes, ohlcvRes, tradesRes] = await allSettledOrThrow([
      settle(tracker.call("context", EP.tokenInformation, { chain: c, token, timeframe: "1d" }, (o) => getTokenInformation(c, token, o))),
      settle(
        tracker.call("context", EP.tokenOhlcv, { chain: c, token, timeframe: "1h", window: "7d" }, (o) =>
          getTokenOhlcv(c, token, { from: film.from, to: film.to }, o),
        ),
      ),
      settle(
        tracker.call("context", EP.tgmDexTrades, { chain: c, token, action: "BUY", window: "7d", top: BIG_BUYS_LIMIT }, (o) =>
          getTgmDexTrades(
            c,
            token,
            film,
            { action: "BUY", perPage: BIG_BUYS_LIMIT, orderBy: [{ field: "estimated_value_usd", direction: "DESC" }] },
            { ...o, timeoutMs: BIG_BUYS_TIMEOUT_MS },
          ),
        ),
      ),
    ]);
    const info = infoRes.ok ? infoRes.value.data.data : null;
    // Young tokens: token-information may return "" / 0 for symbol, name, market cap, supply and
    // liquidity. One token-screener lookup by address (1 credit, cached 60 min, in the estimate) fills
    // them unless the caller's hints already do; a failed or empty lookup changes nothing. search/general
    // is never asked about an address (that kind of lookup may cost 500 credits on the MCP twin).
    let lookup: ScanHints | null = null;
    if (needsTokenLookup(info, opts.hints) && SCREENER_CHAINS.has(c)) {
      const res = await settle(tracker.call("context", EP.tokenScreener, { chain: c, token, lookup: "token" }, (o) => lookupTokenScreener(c, token, o)));
      const row = res.ok ? screenerMatch(res.value.data.data, c, token) : null;
      if (row) lookup = hintsFromScreenerRow(row);
    }
    const hints = mergeHints(opts.hints, lookup);
    // The film is the 7 days up to the LAST candle, not up to "now": a response replayed from the
    // snapshot cache (warm-scans after xray-smoke) keeps its full week and a matching window.
    const allCloses: PricePoint[] = ohlcvRes.ok ? pricePoints(ohlcvRes.value.data.data) : [];
    const lastT = allCloses.length ? allCloses[allCloses.length - 1].t : NaN;
    const filmWindow = Number.isFinite(lastT)
      ? { from: isoMinute(lastT + HOUR_MS - FILM_WINDOW_MS), to: isoMinute(Math.min(now.getTime(), lastT + HOUR_MS)) }
      : film;
    const price: PricePoint[] = allCloses.filter((p) => p.t >= Date.parse(filmWindow.from) - HOUR_MS);
    const priceNow = resolvePriceNow(price, info, hints);
    if (!priceNow || !(priceNow > 0)) {
      lanes.context.open();
      const err = !infoRes.ok ? infoRes.error : !ohlcvRes.ok ? ohlcvRes.error : null;
      if (err instanceof NansenError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return fail(`Nansen has no data for this token (${describeError(err)})`, false, err);
      }
      return fail("Nansen has no price for this token yet", err instanceof NansenError ? err.retryable : false, err ?? undefined);
    }
    const bigBuys: BigBuy[] = tradesRes.ok ? bigBuysFromTrades(tradesRes.value.data.data, price) : [];
    const scanNo = opts.scanNo ?? (await nextScanNo());
    const meta = buildMeta({ chain: c, tokenAddress: token, info, price, scanNo, now, windowFrom: filmWindow.from, windowTo: filmWindow.to, hints });
    const supply = scanSupply(meta, info);
    /** The unit of tgm/holders ownership_percentage and of WallsFinding.allocatedShare. */
    const totalSupply = totalSupplyOf(info, hints);
    out({ type: "meta", meta, price, bigBuys });
    lanes.context.open();

    // ---- shared who-bought-sold reads ----------------------------------------------------------
    // The week's buyers serve finding 01 and rank the deep walls' holders (DEX buyers have a cost);
    // the 30-day buyers are the walls' proxy (quick tier, hybrid, fallback). Each is fetched once.
    type Traders = Settled<NansenResult<WhoBoughtSoldResponse>>;
    let weekBuyersP: Promise<Traders> | null = null;
    let monthBuyersP: Promise<Traders> | null = null;
    const weekBuyers = (): Promise<Traders> =>
      (weekBuyersP ??= settle(
        tracker.call("buyers", EP.whoBoughtSold, { chain: c, token, side: "BUY", window: "7d", all: true, perPage: BUYERS_PAGE }, (o) =>
          getTokenTraders(c, token, "BUY", lastDays(now, BUYERS_WINDOW_DAYS), { perPage: BUYERS_PAGE }, o),
        ),
      ));
    const monthBuyers = (): Promise<Traders> =>
      (monthBuyersP ??= settle(
        tracker.call("walls", EP.whoBoughtSold, { chain: c, token, side: "BUY", window: "30d", all: true, perPage: BUYERS_PAGE }, (o) =>
          getTokenTraders(c, token, "BUY", lastDays(now, RECENT_BUYERS_WINDOW_DAYS), { perPage: BUYERS_PAGE }, o),
        ),
      ));

    // ---- the four findings, concurrently ------------------------------------------------------
    const stages = {
      buyers: buyersStage(),
      flow: flowStage(),
      walls: wallsStage(),
      smart: smartStage(),
    };
    // Awaited in order below; keep a later stage's early failure from surfacing as unhandled.
    for (const p of Object.values(stages)) p.catch(onStageError);
    running = Object.values(stages);

    const order: { key: "buyers" | "flow" | "walls" | "smart"; message: string }[] = [
      {
        key: "buyers",
        // Same wording as lib/xray/copy.ts stageMessage(), which the replay player uses.
        message: deep && isEvmChain(c) ? "Tracing who funded the top buyers" : "Reading this week's top buyers",
      },
      { key: "flow", message: stageMessage("flow") },
      { key: "walls", message: deep ? "Reading holders' entry prices" : "Reading recent buyers' entry prices" },
      { key: "smart", message: stageMessage("smart") },
    ];

    const findings = {} as Scan["findings"];
    for (const { key, message } of order) {
      out({ type: "stage", stage: key, message });
      lanes[key].open();
      if (key === "buyers") {
        findings.buyers = await stages.buyers;
        out({ type: "finding", key: "buyers", finding: findings.buyers });
      } else if (key === "flow") {
        findings.flow = await stages.flow;
        out({ type: "finding", key: "flow", finding: findings.flow });
      } else if (key === "walls") {
        findings.walls = await stages.walls;
        out({ type: "finding", key: "walls", finding: findings.walls });
      } else {
        findings.smart = await stages.smart;
        out({ type: "finding", key: "smart", finding: findings.smart });
      }
    }

    // ---- diagnosis & assembly ---------------------------------------------------------------
    out({ type: "stage", stage: "diagnosis", message: stageMessage("diagnosis") });
    const diagnosis = safeDiagnose(findings, meta);
    out({ type: "diagnosis", diagnosis });

    const finishedAt = opts.now ? new Date(now.getTime() + tracker.elapsed()) : new Date();
    // Gallery mode re-derives a scan from cached responses: date it by its oldest price / flow data,
    // not by today (a scan warmed a day after the smoke test must not claim to be fresh).
    const dataAt = opts.virtualClock ? tracker.oldestCachedAt(["context", "flow"]) : null;
    const scannedAt = dataAt !== null && dataAt < finishedAt.getTime() ? new Date(dataAt) : finishedAt;
    const finalMeta: ScanMeta = { ...meta, scannedAt: scannedAt.toISOString() };
    const scan: Scan = {
      version: 1,
      tier,
      meta: finalMeta,
      price,
      bigBuys,
      findings,
      diagnosis,
      calls: tracker.calls,
      totals: tracker.totals(),
    };
    out({ type: "stage", stage: "done", message: stageMessage("done", scan) });
    out({ type: "done", scan });
    return { scan, debug };

    // ============================================================ stages

    async function buyersStage(): Promise<BuyersFinding> {
      const res = await weekBuyers();
      if (!res.ok) return emptyBuyersFinding("This week's buyers could not be read.");
      const prepared = prepareBuyers(res.value.data.data, c, token, BUYERS_PAGE, res.value.data.pagination.is_last_page);
      // token-information's 24h unique buyers: a floor for the week when the who-bought-sold page is full.
      const buyers24h = meta.buyers24h;
      debug.buyers.eligible = prepared.buyers.length;
      if (!deep) {
        debug.buyers.mode = "quick";
        return concentrationFinding(prepared, "quick", rules.demand, buyers24h);
      }
      if (!isEvmChain(c)) {
        debug.buyers.mode = "non_evm";
        return concentrationFinding(prepared, "non_evm", rules.demand, buyers24h);
      }

      const analysed = prepared.buyers.slice(0, maxBuyers);
      const lookups = new Map<string, FunderLookup>();
      let ok = 0;
      let failedInARow = 0;
      let stopped = false;
      await pool(analysed, concurrency, () => stopped || signal.aborted, async (b) => {
        const key = normalizeAddress(c, b.address);
        try {
          const r = await tracker.call("buyers", EP.firstFunder, { address: key }, (o) => getFirstFunder(key, o));
          lookups.set(key, lookupFromRows(r.data.data));
          ok++;
          failedInARow = 0;
        } catch (err) {
          if (isFatal(err)) throw err;
          lookups.set(key, { status: "failed" });
          // 403 = the plan cannot use the profiler: every other lookup would fail the same way.
          if (err instanceof NansenError && err.isForbidden) stopped = true;
          if (ok === 0 && ++failedInARow >= FANOUT_BREAKER) stopped = true;
        }
      });
      const clustering = clusterBuyers(c, analysed, lookups);
      debug.buyers = {
        mode: clustering.traced + clustering.untraced > 0 ? "traced" : "unavailable",
        eligible: prepared.buyers.length,
        analysed: analysed.length,
        traced: clustering.traced,
        untraced: clustering.untraced,
        failed: clustering.failed,
        maxHubShare: clustering.maxHubShare,
        maxHubLabel: clustering.maxHubLabel,
        walletHub: clustering.walletHub,
      };
      return tracedFinding(prepared, analysed, clustering, rules.demand, buyers24h);
    }

    async function flowStage(): Promise<FlowFinding> {
      const flowsWindow = { from: isoMinute(now.getTime() - FLOWS_HOURS * HOUR_MS), to: isoMinute(now.getTime()) };
      const results = await allSettledOrThrow(
        FLOW_LABELS.map((label) =>
          settle(
            tracker.call("flow", EP.tgmFlows, { chain: c, token, label, window: "7d", perPage: FLOWS_PAGE }, (o) =>
              getTgmFlows(c, token, label, flowsWindow, FLOWS_PAGE, o),
            ),
          ),
        ),
      );
      const intelRes = await settle(
        tracker.call("flow", EP.flowIntelligence, { chain: c, token, timeframe: "7d" }, (o) => getFlowIntelligenceWindow(c, token, "7d", o)),
      );
      const rows: Partial<Record<ScanFlowLabel, TgmFlowRow[] | null>> = {};
      FLOW_LABELS.forEach((label, i) => {
        const r = results[i];
        rows[label] = r.ok ? r.value.data.data : null;
        const data = r.ok ? r.value.data.data : [];
        let moving = 0;
        for (let k = 1; k < data.length; k++) if ((data[k].token_amount ?? 0) !== (data[k - 1].token_amount ?? 0)) moving++;
        debug.flows[label] = { ok: r.ok, buckets: data.length, movingHours: moving };
      });
      const intel: FlowIntelligenceRow | null = intelRes.ok ? (intelRes.value.data.data[0] ?? null) : null;
      debug.flows.intel = intelRes.ok && intel !== null;
      if (results.every((r) => !r.ok) && !intel) return emptyFlowFinding();
      return buildFlowFinding(
        { rows, intel, intelOk: intelRes.ok && intel !== null, supply, marketCapUsd: meta.marketCapUsd, price },
        rules.flow,
      );
    }

    async function recentBuyersWalls(allocatedShare = 0): Promise<WallsFinding> {
      debug.walls.method = "recent_buyers";
      const res = await monthBuyers();
      const extra = allocatedShare > 0 ? { allocatedShare } : undefined;
      if (!res.ok) return { ...emptyWallsFinding("recent_buyers"), ...(extra ?? {}) };
      const holders = recentBuyerEntries(res.value.data.data, c, token, supply, priceNow as number).map((e) => e.point);
      debug.walls.requested = holders.length;
      debug.walls.withCost = holders.length;
      return buildWallsFinding(
        { method: "recent_buyers", holders, priceNow: priceNow as number, liquidityUsd: meta.liquidityUsd, supply, price, extra },
        rules.ceiling,
      );
    }

    async function wallsStage(): Promise<WallsFinding> {
      if (!deep) return recentBuyersWalls();
      const holdersRes = await settle(
        tracker.call("walls", EP.holders, { chain: c, token, list: "all_holders", perPage: 1000 }, (o) => getHolders(c, token, "all_holders", 1000, o)),
      );
      // No holder list (plan / chain / upstream): fall back to the 30-day buyer proxy (1 credit).
      if (!holdersRes.ok) return recentBuyersWalls();

      // Holders that bought on a DEX this week demonstrably have a cost: they are asked first.
      const week = await weekBuyers();
      const recent = week.ok ? buyerKeys(week.value.data.data, c, token) : new Set<string>();
      const planInput: PlanInput = { chain: c, tokenAddress: token, rows: holdersRes.value.data.data, recentBuyers: recent, maxHolders, supply, totalSupply };
      let plan = planPnlHolders(planInput);
      // Known DEX buyers are never allocations. Before skipping anyone, read the 30-day buyer list too
      // (1 credit, fetched once: the hybrid blend reuses it) and plan again with its buyers spared.
      let known: ReadonlySet<string> = recent;
      if (plan.skipped.length) {
        debug.walls.monthForSkips = true;
        const month = await monthBuyers();
        if (month.ok) {
          known = new Set([...recent, ...buyerKeys(month.value.data.data, c, token)]);
          plan = planPnlHolders({ ...planInput, knownBuyers: known });
        }
      }
      debug.walls.requested = plan.chosen.length;
      debug.walls.skipped = plan.skipped.length;
      debug.walls.spared = plan.spared;
      debug.walls.recentBuyerHolders = plan.chosen.filter((h) => h.recentBuyer).length;
      const windows = pnlWindows(meta.deployedAt, now);
      const pnlHolders: KeyedHolder[] = [];
      /** pnl allocations by wallet: excluded from walls; share of total supply. */
      const allocations = new Map<string, { point: HolderPoint; share: number }>();
      const allocatedShare = () => clamp01(plan.skippedShare + [...allocations.values()].reduce((s, a) => s + a.share, 0));
      let ok = 0;
      let failures = 0;
      let failedInARow = 0;
      let stopped = false;
      let forbidden = false;
      await pool(plan.chosen, concurrency, () => stopped || signal.aborted, async (h) => {
        let rows: PnlRow[] | null = null;
        let window: DateWindow | null = null;
        try {
          const res = await tracker.callWindows(
            "walls",
            EP.addressPnl,
            windows,
            (w) => ({ chain: c, token, address: h.key, window: w.label }),
            (w, o) => getAddressPnl(c, h.address, token, { from: w.from, to: w.to }, o),
          );
          rows = res.data.data;
          window = res.window;
          ok++;
          failedInARow = 0;
        } catch (err) {
          if (isFatal(err)) throw err;
          failures++;
          if (err instanceof NansenError && err.isForbidden) {
            forbidden = true;
            stopped = true;
          }
          if (ok === 0 && ++failedInARow >= FANOUT_BREAKER) stopped = true;
          return;
        }
        const coversHistory = !!window && windowCoversHistory(window, meta.deployedAt);
        // A window covering the token's whole life that comes back empty: a contract / LP without history.
        if (rows && rows.length === 0 && coversHistory) {
          debug.walls.noHistory++;
          return;
        }
        const point = deriveHolder({
          id: h.id,
          cohort: "other",
          chain: c,
          tokenAddress: token,
          address: h.address,
          label: h.label,
          tokenAmount: h.tokenAmount,
          ownershipPct: h.ownershipPct,
          ownershipScale: plan.ownershipScale,
          supply,
          priceNow: priceNow as number,
          pnlRows: rows,
          // bought_usd 0 means "never bought" only if the window reached back to the deployment
          // (the "full" window, not a 90d / 30d fallback, on a token younger than 364 days).
          allocationAllowed: window?.label === "full" && coversHistory && !known.has(h.key),
        });
        // Received, never bought on a DEX (team / vesting, airdrops, exchange withdrawals): no entry
        // price, so not part of any wall.
        if (point.fog === "allocation") {
          allocations.set(h.key, { point, share: totalShareOf(h.ownershipPct, plan.ownershipScale, h.tokenAmount, plan.totalSupply) ?? 0 });
          return;
        }
        if (point.fog === "no_cost" && rows && isAllocationRecord(pickPnlRecord(rows, c, token), priceNow as number)) debug.walls.zeroCostKept++;
        pnlHolders.push({ key: h.key, point });
      });
      const settleAllocations = () => {
        debug.walls.allocations = allocations.size;
        debug.walls.allocatedShare = allocatedShare();
      };
      settleAllocations();
      debug.walls.pnlOk = ok;
      debug.walls.failures = failures;
      if (forbidden || ok === 0) return recentBuyersWalls(allocatedShare());
      pnlHolders.sort((a, b) => a.point.id - b.point.id);
      const pnlPoints = pnlHolders.map((e) => e.point);
      const coverage = pnlCostCoverage(pnlPoints);
      debug.walls.pnlCoverage = coverage;
      debug.walls.withCost = pnlPoints.filter((x) => x.cost !== null).length;

      // Hybrid: the holders' own cost basis covers too little of what they hold. Blend in this month's
      // buyers that pnl did not price (volume-weighted buy price, the quick tier's proxy; 1 credit).
      if (coverage < HYBRID_BELOW) {
        const month = await monthBuyers();
        if (month.ok) {
          const proxy = recentBuyerEntries(month.value.data.data, c, token, supply, priceNow as number);
          // A 30-day DEX buyer is never an allocation (when the list was read before the pnl calls,
          // none was called one): one pnl read as such goes back in as a "no_cost" fog point, which
          // its proxy entry replaces if it still holds. Nothing is excluded from the blend.
          const monthKeys = buyerKeys(month.value.data.data, c, token);
          const blendIn = [...pnlHolders];
          for (const [key, a] of allocations) {
            if (!monthKeys.has(key)) continue;
            allocations.delete(key);
            debug.walls.zeroCostKept++;
            blendIn.push({ key, point: { ...a.point, fog: "no_cost", cost: null, multiple: null } });
          }
          settleAllocations();
          blendIn.sort((a, b) => a.point.id - b.point.id);
          const blend = blendRecentBuyers(blendIn, proxy);
          if (blend.recentBuyers > 0) {
            debug.walls.method = "hybrid";
            debug.walls.proxyBuyers = blend.recentBuyers;
            return buildWallsFinding(
              {
                method: "hybrid",
                holders: blend.holders,
                holdersAnalyzed: ok + blend.recentBuyers,
                priceNow: priceNow as number,
                liquidityUsd: meta.liquidityUsd,
                supply,
                price,
                failures,
                extra: { costBasisHolders: blend.costBasisHolders, recentBuyers: blend.recentBuyers, allocatedShare: allocatedShare() },
              },
              rules.ceiling,
            );
          }
        }
      }
      return buildWallsFinding(
        {
          method: "cost_basis",
          holders: pnlPoints,
          holdersAnalyzed: ok,
          priceNow: priceNow as number,
          liquidityUsd: meta.liquidityUsd,
          supply,
          price,
          failures,
          extra: { costBasisHolders: debug.walls.withCost, allocatedShare: allocatedShare() },
        },
        rules.ceiling,
      );
    }

    async function smartStage(): Promise<SmartFinding> {
      const window = lastDays(now, SMART_WINDOW_DAYS);
      const results = await allSettledOrThrow(
        (["BUY", "SELL"] as const).map((side) =>
          settle(
            tracker.call("smart", EP.whoBoughtSold, { chain: c, token, side, window: "30d", smartMoney: true }, (o) =>
              getTokenTraders(c, token, side, window, { perPage: 1000, labels: SMART_MONEY_LABELS }, o),
            ),
          ),
        ),
      );
      const rows: (WhoBoughtSoldRow[] | null)[] = results.map((r) => (r.ok ? r.value.data.data : null));
      const finding = aggregateSmart(c, rows, priceNow as number, rules.smart);
      debug.smart = { wallets: finding.wallets, callsOk: results.filter((r) => r.ok).length };
      return finding;
    }
  }
}
