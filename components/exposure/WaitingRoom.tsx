"use client";

// The waiting room: recorded scans (public/scans/index.json) as patient files. When the gallery is
// empty the synthetic patient is shown with a "synthetic preview" tag. Also home to the small
// loaders the room uses to fetch recorded scans.
import { memo } from "react";
import { chainName } from "@/components/exposure/Report";
import { makeSyntheticScan } from "@/lib/xray/fixtures";
import type { DiagnosisCode, GalleryEntry, PricePoint, Scan } from "@/lib/xray/types";

export const GALLERY_URL = "/scans/index.json";
export const SYNTHETIC_URL = "/scans/_synthetic.json";

/** A waiting-room card: a gallery entry plus where its scan lives and whether it is synthetic. */
export interface Patient extends GalleryEntry {
  url: string;
  synthetic?: boolean;
}

export function patientKey(chain: string, token: string): string {
  const c = chain.trim().toLowerCase();
  const t = token.trim();
  return `${c}:${t.startsWith("0x") ? t.toLowerCase() : t}`;
}

export function scanFileUrl(file: string): string {
  if (/^(https?:)?\//.test(file)) return file;
  return `/scans/${file.replace(/^\.?\/*(scans\/)?/, "")}`;
}

/** Structural check that a JSON body is a v1 Scan (and not, say, a legacy v0 scene). */
export function isScan(x: unknown): x is Scan {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<Scan>;
  return (
    s.version === 1 &&
    !!s.meta &&
    typeof s.meta.chain === "string" &&
    typeof s.meta.tokenAddress === "string" &&
    Array.isArray(s.price) &&
    !!s.findings &&
    typeof s.findings === "object"
  );
}

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeEntry(raw: unknown): Patient | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Json;
  const chain = str(r.chain);
  const tokenAddress = str(r.tokenAddress) ?? str(r.token) ?? str(r.address);
  if (!chain || !tokenAddress) return null;
  const file = str(r.file) ?? `${chain}-${tokenAddress}.json`;
  const spark = Array.isArray(r.spark) ? r.spark.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0.5)) : [];
  return {
    chain,
    tokenAddress,
    symbol: str(r.symbol) ?? tokenAddress.slice(0, 6),
    name: str(r.name) ?? "",
    ...(str(r.logo) ? { logo: str(r.logo) as string } : {}),
    diagnosis: str(r.diagnosis) ?? "",
    code: (str(r.code) ?? "normal") as DiagnosisCode,
    scannedAt: str(r.scannedAt) ?? "",
    file,
    spark,
    url: scanFileUrl(file),
    synthetic: r.synthetic === true,
  };
}

/** Loads /scans/index.json. Accepts `[...]` or `{ entries | scans: [...] }`. Never throws. */
export async function loadGallery(signal?: AbortSignal): Promise<Patient[]> {
  try {
    const res = await fetch(GALLERY_URL, { signal, cache: "no-cache" });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const list = Array.isArray(body) ? body : body && typeof body === "object" ? ((body as Json).entries ?? (body as Json).scans) : null;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeEntry).filter((e): e is Patient => e !== null);
  } catch {
    return [];
  }
}

/** Fetches a recorded scan; null when missing or not a v1 Scan. Never throws (except on abort). */
export async function loadScan(url: string, signal?: AbortSignal): Promise<Scan | null> {
  try {
    const res = await fetch(url, { signal, cache: "no-cache" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isScan(body) ? body : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** A recorded scan for a token: the public file, else this server's /api/recorded copy. */
export async function findRecorded(chain: string, token: string, signal?: AbortSignal): Promise<Scan | null> {
  const c = encodeURIComponent(chain);
  const variants = token.startsWith("0x") && token !== token.toLowerCase() ? [token, token.toLowerCase()] : [token];
  for (const t of variants) {
    const scan = await loadScan(`/scans/${c}-${encodeURIComponent(t)}.json`, signal);
    if (scan) return scan;
  }
  return loadScan(`/api/recorded/${c}/${encodeURIComponent(token)}`, signal);
}

/** The synthetic patient: /scans/_synthetic.json, else generated in the browser. */
export async function loadSyntheticScan(signal?: AbortSignal): Promise<Scan | null> {
  const file = await loadScan(SYNTHETIC_URL, signal);
  if (file) return { ...file, synthetic: true };
  try {
    return makeSyntheticScan();
  } catch {
    return null;
  }
}

/** 24 normalised points (0 = low, 1 = high) of a price series. */
export function sparkFromPrice(price: PricePoint[], n = 24): number[] {
  if (price.length < 2) return [];
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(price[Math.round((i / (n - 1)) * (price.length - 1))].c);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  return pts.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5));
}

export function patientFromScan(scan: Scan, url: string): Patient {
  return {
    chain: scan.meta.chain,
    tokenAddress: scan.meta.tokenAddress,
    symbol: scan.meta.symbol,
    name: scan.meta.name,
    ...(scan.meta.logo ? { logo: scan.meta.logo } : {}),
    diagnosis: scan.diagnosis?.sentence ?? "",
    code: scan.diagnosis?.code ?? "normal",
    scannedAt: scan.meta.scannedAt,
    file: url,
    spark: sparkFromPrice(scan.price),
    url,
    synthetic: scan.synthetic === true,
  };
}

/** Short clinical label for a card (the full sentence goes in the tooltip). */
export const DIAGNOSIS_SHORT: Record<DiagnosisCode, string> = {
  insufficient: "Too few labelled wallets",
  concentrated: "Few hands buying",
  distribution: "Smart money selling",
  capitulation: "Holders giving up",
  overhead: "Sellers overhead",
  accumulation: "Quietly accumulating",
  normal: "Nothing unusual",
};

function sparkPoints(spark: number[]): string {
  if (spark.length < 2) return "0,13 146,13";
  const step = 146 / (spark.length - 1);
  return spark.map((v, i) => `${(i * step).toFixed(1)},${(23 - Math.max(0, Math.min(1, v)) * 20).toFixed(1)}`).join(" ");
}

export interface WaitingRoomProps {
  patients: Patient[];
  /** patientKey() of the patient on the lightbox. */
  activeKey?: string | null;
  loading?: boolean;
  onSelect: (p: Patient) => void;
  className?: string;
}

function WaitingRoomImpl({ patients, activeKey, loading, onSelect, className }: WaitingRoomProps) {
  return (
    <nav className={`queue${className ? ` ${className}` : ""}`} aria-label="Waiting room: recorded x-rays">
      <span className="k">Waiting room</span>
      {loading && patients.length === 0 ? <span className="queue-empty">Calling the next patients…</span> : null}
      {!loading && patients.length === 0 ? <span className="queue-empty">No recorded x-rays yet.</span> : null}
      {patients.map((p) => {
        const key = patientKey(p.chain, p.tokenAddress);
        const active = key === activeKey;
        const label = DIAGNOSIS_SHORT[p.code] ?? p.diagnosis;
        return (
          <button
            key={key}
            type="button"
            className={`chart${active ? " is-active" : ""}${p.synthetic ? " is-synthetic" : ""}`}
            aria-current={active ? "true" : undefined}
            title={p.diagnosis || label}
            onClick={() => onSelect(p)}
          >
            <b>${p.symbol.replace(/^\$/, "")}</b>
            {chainName(p.chain)}
            {p.synthetic ? <span className="tag">synthetic preview</span> : null}
            <svg viewBox="0 0 146 26" aria-hidden="true" preserveAspectRatio="none">
              <polyline points={sparkPoints(p.spark)} fill="none" stroke="#e9f2f9" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
            </svg>
            <i>{label}</i>
          </button>
        );
      })}
    </nav>
  );
}

export const WaitingRoom = memo(WaitingRoomImpl);
