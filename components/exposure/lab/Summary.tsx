"use client";

// Summary: a dark bedside monitor with five channels (real buyers, informed flow, sell wall, smart
// money, you), each with its trace, its big coloured value and its flag word; every channel opens its
// tab. Under it the diagnosis stamp, the sentence and the three lights.
import type { FindingNo } from "@/lib/xray/copy";
import { abnormalFlag, diagnosisStamp, type MonitorChannel, type MonitorTrace } from "@/lib/xray/lab";
import type { Diagnosis, Light } from "@/lib/xray/types";
import { FitSvg, SCREEN, SCREEN_TONE, TabHead } from "./ui";

const TAB_NAME: Record<FindingNo, string> = { 1: "01 Buyers", 2: "02 Flow", 3: "03 Walls", 4: "04 Smart money", 5: "05 You" };

/* ------------------------------------------------------------------------------ traces */

function DotsTrace({ t, w, h, col }: { t: Extract<MonitorTrace, { kind: "dots" }>; w: number; h: number; col: string }) {
  const hasRight = t.right !== null;
  const leftW = hasRight ? w * 0.46 : w - 4;
  const n = Math.max(0, Math.min(t.left, 80));
  const scale = t.left > 0 ? n / t.left : 0;
  const hot = Math.round(t.leftHot * scale);
  const hollow = Math.round(t.leftHollow * scale);
  // Two rows as on the mockup; more rows when the channel is narrow (a phone).
  let rows = n > 40 ? 2 : 1;
  while (rows < 4 && (leftW - 4) / Math.ceil(n / rows) < 3.2) rows++;
  const cols = Math.max(1, Math.ceil(n / rows));
  const rowGap = rows <= 2 ? 12 : (h - 8) / rows;
  const pitch = Math.min(9, (leftW - 4) / cols);
  const r = Math.max(0.8, Math.min(2, pitch * 0.36));
  const dots = Array.from({ length: n }, (_, i) => {
    const cx = 2 + pitch / 2 + (i % cols) * pitch;
    const cy = h / 2 + (Math.floor(i / cols) - (rows - 1) / 2) * rowGap;
    if (i < hot) return <circle key={i} cx={cx} cy={cy} r={r + 0.3} fill={col} />;
    if (i >= n - hollow) return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={SCREEN.dim} strokeWidth={0.8} />;
    return <circle key={i} cx={cx} cy={cy} r={r} fill={SCREEN.dim} />;
  });
  if (!hasRight) return <>{dots}</>;
  const leftEnd = 2 + cols * pitch;
  const ax0 = leftEnd + 7;
  const ax1 = ax0 + Math.max(12, Math.min(24, w * 0.07));
  const m = Math.max(0, Math.min(t.right ?? 0, 40));
  const rx = ax1 + 10;
  const rw = Math.max(10, w - rx - 4);
  let p2 = 8.6;
  let cols2 = Math.max(1, Math.floor(rw / p2) + 1);
  while (Math.ceil(m / cols2) * Math.min(12, p2) > h - 6 && p2 > 3) {
    p2 -= 0.4;
    cols2 = Math.max(1, Math.floor(rw / p2) + 1);
  }
  const rows2 = Math.max(1, Math.ceil(m / cols2));
  // Balanced rows (12 + 11 rather than 19 + 4).
  cols2 = Math.max(1, Math.ceil(m / rows2));
  const gap2 = Math.min(12, p2 + 2);
  const y2 = (row: number) => h / 2 + (row - (rows2 - 1) / 2) * gap2;
  const small = Math.min(2.6, p2 * 0.32);
  return (
    <>
      {dots}
      <path d={`M${ax0} ${h / 2} L${ax1} ${h / 2}`} stroke={col} strokeWidth={2} />
      <path d={`M${ax1 - 6} ${h / 2 - 5} L${ax1 + 1} ${h / 2} L${ax1 - 6} ${h / 2 + 5}`} fill="none" stroke={col} strokeWidth={2} />
      {Array.from({ length: m }, (_, i) => {
        const big = i === 0 && t.rightHot;
        return <circle key={`s${i}`} cx={rx + (i % cols2) * p2} cy={y2(Math.floor(i / cols2))} r={big ? Math.min(5, small * 2) : small} fill={big ? col : SCREEN.ink} />;
      })}
    </>
  );
}

/** Fewer, wider beats on a narrow channel: each keeps its stretch's biggest spike and last baseline. */
function rebucket(beats: { base: number; spike: number }[], n: number): { base: number; spike: number }[] {
  if (beats.length <= n) return beats;
  const k = Math.ceil(beats.length / n);
  const out: { base: number; spike: number }[] = [];
  for (let i = 0; i < beats.length; i += k) {
    const group = beats.slice(i, i + k);
    const spike = group.reduce((a, b) => (Math.abs(b.spike) > Math.abs(a) ? b.spike : a), 0);
    out.push({ base: group[group.length - 1].base, spike });
  }
  return out;
}

function EcgTrace({ t, w, h, col }: { t: Extract<MonitorTrace, { kind: "ecg" }>; w: number; h: number; col: string }) {
  const mid = h / 2;
  if (!t.beats.length) {
    return <path d={`M0 ${mid} L${w} ${mid}`} stroke={col} strokeWidth={2} fill="none" />;
  }
  const beats = rebucket(t.beats, Math.max(6, Math.floor(w / 14)));
  const baseAmp = h * 0.24;
  const spikeAmp = h * 0.4;
  const step = w / beats.length;
  const half = Math.min(7, step * 0.45);
  const y = (v: number) => Math.max(2, Math.min(h - 2, v));
  const first = beats[0];
  let d = `M0 ${y(mid - first.base * baseAmp)}`;
  beats.forEach((b, i) => {
    const x = (i + 0.5) * step;
    const base = mid - b.base * baseAmp;
    // Square-root scaling keeps the quieter beats visible next to the week's biggest move.
    const amp = Math.sign(b.spike) * Math.sqrt(Math.abs(b.spike)) * spikeAmp;
    if (Math.abs(b.spike) < 0.04) d += ` L${x} ${y(base)}`;
    else
      d += ` L${x - half} ${y(base)} L${x - half * 0.35} ${y(base + amp * 0.2)} L${x} ${y(base - amp)} L${x + half * 0.45} ${y(base + amp * 0.3)} L${x + half} ${y(base)}`;
  });
  const last = beats[beats.length - 1];
  d += ` L${w} ${y(mid - last.base * baseAmp)}`;
  return <path d={d} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" />;
}

function BarTrace({ t, w, h, col }: { t: Extract<MonitorTrace, { kind: "bar" }>; w: number; h: number; col: string }) {
  const max = t.max > 0 ? t.max : 1;
  const fill = w * Math.max(0, Math.min(1, t.value / max));
  const rx = (w * t.ref) / max;
  const labelEnd = rx + 4 + t.refLabel.length * 6.5 > w;
  return (
    <>
      <rect x={0} y={h / 2 - 7} width={w} height={14} fill={SCREEN.track} />
      <rect x={0} y={h / 2 - 7} width={fill} height={14} fill={col} />
      <line x1={rx} x2={rx} y1={6} y2={h - 4} stroke={SCREEN.ink} strokeWidth={1.5} strokeDasharray="3 2" />
      <text x={labelEnd ? rx - 4 : rx + 4} y={10} fontSize={9} fill={SCREEN.dim} letterSpacing={1} textAnchor={labelEnd ? "end" : "start"}>
        {t.refLabel}
      </text>
    </>
  );
}

function MarksTrace({ t, w, h, col }: { t: Extract<MonitorTrace, { kind: "marks" }>; w: number; h: number; col: string }) {
  const y = h * 0.55;
  const pad = 14;
  const xs = t.marks.map((m) => pad + m.x * (w - pad * 2));
  // Labels above the line; one that would touch its left neighbour's goes below instead.
  const order = t.marks
    .map((m, i) => ({ m, x: xs[i] }))
    .sort((a, b) => a.x - b.x)
    .reduce<{ m: (typeof t.marks)[number]; x: number; top: boolean }[]>((acc, cur) => {
      const lastTop = [...acc].reverse().find((a) => a.top);
      acc.push({ ...cur, top: !lastTop || cur.x - lastTop.x >= 30 });
      return acc;
    }, []);
  return (
    <>
      <line x1={0} x2={w} y1={y} y2={y} stroke={SCREEN.line} strokeWidth={4} />
      {order.map(({ m, x, top }) => {
        const fill = m.key === "sm" ? SCREEN.green : m.key === "now" ? SCREEN.ink : col;
        return (
          <g key={m.key}>
            <circle cx={x} cy={y} r={m.key === "you" ? 7 : 5} fill={fill} />
            <text x={x} y={top ? 10 : h - 1} fontSize={9} fill={fill} textAnchor="middle" letterSpacing={1}>
              {m.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

function CheckTrace({ w, h }: { w: number; h: number }) {
  const bw = Math.min(w - 2, 168);
  return (
    <>
      <line x1={bw + 10} x2={w} y1={h / 2} y2={h / 2} stroke={SCREEN.line} strokeWidth={4} strokeDasharray="2 6" />
      <rect x={1} y={h / 2 - 11} width={bw} height={22} rx={11} fill="none" stroke={SCREEN.ink} strokeWidth={1.2} />
      <text x={1 + bw / 2} y={h / 2 + 4} fontSize={11} fontWeight={700} fill={SCREEN.ink} textAnchor="middle" letterSpacing={1.2}>
        CHECK A WALLET ›
      </text>
    </>
  );
}

function BlankTrace({ t, w, h }: { t: Extract<MonitorTrace, { kind: "blank" }>; w: number; h: number }) {
  const tw = t.text.length * 7 + 16;
  return (
    <>
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} stroke={SCREEN.line} strokeWidth={2} strokeDasharray="4 4" />
      <rect x={w / 2 - tw / 2} y={h / 2 - 8} width={tw} height={16} fill="#0b1512" />
      <text x={w / 2} y={h / 2 + 3.5} fontSize={10} fill={SCREEN.dim} textAnchor="middle" letterSpacing={1.5}>
        {t.text}
      </text>
    </>
  );
}

function Trace({ c, w, h }: { c: MonitorChannel; w: number; h: number }) {
  const col = SCREEN_TONE[c.flag.tone === "grey" ? c.valueTone : c.flag.tone];
  const t = c.trace;
  switch (t.kind) {
    case "dots":
      return <DotsTrace t={t} w={w} h={h} col={col} />;
    case "ecg":
      return <EcgTrace t={t} w={w} h={h} col={SCREEN_TONE[c.valueTone]} />;
    case "bar":
      return <BarTrace t={t} w={w} h={h} col={SCREEN_TONE[c.valueTone]} />;
    case "marks":
      return <MarksTrace t={t} w={w} h={h} col={SCREEN_TONE[c.valueTone]} />;
    case "check":
      return <CheckTrace w={w} h={h} />;
    default:
      return <BlankTrace t={t} w={w} h={h} />;
  }
}

function Channel({ c, onOpen }: { c: MonitorChannel; onOpen: (n: FindingNo) => void }) {
  return (
    <button
      type="button"
      className="lab-ch"
      onClick={() => onOpen(c.n)}
      aria-label={`${c.label} (${c.sub}): ${c.value}, flag ${c.flag.text.toLowerCase()}. Open ${TAB_NAME[c.n]}.`}
    >
      <span className="lab-ch-lab">
        {c.label}
        <small>{c.sub}</small>
      </span>
      <FitSvg height={44} label="" decorative minWidth={90} className="lab-ch-trace">
        {(w, h) => <Trace c={c} w={w} h={h} />}
      </FitSvg>
      <span className={`lab-ch-val is-${c.valueTone}`}>
        {c.value}
        <small className={`is-${c.flag.tone}`}>{c.flag.text}</small>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------------ the tab */

const LIGHTS: { key: keyof Diagnosis["lights"]; label: string; n: FindingNo }[] = [
  { key: "flow", label: "Flow", n: 2 },
  { key: "crowd", label: "Crowd", n: 1 },
  { key: "ceiling", label: "Ceiling", n: 3 },
];

const LIGHT_WORD: Record<Light, string> = { red: "red", amber: "amber", green: "green" };

export function SummaryTab({
  channels,
  diagnosis,
  evidence,
  onOpen,
}: {
  channels: MonitorChannel[];
  diagnosis: Diagnosis | null;
  /** "248 Nansen API calls · 271 credits", or null before the first call. */
  evidence: string | null;
  onOpen: (tab: FindingNo | "evidence") => void;
}) {
  const chip = abnormalFlag(channels);
  const stamp = diagnosisStamp(diagnosis);
  return (
    <div className="lab-sheet">
      <TabHead tag="Summary · vital signs" flag={chip} flagWhat="Vital signs" />
      <div className="lab-monitor" role="group" aria-label="Vital signs. Select a channel to open its tab.">
        {channels.map((c) => (
          <Channel key={c.n} c={c} onOpen={onOpen} />
        ))}
      </div>
      <div className="lab-dx">
        <div className={`lab-stamp is-${stamp.tone}`}>
          Diagnosis
          <b>{stamp.rule}</b>
          {stamp.confidence}
        </div>
        <div>
          <p className="lab-verdict">{diagnosis ? diagnosis.sentence : "The diagnosis appears when the scan finishes."}</p>
          <ul className="lab-lights" aria-label="Lights">
            {LIGHTS.map((l) => {
              const tone = diagnosis ? diagnosis.lights[l.key] : null;
              return (
                <li key={l.key}>
                  <button type="button" className={`is-${tone ?? "grey"}`} onClick={() => onOpen(l.n)} aria-label={`${l.label}: ${tone ? `${LIGHT_WORD[tone]} light` : "no reading"}. Open ${TAB_NAME[l.n]}.`}>
                    <i aria-hidden="true" />
                    {l.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {evidence ? (
        <p className="lab-foot-link">
          <button type="button" className="lab-link" onClick={() => onOpen("evidence")}>
            Evidence: {evidence} ›
          </button>
        </p>
      ) : null}
    </div>
  );
}
