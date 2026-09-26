"use client";

// 01 Buyers: a funnel (the analysed wallets -> the funding sources behind them, the biggest source's
// wallets highlighted) and a treemap of the sources sized by buy volume. The biggest single source is
// red only when it crosses the CONCENTRATED line (amber at the ORGANIC limit, a neutral dark tile below
// it: then it is just the largest of many). The buyer table sits behind "Show wallets".
import type { ReactNode } from "react";
import { FINDING_QUESTIONS, funderName, noteFor } from "@/lib/xray/copy";
import { isAvailable } from "@/lib/xray/diagnosis";
import {
  biggestSource,
  buyersAnswer,
  buyersChart,
  demandFlag,
  noDash,
  type BuyersChart,
  type FlagTone,
  type TileKind,
  type TreeLeaf,
  type TreeTile,
} from "@/lib/xray/lab";
import { formatPct, formatUsdCompact } from "@/lib/format";
import type { BuyerRow, BuyersFinding, ScanMeta, SourceCluster } from "@/lib/xray/types";
import { squarify, textWidth, type Rect } from "./geometry";
import { Address, Answer, C, Disclosure, FitSvg, Legend, Note, nansenProfilerUrl, Placeholder, profilerLink, shortAddr, TabHead, useSvgId } from "./ui";

const pct = (x: number) => formatPct(x, 0);

/** The biggest single source's colour: a warning only at the thresholds (see BuyersChart.bigTone). */
const BIG_FILL: Record<FlagTone, string> = { red: C.red, amber: C.amber, green: C.ink2, grey: C.ink2 };

/** "0x5eed…9f3c" or a short Solana address; anything else is an entity name. */
function isAddressLabel(label: string): boolean {
  return /^0x[0-9a-f]+(…[0-9a-f]+)?$/i.test(label) || (label.includes("…") && !/\s/.test(label));
}

/* ------------------------------------------------------------------------------ funnel */

function Funnel({ chart, w, h, tone }: { chart: BuyersChart; w: number; h: number; tone: string }) {
  const top = 6;
  const areaH = h - 30;
  const my = top + areaH / 2;
  const labelY = h - 7;
  const leftW = w * (chart.traced ? 0.34 : 0.46);
  const n = Math.max(0, Math.min(chart.wallets, chart.traced ? 120 : 160));
  const scale = chart.wallets > 0 ? n / chart.wallets : 0;
  const hot = Math.round(chart.hot * scale);
  const hollow = Math.round(chart.hollow * scale);
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * leftW) / areaH)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const pitch = Math.min(14, leftW / cols, areaH / rows);
  const r = pitch * 0.34;
  const gridW = cols * pitch;
  const gy = top + (areaH - rows * pitch) / 2;
  const hotCol = chart.traced ? BIG_FILL[chart.bigTone] : tone;

  const ax0 = gridW + 14;
  const ax1 = ax0 + Math.max(46, w * 0.11);
  const rx = ax1 + 16;

  const walletDots = Array.from({ length: n }, (_, i) => {
    const cx = pitch / 2 + (i % cols) * pitch;
    const cy = gy + pitch / 2 + Math.floor(i / cols) * pitch;
    if (i < hot) return <circle key={i} cx={cx} cy={cy} r={r} fill={hotCol} />;
    if (i >= n - hollow) return <circle key={i} cx={cx} cy={cy} r={r - 0.5} fill="none" stroke={C.ink3} strokeWidth={1} />;
    return <circle key={i} cx={cx} cy={cy} r={r} fill={C.ink3} />;
  });

  let right: ReactNode;
  if (chart.traced) {
    const big = chart.sources[0]?.kind === "biggest" ? chart.sources[0] : null;
    const others = chart.sources.slice(big ? 1 : 0);
    const rBig = big ? Math.max(12, Math.min(10 + Math.sqrt(big.wallets) * 2.6, areaH / 2 - 2, 30)) : 0;
    const gx = rx + (big ? rBig * 2 + 12 : 0);
    const gw = Math.max(20, w - gx - 2);
    const m = others.length;
    let p = 15;
    // At least two rows once there are a dozen sources, like a pile rather than a queue.
    let cols2 = Math.max(1, Math.min(Math.floor(gw / p), m > 12 ? Math.max(8, Math.ceil(m / 2)) : m));
    if (Math.ceil(m / cols2) * p > areaH) {
      p = Math.max(5, Math.sqrt((gw * areaH) / Math.max(1, m)));
      cols2 = Math.max(1, Math.floor(gw / p));
    }
    const rows2 = Math.ceil(m / cols2);
    const oy = my - (rows2 * p) / 2;
    const k = p / 14;
    right = (
      <g>
        {big ? (
          <g>
            <title>{`${big.label}: funded ${big.wallets} of the buyers`}</title>
            <circle cx={rx + rBig} cy={my} r={rBig} fill={hotCol} />
            <text x={rx + rBig} y={my + Math.min(17, rBig * 0.85) * 0.36} fontSize={Math.min(17, rBig * 0.85)} fontWeight={700} fill="#fff" textAnchor="middle">
              {big.wallets}
            </text>
          </g>
        ) : null}
        {others.map((d, i) => {
          const cx = gx + p / 2 + (i % cols2) * p;
          const cy = oy + p / 2 + Math.floor(i / cols2) * p;
          const rr = (d.kind === "exchange" ? 4 : Math.min(6.2, 3.2 + Math.sqrt(Math.max(0, d.wallets - 1)) * 1.1)) * k;
          return (
            <circle key={i} cx={cx} cy={cy} r={rr} fill={d.kind === "exchange" ? C.exchange : C.independent} stroke={d.kind === "exchange" ? "none" : C.ink3} strokeWidth={0.6}>
              <title>{d.kind === "exchange" ? `${d.label}: one buyer, one source` : `${d.label}: ${d.wallets} ${d.wallets === 1 ? "wallet" : "wallets"}`}</title>
            </circle>
          );
        })}
        <text x={rx + (w - rx) / 2} y={labelY} fontSize={11} fontWeight={600} fill={C.ink2} textAnchor="middle" letterSpacing={1.5}>
          {chart.sourcesLabel}
        </text>
      </g>
    );
  } else {
    const rr = Math.min(areaH / 2, 44);
    const share = chart.topShare ?? 0;
    right = (
      <g>
        <circle cx={rx + rr} cy={my} r={rr} fill={tone} />
        <text x={rx + rr} y={my + 7} fontSize={Math.min(22, rr * 0.55)} fontWeight={700} fill="#fff" textAnchor="middle">
          {pct(share)}
        </text>
        <text x={rx + rr * 2 + 12} y={my + 4} fontSize={12} fill={C.ink2}>
          of all buying
        </text>
        <text x={rx + rr} y={labelY} fontSize={11} fontWeight={600} fill={C.ink2} textAnchor="middle" letterSpacing={1.5}>
          {`TOP ${chart.hot}`}
        </text>
      </g>
    );
  }

  return (
    <>
      {walletDots}
      <text x={gridW / 2} y={labelY} fontSize={11} fontWeight={600} fill={C.ink2} textAnchor="middle" letterSpacing={1.5}>
        {chart.walletsLabel}
      </text>
      <path d={`M${ax0} ${my} L${ax1} ${my}`} stroke={C.ink} strokeWidth={2} fill="none" />
      <path d={`M${ax1 - 7} ${my - 7} L${ax1 + 1} ${my} L${ax1 - 7} ${my + 7}`} stroke={C.ink} strokeWidth={2} fill="none" />
      <text x={(ax0 + ax1) / 2} y={my - 10} fontSize={11} fill={C.ink2} textAnchor="middle">
        {chart.traced ? "traced to" : "the top did"}
      </text>
      {right}
    </>
  );
}

/* ------------------------------------------------------------------------------ treemap */

const TILE_FILL: Record<TileKind, string> = {
  biggest: C.red,
  exchange: C.exchange,
  independent: C.independent,
  untraced: C.paper2,
  buyer: C.exchange,
  rest: C.independent,
};

function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: Math.max(0, r.w - by * 2), h: Math.max(0, r.h - by * 2) };
}

function Overlay({ r, text }: { r: Rect; text: string }) {
  if (r.h < 40 || textWidth(text, 11.5) + 16 > r.w) return null;
  return (
    <g>
      <rect x={r.x} y={r.y + r.h - 27} width={r.w} height={27} fill="rgba(244,241,232,.9)" />
      <text x={r.x + 8} y={r.y + r.h - 9} fontSize={11.5} fontWeight={700} fill={C.ink2}>
        {text}
      </text>
    </g>
  );
}

function BiggestTile({ r, t, chain, fill }: { r: Rect; t: TreeTile; chain: string; fill: string }) {
  const size = Math.max(14, Math.min(36, r.w * 0.28, r.h * 0.26));
  const name = t.label === "Self-funded" ? "SELF-FUNDED" : isAddressLabel(t.label) ? "ONE WALLET" : t.label.toUpperCase();
  const full = r.h >= size + 70 && r.w >= 118;
  const link = t.address && chain && r.h >= size + 36 && r.w >= 104;
  const addr = t.address ? shortAddr(t.address) : "";
  return (
    <g>
      <title>{`${t.label}: ${pct(t.share)} of the analysed buying, funded ${t.wallets} ${t.wallets === 1 ? "buyer" : "buyers"}`}</title>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} />
      {r.w >= 40 && r.h >= size + 8 ? (
        <text x={r.x + 12} y={r.y + 8 + size} fontSize={size} fontWeight={700} fill="#fff">
          {pct(t.share)}
        </text>
      ) : null}
      {full ? (
        <>
          <text x={r.x + 12} y={r.y + size + 30} fontSize={12} fontWeight={700} fill="#fff" letterSpacing={1.5}>
            {name}
          </text>
          <text x={r.x + 12} y={r.y + size + 48} fontSize={12} fill="#ffe4df">
            {`funded ${t.wallets} ${t.wallets === 1 ? "buyer" : "buyers"}`}
          </text>
        </>
      ) : null}
      {link ? (
        <a href={nansenProfilerUrl(chain, t.address!)} target="_blank" rel="noopener noreferrer" aria-label={`Open funder ${addr} in Nansen (new tab)`} className="lab-svglink">
          <text x={r.x + 12} y={r.y + r.h - 12} fontSize={12} fill="#ffe4df" fontFamily="var(--mono)">
            {`${addr}  ↗`}
          </text>
        </a>
      ) : null}
    </g>
  );
}

function PlainTile({ r, t, fill, ink, upper }: { r: Rect; t: TreeLeaf; fill: string; ink: string; upper: string }) {
  const big = Math.max(12, Math.min(20, r.h * 0.34, r.w * 0.3));
  return (
    <g>
      <title>{`${t.label}: ${pct(t.share)} of the buying, ${t.wallets} ${t.wallets === 1 ? "wallet" : "wallets"}`}</title>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} />
      {r.w >= 34 && r.h >= big + 8 ? (
        <text x={r.x + 8} y={r.y + 6 + big} fontSize={big} fontWeight={700} fill={ink}>
          {pct(t.share)}
        </text>
      ) : null}
      {r.h >= big + 26 && textWidth(upper, 11, true, 1.2) + 14 <= r.w ? (
        <text x={r.x + 8} y={r.y + big + 22} fontSize={11} fontWeight={700} fill={ink} letterSpacing={1.2}>
          {upper}
        </text>
      ) : null}
    </g>
  );
}

function Treemap({ chart, chain, w, h, hatch }: { chart: BuyersChart; chain: string; w: number; h: number; hatch: string }) {
  const cells = squarify(chart.tiles, { x: 0, y: 0, w, h });
  return (
    <>
      <defs>
        <pattern id={hatch} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={7} height={7} fill={C.paper2} />
          <line x1={0} y1={0} x2={0} y2={7} stroke={C.rope} strokeWidth={2.5} />
        </pattern>
      </defs>
      {cells.map((cell) => {
        const t = cell.item;
        const r = inset(cell, 1.5);
        if (r.w <= 0 || r.h <= 0) return null;
        switch (t.kind) {
          case "biggest":
            return <BiggestTile key={t.id} r={r} t={t} chain={chain} fill={BIG_FILL[chart.bigTone]} />;
          case "exchange":
          case "buyer":
            return <PlainTile key={t.id} r={r} t={t} fill={TILE_FILL[t.kind]} ink={C.ink} upper={t.kind === "buyer" ? t.label : t.label.toUpperCase()} />;
          case "untraced":
            return (
              <g key={t.id}>
                <title>{`Untraced: ${pct(t.share)} of the analysed buying, ${t.wallets} ${t.wallets === 1 ? "wallet" : "wallets"} without a known funder`}</title>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#${hatch})`} stroke={C.rope} strokeWidth={1} />
                {r.w >= 70 && r.h >= 30 ? (
                  <text x={r.x + 8} y={r.y + 19} fontSize={11} fontWeight={700} fill={C.ink2} letterSpacing={1.2} className="lab-halo">
                    {`UNTRACED · ${pct(t.share)}`}
                  </text>
                ) : null}
              </g>
            );
          default: {
            // Independent sources (or everyone else): pale tiles, one per source, with an overlay.
            const kids = t.children?.length ? squarify(t.children, r) : [{ ...r, item: t as TreeLeaf }];
            return (
              <g key={t.id}>
                {kids.map((k) => {
                  const kr = inset(k, 1);
                  return (
                    <rect key={k.item.id} x={kr.x} y={kr.y} width={Math.max(0, kr.w)} height={Math.max(0, kr.h)} fill={TILE_FILL[t.kind]}>
                      <title>{`${k.item.label}: ${pct(k.item.share)} of the buying, ${k.item.wallets} ${k.item.wallets === 1 ? "wallet" : "wallets"}`}</title>
                    </rect>
                  );
                })}
                <Overlay r={r} text={`${t.label} · ${pct(t.share)}`} />
              </g>
            );
          }
        }
      })}
    </>
  );
}

const LEGEND_SWATCH: Record<TileKind, string> = {
  biggest: C.red,
  exchange: C.exchange,
  independent: C.independent,
  untraced: C.rope,
  buyer: C.exchange,
  rest: C.independent,
};

/* ------------------------------------------------------------------------------ table */

function FunderCell({ m, chain, cluster }: { m: BuyerRow; chain: string; cluster: SourceCluster }) {
  if (cluster.kind === "untraced" || !m.funder) return <span className="lab-muted">Untraced</span>;
  if (cluster.kind === "self") return <span>Self-funded</span>;
  // A "name" that is only the funder's own address ("0xe9c4f6") is dropped: the short address follows anyway.
  return <Address address={m.funder} href={nansenProfilerUrl(chain, m.funder)} name={funderName(m.funderLabel)} />;
}

function BuyersTable({ b, chain }: { b: BuyersFinding; chain: string }) {
  const big = biggestSource(b);
  if (b.clusters.length) {
    const rows = b.clusters
      .flatMap((c) => c.members.map((m) => ({ m, c })))
      .sort((x, y) => y.m.boughtUsd - x.m.boughtUsd || (x.m.address < y.m.address ? -1 : 1));
    return (
      <div className="lab-table-wrap">
        <table className="lab-table">
          <caption className="sr-only">The analysed buyers, largest first, with the wallet that funded each</caption>
          <thead>
            <tr>
              <th scope="col" className="r">
                #
              </th>
              <th scope="col">Buyer</th>
              <th scope="col" className="r">
                Bought
              </th>
              <th scope="col">Funded by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, c }, i) => (
              <tr key={m.address} className={c === big && c.wallets > 1 ? "is-key" : undefined}>
                <td className="r lab-muted">{i + 1}</td>
                <td>
                  <Address address={m.address} href={profilerLink(m, chain)} />
                </td>
                <td className="r">{formatUsdCompact(m.boughtUsd)}</td>
                <td>
                  <FunderCell m={m} chain={chain} cluster={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const rows = b.largestBuyers ?? [];
  if (!rows.length) return <p className="lab-text">No buyer list for this scan.</p>;
  return (
    <div className="lab-table-wrap">
      <table className="lab-table">
        <caption className="sr-only">The week&apos;s largest buyers</caption>
        <thead>
          <tr>
            <th scope="col" className="r">
              #
            </th>
            <th scope="col">Buyer</th>
            <th scope="col" className="r">
              Bought
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={m.address}>
              <td className="r lab-muted">{i + 1}</td>
              <td>
                <Address address={m.address} href={profilerLink(m, chain)} />
              </td>
              <td className="r">{formatUsdCompact(m.boughtUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------------ the tab */

export function BuyersTab({ b, meta }: { b: BuyersFinding | null; meta: ScanMeta | null }) {
  const flag = demandFlag(b);
  const chart = buyersChart(b);
  const answer = buyersAnswer(b);
  const chain = meta?.chain ?? "";
  const hatch = useSvgId("hatch");
  const tone = flag.tone === "red" ? C.red : flag.tone === "green" ? C.green : C.amber;
  const funnelLabel = chart
    ? chart.traced
      ? `${chart.walletsLabel.toLowerCase()} traced to ${chart.sourcesLabel.toLowerCase()}${chart.hot > 1 ? `; ${chart.hot} of them funded by one wallet` : ""}`
      : `${chart.walletsLabel.toLowerCase()}; the top ${chart.hot} did ${chart.sourcesLabel.toLowerCase()}`
    : "";
  return (
    <div className="lab-sheet">
      <TabHead tag="01 · Buyers" flag={flag} question={FINDING_QUESTIONS[1]} status={b?.status} />
      {chart ? (
        <FitSvg height={128} label={funnelLabel}>
          {(w, h) => <Funnel chart={chart} w={w} h={h} tone={tone} />}
        </FitSvg>
      ) : (
        <Placeholder text={b ? "No buyer data for this scan" : "Tracing the buyers' funders"} />
      )}
      <Answer a={answer} />
      {chart && chart.tiles.length ? (
        <>
          <FitSvg height={(w) => (w >= 520 ? 212 : 248)} label={chart.traced ? "Funding sources sized by buy volume" : "The largest buyers sized by buy volume"}>
            {(w, h) => <Treemap chart={chart} chain={chain} w={w} h={h} hatch={hatch} />}
          </FitSvg>
          <Legend
            items={chart.legend.map((l) => ({
              key: l.kind,
              label: l.label,
              swatch: l.kind === "biggest" ? BIG_FILL[chart.bigTone] : LEGEND_SWATCH[l.kind],
              hatch: l.kind === "untraced",
            }))}
          />
        </>
      ) : null}
      {b && isAvailable(b) ? (
        <Disclosure what="wallets">
          <BuyersTable b={b} chain={chain} />
          <Note>
            {noDash(noteFor(1, b))} Exchanges, bridges and gas services count as independent sources. Buyer wallets come from
            Nansen&apos;s who-bought-sold, funders from Nansen&apos;s first-funder data. Wallet labels are never shown, and smart
            money only ever appears as an aggregate.
          </Note>
        </Disclosure>
      ) : null}
      {b && !isAvailable(b) && b.note ? <Note>{noDash(b.note)}</Note> : null}
    </div>
  );
}
