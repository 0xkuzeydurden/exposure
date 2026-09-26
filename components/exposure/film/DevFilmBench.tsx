"use client";
// DEV ONLY: /dev/film test bench for the x-ray film and the exposure transition on synthetic data.
// Never linked from the app; the route 404s in production builds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Film from "../Film";
import { ExposureOverlay, useExposure } from "../ExposureOverlay";
import { loadGallery, loadScan, scanFileUrl } from "../WaitingRoom";
import { makeSyntheticScan } from "@/lib/xray/fixtures";
import { sound, useSoundEnabled } from "@/lib/exposure/sound";
import { ease } from "@/lib/exposure/filmScale";
import type { Scan, WalletCheck } from "@/lib/xray/types";

type Key = "buyers" | "flow" | "walls" | "smart";
type FocusN = 1 | 2 | 3 | 4 | 5 | null;

function load(seed: number): { scan: Scan | null; error: string | null } {
  try {
    return { scan: makeSyntheticScan(seed), error: null };
  } catch (e) {
    return { scan: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tween(ms: number, fn: (k: number) => void, curve: (t: number) => number, alive: () => boolean) {
  const t0 = performance.now();
  for (;;) {
    const now = await frame();
    if (!alive()) return;
    const t = Math.min(1, (now - t0) / ms);
    fn(curve(t));
    if (t >= 1) return;
  }
}

/**
 * ?p=GSTOCK (a recorded patient's symbol, or its file name) loads that scan instead of the synthetic
 * one; ?bare=1 shows the film alone at the full page width (set the viewport to the film's real size
 * in the room, e.g. 827x473 at 1440x900 or 940x537 at 1920x1080, to judge legibility); &you=1 adds a
 * wallet whose entry is 10% above today's price (marker 5).
 */
interface BenchParams {
  patient: string | null;
  bare: boolean;
  you: boolean;
  /** Bare-mode animation state (&reveal=0.5&merge=0&markers=3&focus=3), for checking in-between frames. */
  reveal: number;
  merge: number;
  markers: number;
  focus: FocusN;
}

function useBenchParams(): BenchParams {
  const [p, setP] = useState<BenchParams>({
    patient: null,
    bare: false,
    you: false,
    reveal: 1,
    merge: 1,
    markers: 5,
    focus: null,
  });
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
    const f = num("focus", 0);
    // Read once after mount (the bench is client-only; no hydration mismatch on the first render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setP({
      patient: q.get("p"),
      bare: q.get("bare") === "1",
      you: q.get("you") === "1",
      reveal: num("reveal", 1),
      merge: num("merge", 1),
      markers: num("markers", 5),
      focus: f >= 1 && f <= 5 ? (f as FocusN) : null,
    });
  }, []);
  return p;
}

function useRecorded(patient: string | null): Scan | null {
  const [scan, setScan] = useState<Scan | null>(null);
  useEffect(() => {
    if (!patient) return;
    const ac = new AbortController();
    (async () => {
      const list = await loadGallery(ac.signal);
      const key = patient.toLowerCase();
      const hit = list.find((e) => (e.symbol || "").toLowerCase() === key || e.file?.toLowerCase().startsWith(key));
      const url = hit ? hit.url : key === "synthetic" ? "/scans/_synthetic.json" : scanFileUrl(patient);
      const s = await loadScan(url, ac.signal);
      if (!ac.signal.aborted) setScan(s);
    })().catch(() => {});
    return () => ac.abort();
  }, [patient]);
  return scan;
}

export default function DevFilmBench() {
  const [seed, setSeed] = useState(7);
  const params = useBenchParams();
  const recorded = useRecorded(params.patient);
  const synthetic = useMemo(() => load(seed), [seed]);
  const { scan, error } = recorded ? { scan: recorded, error: null } : synthetic;
  const [reveal, setReveal] = useState(1);
  const [merge, setMerge] = useState(1);
  const [markers, setMarkers] = useState(5);
  const [focus, setFocus] = useState<FocusN>(null);
  const [beam, setBeam] = useState(false);
  const [withYou, setWithYou] = useState(true);
  const [drop, setDrop] = useState<Record<Key, boolean>>({ buyers: false, flow: false, walls: false, smart: false });
  const [clicked, setClicked] = useState<string>("");
  const [soundOn, setSoundOn] = useSoundEnabled();

  const room = useRef<HTMLDivElement>(null);
  const { ref: exposureRef, run: runExposure, running: exposing } = useExposure();
  const runId = useRef(0);

  const f = scan?.findings;
  const findings = useMemo(() => {
    if (!f) return null;
    const off = <T extends { status: string }>(k: Key, v: T): T => (drop[k] ? { ...v, status: "unavailable" } : v);
    return {
      buyers: off("buyers", f.buyers),
      flow: off("flow", f.flow),
      walls: off("walls", f.walls),
      smart: off("smart", f.smart),
    };
  }, [f, drop]);

  const you = useMemo<WalletCheck | null>(() => {
    if (!scan || !withYou) return null;
    const cost = scan.meta.priceNow * 1.1;
    return {
      status: "ok",
      address: "0x0000000000000000000000000000000000000dev",
      short: "0x0000…0dev",
      cost,
      pnlPct: scan.meta.priceNow / cost - 1,
      vsSmartMoneyPct: scan.findings.smart.avgEntry ? cost / scan.findings.smart.avgEntry - 1 : null,
      cheaperShare: 0.7,
      holdingTokens: 1e5,
    };
  }, [scan, withYou]);

  const play = useCallback(async () => {
    sound.unlock();
    const id = ++runId.current;
    const alive = () => runId.current === id;
    await runExposure(() => {
      setReveal(0);
      setMerge(0);
      setMarkers(0);
      setFocus(null);
      setSeed((s) => s + 1);
    });
    if (!alive()) return;
    // 3. the beam reads the film
    setBeam(true);
    await tween(2400, setReveal, ease.inOutCubic, alive);
    setBeam(false);
    await sleep(260);
    await tween(800, setMerge, ease.linear, alive);
    // 4. each finding: the marker pulses with a monitor beep while its report line "types"
    for (let n = 1; n <= 5 && alive(); n++) {
      setMarkers(n);
      sound.beep();
      await sleep(220);
      for (const ch of "The top 80 buyers trace back to 23 funding sources.") {
        if (!alive()) return;
        sound.key(ch);
        await sleep(ch === "." ? 65 : 13);
      }
      sound.ding();
      await sleep(300);
    }
    if (alive()) sound.stamp();
  }, [runExposure]);

  if (params.bare) {
    return (
      // The spacer keeps the page's fixed corner badges off the film in screenshots.
      <div className="min-h-screen bg-[#070b10] pb-[80px]">
        <Film
          meta={scan?.meta ?? null}
          price={scan?.price ?? []}
          bigBuys={scan?.bigBuys ?? []}
          buyers={findings?.buyers ?? null}
          flow={findings?.flow ?? null}
          walls={findings?.walls ?? null}
          smart={findings?.smart ?? null}
          you={params.you ? you : null}
          reveal={params.reveal}
          beam={params.reveal < 1}
          merge={params.merge}
          markers={params.markers}
          focus={params.focus}
        />
      </div>
    );
  }

  const row = "flex flex-wrap items-center gap-x-5 gap-y-2";
  const lab = "flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8a9aa8]";

  return (
    <div className="relative min-h-screen bg-[#05080b] p-4 font-mono text-[#e9f2f9]">
      <div ref={room} className="mx-auto grid max-w-[1200px] gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 border-t-[3px] border-[#2d6a8a] bg-[#0e151c] px-4 py-2.5">
          <b className="tracking-[0.24em]">EXPOSURE · FILM BENCH</b>
          <span className="text-[11px] tracking-[0.1em] text-[#ffb547]">
            DEV ONLY · SYNTHETIC DATA · NOT LINKED FROM THE APP
          </span>
        </header>

        <div
          className="relative border-[8px] border-[#1b232b] px-[22px] pt-6 pb-[18px]"
          style={{ background: "radial-gradient(ellipse at 50% 45%, #1a2733 0%, #0e1720 58%, #0a1016 100%)" }}
        >
          {error ? (
            <p className="p-8 text-sm text-[#ff8a73]">
              makeSyntheticScan() failed: {error}. The film renders empty below until lib/xray/fixtures.ts is
              implemented.
            </p>
          ) : null}
          <Film
            meta={scan?.meta ?? null}
            price={scan?.price ?? []}
            bigBuys={scan?.bigBuys ?? []}
            buyers={findings?.buyers ?? null}
            flow={findings?.flow ?? null}
            walls={findings?.walls ?? null}
            smart={findings?.smart ?? null}
            you={you}
            reveal={reveal}
            beam={beam}
            merge={merge}
            markers={markers}
            focus={focus}
            onMarkerClick={(n) => setClicked(`marker ${n} clicked`)}
          />
        </div>

        <section className="grid gap-3 border border-[#22303c] bg-[#0e151c] p-4 text-xs">
          <div className={row}>
            <button
              type="button"
              onClick={play}
              className="border border-[#2a3947] bg-[#16212b] px-3 py-2 uppercase tracking-[0.12em] hover:border-[#ffb547] hover:text-[#ffb547]"
            >
              Take the x-ray (next seed)
            </button>
            <button
              type="button"
              onClick={() => setSoundOn(!soundOn)}
              aria-pressed={soundOn}
              className="border border-[#2a3947] bg-[#16212b] px-3 py-2 uppercase tracking-[0.12em] hover:border-[#ffb547]"
            >
              {soundOn ? "Sound on" : "Sound off"}
            </button>
            <span className="text-[#5d6c78]">
              seed {seed} {exposing ? "· exposing…" : ""} {clicked && `· ${clicked}`}
            </span>
          </div>
          <div className={row}>
            <label className={lab}>
              reveal
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={reveal}
                onChange={(e) => setReveal(+e.target.value)}
              />
            </label>
            <label className={lab}>
              merge
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={merge}
                onChange={(e) => setMerge(+e.target.value)}
              />
            </label>
            <label className={lab}>
              markers {markers}
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={markers}
                onChange={(e) => setMarkers(+e.target.value)}
              />
            </label>
            <label className={lab}>
              focus
              <select
                className="bg-[#16212b] p-1"
                value={focus ?? ""}
                onChange={(e) => setFocus(e.target.value ? (Number(e.target.value) as FocusN) : null)}
              >
                <option value="">none</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className={lab}>
              <input type="checkbox" checked={beam} onChange={(e) => setBeam(e.target.checked)} /> beam
            </label>
            <label className={lab}>
              <input type="checkbox" checked={withYou} onChange={(e) => setWithYou(e.target.checked)} /> you
            </label>
          </div>
          <div className={row}>
            <span className={lab}>mark unavailable:</span>
            {(["buyers", "flow", "walls", "smart"] as Key[]).map((k) => (
              <label key={k} className={lab}>
                <input
                  type="checkbox"
                  checked={drop[k]}
                  onChange={(e) => setDrop((d) => ({ ...d, [k]: e.target.checked }))}
                />{" "}
                {k}
              </label>
            ))}
            <label className={lab}>
              seed
              <input
                type="number"
                className="w-20 bg-[#16212b] p-1"
                value={seed}
                onChange={(e) => setSeed(Math.max(1, Math.floor(+e.target.value) || 1))}
              />
            </label>
          </div>
        </section>
      </div>
      <ExposureOverlay ref={exposureRef} target={room} />
    </div>
  );
}
