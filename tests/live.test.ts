import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenInformationResponse } from "../lib/nansen/schemas";
import { joinLiveBuild, liveBuildsAllowed, type LiveListener } from "../lib/pipeline/live";
import type { SceneEvent } from "../lib/types";

function recorder() {
  const events: SceneEvent[] = [];
  let ended = 0;
  const listener: LiveListener = {
    event: (e) => events.push(e),
    end: () => {
      ended += 1;
    },
  };
  return { events, listener, ended: () => ended };
}

const stage = (message: string): SceneEvent => ({ type: "stage", stage: "info", message });

describe("live build guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("allows live builds in development, and in production only with EXPOSURE_LIVE=1", () => {
    vi.stubEnv("EXPOSURE_LIVE", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(liveBuildsAllowed()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(liveBuildsAllowed()).toBe(false);
    vi.stubEnv("EXPOSURE_LIVE", "1");
    expect(liveBuildsAllowed()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EXPOSURE_LIVE", "0");
    expect(liveBuildsAllowed()).toBe(false);
  });

  it("shares one build between subscribers and replays earlier events to late ones", async () => {
    let emit: (e: SceneEvent) => void = () => {};
    let finish: () => void = () => {};
    const run = vi.fn((onEvent: (e: SceneEvent) => void) => {
      emit = onEvent;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const a = recorder();
    const leaveA = joinLiveBuild("base-0xshared", run, a.listener);
    emit(stage("one"));
    const b = recorder();
    joinLiveBuild("base-0xshared", run, b.listener);
    emit(stage("two"));

    expect(run).toHaveBeenCalledTimes(1);
    expect(a.events).toEqual([stage("one"), stage("two")]);
    expect(b.events).toEqual([stage("one"), stage("two")]);

    leaveA();
    emit(stage("three"));
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(3);

    finish();
    await vi.waitFor(() => expect(b.ended()).toBe(1));
    // Finished builds are forgotten: the next request starts a fresh one.
    joinLiveBuild("base-0xshared", run, recorder().listener);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
  });

  it("cancels a build once nobody has been listening for the grace period", () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    const run = (_onEvent: (e: SceneEvent) => void, s: AbortSignal) => {
      signal = s;
      return new Promise<void>(() => {});
    };
    const leave = joinLiveBuild("base-0xidle", run, recorder().listener);
    leave();
    vi.advanceTimersByTime(5_000);
    // A quick reload re-attaches before the grace period ends.
    const leaveAgain = joinLiveBuild("base-0xidle", run, recorder().listener);
    vi.advanceTimersByTime(20_000);
    expect(signal!.aborted).toBe(false);
    leaveAgain();
    vi.advanceTimersByTime(20_000);
    expect(signal!.aborted).toBe(true);
  });

  it("reports unexpected failures as an error event", async () => {
    const r = recorder();
    joinLiveBuild("base-0xboom", () => Promise.reject(new Error("boom")), r.listener);
    await vi.waitFor(() => expect(r.ended()).toBe(1));
    expect(r.events).toEqual([{ type: "error", message: "boom", retryable: true }]);
  });
});

describe("lenient schemas", () => {
  it("treats an array where an object belongs as an empty object", () => {
    const parsed = TokenInformationResponse.safeParse({ data: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.data.token_details.circulating_supply).toBeNull();
    expect(TokenInformationResponse.safeParse({ data: { token_details: [1, 2] } }).success).toBe(true);
  });
});
