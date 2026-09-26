"use client";

// Shared pieces of the lab-results tabs: the tab head (label, lab flag, question), the big answer,
// the "Show ... ▸" disclosure, a width-measured SVG, addresses with copy + "Nansen ↗", the legend.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type SVGProps } from "react";
import { NA, type FlagTone, type LabAnswer, type LabFlag } from "@/lib/xray/lab";
import type { FindingStatus } from "@/lib/xray/types";

/* ------------------------------------------------------------------------------ palette */

/** Chart colours on the lab paper (the approved mockup's). Text wears ink tokens; colour marks identity. */
export const C = {
  red: "#c0322a",
  redSoft: "#d9897f",
  redMid: "#c9675c",
  amber: "#c98512",
  green: "#2f8f6b",
  greenSoft: "#a9c3b6",
  blue: "#1f3a8a",
  ink: "#1c1d22",
  ink2: "#5b5a55",
  ink3: "#8b877c",
  paper: "#f4f1e8",
  paper2: "#ebe6d8",
  exchange: "#9aa3ab",
  independent: "#d6d0c1",
  pale: "#d9d3c4",
  ghost: "#e2dccb",
  rope: "#b9b2a0",
} as const;

/** Tone -> mark colour on paper. */
export const TONE: Record<FlagTone, string> = { red: C.red, amber: C.amber, green: C.green, grey: C.ink3 };

/** The bedside monitor's phosphor colours. */
export const SCREEN = {
  red: "#ff6b5e",
  amber: "#f0b54a",
  green: "#5fd39e",
  grey: "#6f8a80",
  ink: "#cfe3da",
  dim: "#6f8a80",
  track: "#15221e",
  line: "#2c3b36",
} as const;

export const SCREEN_TONE: Record<FlagTone, string> = { red: SCREEN.red, amber: SCREEN.amber, green: SCREEN.green, grey: SCREEN.grey };

/* ------------------------------------------------------------------------------ links */

export function nansenTokenUrl(chain: string, tokenAddress: string): string {
  return `https://app.nansen.ai/token-god-mode?chain=${encodeURIComponent(chain)}&tokenAddress=${encodeURIComponent(tokenAddress)}`;
}

export function nansenProfilerUrl(chain: string, address: string): string {
  return `https://app.nansen.ai/profiler?address=${encodeURIComponent(address)}&chain=${encodeURIComponent(chain)}`;
}

/** Only links that really point at Nansen's profiler are used as-is. */
export function profilerLink(row: { address: string; nansenUrl?: string }, chain: string): string {
  return row.nansenUrl && row.nansenUrl.startsWith("https://app.nansen.ai/") ? row.nansenUrl : nansenProfilerUrl(chain, row.address);
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function num(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : NA;
}

/** An id that is safe inside url(#...) references. */
export function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/* ------------------------------------------------------------------------------ measured svg */

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** The rendered width of an element (px), kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(fallback = 640): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cw = Math.round(el.getBoundingClientRect().width);
      if (cw > 0) setW((prev) => (prev === cw ? prev : cw));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * An SVG drawn in real pixels: the children get the measured width, so 11px text stays 11px from a
 * phone to a 1920 screen. Below `minWidth` the drawing is laid out at minWidth and scaled down.
 */
export function FitSvg({
  height,
  label,
  className,
  minWidth = 280,
  decorative,
  children,
}: {
  height: number | ((w: number) => number);
  label: string;
  className?: string;
  minWidth?: number;
  /** Inside a control that already has a name: hidden from assistive tech. */
  decorative?: boolean;
  children: (w: number, h: number) => ReactNode;
}) {
  const [ref, measured] = useWidth<HTMLSpanElement>();
  const w = Math.max(minWidth, measured);
  const h = typeof height === "function" ? height(w) : height;
  return (
    <span ref={ref} className={`lab-fit${className ? ` ${className}` : ""}`}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        {...(decorative ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": label })}
      >
        {children(w, h)}
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------------------ tab head */

/** A lab flag: outlined, coloured, uppercase ("BORDERLINE", "TAKING PROFIT", "3 OF 5 ABNORMAL"). */
export function FlagChip({ flag, what = "Flag" }: { flag: LabFlag; what?: string }) {
  return (
    <span className={`lab-flag is-${flag.tone}`}>
      <span className="sr-only">{what}: </span>
      {flag.text}
    </span>
  );
}

const STATUS_TEXT: Record<FindingStatus, string | null> = { ok: null, partial: "Partial data", unavailable: "Data unavailable" };

export function TabHead({ tag, flag, question, status, flagWhat }: { tag: string; flag: LabFlag; question?: string; status?: FindingStatus | null; flagWhat?: string }) {
  const note = status ? STATUS_TEXT[status] : null;
  return (
    <>
      <div className="lab-tabline">
        <span className="lab-tabtag">
          {tag}
          {note ? <span className={`lab-datastatus is-${status}`}>{note}</span> : null}
        </span>
        <FlagChip flag={flag} what={flagWhat} />
      </div>
      {question ? <h3 className="lab-q">{question}</h3> : null}
    </>
  );
}

/** One big number and one short line. */
export function Answer({ a }: { a: LabAnswer }) {
  return (
    <p className="lab-answer">
      <strong className={`lab-big is-${a.tone}`}>{a.value}</strong>
      <span className="lab-one">{a.line}</span>
    </p>
  );
}

/* ------------------------------------------------------------------------------ disclosure */

/** "Show wallets ▸": the tables and the long text, collapsed by default. */
export function Disclosure({ what, children }: { what: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="lab-disclosure">
      <button type="button" className="lab-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? `Hide ${what} ▾` : `Show ${what} ▸`}
      </button>
      <div id={id} className="lab-more-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------ legend */

export function Legend({ items }: { items: { key: string; label: ReactNode; swatch: string; hatch?: boolean; hollow?: boolean }[] }) {
  if (!items.length) return null;
  return (
    <ul className="lab-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.key}>
          <i
            aria-hidden="true"
            className={it.hatch ? "is-hatch" : it.hollow ? "is-hollow" : undefined}
            style={it.hatch || it.hollow ? { borderColor: it.swatch } : { background: it.swatch }}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------ addresses */

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions / insecure context): select-and-copy fallback.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        setCopied(document.execCommand("copy"));
      } catch {
        setCopied(false);
      }
      area.remove();
    }
  };
  return (
    <button type="button" className={`lab-copy${copied ? " is-copied" : ""}`} onClick={copy} aria-label={copied ? `Copied ${label}` : `Copy ${label}`} title={copied ? "Copied" : "Copy full address"}>
      {copied ? (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3 10.5V2.5h8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </button>
  );
}

/** A wallet: optional entity name, short address, copy button and "Nansen ↗" (opens its profiler). */
export function Address({ address, href, name, long }: { address: string; href: string; name?: string | null; long?: boolean }) {
  const short = shortAddr(address);
  return (
    <span className="lab-addr">
      {name ? <b className="lab-addr-name">{name}</b> : null}
      <code title={address}>{short}</code>
      <CopyButton text={address} label={`address ${short}`} />
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name ? `${name} ` : ""}${short} in Nansen (new tab)`} title="Open in Nansen">
        {long ? "Open in Nansen ↗" : "Nansen ↗"}
      </a>
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="lab-note">{children}</p>;
}

/** SVG text with a paper halo, legible on top of bars. */
export function Halo({ children, ...rest }: SVGProps<SVGTextElement>) {
  return (
    <text {...rest} className="lab-halo">
      {children}
    </text>
  );
}

/** Where a chart goes while its data is pending or missing. */
export function Placeholder({ text, height = 110 }: { text: string; height?: number }) {
  return (
    <div className="lab-ghost" style={{ minHeight: height }}>
      <span>{text}</span>
    </div>
  );
}
