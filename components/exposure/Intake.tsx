"use client";

// "Next patient" intake: symbol / name search with debounced autocomplete (/api/search, 0 credits)
// merged with the recorded patients, or a pasted token address (+ chain select when ambiguous).
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chainName, shortAddr } from "@/components/exposure/Report";
import { patientKey, type Patient } from "@/components/exposure/WaitingRoom";
import { SUPPORTED_CHAINS, isEvmChain } from "@/lib/nansen/chains";

export interface IntakeTarget {
  chain: string;
  token: string;
  symbol?: string;
  name?: string;
  /** Set when the token already has a recorded x-ray (replays for 0 credits). */
  recorded?: Patient;
}

export interface IntakeLive {
  /** /api/account answered. */
  known: boolean;
  /** Live (credit-spending) x-rays are allowed on this server. */
  enabled: boolean;
  /** Estimated credits for a quick live scan. */
  quickCredits: number;
}

export interface IntakeProps {
  patients: Patient[];
  live: IntakeLive;
  /** The x-ray tube is charging (glow). */
  armed?: boolean;
  /** Text typed by the room's demo (shown instead of the user's input while set). */
  ghost?: string | null;
  notice?: string | null;
  onSubmit: (target: IntakeTarget) => void;
  /** The visitor reached for the intake (focus / pointer): the room stops its demo typing. */
  onActivate?: () => void;
  className?: string;
}

interface Option {
  id: string;
  chain: string;
  token: string;
  symbol: string;
  name: string;
  recorded?: Patient;
}

interface SearchResult {
  name: string;
  symbol: string;
  chain: string;
  address: string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SUI_COIN = /^0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/;
const EVM_CHAINS = SUPPORTED_CHAINS.filter((c) => isEvmChain(c));

type AddressKind = "evm" | "solana" | "sui" | null;

function addressKind(q: string): AddressKind {
  if (EVM_ADDRESS.test(q)) return "evm";
  if (SUI_COIN.test(q)) return "sui";
  if (SOLANA_ADDRESS.test(q) && !/^0x/.test(q)) return "solana";
  return null;
}

function parseResults(body: unknown): SearchResult[] {
  if (!body || typeof body !== "object") return [];
  const list = (body as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  const out: SearchResult[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.chain !== "string" || typeof o.address !== "string") continue;
    out.push({
      chain: o.chain,
      address: o.address,
      symbol: typeof o.symbol === "string" ? o.symbol : "",
      name: typeof o.name === "string" ? o.name : "",
    });
  }
  return out;
}

function matchPatients(patients: Patient[], q: string): Patient[] {
  const s = q.trim().replace(/^\$/, "").toLowerCase();
  if (s.length < 1) return [];
  return patients.filter(
    (p) =>
      p.symbol.toLowerCase().startsWith(s) ||
      p.name.toLowerCase().includes(s) ||
      p.tokenAddress.toLowerCase() === s,
  );
}

function IntakeImpl({ patients, live, armed, ghost, notice, onSubmit, onActivate, className }: IntakeProps) {
  const [query, setQuery] = useState("");
  /** Last answered search (kept while the next one is in flight, so the list does not flicker). */
  const [answered, setAnswered] = useState<{ q: string; results: SearchResult[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [chain, setChain] = useState<string>("base");
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const inputId = useId();

  const q = query.trim();
  const kind = addressKind(q);

  const wantsSearch = q.length >= 2 && !kind;
  const results = useMemo(() => (wantsSearch && answered ? answered.results : []), [wantsSearch, answered]);
  const searching = wantsSearch && answered?.q !== q;

  // Debounced autocomplete (search/general costs 0 credits).
  useEffect(() => {
    if (!wantsSearch) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: unknown) => setAnswered({ q, results: parseResults(body) }))
        .catch(() => {
          if (!ctrl.signal.aborted) setAnswered({ q, results: [] });
        });
    }, 240);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, wantsSearch]);

  const options: Option[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const p of matchPatients(patients, q)) {
      const key = patientKey(p.chain, p.tokenAddress);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, chain: p.chain, token: p.tokenAddress, symbol: p.symbol, name: p.name, recorded: p });
    }
    for (const r of results) {
      const key = patientKey(r.chain, r.address);
      if (seen.has(key)) continue;
      seen.add(key);
      const recorded = patients.find((p) => patientKey(p.chain, p.tokenAddress) === key);
      out.push({ id: key, chain: r.chain, token: r.address, symbol: r.symbol, name: r.name, recorded });
    }
    return out.slice(0, 8);
  }, [patients, results, q]);

  const recordedForAddress = useMemo(() => {
    if (!kind) return undefined;
    const c = kind === "evm" ? chain : kind;
    const key = patientKey(c, q);
    return patients.find((p) => patientKey(p.chain, p.tokenAddress) === key);
  }, [kind, chain, q, patients]);

  const showList = open && !kind && q.length >= 1 && (options.length > 0 || searching);

  const submitOption = useCallback(
    (o: Option) => {
      onSubmit({ chain: o.chain, token: o.token, symbol: o.symbol, name: o.name, recorded: o.recorded });
      setOpen(false);
      setActive(-1);
      setQuery("");
      setHint(null);
      inputRef.current?.blur();
    },
    [onSubmit],
  );

  const submit = useCallback(() => {
    if (!q) return;
    if (kind) {
      const c = kind === "evm" ? chain : kind;
      onSubmit({ chain: c, token: q, recorded: recordedForAddress });
      setQuery("");
      setOpen(false);
      setHint(null);
      inputRef.current?.blur();
      return;
    }
    const pick = active >= 0 ? options[active] : options[0];
    if (pick) {
      submitOption(pick);
      return;
    }
    setHint(searching ? "Still looking…" : "No match. Paste the token's contract address instead.");
  }, [q, kind, chain, onSubmit, recordedForAddress, active, options, submitOption, searching]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && options.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === "ArrowUp" && options.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  // What Enter would cost right now.
  const focused = options[active >= 0 ? active : 0];
  /** null = nothing to submit yet. */
  const topRecorded: boolean | null = kind ? Boolean(recordedForAddress) : focused ? Boolean(focused.recorded) : null;
  let cost: string | null = null;
  if (topRecorded) cost = "on file · 0 credits";
  else if (live.known && live.enabled && (topRecorded === false || !q)) cost = `live x-ray ≈${live.quickCredits} credits`;
  else if (live.known && !live.enabled) cost = "live x-rays off";

  const liveOff = live.known && !live.enabled;
  const note =
    hint ??
    notice ??
    (liveOff && q.length > 0 && !searching && !topRecorded ? "Live x-rays are off: pick a patient from the waiting room" : null);

  const shown = ghost ?? query;

  return (
    <div className={`intake-wrap${className ? ` ${className}` : ""}`}>
      <form
        className={`intake${armed ? " armed" : ""}`}
        autoComplete="off"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId}>Next patient</label>
        <input
          ref={inputRef}
          id={inputId}
          name="q"
          type="text"
          value={shown}
          readOnly={ghost != null}
          placeholder={liveOff ? "search the waiting room by symbol" : "paste a token address or symbol"}
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 && options[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
            setHint(null);
          }}
          onFocus={() => {
            onActivate?.();
            setOpen(true);
          }}
          onPointerDown={() => onActivate?.()}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {kind === "evm" ? (
          <select className="chain-select" aria-label="Chain" value={chain} onChange={(e) => setChain(e.target.value)}>
            {EVM_CHAINS.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
          </select>
        ) : null}
        {cost ? <span className="cost">{cost}</span> : null}
        <kbd aria-hidden="true">⏎</kbd>
      </form>

      {showList ? (
        <ul className="intake-list" id={listId} role="listbox" aria-label="Matching tokens">
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "is-active" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                submitOption(o);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <b>${o.symbol.replace(/^\$/, "") || "?"}</b>
              <span className="nm">{o.name}</span>
              <span className="ch">{chainName(o.chain)}</span>
              <span className="ad">{shortAddr(o.token)}</span>
              <span className={o.recorded ? "rc on" : "rc"}>{o.recorded ? "on file" : live.enabled ? `≈${live.quickCredits} cr` : "live off"}</span>
            </li>
          ))}
          {searching && options.length === 0 ? <li className="intake-searching">Searching the Nansen index…</li> : null}
        </ul>
      ) : null}

      {note ? (
        <div className="intake-note" role="status">
          {note}
        </div>
      ) : null}
    </div>
  );
}

export const Intake = memo(IntakeImpl);
