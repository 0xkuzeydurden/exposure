"use client";

// The check-in gate (lib/exposure/checkin): a reception card over the dimmed room on the first page of
// a browser session. "Check in" turns the sound on inside the click (browsers only allow audio after a
// gesture), the card fades, then the room plays its opening exposure with sound. "Enter silently" (or
// Esc) does the same with the sound switched off. Enter / Space check in, Tab stays on the card.
//
// It is server-rendered, so the first paint already shows it over the room (no flash of the intro). A
// returning visitor's card is hidden by an inline script during parsing, before the first paint, and
// dropped by the room once the session flag is read on the client.
import { useCallback, useEffect, useRef, useState } from "react";
import { CHECKIN_FADE_MS, CHECKIN_ID, CHECKIN_SCRIPT, chooseSound, type CheckInChoice } from "@/lib/exposure/checkin";
import { sound } from "@/lib/exposure/sound";

export interface CheckInProps {
  /** The card has left (the sound choice is already applied): record the check-in, start the intro. */
  onDone: (choice: CheckInChoice) => void;
}

const NOSCRIPT_CSS = `<style>#${CHECKIN_ID}{display:none}</style>`;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs during HTML parsing on a full load; on the client it is rendered as an inert data block (React
 * never executes scripts it creates, and warns about executable ones). Next.js guide: preventing flash
 * before hydration.
 */
function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function CheckIn({ onDone }: CheckInProps) {
  const [leaving, setLeaving] = useState(false);
  const goRef = useRef<HTMLButtonElement>(null);
  const silentRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ choice: CheckInChoice; timer: number } | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const choose = useCallback((choice: CheckInChoice) => {
    if (pending.current) return;
    // Inside the gesture: the AudioContext may only start here.
    chooseSound(choice, sound);
    setLeaving(true);
    const timer = window.setTimeout(
      () => {
        pending.current = null;
        onDoneRef.current(choice);
      },
      reducedMotion() ? 0 : CHECKIN_FADE_MS,
    );
    pending.current = { choice, timer };
  }, []);

  // The primary button has the focus, so Enter / Space check in straight away.
  useEffect(() => {
    goRef.current?.focus({ preventScroll: true });
  }, []);

  // Keyboard: Esc enters silently; Enter / Space check in when the focus is not on one of the card's
  // buttons (those activate themselves); Tab cycles between the two buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pending.current || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const buttons = [goRef.current, silentRef.current].filter((b): b is HTMLButtonElement => b !== null);
      if (e.key === "Escape") {
        e.preventDefault();
        choose("silent");
      } else if (e.key === "Enter" || e.key === " ") {
        if (buttons.includes(e.target as HTMLButtonElement)) return;
        e.preventDefault();
        choose("sound");
      } else if (e.key === "Tab" && buttons.length) {
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
        buttons[next].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose]);

  // Unmounted mid-fade (a navigation): the choice still counts.
  useEffect(
    () => () => {
      const p = pending.current;
      if (!p) return;
      window.clearTimeout(p.timer);
      pending.current = null;
      onDoneRef.current(p.choice);
    },
    [],
  );

  return (
    <>
      <div
        id={CHECKIN_ID}
        className={leaving ? "checkin is-leaving" : "checkin"}
        role="dialog"
        aria-modal="true"
        aria-label="Check in to EXPOSURE"
        aria-describedby={`${CHECKIN_ID}-note`}
        suppressHydrationWarning
      >
        <div className="checkin-card">
          <div className="checkin-brand">
            <span className="checkin-cross" aria-hidden="true" />
            <b>EXPOSURE</b>
          </div>
          <p className="checkin-dept">Radiology · On-chain imaging</p>
          <button ref={goRef} type="button" className="checkin-go" onClick={() => choose("sound")}>
            Check in
          </button>
          <p className="checkin-note" id={`${CHECKIN_ID}-note`}>
            Sound on · headphones recommended
          </p>
          <button ref={silentRef} type="button" className="checkin-silent" onClick={() => choose("silent")}>
            Enter silently
          </button>
        </div>
      </div>
      <InlineScript html={CHECKIN_SCRIPT} />
      <noscript dangerouslySetInnerHTML={{ __html: NOSCRIPT_CSS }} />
    </>
  );
}

export default CheckIn;
