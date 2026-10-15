/**
 * What a run turned into, for the UI: { trace }, { error: message }, or BLANK (no code at all: not an error).
 * Shared by the worker-based runs (hooks/useStepper.js) and the main-thread traceCode (engine/sync.js, tests).
 */
export const BLANK = { empty: true };
export const NO_STEPS = { error: 'There is nothing to run yet. Add at least one statement.' };
export const fromTrace = trace => (trace.steps.length ? { trace } : NO_STEPS);
/** A timeout or a start-up problem is shown as it is; anything else the tracer throws is a syntax error. */
export const fromError = e => ({ error: e && (e.timeout || e.plain) ? e.message : 'Syntax error: ' + (e && e.message ? e.message : e) });
