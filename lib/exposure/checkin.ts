// The check-in gate. Browsers only allow audio after a user gesture, so the first page of a browser
// session opens on a reception card: "Check in" (the click turns the sound on) or "Enter silently".
// The room behind it is server-rendered as usual; the opening exposure starts when the card leaves.
// Later pages of the same session (reloads, other tokens) skip the card and play the intro at once
// with the stored sound preference. Recording mode (?rec=1) never shows it: it has its own plate.
//
//   gateNeeded({ recording: director !== null, checkedIn: hasCheckedIn() })
//   chooseSound("sound", sound);   // inside the click: sound on + unlock
//   completeCheckIn();             // after the card's fade: session flag + listeners (the intro starts)
//
// No React and no DOM beyond the Web Storage interface, so the tests run in node.

/** sessionStorage key, "1" once the visitor checked in (with or without sound) in this browser session. */
export const CHECKIN_KEY = "exposure:checked-in";

/** DOM id of the gate; the inline script hides it before the first paint for a returning visitor. */
export const CHECKIN_ID = "checkin";

/** The card's exit fade (instant with prefers-reduced-motion). */
export const CHECKIN_FADE_MS = 260;

export type CheckInChoice = "sound" | "silent";

/** The part of Web Storage the gate needs (sessionStorage in the browser, a Map in the tests). */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of the sound engine (lib/exposure/sound) the gate drives. */
export interface SoundSwitch {
  setEnabled(on: boolean): void;
  unlock(): void;
}

/** window.sessionStorage, or null on the server and wherever storage is blocked. */
export function sessionStore(): FlagStore | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Checked in during this document (survives blocked storage until the next full load). */
let checkedInHere = false;
const listeners = new Set<() => void>();

/** True when this browser session already went through the gate. Never throws. */
export function hasCheckedIn(store: FlagStore | null = sessionStore()): boolean {
  if (checkedInHere) return true;
  try {
    return store?.getItem(CHECKIN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether a page opens on the gate: not in recording mode, not twice in one session. */
export function gateNeeded({ recording, checkedIn }: { recording: boolean; checkedIn: boolean }): boolean {
  return !recording && !checkedIn;
}

/**
 * The visitor's choice, applied inside the click (or key) handler so the browser counts the gesture:
 * "sound" switches the sound on and unlocks the AudioContext, "silent" switches it off. Both persist as
 * the engine's own sound preference (the signage toggle shows the same state).
 */
export function chooseSound(choice: CheckInChoice, sound: SoundSwitch): void {
  if (choice === "sound") {
    sound.setEnabled(true);
    sound.unlock();
  } else {
    sound.setEnabled(false);
  }
}

/** The card has left: remember the check-in for this session and let the room start its intro. */
export function completeCheckIn(store: FlagStore | null = sessionStore()): void {
  checkedInHere = true;
  try {
    store?.setItem(CHECKIN_KEY, "1");
  } catch {
    /* storage blocked: the gate shows again on the next full load */
  }
  for (const l of listeners) l();
}

/** The whole check-in in one call (choice + session flag), for callers without an exit animation. */
export function checkIn(choice: CheckInChoice, sound: SoundSwitch, store: FlagStore | null = sessionStore()): void {
  chooseSound(choice, sound);
  completeCheckIn(store);
}

/** useSyncExternalStore subscription: fires when the visitor checks in. */
export function subscribeCheckIn(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Client snapshot for useSyncExternalStore (the server snapshot is `false`: the gate is rendered). */
export function checkedInSnapshot(): boolean {
  return hasCheckedIn();
}

/** Tests only: forget the in-document check-in. */
export function resetCheckInForTests(): void {
  checkedInHere = false;
  listeners.clear();
}

/**
 * Inline script placed right after the gate in the server HTML: a returning visitor's gate is hidden
 * during parsing, before the first paint (React hydrates it with suppressHydrationWarning and removes
 * it once the session flag is read on the client).
 */
export const CHECKIN_SCRIPT = `try{if(sessionStorage.getItem(${JSON.stringify(CHECKIN_KEY)})==="1"){var g=document.getElementById(${JSON.stringify(
  CHECKIN_ID,
)});if(g)g.hidden=true}}catch(e){}`;
