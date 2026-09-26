"use client";
// SVG layers of the x-ray film. Each layer is memoised on the geometry so the per-frame props
// (reveal / merge / markers) only touch a clip rect, a transform or a single path attribute.
import { memo, type KeyboardEvent } from "react";
import { formatPct } from "@/lib/format";
import {
  C,
  FS,
  V,
  dotsPath,
  mergeEase,
  tagBox,
  type FilmGeometry,
  type MarkerGeo,
  type MarkerN,
  type ZoneLabelGeo,
} from "./geometry";
import s from "./film.module.css";

export interface FilmIds {
  vign: string;
  soft: string;
  warm: string;
  cool: string;
  clip: string;
  beam: string;
  glow: string;
  pulse: string;
}

export type Focus = MarkerN | null;

const url = (id: string) => `url(#${id})`;

/** Class for a finding layer under the current focus (others dim to ~20%). */
function layerProps(n: MarkerN, focus: Focus) {
  if (focus === null) return { className: s.layer };
  if (focus === n) return { className: `${s.layer} ${s.hot}` };
  return { className: `${s.layer} ${s.dim}` };
}

/** Glow filter for the focused layer's strokes (never on text: it would smear the letters). */
const glowIf = (on: boolean, ids: FilmIds) => (on ? url(ids.glow) : undefined);

/**
 * A dark outline painted under the letters (paint-order, not a filter): keeps a label legible where it
 * crosses a band, the price line or a dot. `pre` keeps the spaces between a label's tspans.
 */
const HALO = {
  stroke: "#070b10",
  strokeWidth: 5,
  strokeLinejoin: "round",
  paintOrder: "stroke",
  style: { whiteSpace: "pre" },
} as const;

const TONE = { sell: C.warmText, buy: C.coolText, flat: C.dim } as const;

/* ---------------------------------------------------------------- defs */

export const FilmDefs = memo(function FilmDefs({ ids }: { ids: FilmIds }) {
  // Tinted bands fade out at their top and bottom edge; each band's opacity sets its strength.
  const tissue = (id: string, c: string) => (
    <linearGradient id={id} x1={0} x2={0} y1={0} y2={1}>
      <stop offset="0" stopColor={c} stopOpacity={0.3} />
      <stop offset="0.5" stopColor={c} stopOpacity={1} />
      <stop offset="1" stopColor={c} stopOpacity={0.3} />
    </linearGradient>
  );
  return (
    <>
      <radialGradient id={ids.vign} cx="50%" cy="45%" r="75%">
        <stop offset="0" stopColor="#0f1822" />
        <stop offset="1" stopColor="#04070a" />
      </radialGradient>
      <filter id={ids.soft} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="5" />
      </filter>
      <filter id={ids.glow} x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      {tissue(ids.warm, C.warm)}
      {tissue(ids.cool, C.cool)}
      {/* Pulse fill: green above the zero line, red below, stronger further from it. */}
      <linearGradient id={ids.pulse} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={V.EB - 56} y2={V.EB + 56}>
        <stop offset="0" stopColor={C.cool} stopOpacity={0.45} />
        <stop offset="0.5" stopColor={C.cool} stopOpacity={0.14} />
        <stop offset="0.5" stopColor={C.warm} stopOpacity={0.14} />
        <stop offset="1" stopColor={C.warm} stopOpacity={0.45} />
      </linearGradient>
      <linearGradient id={ids.beam} x1={0} x2={1} y1={0} y2={0}>
        <stop offset="0" stopColor="#cfe6ff" stopOpacity={0} />
        <stop offset="0.85" stopColor="#cfe6ff" stopOpacity={0.18} />
        <stop offset="1" stopColor="#ffffff" stopOpacity={0.9} />
      </linearGradient>
    </>
  );
});

/* ---------------------------------------------------------------- base: vignette, plate, guide, scale */

export const FilmBase = memo(function FilmBase({ geo, ids }: { geo: FilmGeometry; ids: FilmIds }) {
  const { missing, partial, x: sx } = geo.status;
  return (
    <g>
      <rect x={0} y={0} width={V.W} height={V.H} fill={url(ids.vign)} />
      <g>
        <rect x={40} y={22} width={geo.plate.w} height={64} fill="rgba(233,242,249,0.05)" stroke="rgba(233,242,249,0.28)" />
        <text x={56} y={51} fontSize={FS.plate} fontWeight={500} fill={C.bone} letterSpacing="2">
          {geo.plate.name}
        </text>
        <text x={56} y={75} fontSize={FS.plateSub} fill={C.dim} letterSpacing="1.2">
          {geo.plate.sub}
        </text>
      </g>
      {missing.length > 0 && (
        <text x={sx} y={49} fontSize={FS.status} fill={C.dim} letterSpacing="1">
          NOT AVAILABLE · {missing.join(" · ")}
        </text>
      )}
      {partial.length > 0 && (
        <text x={sx} y={missing.length ? 73 : 49} fontSize={FS.status} fill={C.dim} letterSpacing="1">
          PARTIAL · {partial.join(" · ")}
        </text>
      )}
      <text x={1360} y={70} fontSize={34} fill="rgba(233,242,249,0.6)" fontWeight={500} textAnchor="end">
        7D
      </text>
      {geo.guide.length > 0 && (
        <text x={40} y={V.GUIDE_Y} fontSize={FS.guide} fill={C.dim} style={{ whiteSpace: "pre" }}>
          {geo.guide.map((g, i) => (
            <tspan key={g.lead}>
              {i > 0 ? " · " : ""}
              <tspan fill={g.tone === "warm" ? C.warmText : g.tone === "cool" ? C.coolText : C.bone} fontWeight={600}>
                {g.lead}
              </tspan>
              {g.text}
            </tspan>
          ))}
        </text>
      )}
      {geo.ticks.map((t) => (
        <g key={t.label}>
          <line x1={V.X0 - 10} x2={V.X0 - 2} y1={t.y} y2={t.y} stroke="rgba(233,242,249,0.45)" />
          <text x={V.X0 - 14} y={t.y + 6} fontSize={FS.tick} fill={C.dim} textAnchor="end">
            {t.label}
          </text>
        </g>
      ))}
      {/* Today's price across the chart: the line between the two zones. */}
      {geo.now && (
        <line
          x1={V.X0}
          x2={V.X1}
          y1={geo.now.y}
          y2={geo.now.y}
          stroke={C.bone}
          strokeOpacity={0.5}
          strokeWidth={1.2}
          strokeDasharray="7 6"
        />
      )}
      {geo.hasMeta && !geo.hasPrice && (
        <text
          x={(V.X0 + V.X1) / 2}
          y={(V.Y0 + V.Y1) / 2}
          fontSize={FS.zone}
          fill={C.dim}
          textAnchor="middle"
          letterSpacing="2"
        >
          NO PRICE DATA ON THIS FILM
        </text>
      )}
    </g>
  );
});

/* ---------------------------------------------------------------- tissue: zones, bands, ladder, SM, YOU, big buys */

export const Tissue = memo(function Tissue({ geo, focus, ids }: { geo: FilmGeometry; focus: Focus; ids: FilmIds }) {
  const w = geo.walls;
  return (
    <g clipPath={url(ids.clip)}>
      {w && (
        <g {...layerProps(3, focus)}>
          {w.zones && (
            <>
              <rect x={V.X0} width={V.X1 - V.X0} y={w.zones.warm.y} height={w.zones.warm.h} fill={C.warm} fillOpacity={0.05} />
              <rect x={V.X0} width={V.X1 - V.X0} y={w.zones.cool.y} height={w.zones.cool.h} fill={C.cool} fillOpacity={0.045} />
            </>
          )}
          {w.bands.map((b, i) => (
            <rect
              key={i}
              x={V.X0}
              width={V.X1 - V.X0}
              y={b.y}
              height={b.h}
              fill={url(b.warm ? ids.warm : ids.cool)}
              opacity={focus === 3 ? Math.min(0.85, b.opacity * 1.35) : b.opacity}
            />
          ))}
        </g>
      )}
      {geo.smY !== null && (
        <g {...layerProps(4, focus)}>
          {/* Beyond the film's range the line is parked at the edge, fainter and dotted (its tag has the arrow). */}
          <line
            x1={V.X0}
            x2={V.X1}
            y1={geo.smY}
            y2={geo.smY}
            stroke={C.bone}
            strokeOpacity={geo.smOff ? 0.5 : 0.85}
            strokeWidth={focus === 4 ? 2.4 : 1.8}
            strokeDasharray={geo.smOff ? "2 7" : "10 7"}
            filter={glowIf(focus === 4, ids)}
          />
        </g>
      )}
      {geo.youY !== null && (
        <g {...layerProps(5, focus)}>
          <line
            x1={V.X0}
            x2={V.X1}
            y1={geo.youY}
            y2={geo.youY}
            stroke={C.you}
            strokeOpacity={focus === 5 ? 0.95 : 0.7}
            strokeWidth={focus === 5 ? 2 : 1.5}
            strokeDasharray="2 5"
            filter={glowIf(focus === 5, ids)}
          />
        </g>
      )}
      {geo.bigBuys.length > 0 && (
        <g {...layerProps(1, focus)}>
          {geo.bigBuys.map((d, i) => (
            <g key={i}>
              <circle cx={d.cx} cy={d.cy} r={d.r + 3} fill="none" stroke={C.bone} strokeOpacity={0.32} strokeWidth={1} />
              <circle cx={d.cx} cy={d.cy} r={d.r} fill={C.bone} fillOpacity={focus === 1 ? Math.min(1, d.o + 0.2) : d.o} />
            </g>
          ))}
        </g>
      )}
      {(w || geo.wallsMissing) && (
        <g {...layerProps(3, focus)}>
          <text x={V.LX + V.LW} y={V.Y0 - 32} fontSize={FS.ladder} fill={C.dim} textAnchor="end" letterSpacing="1">
            SUPPLY BY ENTRY PRICE
          </text>
          {w && <line x1={V.LX} x2={V.LX} y1={V.Y0 - 6} y2={V.Y1 + 6} stroke="rgba(233,242,249,0.25)" />}
          {w?.ladder.map((b, i) => (
            <rect
              key={i}
              x={V.LX}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={2}
              fill={b.warm ? C.warm : C.cool}
              fillOpacity={b.wall ? 1 : focus === 3 ? Math.min(1, b.opacity + 0.15) : b.opacity}
              stroke={b.wall ? C.warmText : undefined}
              strokeWidth={b.wall ? 1.5 : undefined}
            />
          ))}
          {/* Today's price on the ladder: warm bars above it, cool below. */}
          {w && geo.now && (
            <line
              x1={V.LX - 8}
              x2={V.LX + V.LB + 6}
              y1={geo.now.y}
              y2={geo.now.y}
              stroke={C.bone}
              strokeOpacity={0.85}
              strokeWidth={1.6}
            />
          )}
          {/* After the NOW tick, so its halo keeps the tick from striking through the wall's share. */}
          {w?.wallLabel && (
            <text x={w.wallLabel.x} y={w.wallLabel.y} fontSize={FS.wallPct} fontWeight={600} fill={C.warmText} {...HALO}>
              {w.wallLabel.text}
            </text>
          )}
          {/* Supply that entered beyond the film's price range, so the ladder never hides it. */}
          {w && w.offAbove >= 0.005 && (
            <text x={V.LX + V.LW} y={V.Y0 - 12} fontSize={FS.ladder} fill={C.dim} textAnchor="end" letterSpacing="0.5">
              ↑ {formatPct(w.offAbove, 0)} ENTERED HIGHER
            </text>
          )}
          {w && w.offBelow >= 0.005 && (
            <text x={V.LX + V.LW} y={V.Y1 + 26} fontSize={FS.ladder} fill={C.dim} textAnchor="end" letterSpacing="0.5">
              ↓ {formatPct(w.offBelow, 0)} ENTERED LOWER
            </text>
          )}
          {geo.wallsMissing && (
            <text x={V.LX} y={(V.Y0 + V.Y1) / 2} fontSize={FS.ladder} fill={C.dim} letterSpacing="1">
              NOT AVAILABLE
            </text>
          )}
          {w?.partial && (
            <text
              x={V.LX + V.LW}
              y={V.Y1 + (w.offBelow >= 0.005 ? 46 : 26)}
              fontSize={FS.ladder}
              fill={C.dim}
              textAnchor="end"
              letterSpacing="1"
            >
              PARTIAL
            </text>
          )}
        </g>
      )}
    </g>
  );
});

/* ---------------------------------------------------------------- zone labels (over the price line) */

export const ZoneLabels = memo(function ZoneLabels({ geo, focus }: { geo: FilmGeometry; focus: Focus }) {
  const w = geo.walls;
  if (!w || (!w.loss && !w.profit)) return null;
  const label = (l: ZoneLabelGeo, color: string) => (
    <text x={l.x} y={l.y} fill={color} {...HALO}>
      <tspan fontSize={FS.zonePct} fontWeight={600} letterSpacing="0.5">
        {l.pct}
      </tspan>
      <tspan fontSize={FS.zone} fontWeight={500} letterSpacing="1">
        {l.text}
      </tspan>
      {l.note ? (
        <tspan fontSize={FS.zoneNote} fill={C.dim} letterSpacing="1">
          {`  ${l.note}`}
        </tspan>
      ) : null}
    </text>
  );
  return (
    <g {...layerProps(3, focus)}>
      {w.loss && label(w.loss, C.warmText)}
      {w.profit && label(w.profit, C.coolText)}
    </g>
  );
});

/* ---------------------------------------------------------------- bone: the 7-day price line */

export const BoneLine = memo(function BoneLine({ geo, ids }: { geo: FilmGeometry; ids: FilmIds }) {
  if (!geo.pricePath) return null;
  return (
    <>
      <path d={geo.pricePath} fill="none" stroke={C.glow} strokeWidth={7} strokeOpacity={0.28} filter={url(ids.soft)} />
      <path d={geo.pricePath} fill="none" stroke={C.boneLine} strokeWidth={2.4} strokeLinejoin="round" />
    </>
  );
});

export const NowMark = memo(function NowMark({ geo }: { geo: FilmGeometry }) {
  const n = geo.now;
  if (!n) return null;
  const t = n.tag;
  return (
    <g>
      <circle cx={n.x} cy={n.y} r={10} fill="none" stroke="#ffffff" strokeOpacity={0.4} strokeWidth={1.2} />
      <circle cx={n.x} cy={n.y} r={5.5} fill="#ffffff" />
      <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={3} fill={C.bone} />
      <text x={t.x + 8} y={t.y + t.h / 2 + n.size * 0.36} fontSize={n.size} fontWeight={700} fill={C.ink} letterSpacing="0.4">
        {n.label}
      </text>
    </g>
  );
});

/* ---------------------------------------------------------------- lower strip: sources + pulse */

export const Sources = memo(function Sources({
  geo,
  merge,
  focus,
}: {
  geo: FilmGeometry;
  merge: number;
  focus: Focus;
}) {
  const src = geo.sources;
  if (!src) {
    if (!geo.sourcesMissing) return null;
    return (
      <g>
        <text x={40} y={V.TITLE_Y} fontSize={FS.title} fill={C.dim} letterSpacing="1.2">
          FUNDING SOURCES
        </text>
        <text
          x={(V.SRC_X0 + V.SRC_X1) / 2}
          y={V.SRC_CY + 6}
          fontSize={FS.zone}
          fill={C.dim}
          textAnchor="middle"
          letterSpacing="1.2"
        >
          NOT AVAILABLE
        </text>
      </g>
    );
  }
  const title = src.partial ? `${src.title} · PARTIAL` : src.title;

  if (src.mode === "concentration") {
    const b = src.bar;
    return (
      <g {...layerProps(1, focus)}>
        <text x={40} y={V.TITLE_Y} fontSize={FS.title} fill={C.dim} letterSpacing="1.2">
          {title}
        </text>
        <text x={40} y={V.HEAD_Y} fontSize={FS.head} fontWeight={600} fill={C.bone} letterSpacing="0.5" {...HALO}>
          {src.head}
        </text>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(233,242,249,0.07)" stroke="rgba(233,242,249,0.3)" />
        <rect x={b.x} y={b.y} width={b.w * b.share} height={b.h} fill={C.bone} fillOpacity={0.85} />
        {src.rest && (
          <text x={b.x} y={716} fontSize={FS.name} fill={C.dim} letterSpacing="1">
            {src.rest}
          </text>
        )}
        {src.note && (
          <text x={b.x} y={742} fontSize={FS.name} fill={C.dim} letterSpacing="1">
            {src.note}
          </text>
        )}
      </g>
    );
  }

  const k = mergeEase(Math.min(1, Math.max(0, merge)));
  // Counts down from "90 OF 90" to "88 OF 90" as the dots merge: how many buyers had a funder of their own.
  const cur = Math.round(src.counter.from + (src.counter.to - src.counter.from) * k);
  return (
    <g {...layerProps(1, focus)}>
      <text x={40} y={V.TITLE_Y} fontSize={FS.title} fill={C.dim} letterSpacing="1.2">
        {title}
      </text>
      {k > 0 && (
        <text x={40} y={V.HEAD_Y} fill={C.bone} opacity={Math.min(1, k * 3)} {...HALO}>
          <tspan fontSize={FS.head} fontWeight={600} letterSpacing="0.5">
            {`${cur} OF ${src.counter.from} ${src.short ? "" : "BUYERS "}FUNDED INDEPENDENTLY`}
          </tspan>
          {src.extra ? (
            <tspan fontSize={FS.headExtra} fontWeight={500} fill={C.warmText} letterSpacing="0.5">
              {src.extra}
            </tspan>
          ) : null}
        </text>
      )}
      {src.groups.map((g, i) =>
        g.mode === "fill" ? (
          <path
            key={i}
            d={dotsPath(g.pts, k, src.r)}
            fill={C.bone}
            fillOpacity={focus === 1 ? Math.min(1, g.opacity + 0.15) : g.opacity}
          />
        ) : (
          <path
            key={i}
            d={dotsPath(g.pts, k, src.r - 0.7)}
            fill="none"
            stroke={C.bone}
            strokeOpacity={g.opacity}
            strokeWidth={1.5}
          />
        ),
      )}
      <g opacity={k}>
        {src.labels.map((l, i) => (
          <g key={i}>
            <text x={l.x} y={V.NUM_Y} fontSize={FS.num} fontWeight={600} fill={C.bone} textAnchor="middle">
              {l.count}
            </text>
            {l.name ? (
              <text x={l.x} y={V.NAME_Y} fontSize={FS.name} fill={C.dim} textAnchor="middle" letterSpacing="1">
                {l.name}
              </text>
            ) : null}
          </g>
        ))}
      </g>
    </g>
  );
});

export const Pulse = memo(function Pulse({ geo, focus, ids }: { geo: FilmGeometry; focus: Focus; ids: FilmIds }) {
  const p = geo.pulse;
  if (!p && !geo.pulseMissing) return null;
  return (
    <g {...(p ? layerProps(2, focus) : {})}>
      <text x={V.EX0} y={V.TITLE_Y} fontSize={FS.title} fill={C.dim} letterSpacing="1.2">
        {p?.partial ? "INFORMED MONEY · PULSE · PARTIAL" : "INFORMED MONEY · PULSE"}
      </text>
      {p ? (
        <>
          {p.net && (
            <text x={V.EX0} y={V.HEAD_Y} fontSize={FS.net} fontWeight={600} fill={TONE[p.net.tone]} letterSpacing="0.5" {...HALO}>
              {p.net.text}
            </text>
          )}
          <path d={p.area} fill={url(ids.pulse)} />
          <line x1={V.EX0} x2={V.EX1} y1={V.EB} y2={V.EB} stroke={C.bone} strokeOpacity={0.4} strokeWidth={1.2} />
          {/* The zero line's scale: net buying pulls the trace up, net selling down. */}
          <text x={V.EX1 + 8} y={V.EB - 16} fontSize={FS.legend} fill={C.coolText}>
            BUY ↑
          </text>
          <text x={V.EX1 + 8} y={V.EB + 5} fontSize={FS.legend} fill={C.dim}>
            0
          </text>
          <text x={V.EX1 + 8} y={V.EB + 27} fontSize={FS.legend} fill={C.warmText}>
            SELL ↓
          </text>
          <path d={p.d} fill="none" stroke={C.glow} strokeWidth={6} strokeOpacity={0.2} filter={url(ids.soft)} />
          <path
            d={p.d}
            fill="none"
            stroke={C.bone}
            strokeWidth={focus === 2 ? 3 : 2.6}
            strokeLinejoin="round"
            filter={glowIf(focus === 2, ids)}
          />
          <text x={V.EX0} y={V.DATE_Y} fontSize={FS.date} fill={C.dim} letterSpacing="1">
            {p.from}
          </text>
          <text x={V.EX1} y={V.DATE_Y} fontSize={FS.date} fill={C.dim} textAnchor="end" letterSpacing="1">
            {p.to}
          </text>
        </>
      ) : (
        <text
          x={(V.EX0 + V.EX1) / 2}
          y={V.EB + 6}
          fontSize={FS.zone}
          fill={C.dim}
          textAnchor="middle"
          letterSpacing="1.2"
        >
          NOT AVAILABLE
        </text>
      )}
    </g>
  );
});

/* ---------------------------------------------------------------- markers */

export interface MarkersProps {
  markers: MarkerGeo[];
  shown: number;
  focus: Focus;
  gens: readonly number[];
  onMarkerClick?: (n: MarkerN) => void;
}

export const Markers = memo(function Markers({ markers, shown, focus, gens, onMarkerClick }: MarkersProps) {
  return (
    <g>
      {markers.map((m) => (
        <Marker
          key={m.n}
          m={m}
          visible={m.n <= shown}
          dim={focus !== null && focus !== m.n}
          gen={gens[m.n - 1] ?? 0}
          onClick={onMarkerClick}
        />
      ))}
    </g>
  );
});

function Marker({
  m,
  visible,
  dim,
  gen,
  onClick,
}: {
  m: MarkerGeo;
  visible: boolean;
  dim: boolean;
  gen: number;
  onClick?: (n: MarkerN) => void;
}) {
  const live = visible && !!onClick;
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (!live) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick!(m.n);
    }
  };
  const end = m.anchor === "end";
  // Leader from the ring to the nearest point of the tag box (the ring hides its first 17px).
  const box = tagBox(m);
  const lx = Math.min(box.x + box.w, Math.max(box.x, m.cx));
  const ly = Math.min(box.y + box.h, Math.max(box.y, m.cy));
  return (
    <g
      className={s.marker}
      data-live={live}
      style={{ opacity: visible ? (dim ? 0.35 : 1) : 0 }}
      role={onClick ? "button" : undefined}
      tabIndex={live ? 0 : -1}
      aria-hidden={!visible}
      aria-label={m.label}
      onClick={live ? () => onClick!(m.n) : undefined}
      onKeyDown={onKey}
    >
      <line x1={m.cx} y1={m.cy} x2={lx} y2={ly} stroke={m.color} strokeWidth={1.4} />
      {gen > 0 && visible && (
        <circle
          key={`h${gen}`}
          className={s.halo}
          cx={m.cx}
          cy={m.cy}
          r={17}
          fill="none"
          stroke={m.color}
          strokeWidth={1.5}
        />
      )}
      <circle
        key={`r${gen}`}
        className={`${s.ring} ${gen > 0 ? s.pulse : ""}`}
        cx={m.cx}
        cy={m.cy}
        r={17}
        fill={C.ink}
        stroke={m.color}
        strokeWidth={2.2}
      />
      <text x={m.cx} y={m.cy + 6} fontSize={17} fontWeight={500} fill={m.color} textAnchor="middle">
        {m.n}
      </text>
      <rect
        className={s.tagBox}
        x={end ? m.tx - m.w : m.tx - 2}
        y={m.ty - 21}
        width={m.w}
        height={28}
        fill={C.ink}
        stroke={m.color}
        strokeOpacity={0.55}
      />
      <text
        x={end ? m.tx - 9 : m.tx + 7}
        y={m.ty - 2}
        fontSize={15}
        fontWeight={500}
        fill={m.color}
        textAnchor={m.anchor}
        letterSpacing="0.5"
      >
        {m.tag}
      </text>
    </g>
  );
}
