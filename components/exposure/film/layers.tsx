"use client";
// SVG layers of the x-ray film. Each layer is memoised on the geometry so the per-frame props
// (reveal / merge / markers) only touch a clip rect, a transform or a single path attribute.
import { memo, type KeyboardEvent } from "react";
import { formatPct } from "@/lib/format";
import { C, V, dotsPath, mergeEase, tagBox, type FilmGeometry, type MarkerGeo, type MarkerN } from "./geometry";
import s from "./film.module.css";

export interface FilmIds {
  vign: string;
  soft: string;
  warm: string;
  cool: string;
  clip: string;
  beam: string;
  glow: string;
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

const LBL = { fontSize: 12, letterSpacing: "1.2" } as const;

/* ---------------------------------------------------------------- defs */

export const FilmDefs = memo(function FilmDefs({ ids }: { ids: FilmIds }) {
  const tissue = (id: string, c: string, a: number) => (
    <linearGradient id={id} x1={0} x2={0} y1={0} y2={1}>
      <stop offset="0" stopColor={c} stopOpacity={0.04} />
      <stop offset="0.5" stopColor={c} stopOpacity={a} />
      <stop offset="1" stopColor={c} stopOpacity={0.04} />
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
      {tissue(ids.warm, "#dbe9f5", 0.42)}
      {tissue(ids.cool, "#7fa2bd", 0.26)}
      <linearGradient id={ids.beam} x1={0} x2={1} y1={0} y2={0}>
        <stop offset="0" stopColor="#cfe6ff" stopOpacity={0} />
        <stop offset="0.85" stopColor="#cfe6ff" stopOpacity={0.18} />
        <stop offset="1" stopColor="#ffffff" stopOpacity={0.9} />
      </linearGradient>
    </>
  );
});

/* ---------------------------------------------------------------- base: vignette, plate, scale */

export const FilmBase = memo(function FilmBase({ geo, ids }: { geo: FilmGeometry; ids: FilmIds }) {
  const { missing, partial } = geo.status;
  return (
    <g>
      <rect x={0} y={0} width={V.W} height={V.H} fill={url(ids.vign)} />
      <g>
        <rect x={40} y={32} width={340} height={60} fill="rgba(233,242,249,0.04)" stroke="rgba(233,242,249,0.2)" />
        <text x={54} y={57} fontSize={16} fill={C.bone} letterSpacing="2">
          {geo.plate.name}
        </text>
        <text x={54} y={80} fontSize={11} fill={C.dim} letterSpacing="1.2">
          {geo.plate.sub}
        </text>
      </g>
      {missing.length > 0 && (
        <text x={400} y={57} fontSize={11} fill={C.dim} letterSpacing="1.2">
          NOT AVAILABLE · {missing.join(" · ")}
        </text>
      )}
      {partial.length > 0 && (
        <text x={400} y={missing.length ? 80 : 57} fontSize={11} fill={C.faint} letterSpacing="1.2">
          PARTIAL · {partial.join(" · ")}
        </text>
      )}
      <text x={1340} y={70} fontSize={34} fill="rgba(233,242,249,0.55)" fontWeight={500} textAnchor="end">
        7D
      </text>
      {geo.ticks.map((t) => (
        <g key={t.label}>
          <line x1={V.X0 - 16} x2={V.X0 - 6} y1={t.y} y2={t.y} stroke="rgba(233,242,249,0.25)" />
          <text x={V.X0 - 22} y={t.y + 4} fontSize={12} fill={C.faint} textAnchor="end">
            {t.label}
          </text>
        </g>
      ))}
      {geo.hasMeta && !geo.hasPrice && (
        <text
          x={(V.X0 + V.X1) / 2}
          y={(V.Y0 + V.Y1) / 2}
          fontSize={13}
          fill={C.faint}
          textAnchor="middle"
          letterSpacing="2"
        >
          NO PRICE DATA ON THIS FILM
        </text>
      )}
    </g>
  );
});

/* ---------------------------------------------------------------- tissue: bands, ladder, SM, YOU, big buys */

export const Tissue = memo(function Tissue({ geo, focus, ids }: { geo: FilmGeometry; focus: Focus; ids: FilmIds }) {
  const w = geo.walls;
  return (
    <g clipPath={url(ids.clip)}>
      {w && (
        <g {...layerProps(3, focus)}>
          {w.bands.map((b, i) => (
            <rect
              key={i}
              x={V.X0}
              width={V.X1 - V.X0}
              y={b.y}
              height={b.h}
              fill={url(b.warm ? ids.warm : ids.cool)}
              opacity={focus === 3 ? Math.min(1, b.opacity * 1.35) : b.opacity}
            />
          ))}
          {w.lossLabelY !== null && (
            <text x={w.lossLabelX} y={w.lossLabelY} fill={C.label} {...LBL} letterSpacing="2">
              HOLDERS AT A LOSS
            </text>
          )}
          {w.profitLabelY !== null && (
            <text x={w.profitLabelX} y={w.profitLabelY} fill={C.labelCool} {...LBL} letterSpacing="2">
              HOLDERS IN PROFIT
            </text>
          )}
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
            strokeOpacity={geo.smOff ? 0.45 : 0.75}
            strokeWidth={focus === 4 ? 2 : 1.4}
            strokeDasharray={geo.smOff ? "2 7" : "8 6"}
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
            strokeOpacity={focus === 5 ? 0.95 : 0.6}
            strokeWidth={focus === 5 ? 1.8 : 1.2}
            strokeDasharray="2 5"
            filter={glowIf(focus === 5, ids)}
          />
        </g>
      )}
      {geo.bigBuys.length > 0 && (
        <g {...layerProps(1, focus)}>
          {geo.bigBuys.map((d, i) => (
            <circle
              key={i}
              cx={d.cx}
              cy={d.cy}
              r={d.r}
              fill={C.bone}
              fillOpacity={focus === 1 ? Math.min(1, d.o + 0.25) : d.o}
            />
          ))}
        </g>
      )}
      {(w || geo.wallsMissing) && (
        <g {...layerProps(3, focus)}>
          {w?.ladder.map((b, i) => (
            <rect
              key={i}
              x={V.LX}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={b.h / 2}
              fill={C.band}
              fillOpacity={focus === 3 ? Math.min(1, b.opacity + 0.2) : b.opacity}
            />
          ))}
          <text x={V.LX} y={V.Y1 + 28} fontSize={11} fill={C.faint} letterSpacing="1.2">
            SUPPLY BY ENTRY PRICE
          </text>
          {/* Supply that entered beyond the film's price range, so the ladder never hides it. */}
          {w && w.offAbove >= 0.005 && (
            <text x={V.LX} y={V.Y0 - 16} fontSize={10.5} fill={C.dim} letterSpacing="1">
              ↑ {formatPct(w.offAbove, 0)} ENTERED HIGHER
            </text>
          )}
          {w && w.offBelow >= 0.005 && (
            <text x={V.LX} y={V.Y1 + 44} fontSize={10.5} fill={C.dim} letterSpacing="1">
              ↓ {formatPct(w.offBelow, 0)} ENTERED LOWER
            </text>
          )}
          {geo.wallsMissing && (
            <text x={V.LX} y={(V.Y0 + V.Y1) / 2} fontSize={11} fill={C.dim} letterSpacing="1.2">
              NOT AVAILABLE
            </text>
          )}
          {w?.partial && (
            <text x={V.LX} y={V.Y1 + (w.offBelow >= 0.005 ? 58 : 44)} fontSize={10} fill={C.faint} letterSpacing="1.2">
              PARTIAL
            </text>
          )}
        </g>
      )}
    </g>
  );
});

/* ---------------------------------------------------------------- bone: the 7-day price line */

export const BoneLine = memo(function BoneLine({ geo, ids }: { geo: FilmGeometry; ids: FilmIds }) {
  if (!geo.pricePath) return null;
  return (
    <>
      <path d={geo.pricePath} fill="none" stroke={C.glow} strokeWidth={7} strokeOpacity={0.28} filter={url(ids.soft)} />
      <path d={geo.pricePath} fill="none" stroke={C.boneLine} strokeWidth={2} strokeLinejoin="round" />
    </>
  );
});

export const NowMark = memo(function NowMark({ geo }: { geo: FilmGeometry }) {
  const n = geo.now;
  if (!n) return null;
  const w = n.label.length * 7.4 + 8;
  return (
    <g>
      <circle cx={n.x} cy={n.y} r={4.5} fill="#ffffff" />
      <rect x={n.x + 7} y={n.y - 9} width={w} height={17} fill="#070b10" fillOpacity={0.72} />
      <text x={n.x + 10} y={n.y + 4} fontSize={12} fill={C.bone}>
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
        <text x={V.X0} y={V.TITLE_Y} fill={C.faint} {...LBL}>
          FUNDING SOURCES
        </text>
        <text
          x={(V.SRC_X0 + V.SRC_X1) / 2}
          y={V.SRC_CY + 4}
          fontSize={12}
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
        <text x={V.X0} y={V.TITLE_Y} fill={C.faint} {...LBL}>
          {title}
        </text>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(233,242,249,0.06)" stroke="rgba(233,242,249,0.18)" />
        <rect x={b.x} y={b.y} width={b.w * b.share} height={b.h} fill={C.bone} fillOpacity={0.8} />
        <text x={b.x} y={b.y + b.h + 24} fontSize={12} fill={C.bone} letterSpacing="1.2">
          {src.text}
        </text>
        {src.rest && (
          <text x={b.x + b.w} y={b.y + b.h + 24} fontSize={11} fill={C.faint} textAnchor="end" letterSpacing="1.2">
            {src.rest}
          </text>
        )}
        {src.note && (
          <text x={V.X0} y={V.LABEL_Y} fontSize={10} fill={C.faint} letterSpacing="1">
            {src.note}
          </text>
        )}
      </g>
    );
  }

  const k = mergeEase(Math.min(1, Math.max(0, merge)));
  const counterX = V.X0 + title.length * 8.4 + 14;
  // Counts down from "90 OF 90" to "88 OF 90" as the dots merge: how many buyers had a funder of their own.
  const cur = Math.round(src.counter.from + (src.counter.to - src.counter.from) * k);
  return (
    <g {...layerProps(1, focus)}>
      <text x={V.X0} y={V.TITLE_Y} fill={C.faint} {...LBL}>
        {title}
      </text>
      {k > 0 && (
        <text x={counterX} y={V.TITLE_Y} fontSize={12} fill={C.dim} letterSpacing="1.2" opacity={Math.min(1, k * 3)}>
          · {cur} OF {src.counter.from} FUNDED INDEPENDENTLY
        </text>
      )}
      {src.groups.map((g, i) =>
        g.mode === "fill" ? (
          <path
            key={i}
            d={dotsPath(g.pts, k, src.r)}
            fill={C.bone}
            fillOpacity={focus === 1 ? Math.min(1, g.opacity + 0.2) : g.opacity}
          />
        ) : (
          <path
            key={i}
            d={dotsPath(g.pts, k, src.r - 0.6)}
            fill="none"
            stroke={C.bone}
            strokeOpacity={g.opacity}
            strokeWidth={1.2}
          />
        ),
      )}
      <g opacity={k}>
        {src.labels.map((l, i) => (
          <g key={i}>
            {l.text ? (
              <text x={l.x} y={V.LABEL_Y} fontSize={11} fill={C.dim} textAnchor="middle" letterSpacing="1.2">
                {l.text}
              </text>
            ) : null}
            <text x={l.x} y={V.SUB_Y} fontSize={10} fill={C.faint} textAnchor="middle" letterSpacing="1">
              {l.sub}
            </text>
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
      <text x={V.EX0} y={V.TITLE_Y} fill={C.faint} {...LBL}>
        {p?.partial ? "INFORMED MONEY · PULSE · PARTIAL" : "INFORMED MONEY · PULSE"}
      </text>
      {p ? (
        <>
          <text x={V.EX1} y={V.TITLE_Y} fontSize={10} fill={C.faint} textAnchor="end" letterSpacing="1">
            UP = BUYING · DOWN = SELLING
          </text>
          <line x1={V.EX0} x2={V.EX1} y1={V.EB} y2={V.EB} stroke="rgba(233,242,249,0.07)" strokeDasharray="2 6" />
          <path d={p.d} fill="none" stroke={C.glow} strokeWidth={5} strokeOpacity={0.22} filter={url(ids.soft)} />
          <path
            d={p.d}
            fill="none"
            stroke={C.bone}
            strokeWidth={focus === 2 ? 2 : 1.6}
            strokeLinejoin="round"
            filter={glowIf(focus === 2, ids)}
          />
          <text x={V.EX0} y={V.LABEL_Y} fontSize={11} fill={C.faint} letterSpacing="1.2">
            {p.from}
          </text>
          <text x={V.EX1} y={V.LABEL_Y} fontSize={11} fill={C.faint} textAnchor="end" letterSpacing="1.2">
            {p.to}
          </text>
        </>
      ) : (
        <text x={(V.EX0 + V.EX1) / 2} y={V.EB + 4} fontSize={12} fill={C.dim} textAnchor="middle" letterSpacing="1.2">
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
