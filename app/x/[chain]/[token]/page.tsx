import type { Metadata } from "next";
import { cache } from "react";
import { Room } from "@/components/exposure/Room";
import { parseDirectorParams } from "@/components/exposure/DirectorScript";
import { isSupportedChain, isValidAddress } from "@/lib/nansen/chains";
import { patientName } from "@/lib/xray/copy";
import { loadLatestScan } from "@/lib/xray/store";
import type { Scan } from "@/lib/xray/types";

type RouteParams = Promise<{ chain: string; token: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

interface Patient {
  chain: string;
  token: string;
  invalid: string | null;
  /** The newest recorded scan of this token on disk (live recording or gallery file), if any. */
  scan: Scan | null;
}

/** Shared by generateMetadata and the page (one disk read per request). Never spends credits. */
const readPatient = cache(async (rawChain: string, rawToken: string): Promise<Patient> => {
  const chain = safeDecode(rawChain).trim().toLowerCase();
  const token = safeDecode(rawToken).trim();
  if (!isSupportedChain(chain)) return { chain, token, invalid: `"${chain.slice(0, 32)}" is not a chain EXPOSURE can read.`, scan: null };
  if (!isValidAddress(chain, token)) return { chain, token, invalid: `That is not a ${chain} token address.`, scan: null };
  let scan: Scan | null = null;
  try {
    scan = await loadLatestScan(chain, token, { includePublic: true });
  } catch {
    scan = null;
  }
  return { chain, token, invalid: null, scan };
});

export async function generateMetadata({ params }: { params: RouteParams }): Promise<Metadata> {
  const { chain, token } = await params;
  const p = await readPatient(chain, token);
  if (p.scan) {
    const name = patientName(p.scan.meta);
    const sentence = p.scan.diagnosis?.sentence ?? "";
    return {
      title: `${name} x-ray`,
      description: `${name}: ${sentence} Every chart shows you the price. EXPOSURE shows who's behind it. Powered by Nansen API.`,
      openGraph: { title: `${name} · ${sentence}`, description: "Every chart shows you the price. EXPOSURE shows who's behind it." },
    };
  }
  return {
    title: p.invalid ? "Unreadable request" : `${short(p.token)} x-ray`,
    description: "Every chart shows you the price. EXPOSURE shows who's behind it. Powered by Nansen API.",
  };
}

/**
 * /x/<chain>/<token>: the recorded x-ray of a token, or a "Take the x-ray" button (never spends credits on
 * load). `?rec=1` plays the recording-mode demo with this token as the first patient.
 */
export default async function TokenPage({ params, searchParams }: { params: RouteParams; searchParams: SearchParams }) {
  const [{ chain, token }, query] = await Promise.all([params, searchParams]);
  const p = await readPatient(chain, token);
  const director = parseDirectorParams(query, process.env.NEXT_PUBLIC_REPO_URL);
  return (
    <Room
      key={`${p.chain}/${p.token}`}
      initial={{ kind: "token", chain: p.chain, token: p.token, scan: p.scan, invalid: p.invalid }}
      director={director}
    />
  );
}
