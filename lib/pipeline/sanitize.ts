// Public scenes carry no wallet addresses: holder tags are dropped and any address-like string
// (other than the token's own address and logo URL) is redacted. Balances are rounded to two
// significant figures so a published column cannot be matched to a wallet by its exact balance.
import type { HolderPoint, Scene } from "../types";

const PUBLIC_PRECISION = 2;

export function roundSignificant(x: number, digits = PUBLIC_PRECISION): number {
  return Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(digits)) : x;
}

function coarsen(h: HolderPoint): HolderPoint {
  const copy: HolderPoint = {
    ...h,
    amount: roundSignificant(h.amount),
    maxHeld: roundSignificant(h.maxHeld),
    supplyShare: roundSignificant(h.supplyShare),
  };
  delete copy.tag;
  return copy;
}

const EVM_RE = /0x[0-9a-fA-F]{40}/g;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function scrub(value: unknown, keep: string): unknown {
  if (typeof value === "string") {
    return value
      .replace(EVM_RE, (m) => (m.toLowerCase() === keep ? m : "[redacted]"))
      .replace(BASE58_RE, (m) => (m.toLowerCase() === keep ? m : "[redacted]"));
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, keep));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, keep);
    return out;
  }
  return value;
}

export function toPublicScene(scene: Scene): Scene {
  const keep = scene.meta.tokenAddress.toLowerCase();
  const holders = scene.holders.map(coarsen);
  const { tokenAddress, logo, ...metaRest } = scene.meta;
  const cleaned = scrub({ ...scene, holders, meta: metaRest }, keep) as Scene;
  return {
    ...cleaned,
    meta: { ...cleaned.meta, tokenAddress, ...(logo ? { logo } : {}) },
  };
}
