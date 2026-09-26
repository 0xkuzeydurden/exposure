"use client";

// Evidence: a waffle with one square per Nansen API call, coloured by endpoint group (faded = served
// from the cache, hollow = failed), the call count, credits and duration. Every call sits behind
// "Show every call".
import { formatMs } from "@/lib/format";
import { callTotals, callWaffle, evidenceAnswer, evidenceFlag, noDash, type Waffle } from "@/lib/xray/lab";
import type { CallRecord, Diagnosis, FindingKey, Scan, ScanMeta, Tier } from "@/lib/xray/types";
import { Answer, Disclosure, FitSvg, Legend, nansenTokenUrl, Note, num, Placeholder, TabHead } from "./ui";

const FINDING_LABEL: Record<FindingKey, string> = {
  context: "Context",
  buyers: "01 Buyers",
  flow: "02 Flow",
  walls: "03 Walls",
  smart: "04 Smart money",
  you: "05 You",
};

/** Square pitch so the waffle stays within ~12 rows. */
function pitchFor(n: number, w: number): number {
  let p = 14;
  while (p > 5 && Math.ceil(n / Math.max(1, Math.floor((w + 2) / p))) * p > 12 * 14) p -= 1;
  return p;
}

function WaffleSvg({ waffle, w }: { waffle: Waffle; w: number }) {
  const n = waffle.cells.length;
  const p = pitchFor(n, w);
  const cols = Math.max(1, Math.floor((w + 2) / p));
  const size = p * 0.87;
  return (
    <>
      {waffle.cells.map((c, k) => {
        const x = (k % cols) * p;
        const y = Math.floor(k / cols) * p;
        const call = c.call;
        const tip = `#${c.index + 1} ${call.endpoint} · ${call.status} · ${call.credits} ${call.credits === 1 ? "credit" : "credits"} · ${Math.round(call.ms)}ms${c.cached ? " · cache" : ""}`;
        return c.failed ? (
          <g key={c.index}>
            <title>{`${tip} · failed`}</title>
            <rect x={x + 0.75} y={y + 0.75} width={size - 1.5} height={size - 1.5} rx={1.5} fill="none" stroke={c.color} strokeWidth={1.5} />
            <path d={`M${x + 2} ${y + 2} L${x + size - 2} ${y + size - 2}`} stroke={c.color} strokeWidth={1.5} />
          </g>
        ) : (
          <rect key={c.index} x={x} y={y} width={size} height={size} rx={1.5} fill={c.color} opacity={c.cached ? 0.4 : 1}>
            <title>{tip}</title>
          </rect>
        );
      })}
    </>
  );
}

function wafflesHeight(n: number, w: number): number {
  const p = pitchFor(n, w);
  const cols = Math.max(1, Math.floor((w + 2) / p));
  return Math.max(p, Math.ceil(n / cols) * p);
}

function EndpointTable({ calls }: { calls: CallRecord[] }) {
  const map = new Map<string, { endpoint: string; n: number; credits: number; ms: number; cached: number; findings: Set<FindingKey> }>();
  for (const c of calls) {
    let e = map.get(c.endpoint);
    if (!e) {
      e = { endpoint: c.endpoint, n: 0, credits: 0, ms: 0, cached: 0, findings: new Set() };
      map.set(c.endpoint, e);
    }
    e.n++;
    e.credits += Number.isFinite(c.credits) ? c.credits : 0;
    e.ms += Number.isFinite(c.ms) ? c.ms : 0;
    if (c.cached) e.cached++;
    e.findings.add(c.finding);
  }
  const rows = [...map.values()].sort((a, b) => b.credits - a.credits || b.n - a.n);
  return (
    <>
      <h4 className="lab-subhead">Calls by endpoint · most credits first</h4>
      <div className="lab-table-wrap">
        <table className="lab-table">
          <caption className="sr-only">Nansen API calls grouped by endpoint</caption>
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col" className="r">
                Credits
              </th>
              <th scope="col" className="r">
                Calls
              </th>
              <th scope="col" className="r">
                Avg ms
              </th>
              <th scope="col">Findings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.endpoint}>
                <td className="mono">{e.endpoint}</td>
                <td className="r">{num(e.credits)}</td>
                <td className="r">
                  {num(e.n)}
                  {e.cached ? <span className="lab-muted"> ({e.cached} cached)</span> : null}
                </td>
                <td className="r">{num(e.ms / e.n)}</td>
                <td className="lab-muted">{[...e.findings].map((k) => FINDING_LABEL[k] ?? k).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CallLog({ calls, t }: { calls: CallRecord[]; t: Scan["totals"] }) {
  return (
    <>
      <h4 className="lab-subhead">Every call · in the order they finished</h4>
      <div className="lab-table-wrap">
        <table className="lab-table lab-calls">
          <caption className="sr-only">Every Nansen API call this scan made</caption>
          <thead>
            <tr>
              <th scope="col" className="r">
                #
              </th>
              <th scope="col">Endpoint</th>
              <th scope="col">Finding</th>
              <th scope="col" className="r">
                Status
              </th>
              <th scope="col" className="r">
                Credits
              </th>
              <th scope="col" className="r">
                ms
              </th>
              <th scope="col">Cached</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c, i) => (
              <tr key={`${i}-${c.endpoint}-${c.at}`}>
                <td className="r">{i + 1}</td>
                <td className="mono">{c.endpoint}</td>
                <td>{FINDING_LABEL[c.finding] ?? c.finding}</td>
                <td className={`r${c.status >= 400 ? " bad" : ""}`}>{c.status}</td>
                <td className="r">{c.credits}</td>
                <td className="r">{Math.round(c.ms)}</td>
                <td className={c.cached ? undefined : "lab-muted"}>{c.cached ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                Total · {num(t.calls)} calls
              </th>
              <td className="r">{num(t.credits)}</td>
              <td className="r">{noDash(formatMs(t.durationMs))}</td>
              <td>{t.cacheHits} hits</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

export function EvidenceTab({
  calls,
  totals,
  meta,
  diagnosis,
  replayed,
  tier,
}: {
  calls: CallRecord[];
  totals: Scan["totals"] | null;
  meta: ScanMeta | null;
  diagnosis: Diagnosis | null;
  replayed?: boolean;
  tier: Tier | null;
}) {
  const flag = evidenceFlag(calls);
  const waffle = callWaffle(calls);
  const t = callTotals(calls, totals);
  const answer = evidenceAnswer(calls, totals);
  return (
    <div className="lab-sheet">
      <TabHead tag="Evidence" flag={flag} question="What did we ask Nansen?" />
      {calls.length ? (
        <FitSvg height={(w) => wafflesHeight(calls.length, w)} label={`${calls.length} Nansen API calls, one square each, coloured by endpoint`}>
          {(w) => <WaffleSvg waffle={waffle} w={w} />}
        </FitSvg>
      ) : (
        <Placeholder text="The calls appear here as the scan makes them" height={80} />
      )}
      <Answer a={answer} />
      <Legend
        items={[
          ...waffle.groups.map((g) => ({ key: g.key, label: `${g.label} · ${num(g.count)}`, swatch: g.color })),
          ...(waffle.cached ? [{ key: "cached", label: `faded: from the cache · ${num(waffle.cached)}`, swatch: "rgba(28,29,34,.3)" }] : []),
          ...(waffle.failed ? [{ key: "failed", label: `hollow: failed · ${num(waffle.failed)}`, swatch: "#c0322a", hollow: true }] : []),
        ]}
      />
      <p className="lab-method">
        {tier ? `${tier === "deep" ? "Deep" : "Quick"} scan · ` : ""}
        {num(t.networkCalls)} network calls · {num(t.cacheHits)} cache hits
        {diagnosis ? ` · diagnosis rule ${diagnosis.rule} (${diagnosis.code})` : ""}
        {meta ? (
          <>
            {" · "}
            <a href={nansenTokenUrl(meta.chain, meta.tokenAddress)} target="_blank" rel="noopener noreferrer">
              Open in Nansen ↗
            </a>
          </>
        ) : null}
      </p>
      {replayed ? <Note>This is a recorded scan, replayed for 0 new credits. The calls are the ones the recording made.</Note> : null}
      {calls.length ? (
        <Disclosure what="every call">
          <EndpointTable calls={calls} />
          <CallLog calls={calls} t={t} />
        </Disclosure>
      ) : null}
    </div>
  );
}
