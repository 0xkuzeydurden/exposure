"use client";

// 04 Smart money: a semicircle gauge of today's price against smart money's average entry (loss red,
// break-even amber, profit green), logarithmic in the price multiple and widened to fit the reading
// (-50%..2x, up to 5x, 10x ...), the needle at today's price and a stance badge under the pivot.
// Too few wallets, none, or no data: a grey gauge and one clear line. Aggregate only.
import { FINDING_QUESTIONS, noteFor } from "@/lib/xray/copy";
import { hasSmartData } from "@/lib/xray/diagnosis";
import { formatSignedPct, formatUsdCompact } from "@/lib/format";
import { gaugePos, noDash, price, signedUsd, smartAnswer, smartGauge, smartTabFlag, type SmartGauge } from "@/lib/xray/lab";
import type { ScanMeta, SmartFinding } from "@/lib/xray/types";
import { textWidth } from "./geometry";
import { Answer, C, Disclosure, FitSvg, Note, num, TabHead, TONE } from "./ui";

function Gauge({ g, w }: { g: SmartGauge; w: number }) {
  const R = Math.max(80, Math.min(150, w / 2 - 56));
  const cx = w / 2;
  const cy = R + 30;
  const stroke = Math.max(16, R * 0.17);
  const ang = (v: number) => Math.PI * (1 - gaugePos(g, v));
  const pt = (v: number, r: number) => [cx + r * Math.cos(ang(v)), cy - r * Math.sin(ang(v))] as const;
  const arc = (a: number, b: number) => {
    const [x0, y0] = pt(a, R);
    const [x1, y1] = pt(b, R);
    return `M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}`;
  };
  const grey = g.needle === null;
  const ticks: [number, string][] = g.ticks.map((t) => [t.v, t.label]);
  // Zone words at the zone's middle on the arc (the arc is logarithmic, so the middle of the multiples).
  const midOf = (a: number, b: number) => Math.sqrt((1 + a) * (1 + b)) - 1;
  const lossMid = midOf(g.zones[0].from, g.zones[0].to);
  const profitMid = midOf(g.zones[2].from, g.zones[2].to);
  const badge = g.stance ? `${g.stance.word} ${g.stance.arrow}` : g.blank ?? "";
  const bw = textWidth(badge, 13, true, 1.5) + 26;
  const badgeCol = g.stance ? TONE[g.stance.tone] : C.ink3;
  return (
    <>
      {g.zones.map((z) => (
        <path key={z.tone} d={arc(z.from, z.to)} fill="none" stroke={grey ? C.independent : TONE[z.tone]} strokeWidth={stroke} />
      ))}
      {ticks.map(([v, t]) => {
        const [x, y] = pt(v, R + stroke / 2 + 13);
        // The two ends sit beside the arc's feet: anchored outwards so they never touch the band.
        const p = gaugePos(g, v);
        const anchor = p < 0.02 ? "end" : p > 0.98 ? "start" : "middle";
        const dx = anchor === "end" ? 4 : anchor === "start" ? -4 : 0;
        return (
          <text key={t} x={x + dx} y={y + 4} fontSize={11} fontWeight={700} fill={C.ink2} textAnchor={anchor}>
            {t}
          </text>
        );
      })}
      {!grey ? (
        <>
          {(
            [
              [lossMid, "LOSS"],
              [profitMid, "PROFIT"],
            ] as const
          ).map(([v, t]) => {
            // Written along the arc, so the word stays inside the band at any size.
            const [x, y] = pt(v, R);
            const deg = 90 - (ang(v) * 180) / Math.PI;
            return (
              <text
                key={t}
                x={x}
                y={y}
                dy="0.35em"
                transform={`rotate(${deg} ${x} ${y})`}
                fontSize={Math.min(11, stroke * 0.5)}
                fontWeight={700}
                fill="#fff"
                textAnchor="middle"
                letterSpacing={1}
              >
                {t}
              </text>
            );
          })}
          <line
            x1={cx}
            y1={cy}
            x2={pt(g.needle as number, R - stroke - 8)[0]}
            y2={pt(g.needle as number, R - stroke - 8)[1]}
            stroke={C.ink}
            strokeWidth={5}
            strokeLinecap="round"
          />
        </>
      ) : null}
      <circle cx={cx} cy={cy} r={10} fill={grey ? C.ink3 : C.ink} />
      {badge ? (
        <g>
          <rect x={cx - bw / 2} y={cy + 18} width={bw} height={30} fill={grey ? "none" : "rgba(255,255,255,.35)"} stroke={badgeCol} strokeWidth={1.5} />
          <text x={cx} y={cy + 38} fontSize={13} fontWeight={700} fill={badgeCol === C.ink3 ? C.ink2 : badgeCol} textAnchor="middle" letterSpacing={1.5}>
            {badge}
          </text>
        </g>
      ) : null}
      {g.offScale && g.needle !== null ? (
        <text x={cx} y={cy - 22} fontSize={10} fill={C.ink2} textAnchor="middle">
          {g.needle >= g.max ? "beyond the scale ↗" : "beyond the scale ↖"}
        </text>
      ) : null}
    </>
  );
}

function AggregateTable({ s, meta }: { s: SmartFinding; meta: ScanMeta | null }) {
  const rows: [string, string][] = [
    ["Average entry", `${price(s.avgEntry)} (${s.windowDays}-day VWAP)`],
    ["Price now", price(meta?.priceNow)],
    ["Bought", formatUsdCompact(s.boughtUsd)],
    ["Sold", formatUsdCompact(s.soldUsd)],
    ["Net", signedUsd(s.netUsd)],
    ["Stance", `${s.stance} (from net ÷ gross flow)`],
    ["Wallets", `${num(s.wallets)}, aggregated, never per wallet`],
  ];
  return (
    <div className="lab-table-wrap">
      <table className="lab-table lab-kv">
        <caption className="sr-only">Smart money in aggregate</caption>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SmartTab({ s, meta }: { s: SmartFinding | null; meta: ScanMeta | null }) {
  const flag = smartTabFlag(s);
  const g = smartGauge(s);
  const answer = smartAnswer(s);
  const label =
    g.needle !== null && s
      ? `Gauge: price is ${formatSignedPct(s.pnlPct)} against smart money's average entry; ${g.stance ? g.stance.word.toLowerCase() : ""}`
      : `Gauge without a reading: ${(g.blank ?? "").toLowerCase()}`;
  return (
    <div className="lab-sheet">
      <TabHead tag="04 · Smart money" flag={flag} question={FINDING_QUESTIONS[4]} status={s?.status} />
      <FitSvg height={(w) => Math.max(80, Math.min(150, w / 2 - 56)) + 30 + 56} label={label}>
        {(w) => <Gauge g={g} w={w} />}
      </FitSvg>
      <Answer a={answer} />
      <p className="lab-method">
        Aggregate only, per Nansen&apos;s data rules{s && s.wallets > 0 ? ` · ${num(s.wallets)} ${s.wallets === 1 ? "wallet" : "wallets"} · ${s.windowDays} days` : ""}
      </p>
      {s && hasSmartData(s) ? (
        <Disclosure what="aggregate numbers">
          <AggregateTable s={s} meta={meta} />
          <Note>
            {noDash(noteFor(4, s))} No smart-money wallet, label or address is listed anywhere in EXPOSURE.
          </Note>
        </Disclosure>
      ) : s ? (
        <Note>{noDash(noteFor(4, s))}</Note>
      ) : null}
    </div>
  );
}
