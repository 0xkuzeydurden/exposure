// Live scene pipeline: token-information + ohlcv → holders ×4 + who-bought-sold ×2 → one
// profiler/address/pnl per holder → flow-intelligence → Scene. Streams SceneEvents as it goes.
import { getAddressPnl, getFlowIntelligence, getHolders, getTokenInformation, getTokenOhlcv, getWhoBoughtSold, type HolderList } from "../nansen/api";
import { isEvmChain, isSupportedChain, isValidAddress, normalizeAddress, SUPPORTED_CHAINS } from "../nansen/chains";
import { nansenConcurrency, type NansenRequestOptions, type NansenResult } from "../nansen/client";
import { EP } from "../nansen/endpoints";
import { describeError, isAbortError, MissingKeyError, NansenError } from "../nansen/errors";
import type { HolderRow, PnlRow } from "../nansen/schemas";
import type { CallRecord, CohortFlow, HolderPoint, OhlcvPoint, Scene, SceneEvent, SceneMeta } from "../types";
import {
  computeCoverage,
  deriveHolder,
  fallbackPrice,
  mapFlows,
  ohlcvRange,
  ohlcvToPoints,
  pnlWindows,
  selectHolders,
  shareOf,
  supplyBasis,
  windowCoversHistory,
  type DateWindow,
} from "./derive";

export const NO_KEY_MESSAGE = "NANSEN_API_KEY is not set. Gallery replays still work.";
export const DEFAULT_MAX_HOLDERS = 200;
export const MAX_HOLDERS_CAP = 1000;
/** If this many profiler calls in a row fail before any succeeds, the endpoint is unusable: stop. */
const PNL_FAILURE_BREAKER = 12;

/** Documented credits for one build: info + ohlcv + 4 holder lists × 5 + 2 who-bought-sold + flows + 1 pnl per holder. */
export function estimateBuildCredits(maxHolders: number): number {
  return 1 + 1 + 4 * 5 + 2 + 1 + Math.max(0, Math.floor(maxHolders));
}

export interface BuildOptions {
  /** Holders analysed with a pnl call (1 credit each). Default env MAX_HOLDERS or 200. */
  maxHolders?: number;
  onEvent?: (e: SceneEvent) => void;
  signal?: AbortSignal;
  /** Attach short address / entity labels to holders (live local mode only; stripped from public scenes). */
  includeTags?: boolean;
  /**
   * Advance `CallRecord.at` by each cache hit's original latency / concurrency, so a scene re-derived
   * from the disk cache replays with the rhythm of the original network build (used by warm).
   */
  virtualClock?: boolean;
  /** Override "now" (tests / reproducible snapshots). */
  now?: Date;
}

/** Fatal pipeline failure. The matching `{type:'error'}` event has already been emitted. */
export class BuildError extends Error {
  readonly name = "BuildError";
  constructor(
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Errors that must stop the whole build instead of degrading one holder / one optional call. */
function isFatal(err: unknown): boolean {
  return isAbortError(err) || err instanceof MissingKeyError || (err instanceof NansenError && err.isAccountLevel);
}

function failedCall(err: NansenError) {
  return { status: err.status, credits: err.credits, ms: err.ms, cached: false };
}

export function maxHoldersFromEnv(): number {
  const n = Number.parseInt(process.env.MAX_HOLDERS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HOLDERS;
}

const HOLDER_LISTS: HolderList[] = ["all_holders", "whale", "public_figure", "exchange"];

export async function buildScene(chain: string, tokenAddress: string, opts: BuildOptions = {}): Promise<Scene> {
  const callerSignal = opts.signal;
  // Cancels in-flight calls once the build has failed (e.g. out of credits mid fan-out).
  const internal = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, internal.signal]) : internal.signal;
  const emit = (e: SceneEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* a broken listener must not kill the build */
    }
  };
  const fail = (message: string, retryable: boolean, cause?: unknown): never => {
    emit({ type: "error", message, retryable });
    throw new BuildError(message, retryable, cause);
  };

  try {
    return await run();
  } catch (err) {
    if (err instanceof BuildError || isAbortError(err) || callerSignal?.aborted) throw err;
    if (err instanceof MissingKeyError) return fail(NO_KEY_MESSAGE, false, err);
    return fail(describeError(err), err instanceof NansenError ? err.retryable : false, err);
  } finally {
    internal.abort();
  }

  async function run(): Promise<Scene> {
    chain = chain.trim().toLowerCase();
    tokenAddress = tokenAddress.trim();
    if (!isSupportedChain(chain)) {
      return fail(`Chain "${chain}" is not supported. Try one of: ${SUPPORTED_CHAINS.join(", ")}`, false);
    }
    if (!isValidAddress(chain, tokenAddress)) return fail(`"${tokenAddress}" is not a valid ${chain} token address`, false);
    const token = isEvmChain(chain) ? tokenAddress.toLowerCase() : tokenAddress;
    const now = opts.now ?? new Date();
    const requested = Math.floor(opts.maxHolders ?? maxHoldersFromEnv());
    const maxHolders = Number.isFinite(requested) ? Math.min(MAX_HOLDERS_CAP, Math.max(1, requested)) : DEFAULT_MAX_HOLDERS;
    const concurrency = Math.max(1, nansenConcurrency());

    // ---- call tracking -------------------------------------------------------------------
    const started = performance.now();
    let virtualOffset = 0;
    const calls: CallRecord[] = [];
    const record = (
      endpoint: string,
      r: { status: number; credits: number; ms: number; cached: boolean; origin?: NansenResult<unknown>["origin"] },
      holderId?: number,
    ) => {
      if (opts.virtualClock && r.cached && r.origin) virtualOffset += r.origin.ms / concurrency;
      const call: CallRecord = {
        endpoint,
        status: r.status,
        credits: r.credits,
        ms: r.ms,
        cached: r.cached,
        at: Math.round(performance.now() - started + virtualOffset),
        ...(holderId !== undefined ? { holderId } : {}),
      };
      calls.push(call);
      emit({ type: "call", call });
    };

    const tracked = async <T>(
      endpoint: string,
      cacheKey: unknown,
      fn: (o: NansenRequestOptions) => Promise<NansenResult<T>>,
    ): Promise<NansenResult<T>> => {
      try {
        const res = await fn({ signal, cacheKey });
        record(endpoint, res);
        return res;
      } catch (err) {
        if (err instanceof NansenError) record(endpoint, failedCall(err));
        throw err;
      }
    };

    /** Tries each date window in turn while the API says the range is too wide (invalid_date_range, query_timeout). */
    const trackedWindows = async <T>(
      endpoint: string,
      windows: DateWindow[],
      cacheKey: (w: DateWindow) => unknown,
      fn: (w: DateWindow, o: NansenRequestOptions) => Promise<NansenResult<T>>,
      holderId?: number,
    ): Promise<NansenResult<T> & { window: DateWindow }> => {
      for (let i = 0; ; i++) {
        const w = windows[i];
        const last = i === windows.length - 1;
        try {
          const res = await fn(w, { signal, cacheKey: cacheKey(w) });
          record(endpoint, res, holderId);
          return { ...res, window: w };
        } catch (err) {
          if (!(err instanceof NansenError)) throw err;
          const next = err.shouldNarrowRange && !last;
          record(endpoint, failedCall(err), next ? undefined : holderId);
          if (!next) throw err;
        }
      }
    };

    const settle = <T>(p: Promise<T>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          if (isFatal(error)) throw error;
          return { ok: false as const, error };
        },
      );

    // ---- a. token profile + price --------------------------------------------------------
    emit({ type: "stage", stage: "info", message: "Reading token profile and 30 days of hourly price" });
    const range = ohlcvRange(now);
    const [infoRes, ohlcvRes] = await Promise.all([
      tracked(EP.tokenInformation, { chain, token, timeframe: "1d" }, (o) => getTokenInformation(chain, token, o)),
      settle(
        tracked(EP.tokenOhlcv, { chain, token, timeframe: "1h", window: "30d" }, (o) => getTokenOhlcv(chain, token, range, o)),
      ),
    ]);

    const info = infoRes.data.data;
    const details = info.token_details;
    const spot = info.spot_metrics;
    const ohlcv: OhlcvPoint[] = ohlcvRes.ok ? ohlcvToPoints(ohlcvRes.value.data.data) : [];
    const priceNow = ohlcv.length ? ohlcv[ohlcv.length - 1].c : fallbackPrice(details);
    if (!priceNow || !(priceNow > 0)) return fail("Nansen has no price for this token yet", false);

    const windows = pnlWindows(details.token_deployment_date, now);
    const supply = supplyBasis(details.circulating_supply, details.total_supply, details.market_cap_usd, priceNow);
    const meta: SceneMeta = {
      chain,
      tokenAddress: token,
      symbol: info.symbol ?? "?",
      name: info.name ?? info.symbol ?? token,
      ...(info.logo ? { logo: info.logo } : {}),
      priceNow,
      liquidityUsd: spot.liquidity_usd,
      marketCapUsd: details.market_cap_usd,
      circulatingSupply: details.circulating_supply ?? details.total_supply ?? null,
      totalHolders: spot.total_holders,
      deployedAt: details.token_deployment_date,
      pnlFrom: windows[0].from.slice(0, 10),
      pnlTo: windows[0].to.slice(0, 10),
      generatedAt: now.toISOString(),
    };
    emit({ type: "meta", meta, ohlcv });

    // ---- b + c. holder lists and the smart-money set (in parallel) -------------------------
    emit({ type: "stage", stage: "holders", message: "Fetching holder lists: all · whale · public figure · exchange" });
    const holderCalls = HOLDER_LISTS.map((list) =>
      settle(
        tracked(EP.holders, { chain, token, list, perPage: 1000 }, (o) => getHolders(chain, token, list, 1000, o)),
      ),
    );
    const smCalls = (["BUY", "SELL"] as const).map((side) =>
      settle(
        trackedWindows(
          EP.whoBoughtSold,
          windows,
          (w) => ({ chain, token, side, window: w.label }),
          (w, o) => getWhoBoughtSold(chain, token, side, { from: w.from, to: w.to }, o),
        ),
      ),
    );

    // Awaited after the holder lists; keep an early abort from surfacing as an unhandled rejection.
    for (const p of smCalls) p.catch(() => undefined);

    const lists = await Promise.all(holderCalls);
    const rowsOf = (i: number): HolderRow[] => {
      const r = lists[i];
      return r.ok ? r.value.data.data : [];
    };
    if (!lists[0].ok) {
      const err = lists[0].error;
      return fail(describeError(err), err instanceof NansenError ? err.retryable : false, err);
    }
    const skipped = HOLDER_LISTS.filter((_, i) => !lists[i].ok);

    emit({
      type: "stage",
      stage: "cohorts",
      message:
        "Tagging Smart Money via who-bought-sold" + (skipped.length ? ` (holder lists unavailable: ${skipped.join(", ")})` : ""),
    });
    const smResults = await Promise.all(smCalls);
    const smartMoney: string[] = [];
    for (const r of smResults) if (r.ok) for (const row of r.value.data.data) if (row.address) smartMoney.push(row.address);

    const selection = selectHolders({
      chain,
      tokenAddress: token,
      allHolders: rowsOf(0),
      whales: rowsOf(1),
      publicFigures: rowsOf(2),
      exchanges: rowsOf(3),
      smartMoney,
      maxHolders,
      supply,
    });
    emit({
      type: "cohorts",
      counts: selection.counts,
      coverage: { exchangeShare: selection.exchangeShare, contractShare: selection.contractShare },
    });

    // ---- e. cost basis: one profiler pnl call per holder ---------------------------------
    emit({
      type: "stage",
      stage: "costbasis",
      message: `Reading cost basis for ${selection.chosen.length} holders (1 profiler call each)`,
    });
    const holders: HolderPoint[] = [];
    // Holders whose pnl window spans the token's whole life yet came back empty: contracts / PDAs.
    let noHistoryShare = 0;
    let noHistoryCount = 0;
    let pnlSucceeded = 0;
    let pnlFailedInARow = 0;
    await Promise.all(
      selection.chosen.map(async (c) => {
        let pnlRows: PnlRow[] | null = null;
        let window: DateWindow | null = null;
        try {
          const res = await trackedWindows(
            EP.addressPnl,
            windows,
            (w) => ({ chain, token, address: c.key, window: w.label }),
            (w, o) => getAddressPnl(chain, c.address, token, { from: w.from, to: w.to }, o),
            c.id,
          );
          pnlRows = res.data.data;
          window = res.window;
          pnlSucceeded += 1;
        } catch (err) {
          if (signal.aborted || isFatal(err)) throw err;
          // 403: no access to the profiler (plan tier): every other holder would fail the same way.
          if (err instanceof NansenError && err.isForbidden) throw err;
          pnlFailedInARow = pnlSucceeded === 0 ? pnlFailedInARow + 1 : 0;
          if (pnlFailedInARow >= PNL_FAILURE_BREAKER) throw err;
        }
        if (pnlRows && pnlRows.length === 0 && window && windowCoversHistory(window, details.token_deployment_date)) {
          noHistoryShare += shareOf(c.tokenAmount, c.ownershipPct, supply, selection.ownershipScale);
          noHistoryCount += 1;
          return;
        }
        const holder = deriveHolder({
          id: c.id,
          cohort: c.cohort,
          chain,
          tokenAddress: token,
          address: c.address,
          label: c.label,
          tokenAmount: c.tokenAmount,
          ownershipPct: c.ownershipPct,
          ownershipScale: selection.ownershipScale,
          supply,
          priceNow,
          pnlRows,
          includeTags: opts.includeTags,
        });
        holders.push(holder);
        emit({ type: "holder", holder });
      }),
    );

    // ---- f. flows (non-fatal) --------------------------------------------------------------
    emit({ type: "stage", stage: "flows", message: "Reading 24h cohort flows" });
    let flows: CohortFlow[] = [];
    const flowRes = await settle(
      tracked(EP.flowIntelligence, { chain, token, timeframe: "1d" }, (o) => getFlowIntelligence(chain, token, o)),
    );
    if (flowRes.ok) flows = mapFlows(flowRes.value.data.data[0]);

    // ---- g. assemble -----------------------------------------------------------------------
    holders.sort((a, b) => a.id - b.id);
    const scene: Scene = {
      version: 1,
      meta,
      holders,
      coverage: computeCoverage(holders, selection.exchangeShare, selection.contractShare + noHistoryShare),
      ohlcv,
      flows,
      calls,
      totals: {
        calls: calls.length,
        networkCalls: calls.filter((c) => !c.cached).length,
        credits: calls.reduce((s, c) => s + c.credits, 0),
        cacheHits: calls.filter((c) => c.cached).length,
        durationMs: Math.round(performance.now() - started + virtualOffset),
      },
    };
    const fogCount = holders.filter((h) => h.fog).length;
    const noHistory = noHistoryCount ? ` · ${noHistoryCount} contracts without history` : "";
    emit({
      type: "stage",
      stage: "done",
      message: `${holders.length} holders analysed · ${fogCount} in fog${noHistory} · ${scene.totals.credits} credits`,
    });
    emit({ type: "done", scene });
    return scene;
  }
}

/** Normalised identity used for file names: `<chain>-<address>` (lowercase address on EVM). */
export function sceneId(chain: string, tokenAddress: string): string {
  const c = chain.trim().toLowerCase();
  return `${c}-${normalizeAddress(c, tokenAddress.trim())}`;
}
