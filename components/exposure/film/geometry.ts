// Film geometry: turns the scan data into SVG coordinates for every layer of the x-ray film.
// Pure and deterministic (no React, no DOM) so it is memoised once per data change and unit-tested.
// The viewBox is fixed at 1400x800 and matches the approved mockup.
import { formatAmount, formatPct, formatPrice, formatSignedPct } from "@/lib/format";
import { chainLabel, patientName, plateLine, priceTick, sourceName, tagFor, untracedReason } from "@/lib/xray/copy";
import { hasSmartData, primaryWall } from "@/lib/xray/diagnosis";
import {
  clamp,
  ease,
  logScale,
  nearestIndex,
  priceDomain,
  priceTicks,
  prng,
  timeScale,
  type LogScale,
  type TimeScale,
} from "@/lib/exposure/filmScale";
import type {
  BigBuy,
  BuyersFinding,
  FlowFinding,
  LadderBin,
  PricePoint,
  ScanMeta,
  SmartFinding,
  SourceCluster,
  Wall,
  WalletCheck,
  WallsFinding,
} from "@/lib/xray/types";

export const V = {
  W: 1400,
  H: 800,
  /** Main chart area. */
  X0: 96,
  X1: 1150,
  Y0: 118,
  Y1: 520,
  /** Side ladder "supply by entry price". */
  LX: 1178,
  LW: 110,
  /** Lower strip. */
  STRIP_Y: 590,
  TITLE_Y: 620,
  LABEL_Y: 764,
  SUB_Y: 779,
  SRC_X0: 110,
  SRC_X1: 772,
  SRC_CY: 690,
  ROW_Y: 646,
  /** Pulse (ECG) strip. */
  EX0: 820,
  EX1: 1330,
  EB: 690,
} as const;

export const C = {
  bone: "#e9f2f9",
  boneLine: "#f2f8fd",
  glow: "#cfe6ff",
  dim: "#8a9aa8",
  faint: "#5d6c78",
  label: "#9fb8cc",
  labelCool: "#7f98ab",
  band: "#dbe9f5",
  marker: "#ffb547",
  you: "#ff6b47",
  ink: "#0a0f14",
} as const;

export type MarkerN = 1 | 2 | 3 | 4 | 5;

export interface FilmInput {
  meta: ScanMeta | null;
  price: PricePoint[];
  bigBuys: BigBuy[];
  buyers: BuyersFinding | null;
  flow: FlowFinding | null;
  walls: WallsFinding | null;
  smart: SmartFinding | null;
  you: WalletCheck | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarkerGeo {
  n: MarkerN;
  cx: number;
  cy: number;
  tag: string;
  /** Tag anchor point (mockup convention: text baseline at ty - 2, box from ty - 21 to ty + 7). */
  tx: number;
  ty: number;
  anchor: "start" | "end";
  color: string;
  /** Tag box width. */
  w: number;
  /** Accessible name. */
  label: string;
}

export interface BandGeo {
  y: number;
  h: number;
  warm: boolean;
  opacity: number;
}

export interface LadderBarGeo {
  y: number;
  h: number;
  w: number;
  opacity: number;
}

export interface WallsGeo {
  bands: BandGeo[];
  lossLabelY: number | null;
  profitLabelY: number | null;
  /** x of the two band labels, moved along the band to where the price line and SM line leave room. */
  lossLabelX: number;
  profitLabelX: number;
  /** Share of circulating supply that entered above / below the film's price range (side-ladder notes). */
  offAbove: number;
  offBelow: number;
  ladder: LadderBarGeo[];
  /** Sorted by price, for the crosshair's "supply entered at this price". */
  bins: LadderBin[];
  partial: boolean;
}

export interface DotGroup {
  mode: "fill" | "stroke";
  opacity: number;
  /** Flat [sx, sy, tx, ty, ...]: scattered-row start and merged-cluster target of every dot. */
  pts: number[];
}

export interface SourcesClusterGeo {
  mode: "clusters";
  title: string;
  counter: { from: number; to: number };
  r: number;
  groups: DotGroup[];
  labels: { x: number; text: string; sub: string }[];
  partial: boolean;
}

export interface SourcesConcentrationGeo {
  mode: "concentration";
  title: string;
  bar: Box & { share: number };
  text: string;
  rest: string;
  note: string | null;
  partial: boolean;
}

export type SourcesGeo = SourcesClusterGeo | SourcesConcentrationGeo;

export interface PulseGeo {
  d: string;
  from: string;
  to: string;
  partial: boolean;
}

export interface FilmGeometry {
  hasMeta: boolean;
  hasPrice: boolean;
  plate: { name: string; sub: string };
  status: { missing: string[]; partial: string[] };
  y: LogScale;
  x: TimeScale | null;
  priceNow: number | null;
  /** Price series in film coordinates (for the crosshair and marker placement). */
  series: { t: number[]; c: number[]; xs: number[]; ys: number[] };
  ticks: { y: number; label: string }[];
  pricePath: string;
  now: { x: number; y: number; label: string } | null;
  walls: WallsGeo | null;
  wallsMissing: boolean;
  smY: number | null;
  youY: number | null;
  /** The smart-money entry / your entry lies beyond the film's price range (drawn at the edge). */
  smOff: "above" | "below" | null;
  youOff: "above" | "below" | null;
  bigBuys: { cx: number; cy: number; r: number; o: number }[];
  sources: SourcesGeo | null;
  sourcesMissing: boolean;
  pulse: PulseGeo | null;
  pulseMissing: boolean;
  markers: MarkerGeo[];
}

/* ---------------------------------------------------------------- helpers */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const pad2 = (n: number) => String(n).padStart(2, "0");

const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "TUE 22 SEP 14:00" (UTC). */
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "SAT 19 SEP" (UTC). */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Mockup tag box width for a 15px mono tag. */
export const tagWidth = (tag: string) => tag.length * 10.4 + 18;

export function tagBox(m: Pick<MarkerGeo, "tx" | "ty" | "w" | "anchor">): Box {
  return { x: m.anchor === "end" ? m.tx - m.w : m.tx - 2, y: m.ty - 21, w: m.w, h: 28 };
}

const intersects = (a: Box, b: Box, pad = 0) =>
  a.x - pad < b.x + b.w && b.x - pad < a.x + a.w && a.y - pad < b.y + b.h && b.y - pad < a.y + a.h;

/** Path of `n` circles (one <path> per dot group keeps the per-frame merge update to a single attribute). */
export function dotsPath(pts: readonly number[], k: number, r: number): string {
  const rr = r.toFixed(2);
  const d2 = (2 * r).toFixed(2);
  let d = "";
  for (let i = 0; i + 3 < pts.length; i += 4) {
    const x = pts[i] + (pts[i + 2] - pts[i]) * k;
    const y = pts[i + 1] + (pts[i + 3] - pts[i + 1]) * k;
    d += `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${rr} ${rr} 0 1 0 ${d2} 0a${rr} ${rr} 0 1 0 -${d2} 0`;
  }
  return d;
}

/** Merge easing used by the mockup's setSources(). */
export const mergeEase = ease.inOutQuad;

/**
 * How far (as a price ratio from the week's range) a drawn level may pull the film's price axis. Real
 * smart-money entries sit up to 4x below the week's prices; at the old 4x reach the line was squeezed
 * into the top third of the film.
 */
const FILM_REACH = 1.6;

/** "SM ENTRY $0.087 ↓": a level beyond the film's range is drawn at the edge and its tag points on. */
function offTag(tag: string, off: "above" | "below" | null): string {
  return off === "below" ? `${tag} ↓` : off === "above" ? `${tag} ↑` : tag;
}

/** Band label width on the film (12px mono, letter-spacing 2). */
const BAND_LABEL_W = 17 * 9.3;

/**
 * Moves "HOLDERS AT A LOSS" / "HOLDERS IN PROFIT" along their band (and a line up or down) to where the
 * price line and the smart-money line leave them readable.
 */
function placeBandLabels(w: WallsGeo, series: { xs: number[]; ys: number[] }, smY: number | null, markers: readonly MarkerGeo[]): void {
  const obstacles: Box[] = markers.flatMap((m) => [tagBox(m), { x: m.cx - 19, y: m.cy - 19, w: 38, h: 38 }]);
  const xsCand = [V.X0 + 12, V.X0 + 300, V.X1 - BAND_LABEL_W - 20, V.X0 + 560];
  const place = (y0: number | null, dir: 1 | -1): [number, number] | null => {
    if (y0 === null) return null;
    let best: [number, number] = [V.X0 + 12, y0];
    let bestScore = Infinity;
    for (const [dy, pen] of [
      [0, 0],
      [-14 * dir, 4],
      [14 * dir, 6],
    ] as const) {
      const y = y0 + dy;
      if (y < 104 || y > V.Y1 + 40) continue;
      xsCand.forEach((x, i) => {
        let hits = 0;
        for (let k = 0; k < series.xs.length; k++) {
          if (series.xs[k] < x - 6 || series.xs[k] > x + BAND_LABEL_W + 6) continue;
          if (series.ys[k] > y - 16 && series.ys[k] < y + 7) hits++;
        }
        const sm = smY !== null && smY > y - 15 && smY < y + 7 ? 60 : 0;
        const box: Box = { x: x - 4, y: y - 13, w: BAND_LABEL_W + 8, h: 17 };
        const blocked = obstacles.some((o) => intersects(box, o, 2)) ? 200 : 0;
        const score = hits * 10 + sm + blocked + pen + i * 1.5;
        if (score < bestScore) {
          bestScore = score;
          best = [x, y];
        }
      });
    }
    return best;
  };
  const loss = place(w.lossLabelY, 1);
  const profit = place(w.profitLabelY, -1);
  if (loss) [w.lossLabelX, w.lossLabelY] = loss;
  if (profit) [w.profitLabelX, w.profitLabelY] = profit;
}

/* ---------------------------------------------------------------- main */

export function buildFilmGeometry(input: FilmInput): FilmGeometry {
  const { meta, buyers, flow, walls, smart, you } = input;

  // Price series: finite, positive, oldest first.
  const pts = input.price.filter((p) => isNum(p.t) && isPos(p.c)).slice();
  pts.sort((a, b) => a.t - b.t);
  const hasPrice = pts.length > 0;
  const priceNow = isPos(meta?.priceNow) ? meta!.priceNow : hasPrice ? pts[pts.length - 1].c : null;

  // Time window: the price series extent (the line fills the chart), else the scan window.
  let t0: number | null = null;
  let t1: number | null = null;
  if (pts.length >= 2) {
    t0 = pts[0].t;
    t1 = pts[pts.length - 1].t;
  } else {
    t0 = parseTime(meta?.window.from);
    t1 = parseTime(meta?.window.to);
    if (hasPrice && (t0 === null || t1 === null)) {
      t0 = pts[0].t - 3_600_000;
      t1 = pts[0].t;
    }
  }
  const x = t0 !== null && t1 !== null && t1 > t0 ? timeScale(t0, t1, V.X0, V.X1) : null;

  // Which findings can be drawn.
  // Tags, the headline wall and "has smart data" come from lib/xray (copy.ts / diagnosis.ts) so the
  // film always says exactly what the typed report says.
  const smartOk = hasSmartData(smart);
  const youOk = !!you && you.status !== "unavailable" && isPos(you.cost);
  const wallsOk = !!walls && walls.status !== "unavailable";
  const wall = wallsOk ? primaryWall(walls, meta?.circulatingSupply ?? null) : null;

  // Log price domain from the series plus every level drawn on it.
  const extra: number[] = [];
  if (priceNow) extra.push(priceNow);
  if (smartOk) extra.push(smart!.avgEntry!);
  if (youOk) extra.push(you!.cost!);
  if (wallsOk) for (const w of walls!.walls) if (isPos(w.price)) extra.push(w.price);
  // Levels far from the week's prices (a smart-money entry 4x below them) are not allowed to squeeze
  // the price line into a third of the film: they stop at the edge, marked with an arrow instead.
  const domain = priceDomain(
    pts.map((p) => p.c),
    extra,
    { reach: FILM_REACH },
  );
  const y = logScale(domain, V.Y0, V.Y1);

  const series = {
    t: pts.map((p) => p.t),
    c: pts.map((p) => p.c),
    xs: x ? pts.map((p) => x(p.t)) : [],
    ys: pts.map((p) => y(p.c)),
  };

  const ticks = hasPrice || extra.length ? priceTicks(y).map((v) => ({ y: y(v), label: priceTick(v) })) : [];

  let pricePath = "";
  if (x && pts.length) {
    for (let i = 0; i < pts.length; i++)
      pricePath += `${i ? "L" : "M"}${series.xs[i].toFixed(1)} ${series.ys[i].toFixed(1)}`;
  }
  const now =
    x && pts.length && priceNow
      ? { x: series.xs[series.xs.length - 1], y: y.clamped(priceNow), label: formatPrice(priceNow) }
      : null;

  // Plate.
  const plate = meta
    ? { name: `${patientName(meta).slice(0, 14)} · ${chainLabel(meta.chain)}`, sub: plateLine(meta) }
    : { name: "AWAITING PATIENT", sub: "NO EXPOSURE ON THIS FILM" };

  // Status plate.
  const missing: string[] = [];
  const partial: string[] = [];
  const note = (f: { status: string } | null, label: string) => {
    if (!f) return;
    if (f.status === "unavailable") missing.push(label);
    else if (f.status === "partial") partial.push(label);
  };
  note(buyers, "01 BUYERS");
  note(flow, "02 FLOW");
  note(walls, "03 SELL WALLS");
  note(smart, "04 SMART MONEY");
  if (smart && smart.status !== "unavailable" && !smartOk) {
    // Answered, but no smart money was seen: nothing to draw.
    if (partial.includes("04 SMART MONEY")) partial.splice(partial.indexOf("04 SMART MONEY"), 1);
    missing.push("04 SMART MONEY");
  }
  note(you, "05 YOU");

  const wallsGeo = wallsOk ? buildWalls(walls!, y, priceNow, wall) : null;
  const offOf = (p: number): "above" | "below" | null => (p > y.domain.hi ? "above" : p < y.domain.lo ? "below" : null);
  const smY = smartOk ? y.clamped(smart!.avgEntry!) : null;

  // Big buys: dots on the price at the time of the buy.
  const bigBuys: FilmGeometry["bigBuys"] = [];
  if (x) {
    const bb = input.bigBuys.filter((b) => isNum(b.t) && isPos(b.price) && isPos(b.usd) && b.t >= x.t0 && b.t <= x.t1);
    bb.sort((a, b) => b.usd - a.usd);
    const top = bb.slice(0, 60);
    const maxUsd = top.length ? top[0].usd : 1;
    for (const b of top) {
      const k = Math.sqrt(b.usd / maxUsd);
      const cy = y(b.price);
      if (cy < V.Y0 - 10 || cy > V.Y1 + 10) continue;
      bigBuys.push({ cx: x(b.t), cy, r: 2 + 4 * k, o: 0.25 + 0.5 * k });
    }
  }

  const sources = buyers && buyers.status !== "unavailable" ? buildSources(buyers, tagFor(1, buyers)) : null;
  const pulse = flow && flow.status !== "unavailable" ? buildPulse(flow, x, meta) : null;

  // A level parked at the film's edge must not read as the price tick next to it.
  const smOff = smartOk ? offOf(smart!.avgEntry!) : null;
  const parkedTicks = smOff && smY !== null ? ticks.filter((t) => Math.abs(t.y - smY) >= 18) : ticks;

  const geo: FilmGeometry = {
    hasMeta: !!meta,
    hasPrice,
    plate,
    status: { missing, partial },
    y,
    x,
    priceNow,
    series,
    ticks: parkedTicks,
    pricePath,
    now,
    walls: wallsGeo,
    wallsMissing: !!walls && walls.status === "unavailable",
    smY,
    youY: youOk ? y.clamped(you!.cost!) : null,
    smOff,
    youOff: youOk ? offOf(you!.cost!) : null,
    bigBuys,
    sources: sources?.geo ?? null,
    sourcesMissing: !!buyers && buyers.status === "unavailable",
    pulse: pulse?.geo ?? null,
    pulseMissing: !!flow && flow.status === "unavailable",
    markers: [],
  };

  geo.markers = placeMarkers(geo, {
    buyers: sources ? { anchor: sources.anchor, tag: tagFor(1, buyers) } : null,
    flow: pulse ? { anchor: pulse.anchor, tag: tagFor(2, flow) } : null,
    wall: wall && isPos(wall.price) ? { price: wall.price, tag: tagFor(3, walls) } : null,
    // No wall above the price: marker 3 sits at today's price and says so ("NO SELL WALL").
    wallFallback: wallsGeo && !wall && priceNow ? { tag: tagFor(3, walls) } : null,
    smart: smartOk ? { tag: offTag(tagFor(4, smart), offOf(smart!.avgEntry!)) } : null,
    you: youOk ? { tag: offTag(tagFor(5, you), offOf(you!.cost!)) } : null,
  });
  // The band labels go where the price line, the SM line and the markers' tags leave room.
  if (wallsGeo) placeBandLabels(wallsGeo, series, smY, geo.markers);

  return geo;
}

/* ---------------------------------------------------------------- walls, bands, ladder */

function buildWalls(walls: WallsFinding, y: LogScale, priceNow: number | null, primary: Wall | null): WallsGeo {
  const bins = walls.ladder
    .filter((b) => isPos(b.lo) && isPos(b.hi) && b.hi > b.lo && isNum(b.supplyShare) && b.supplyShare >= 0)
    .slice()
    .sort((a, b) => a.lo - b.lo);
  const maxShare = bins.reduce((m, b) => Math.max(m, b.supplyShare), 0);

  // Peaks of the ladder become tissue bands: each peak grows over neighbours holding >= 70% of it
  // (at most 2 bins each side); a one-bin gap is kept between bands. Split at today's price later.
  type Raw = { lo: number; hi: number; weight: number };
  const raw: Raw[] = [];
  if (maxShare > 0) {
    const n = bins.length;
    const taken = new Uint8Array(n); // 1 = in a band, 2 = gap next to a band
    const contiguous = (a: number, b: number) => bins[b].lo <= bins[a].hi * 1.0001;
    const order = bins
      .map((_, i) => i)
      .filter((i) => bins[i].supplyShare >= maxShare * 0.3)
      .sort((a, b) => bins[b].supplyShare - bins[a].supplyShare);
    for (const i of order) {
      if (taken[i]) continue;
      const peak = bins[i].supplyShare;
      let l = i;
      let r = i;
      while (l > 0 && i - l < 2 && !taken[l - 1] && contiguous(l - 1, l) && bins[l - 1].supplyShare >= peak * 0.7) l--;
      while (r < n - 1 && r - i < 2 && !taken[r + 1] && contiguous(r, r + 1) && bins[r + 1].supplyShare >= peak * 0.7)
        r++;
      let weight = 0;
      for (let k = l; k <= r; k++) {
        taken[k] = 1;
        weight += bins[k].supplyShare;
      }
      if (l > 0 && !taken[l - 1]) taken[l - 1] = 2;
      if (r < n - 1 && !taken[r + 1]) taken[r + 1] = 2;
      raw.push({ lo: bins[l].lo, hi: bins[r].hi, weight: peak + (weight - peak) * 0.25 });
    }
  }
  const split: (Raw & { warm: boolean })[] = [];
  for (const r of raw) {
    if (priceNow && r.lo < priceNow && r.hi > priceNow) {
      const f = Math.round(((Math.log(r.hi) - Math.log(priceNow)) / (Math.log(r.hi) - Math.log(r.lo))) * 1e6) / 1e6;
      split.push({ lo: priceNow, hi: r.hi, weight: r.weight * f, warm: true });
      split.push({ lo: r.lo, hi: priceNow, weight: r.weight * (1 - f), warm: false });
    } else {
      split.push({ ...r, warm: priceNow ? r.lo >= priceNow : true });
    }
  }
  // Every wall gets a band even when the ladder is coarse.
  const wallList = walls.walls.filter((w) => isPos(w.price)).slice(0, 4);
  if (primary && !wallList.includes(primary)) wallList.unshift(primary);
  for (const w of wallList) {
    if (split.some((b) => w.price >= b.lo && w.price <= b.hi)) continue;
    split.push({
      lo: w.price / 1.05,
      hi: w.price * 1.05,
      weight: Math.max(w.supplyShare || 0, maxShare * 0.5),
      warm: priceNow ? w.price >= priceNow : true,
    });
  }
  split.sort((a, b) => b.weight - a.weight);
  const kept = split.slice(0, 7);
  const maxW = kept.reduce((m, b) => Math.max(m, b.weight), 0) || 1;

  const top = V.Y0 - 14;
  const bottom = V.Y1 + 14;
  const bands: BandGeo[] = [];
  for (const b of kept) {
    const y1 = clamp(y(b.hi), top, bottom);
    const y2 = clamp(y(b.lo), top, bottom);
    if (y2 - y1 < 1) continue;
    let h = y2 - y1;
    let yy = y1;
    if (h < 6) {
      yy -= (6 - h) / 2;
      h = 6;
    }
    bands.push({ y: yy, h, warm: b.warm, opacity: 0.5 + 0.5 * (b.weight / maxW) });
  }
  const warm = bands.filter((b) => b.warm);
  const cool = bands.filter((b) => !b.warm);
  const lossLabelY = warm.length ? Math.max(106, Math.min(...warm.map((b) => b.y)) - 9) : null;
  const profitLabelY = cool.length ? Math.min(V.Y1 + 36, Math.max(...cool.map((b) => b.y + b.h)) + 24) : null;

  // Supply that entered beyond the film's range: summed into the side ladder's notes, not dropped silently.
  let offAbove = 0;
  let offBelow = 0;
  for (const b of bins) {
    if (y(b.lo) < V.Y0 - 8) offAbove += b.supplyShare;
    else if (y(b.hi) > V.Y1 + 8) offBelow += b.supplyShare;
  }

  const ladder: LadderBarGeo[] = [];
  if (maxShare > 0) {
    for (const b of bins) {
      const yt = y(b.hi);
      const yb = y(b.lo);
      if (yb < V.Y0 - 8 || yt > V.Y1 + 8) continue;
      const mid = clamp((yt + yb) / 2, V.Y0 - 8, V.Y1 + 8);
      const h = clamp((yb - yt) * 0.6, 2.5, 6);
      const dens = b.supplyShare / maxShare;
      ladder.push({ y: mid - h / 2, h, w: Math.max(2, dens * V.LW), opacity: 0.25 + dens * 0.6 });
    }
  }

  return {
    bands,
    lossLabelY,
    profitLabelY,
    lossLabelX: V.X0 + 12,
    profitLabelX: V.X0 + 12,
    offAbove,
    offBelow,
    ladder,
    bins,
    partial: walls.status === "partial",
  };
}

/** Ladder bin containing `price` (bins sorted by lo), or null. */
export function binAt(bins: readonly LadderBin[], price: number): LadderBin | null {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bins[mid];
    if (price < b.lo) hi = mid - 1;
    else if (price >= b.hi) lo = mid + 1;
    else return b;
  }
  return null;
}

/* ---------------------------------------------------------------- 01 funding sources */

/** Longest cluster label on the film (characters); longer names end in "…". */
const CLUSTER_LABEL_MAX = 12;

/**
 * A cluster's name under its dots: the funder's short address ("0x5eed…9f3c", hex stays lower-case;
 * also for a Nansen "name" that is only its own address, "0xe9c4f6") or its entity name in capitals
 * ("BINANCE"), truncated to fit.
 */
const KIND_LABEL = (c: SourceCluster): string => {
  switch (c.kind) {
    case "self":
      return "SELF-FUNDED";
    case "untraced":
      return "UNTRACED";
    default: {
      const label = (c.label || "").trim();
      // Scans recorded before funders were named ("Funder A") keep the old generic label.
      if ((!label || /^Funder [A-Z]+$/.test(label)) && !c.funder) return c.kind === "wallet" ? "ONE WALLET" : c.kind.toUpperCase();
      const name = sourceName(c);
      const address = /^0x[0-9a-f]+(…[0-9a-f]+)?$/i.test(name) || /^[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{3,6}$/.test(name);
      const text = address ? name : name.toUpperCase();
      return text.length > CLUSTER_LABEL_MAX ? `${text.slice(0, CLUSTER_LABEL_MAX - 1).trimEnd()}…` : text;
    }
  }
};

function buildSources(
  b: BuyersFinding,
  tag: string,
): { geo: SourcesGeo; anchor: { x: number; y: number; right: boolean; lift?: boolean } } | null {
  const clusters = b.clusters.filter((c) => c.wallets > 0);
  const partial = b.status === "partial";

  if (!clusters.length) {
    // Concentration fallback (Solana / quick tier): the analysed buyers' share of all buying.
    if (!(b.topBuyers > 0)) return null;
    const share = clamp(isNum(b.topShare) ? b.topShare : 0, 0, 1);
    const bar = { x: V.SRC_X0, y: 668, w: 620, h: 18, share };
    const others = Math.max(0, (b.totalBuyers || 0) - b.topBuyers);
    // One short line that fits under the bar (the pipeline's note runs to 200+ characters and was cut
    // mid-sentence): why there are no funders, and how much the single largest buyer did.
    const top1 = clamp(isNum(b.biggestSourceShare) ? b.biggestSourceShare : 0, 0, 1);
    const reason = untracedReason(b).replace(/\.$/, "").toUpperCase();
    return {
      geo: {
        mode: "concentration",
        title: "BUYING CONCENTRATION",
        bar,
        text: `TOP ${b.topBuyers} BUYERS · ${formatPct(share, 0)} OF BUYING`,
        rest: others ? `${formatAmount(others)}${b.totalBuyersCapped ? "+" : ""} OTHER BUYERS` : "",
        note: b.topBuyers > 1 && top1 > 0 ? `${reason} · LARGEST BUYER ${formatPct(top1, 0)}` : reason,
        partial,
      },
      anchor: { x: bar.x + bar.w * share, y: bar.y + bar.h / 2, right: false },
    };
  }

  // Highlighted source = the largest single funding wallet; it goes first (mockup: "ONE WALLET").
  const sorted = clusters.slice().sort((a, c) => c.wallets - a.wallets);
  const hi = sorted.find((c) => c.kind === "wallet") ?? sorted[0];
  const ordered = [
    hi,
    ...sorted.filter((c) => c !== hi && c.kind !== "untraced"),
    ...sorted.filter((c) => c !== hi && c.kind === "untraced"),
  ];

  const total = ordered.reduce((s, c) => s + c.wallets, 0);
  const unit = total > 120 ? Math.ceil(total / 120) : 1;
  type Item = { c: SourceCluster; n: number; opacity: number; mode: "fill" | "stroke" };
  const items: Item[] = ordered.map((c) => ({
    c,
    n: Math.max(1, Math.round(c.wallets / unit)),
    opacity: c === hi ? 0.95 : c.kind === "untraced" ? 0.55 : 0.6,
    mode: c.kind === "untraced" ? "stroke" : "fill",
  }));

  // A clump reads "one funder, several buyers". Buyers funded from an exchange or bridge each count as
  // their own source, so a pair from Bitget is not a story: it joins the grid of independent buyers
  // (a big exchange clump such as BINANCE · 34 WALLETS stays, it says where the buyers came from).
  const service = (c: SourceCluster) => c.kind === "exchange" || c.kind === "bridge";
  const clump = (it: Item) => it.n >= 2 && (it.c === hi || !service(it.c) || it.c.wallets >= 3);
  let multi = items.filter(clump);
  let singles = items.filter((it) => !clump(it));
  if (!multi.length) {
    multi = [items[0]];
    singles = items.slice(1);
  }

  const LABEL_CH = 7.8;
  const SUB_CH = 7;
  const subOf = (w: number) => `${w} ${w === 1 ? "WALLET" : "WALLETS"}`;
  const labelWidth = (c: SourceCluster) => Math.max(KIND_LABEL(c).length * LABEL_CH, subOf(c.wallets).length * SUB_CH);
  const avail = V.SRC_X1 - V.SRC_X0 - 14;
  const maxN = Math.max(...multi.map((m) => m.n));
  let s = Math.min(6, 40 / Math.sqrt(Math.max(1, maxN - 1)));

  // `subs`: reserve room for the "N WALLETS" count of unnamed clumps too (only while it costs no dot size).
  let subs = true;
  const measure = (sp: number, ms: Item[], sg: Item[]) => {
    const r = clamp(3.4 * (sp / 6), 1.6, 3.4);
    const R = ms.map((m) => sp * Math.sqrt(m.n - 1) + r);
    const cell = Math.max(2 * r + 2, 16 * (sp / 6));
    const sgN = sg.reduce((acc, it) => acc + it.n, 0);
    const rows = sgN ? clamp(Math.round(Math.sqrt(sgN / 1.8)), 1, 5) : 0;
    const cols = rows ? Math.ceil(sgN / rows) : 0;
    const gridW = cols ? (cols - 1) * cell + 2 * r : 0;
    // Named: the highlighted source, then the next two or any big one, if it funded 3+ buyers (a pair is
    // counted with the other small clumps rather than crowding the row with another address).
    const labeled = ms.map((m, i) => i === 0 || ((i < 3 || m.c.wallets >= total * 0.06) && m.c.wallets >= 3));
    const halfW = ms.map((_, i) => R[i]);
    // An unnamed clump still gets its "N WALLETS" count, so it reserves that much room too.
    const labelW = ms.map((m, i) => (labeled[i] ? labelWidth(m.c) : subs ? subOf(m.c.wallets).length * SUB_CH : 0));
    const gaps: number[] = [];
    let width = 0;
    for (let i = 0; i < ms.length; i++) {
      width += 2 * halfW[i];
      if (i < ms.length - 1 || gridW) {
        const nextHalf = i < ms.length - 1 ? halfW[i + 1] : gridW / 2;
        const nextLabel = i < ms.length - 1 ? labelW[i + 1] : 13 * LABEL_CH;
        let g = 18;
        if (labelW[i] && nextLabel) g = Math.max(g, labelW[i] / 2 + nextLabel / 2 + 10 - halfW[i] - nextHalf);
        if (i === 0) g = Math.max(g, 72);
        gaps.push(g);
        width += g;
      }
    }
    width += gridW;
    return { r, R, cell, rows, cols, gridW, labeled, gaps, width };
  };

  let m = measure(s, multi, singles);
  if (m.width > avail) {
    subs = false;
    m = measure(s, multi, singles);
  }
  for (let pass = 0; pass < 3 && m.width > avail; pass++) {
    const gapSum = m.gaps.reduce((a, g) => a + g, 0);
    const f = Math.max(0.2, (avail - gapSum) / Math.max(1, m.width - gapSum));
    s = Math.max(2.2, s * f);
    m = measure(s, multi, singles);
  }
  while (m.width > avail && multi.length > 3) {
    const smallest = multi[multi.length - 1];
    multi = multi.slice(0, -1);
    singles = [...singles, smallest];
    m = measure(s, multi, singles);
  }

  // Spread over the free width: first let the gap after the highlighted source clear marker 1's tag,
  // then share what is left between the other gaps.
  if (m.gaps.length && m.width < avail) {
    let extra = avail - m.width;
    const want = Math.max(0, 63 + tagWidth(tag) - m.gaps[0]);
    const g0 = Math.min(extra, want);
    m.gaps[0] += g0;
    extra -= g0;
    const each = Math.min(48, (extra * 0.85) / m.gaps.length);
    for (let i = 0; i < m.gaps.length; i++) m.gaps[i] += each;
  }
  // Not enough room beside the first clump for marker 1's tag: it is lifted above the clumps' tops.
  const liftTag = m.gaps.length > 0 && m.gaps[0] < 63 + tagWidth(tag);

  // Merged targets.
  const targets: { item: Item; tx: number; ty: number }[] = [];
  // Label candidates, placed by priority (a named cluster, then the grid's label, then a bare wallet
  // count) so a small clump's "2 WALLETS" never pushes out the INDEPENDENT label of the grid.
  type LabelCand = SourcesClusterGeo["labels"][number] & { half: number; pri: number };
  const cands: LabelCand[] = [];
  const clumps: { x: number; wallets: number }[] = [];
  let cursor = V.SRC_X0 + 14;
  let anchor: { x: number; y: number; right: boolean; lift?: boolean } = { x: 0, y: 0, right: true };
  multi.forEach((it, i) => {
    const cx = cursor + m.R[i];
    for (let j = 0; j < it.n; j++) {
      const a = j * 2.39996;
      const rr = s * Math.sqrt(j);
      // Rounded: Math.cos/sin can differ in the last bits between Node (SSR) and the browser.
      targets.push({ item: it, tx: Math.round((cx + Math.cos(a) * rr) * 100) / 100, ty: Math.round((V.SRC_CY + Math.sin(a) * rr * 0.9) * 100) / 100 });
    }
    {
      // Named when it is one of the first three or a big one; otherwise (or when the name does not fit)
      // at least its wallet count, so no clump of dots is left unexplained.
      const halfL = labelWidth(it.c) / 2;
      const halfS = (subOf(it.c.wallets).length * SUB_CH) / 2;
      if (m.labeled[i]) cands.push({ x: cx, text: KIND_LABEL(it.c), sub: subOf(it.c.wallets), half: halfL, pri: i === 0 ? 0 : 1 });
      cands.push({ x: cx, text: "", sub: subOf(it.c.wallets), half: halfS, pri: 3 });
      clumps.push({ x: cx, wallets: it.c.wallets });
    }
    if (i === 0) anchor = { x: cx + m.R[0] + 19, y: V.SRC_CY - 30, right: true, lift: liftTag };
    cursor = cx + m.R[i] + (m.gaps[i] ?? 0);
  });
  if (m.rows) {
    const x0 = cursor + m.r;
    const gy0 = V.SRC_CY - ((m.rows - 1) * m.cell) / 2;
    let k = 0;
    for (const it of singles) {
      for (let j = 0; j < it.n; j++, k++) {
        const col = Math.floor(k / m.rows);
        const row = k % m.rows;
        targets.push({ item: it, tx: x0 + col * m.cell, ty: gy0 + row * m.cell });
      }
    }
    // One wallet per source reads INDEPENDENT; the untraced ones among them (hollow dots) are counted
    // apart instead of turning the whole grid into "small sources".
    const traced = singles.filter((it) => it.c.kind !== "untraced");
    const untracedN = singles.filter((it) => it.c.kind === "untraced").reduce((acc, it) => acc + it.c.wallets, 0);
    const allOne = traced.every((it) => it.c.wallets === 1 || service(it.c));
    const wallets = traced.reduce((acc, it) => acc + it.c.wallets, 0);
    const text = !traced.length ? "UNTRACED" : allOne ? "INDEPENDENT" : "SMALL SOURCES";
    const sub = !traced.length
      ? subOf(untracedN)
      : untracedN
        ? `${subOf(wallets)} · ${untracedN} UNTRACED`
        : subOf(wallets);
    const gx = x0 + (m.gridW - 2 * m.r) / 2;
    const half = Math.max(text.length * LABEL_CH, sub.length * SUB_CH) * 0.5;
    cands.push({ x: gx, text, sub, half, pri: 2 });
  }
  let labels: LabelCand[] = [];
  const fits = (list: LabelCand[], c: LabelCand) =>
    // One label per clump, none overlapping another or running past the strip.
    !list.some((l) => Math.abs(l.x - c.x) < 0.5) &&
    c.x + c.half <= V.SRC_X1 + 40 &&
    !list.some((l) => l.x - l.half - 8 < c.x + c.half && c.x - c.half < l.x + l.half + 8);
  for (const c of cands.filter((k) => k.pri <= 2).sort((a, b) => a.pri - b.pri)) if (fits(labels, c)) labels.push(c);
  // The remaining small clumps: each its own "2 WALLETS" when all of them fit; otherwise the clumps
  // between two named ones share one label ("3 MORE · 7 WALLETS") so none is left unexplained.
  const bare = clumps.filter((k) => !labels.some((l) => Math.abs(l.x - k.x) < 0.5));
  const own = [...labels];
  let all = true;
  for (const k of bare) {
    const c = cands.find((x) => x.pri === 3 && Math.abs(x.x - k.x) < 0.5)!;
    if (fits(own, c)) own.push(c);
    else all = false;
  }
  if (all) labels = own;
  else {
    const runs: (typeof bare)[] = [];
    for (const k of bare) {
      const run = runs[runs.length - 1];
      const between = run && labels.some((l) => l.x > run[run.length - 1].x && l.x < k.x);
      if (run && !between) run.push(k);
      else runs.push([k]);
    }
    for (const run of runs) {
      const x = run.reduce((a, k) => a + k.x, 0) / run.length;
      const wallets = run.reduce((a, k) => a + k.wallets, 0);
      const text = run.length > 1 ? `${run.length} MORE` : "";
      const sub = subOf(wallets);
      const c: LabelCand = { x, text, sub, half: Math.max(text.length * LABEL_CH, sub.length * SUB_CH) / 2, pri: 4 };
      if (fits(labels, c)) labels.push(c);
      else {
        // No room for the shared label either: as many single counts as fit.
        for (const k of run) {
          const one = cands.find((x2) => x2.pri === 3 && Math.abs(x2.x - k.x) < 0.5)!;
          if (fits(labels, one)) labels.push(one);
        }
      }
    }
  }
  labels.sort((a, b) => a.x - b.x);

  // Scattered row: every analysed buyer looks independent before the merge (deterministic shuffle).
  const N = targets.length;
  const order = targets.map((_, i) => i);
  const rnd = prng(N * 7919 + 17);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const twoRows = N > 90;
  const perRow = twoRows ? Math.ceil(N / 2) : N;
  const rowW = Math.min(600, perRow * 9);
  const groupsMap = new Map<Item, DotGroup>();
  order.forEach((ti, slot) => {
    const t = targets[ti];
    const row = twoRows ? slot % 2 : 0;
    const idx = twoRows ? Math.floor(slot / 2) : slot;
    const sx = V.SRC_X0 + (perRow > 1 ? (idx / (perRow - 1)) * rowW : 0);
    const sy = twoRows ? V.ROW_Y - 6 + row * 12 : V.ROW_Y;
    let g = groupsMap.get(t.item);
    if (!g) {
      g = { mode: t.item.mode, opacity: t.item.opacity, pts: [] };
      groupsMap.set(t.item, g);
    }
    g.pts.push(sx, sy, t.tx, t.ty);
  });

  const topBuyers = b.topBuyers > 0 ? b.topBuyers : total;
  return {
    geo: {
      mode: "clusters",
      title: `FUNDING SOURCES OF THE TOP ${topBuyers} BUYERS`,
      counter: { from: topBuyers, to: b.sources },
      r: m.r,
      groups: [...groupsMap.values()],
      labels: labels.map(({ x, text, sub }) => ({ x, text, sub })),
      partial,
    },
    anchor,
  };
}

/* ---------------------------------------------------------------- 02 informed-money pulse (ECG) */

interface Beat {
  net: number;
  cum: number;
}

function buildPulse(
  f: FlowFinding,
  x: TimeScale | null,
  meta: ScanMeta | null,
): { geo: PulseGeo; anchor: { x: number; y: number } } | null {
  const informed = f.series.find((s) => s.cohort === "informed")?.points.filter((p) => isNum(p.t)) ?? [];
  informed.sort((a, b) => a.t - b.t);

  let beats: Beat[] = [];
  let t0 = x?.t0 ?? parseTime(meta?.window.from);
  let t1 = x?.t1 ?? parseTime(meta?.window.to);

  if (informed.length >= 2) {
    if (t0 === null || t1 === null || !(t1 > t0)) {
      t0 = informed[0].t;
      t1 = informed[informed.length - 1].t;
    }
    const B = informed.length >= 28 ? 14 : clamp(informed.length, 1, 14);
    const dt = (t1 - t0) / B;
    const useCum = informed.some((p) => isNum(p.cumPctSupply) && p.cumPctSupply !== 0);
    let prevCum = 0;
    let run = 0;
    let pi = 0;
    for (let bi = 0; bi < B; bi++) {
      const end = bi === B - 1 ? Infinity : t0 + (bi + 1) * dt;
      let netUsd = 0;
      let lastCum: number | null = null;
      while (pi < informed.length && informed[pi].t < end) {
        const p = informed[pi++];
        if (isNum(p.netUsd)) netUsd += p.netUsd;
        if (isNum(p.cumPctSupply)) lastCum = p.cumPctSupply;
      }
      if (useCum) {
        const cum = lastCum ?? prevCum;
        beats.push({ net: cum - prevCum, cum });
        prevCum = cum;
      } else {
        run += netUsd;
        beats.push({ net: netUsd, cum: run });
      }
    }
  } else if (f.daily.length) {
    let run = 0;
    const days = f.daily.slice().sort((a, b) => a.day.localeCompare(b.day));
    beats = days.map((d) => {
      const net = isNum(d.informedUsd) ? d.informedUsd : 0;
      run += net;
      return { net, cum: run };
    });
    if (t0 === null || t1 === null) {
      const a = Date.parse(`${days[0].day}T00:00:00Z`);
      t0 = Number.isFinite(a) ? a : null;
      t1 = t0 !== null ? t0 + beats.length * 86_400_000 : null;
    }
  }
  if (!beats.length) return null;

  const B = beats.length;
  const maxNet = beats.reduce((m, b) => Math.max(m, Math.abs(b.net)), 0);
  const maxCum = beats.reduce((m, b) => Math.max(m, Math.abs(b.cum)), 0);
  const bw = (V.EX1 - V.EX0) / B;
  const sx = Math.min(1, bw / 30);
  const DRIFT = 22;
  const base = (cum: number) => V.EB - (maxCum > 0 ? (cum / maxCum) * DRIFT : 0);

  let d = `M${V.EX0} ${V.EB}`;
  const centers: { x: number; y: number }[] = [];
  beats.forEach((b, i) => {
    const bx = V.EX0 + (i + 0.5) * bw;
    const by = base(b.cum);
    const amp = maxNet > 0 ? 5 + 29 * Math.pow(Math.abs(b.net) / maxNet, 0.8) : 5;
    const dir = b.net < 0 ? 1 : -1; // selling pulls the trace down
    const over = Math.min(10, amp * 0.35);
    d +=
      ` L${(bx - 10 * sx).toFixed(1)} ${by.toFixed(1)}` +
      ` L${(bx - 4 * sx).toFixed(1)} ${(by - 6 * dir).toFixed(1)}` +
      ` L${bx.toFixed(1)} ${(by + amp * dir).toFixed(1)}` +
      ` L${(bx + 5 * sx).toFixed(1)} ${(by - over * dir).toFixed(1)}` +
      ` L${(bx + 12 * sx).toFixed(1)} ${by.toFixed(1)}`;
    centers.push({ x: bx, y: by });
  });
  d += ` L${V.EX1} ${base(beats[B - 1].cum).toFixed(1)}`;

  // Marker 2 sits on the beat that tells the story: the lead observation if any, else the turn.
  let at = 0;
  if (f.lead && isNum(f.lead.t) && t0 !== null && t1 !== null && t1 > t0) {
    at = clamp(Math.floor(((f.lead.t - t0) / (t1 - t0)) * B), 0, B - 1);
  } else {
    // Where informed money turned: the beat after the cumulative peak (distributing) or trough
    // (accumulating); otherwise the verdict's biggest beat.
    const sign = f.verdict === "distributing" ? 1 : f.verdict === "accumulating" ? -1 : 0;
    let turn = -1;
    if (sign) {
      let ext = 0;
      beats.forEach((b, i) => {
        if (sign * b.cum > sign * ext) {
          ext = b.cum;
          turn = i;
        }
      });
      if (turn >= B - 1) turn = -1;
      else if (turn >= 0) turn += 1;
    }
    if (turn >= 0) at = turn;
    else {
      let best = -Infinity;
      beats.forEach((b, i) => {
        const score = sign > 0 ? -b.net : sign < 0 ? b.net : Math.abs(b.net);
        if (score > best) {
          best = score;
          at = i;
        }
      });
    }
  }

  return {
    geo: {
      d,
      from: t0 !== null ? fmtDay(t0) : "",
      to: t1 !== null ? fmtDay(t1) : "",
      partial: f.status === "partial",
    },
    anchor: { x: centers[at].x, y: centers[at].y + 10 },
  };
}

/* ---------------------------------------------------------------- markers */

interface MarkerInputs {
  buyers: { anchor: { x: number; y: number; right: boolean; lift?: boolean }; tag: string } | null;
  flow: { anchor: { x: number; y: number }; tag: string } | null;
  wall: { price: number; tag: string } | null;
  wallFallback: { tag: string } | null;
  smart: { tag: string } | null;
  you: { tag: string } | null;
}

const RING = 17;

function placeMarkers(geo: FilmGeometry, inp: MarkerInputs): MarkerGeo[] {
  const out: MarkerGeo[] = [];
  const boxes: Box[] = [];
  const rings: Box[] = [];
  const { xs, ys } = geo.series;

  const mk = (
    n: MarkerN,
    cx: number,
    cy: number,
    tag: string,
    tx: number,
    ty: number,
    anchor: "start" | "end",
    color: string = C.marker,
  ): MarkerGeo => ({ n, cx, cy, tag, tx, ty, anchor, color, w: tagWidth(tag), label: `Finding ${n}: ${tag}` });

  const ringBox = (cx: number, cy: number): Box => ({ x: cx - RING, y: cy - RING, w: 2 * RING, h: 2 * RING });

  /** Price-line samples inside a box (the line should never run through a tag or a ring). */
  const lineHits = (b: Box, pad = 5) => {
    let hits = 0;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < b.x - pad || xs[i] > b.x + b.w + pad) continue;
      if (ys[i] >= b.y - pad && ys[i] <= b.y + b.h + pad) hits++;
    }
    return hits;
  };

  const score = (m: MarkerGeo, area: Box) => {
    const tb = tagBox(m);
    const rb = ringBox(m.cx, m.cy);
    let p = (lineHits(tb) + lineHits(rb, 2)) * 10;
    for (const o of [...boxes, ...rings]) {
      if (intersects(tb, o, 4)) p += 200;
      if (intersects(rb, o, 2)) p += 200;
    }
    if (tb.x < area.x || tb.x + tb.w > area.x + area.w || tb.y < area.y || tb.y + tb.h > area.y + area.h) p += 500;
    return p;
  };

  const commit = (m: MarkerGeo) => {
    out.push(m);
    boxes.push(tagBox(m));
    rings.push(ringBox(m.cx, m.cy));
  };

  // 01 · buyers (lower-left strip)
  if (inp.buyers) {
    const a = inp.buyers.anchor;
    const w = tagWidth(inp.buyers.tag);
    const cx = clamp(a.x, V.SRC_X0 + RING, V.SRC_X1 - RING);
    const cy = a.right ? a.y : a.y - 22;
    let tx = cx + 40;
    let anchor: "start" | "end" = "start";
    if (tx + w > V.EX0 - 16) {
      tx = cx - 40;
      anchor = "end";
    }
    commit(mk(1, cx, a.lift ? cy - 2 : cy, inp.buyers.tag, tx, a.lift ? cy - 10 : cy + 8, anchor));
  }

  // 02 · flow (pulse strip); the tag hangs below-right, clear of the day labels.
  if (inp.flow) {
    const { x: cx, y: cy } = inp.flow.anchor;
    const w = tagWidth(inp.flow.tag);
    // Centred under the ring, clear of the day labels at both ends of the strip.
    const tx = clamp(cx + w / 2, V.EX0 + 92 + w, V.EX1 - 92);
    commit(mk(2, cx, cy, inp.flow.tag, tx, 780, "end"));
  }

  const chart: Box = { x: V.X0 - 10, y: 98, w: V.LX - 6 - (V.X0 - 10), h: 582 - 98 };
  const xAt = (f: number) => V.X0 + f * (V.X1 - V.X0);
  const best = (cands: { m: MarkerGeo; bias: number }[]) => {
    let pick = cands[0];
    let ps = Infinity;
    for (const c of cands) {
      const s = score(c.m, chart) + c.bias;
      if (s < ps) {
        ps = s;
        pick = c;
      }
    }
    return pick.m;
  };

  // 03 · sell wall
  if (inp.wall || inp.wallFallback) {
    const yW = inp.wall ? geo.y.clamped(inp.wall.price) : geo.y.clamped(geo.priceNow!);
    const tag = inp.wall ? inp.wall.tag : inp.wallFallback!.tag;
    const cands: { m: MarkerGeo; bias: number }[] = [];
    for (let f = 0.6; f <= 0.8001; f += 0.04) {
      const cx = xAt(f);
      cands.push({ m: mk(3, cx, yW, tag, cx + 62, yW - 44, "start"), bias: Math.abs(f - 0.76) * 10 });
      cands.push({ m: mk(3, cx, yW, tag, cx + 62, yW + 58, "start"), bias: Math.abs(f - 0.76) * 10 + 3 });
    }
    commit(best(cands));
  }

  // 04 · smart-money entry
  if (inp.smart && geo.smY !== null) {
    const yS = geo.smY;
    const cands: { m: MarkerGeo; bias: number }[] = [];
    for (let f = 0.28; f <= 0.5601; f += 0.04) {
      const cx = xAt(f);
      cands.push({ m: mk(4, cx, yS, inp.smart.tag, cx + 40, yS + 58, "start"), bias: Math.abs(f - 0.44) * 10 });
      cands.push({ m: mk(4, cx, yS, inp.smart.tag, cx + 40, yS - 44, "start"), bias: Math.abs(f - 0.44) * 10 + 3 });
    }
    commit(best(cands));
  }

  // 05 · you (at the ladder, where your entry sits in the supply)
  if (inp.you && geo.youY !== null) {
    const yY = geo.youY;
    const cx = V.LX - 22;
    commit(
      best([
        { m: mk(5, cx, yY, inp.you.tag, V.LX - 60, yY - 34, "end", C.you), bias: 0 },
        { m: mk(5, cx, yY, inp.you.tag, V.LX - 60, yY + 48, "end", C.you), bias: 3 },
        { m: mk(5, cx, yY, inp.you.tag, V.LX - 60, yY + 7, "end", C.you), bias: 6 },
      ]),
    );
  }

  return out.sort((a, b) => a.n - b.n);
}

/* ---------------------------------------------------------------- crosshair readout */

export interface Readout {
  x: number | null;
  dotY: number | null;
  lines: [string, string, string];
}

/** Crosshair text for a point in film coordinates (null when outside the chart + ladder). */
export function readoutAt(geo: FilmGeometry, fx: number, fy: number): Readout | null {
  if (!geo.hasPrice && !geo.walls) return null;
  if (fx < V.X0 - 10 || fx > V.LX + V.LW + 10 || fy < V.Y0 - 20 || fy > V.Y1 + 20) return null;
  const level = geo.y.invert(clamp(fy, V.Y0, V.Y1));
  let x: number | null = null;
  let dotY: number | null = null;
  let l1 = "SUPPLY LADDER";
  if (geo.x && fx <= V.X1 + 4 && geo.series.t.length) {
    const i = nearestIndex(geo.series.t, geo.x.invert(fx));
    x = geo.series.xs[i];
    dotY = geo.series.ys[i];
    l1 = `${fmtStamp(geo.series.t[i])} · ${formatPrice(geo.series.c[i])}`;
  }
  const vsNow = geo.priceNow ? ` (${formatSignedPct(level / geo.priceNow - 1)})` : "";
  const l2 = `LEVEL ${formatPrice(level)}${vsNow}`;
  let l3 = "ENTERED HERE n/a";
  if (geo.walls) {
    const bin = binAt(geo.walls.bins, level);
    l3 = bin ? `ENTERED HERE ${formatPct(bin.supplyShare)} · ${formatAmount(bin.tokens)}` : "ENTERED HERE 0%";
  }
  return { x, dotY, lines: [l1, l2, l3] };
}
