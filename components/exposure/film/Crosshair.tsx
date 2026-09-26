"use client";
// Hover crosshair for the film: date/time + close, the price level under the cursor, and the share of
// supply that entered at that level (from the walls ladder). One rAF-throttled pointer handler that
// writes attributes directly (no React state per mouse move).
import { memo, useEffect, useRef, type RefObject } from "react";
import { C, V, readoutAt, type FilmGeometry } from "./geometry";
import s from "./film.module.css";

const BOX_W = 262;
const BOX_H = 64;

export const Crosshair = memo(function Crosshair({
  geo,
  svgRef,
}: {
  geo: FilmGeometry;
  svgRef: RefObject<SVGSVGElement | null>;
}) {
  const root = useRef<SVGGElement>(null);
  const vLine = useRef<SVGLineElement>(null);
  const hLine = useRef<SVGLineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const box = useRef<SVGGElement>(null);
  const t1 = useRef<SVGTextElement>(null);
  const t2 = useRef<SVGTextElement>(null);
  const t3 = useRef<SVGTextElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const rootEl = root.current;
    if (!svg) return;
    let raf = 0;
    let px = 0;
    let py = 0;
    let inside = false;
    let shown = false;

    const show = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      rootEl?.setAttribute("visibility", on ? "visible" : "hidden");
    };
    const setText = (el: SVGTextElement | null, v: string) => {
      if (el && el.textContent !== v) el.textContent = v;
    };

    const frame = () => {
      raf = 0;
      if (!inside) return show(false);
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return show(false);
      // viewBox 1400x800 with the default xMidYMid meet.
      const k = Math.min(r.width / V.W, r.height / V.H);
      const fx = (px - (r.left + (r.width - V.W * k) / 2)) / k;
      const fy = (py - (r.top + (r.height - V.H * k) / 2)) / k;
      const ro = readoutAt(geo, fx, fy);
      if (!ro) return show(false);

      const ly = Math.min(V.Y1, Math.max(V.Y0, fy));
      hLine.current?.setAttribute("y1", ly.toFixed(1));
      hLine.current?.setAttribute("y2", ly.toFixed(1));
      if (ro.x !== null && ro.dotY !== null) {
        vLine.current?.setAttribute("x1", ro.x.toFixed(1));
        vLine.current?.setAttribute("x2", ro.x.toFixed(1));
        vLine.current?.setAttribute("visibility", "visible");
        dot.current?.setAttribute("cx", ro.x.toFixed(1));
        dot.current?.setAttribute("cy", ro.dotY.toFixed(1));
        dot.current?.setAttribute("visibility", "visible");
      } else {
        vLine.current?.setAttribute("visibility", "hidden");
        dot.current?.setAttribute("visibility", "hidden");
      }
      setText(t1.current, ro.lines[0]);
      setText(t2.current, ro.lines[1]);
      setText(t3.current, ro.lines[2]);
      let bx = fx + 18;
      if (bx + BOX_W > V.W - 8) bx = fx - 18 - BOX_W;
      let by = fy + 18;
      if (by + BOX_H > V.H - 8) by = fy - 18 - BOX_H;
      box.current?.setAttribute("transform", `translate(${bx.toFixed(1)} ${by.toFixed(1)})`);
      show(true);
    };

    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      inside = true;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const onLeave = () => {
      inside = false;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    svg.addEventListener("pointermove", onMove, { passive: true });
    svg.addEventListener("pointerleave", onLeave);
    return () => {
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
      rootEl?.setAttribute("visibility", "hidden");
    };
  }, [geo, svgRef]);

  return (
    <g ref={root} className={s.cross} visibility="hidden" aria-hidden="true">
      <line
        ref={vLine}
        x1={0}
        x2={0}
        y1={V.Y0 - 20}
        y2={V.Y1 + 10}
        stroke="rgba(233,242,249,0.32)"
        strokeDasharray="3 4"
      />
      <line
        ref={hLine}
        x1={V.X0}
        x2={V.LX + V.LW}
        y1={0}
        y2={0}
        stroke="rgba(233,242,249,0.32)"
        strokeDasharray="3 4"
      />
      <circle ref={dot} cx={0} cy={0} r={4} fill="#070b10" stroke={C.glow} strokeWidth={1.6} />
      <g ref={box}>
        <rect x={0} y={0} width={BOX_W} height={BOX_H} fill={C.ink} fillOpacity={0.9} stroke="rgba(233,242,249,0.25)" />
        <text ref={t1} x={10} y={19} fontSize={12} fill={C.bone} letterSpacing="0.6" />
        <text ref={t2} x={10} y={37} fontSize={12} fill={C.dim} letterSpacing="0.6" />
        <text ref={t3} x={10} y={55} fontSize={12} fill={C.dim} letterSpacing="0.6" />
      </g>
    </g>
  );
});
