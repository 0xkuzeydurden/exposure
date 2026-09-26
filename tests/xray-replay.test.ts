import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSyntheticScan } from "@/lib/xray/fixtures";
import { playScan, replayDurationMs, scanTimeline } from "@/lib/xray/replay";
import type { CallRecord, FindingKey, Scan, ScanEvent } from "@/lib/xray/types";

const SYNTHETIC = makeSyntheticScan();

function call(at: number, finding: FindingKey, endpoint = "tgm/flows"): CallRecord {
  return { endpoint, status: 200, credits: 1, ms: 100, cached: false, at, finding };
}

function withCalls(calls: CallRecord[]): Scan {
  return { ...SYNTHETIC, calls };
}

/** Event list with calls collapsed, e.g. "stage:context", "meta", "call:context", "finding:buyers". */
function outline(events: ScanEvent[]): string[] {
  return events.map((e) =>
    e.type === "stage" ? `stage:${e.stage}` : e.type === "call" ? `call:${e.call.finding}` : e.type === "finding" ? `finding:${e.key}` : e.type,
  );
}

function skeleton(events: ScanEvent[]): string[] {
  return outline(events).filter((s) => !s.startsWith("call:"));
}

const ORDER = [
  "stage:context",
  "meta",
  "stage:buyers",
  "finding:buyers",
  "stage:flow",
  "finding:flow",
  "stage:walls",
  "finding:walls",
  "stage:smart",
  "finding:smart",
  "stage:diagnosis",
  "diagnosis",
  "stage:done",
  "done",
];

describe("playScan · instant", () => {
  it("emits the whole stream synchronously in contract order", () => {
    const events: ScanEvent[] = [];
    const cancel = playScan(SYNTHETIC, (e) => events.push(e), { instant: true });
    expect(typeof cancel).toBe("function");
    expect(skeleton(events)).toEqual(ORDER);

    // Every call sits between its own stage and finding, in `at` order within the finding.
    const lanes = outline(events);
    let current = "context";
    let lastAt = -Infinity;
    events.forEach((e, i) => {
      if (e.type === "stage") {
        current = e.stage;
        lastAt = -Infinity;
      }
      if (e.type === "call") {
        expect(lanes[i]).toBe(`call:${current}`);
        expect(e.call.at).toBeGreaterThanOrEqual(lastAt);
        lastAt = e.call.at;
      }
    });
    expect(events.filter((e) => e.type === "call")).toHaveLength(SYNTHETIC.calls.length);

    const meta = events[1];
    expect(meta.type === "meta" && meta.price.length).toBe(168);
    const done = events[events.length - 1];
    expect(done.type === "done" && done.scan).toBe(SYNTHETIC);
    const diag = events.find((e) => e.type === "diagnosis");
    expect(diag?.type === "diagnosis" && diag.diagnosis.sentence).toBe("Smart money is selling to the crowd.");
    const doneStage = events.find((e) => e.type === "stage" && e.stage === "done");
    expect(doneStage?.type === "stage" && doneStage.message).toBe("Exposure complete · 248 Nansen API calls · 271 credits");
  });

  it("puts calls recorded for 'you' (or unknown findings) after the last finding", () => {
    const events: ScanEvent[] = [];
    playScan(withCalls([call(10, "you", "profiler/address/pnl"), call(5, "buyers")]), (e) => events.push(e), { instant: true });
    const o = outline(events);
    expect(o.indexOf("call:you")).toBeGreaterThan(o.indexOf("finding:smart"));
    expect(o.indexOf("call:you")).toBeLessThan(o.indexOf("stage:diagnosis"));
  });

  it("works with no calls at all", () => {
    const events: ScanEvent[] = [];
    playScan(withCalls([]), (e) => events.push(e), { instant: true });
    expect(outline(events)).toEqual(ORDER);
    expect(replayDurationMs(withCalls([]))).toBe(0);
  });
});

describe("scanTimeline · timing", () => {
  const timesOfCalls = (scan: Scan, opts?: Parameters<typeof scanTimeline>[1]) =>
    scanTimeline(scan, opts).flatMap((s) => s.events.filter((e) => e.type === "call").map(() => s.at));

  it("compresses gaps by speed (default 6) and clamps them at maxGapMs (default 250)", () => {
    const scan = withCalls([call(0, "context"), call(600, "buyers"), call(60_600, "buyers")]);
    expect(timesOfCalls(scan)).toEqual([0, 100, 350]);
    expect(timesOfCalls(scan, { speed: 1, maxGapMs: 1_000 })).toEqual([0, 600, 1_600]);
    expect(timesOfCalls(scan, { speed: 2, maxGapMs: 100_000 })).toEqual([0, 300, 30_300]);
  });

  it("falls back to the defaults for invalid options", () => {
    const scan = withCalls([call(0, "context"), call(600, "buyers")]);
    expect(timesOfCalls(scan, { speed: 0, maxGapMs: -5 })).toEqual([0, 100]);
    expect(timesOfCalls(scan, { speed: Number.NaN })).toEqual([0, 100]);
  });

  it("replays one finding at a time even when the live scan ran them in parallel", () => {
    // buyers ran 0..6000ms while flow ran 1000..1200ms.
    const scan = withCalls([call(6_000, "buyers"), call(1_000, "flow"), call(1_200, "flow"), call(0, "buyers")]);
    const steps = scanTimeline(scan, { speed: 1, maxGapMs: 10_000 });
    const calls = steps.flatMap((s) => s.events.flatMap((e) => (e.type === "call" ? [{ t: s.at, at: e.call.at }] : [])));
    // buyers 0 -> 6000 (gap 6000), then flow 1000 (gap clamped to 0), flow 1200 (gap 200).
    expect(calls).toEqual([
      { t: 0, at: 0 },
      { t: 6_000, at: 6_000 },
      { t: 6_000, at: 1_000 },
      { t: 6_200, at: 1_200 },
    ]);
  });

  it("the synthetic deep scan replays in a few seconds at default speed", () => {
    const ms = replayDurationMs(SYNTHETIC);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThan(15_000);
    expect(replayDurationMs(SYNTHETIC, { instant: true })).toBe(0);
  });
});

describe("playScan · timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits nothing synchronously, then the same stream as instant mode", () => {
    const instant: ScanEvent[] = [];
    playScan(SYNTHETIC, (e) => instant.push(e), { instant: true });

    const events: ScanEvent[] = [];
    playScan(SYNTHETIC, (e) => events.push(e));
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(replayDurationMs(SYNTHETIC) + 1);
    expect(events).toEqual(instant);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows the timeline: the first calls land before the last ones", () => {
    const scan = withCalls([call(0, "context"), call(600, "buyers"), call(1_800, "flow")]);
    const events: ScanEvent[] = [];
    playScan(scan, (e) => events.push(e));
    vi.advanceTimersByTime(0);
    // A finding's stage is announced as soon as the previous finding is done.
    expect(outline(events)).toEqual(["stage:context", "meta", "call:context", "stage:buyers"]);
    vi.advanceTimersByTime(100); // 600 / 6
    expect(outline(events).slice(4)).toEqual(["call:buyers", "finding:buyers", "stage:flow"]);
    vi.advanceTimersByTime(199);
    expect(outline(events)).not.toContain("call:flow");
    vi.advanceTimersByTime(1); // + min(250, 1200 / 6) = 300
    expect(skeleton(events)).toEqual(ORDER);
  });

  it("cancel stops the stream and clears every timer", () => {
    const events: ScanEvent[] = [];
    const cancel = playScan(SYNTHETIC, (e) => events.push(e));
    vi.advanceTimersByTime(1_000);
    const seen = events.length;
    expect(seen).toBeGreaterThan(2);
    expect(events.some((e) => e.type === "done")).toBe(false);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(seen);
    cancel(); // idempotent
  });

  it("cancel from inside a handler stops the rest of that step", () => {
    const events: ScanEvent[] = [];
    let cancel: () => void = () => {};
    cancel = playScan(SYNTHETIC, (e) => {
      events.push(e);
      if (e.type === "meta") cancel();
    });
    vi.advanceTimersByTime(60_000);
    expect(outline(events)).toEqual(["stage:context", "meta"]);
  });
});
