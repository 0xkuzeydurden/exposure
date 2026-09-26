"use client";

// Recording mode (?rec=1) overlay: the "Click to start" plate, the title card over the dark room, the
// captions (bottom centre, large, high contrast), the ring on the next patient's card and the end
// card. It also hides the chrome a video should not show (cursor, dev badge, focus rings, scrollbar)
// and blocks stray pointer input while the script runs. Rendered by Room only when ?rec is on.
import { useMemo, useRef } from "react";
import { END_CARD, TITLE_TEXT, type DirectorConfig } from "@/components/exposure/DirectorScript";
import { useDirector, type DirectorRoom } from "@/hooks/useDirector";

export interface DirectorStageProps {
  config: DirectorConfig;
  room: DirectorRoom;
}

/** Always on in recording mode. */
const REC_CSS = `
nextjs-portal{display:none!important}
html{scrollbar-width:none}
html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}
.intake:focus-within{border-color:#22303c}
:focus,:focus-visible{outline:none!important}
.rec-title{position:fixed;inset:0;z-index:55;display:grid;place-items:center;background:rgba(3,5,7,.9);pointer-events:none}
.rec-title svg{position:absolute;left:9vw;top:27vh;width:82vw;height:46vh;overflow:visible}
.rec-title path{fill:none;stroke:rgba(233,242,249,.34);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.rec-title h2{position:relative;margin:0;padding:0 6vw;font:600 max(56px,6.6vh)/1.1 var(--sign);letter-spacing:.005em;color:#f4f8fb;text-align:center;text-shadow:0 2px 30px rgba(0,0,0,.85)}
.rec{--rec-lab-w:min(100vw,clamp(820px,46vw,940px))}
.rec-cap{position:fixed;left:50%;bottom:max(34px,4.4vh);z-index:100;transform:translateX(-50%);width:max-content;max-width:min(1480px,88vw);padding:max(14px,1.4vh) max(30px,2.8vh) max(16px,1.6vh);background:rgba(4,7,10,.93);border:1px solid rgba(233,242,249,.16);border-top:3px solid var(--marker);box-shadow:0 18px 60px rgba(0,0,0,.65);text-align:center;pointer-events:none}
.rec-cap.is-lab{left:calc((100vw - var(--rec-lab-w)) / 2);max-width:calc(100vw - var(--rec-lab-w) - 48px)}
.rec-cap-tag{display:block;margin-bottom:.5em;font:500 max(15px,1.65vh)/1 var(--mono);letter-spacing:.18em;color:var(--marker)}
.rec-cap p{margin:0;font:600 max(30px,3.4vh)/1.22 var(--sign);color:#fff;text-wrap:balance}
.rec-block{position:fixed;inset:0;z-index:99;background:transparent}
.rec-ring{position:fixed;z-index:90;pointer-events:none;border:3px solid var(--marker);box-shadow:0 0 0 6px rgba(255,181,71,.18),0 0 44px rgba(255,181,71,.5);transform-origin:50% 50%}
.rec-end{position:fixed;inset:0;z-index:95;display:grid;place-items:center;background:#05080b;text-align:center;pointer-events:none}
.rec-end-in{display:grid;gap:max(18px,2.2vh);justify-items:center;padding:0 6vw}
.rec-end-brand{margin:0 0 max(10px,1.2vh);font:400 max(44px,5.4vh)/1.1 var(--sign);color:var(--bone-dim,#a9bccb)}
.rec-end-brand b{font-weight:600;letter-spacing:.14em;color:#f4f8fb}
.rec-end-built{margin:0;font:500 max(28px,3.2vh)/1.2 var(--sign);color:#e9f2f9}
.rec-end-repo{margin:0;font:500 max(28px,3vh)/1.2 var(--mono);color:var(--marker)}
.rec-end-calls{margin:0;font:500 max(28px,2.8vh)/1.2 var(--mono);letter-spacing:.04em;color:#cfdbe5}
.rec-plate{position:fixed;inset:0;z-index:120;display:grid;place-content:center;justify-items:center;gap:max(18px,2.2vh);width:100%;border:0;padding:0 6vw;background:#05080b;color:#e9f2f9;text-align:center;cursor:pointer}
.rec-plate:disabled{cursor:progress}
.rec-plate-k{font:500 max(15px,1.6vh)/1 var(--mono);letter-spacing:.22em;color:var(--marker)}
.rec-plate-go{padding:max(18px,2vh) max(44px,4.4vh);border:2px solid rgba(233,242,249,.55);font:600 max(52px,6.4vh)/1 var(--sign);letter-spacing:.02em}
.rec-plate:not(:disabled):hover .rec-plate-go{border-color:var(--marker);color:var(--marker)}
.rec-plate-note{max-width:60ch;font:400 max(16px,1.7vh)/1.5 var(--mono);color:#8fa3b3}
`;

/** Only while the script runs: no cursor anywhere. */
const RUN_CSS = `*,*::before,*::after{cursor:none!important}`;

/** A 1000 x 300 polyline of 0..1 points (high = top). */
function sparkPath(spark: number[]): string {
  if (spark.length < 2) return "";
  const step = 1000 / (spark.length - 1);
  return spark.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(300 - v * 300).toFixed(1)}`).join(" ");
}

export function DirectorStage({ config, room }: DirectorStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { view, phase, ring, spark, start } = useDirector(config, room, rootRef);
  const running = phase === "running" || phase === "done";
  const showPlate = config.autostart ? phase === "failed" : !running;
  const path = useMemo(() => sparkPath(spark), [spark]);

  return (
    <div className="rec" data-director="" ref={rootRef}>
      <style>{running ? REC_CSS + RUN_CSS : REC_CSS}</style>

      {view.title ? (
        <div className="rec-title" style={{ opacity: view.title.bg }} aria-hidden={view.title.text === 0}>
          {path ? (
            <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
              <path d={path} pathLength={1} style={{ strokeDasharray: "1 1", strokeDashoffset: 1 - view.title.line }} />
            </svg>
          ) : null}
          <h2 style={{ opacity: view.title.text }}>{TITLE_TEXT}</h2>
        </div>
      ) : null}

      {running ? <div className="rec-block" aria-hidden="true" /> : null}

      {ring && view.ring ? (
        <div
          className="rec-ring"
          aria-hidden="true"
          style={{
            left: ring.x - 6,
            top: ring.y - 6,
            width: ring.w + 12,
            height: ring.h + 12,
            opacity: view.ring.opacity,
            transform: `scale(${view.ring.scale})`,
          }}
        />
      ) : null}

      {view.caption ? (
        <div
          className={view.caption.beside === "lab" ? "rec-cap is-lab" : "rec-cap"}
          key={view.caption.id}
          style={{ opacity: view.caption.opacity }}
          role="status"
        >
          {view.caption.tag ? <span className="rec-cap-tag">{view.caption.tag}</span> : null}
          <p>{view.caption.text}</p>
        </div>
      ) : null}

      {view.end ? (
        <div className="rec-end" style={{ opacity: view.end.bg }}>
          <div className="rec-end-in">
            <p className="rec-end-brand" style={{ opacity: view.end.lines[0] }}>
              <b>{END_CARD.brand}</b> · {END_CARD.tagline}
            </p>
            <p className="rec-end-built" style={{ opacity: view.end.lines[1] }}>
              {END_CARD.built}
            </p>
            <p className="rec-end-repo" style={{ opacity: view.end.lines[2] }}>
              {config.repo}
            </p>
            <p className="rec-end-calls" style={{ opacity: view.end.lines[3] }}>
              {END_CARD.calls}
            </p>
          </div>
        </div>
      ) : null}

      {showPlate ? (
        <button type="button" className="rec-plate" onClick={start} disabled={phase !== "ready"} aria-label="Start recording: click to start the demo">
          <span className="rec-plate-k">START RECORDING · EXPOSURE DEMO</span>
          <span className="rec-plate-go">
            {phase === "ready" ? "Click to start" : phase === "failed" ? "No recorded x-rays to play" : "Loading the waiting room…"}
          </span>
          <span className="rec-plate-note">
            Start the screen recorder at 1920 × 1080 first. One click turns the sound on and plays the {Math.round(60 / config.speed)} s script with no
            further input.
            {config.speed !== 1 ? ` Speed ×${config.speed}.` : ""}
          </span>
        </button>
      ) : null}
    </div>
  );
}

export default DirectorStage;
