"use client";

// Hospital signage across the top of the room: cross + EXPOSURE + department, a small status note,
// the sound switch, "Lab results" and "Take the x-ray".
import { memo } from "react";

export interface SignageProps {
  /** Small mono note, e.g. "recorded 26 Sep 14:02 · replay · 0 credits". */
  note?: string | null;
  soundOn: boolean;
  onToggleSound: () => void;
  onTakeXray: () => void;
  /** Button label; default "Take the x-ray". */
  takeLabel?: string;
  takeDisabled?: boolean;
  /** "Lab results": opens the drawer on its Summary tab (hidden without it). */
  onOpenLab?: () => void;
  labDisabled?: boolean;
  className?: string;
}

function SignageImpl({ note, soundOn, onToggleSound, onTakeXray, takeLabel, takeDisabled, onOpenLab, labDisabled, className }: SignageProps) {
  return (
    <header className={`sign${className ? ` ${className}` : ""}`}>
      <div className="dept">
        <span className="cross" aria-hidden="true" />
        <h1>
          <b>EXPOSURE</b>
        </h1>
        <span>Radiology · On-chain imaging</span>
      </div>
      <div className="controls">
        {note ? <span className="note">{note}</span> : null}
        <button className="btn" type="button" aria-pressed={soundOn} onClick={onToggleSound}>
          {soundOn ? "Sound on" : "Sound off"}
        </button>
        {onOpenLab ? (
          <button className="btn" type="button" onClick={onOpenLab} disabled={labDisabled}>
            Lab results
          </button>
        ) : null}
        <button className="btn" type="button" onClick={onTakeXray} disabled={takeDisabled}>
          {takeLabel ?? "Take the x-ray"}
        </button>
      </div>
    </header>
  );
}

export const Signage = memo(SignageImpl);
