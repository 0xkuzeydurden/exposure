"use client";

// LAB RESULTS: a right-side drawer in hospital lab-report style. Every tab is one dominant chart, one
// big number, a coloured lab flag and one short line; tables and long text sit behind a collapsed
// "Show ... ▸". SUMMARY is a bedside monitor with five channels; 01 Buyers a funnel and a treemap;
// 02 Flow a tug of war and daily bars; 03 Walls a price ladder; 04 Smart money a gauge; 05 You an
// entry-price distribution; EVIDENCE a waffle of every Nansen call. Esc closes; focus is trapped while
// open and returns to the opener on close. The sub-components live in components/exposure/lab/.
//
// Addresses (README "Data rules"): buyer wallets and their funders are shown short, with copy and
// "Open in Nansen"; smart money only ever appears as an aggregate (tab 04), never per wallet.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type FindingNo, type WalletUi } from "@/components/exposure/Report";
import { BuyersTab } from "@/components/exposure/lab/Buyers";
import { EvidenceTab } from "@/components/exposure/lab/Evidence";
import { FlowTab } from "@/components/exposure/lab/Flow";
import { SmartTab } from "@/components/exposure/lab/Smart";
import { SummaryTab } from "@/components/exposure/lab/Summary";
import { YouTab } from "@/components/exposure/lab/You";
import { WallsTab } from "@/components/exposure/lab/Walls";
import { nansenProfilerUrl, nansenTokenUrl, num } from "@/components/exposure/lab/ui";
import type { ScanFindings } from "@/hooks/useScan";
import { chainLabel, reportDate, scanNoLabel } from "@/lib/xray/copy";
import { callTotals, monitorChannels, NA, noDash, symbolText, tabFlag } from "@/lib/xray/lab";
import type { CallRecord, Diagnosis, Scan, ScanMeta, Tier, WalletCheck } from "@/lib/xray/types";

export { nansenProfilerUrl, nansenTokenUrl };

export type LabTab = "summary" | FindingNo | "evidence";

export const LAB_TABS: { id: LabTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: 1, label: "01 Buyers" },
  { id: 2, label: "02 Flow" },
  { id: 3, label: "03 Walls" },
  { id: 4, label: "04 Smart money" },
  { id: 5, label: "05 You" },
  { id: "evidence", label: "Evidence" },
];

export interface LabResultsProps {
  open: boolean;
  tab: LabTab;
  onTab: (tab: LabTab) => void;
  onClose: () => void;
  meta: ScanMeta | null;
  tier: Tier | null;
  findings: ScanFindings;
  diagnosis: Diagnosis | null;
  calls: CallRecord[];
  totals: Scan["totals"] | null;
  you: WalletCheck | null;
  wallet: WalletUi;
  onWalletSubmit?: (address: string) => void;
  /**
   * Offered when live scans are on and this is not already a deep scan. Starting it takes a second,
   * confirming click that shows the cost and what is left of today's deep-scan budget.
   */
  deep?: { credits: number; left: number | null; onStart: () => void } | null;
  synthetic?: boolean;
  /** The data on screen is a recorded scan replayed for 0 new credits. */
  replayed?: boolean;
  /** Highlights the matching layer on the film while a finding tab is open. */
  onFocusFinding?: (n: FindingNo | null) => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function patientLine(meta: ScanMeta | null): string {
  if (!meta) return `${NA} · SCAN ${NA}`;
  return noDash(`${symbolText(meta)} · ${chainLabel(meta.chain)} · SCAN ${scanNoLabel(meta.scanNo)} · ${meta.scannedAt ? reportDate(meta.scannedAt) : NA}`);
}

export function LabResults(props: LabResultsProps) {
  const { open, tab, onTab, onClose, meta, tier, findings, diagnosis, calls, totals, you, wallet, onWalletSubmit, deep, synthetic, replayed, onFocusFinding } =
    props;
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const tabIdBase = useId();
  /** The deep-scan button was clicked once: show the cost and ask for a second click. */
  const [confirmDeep, setConfirmDeep] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // Esc, focus trap, scroll lock, focus return.
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.getClientRects().length > 0);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const inside = panelRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      returnTo?.focus?.();
    };
  }, [open]);

  // The open finding tab highlights its layer on the film.
  useEffect(() => {
    if (!onFocusFinding) return;
    onFocusFinding(open && typeof tab === "number" ? tab : null);
  }, [open, tab, onFocusFinding]);

  // A new tab starts at its top.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  if (!open || typeof document === "undefined") return null;

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = LAB_TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % LAB_TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + LAB_TABS.length) % LAB_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = LAB_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onTab(LAB_TABS[next].id);
    requestAnimationFrame(() => document.getElementById(`${tabIdBase}-tab-${String(LAB_TABS[next].id)}`)?.focus());
  };

  let body: ReactNode;
  switch (tab) {
    case "summary": {
      const t = callTotals(calls, totals);
      body = (
        <SummaryTab
          channels={monitorChannels(findings, meta, you)}
          diagnosis={diagnosis}
          evidence={calls.length ? `${num(t.calls)} Nansen API calls · ${num(t.credits)} credits` : null}
          onOpen={onTab}
        />
      );
      break;
    }
    case 1:
      body = <BuyersTab b={findings.buyers} meta={meta} />;
      break;
    case 2:
      body = <FlowTab f={findings.flow} meta={meta} />;
      break;
    case 3:
      body = <WallsTab w={findings.walls} meta={meta} />;
      break;
    case 4:
      body = <SmartTab s={findings.smart} meta={meta} />;
      break;
    case 5:
      body = <YouTab you={you} walls={findings.walls} smart={findings.smart} meta={meta} wallet={wallet} onWalletSubmit={onWalletSubmit} />;
      break;
    default:
      body = <EvidenceTab calls={calls} totals={totals} meta={meta} diagnosis={diagnosis} replayed={replayed} tier={tier} />;
  }

  return createPortal(
    <div className="lab-root">
      <div className="lab-backdrop" onMouseDown={() => closeRef.current()} aria-hidden="true" />
      <div className="lab" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="lab-head">
          <div>
            <h2 id={titleId}>LAB RESULTS</h2>
            <div className="lab-patient">{patientLine(meta)}</div>
            {synthetic ? <div className="lab-synthetic">SYNTHETIC PREVIEW · ILLUSTRATIVE DATA · FAKE 0x5eed… WALLETS</div> : null}
          </div>
          <button type="button" className="lab-close" onClick={() => closeRef.current()} aria-label="Close lab results (Esc)">
            Close ✕
          </button>
        </header>
        <div className="lab-tabs" role="tablist" aria-label="Lab results" onKeyDown={onTabKey}>
          {LAB_TABS.map((t) => {
            const selected = t.id === tab;
            const flag = tabFlag(t.id, findings, meta, you, calls);
            const dot = flag.tone !== "grey" ? flag : null;
            return (
              <button
                key={String(t.id)}
                id={`${tabIdBase}-tab-${String(t.id)}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tabIdBase}-panel`}
                tabIndex={selected ? 0 : -1}
                className={selected ? "is-active" : undefined}
                onClick={() => onTab(t.id)}
              >
                {t.label}
                {dot ? (
                  <>
                    <i className={`lab-tabdot is-${dot.tone}`} aria-hidden="true" />
                    <span className="sr-only">, flag {dot.text.toLowerCase()}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
        <section className="lab-panel" id={`${tabIdBase}-panel`} role="tabpanel" aria-labelledby={`${tabIdBase}-tab-${String(tab)}`} ref={bodyRef}>
          {body}
        </section>
        <footer className="lab-foot">
          <span>Powered by Nansen API</span>
          {deep && !confirmDeep ? (
            <button type="button" className="lab-deep" onClick={() => setConfirmDeep(true)}>
              Deep scan (≈{deep.credits} credits)
            </button>
          ) : null}
          {deep && confirmDeep ? (
            <span className="lab-deep-confirm" role="group" aria-label="Confirm the deep scan">
              <span>
                ≈{deep.credits} credits
                {deep.left !== null ? ` · ${deep.left} left today` : ""}
              </span>
              {deep.left !== null && deep.left < deep.credits ? (
                <span className="lab-deep-note">Not enough of today&apos;s deep-scan budget left.</span>
              ) : (
                <button
                  type="button"
                  className="lab-deep"
                  onClick={() => {
                    setConfirmDeep(false);
                    deep.onStart();
                  }}
                >
                  Confirm deep scan
                </button>
              )}
              <button type="button" className="lab-link" onClick={() => setConfirmDeep(false)}>
                Cancel
              </button>
            </span>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
