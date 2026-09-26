import "server-only";
import type { NextRequest } from "next/server";
import { isEvmChain, isSupportedChain, isValidAddress } from "@/lib/nansen/chains";
import { hasNansenKey } from "@/lib/nansen/client";
import { flushLedger } from "@/lib/nansen/ledger";
import { admitScan, budgetEvent, clientIp, estimateCredits, liveScanLimits, settleTicket } from "@/lib/xray/budget";
import { NO_KEY_MESSAGE, runScan, ScanError } from "@/lib/xray/pipeline/run";
import { hasSharedScan, joinSharedScan, sharedScanKey } from "@/lib/xray/pipeline/shared";
import { stageMessage } from "@/lib/xray/copy";
import { playScan } from "@/lib/xray/replay";
import { loadLatestScan, loadPublicScan, saveRecordedScan, scanAgeMs, scanId } from "@/lib/xray/store";
import type { Scan, ScanEvent, Tier } from "@/lib/xray/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A recorded scan younger than this is replayed instead of re-scanned (EXPOSURE_SCAN_TTL_MIN, default 60). */
function recordedTtlMs(): number {
  const n = Number(process.env.EXPOSURE_SCAN_TTL_MIN);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 60_000;
}

/** Every event of a recorded scan at once, in stream order (used if the replay player is unavailable). */
function instantEvents(scan: Scan): ScanEvent[] {
  const events: ScanEvent[] = [{ type: "stage", stage: "context", message: stageMessage("context", scan) }];
  events.push({ type: "meta", meta: scan.meta, price: scan.price, bigBuys: scan.bigBuys });
  for (const call of scan.calls) if (call.finding === "context") events.push({ type: "call", call });
  for (const key of ["buyers", "flow", "walls", "smart"] as const) {
    events.push({ type: "stage", stage: key, message: stageMessage(key, scan) });
    for (const call of scan.calls) if (call.finding === key) events.push({ type: "call", call });
    events.push({ type: "finding", key, finding: scan.findings[key] } as ScanEvent);
  }
  events.push({ type: "stage", stage: "diagnosis", message: stageMessage("diagnosis", scan) }, { type: "diagnosis", diagnosis: scan.diagnosis });
  events.push({ type: "stage", stage: "done", message: stageMessage("done", scan) }, { type: "done", scan });
  return events;
}

/**
 * GET /api/scan/:chain/:token?tier=quick|deep[&fresh=1][&speed=6]: Server-Sent Events, one ScanEvent
 * JSON per `data:` message. The stream closes after `done`, `error` or `budget`; clients should call
 * EventSource.close() on any of them (a reconnect would ask for another scan).
 *
 *   1. A live scan of this token recorded in the last EXPOSURE_SCAN_TTL_MIN minutes (default 60), else
 *      its gallery scan (public/scans, any age), is replayed: 0 credits. A deep scan also answers a
 *      quick request. `fresh=1` skips this outside production only (it would let one visitor re-spend).
 *   2. No key → one `error` event. Live scans off / over budget / visitor limit → one `budget` event.
 *   3. A scan of the same token and tier already running on this server is joined (no new credits).
 *   4. Otherwise a live scan runs (live deep scans use EXPOSURE_LIVE_MAX_BUYERS / _HOLDERS, default 15),
 *      is saved to .cache/scans and settles the budget with the credits it really spent (counted as
 *      each call is made; a scan cut short keeps at least its whole reservation).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ chain: string; token: string }> }) {
  const { chain: rawChain, token: rawToken } = await params;
  const search = request.nextUrl.searchParams;
  const tier: Tier = search.get("tier") === "deep" ? "deep" : "quick";
  const fresh = search.get("fresh") === "1" && process.env.NODE_ENV !== "production";
  const speedParam = Number(search.get("speed"));
  const speed = Number.isFinite(speedParam) && speedParam > 0 ? Math.min(60, speedParam) : undefined;
  const ip = clientIp(request.headers);

  const chain = safeDecode(rawChain).trim().toLowerCase();
  const rawAddress = safeDecode(rawToken).trim();
  const token = isEvmChain(chain) ? rawAddress.toLowerCase() : rawAddress;

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let cleanup: (() => void) | undefined;
  const onClientGone = () => cleanup?.();
  request.signal.addEventListener("abort", onClientGone, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (e: ScanEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", onClientGone);
        const c = cleanup;
        cleanup = undefined;
        c?.();
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const terminal = (e: ScanEvent) => e.type === "done" || e.type === "error" || e.type === "budget";

      // Long reconnect delay: a finished scan must not be restarted by EventSource.
      write("retry: 600000\n\n");

      if (!isSupportedChain(chain) || !isValidAddress(chain, token)) {
        send({ type: "error", message: `"${rawAddress}" is not a valid ${chain} token address`, retryable: false });
        close();
        return;
      }

      // 1. Recent recording, or the gallery scan of this token → replay for 0 credits.
      if (!fresh) {
        const live = await loadLatestScan(chain, token, { tier, includePublic: false }).catch(() => null);
        const gallery = await loadPublicScan(chain, token).catch(() => null);
        const recorded =
          live && scanAgeMs(live) <= recordedTtlMs()
            ? live
            : gallery && (tier === "quick" || gallery.tier === "deep")
              ? gallery
              : null;
        if (recorded) {
          const onEvent = (e: ScanEvent) => {
            send(e);
            if (terminal(e)) close();
          };
          try {
            cleanup = playScan(recorded, onEvent, speed ? { speed } : undefined);
          } catch {
            for (const e of instantEvents(recorded)) onEvent(e);
          }
          if (closed) cleanup?.();
          return;
        }
      }

      // 2. Can we scan live at all?
      if (!hasNansenKey()) {
        send({ type: "error", message: NO_KEY_MESSAGE, retryable: false });
        close();
        return;
      }

      heartbeat = setInterval(() => write(`: keep-alive ${Date.now()}\n\n`), HEARTBEAT_MS);
      const key = sharedScanKey(scanId(chain, token), tier);
      const limits = liveScanLimits();
      const listener = {
        event: (e: ScanEvent) => {
          send(e);
          if (terminal(e)) close();
        },
        end: close,
      };

      // 3. Join a scan already running (it is already paid for).
      if (hasSharedScan(key)) {
        cleanup = joinSharedScan(key, () => Promise.resolve(), listener);
        if (closed) cleanup();
        return;
      }

      const admission = await admitScan({
        ip,
        chain,
        token,
        tier,
        estimate: estimateCredits(tier, chain, limits),
      });
      if (!admission.ok) {
        send(budgetEvent(admission));
        close();
        return;
      }
      if (closed) {
        // The client left while we were checking the budget: nothing was spent.
        await settleTicket(admission.ticket, 0);
        return;
      }
      // Another request for this token and tier started a scan while we were checking the budget:
      // join it and give the reservation back (its `run` below would never be called).
      if (hasSharedScan(key)) {
        await settleTicket(admission.ticket, 0);
        cleanup = joinSharedScan(key, () => Promise.resolve(), listener);
        if (closed) cleanup();
        return;
      }

      // 4. Live scan (shared with anyone who asks for the same token and tier meanwhile).
      const ticket = admission.ticket;
      cleanup = joinSharedScan(
        key,
        async (onEvent, signal) => {
          // Counted when each call is made (not when the ordered stream releases it).
          let spent = 0;
          // true once every call of the scan has settled: `spent` is then exact.
          let complete = false;
          try {
            const scan = await runScan(chain, token, {
              tier,
              signal,
              maxBuyers: limits.maxBuyers,
              maxHolders: limits.maxHolders,
              onCall: (c) => {
                spent += Number.isFinite(c.credits) ? c.credits : 0;
              },
              onEvent,
            });
            complete = true;
            await saveRecordedScan(scan).catch((err) => {
              console.warn(`[scan] could not record scan: ${err instanceof Error ? err.message : String(err)}`);
            });
            return scan;
          } catch (err) {
            // A ScanError is raised after the pipeline waited for its stages; an abort is not (requests
            // cancelled mid-flight may still be billed), so it keeps its whole reservation.
            if (err instanceof ScanError) complete = true;
            throw err;
          } finally {
            await settleTicket(ticket, complete ? spent : Math.max(spent, ticket.reserved)).catch(() => undefined);
            void flushLedger();
          }
        },
        listener,
      );
      if (closed) cleanup();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      const c = cleanup;
      cleanup = undefined;
      c?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
