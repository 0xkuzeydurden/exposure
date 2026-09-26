import "server-only";
import type { NextRequest } from "next/server";
import { isSupportedChain, isValidAddress } from "@/lib/nansen/chains";
import { loadLatestScan } from "@/lib/xray/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * GET /api/recorded/:chain/:token[?tier=deep|quick]: the newest EXPOSURE Scan of this token on disk
 * (this server's live scans in .cache/scans, else the gallery file in public/scans), so re-opening a
 * token replays it for 0 credits. `tier=deep` only accepts deep scans. 404 when there is none.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ chain: string; token: string }> }) {
  const { chain: rawChain, token: rawToken } = await params;
  const chain = safeDecode(rawChain).trim().toLowerCase();
  const token = safeDecode(rawToken).trim();
  if (!isSupportedChain(chain) || !isValidAddress(chain, token)) {
    return Response.json({ error: "Unknown token" }, { status: 404 });
  }
  const tierParam = request.nextUrl.searchParams.get("tier");
  const tier = tierParam === "deep" || tierParam === "quick" ? tierParam : undefined;
  const scan = await loadLatestScan(chain, token, { tier, includePublic: true }).catch(() => null);
  if (!scan) return Response.json({ error: "No recorded scan" }, { status: 404 });
  return Response.json(scan, { headers: { "cache-control": "no-store" } });
}
