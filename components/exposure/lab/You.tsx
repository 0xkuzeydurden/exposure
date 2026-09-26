"use client";

// 05 You: the analysed holders' entry prices as a histogram (from the walls ladder) with smart money's
// entry, today's price and yours as lines, and a green bar for the share of holdings that got in
// cheaper. Before a wallet is checked: the wallet input and a ghost of the same chart.
import { useState } from "react";
import { WalletForm, type WalletUi } from "@/components/exposure/Report";
import { noteFor } from "@/lib/xray/copy";
import { formatAmount, formatPct, formatPrice, formatSignedPct } from "@/lib/format";
import { NA, noDash, price, symbolText, youAnswer, youChart, youTabFlag, type FlagTone, type YouChart } from "@/lib/xray/lab";
import type { ScanMeta, SmartFinding, WalletCheck, WallsFinding } from "@/lib/xray/types";
import { logScale, placeLabels, textWidth } from "./geometry";
import { Address, Answer, C, Disclosure, FitSvg, nansenProfilerUrl, Note, Placeholder, TabHead, TONE } from "./ui";

export const YOU_QUESTION = "Did you buy before or after smart money?";

function Distribution({ chart, w, h, youTone }: { chart: YouChart; w: number; h: number; youTone: FlagTone }) {
  const base = 100;
  const maxH = 66;
  const x0 = 20;
  const x1 = w - 20;
  const ex = logScale(chart.lo, chart.hi, x0, x1);
  const maxTokens = Math.max(1e-12, ...chart.bins.map((b) => b.tokens));
  const ghost = !chart.checked;
  const youCol = youTone === "grey" ? C.ink : TONE[youTone];
  const lines = [
    ...(chart.sm !== null ? [{ key: "sm", p: chart.sm, col: C.green, text: `SMART MONEY ${price(chart.sm)}`, wide: 2 }] : []),
    ...(chart.now !== null ? [{ key: "now", p: chart.now, col: C.blue, text: `NOW ${price(chart.now)}`, wide: 2 }] : []),
    ...(chart.you !== null ? [{ key: "you", p: chart.you, col: youCol, text: `YOU ${price(chart.you)}`, wide: 3 }] : []),
  ];
  const labels = placeLabels(
    lines.map((l) => ({ x: ex(l.p), width: textWidth(l.text, 11, true) })),
    w,
    [12, 26, 40],
  );
  const cheaper = chart.cheaperShare;
  const cheaperText = cheaper !== null ? `${formatPct(cheaper, 0)} OF HOLDINGS GOT IN CHEAPER` : "";
  return (
    <>
      {chart.bins.map((b) => {
        const hh = (b.tokens / maxTokens) * maxH;
        const xa = ex(b.lo);
        const xb = ex(b.hi);
        return (
          <rect key={`${b.lo}-${b.hi}`} x={xa + 0.75} y={base - hh} width={Math.max(1, xb - xa - 1.5)} height={hh} fill={ghost ? C.ghost : b.cheaper ? C.greenSoft : C.pale}>
            <title>{`Entry ${formatPrice(b.lo)} to ${formatPrice(b.hi)}: ${formatAmount(b.tokens)} tokens`}</title>
          </rect>
        );
      })}
      <line x1={x0} x2={x1} y1={base} y2={base} stroke={C.ink} />
      {!ghost && cheaper !== null && chart.you !== null ? (
        <>
          <rect x={x0} y={base + 10} width={Math.max(2, ex(chart.you) - x0)} height={10} fill={C.green} opacity={0.85} />
          <text x={x0 + 4} y={base + 38} fontSize={11.5} fontWeight={700} fill={C.green} letterSpacing={1}>
            {textWidth(cheaperText, 11.5, true, 1) < w - 40 ? cheaperText : `${formatPct(cheaper, 0)} GOT IN CHEAPER`}
          </text>
        </>
      ) : null}
      {lines.map((l, i) => {
        const x = ex(l.p);
        const lab = labels[i];
        return (
          <g key={l.key}>
            <line x1={x} x2={x} y1={lab.y + 2} y2={base + 4} stroke={l.col} strokeWidth={l.wide} />
            <text x={lab.x} y={lab.y} fontSize={11} fontWeight={700} fill={l.col} textAnchor={lab.anchor} className="lab-halo">
              {l.text}
            </text>
          </g>
        );
      })}
      {ghost ? (
        <text x={w / 2} y={70} fontSize={11.5} fontWeight={700} fill={C.ink2} textAnchor="middle" letterSpacing={1} className="lab-halo">
          YOUR ENTRY LANDS ON THIS CHART
        </text>
      ) : null}
      <text x={x1} y={h - 6} fontSize={11} fill={C.ink3} textAnchor="end">
        entry prices of analysed holders
      </text>
    </>
  );
}

function YourNumbers({ you, meta }: { you: WalletCheck; meta: ScanMeta | null }) {
  const rows: [string, string][] = [
    ["Your entry", `${price(you.cost)} (average buy price)`],
    ["Vs smart money's entry", you.vsSmartMoneyPct !== null ? formatSignedPct(you.vsSmartMoneyPct) : NA],
    ["Now vs your entry", you.pnlPct !== null ? `${formatSignedPct(you.pnlPct)}${meta ? ` (price ${price(meta.priceNow)})` : ""}` : NA],
    ["Holdings bought cheaper", you.cheaperShare !== null ? `${formatPct(you.cheaperShare, 0)} of the analysed supply` : NA],
    ["Holding", you.holdingTokens !== null ? `${formatAmount(you.holdingTokens)} ${symbolText(meta).replace("$", "")}` : NA],
  ];
  return (
    <div className="lab-table-wrap">
      <table className="lab-table lab-kv">
        <caption className="sr-only">Your wallet against this token</caption>
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

export function YouTab({
  you,
  walls,
  smart,
  meta,
  wallet,
  onWalletSubmit,
}: {
  you: WalletCheck | null;
  walls: WallsFinding | null;
  smart: SmartFinding | null;
  meta: ScanMeta | null;
  wallet: WalletUi;
  onWalletSubmit?: (address: string) => void;
}) {
  const [again, setAgain] = useState(false);
  const checked = you && !again ? you : null;
  const flag = youTabFlag(checked);
  const chart = youChart(checked, walls, smart, meta);
  const answer = youAnswer(checked, meta);
  return (
    <div className="lab-sheet">
      <TabHead tag="05 · You" flag={flag} question={YOU_QUESTION} status={checked?.status} />
      {chart ? (
        <FitSvg height={chart.checked ? 172 : 132} label={chart.checked ? `Your entry ${price(chart.you)} against smart money's ${price(chart.sm)} and today's ${price(chart.now)} on the holders' entry prices` : "Holders' entry prices, waiting for your wallet"}>
          {(w, h) => <Distribution chart={chart} w={w} h={h} youTone={flag.tone} />}
        </FitSvg>
      ) : (
        <Placeholder text="Holders' entry prices appear here with the scan" />
      )}
      <Answer a={answer} />
      {checked ? (
        <>
          <p className="lab-actions">
            {meta ? <Address address={checked.address} href={nansenProfilerUrl(meta.chain, checked.address)} long /> : null}
            <button type="button" className="lab-link" onClick={() => setAgain(true)}>
              Check another wallet
            </button>
          </p>
          <Disclosure what="your numbers">
            <YourNumbers you={checked} meta={meta} />
            <Note>{noDash(noteFor(5, checked))}</Note>
          </Disclosure>
        </>
      ) : (
        <WalletForm
          ui={wallet}
          className="lab-wallet"
          onSubmit={(a) => {
            setAgain(false);
            onWalletSubmit?.(a);
          }}
        />
      )}
    </div>
  );
}
