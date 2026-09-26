// Recording mode (?rec=1): the query parser, the 60 s script built from the real gallery scans, the
// captions, the per-frame view and the page clock used to speed the room up.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildScript,
  CAPTION_FADE,
  directorView,
  findingCaption,
  parseDirectorParams,
  pickSecond,
  REC,
  repoLabel,
  REPO_FALLBACK,
  sameView,
  sparkOf,
  TimeWarp,
  window01,
  type DirectorScript,
} from "@/components/exposure/DirectorScript";
import { IMPRESSION_SPEED_MS, LINE_END_AFTER_BELL_MS, LINE_END_CARET_MS, typingDuration } from "@/lib/exposure/typewriter";
import { reportLines } from "@/lib/xray/copy";
import type { GalleryEntry, Scan } from "@/lib/xray/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EM_DASH = String.fromCodePoint(0x2014);

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as T;
}

const gallery = readJson<GalleryEntry[]>("public/scans/index.json");
const scanOf = (e: GalleryEntry) => readJson<Scan>(`public/scans/${e.file}`);
const A = scanOf(gallery[0]);
const bIndex = pickSecond(gallery, { chain: A.meta.chain, tokenAddress: A.meta.tokenAddress, code: A.diagnosis.code });
const B = scanOf(gallery[bIndex]);
const script = buildScript(A, B);

/* ------------------------------------------------------------------ query */

describe("parseDirectorParams", () => {
  it("is off without ?rec or ?director (no effect on the room)", () => {
    expect(parseDirectorParams({})).toBeNull();
    expect(parseDirectorParams(null)).toBeNull();
    expect(parseDirectorParams({ speed: "2", autostart: "1" })).toBeNull();
    expect(parseDirectorParams({ rec: "0" })).toBeNull();
    expect(parseDirectorParams({ rec: "false" })).toBeNull();
  });

  it("turns on with ?rec=1, ?rec, ?director=1", () => {
    expect(parseDirectorParams({ rec: "1" })).toEqual({ speed: 1, autostart: false, repo: REPO_FALLBACK });
    expect(parseDirectorParams({ rec: "" })).not.toBeNull();
    expect(parseDirectorParams({ director: "1" })).not.toBeNull();
    expect(parseDirectorParams({ rec: ["1", "0"] })).not.toBeNull();
  });

  it("reads speed (clamped) and autostart", () => {
    expect(parseDirectorParams({ rec: "1", speed: "2" })?.speed).toBe(2);
    expect(parseDirectorParams({ rec: "1", speed: "0.5" })?.speed).toBe(0.5);
    expect(parseDirectorParams({ rec: "1", speed: "100" })?.speed).toBe(8);
    expect(parseDirectorParams({ rec: "1", speed: "0.01" })?.speed).toBe(0.25);
    expect(parseDirectorParams({ rec: "1", speed: "fast" })?.speed).toBe(1);
    expect(parseDirectorParams({ rec: "1", speed: "-3" })?.speed).toBe(1);
    expect(parseDirectorParams({ rec: "1", autostart: "1" })?.autostart).toBe(true);
    expect(parseDirectorParams({ rec: "1", autostart: "0" })?.autostart).toBe(false);
  });

  it("prints the repository without scheme, www or .git", () => {
    expect(parseDirectorParams({ rec: "1" }, "https://github.com/someone/exposure")?.repo).toBe("github.com/someone/exposure");
    expect(repoLabel("https://www.github.com/someone/exposure.git/")).toBe("github.com/someone/exposure");
    expect(repoLabel("git@github.com:someone/exposure.git")).toBe("github.com/someone/exposure");
    expect(repoLabel("")).toBe(REPO_FALLBACK);
    expect(repoLabel(undefined)).toBe(REPO_FALLBACK);
    expect(REPO_FALLBACK).toBe("github.com/0xkuzeydurden/exposure");
  });
});

/* ------------------------------------------------------------------ cast */

describe("cast", () => {
  it("features the first gallery patient and picks a second one with a different diagnosis", () => {
    expect(bIndex).toBeGreaterThan(0);
    expect(B.diagnosis.code).not.toBe(A.diagnosis.code);
    expect(B.synthetic).not.toBe(true);
  });

  it("the current gallery gives GSTOCK, then FP", () => {
    expect(A.meta.symbol).toBe("GSTOCK");
    expect(B.meta.symbol).toBe("FP");
  });

  it("falls back to any other patient, and to none", () => {
    const one = { chain: "bnb", tokenAddress: "0xA", code: "normal" };
    const two = { chain: "base", tokenAddress: "0xB", code: "normal" };
    expect(pickSecond([one, two], one)).toBe(1);
    expect(pickSecond([one], one)).toBe(-1);
    expect(pickSecond([{ ...two, synthetic: true }, one], one)).toBe(-1);
  });
});

/* ------------------------------------------------------------------ script */

describe("buildScript", () => {
  it("runs 60 s with cues in time order, all inside the script", () => {
    expect(script.duration).toBe(60);
    const at = script.cues.map((c) => c.at);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    for (const t of at) expect(t >= 0 && t <= script.duration).toBe(true);
  });

  it("follows the storyboard", () => {
    const find = (pred: (c: DirectorScript["cues"][number]) => boolean) => script.cues.find(pred)?.at;
    expect(find((c) => c.action.type === "expose" && c.action.patient === "a")).toBe(4);
    const focusA = script.cues.filter((c) => c.action.type === "focus" && c.at < 30).map((c) => c.at);
    expect(focusA[0]).toBe(12);
    expect(focusA).toHaveLength(5);
    const lab = script.cues.filter((c) => c.action.type === "lab");
    expect(lab.map((c) => (c.action.type === "lab" ? c.action.tab : null))).toEqual(["summary", 1, 3, "evidence"]);
    expect(lab[0].at).toBe(30);
    for (let i = 1; i < lab.length; i++) {
      const gap = lab[i].at - lab[i - 1].at;
      expect(gap >= 3 && gap <= 4).toBe(true);
    }
    expect(find((c) => c.action.type === "closeLab")).toBe(42);
    const exposeB = find((c) => c.action.type === "expose" && c.action.patient === "b")!;
    expect(exposeB > 42 && exposeB < 45).toBe(true);
    // Patient B is sped up, and the tempo returns to 1 for the end card.
    const tempo = script.cues.filter((c) => c.action.type === "tempo");
    expect(tempo[0].at).toBeLessThanOrEqual(exposeB);
    expect(tempo[0].action).toEqual({ type: "tempo", rate: REC.bRate });
    expect(REC.bRate).toBeGreaterThan(1);
    expect(tempo.at(-1)).toEqual({ at: REC.endCard, action: { type: "tempo", rate: 1 } });
  });

  it("captions never overlap and each one is on screen long enough to read", () => {
    const c = script.captions;
    for (let i = 0; i < c.length; i++) {
      expect(c[i].to - c[i].from).toBeGreaterThanOrEqual(2.5);
      if (i > 0) expect(c[i].from).toBeGreaterThanOrEqual(c[i - 1].to);
      expect(c[i].to).toBeLessThanOrEqual(REC.endCard);
    }
  });

  it("carries the storyboard's lines and the scans' numbers", () => {
    const texts = script.captions.map((c) => c.text);
    expect(texts).toContain("EXPOSURE shows who's behind it.");
    expect(texts).toContain("Every number is a Nansen API call.");
    expect(texts).toContain(A.diagnosis.sentence);
    expect(texts).toContain(B.diagnosis.sentence);
    expect(texts.some((t) => t.includes("$FP"))).toBe(true);
    const evidence = script.captions.find((c) => c.text === "Every number is a Nansen API call.");
    expect(evidence?.tag).toBe(`EVIDENCE · ${A.totals.calls} CALLS`);
    const tags = script.captions.map((c) => c.tag ?? "");
    for (const t of ["1 · REAL BUYERS", "2 · FLOW", "3 · SELL WALL", "4 · SMART MONEY"]) expect(tags).toContain(t);
  });

  it("centres the lab captions beside the drawer, and only those", () => {
    const beside = script.captions.filter((c) => c.beside === "lab");
    expect(beside.map((c) => c.id)).toEqual(["lab-summary", "lab-1", "lab-3", "lab-evidence"]);
    for (const c of beside) expect(c.from >= REC.labFrom && c.to <= REC.labClose).toBe(true);
    expect(directorView(script, 34).caption?.beside).toBe("lab");
    expect(directorView(script, 20).caption?.beside).toBeUndefined();
  });

  it("follows patient B: name, its flow, then its diagnosis before the end card", () => {
    const ids = script.captions.filter((c) => c.from >= REC.labClose).map((c) => c.id);
    expect(ids).toEqual(["next", "flow-b", "diagnosis-b"]);
    expect(script.captions.find((c) => c.id === "flow-b")?.text).toBe(findingCaption(2, B));
    const focusB = script.cues.filter((c) => c.action.type === "focus" && c.at > REC.exposeB);
    expect(focusB.map((c) => (c.action.type === "focus" ? c.action.n : 0))).toEqual([2, null]);
  });

  it("builds a script without a second patient", () => {
    const solo = buildScript(A, null);
    expect(solo.hasB).toBe(false);
    expect(solo.cues.some((c) => c.action.type === "expose" && c.action.patient === "b")).toBe(false);
    expect(solo.cues.some((c) => c.action.type === "pick")).toBe(false);
  });

  it("never prints an em dash", () => {
    for (const s of [buildScript(A, B), ...gallery.map((e) => buildScript(scanOf(e), B))]) {
      for (const c of s.captions) {
        expect(c.text.includes(EM_DASH)).toBe(false);
        expect((c.tag ?? "").includes(EM_DASH)).toBe(false);
      }
    }
  });
});

describe("findingCaption", () => {
  it("phrases GSTOCK's findings in plain words with its numbers", () => {
    expect(findingCaption(1, A)).toBe("The top 90 buyers came from 88 different funders.");
    expect(findingCaption(2, A)).toBe("Smart money and whales sold $289K this week. New wallets bought $29M.");
    expect(findingCaption(3, A)).toBe("Sellers wait at $0.025: 16M tokens break even 2.7% above today.");
    expect(findingCaption(4, A)).toBe("Smart money got in at $0.0078 and is up 209%.");
  });

  it("stays short for every recorded scan", () => {
    for (const e of gallery) {
      const s = scanOf(e);
      for (const n of [1, 2, 3, 4] as const) {
        const line = findingCaption(n, s);
        expect(line.length).toBeGreaterThan(10);
        expect(line.length).toBeLessThanOrEqual(80);
        expect(line).not.toMatch(/n\/a|NaN|undefined/);
      }
    }
  });

  it("names a funding cluster when one wallet funded several top buyers", () => {
    const clustered = { ...A.findings, buyers: { ...A.findings.buyers, biggestSourceWallets: 12 } };
    expect(findingCaption(1, { findings: clustered })).toBe("12 of the top 90 buyers were funded by one wallet.");
  });
});

/* ------------------------------------------------------------------ timing budget */

/**
 * Seconds from an exposure to the report's stamp at tempo 1 (Room + Report): overlay 3.41 s, beam
 * 2.4 s, fade 0.26 s, merge 0.8 s; per line 220 ms + typing + caret and bell; the impression; the stamp.
 * `slack` stretches the typing for timer clamping and per-character renders in a real browser.
 */
function stampAfter(scan: Scan, slack = 1.3): number {
  let ms = 3410 + 40 + 2400 + 260 + 800;
  for (const l of reportLines(scan.findings, null)) {
    ms += 220 + typingDuration(`${l.n}. ${l.title}: ${l.text}`) * slack + LINE_END_CARET_MS + LINE_END_AFTER_BELL_MS;
  }
  return (ms + 250 + typingDuration(scan.diagnosis.sentence, IMPRESSION_SPEED_MS) * slack + 460) / 1000;
}

describe("timing budget", () => {
  it("stamps A's report before its diagnosis caption and before the lab opens", () => {
    const dx = script.captions.find((c) => c.id === "diagnosis-a")!;
    expect(REC.exposeA + stampAfter(A)).toBeLessThan(dx.from + 1);
    expect(REC.exposeA + stampAfter(A)).toBeLessThan(REC.labFrom - 2);
  });

  it("stamps B's report (sped up) before the end card", () => {
    expect(REC.exposeB + stampAfter(B) / REC.bRate).toBeLessThan(REC.endCard - 1);
  });

  it("holds for every gallery patient as the second one", () => {
    for (const e of gallery) expect(REC.exposeB + stampAfter(scanOf(e)) / REC.bRate).toBeLessThan(REC.endCard - 0.5);
  });
});

/* ------------------------------------------------------------------ view */

describe("directorView", () => {
  it("opens on the dark room before the start and during the title", () => {
    const v0 = directorView(script, 0);
    expect(v0.title?.bg).toBe(1);
    expect(v0.title?.text).toBe(0);
    expect(v0.caption).toBeNull();
    expect(directorView(script, 2).title?.text).toBe(1);
    expect(directorView(script, REC.titleEnd + 0.01).title).toBeNull();
  });

  it("shows exactly the caption of the moment, fading in and out", () => {
    const behind = script.captions.find((c) => c.id === "behind")!;
    expect(directorView(script, behind.from + 1).caption?.text).toBe("EXPOSURE shows who's behind it.");
    expect(directorView(script, behind.from + 1).caption?.opacity).toBe(1);
    const mid = directorView(script, behind.from + CAPTION_FADE / 2).caption?.opacity ?? 0;
    expect(mid > 0 && mid < 1).toBe(true);
    expect(directorView(script, 4.8).caption).toBeNull();
    expect(directorView(script, 13).caption?.tag).toBe("1 · REAL BUYERS");
    expect(directorView(script, 40).caption?.text).toBe("Every number is a Nansen API call.");
  });

  it("rings patient B's card before the second exposure", () => {
    expect(directorView(script, REC.pick - 0.1).ring).toBeNull();
    expect(directorView(script, REC.pick + 0.6).ring?.opacity).toBe(1);
    expect(directorView(buildScript(A, null), REC.pick + 0.6).ring).toBeNull();
  });

  it("ends on the end card, which stays", () => {
    expect(directorView(script, REC.endCard - 0.1).end).toBeNull();
    const end = directorView(script, 59).end!;
    expect(end.bg).toBe(1);
    expect(end.lines).toEqual([1, 1, 1, 1]);
    expect(directorView(script, 600).end?.bg).toBe(1);
  });

  it("is deterministic and only changes when something visible changes", () => {
    expect(sameView(directorView(script, 20.5), directorView(script, 20.5))).toBe(true);
    expect(sameView(directorView(script, 20.5), directorView(script, 20.51))).toBe(true);
    expect(sameView(directorView(script, 12), directorView(script, 16))).toBe(false);
  });

  it("window01 is 0 outside, 1 inside", () => {
    expect(window01(0.9, 1, 3)).toBe(0);
    expect(window01(2, 1, 3)).toBe(1);
    expect(window01(3.1, 1, 3)).toBe(0);
  });
});

describe("sparkOf", () => {
  it("normalises the price to 0..1", () => {
    const s = sparkOf(A.price);
    expect(s.length).toBeGreaterThan(20);
    expect(Math.min(...s)).toBe(0);
    expect(Math.max(...s)).toBe(1);
    expect(sparkOf([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ page clock */

describe("TimeWarp", () => {
  it("is the identity at rate 1", () => {
    const w = new TimeWarp(1000);
    expect(w.map(1000)).toBe(1000);
    expect(w.map(1500)).toBe(1500);
    expect(w.delay(300)).toBe(300);
  });

  it("runs faster at a higher rate and stays continuous when the rate changes", () => {
    const w = new TimeWarp(0, 2);
    expect(w.map(100)).toBe(200);
    expect(w.delay(300)).toBe(150);
    w.setRate(1, 100);
    expect(w.map(100)).toBe(200);
    expect(w.map(150)).toBe(250);
    w.setRate(4, 150);
    expect(w.map(150)).toBe(250);
    expect(w.map(160)).toBe(290);
    expect(w.delay(400)).toBe(100);
  });

  it("ignores invalid rates and delays", () => {
    const w = new TimeWarp(0, 0);
    expect(w.rate).toBe(1);
    w.setRate(-1, 10);
    w.setRate(Number.NaN, 10);
    expect(w.rate).toBe(1);
    expect(w.delay(-5)).toBe(0);
    expect(w.delay(Number.NaN)).toBe(0);
  });
});
