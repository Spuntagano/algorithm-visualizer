/** The C++ engine: the C interpreter (./interp.js) with its C++ parts and the standard library (./stl.js) switched on. */
import { runCTrace } from './interp.js';

/** Runs a C++ program: { steps, logs, error }; throws an Error ("line N: …") on a syntax error */
export const runCppTrace = src => runCTrace(src, { cpp: true });
