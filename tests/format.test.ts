import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatMs,
  formatMultiple,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatUsdCompact,
} from "@/lib/format";

describe("formatPrice", () => {
  it("uses subscript zeros for memecoin prices", () => {
    expect(formatPrice(0.00001234)).toBe("$0.0₄1234");
    expect(formatPrice(0.000000000512)).toBe("$0.0₉512");
    expect(formatPrice(0.0000123456)).toBe("$0.0₄1235");
  });

  it("keeps small and mid prices at four significant digits", () => {
    expect(formatPrice(0.0421)).toBe("$0.0421");
    expect(formatPrice(0.001234)).toBe("$0.001234");
    expect(formatPrice(0.0001)).toBe("$0.0001");
    expect(formatPrice(0.000099999)).toBe("$0.0001");
    expect(formatPrice(0.5)).toBe("$0.50");
    expect(formatPrice(3.42123)).toBe("$3.421");
    expect(formatPrice(12.3456)).toBe("$12.35");
  });

  it("groups large prices", () => {
    expect(formatPrice(1234.5)).toBe("$1,234.50");
    expect(formatPrice(112_345.67)).toBe("$112,346");
  });

  it("handles zero and missing values", () => {
    expect(formatPrice(0)).toBe("$0");
    expect(formatPrice(null)).toBe("n/a");
    expect(formatPrice(Number.NaN)).toBe("n/a");
  });
});

describe("compact numbers", () => {
  it("formats USD", () => {
    expect(formatUsdCompact(9_412_000)).toBe("$9.4M");
    expect(formatUsdCompact(42_100_000)).toBe("$42M");
    expect(formatUsdCompact(1_900_000)).toBe("$1.9M");
    expect(formatUsdCompact(420_000)).toBe("$420K");
    expect(formatUsdCompact(1_200_000_000)).toBe("$1.2B");
    expect(formatUsdCompact(999_700)).toBe("$1M");
    expect(formatUsdCompact(950)).toBe("$950");
    expect(formatUsdCompact(-96_000)).toBe("−$96K");
    expect(formatUsdCompact(undefined)).toBe("n/a");
  });

  it("formats token amounts", () => {
    expect(formatAmount(9_400_000)).toBe("9.4M");
    expect(formatAmount(2_000_000)).toBe("2M");
    expect(formatAmount(3.2e12)).toBe("3.2T");
    expect(formatAmount(12.5)).toBe("12.5");
    expect(formatAmount(0.42)).toBe("0.42");
    expect(formatAmount(0)).toBe("0");
  });
});

describe("percentages and multiples", () => {
  it("formats plain percentages", () => {
    expect(formatPct(0.417)).toBe("41.7%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct(0.12, 0)).toBe("12%");
    expect(formatPct(-0.05)).toBe("−5.0%");
  });

  it("formats signed moves with a true minus sign", () => {
    expect(formatSignedPct(0.22)).toBe("+22%");
    expect(formatSignedPct(-0.2)).toBe("−20%");
    expect(formatSignedPct(0.034)).toBe("+3.4%");
    expect(formatSignedPct(0.0996)).toBe("+10%");
    expect(formatSignedPct(0)).toBe("0.0%");
    expect(formatSignedPct(-0.4567, 1)).toBe("−45.7%");
  });

  it("formats profit multiples", () => {
    expect(formatMultiple(3.2)).toBe("3.2×");
    expect(formatMultiple(0.58)).toBe("0.58×");
    expect(formatMultiple(140.2)).toBe("140×");
    expect(formatMultiple(0.004)).toBe("<0.01×");
    expect(formatMultiple(null)).toBe("n/a");
  });
});

describe("formatMs", () => {
  it("formats latencies and durations", () => {
    expect(formatMs(184)).toBe("184ms");
    expect(formatMs(1234)).toBe("1.2s");
    expect(formatMs(65_000)).toBe("1m 05s");
    expect(formatMs(-1)).toBe("n/a");
  });
});
