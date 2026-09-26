"use client";

// The red rubber stamp at the foot of the report: "REVIEWED · CONFIDENCE HIGH".
// "stamping" plays the one bounce (scale 1.6 → 1 over 260ms); "shown" is the resting state.
import type { Diagnosis } from "@/lib/xray/types";

export type StampState = "hidden" | "stamping" | "shown";

export interface StampProps {
  state: StampState;
  confidence: Diagnosis["confidence"] | null;
  /** Top line; "Reviewed" by default, "Synthetic" for the dev fixture. */
  label?: string;
  className?: string;
}

export function Stamp({ state, confidence, label = "Reviewed", className }: StampProps) {
  if (state === "hidden") return null;
  const level = (confidence ?? "low").toUpperCase();
  return (
    <div
      className={`stampbox${state === "stamping" ? " is-stamping" : ""}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={`${label}. Confidence ${level.toLowerCase()}.`}
    >
      {label}
      <b>Confidence {level.toLowerCase()}</b>
    </div>
  );
}
