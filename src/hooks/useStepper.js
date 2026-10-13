/**
 * Owns everything about running and stepping: the trace, which step is showing, and playback.
 * UI components only read from it and call its actions.
 */
import { useEffect, useRef, useState } from 'react';
import { runTraceAsync } from '../engine/runner.js';
import { runTrace } from '../engine/trace.js';

const EMPTY = { error: 'There is nothing to run yet. Add at least one statement.' };
const fromTrace = trace => (trace.steps.length ? { trace } : EMPTY);
const fromError = e => ({ error: e && e.timeout ? e.message : 'Syntax error: ' + (e && e.message ? e.message : e) });

/**
 * Trace `code` on this thread without ever throwing. Used for the first example, which is known to be safe.
 * Returns an object with either a trace or an error message.
 */
export function traceCode(code) {
  if (!String(code).trim()) return EMPTY;
  try { return fromTrace(runTrace(code)); } catch (e) { return fromError(e); }
}

/** Like traceCode, but runs in a worker so a runaway program is stopped. */
export function traceCodeAsync(code) {
  if (!String(code).trim()) return Promise.resolve(EMPTY);
  return runTraceAsync(code).then(fromTrace, fromError);
}

export function useStepper(initialCode) {
  const [first] = useState(() => traceCode(initialCode));      // computed once, so the first paint is already stepping
  const [trace, setTrace] = useState(first.trace || null);
  const [mode, setMode] = useState(first.trace ? 'run' : 'edit');   // 'edit' | 'run'
  const [notice, setNotice] = useState(first.error || null);   // syntax error etc., shown in edit mode
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(500);
  const [running, setRunning] = useState(false);   // a trace is being computed
  const latest = useRef(0);                         // ignores the result of a run that has been superseded

  const steps = trace ? trace.steps : [];
  const last = Math.max(0, steps.length - 1);
  const step = steps[idx] || null;
  const prev = idx > 0 ? steps[idx - 1] : null;

  /** Trace `code` and show step 1. Resolves to false (and shows why) if it cannot run. */
  const run = async code => {
    const id = ++latest.current;
    setPlaying(false); setRunning(true);
    const r = await traceCodeAsync(code);
    if (id !== latest.current) return false;
    setRunning(false);
    if (r.error) { setMode('edit'); setNotice(r.error); return false; }
    setTrace(r.trace); setIdx(0); setNotice(null); setMode('run');
    return true;
  };
  const edit = () => { latest.current++; setRunning(false); setPlaying(false); setMode('edit'); setNotice(null); };

  /** Jump to a step (pauses playback). */
  const go = i => { setPlaying(false); setIdx(Math.max(0, Math.min(last, i))); };
  const togglePlay = () => {
    if (!playing && idx >= last) setIdx(0);
    setPlaying(p => !p);
  };
  /** Next step that is not deeper in the call stack than the current one. */
  const stepOver = () => {
    const d = steps[idx].stack.length; let j = idx + 1;
    while (j < last && steps[j].stack.length > d) j++;
    go(j);
  };
  /** Next step that is shallower than the current one (after the current function returns). */
  const stepOut = () => {
    const d = steps[idx].stack.length; let j = idx + 1;
    if (d === 0) { go(last); return; }
    while (j < last && steps[j].stack.length >= d) j++;
    go(j);
  };

  useEffect(() => {
    if (!playing || !trace) return undefined;
    const t = setTimeout(() => { if (idx >= last) setPlaying(false); else setIdx(idx + 1); }, speed);
    return () => clearTimeout(t);
  }, [playing, idx, speed, last, trace]);

  return { mode, trace, step, prev, idx, last, count: steps.length, playing, speed, setSpeed, notice, running, run, edit, go, togglePlay, stepOver, stepOut };
}
