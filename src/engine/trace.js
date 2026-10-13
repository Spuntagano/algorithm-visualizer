/**
 * Step 2 of tracing: run the instrumented program once and record a snapshot at every
 * statement (variables, call stack, console output). The UI then replays that recording.
 */
import { instrument } from './instrument.js';
import { brief, createSerializer, fmtLog } from './serialize.js';

const MAX_STEPS = 3000;  // stop runaway loops
const MAX_CALLS = 300;   // stop runaway recursion

/** Thrown by the tracing hooks to end a run early without it counting as a program error. */
class StopRun extends Error {}

/**
 * Runs `code` and returns { steps, logs, error }.
 * Throws if the code does not parse (the message comes from acorn).
 */
export function runTrace(code) {
  const instrumented = instrument(code);
  const { capture } = createSerializer();
  const steps = [], logs = []; const stack = [];

  const __t = (line, fd, entries) => {
    if (steps.length >= MAX_STEPS) throw new StopRun('Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = capture(entries, fd);
    steps.push({ line, stack: stack.slice(), vars: c.vars, refs: c.refs, logs: logs.length });
  };
  const __enter = (name, entries) => {
    const args = entries.map(([n, th]) => { let v; try { v = th(); } catch (e) { v = undefined; } return n + '=' + brief(v); }).join(', ');
    stack.push({ name, args: args.length > 70 ? args.slice(0, 70) + '…' : args });
    if (stack.length > MAX_CALLS) throw new StopRun('Trace stopped: more than ' + MAX_CALLS + ' nested calls.');
  };
  const __exit = () => { stack.pop(); };
  const push = type => (...a) => logs.push({ type, s: a.map(fmtLog).join(' ') });
  const cons = { log: push('log'), info: push('log'), debug: push('log'), warn: push('warn'), error: push('error') };

  let error = null;
  try {
    const fn = new Function('__t', '__enter', '__exit', 'console', instrumented);
    fn(__t, __enter, __exit, cons);
  } catch (e) {
    error = e instanceof StopRun ? { msg: e.message, soft: true } : { msg: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };
  }
  return { steps, logs, error };
}
