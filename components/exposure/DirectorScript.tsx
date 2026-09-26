// Recording mode (?rec=1): the script of the 60 s demo video, as pure data and pure functions (no
// React, no DOM), so the pages can parse the query on the server and the tests can check every
// timing and caption. The hook (hooks/useDirector.ts) plays it; the stage (Director.tsx) draws it.
//
//   0-4 s    title card over the dark room: "Every chart shows you the price."
//   4-12 s   the exposure of patient A (flash, eyelids, beam): "EXPOSURE shows who's behind it."
//   12-30 s  markers 1-4 light up while the report types; one caption per finding, then the diagnosis
//   30-42 s  Lab Results: Summary, 01 Buyers, 03 Walls, Evidence ("Every number is a Nansen API call.")
//   42-54 s  drawer closes, patient B (a different diagnosis) is picked from the waiting room and
//            exposed at 2.5x tempo: its flow caption, then its diagnosis
//   54-60 s  end card
//
// Times are script seconds. `?speed=2` plays the whole script (and the room's own animations) twice as
// fast; it never changes the order or the relative timing.
import type { LabTab } from "@/components/exposure/LabResults";
import { formatAmount, formatPct, formatUsdCompact } from "@/lib/format";
import { hasSmartData, isAvailable, isTraced, primaryWall, tooFewSmartWallets } from "@/lib/xray/diagnosis";
import { patientName, priceShort } from "@/lib/xray/copy";
import { T } from "@/lib/xray/thresholds";
import type { DiagnosisCode, PricePoint, Scan } from "@/lib/xray/types";

/* ------------------------------------------------------------------ query */

export interface DirectorConfig {
  /** Script (and room) tempo: 1 = the real 60 s cut, 2 = a quick check in 30 s. */
  speed: number;
  /** Skip the "Click to start" plate (sounds stay muted: browsers need a gesture). */
  autostart: boolean;
  /** Repository shown on the end card, e.g. "github.com/0xkuzeydurden/exposure". */
  repo: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

export const REPO_FALLBACK = "github.com/0xkuzeydurden/exposure";
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 8;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** "1", "true", "yes", "on" and a bare flag ("?rec") are on; "0", "false", "no", "off" are off. */
function flag(v: string | string[] | undefined): boolean {
  const s = first(v);
  if (s === undefined) return false;
  return !/^(0|false|no|off)$/i.test(s.trim());
}

/** NEXT_PUBLIC_REPO_URL as the end card prints it: no scheme, no "www.", no ".git", no trailing slash. */
export function repoLabel(url: string | null | undefined): string {
  const s = (url ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^git@([^:]+):/i, "$1/")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return s || REPO_FALLBACK;
}

/**
 * The recording-mode config from a page's search params, or null when neither `rec` nor `director` is
 * on (then nothing about the room changes). `speed` is clamped to [0.25, 8]; `autostart` skips the plate.
 */
export function parseDirectorParams(sp: SearchParams | null | undefined, repoUrl?: string | null): DirectorConfig | null {
  if (!sp || !(flag(sp.rec) || flag(sp.director))) return null;
  const raw = Number(first(sp.speed));
  const speed = Number.isFinite(raw) && raw > 0 ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw)) : 1;
  return { speed, autostart: flag(sp.autostart), repo: repoLabel(repoUrl) };
}

/* ------------------------------------------------------------------ the script */

export type FindingNo4 = 1 | 2 | 3 | 4;

export type DirectorAction =
  | { type: "expose"; patient: "a" | "b" }
  /** Highlights finding n on the film (null clears). */
  | { type: "focus"; n: FindingNo4 | null }
  /** Opens the lab drawer on `tab` (or switches to it). */
  | { type: "lab"; tab: LabTab }
  | { type: "closeLab" }
  /** Rings patient B's card in the waiting room (the "click"). */
  | { type: "pick" }
  /** The room's animations and typing run `rate` times faster (times the config's speed). */
  | { type: "tempo"; rate: number };

export interface DirectorCue {
  at: number;
  action: DirectorAction;
}

export interface DirectorCaption {
  id: string;
  from: number;
  to: number;
  text: string;
  /** Small label above the text, e.g. "1 · REAL BUYERS". */
  tag?: string;
  /** The lab drawer is open on the right: centre the caption in the room beside it. */
  beside?: "lab";
}

export interface DirectorScript {
  duration: number;
  cues: DirectorCue[];
  captions: DirectorCaption[];
  /** Title-card price line (0..1 normalised closes of patient A, oldest first). */
  spark: number[];
  hasB: boolean;
}

/** Key moments (script seconds). */
export const REC = {
  titleTextIn: 0.25,
  titleTextOut: 3.6,
  exposeA: 4.0,
  /** The title card is dropped behind the flash (charge 0.42 s, then the flash rises for 0.1 s). */
  titleEnd: 4.5,
  behindFrom: 5.1,
  behindTo: 11.5,
  findingsFrom: 12.0,
  /** One caption per finding 1-4, then the diagnosis. */
  findingStep: 3.6,
  labFrom: 30.0,
  labStep: 3.0,
  labClose: 42.0,
  pick: 42.3,
  tempoB: 43.3,
  exposeB: 43.4,
  /** Patient B plays at this multiple of the script speed. */
  bRate: 2.5,
  bFlowFrom: 47.2,
  bDiagnosisFrom: 50.6,
  endCard: 54.0,
  duration: 60.0,
} as const;

/** Gap between two captions (the previous one fades out before the next fades in). */
const CAPTION_GAP = 0.2;
export const CAPTION_FADE = 0.3;

export const TITLE_TEXT = "Every chart shows you the price.";
export const BEHIND_TEXT = "EXPOSURE shows who's behind it.";
export const EVIDENCE_TEXT = "Every number is a Nansen API call.";
export const END_CARD = {
  brand: "EXPOSURE",
  tagline: "an x-ray for any token",
  built: "Built on the Nansen API · @nansen_ai",
  calls: "1,000+ Nansen API calls",
} as const;

const FINDING_TAGS: Record<FindingNo4, string> = {
  1: "1 · REAL BUYERS",
  2: "2 · FLOW",
  3: "3 · SELL WALL",
  4: "4 · SMART MONEY",
};

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pct(fraction: number): string {
  const a = Math.abs(fraction);
  return formatPct(a, a < 0.0995 ? 1 : 0);
}

const CHAIN_TITLES: Record<string, string> = { bnb: "BNB Chain", ethereum: "Ethereum", base: "Base", solana: "Solana" };

function chainTitle(chain: string): string {
  return CHAIN_TITLES[chain] ?? (chain ? chain[0].toUpperCase() + chain.slice(1) : chain);
}

/** One short caption per finding: plain words, the numbers straight from the scan. */
export function findingCaption(n: FindingNo4, scan: Pick<Scan, "findings">): string {
  const f = scan.findings;
  switch (n) {
    case 1: {
      const b = f.buyers;
      if (!b || !isAvailable(b)) return "Buyer data was not available for this scan.";
      const top = group(b.topBuyers);
      if (!isTraced(b)) return `The top ${top} buyers did ${pct(b.topShare)} of this week's buying.`;
      if (b.sources <= 0) return `None of the top ${top} buyers could be traced to a funder.`;
      if (b.biggestSourceWallets >= 3) return `${group(b.biggestSourceWallets)} of the top ${top} buyers were funded by one wallet.`;
      return `The top ${top} buyers came from ${group(b.sources)} different funders.`;
    }
    case 2: {
      const fl = f.flow;
      if (!fl || !isAvailable(fl)) return "No labelled smart-money flow this week.";
      const usd = finite(fl.informedNetUsd) ? fl.informedNetUsd : 0;
      const quiet = finite(fl.informedNetPctSupply) ? Math.abs(fl.informedNetPctSupply) < T.copy.quietFlow : Math.abs(usd) < 1_000;
      const informed =
        quiet || usd === 0
          ? "Smart money and whales barely moved this week."
          : `Smart money and whales ${usd < 0 ? "sold" : "bought"} ${formatUsdCompact(Math.abs(usd))} this week.`;
      if (!finite(fl.freshNetUsd) || fl.freshNetUsd === 0) return informed;
      return `${informed} New wallets ${fl.freshNetUsd > 0 ? "bought" : "sold"} ${formatUsdCompact(Math.abs(fl.freshNetUsd))}.`;
    }
    case 3: {
      const w = f.walls;
      if (!w || !isAvailable(w)) return "Holders' entry prices were not available.";
      const wall = primaryWall(w);
      if (!wall) return "No sell wall sits above the price.";
      return `Sellers wait at ${priceShort(wall.price)}: ${formatAmount(wall.tokens)} tokens break even ${pct(wall.movePct)} above today.`;
    }
    case 4: {
      const s = f.smart;
      if (!s || !isAvailable(s)) return "Smart money data was not available.";
      if (tooFewSmartWallets(s)) return `Only ${group(s.wallets)} smart-money wallets traded it: too few to read.`;
      if (!hasSmartData(s)) return `No smart money traded it in ${s.windowDays} days.`;
      const entry = `Smart money got in at ${priceShort(s.avgEntry)}`;
      if (!finite(s.pnlPct)) return `${entry}.`;
      if (Math.abs(s.pnlPct) < 0.005) return `${entry} and is back at break-even.`;
      return `${entry} and is ${s.pnlPct > 0 ? "up" : "down"} ${pct(s.pnlPct)}.`;
    }
  }
}

/** 0..1 normalised closes (at most `n` points) for the title card's price line. */
export function sparkOf(price: PricePoint[] | null | undefined, n = 96): number[] {
  const p = (price ?? []).filter((x) => finite(x?.c));
  if (p.length < 2) return [];
  const pts: number[] = [];
  const m = Math.min(n, p.length);
  for (let i = 0; i < m; i++) pts.push(p[Math.round((i / (m - 1)) * (p.length - 1))].c);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  return pts.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5));
}

/** The second patient: the first gallery entry with a different diagnosis than A (else any other). */
export function pickSecond<P extends { chain: string; tokenAddress: string; code: DiagnosisCode | string; synthetic?: boolean }>(
  patients: readonly P[],
  a: { chain: string; tokenAddress: string; code: DiagnosisCode | string | null },
): number {
  const same = (p: P) => p.chain === a.chain && p.tokenAddress.toLowerCase() === a.tokenAddress.toLowerCase();
  const others = patients.map((p, i) => ({ p, i })).filter(({ p }) => !same(p) && !p.synthetic);
  const different = others.find(({ p }) => p.code !== a.code);
  return (different ?? others[0])?.i ?? -1;
}

type ScriptScan = Pick<Scan, "meta" | "findings" | "diagnosis" | "totals" | "price">;

/** The whole script for patient A (and B, when the gallery has a second patient). */
export function buildScript(a: ScriptScan, b: ScriptScan | null): DirectorScript {
  const cues: DirectorCue[] = [];
  const captions: DirectorCaption[] = [];
  const cue = (at: number, action: DirectorAction) => cues.push({ at, action });
  const caption = (id: string, from: number, to: number, text: string, tag?: string, beside?: "lab") =>
    captions.push({ id, from, to, text, ...(tag ? { tag } : {}), ...(beside ? { beside } : {}) });

  // 4-12: the exposure.
  cue(REC.exposeA, { type: "expose", patient: "a" });
  caption("behind", REC.behindFrom, REC.behindTo, BEHIND_TEXT);

  // 12-30: findings 1-4 (film marker highlighted), then the diagnosis.
  const step = REC.findingStep;
  ([1, 2, 3, 4] as const).forEach((n, i) => {
    const from = REC.findingsFrom + i * step;
    cue(from, { type: "focus", n });
    caption(`finding-${n}`, from, from + step - CAPTION_GAP, findingCaption(n, a), FINDING_TAGS[n]);
  });
  const dxFrom = REC.findingsFrom + 4 * step;
  cue(dxFrom, { type: "focus", n: null });
  if (a.diagnosis?.sentence) caption("diagnosis-a", dxFrom, REC.labFrom - CAPTION_GAP, a.diagnosis.sentence, "DIAGNOSIS");

  // 30-42: the lab drawer flips through four tabs.
  const calls = finite(a.totals?.calls) ? a.totals.calls : 0;
  const lab: { tab: LabTab; tag: string; text: string }[] = [
    { tab: "summary", tag: "LAB RESULTS", text: "The whole x-ray on one bedside monitor." },
    { tab: 1, tag: "01 BUYERS", text: "Who bought, grouped by who funded them." },
    { tab: 3, tag: "03 WALLS", text: "Where holders wait to sell at break-even." },
    { tab: "evidence", tag: calls > 0 ? `EVIDENCE · ${group(calls)} CALLS` : "EVIDENCE", text: EVIDENCE_TEXT },
  ];
  lab.forEach((l, i) => {
    const at = REC.labFrom + i * REC.labStep;
    cue(at, { type: "lab", tab: l.tab });
    caption(`lab-${l.tab}`, at + 0.3, at + REC.labStep - CAPTION_GAP / 2, l.text, l.tag, "lab");
  });
  cue(REC.labClose, { type: "closeLab" });

  // 42-54: the next patient, at 2.5x tempo (its report is stamped at about 51 s).
  if (b) {
    cue(REC.pick, { type: "pick" });
    cue(REC.tempoB, { type: "tempo", rate: REC.bRate });
    cue(REC.exposeB, { type: "expose", patient: "b" });
    caption("next", REC.pick + 0.1, REC.bFlowFrom - 0.3, `Next patient: ${patientName(b.meta)} on ${chainTitle(b.meta.chain)}.`);
    // B's flow line types at about 47 s and its impression at about 50 s.
    cue(REC.bFlowFrom + 1.0, { type: "focus", n: 2 });
    caption("flow-b", REC.bFlowFrom, REC.bDiagnosisFrom - CAPTION_GAP, findingCaption(2, b), FINDING_TAGS[2]);
    cue(REC.bDiagnosisFrom, { type: "focus", n: null });
    if (b.diagnosis?.sentence) {
      const tag = a.diagnosis && b.diagnosis.code !== a.diagnosis.code ? "A DIFFERENT DIAGNOSIS" : "DIAGNOSIS";
      caption("diagnosis-b", REC.bDiagnosisFrom, REC.endCard - CAPTION_GAP, b.diagnosis.sentence, tag);
    }
  }
  cue(REC.endCard, { type: "tempo", rate: 1 });

  cues.sort((x, y) => x.at - y.at);
  captions.sort((x, y) => x.from - y.from);
  return { duration: REC.duration, cues, captions, spark: sparkOf(a.price), hasB: Boolean(b) };
}

/* ------------------------------------------------------------------ what is on screen at time t */

/** 0 before `from`, 1 after `to`, smoothstep between. */
export function ramp(t: number, from: number, to: number): number {
  if (t <= from) return 0;
  if (t >= to) return 1;
  const k = (t - from) / (to - from);
  return k * k * (3 - 2 * k);
}

/** Fades in over `fade` s from `from`, out over `fade` s until `to`. */
export function window01(t: number, from: number, to: number, fade = CAPTION_FADE): number {
  if (t < from || t > to) return 0;
  return Math.min(ramp(t, from, from + fade), 1 - ramp(t, to - fade, to));
}

/** Opacity steps of 1/50 (the view only changes when something visible changes). */
const q = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 50) / 50;

export interface DirectorView {
  title: { bg: number; text: number; line: number } | null;
  caption: { id: string; text: string; tag?: string; beside?: "lab"; opacity: number } | null;
  ring: { opacity: number; scale: number } | null;
  end: { bg: number; lines: [number, number, number, number] } | null;
}

/** The overlay state at script time `t` (t < 0: not started, the title card's dark room only). */
export function directorView(script: DirectorScript, t: number): DirectorView {
  const title =
    t < REC.titleEnd
      ? {
          bg: 1,
          text: q(Math.min(ramp(t, REC.titleTextIn, REC.titleTextIn + 0.6), 1 - ramp(t, REC.titleTextOut, REC.titleTextOut + 0.55))),
          line: q(ramp(t, 0.1, 3.3)),
        }
      : null;

  let caption: DirectorView["caption"] = null;
  for (const c of script.captions) {
    const o = q(window01(t, c.from, c.to));
    if (o > 0) {
      caption = { id: c.id, text: c.text, ...(c.tag ? { tag: c.tag } : {}), ...(c.beside ? { beside: c.beside } : {}), opacity: o };
      break;
    }
  }

  const ringTo = REC.exposeB + 0.3;
  const ring =
    script.hasB && t >= REC.pick && t <= ringTo
      ? {
          opacity: q(window01(t, REC.pick, ringTo, 0.25)),
          // Settles onto the card, then one press just before the exposure.
          scale: Math.round((1 + 0.1 * (1 - ramp(t, REC.pick, REC.pick + 0.35)) - 0.035 * window01(t, REC.exposeB - 0.45, REC.exposeB - 0.05, 0.2)) * 1000) / 1000,
        }
      : null;

  const end =
    t >= REC.endCard
      ? {
          bg: q(ramp(t, REC.endCard, REC.endCard + 0.6)),
          lines: [0.5, 1.1, 1.7, 2.3].map((d) => q(ramp(t, REC.endCard + d, REC.endCard + d + 0.5))) as [number, number, number, number],
        }
      : null;

  return { title, caption, ring, end };
}

/** Same view (used to skip re-renders between frames). */
export function sameView(x: DirectorView, y: DirectorView): boolean {
  return JSON.stringify(x) === JSON.stringify(y);
}

/* ------------------------------------------------------------------ page clock */

/**
 * The room's clock while recording: virtual = v0 + (real - r0) * rate, continuous when the rate
 * changes. hooks/useDirector patches performance.now, requestAnimationFrame and the timers with it so
 * the room's own tweens, typing and flashes run `rate` times faster without touching their code.
 */
export class TimeWarp {
  private r0: number;
  private v0: number;
  private k: number;

  constructor(now: number, rate = 1) {
    this.r0 = now;
    this.v0 = now;
    this.k = rate > 0 && Number.isFinite(rate) ? rate : 1;
  }

  get rate(): number {
    return this.k;
  }

  /** Virtual time of a real timestamp (performance.now / rAF base). */
  map(real: number): number {
    return this.v0 + (real - this.r0) * this.k;
  }

  /** Changes the rate from `realNow` on; virtual time stays continuous. */
  setRate(rate: number, realNow: number): void {
    if (!(rate > 0) || !Number.isFinite(rate)) return;
    this.v0 = this.map(realNow);
    this.r0 = realNow;
    this.k = rate;
  }

  /** Real delay for a virtual one (setTimeout / setInterval). */
  delay(ms: number): number {
    return Number.isFinite(ms) && ms > 0 ? ms / this.k : 0;
  }
}
