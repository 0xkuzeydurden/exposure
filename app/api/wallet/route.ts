import "server-only";
import { z } from "zod";
import { isEvmChain, isSupportedChain, isValidAddress } from "@/lib/nansen/chains";
import { hasNansenKey } from "@/lib/nansen/client";
import { describeError, NansenError } from "@/lib/nansen/errors";
import { flushLedger } from "@/lib/nansen/ledger";
import { admitWalletCheck, clientIp, settleTicket } from "@/lib/xray/budget";
import type { ExposureApiError, WalletApiResult } from "@/lib/xray/pipeline/api-types";
import { NO_KEY_MESSAGE } from "@/lib/xray/pipeline/run";
import { checkWallet } from "@/lib/xray/pipeline/wallet";
import { loadLatestScan } from "@/lib/xray/store";
import type { CallRecord } from "@/lib/xray/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  chain: z.string().trim().toLowerCase(),
  token: z.string().trim(),
  wallet: z.string().trim(),
});

function error(status: number, message: string, budget?: ExposureApiError["budget"]) {
  const body: ExposureApiError = { error: message };
  if (budget) body.budget = budget;
  return Response.json(body, { status });
}

/**
 * POST /api/wallet {chain, token, wallet} → WalletCheck + {calls, credits, comparedWith}.
 * One profiler/address/pnl call (1 credit; 0 when the wallet is a top holder the deep scan already
 * read), budget-checked. The wallet is compared with the newest scan of the token on disk (recorded
 * or gallery): smart-money entry and the supply-by-entry-price ladder.
 * Errors: 400 bad input · 429 budget / visitor limit (body.budget set) · 503 no key · 502 upstream.
 */
export async function POST(request: Request) {
  let input: z.output<typeof Body>;
  try {
    input = Body.parse(await request.json());
  } catch {
    return error(400, "Expected JSON body {chain, token, wallet}");
  }
  const { chain } = input;
  if (!isSupportedChain(chain)) return error(400, `Chain "${chain}" is not supported`);
  if (!isValidAddress(chain, input.token)) return error(400, "Invalid token address");
  if (!isValidAddress(chain, input.wallet)) return error(400, "Invalid wallet address");
  if (!hasNansenKey()) return error(503, NO_KEY_MESSAGE);
  const token = isEvmChain(chain) ? input.token.toLowerCase() : input.token;

  const admission = await admitWalletCheck({ ip: clientIp(request.headers) });
  if (!admission.ok) {
    return error(admission.reason === "no_key" ? 503 : 429, admission.message, {
      creditsLeftToday: admission.creditsLeftToday,
      creditsRemaining: admission.creditsRemaining,
    });
  }

  const calls: CallRecord[] = [];
  try {
    const scan = await loadLatestScan(chain, token, { includePublic: true }).catch(() => null);
    const check = await checkWallet(chain, token, input.wallet, scan, {
      signal: request.signal,
      onCall: (c) => calls.push(c),
    });
    const credits = calls.reduce((s, c) => s + c.credits, 0);
    const body: WalletApiResult = { ...check, calls, credits, comparedWith: scan?.meta.scannedAt ?? null };
    return Response.json(body);
  } catch (err) {
    if (request.signal.aborted) return error(499, "Request aborted");
    const status = err instanceof NansenError && err.status >= 400 && err.status < 500 && err.status !== 429 ? 400 : 502;
    return error(status, describeError(err));
  } finally {
    const credits = calls.reduce((s, c) => s + c.credits, 0);
    // A check cut short by the client may have been billed for a request still in flight.
    const settled = request.signal.aborted ? Math.max(credits, admission.ticket.reserved) : credits;
    await settleTicket(admission.ticket, settled).catch(() => undefined);
    void flushLedger();
  }
}
