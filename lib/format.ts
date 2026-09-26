// Display formatting shared by the HUD, the call rail and the share card. Pure, locale-independent.

const NA = "n/a"; // missing / non-finite values
const MINUS = "−"; // true minus sign, not a hyphen
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

type Num = number | null | undefined;

function isNum(v: Num): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
}

function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed decimals with thousands separators, e.g. 12345.678 -> "12,345.68". */
function fixedGrouped(v: number, digits: number): string {
  const [i, f] = v.toFixed(digits).split(".");
  return f ? `${group(i)}.${f}` : group(i);
}

function trimZeros(digits: string): string {
  return digits.replace(/0+$/, "") || "0";
}

/**
 * Token price in USD.
 *   1234.5      -> "$1,234.50" (>= $1,000 drops cents above $100k)
 *   3.4212      -> "$3.421"
 *   0.0421      -> "$0.0421"
 *   0.001234    -> "$0.001234"
 *   0.00001234  -> "$0.0₄1234"   (subscript = number of zeros after the decimal point)
 */
export function formatPrice(price: Num): string {
  if (!isNum(price)) return NA;
  if (price === 0) return "$0";
  const sign = price < 0 ? MINUS : "";
  const p = Math.abs(price);

  if (p >= 100_000) return `${sign}$${fixedGrouped(p, 0)}`;
  if (p >= 100) return `${sign}$${fixedGrouped(p, 2)}`;

  // Four significant digits, resolved through toExponential so rounding carries correctly
  // (0.000099999 -> 1.000e-4).
  const [mant, expStr] = p.toExponential(3).split("e");
  const exp = Number(expStr);
  if (exp >= 0) {
    const decimals = Math.max(2, 3 - exp);
    return `${sign}$${fixedGrouped(Number(p.toPrecision(4)), decimals)}`;
  }
  const digits = trimZeros(mant.replace(".", ""));
  const zeros = -exp - 1;
  if (zeros >= 4) return `${sign}$0.0${subscript(zeros)}${digits}`;
  const frac = "0".repeat(zeros) + digits;
  return `${sign}$0.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}

const UNITS = [
  { v: 1e12, s: "T" },
  { v: 1e9, s: "B" },
  { v: 1e6, s: "M" },
  { v: 1e3, s: "K" },
];

/** Compact magnitude: 9_412_000 -> "9.4M", 42_100_000 -> "42M", 950 -> "950", 0.42 -> "0.42". */
function compact(v: number): string {
  const a = Math.abs(v);
  for (let i = 0; i < UNITS.length; i++) {
    const u = UNITS[i];
    if (a < u.v * 0.9995) continue;
    let x = a / u.v;
    let decimals = x < 10 ? 1 : 0;
    let r = Number(x.toFixed(decimals));
    // Rounding may carry into the next unit (999.6K -> 1M).
    if (r >= 1000 && i > 0) {
      const up = UNITS[i - 1];
      x = a / up.v;
      decimals = 1;
      r = Number(x.toFixed(decimals));
      return `${stripDotZero(r.toFixed(decimals))}${up.s}`;
    }
    return `${stripDotZero(r.toFixed(decimals))}${u.s}`;
  }
  if (a >= 100) return a.toFixed(0);
  if (a >= 1) return stripDotZero(a.toFixed(1));
  if (a === 0) return "0";
  return trimFraction(a.toPrecision(2));
}

function stripDotZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function trimFraction(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Compact USD: $9.4M, $420K, $1.2B, −$96K. */
export function formatUsdCompact(usd: Num): string {
  if (!isNum(usd)) return NA;
  return `${usd < 0 ? MINUS : ""}$${compact(usd)}`;
}

/** Compact token amount (caller appends the unit): 9_400_000 -> "9.4M". */
export function formatAmount(amount: Num): string {
  if (!isNum(amount)) return NA;
  return `${amount < 0 ? MINUS : ""}${compact(amount)}`;
}

/** Fraction as percent: 0.417 -> "41.7%". */
export function formatPct(fraction: Num, digits = 1): string {
  if (!isNum(fraction)) return NA;
  const s = (fraction * 100).toFixed(digits);
  return `${s.startsWith("-") ? MINUS + s.slice(1) : s}%`;
}

/**
 * Signed move: 0.22 -> "+22%", -0.2 -> "−20%", 0.034 -> "+3.4%".
 * Default precision is one decimal below 10%, none above.
 */
export function formatSignedPct(fraction: Num, digits?: number): string {
  if (!isNum(fraction)) return NA;
  const pct = fraction * 100;
  const d = digits ?? (Math.abs(pct) < 9.95 ? 1 : 0);
  const body = Math.abs(pct).toFixed(d);
  if (Number(body) === 0) return `${(0).toFixed(d)}%`;
  return `${pct > 0 ? "+" : MINUS}${body}%`;
}

/** Profit multiple: 3.2 -> "3.2×", 0.58 -> "0.58×", 140 -> "140×". */
export function formatMultiple(multiple: Num): string {
  if (!isNum(multiple) || multiple < 0) return NA;
  if (multiple >= 99.5) return `${fixedGrouped(multiple, 0)}×`;
  if (multiple >= 0.995) return `${multiple.toFixed(1)}×`;
  if (multiple < 0.01) return "<0.01×";
  return `${multiple.toFixed(2)}×`;
}

/** Latency / duration: 184 -> "184ms", 1234 -> "1.2s", 65000 -> "1m 05s". */
export function formatMs(ms: Num): string {
  if (!isNum(ms) || ms < 0) return NA;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
