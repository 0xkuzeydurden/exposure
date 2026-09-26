"use client";
// The x-ray film on the lightbox (SVG, no WebGL). Port of the approved mockup's film
// (v3) driven by real scan data: every coordinate comes from
// ./film/geometry.ts, which is memoised on the data. The animation props (reveal, beam, merge,
// markers, focus) only move a clip rect, a transform, one path per dot group and a few opacities.
import { useId, useMemo, useRef, useState } from "react";
import type { FilmProps } from "@/lib/xray/types";
import { buildFilmGeometry, V } from "./film/geometry";
import { BoneLine, FilmBase, FilmDefs, Markers, NowMark, Pulse, Sources, Tissue, type FilmIds } from "./film/layers";
import { Crosshair } from "./film/Crosshair";
import s from "./film/film.module.css";

const ZERO5 = [0, 0, 0, 0, 0] as const;

function useFilmIds(): FilmIds {
  const raw = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return useMemo(
    () => ({
      vign: `xf${raw}v`,
      soft: `xf${raw}s`,
      warm: `xf${raw}w`,
      cool: `xf${raw}c`,
      clip: `xf${raw}r`,
      beam: `xf${raw}b`,
      glow: `xf${raw}g`,
    }),
    [raw],
  );
}

/** O(1) identity for the arrays, so a parent re-creating `price` / `bigBuys` each frame does not re-layout. */
function arraySig(a: readonly { t: number }[], val: (i: number) => number): string {
  const n = a.length;
  return n ? `${n}:${a[0].t}:${a[n - 1].t}:${val(n - 1)}:${val(n >> 1)}` : "0";
}

export default function Film({
  meta,
  price,
  bigBuys,
  buyers,
  flow,
  walls,
  smart,
  you,
  reveal,
  beam,
  merge,
  markers,
  focus,
  onMarkerClick,
  className,
}: FilmProps) {
  const ids = useFilmIds();
  const svgRef = useRef<SVGSVGElement>(null);

  const priceSig = arraySig(price, (i) => price[i].c);
  const buysSig = arraySig(bigBuys, (i) => bigBuys[i].usd);
  const geo = useMemo(
    () => buildFilmGeometry({ meta, price, bigBuys, buyers, flow, walls, smart, you }),
    // Arrays are keyed by content signature, findings by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, priceSig, buysSig, buyers, flow, walls, smart, you],
  );

  // Marker n pulses once when `markers` steps up to n (again after a reset to 0 for the next patient).
  // Only a one-step rise pulses (the report lighting findings one by one); a jump (0 → 5 when a
  // recorded scan is shown fully read) updates silently, and so does a film that mounts fully read.
  const shown = Math.max(0, Math.min(5, Math.floor(markers || 0)));
  const [pulse, setPulse] = useState<{ prev: number; gens: readonly number[] }>(() => ({ prev: shown, gens: ZERO5 }));
  if (shown !== pulse.prev) {
    setPulse({
      prev: shown,
      gens: shown === pulse.prev + 1 ? pulse.gens.map((g, i) => (i + 1 === shown ? g + 1 : g)) : pulse.gens,
    });
  }

  const r = Math.max(0, Math.min(1, Number.isFinite(reveal) ? reveal : 1));
  const bx = r * V.W;
  const boneOpacity = 0.55 + 0.45 * Math.min(1, r * 3);
  const available = geo.markers.map((m) => m.n);

  return (
    <svg
      ref={svgRef}
      className={className ? `${s.film} ${className}` : s.film}
      viewBox={`0 0 ${V.W} ${V.H}`}
      role="group"
      aria-label={
        geo.hasMeta
          ? `X-ray film of ${geo.plate.name}${available.length ? ` with findings ${available.join(", ")}` : ""}`
          : "Empty x-ray film"
      }
    >
      <defs>
        <FilmDefs ids={ids} />
        <clipPath id={ids.clip}>
          <rect x={0} y={0} width={bx} height={V.H} />
        </clipPath>
      </defs>

      <FilmBase geo={geo} ids={ids} />

      {geo.hasMeta && (
        <>
          <Tissue geo={geo} focus={focus} ids={ids} />

          <g style={{ opacity: focus !== null ? 0.4 : boneOpacity }}>
            <BoneLine geo={geo} ids={ids} />
          </g>
          <NowMark geo={geo} />

          <g clipPath={`url(#${ids.clip})`}>
            <line x1={40} x2={1360} y1={V.STRIP_Y} y2={V.STRIP_Y} stroke="rgba(233,242,249,0.08)" />
            <Sources geo={geo} merge={merge} focus={focus} />
            <Pulse geo={geo} focus={focus} ids={ids} />
          </g>

          <g className={s.beam} style={{ opacity: beam ? 1 : 0 }} transform={`translate(${bx.toFixed(1)},0)`}>
            <rect x={-90} y={0} width={90} height={V.H} fill={`url(#${ids.beam})`} />
            <line x1={0} x2={0} y1={0} y2={V.H} stroke="#ffffff" strokeWidth={1.5} />
          </g>

          <Crosshair geo={geo} svgRef={svgRef} />

          <Markers markers={geo.markers} shown={shown} focus={focus} gens={pulse.gens} onMarkerClick={onMarkerClick} />
        </>
      )}
    </svg>
  );
}

export { Film };
