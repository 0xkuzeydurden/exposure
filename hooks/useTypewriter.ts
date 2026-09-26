"use client";

// One cancellable typing session per component: begin() aborts the previous session and returns a
// fresh AbortSignal; everything aborts on unmount. Strict-mode safe (the effect cleanup cancels).
import { useCallback, useEffect, useMemo, useRef } from "react";
import { typeText, type TypeOptions } from "@/lib/exposure/typewriter";

export interface Typewriter {
  /** Aborts the running session (if any) and starts a new one. */
  begin: () => AbortSignal;
  /** Aborts the running session. */
  cancel: () => void;
  /** typeText bound to the current session's signal. */
  type: (text: string, opts: Omit<TypeOptions, "signal">) => Promise<void>;
  /** The current session's signal (a pre-aborted one when idle). */
  signal: () => AbortSignal;
}

function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

export function useTypewriter(): Typewriter {
  const ctrl = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
  }, []);

  const begin = useCallback(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    return c.signal;
  }, []);

  const signal = useCallback(() => ctrl.current?.signal ?? abortedSignal(), []);

  const type = useCallback(
    (text: string, opts: Omit<TypeOptions, "signal">) => typeText(text, { ...opts, signal: signal() }),
    [signal],
  );

  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ begin, cancel, type, signal }), [begin, cancel, type, signal]);
}
