// Chains the scan pipeline can run on: the intersection of the chain enums of
// profiler/address/pnl (ProfilerPnLChain) and tgm/holders (TGMHoldersChain) in the OpenAPI spec.

export const SUPPORTED_CHAINS = [
  "arbitrum",
  "arc",
  "avalanche",
  "base",
  "bnb",
  "ethereum",
  "linea",
  "mantle",
  "monad",
  "optimism",
  "plasma",
  "polygon",
  "robinhood",
  "sei",
  "solana",
  "sonic",
  "sui",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

const NON_EVM = new Set<string>(["solana", "sui"]);

export function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain);
}

export function isEvmChain(chain: string): boolean {
  return !NON_EVM.has(chain);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Sui coin types look like 0x…::module::NAME; plain object ids are 0x + 64 hex.
const SUI_ADDRESS = /^0x[0-9a-fA-F]{1,64}(::[A-Za-z0-9_]+::[A-Za-z0-9_]+)?$/;

/** Structural check only: the API is the final judge. */
export function isValidAddress(chain: string, address: string): boolean {
  if (chain === "solana") return SOLANA_ADDRESS.test(address);
  if (chain === "sui") return SUI_ADDRESS.test(address);
  return EVM_ADDRESS.test(address);
}

/** Canonical form used for set membership / comparisons: lowercase on EVM, verbatim elsewhere. */
export function normalizeAddress(chain: string, address: string): string {
  const a = address.trim();
  return isEvmChain(chain) ? a.toLowerCase() : a;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
