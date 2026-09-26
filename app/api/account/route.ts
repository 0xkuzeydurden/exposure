import "server-only";
import { hasNansenKey } from "@/lib/nansen/client";
import { ledgerCounters } from "@/lib/nansen/ledger";
import { budgetStatus, estimateCredits, liveScanLimits } from "@/lib/xray/budget";
import type { ExposureAccountResponse } from "@/lib/xray/pipeline/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account (0 credits) → { hasKey, liveEnabled, plan, creditsRemaining, dailyLeft, dailyCap,
 * deepLeft, floor, estimates: {quick, deep}, deepByChain: {evm, other}, session } plus the
 * legacy field names (liveBuilds = liveEnabled, creditsPerBuild = deep estimate).
 * `creditsRemaining` comes from the free GET /account, cached 5 minutes.
 */
export async function GET() {
  const limits = liveScanLimits();
  const estimates = {
    quick: estimateCredits("quick", "base", limits),
    deep: estimateCredits("deep", "base", limits),
  };
  const deepByChain = { evm: estimates.deep, other: estimateCredits("deep", "solana", limits) };
  const c = ledgerCounters();
  const session = { calls: c.calls, networkCalls: c.networkCalls, cacheHits: c.cacheHits, credits: c.credits };
  try {
    const s = await budgetStatus();
    // Legacy field names, kept so nothing that still reads them breaks.
    const legacy = { liveBuilds: s.liveEnabled, creditsPerBuild: estimates.deep };
    const body: ExposureAccountResponse = {
      hasKey: s.hasKey,
      liveEnabled: s.liveEnabled,
      plan: s.plan,
      creditsRemaining: s.creditsRemaining,
      dailyLeft: s.dailyLeft,
      dailyCap: s.dailyCap,
      deepLeft: s.deepLeft,
      floor: s.floor,
      estimates,
      deepByChain,
      session,
      ...legacy,
    };
    if (s.accountError) body.error = s.accountError;
    return Response.json(body);
  } catch (err) {
    const body: ExposureAccountResponse = {
      hasKey: hasNansenKey(),
      liveEnabled: false,
      plan: null,
      creditsRemaining: c.creditsRemaining,
      dailyLeft: 0,
      dailyCap: 0,
      deepLeft: 0,
      floor: 0,
      estimates,
      deepByChain,
      session,
      error: err instanceof Error ? err.message : String(err),
      liveBuilds: false,
      creditsPerBuild: estimates.deep,
    };
    return Response.json(body);
  }
}
