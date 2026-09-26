"use client";

// 03 Walls: a vertical price ladder (log price axis split at today's price so the part above it, where
// sellers wait, always gets room; today's price in blue), the analysed supply by entry price as
// horizontal bars (reddish above the price, green-grey below), the walls on top as thin red bars with
// labels that never sit on each other or on the price line, and a dashed POOL LIQUIDITY length so
// "2.3x POOL" reads at a glance. Every level sits behind "Show all price levels".
import { FINDING_QUESTIONS, allocationNote, noteFor, priceShort, priceTick } from "@/lib/xray/copy";
import { isHeavyWall, primaryWall } from "@/lib/xray/diagnosis";
import { formatAmount, formatMultiple, formatPct, formatPrice, formatSignedPct } from "@/lib/format";
import { ceilingFlag, ladderScale, nearestWall, noDash, NA, wallsAnswer, wallsChart, type WallsChart } from "@/lib/xray/lab";
import type { ScanMeta, WallsFinding } from "@/lib/xray/types";
import { textWidth } from "./geometry";
import { Answer, C, Disclosure, FitSvg, Legend, Note, num, Placeholder, TabHead } from "./ui";

function Ladder({ chart, w, h }: { chart: WallsChart; w: number; h: number }) {
  const top = 22;
  const bottom = h - 12;
  const py = ladderScale(chart, bottom, top);
  const AX = Math.min(92, Math.max(64, w * 0.12));
  const x0 = AX + 2;
  const labelRoom = 96;
  const avail = Math.max(60, w - x0 - labelRoom);
  const pool = chart.unit === "pool";
  // One pool's liquidity as a length: the longest bar (or 2.2 pools) fills the space.
  const unitLen = pool ? avail / Math.max(2.2, chart.maxSize * 1.08) : (avail * 0.92) / chart.maxSize;
  const len = (size: number) => Math.max(1, size * unitLen);
  const nowY = chart.now !== null ? py(chart.now) : null;
  const main = chart.walls.find((x) => x.main) ?? null;
  const nowText = chart.now !== null ? `NOW ${priceShort(chart.now)}` : "";
  const nowW = textWidth(nowText, 10.5, true) + 14;

  const bars = chart.bars.map((b) => {
    const y1 = py(b.hi);
    const y2 = py(b.lo);
    return { b, y1, y2, end: x0 + len(b.size) };
  });
  /** Right end of every bar crossing the band [ya, yb] (a label placed there must start after it). */
  const barsEnd = (ya: number, yb: number) => bars.reduce((m, r) => (r.y2 > ya && r.y1 < yb ? Math.max(m, r.end) : m), x0);

  // Wall labels: after the longest bar at their height, never on the NOW line, never on each other
  // (walls a few percent apart share a few pixels on any axis); a leader joins a moved label to its wall.
  const WALL_H = 9;
  type Lab = { key: string; y: number; ly: number; x: number; end: number; text: string; main: boolean; title: string };
  const labs: Lab[] = chart.walls
    .map((x) => {
      const y = py(x.price);
      const end = x0 + len(x.size);
      return {
        key: `${x.price}-${x.tokens}`,
        y,
        ly: y,
        x: end,
        end,
        text: x.main ? x.label : x.label.replace(" POOL", ""),
        main: x.main,
        title: `Wall at ${priceShort(x.price)} (${formatSignedPct(x.movePct)}): ${formatAmount(x.tokens)} tokens, ${x.label.toLowerCase()}`,
      };
    })
    .sort((a, b) => b.y - a.y);
  const GAP = 14;
  let floor = nowY !== null ? nowY - 11 : bottom;
  for (const l of labs) {
    l.ly = Math.min(l.y, floor);
    floor = l.ly - GAP;
  }
  // Pushed above the chart: slide the stack back down (still clear of the NOW line).
  const over = labs.length ? top - 2 - labs[labs.length - 1].ly : 0;
  if (over > 0) for (const l of labs) l.ly += over;
  for (const l of labs) l.x = Math.max(l.end, barsEnd(l.ly - 6, l.ly + 6)) + 7;

  const capAbove = nowY !== null ? Math.max(top + 4, nowY - 10) : 0;
  const capBelow = nowY !== null ? Math.min(bottom, nowY + 20) : 0;
  return (
    <>
      {/* supply by entry price */}
      {bars.map(({ b, y1, y2 }) => {
        const hh = Math.max(2, y2 - y1 - 1.5);
        const fill = b.zone === "below" ? C.greenSoft : C.redSoft;
        return (
          <rect key={`${b.lo}-${b.hi}`} x={x0} y={y1 + 0.75} width={len(b.size)} height={hh} fill={fill} opacity={b.zone === "band" ? 1 : 0.85}>
            <title>{`${formatPrice(b.lo)} to ${formatPrice(b.hi)}: ${formatAmount(b.tokens)} tokens, ${formatPct(b.supplyShare, 1)} of supply${b.ratio !== null ? `, ${formatMultiple(b.ratio)} the pool` : ""}`}</title>
          </rect>
        );
      })}
      {/* the walls: thin bars on top of the ladder, outlined in paper so they read as their own layer */}
      {labs.map((l) => (
        <g key={l.key}>
          <title>{l.title}</title>
          <rect x={x0} y={l.y - WALL_H / 2} width={Math.max(1, l.end - x0)} height={WALL_H} fill={l.main ? C.red : C.redMid} stroke={C.paper} strokeWidth={1} />
          {Math.abs(l.ly - l.y) > 2 || l.x - l.end > 10 ? (
            <path d={`M${l.end + 1} ${l.y} L${l.x - 3} ${l.ly}`} stroke={l.main ? C.red : C.ink3} strokeWidth={1} fill="none" />
          ) : null}
          <text
            x={l.x}
            y={l.ly + 4}
            fontSize={l.main ? 12 : 10.5}
            fontWeight={l.main ? 700 : 600}
            fill={l.main ? C.red : C.ink2}
            className="lab-halo"
          >
            {l.text}
          </text>
        </g>
      ))}
      {/* price axis */}
      <line x1={AX} x2={AX} y1={top - 12} y2={bottom + 2} stroke={C.ink} strokeWidth={1.5} />
      {chart.ticks.map((v) => (
        <g key={v}>
          <line x1={AX - 5} x2={AX} y1={py(v)} y2={py(v)} stroke={C.ink} />
          {/* A tick label the NOW badge would cover is left out (the badge carries the price). */}
          {nowY !== null && Math.abs(py(v) - nowY) < 16 ? null : (
            <text x={AX - 9} y={py(v) + 4} fontSize={11} fill={C.ink2} textAnchor="end">
              {priceTick(v)}
            </text>
          )}
        </g>
      ))}
      {/* one pool of liquidity */}
      {pool ? (
        <>
          <line x1={x0 + unitLen} x2={x0 + unitLen} y1={top - 12} y2={bottom + 2} stroke={C.ink} strokeWidth={1.2} strokeDasharray="4 3" />
          <text x={x0 + unitLen + 5} y={top - 3} fontSize={10} fontWeight={700} fill={C.ink2} letterSpacing={1} className="lab-halo">
            POOL LIQUIDITY
          </text>
        </>
      ) : null}
      {/* today's price */}
      {nowY !== null ? (
        <>
          <line x1={4} x2={w - 4} y1={nowY} y2={nowY} stroke={C.blue} strokeWidth={2} />
          <rect x={4} y={nowY - 10} width={nowW} height={20} fill={C.blue} />
          <text x={4 + nowW / 2} y={nowY + 4} fontSize={10.5} fontWeight={700} fill="#fff" textAnchor="middle">
            {nowText}
          </text>
          <text x={w - 4} y={capAbove} fontSize={11} fontWeight={700} fill={C.red} textAnchor="end" letterSpacing={1} className="lab-halo">
            SELLERS WAITING ↑
          </text>
          <text x={w - 4} y={capBelow} fontSize={11} fontWeight={700} fill={C.green} textAnchor="end" letterSpacing={1} className="lab-halo">
            HOLDERS IN PROFIT ↓
          </text>
        </>
      ) : null}
      {!main && !chart.walls.length && nowY !== null ? (
        <text x={x0 + 8} y={Math.max(top + 12, nowY - 28)} fontSize={11} fill={C.ink2} className="lab-halo">
          no wall above today&apos;s price
        </text>
      ) : null}
    </>
  );
}

function LevelsTables({ w, meta, chart }: { w: WallsFinding; meta: ScanMeta | null; chart: WallsChart }) {
  const supply = meta?.circulatingSupply ?? null;
  const main = primaryWall(w, supply);
  const near = nearestWall(w);
  const walls = [...w.walls].sort((a, b) => a.price - b.price);
  // Empty levels (no analysed holder entered there) are gaps on the chart, not rows of zeros.
  const levels = chart.bars.filter((b) => b.tokens > 0).sort((a, b) => b.lo - a.lo);
  return (
    <>
      <h4 className="lab-subhead">Walls: prices where holders get back to break-even</h4>
      {walls.length ? (
        <div className="lab-table-wrap">
          <table className="lab-table">
            <caption className="sr-only">Sell walls above today&apos;s price, nearest first</caption>
            <thead>
              <tr>
                <th scope="col">Price</th>
                <th scope="col" className="r">
                  Move
                </th>
                <th scope="col" className="r">
                  × pool
                </th>
                <th scope="col" className="r">
                  Tokens
                </th>
                <th scope="col" className="r">
                  Already trimming
                </th>
                <th scope="col" className="r">
                  Holders
                </th>
              </tr>
            </thead>
            <tbody>
              {walls.map((x) => {
                const tags = [x === main ? "Main wall" : null, x === near ? "Nearest" : null, isHeavyWall(x, w, supply) ? "Heavy" : null].filter(Boolean) as string[];
                return (
                  <tr key={`${x.price}-${x.tokens}`} className={x === main ? "is-key" : undefined}>
                    <td>
                      {priceShort(x.price)}
                      {tags.map((t) => (
                        <span key={t} className="lab-rowtag">
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="r">{formatSignedPct(x.movePct)}</td>
                    <td className="r">{x.wallToLiquidity !== null ? formatMultiple(x.wallToLiquidity) : NA}</td>
                    <td className="r">{formatAmount(x.tokens)}</td>
                    <td className="r">{formatPct(x.alreadyTrimming, 0)}</td>
                    <td className="r">{num(x.holders)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="lab-text">No sell wall above today&apos;s price.</p>
      )}
      <h4 className="lab-subhead">All price levels · highest first</h4>
      <div className="lab-table-wrap">
        <table className="lab-table">
          <caption className="sr-only">Analysed supply by entry price</caption>
          <thead>
            <tr>
              <th scope="col">Entry price</th>
              <th scope="col" className="r">
                Tokens
              </th>
              <th scope="col" className="r">
                % supply
              </th>
              <th scope="col" className="r">
                × pool
              </th>
              <th scope="col">Today</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((b) => (
              <tr key={`${b.lo}-${b.hi}`} className={b.zone === "band" ? "is-key" : undefined}>
                <td>
                  {formatPrice(b.lo)} to {formatPrice(b.hi)}
                </td>
                <td className="r">{formatAmount(b.tokens)}</td>
                <td className="r">{formatPct(b.supplyShare, 1)}</td>
                <td className="r">{b.ratio !== null ? formatMultiple(b.ratio) : NA}</td>
                <td className={b.zone === "below" ? "lab-muted" : undefined}>{b.zone === "below" ? "in profit" : b.zone === "band" ? "wall" : "underwater"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function WallsTab({ w, meta }: { w: WallsFinding | null; meta: ScanMeta | null }) {
  const flag = ceilingFlag(w);
  const chart = wallsChart(w, meta);
  const answer = wallsAnswer(w, meta);
  const main = chart?.walls.find((x) => x.main) ?? null;
  const allocation = w ? allocationNote(w) : "";
  return (
    <div className="lab-sheet">
      <TabHead tag="03 · Sell walls" flag={flag} question={FINDING_QUESTIONS[3]} status={w?.status} />
      <Answer a={answer} />
      {chart && (chart.bars.length || chart.walls.length) ? (
        <>
          <FitSvg
            height={(width) => (width >= 520 ? 300 : 320)}
            label={`Price ladder: supply by entry price with today's price${main ? `; the main wall is ${main.label.toLowerCase()} at ${priceShort(main.price)}` : ""}`}
          >
            {(width, h) => <Ladder chart={chart} w={width} h={h} />}
          </FitSvg>
          <Legend
            items={[
              { key: "above", label: "bought above today (underwater)", swatch: C.redSoft },
              { key: "wall", label: "sell wall", swatch: C.red },
              { key: "below", label: "bought below (in profit)", swatch: C.greenSoft },
              ...(chart.unit === "pool" ? [{ key: "pool", label: "one pool of liquidity", swatch: C.ink, hollow: true }] : []),
            ]}
          />
          <p className="lab-method">Method: {chart.method}</p>
        </>
      ) : (
        <Placeholder text={w ? "No holder entry prices for this scan" : "Reading holders' entry prices"} height={160} />
      )}
      {w && chart ? (
        <Disclosure what="all price levels">
          <LevelsTables w={w} meta={meta} chart={chart} />
          <Note>
            {noDash(noteFor(3, w))} {allocation ? `${noDash(allocation)} ` : ""}A wall is supply bought above today&apos;s price: those holders
            get their money back there, and many sell. &quot;Already trimming&quot; is the share of the wall held by wallets that already
            sold part of their peak balance.
          </Note>
        </Disclosure>
      ) : null}
    </div>
  );
}
