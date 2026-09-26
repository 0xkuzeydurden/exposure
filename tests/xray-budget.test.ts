// Live-scan budget guard (lib/xray/budget.ts) against a mocked GET /account: no network, no key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accountSnapshot, admitScan, budgetStatus, flushBudget, settleTicket } from "../lib/xray/budget";

const TOKEN = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("budget guard", () => {
  const keys = ["NANSEN_API_KEY", "NANSEN_CACHE", "NANSEN_LEDGER", "EXPOSURE_ROOT", "EXPOSURE_LIVE", "EXPOSURE_CREDIT_FLOOR"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let root = "";
  let accountUp = false;

  const fetchMock = vi.fn(async (url: string | URL) => {
    const endpoint = String(url).replace(/^https?:\/\/[^/]+\/api\/v1\//, "");
    if (endpoint !== "account") throw new Error(`unexpected call to ${endpoint}`);
    if (!accountUp) return new Response(JSON.stringify({ message: "unavailable" }), { status: 400 });
    return new Response(JSON.stringify({ user_id: "u", plan: "pro", credits_remaining: 1500 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "exposure-budget-"));
    process.env.EXPOSURE_ROOT = root;
    process.env.NANSEN_API_KEY = "test-key";
    process.env.NANSEN_CACHE = "off";
    process.env.NANSEN_LEDGER = "off";
    process.env.EXPOSURE_LIVE = "1";
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => {
    await flushBudget();
    vi.unstubAllGlobals();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed while the balance is unknown", async () => {
    const a = await admitScan({ ip: "1.1.1.1", chain: "base", token: TOKEN(1), tier: "quick", estimate: 12 });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("balance_unknown");
    const status = await budgetStatus();
    expect(status.aboveFloor).toBe(false);
    expect(status.liveEnabled).toBe(false);
  });

  it("counts the reservations of scans still running against the floor", async () => {
    accountUp = true;
    expect((await accountSnapshot({ force: true })).creditsRemaining).toBe(1500);
    // 1500 − 12 = 1488 clears a floor of 1480; a second running scan would take it to 1476.
    process.env.EXPOSURE_CREDIT_FLOOR = "1480";
    const first = await admitScan({ ip: "1.1.1.1", chain: "base", token: TOKEN(2), tier: "quick", estimate: 12 });
    expect(first.ok).toBe(true);
    const second = await admitScan({ ip: "2.2.2.2", chain: "base", token: TOKEN(3), tier: "quick", estimate: 12 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("floor");
    expect((await budgetStatus()).aboveFloor).toBe(false);

    // Settled: the reservation no longer weighs on the floor.
    if (first.ok) await settleTicket(first.ticket, 0);
    const third = await admitScan({ ip: "2.2.2.2", chain: "base", token: TOKEN(3), tier: "quick", estimate: 12 });
    expect(third.ok).toBe(true);
    if (third.ok) await settleTicket(third.ticket, 0);
    delete process.env.EXPOSURE_CREDIT_FLOOR;
  });

  it("keeps deep scans inside their own daily cap (plan §8: 50)", async () => {
    const deep = await admitScan({ ip: "3.3.3.3", chain: "base", token: TOKEN(4), tier: "deep", estimate: 46 });
    expect(deep.ok).toBe(true);
    // 46 + 31 fits the daily cap (80) but not the deep cap (50).
    const again = await admitScan({ ip: "3.3.3.4", chain: "solana", token: "So11111111111111111111111111111111111111112", tier: "deep", estimate: 31 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("deep_cap");
    if (deep.ok) await settleTicket(deep.ticket, 40);
    expect((await budgetStatus()).deepLeft).toBe(10);
  });
});
