"use client";

// 02 Flow: a tug of war (informed money on the left, fresh wallets on the right, the knot pulled towards
// whoever ends up with the supply, as far as informed money moved) and the informed money's daily net as
// diverging bars, the largest outflow labelled. The daily table sits behind "Show daily table".
import { FINDING_QUESTIONS, noteFor } from "@/lib/xray/copy";
import { dayLabel, flowAnswer, flowChart, flowFlag, noDash, signedUsd, type FlowChart } from "@/lib/xray/lab";
import type { FlowFinding, ScanMeta } from "@/lib/xray/types";
import { textWidth } from "./geometry";
import { Answer, C, Disclosure, FitSvg, Note, Placeholder, TabHead, TONE } from "./ui";

function TugOfWar({ chart, w, h }: { chart: FlowChart; w: number; h: number }) {
  const pad = 20;
  const mid = w / 2;
  const rope = 72;
  const knotX = mid + chart.knot * (w / 2 - pad) * 0.6;
  const leftCol = TONE[chart.left.tone];
  const rightCol = TONE[chart.right.tone];
  const capW = textWidth(chart.caption, 11.5, true, 1);
  const capX = Math.max(pad + capW / 2, Math.min(w - pad - capW / 2, knotX));
  return (
    <>
      <line x1={pad} x2={w - pad} y1={rope} y2={rope} stroke={C.rope} strokeWidth={5} strokeLinecap="round" />
      <line x1={mid} x2={mid} y1={30} y2={112} stroke={C.ink3} strokeWidth={1.5} strokeDasharray="4 3" />
      <rect x={pad} y={rope - 11} width={Math.max(0, knotX - pad)} height={22} rx={3} fill={leftCol} opacity={chart.left.tone === "grey" ? 0.45 : 1}>
        <title>{`Smart money, whales and public figures: ${chart.left.text}`}</title>
      </rect>
      <rect x={knotX} y={rope - 11} width={Math.max(0, w - pad - knotX)} height={22} rx={3} fill={rightCol} opacity={chart.right.tone === "grey" ? 0.45 : 0.85}>
        <title>{`Fresh wallets: ${chart.right.text}`}</title>
      </rect>
      <circle cx={knotX} cy={rope} r={13} fill={C.ink} />
      <text x={pad} y={34} fontSize={12} fontWeight={700} fill={leftCol === C.ink3 ? C.ink2 : leftCol} letterSpacing={1.2}>
        {chart.left.who}
      </text>
      <text x={pad} y={53} fontSize={15} fontWeight={700} fill={C.ink}>
        {chart.left.text}
      </text>
      <text x={w - pad} y={34} fontSize={12} fontWeight={700} fill={rightCol === C.ink3 ? C.ink2 : rightCol} textAnchor="end" letterSpacing={1.2}>
        {chart.right.who}
      </text>
      <text x={w - pad} y={53} fontSize={15} fontWeight={700} fill={C.ink} textAnchor="end">
        {chart.right.text}
      </text>
      <text x={capX} y={110} fontSize={11.5} fontWeight={700} fill={C.ink2} textAnchor="middle" letterSpacing={1} className="lab-halo">
        {chart.caption}
      </text>
      {chart.exchanges ? (
        <text x={mid} y={h - 8} fontSize={12} fill={C.ink2} textAnchor="middle">
          {chart.exchanges}
        </text>
      ) : null}
    </>
  );
}

function DailyBars({ chart, w, h }: { chart: FlowChart; w: number; h: number }) {
  const days = chart.days;
  const y0 = 46;
  const maxH = 30;
  const max = Math.max(1, ...days.map((d) => Math.abs(d.usd)));
  const slot = (w - 20) / Math.max(1, days.length);
  const bw = Math.min(40, slot * 0.6);
  return (
    <>
      <text x={10} y={12} fontSize={11} fill={C.ink3}>
        informed money, daily net
      </text>
      <line x1={10} x2={w - 10} y1={y0} y2={y0} stroke={C.ink3} />
      {days.map((d, i) => {
        const cx = 10 + slot * (i + 0.5);
        const hh = d.usd === 0 ? 0 : Math.max(1.5, (Math.abs(d.usd) / max) * maxH);
        const worst = i === chart.worst;
        return (
          <g key={d.day}>
            <title>{`${dayLabel(d.day)}: ${signedUsd(d.usd)}`}</title>
            <rect x={cx - bw / 2} y={d.usd > 0 ? y0 - hh : y0} width={bw} height={hh} fill={d.usd > 0 ? C.green : C.red} opacity={worst ? 1 : 0.72} />
            {worst ? (
              <>
                <text x={cx} y={y0 + maxH + 13} fontSize={9.5} fontWeight={700} fill={C.red} textAnchor="middle" letterSpacing={0.8}>
                  LARGEST OUTFLOW
                </text>
                <text x={cx} y={y0 + maxH + 25} fontSize={10.5} fontWeight={700} fill={C.red} textAnchor="middle">
                  {signedUsd(d.usd)}
                </text>
              </>
            ) : null}
            <text x={cx} y={h - 4} fontSize={11} fill={C.ink2} textAnchor="middle" letterSpacing={1}>
              {d.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

function DailyTable({ f }: { f: FlowFinding }) {
  const rows = [...f.daily].sort((a, b) => (a.day < b.day ? 1 : -1));
  const worst = rows.reduce<(typeof rows)[number] | null>((w, d) => (d.informedUsd < 0 && (!w || d.informedUsd < w.informedUsd) ? d : w), null);
  // Fresh wallets have no daily split in the recorded scans: a column of "n/a" only adds noise.
  const fresh = rows.some((d) => typeof d.freshUsd === "number" && Number.isFinite(d.freshUsd));
  if (!rows.length) return <p className="lab-text">No daily flow for this scan.</p>;
  return (
    <div className="lab-table-wrap">
      <table className="lab-table">
        <caption className="sr-only">Daily net flow by cohort, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col" className="r">
              Informed money
            </th>
            {fresh ? (
              <th scope="col" className="r">
                Fresh wallets
              </th>
            ) : null}
            <th scope="col" className="r">
              Exchanges
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day} className={d === worst ? "is-key" : undefined}>
              <td>
                {dayLabel(d.day)}
                {d === worst ? <span className="lab-rowtag">Largest outflow</span> : null}
              </td>
              <td className={`r${d.informedUsd < 0 ? " neg" : ""}`}>{signedUsd(d.informedUsd)}</td>
              {fresh ? <td className="r">{signedUsd(d.freshUsd)}</td> : null}
              <td className="r">{signedUsd(d.exchangeUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FlowTab({ f, meta }: { f: FlowFinding | null; meta: ScanMeta | null }) {
  const flag = flowFlag(f);
  const chart = flowChart(f, meta);
  const answer = flowAnswer(f, meta);
  return (
    <div className="lab-sheet">
      <TabHead tag="02 · Flow" flag={flag} question={FINDING_QUESTIONS[2]} status={f?.status} />
      {chart ? (
        <FitSvg height={150} label={`Tug of war: smart money and whales ${chart.left.text}, fresh wallets ${chart.right.text}. ${chart.caption.replace(/[←→]/g, "").trim().toLowerCase()}.`}>
          {(w, h) => <TugOfWar chart={chart} w={w} h={h} />}
        </FitSvg>
      ) : (
        <Placeholder text={f ? "No labelled flow this week" : "Reading the week's flows"} />
      )}
      <Answer a={answer} />
      {chart && chart.days.length ? (
        <FitSvg height={122} label="Daily net flow of informed money: bars up are net buying, bars down net selling">
          {(w, h) => <DailyBars chart={chart} w={w} h={h} />}
        </FitSvg>
      ) : null}
      {f && chart ? (
        <Disclosure what="daily table">
          <DailyTable f={f} />
          {/* noteFor(2) already carries the definition, the partial-data line and the lead observation. */}
          <Note>{noDash(noteFor(2, f))}</Note>
        </Disclosure>
      ) : null}
    </div>
  );
}
