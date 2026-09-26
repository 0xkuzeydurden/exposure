"use client";

// The typed radiology report on the clipboard. Findings 1–5 are phrased in plain English from the
// finding data, typed character by character (key sounds, a bell per line), then the impression
// (the diagnosis sentence), the confidence line and the red stamp.
import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Stamp, type StampState } from "@/components/exposure/Stamp";
import { useTypewriter } from "@/hooks/useTypewriter";
import { sound } from "@/lib/exposure/sound";
import {
  IMPRESSION_SPEED_MS,
  isCancelled,
  LINE_END_AFTER_BELL_MS,
  LINE_END_CARET_MS,
  sleep,
  TypingCancelled,
  typeText,
  waitFor,
} from "@/lib/exposure/typewriter";
import {
  chainLabel,
  confidenceLine,
  examLabel,
  FINDING_TITLES,
  findingAt,
  lineFor,
  patientName,
  reportDate,
  scanNoLabel,
  type FindingNo,
} from "@/lib/xray/copy";
import type { Diagnosis, ReportProps, ScanMeta, WalletCheck } from "@/lib/xray/types";

export type { FindingNo };

/* ------------------------------------------------------------------------------------------ */
/* Shared display helpers (also used by the lab results, the intake and the waiting room).     */
/* ------------------------------------------------------------------------------------------ */

const CHAIN_NAMES: Record<string, string> = {
  arbitrum: "Arbitrum",
  arc: "Arc",
  avalanche: "Avalanche",
  base: "Base",
  bnb: "BNB",
  ethereum: "Ethereum",
  linea: "Linea",
  mantle: "Mantle",
  monad: "Monad",
  optimism: "Optimism",
  plasma: "Plasma",
  polygon: "Polygon",
  robinhood: "Robinhood",
  sei: "Sei",
  solana: "Solana",
  sonic: "Sonic",
  sui: "Sui",
};

/** "Base", "Ethereum", "BNB" (title case, for cards and lists; the report uses copy.chainLabel). */
export function chainName(chain: string): string {
  return CHAIN_NAMES[chain] ?? (chain ? chain[0].toUpperCase() + chain.slice(1) : "n/a");
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** "$KAIRO", or "n/a" before the patient is known. */
export function symbolLabel(meta: Pick<ScanMeta, "symbol" | "name"> | null | undefined): string {
  return meta ? patientName(meta) : "n/a";
}

/** "0412", or "n/a" before the patient is known. */
export function scanNoText(meta: Pick<ScanMeta, "scanNo"> | null | undefined): string {
  return meta ? scanNoLabel(meta.scanNo) : "n/a";
}

/** "26 SEP 2026 14:02" (UTC, as on the film plate), or "n/a". */
export function scanDateText(meta: Pick<ScanMeta, "scannedAt"> | null | undefined): string {
  return meta?.scannedAt ? reportDate(meta.scannedAt) : "n/a";
}

/* ------------------------------------------------------------------------------------------ */
/* Report lines (phrasing lives in lib/xray/copy, shared with the film's marker tags)          */
/* ------------------------------------------------------------------------------------------ */

/** One report line split for typing (the phrasing itself comes from lib/xray/copy). */
interface TypedReportLine {
  n: FindingNo;
  /** "1. " */
  num: string;
  /** "REAL BUYERS: " */
  key: string;
  text: string;
}

/** Placeholder of the inline wallet input under finding 5. */
export const WALLET_PLACEHOLDER = "Paste your wallet to compare with smart money";

type ReportScan = ReportProps["scan"];

function typedLine(n: FindingNo, scan: ReportScan, you: WalletCheck | null): TypedReportLine {
  return { n, num: `${n}. `, key: `${FINDING_TITLES[n]}: `, text: lineFor(n, findingAt(n, scan?.findings, you)) };
}

function typedLines(scan: ReportScan, you: WalletCheck | null): TypedReportLine[] {
  return ([1, 2, 3, 4, 5] as const).map((n) => typedLine(n, scan, you));
}

function fullText(l: TypedReportLine): string {
  return l.num + l.key + l.text;
}

const FOOTNOTE_NO: Record<Diagnosis["footnotes"][number], FindingNo> = { buyers: 1, flow: 2, walls: 3, smart: 4 };
const SUPERSCRIPT: Record<FindingNo, string> = { 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵" };

/* ------------------------------------------------------------------------------------------ */
/* Wallet form (finding 5 and the lab's "05 You" tab)                                          */
/* ------------------------------------------------------------------------------------------ */

export interface WalletUi {
  /** The check can run (live scans on, real token). */
  enabled: boolean;
  pending: boolean;
  error: string | null;
  /** Why the check is off (shown instead of the form). */
  disabledReason?: string | null;
}

export function WalletForm({
  onSubmit,
  ui,
  className,
  autoFocus,
}: {
  onSubmit?: (address: string) => void;
  ui: WalletUi;
  className?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const id = useId();
  if (!ui.enabled) {
    return <div className={`wallet-note${className ? ` ${className}` : ""}`}>{ui.disabledReason ?? "Wallet checks are off here."}</div>;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v && !ui.pending) onSubmit?.(v);
  };
  return (
    <div className={className}>
      <form className="wallet-form" onSubmit={submit} autoComplete="off">
        <label className="sr-only" htmlFor={id}>
          Your wallet address
        </label>
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={WALLET_PLACEHOLDER}
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={ui.pending}
        />
        <button type="submit" disabled={ui.pending || !value.trim()}>
          {ui.pending ? "Checking…" : "Compare"}
        </button>
      </form>
      {ui.pending ? <div className="wallet-note">Reading your entry from the Nansen profiler (1–3 credits)…</div> : null}
      {ui.error ? (
        <div className="wallet-error" role="alert">
          {ui.error}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The report                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface ReportExtras {
  /** Faint line under FINDINGS while the scan is still running (e.g. the live stage message). */
  status?: string | null;
  wallet?: WalletUi;
  /** Exam field; default "7-DAY RADIOGRAPH". */
  exam?: string;
  synthetic?: boolean;
  /** "Lab results" in the report header: opens the drawer on its Summary tab. */
  onOpenLab?: () => void;
}

export type ReportComponentProps = ReportProps & ReportExtras;

interface TypedLine {
  line: TypedReportLine;
  shown: number;
}

const DEFAULT_WALLET: WalletUi = { enabled: false, pending: false, error: null, disabledReason: null };

function LineText({ line, shown, caret }: { line: TypedReportLine; shown: number; caret: boolean }) {
  const a = line.num.length;
  const b = a + line.key.length;
  const num = line.num.slice(0, Math.min(shown, a));
  const key = shown > a ? line.key.slice(0, Math.min(shown - a, line.key.length)) : "";
  const text = shown > b ? line.text.slice(0, shown - b) : "";
  return (
    <>
      <span className="num">{num}</span>
      <span className="key">{key}</span>
      {text}
      {caret ? <span className="caret" aria-hidden="true" /> : null}
    </>
  );
}

function ReportImpl(props: ReportComponentProps) {
  const { scan, you, mode, onFindingClick, onFindingHover, onWalletSubmit, className, status, exam, synthetic, onOpenLab } = props;
  const wallet = props.wallet ?? DEFAULT_WALLET;
  const meta = scan?.meta ?? null;
  const diagnosis = scan?.diagnosis ?? null;

  // Typing-mode state (instant mode renders straight from props).
  const [typed, setTyped] = useState<TypedLine[]>([]);
  const [caret, setCaret] = useState<FindingNo | "impression" | null>(null);
  const [impression, setImpression] = useState<{ text: string; shown: number } | null>(null);
  const [confShown, setConfShown] = useState(false);
  const [stamp, setStamp] = useState<StampState>("hidden");
  /** Line 5 finished its first typing (a wallet checked later retypes it). */
  const [line5Ready, setLine5Ready] = useState(false);

  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  /** The `you` value line 5 was typed with. */
  const typedYou = useRef<WalletCheck | null>(null);
  const main = useTypewriter();
  const retype = useTypewriter();

  // Main typing pass: findings 1–5, impression, confidence, stamp.
  useEffect(() => {
    if (mode !== "typing") return;
    const signal = main.begin();
    const alive = () => {
      if (signal.aborted) throw new TypingCancelled();
    };
    const setShown = (idx: number, shown: number) =>
      setTyped((prev) => {
        if (!prev[idx] || prev[idx].shown === shown) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], shown };
        return next;
      });

    void (async () => {
      try {
        await waitFor(() => Boolean(latest.current.scan?.findings), signal);
        alive();
        for (let n = 1 as FindingNo; n <= 5; n = (n + 1) as FindingNo) {
          const p = latest.current;
          const line = typedLine(n, p.scan, p.you);
          if (n === 5) typedYou.current = p.you;
          p.onFindingStart?.(n);
          // Let the film's marker pulse land before the carriage moves (mockup: 220ms).
          await sleep(220, signal);
          const idx = n - 1;
          setTyped((prev) => [...prev.slice(0, idx), { line, shown: 0 }]);
          setCaret(n);
          await typeText(fullText(line), {
            signal,
            onProgress: (shown) => setShown(idx, shown),
            onKey: sound.key,
          });
          await sleep(LINE_END_CARET_MS, signal);
          setCaret(null);
          sound.ding();
          if (n === 5) setLine5Ready(true);
          await sleep(LINE_END_AFTER_BELL_MS, signal);
        }
        await sleep(250, signal);
        await waitFor(() => Boolean(latest.current.scan?.diagnosis), signal);
        alive();
        const sentence = latest.current.scan?.diagnosis?.sentence ?? "";
        setImpression({ text: sentence, shown: 0 });
        setCaret("impression");
        await typeText(sentence, {
          speed: IMPRESSION_SPEED_MS,
          signal,
          onProgress: (shown) => setImpression({ text: sentence, shown }),
          onKey: sound.key,
        });
        setCaret(null);
        sound.ding();
        await sleep(200, signal);
        setConfShown(true);
        sound.stamp();
        setStamp("stamping");
        await sleep(260, signal);
        setStamp("shown");
        latest.current.onDone?.();
      } catch (err) {
        if (!isCancelled(err)) throw err;
      }
    })();
    return () => main.cancel();
  }, [mode, main]);

  // A wallet checked after line 5 was typed: retype line 5 (with sound).
  useEffect(() => {
    if (mode !== "typing" || !line5Ready || typedYou.current === you) return;
    typedYou.current = you;
    const signal = retype.begin();
    const line = typedLine(5, latest.current.scan, you);
    const text = fullText(line);
    void (async () => {
      try {
        setTyped((prev) => {
          const next = prev.slice();
          next[4] = { line, shown: 0 };
          return next;
        });
        setCaret(5);
        await typeText(text, {
          signal,
          onProgress: (shown) =>
            setTyped((prev) => {
              const next = prev.slice();
              if (next[4]) next[4] = { ...next[4], shown };
              return next;
            }),
          onKey: sound.key,
        });
        await sleep(LINE_END_CARET_MS, signal);
        setCaret((c) => (c === 5 ? null : c));
        sound.ding();
      } catch (err) {
        if (!isCancelled(err)) throw err;
      }
    })();
    return () => retype.cancel();
  }, [you, mode, retype, line5Ready]);

  const instant = mode === "instant";
  const lines: TypedLine[] = instant
    ? scan?.findings
      ? typedLines(scan, you).map((line) => ({ line, shown: fullText(line).length }))
      : []
    : typed;
  const impressionView = instant
    ? diagnosis
      ? { text: diagnosis.sentence, shown: diagnosis.sentence.length }
      : null
    : impression;
  const impressionDone = impressionView !== null && impressionView.shown >= impressionView.text.length;
  const showConf = instant ? diagnosis !== null : confShown;
  const stampState: StampState = instant ? (diagnosis ? "shown" : "hidden") : stamp;
  const line5 = lines[4];
  const line5Done = line5 ? line5.shown >= fullText(line5.line).length : false;
  const showStatus = Boolean(status) && lines.length === 0;

  return (
    <article className={`sheet${className ? ` ${className}` : ""}`} aria-label="Radiology report">
      {onOpenLab ? (
        <button type="button" className="sheet-lab" onClick={onOpenLab} disabled={!meta} aria-label="Open the lab results: summary and key numbers">
          Lab results ›
        </button>
      ) : null}
      <h2>EXPOSURE RADIOLOGY</h2>
      <div className="sub">ON-CHAIN IMAGING DEPARTMENT · DATA: NANSEN API</div>
      {synthetic ? <div className="sub synthetic-tag">SYNTHETIC PREVIEW · ILLUSTRATIVE DATA · NOT A REAL TOKEN</div> : null}
      <div className="form">
        <div>
          <small>Patient</small>
          <span>{symbolLabel(meta)}</span>
        </div>
        <div>
          <small>Chain</small>
          <span>{meta ? chainLabel(meta.chain) : "n/a"}</span>
        </div>
        <div>
          <small>Exam</small>
          <span>{exam ?? examLabel("deep")}</span>
        </div>
        <div>
          <small>Scan no.</small>
          <span>{scanNoText(meta)}</span>
        </div>
        <div>
          <small>Date</small>
          <span>{scanDateText(meta)}</span>
        </div>
        <div>
          <small>Calls to Nansen</small>
          <span>{scan?.totals ? scan.totals.calls.toLocaleString("en-US") : "n/a"}</span>
        </div>
      </div>

      <div className="sect">FINDINGS</div>
      <div className="typed findings">
        {showStatus ? (
          <div className="status-line" role="status">
            {status}
            <span className="caret" aria-hidden="true" />
          </div>
        ) : null}
        {lines.map(({ line, shown }, i) => {
          const done = shown >= fullText(line).length;
          const n = line.n;
          const button = (
            <button
              key={`b${n}`}
              type="button"
              className="finding"
              aria-label={done ? fullText(line) : undefined}
              onMouseEnter={() => onFindingHover?.(n)}
              onMouseLeave={() => onFindingHover?.(null)}
              onFocus={() => onFindingHover?.(n)}
              onBlur={() => onFindingHover?.(null)}
              onClick={() => onFindingClick?.(n)}
            >
              <LineText line={line} shown={shown} caret={caret === n} />
            </button>
          );
          if (i < 4) return button;
          return (
            <div key="l5" className="finding-5">
              {button}
              {you === null && (instant || line5Done) ? (
                <WalletForm className="wallet-inline" onSubmit={onWalletSubmit} ui={wallet} />
              ) : null}
              {you !== null && wallet.error ? (
                <div className="wallet-error" role="alert">
                  {wallet.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sect">IMPRESSION</div>
      <div className="typed impression">
        {impressionView ? impressionView.text.slice(0, impressionView.shown) : null}
        {caret === "impression" ? <span className="caret" aria-hidden="true" /> : null}
        {impressionDone && diagnosis?.footnotes?.length ? (
          <span className="footnotes">
            {diagnosis.footnotes.map((k) => {
              const n = FOOTNOTE_NO[k];
              return (
                <sup key={k}>
                  <button
                    type="button"
                    className="fn"
                    aria-label={`See finding ${n}`}
                    onMouseEnter={() => onFindingHover?.(n)}
                    onMouseLeave={() => onFindingHover?.(null)}
                    onFocus={() => onFindingHover?.(n)}
                    onBlur={() => onFindingHover?.(null)}
                    onClick={() => onFindingClick?.(n)}
                  >
                    {SUPERSCRIPT[n]}
                  </button>
                </sup>
              );
            })}
          </span>
        ) : null}
      </div>
      <div className="conf">{showConf && diagnosis ? confidenceLine(diagnosis) : ""}</div>
      <div className="sig">
        <span>
          Radiologist: EXPOSURE (automated)
          <br />
          Rules published in README
        </span>
      </div>
      <Stamp state={stampState} confidence={diagnosis?.confidence ?? null} label={synthetic ? "Synthetic" : "Reviewed"} />
    </article>
  );
}

/** The typed radiology report. Remount it (key) for every new exposure. */
export const Report = memo(ReportImpl);
