/**
 * Owns everything about running and stepping: the trace, which step is showing, and playback.
 * UI components only read from it and call its actions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { runTraceAsync } from '../engine/runner.js';
import { runTrace } from '../engine/trace.js';

const BLANK = { empty: true };                     // no code at all: not an error, the page just waits for some
const NO_STEPS = { error: 'There is nothing to run yet. Add at least one statement.' };
const fromTrace = trace => (trace.steps.length ? { trace } : NO_STEPS);
const fromError = e => ({ error: e && e.timeout ? e.message : 'Syntax error: ' + (e && e.message ? e.message : e) });

/**
 * Trace `code` on this thread without ever throwing. Used for the first example, which is known to be safe.
 * Returns an object with either a trace or an error message.
 */
export function traceCode(code) {
  if (!String(code).trim()) return BLANK;
  try { return fromTrace(runTrace(code)); } catch (e) { return fromError(e); }
}

/** Like traceCode, but runs in a worker so a runaway program is stopped. Resolves to null if `signal` aborted. */
export function traceCodeAsync(code, signal) {
  if (!String(code).trim()) return Promise.resolve(BLANK);
  return runTraceAsync(code, signal).then(fromTrace, e => (e && e.aborted ? null : fromError(e)));
}

/** Index of the first step after `idx` (or before it, with dir = -1) that is on a breakpoint line, or -1. */
export function breakpointStep(steps, idx, lines, dir = 1) {
  for (let j = idx + dir; j >= 0 && j < steps.length; j += dir) if (lines.has(steps[j].line)) return j;
  return -1;
}

/** @param breakpoints  marked line numbers; playback pauses on them, and nextBreak / prevBreak jump to them */
export function useStepper(initialCode, breakpoints = []) {
  const [first] = useState(() => traceCode(initialCode));      // computed once, so the first paint is already stepping
  const [trace, setTrace] = useState(first.trace || null);
  const [tracedCode, setTracedCode] = useState(initialCode);   // the code `trace` (or `notice`) belongs to
  const [notice, setNotice] = useState(first.error || null);   // why the code cannot be shown: syntax error, timeout, no statements
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(500);
  const [running, setRunning] = useState(false);   // a trace is being computed
  const [runs, setRuns] = useState(0);              // finished runs, so callers (and tests) can tell a new result arrived
  const pending = useRef(null);                     // AbortController of the run in progress

  const steps = trace ? trace.steps : [];
  const last = Math.max(0, steps.length - 1);
  const step = steps[idx] || null;
  const prev = idx > 0 ? steps[idx - 1] : null;
  const bpKey = breakpoints.join();
  const bps = useMemo(() => new Set(bpKey ? bpKey.split(',').map(Number) : []), [bpKey]);   // keyed by content, not array identity

  /**
   * Trace `code` and show step 1; a run still in progress is stopped. Resolves to false (and shows why)
   * if the code cannot run, or if a newer run replaced this one.
   */
  const run = async code => {
    if (pending.current) pending.current.abort();
    const ctl = pending.current = new AbortController();
    setPlaying(false); setRunning(true);
    const r = await traceCodeAsync(code, ctl.signal);
    if (!r || pending.current !== ctl) return false;
    pending.current = null;
    setRunning(false); setTracedCode(code); setIdx(0); setRuns(n => n + 1);
    if (r.empty || r.error) { setTrace(null); setNotice(r.error || null); return false; }
    setTrace(r.trace); setNotice(null);
    return true;
  };
  const pause = () => setPlaying(false);

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

  /** Continue to the next breakpoint (or the end); back to the previous one (or the start). */
  const nextBreak = () => { const j = breakpointStep(steps, idx, bps, 1); go(j >= 0 ? j : last); };
  const prevBreak = () => { const j = breakpointStep(steps, idx, bps, -1); go(j >= 0 ? j : 0); };
  /** Steps that land on a breakpoint (for the ticks on the timeline). */
  const hits = useMemo(() => (bps.size ? steps.flatMap((st, i) => (bps.has(st.line) ? [i] : [])) : []), [steps, bps]);

  useEffect(() => {                                 // playback: one step per tick, pausing when it reaches a breakpoint
    if (!playing || !trace) return undefined;
    const t = setTimeout(() => {
      if (idx >= last) { setPlaying(false); return; }
      setIdx(idx + 1);
      if (bps.has(steps[idx + 1].line)) setPlaying(false);
    }, speed);
    return () => clearTimeout(t);
  }, [playing, idx, speed, last, trace, bps, steps]);

  return { trace, tracedCode, runs, step, prev, idx, last, count: steps.length, playing, speed, setSpeed, notice, running, run, pause, go, togglePlay, stepOver, stepOut,
    breakpoints: bps, hits, nextBreak, prevBreak };
}
