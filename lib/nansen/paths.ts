import path from "node:path";

/** Repo root. Next.js, npm scripts and vitest all run with cwd = repo root; EXPOSURE_ROOT overrides. */
export function projectRoot(): string {
  return process.env.EXPOSURE_ROOT || process.cwd();
}

export function nansenCacheDir(): string {
  return process.env.NANSEN_CACHE_DIR || path.join(projectRoot(), ".cache", "nansen");
}

export function sceneCacheDir(): string {
  return path.join(projectRoot(), ".cache", "scenes");
}

export function ledgerFile(): string {
  return process.env.NANSEN_LEDGER_FILE || path.join(projectRoot(), ".ledger", "calls.ndjson");
}

export function publicScenesDir(): string {
  return path.join(projectRoot(), "public", "scenes");
}
