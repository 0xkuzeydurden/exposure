// The check-in gate (lib/exposure/checkin): when a page opens on it (never in recording mode, once per
// browser session), the session flag (Web Storage that may be missing or blocked), the sound choice
// applied inside the click, and the inline script that hides the card for a returning visitor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDirectorParams } from "@/components/exposure/DirectorScript";
import {
  CHECKIN_ID,
  CHECKIN_KEY,
  CHECKIN_SCRIPT,
  checkedInSnapshot,
  checkIn,
  chooseSound,
  completeCheckIn,
  gateNeeded,
  hasCheckedIn,
  resetCheckInForTests,
  subscribeCheckIn,
  type FlagStore,
  type SoundSwitch,
} from "@/lib/exposure/checkin";
import { sound } from "@/lib/exposure/sound";

/** In-memory Web Storage. */
function memoryStore(init: Record<string, string> = {}): FlagStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** Storage that throws on every access (Safari private mode, blocked site data). */
const blockedStore: FlagStore = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("SecurityError");
  },
};

/** Records what the gate asked of the sound engine, in order. */
function soundSpy(): SoundSwitch & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setEnabled: (on) => void calls.push(on ? "on" : "off"),
    unlock: () => void calls.push("unlock"),
  };
}

beforeEach(() => resetCheckInForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  resetCheckInForTests();
});

describe("gateNeeded", () => {
  it("opens the first page of a session", () => {
    expect(gateNeeded({ recording: false, checkedIn: false })).toBe(true);
  });

  it("is skipped once the visitor checked in this session", () => {
    expect(gateNeeded({ recording: false, checkedIn: true })).toBe(false);
  });

  it("never shows in recording mode (?rec=1 / ?director=1 have their own Click to start plate)", () => {
    for (const q of [{ rec: "1" }, { rec: "" }, { director: "1" }, { rec: "1", autostart: "1" }]) {
      expect(gateNeeded({ recording: parseDirectorParams(q) !== null, checkedIn: false }), JSON.stringify(q)).toBe(false);
    }
    for (const q of [{}, { rec: "0" }, { speed: "2" }]) {
      expect(gateNeeded({ recording: parseDirectorParams(q) !== null, checkedIn: false }), JSON.stringify(q)).toBe(true);
    }
  });
});

describe("session flag", () => {
  it("is off in a new session and on after the check-in", () => {
    const store = memoryStore();
    expect(hasCheckedIn(store)).toBe(false);
    completeCheckIn(store);
    expect(store.data.get(CHECKIN_KEY)).toBe("1");
    expect(hasCheckedIn(store)).toBe(true);
  });

  it("reads a check-in from an earlier page of the session (a reload)", () => {
    expect(hasCheckedIn(memoryStore({ [CHECKIN_KEY]: "1" }))).toBe(true);
    expect(hasCheckedIn(memoryStore({ [CHECKIN_KEY]: "0" }))).toBe(false);
  });

  it("is off on the server (no storage) and never throws when storage is blocked", () => {
    expect(hasCheckedIn(null)).toBe(false);
    expect(hasCheckedIn()).toBe(false); // node: no window, no sessionStorage
    expect(hasCheckedIn(blockedStore)).toBe(false);
    expect(() => completeCheckIn(blockedStore)).not.toThrow();
    // Blocked storage: the check-in still holds for the rest of this document.
    expect(hasCheckedIn(blockedStore)).toBe(true);
  });

  it("uses window.sessionStorage by default", () => {
    const session = memoryStore();
    vi.stubGlobal("window", { sessionStorage: session });
    expect(checkedInSnapshot()).toBe(false);
    completeCheckIn();
    expect(session.data.get(CHECKIN_KEY)).toBe("1");
    expect(checkedInSnapshot()).toBe(true);
  });

  it("notifies subscribers (the room starts its intro) until they unsubscribe", () => {
    const fn = vi.fn();
    const off = subscribeCheckIn(fn);
    completeCheckIn(memoryStore());
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    completeCheckIn(memoryStore());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("the choice", () => {
  it("Check in: sound on, then unlock (inside the gesture)", () => {
    const s = soundSpy();
    chooseSound("sound", s);
    expect(s.calls).toEqual(["on", "unlock"]);
  });

  it("Enter silently: sound off, no AudioContext", () => {
    const s = soundSpy();
    chooseSound("silent", s);
    expect(s.calls).toEqual(["off"]);
  });

  it("checkIn applies the choice and marks the session", () => {
    const store = memoryStore();
    const s = soundSpy();
    checkIn("silent", s, store);
    expect(s.calls).toEqual(["off"]);
    expect(hasCheckedIn(store)).toBe(true);
  });

  it("a silent entry persists the engine's sound flag as off (the signage shows Sound off)", () => {
    const local = memoryStore();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memoryStore() });
    const seen: boolean[] = [];
    const off = sound.subscribe(() => seen.push(sound.enabled));

    checkIn("silent", sound);
    expect(local.data.get("exposure:sound")).toBe("off");
    expect(sound.enabled).toBe(false);

    // The next session's Check in turns it back on (no AudioContext in node: unlock is a no-op).
    resetCheckInForTests();
    checkIn("sound", sound);
    expect(local.data.get("exposure:sound")).toBe("on");
    expect(sound.enabled).toBe(true);
    expect(seen).toEqual([false, true]);
    off();
  });
});

describe("sound.resume (a returning visitor, no gesture yet)", () => {
  function fakeAudio() {
    const made: string[] = [];
    class FakeContext {
      state = "suspended";
      sampleRate = 44100;
      currentTime = 0;
      destination = {};
      constructor() {
        made.push("ctx");
      }
      createGain() {
        return { gain: { value: 1, setValueAtTime() {} }, connect() {} };
      }
      createBuffer(_c: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      resume() {
        return Promise.resolve();
      }
    }
    return { made, FakeContext };
  }

  it("tries only where the browser may allow audio, and never while the sound is off", () => {
    const { made, FakeContext } = fakeAudio();
    const local = memoryStore();
    const withAudio = () => vi.stubGlobal("window", { localStorage: local, AudioContext: FakeContext });
    const withoutAudio = () => vi.stubGlobal("window", { localStorage: local });

    withoutAudio();
    sound.setEnabled(false);
    withAudio();
    sound.resume();
    expect(made).toEqual([]); // sound off (entered silently)

    withoutAudio();
    sound.setEnabled(true); // (its own unlock finds no AudioContext here)
    withAudio();
    vi.stubGlobal("navigator", { getAutoplayPolicy: () => "disallowed" });
    expect(() => sound.resume()).not.toThrow();
    expect(made).toEqual([]); // the browser says no: stay silent until the first gesture

    vi.stubGlobal("navigator", { getAutoplayPolicy: () => "allowed" });
    sound.resume();
    expect(made).toEqual(["ctx"]);
  });
});

describe("CHECKIN_SCRIPT (hides the card before the first paint)", () => {
  function run(storage: Partial<FlagStore>) {
    const gate = { hidden: false };
    const document = { getElementById: (id: string) => (id === CHECKIN_ID ? gate : null) };
    new Function("sessionStorage", "document", CHECKIN_SCRIPT)(storage, document);
    return gate.hidden;
  }

  it("hides the gate for a visitor who checked in this session", () => {
    expect(run(memoryStore({ [CHECKIN_KEY]: "1" }))).toBe(true);
  });

  it("leaves it for a new session and when storage is blocked", () => {
    expect(run(memoryStore())).toBe(false);
    expect(() => run(blockedStore)).not.toThrow();
    expect(run(blockedStore)).toBe(false);
  });
});
