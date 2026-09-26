// Project rule: the em dash (U+2014) never appears in copy, titles, comments or placeholders.
// Use "·", ":", ",", parentheses or a plain hyphen instead, and "n/a" for empty cells.
// The character is built from its code point so this file never contains it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EM_DASH = String.fromCodePoint(0x2014);

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories walked recursively, and single files, relative to the project root. */
const DIRS = ["app", "components", "lib", "hooks", "scripts", "tests", "public/scans"];
const FILES = ["README.md", ".env.example"];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".cache", ".ledger"]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|webm|ogg|pdf|zip|gz)$/i;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && !BINARY.test(entry.name)) {
      out.push(full);
    }
  }
}

function filesToCheck(): string[] {
  const out: string[] = [];
  for (const d of DIRS) {
    const full = path.join(ROOT, d);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, out);
  }
  for (const f of FILES) {
    const full = path.join(ROOT, f);
    if (existsSync(full) && statSync(full).isFile()) out.push(full);
  }
  return out.sort();
}

/** "path/to/file.ts:12" for every line holding the character (binary files with a NUL byte are skipped). */
function offenders(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    if (!text.includes(EM_DASH)) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes(EM_DASH)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

describe("no em dash (U+2014) in the project", () => {
  it("walks a non-empty set of files", () => {
    expect(filesToCheck().length).toBeGreaterThan(10);
  });

  it("finds none in app, components, lib, hooks, scripts, tests, public/scans, README.md, .env.example", () => {
    const hits = offenders(filesToCheck());
    expect(hits, `U+2014 found (use "·", ":", ",", parentheses, a hyphen or "n/a"):\n${hits.join("\n")}`).toEqual([]);
  });
});
