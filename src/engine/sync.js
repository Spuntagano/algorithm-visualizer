/**
 * Tracing JavaScript (or TypeScript, Lua, Java, Kotlin, C#, Go, C or C++) on the current thread, for tests and tools (the page always traces in a worker: runner.js).
 * Never throws: returns { trace }, { error } or BLANK, like a worker run.
 */
import { BLANK, fromError, fromTrace } from './outcome.js';
import { runTrace } from './trace.js';
import { stripTypes } from './typescript.js';
import { runLuaTrace } from './lua/tracer.js';
import { runCTrace } from './c/interp.js';
import { runJavaTrace } from './java/interp.js';
import { runGoTrace } from './go/interp.js';
import { runCsTrace } from './cs/interp.js';
import { runKotlinTrace } from './kotlin/interp.js';

export function traceCode(code, lang = 'javascript') {
  if (!String(code).trim()) return BLANK;
  try { return fromTrace(lang === 'lua' ? runLuaTrace(code) : lang === 'c' ? runCTrace(code) : lang === 'cpp' ? runCTrace(code, { cpp: true }) : lang === 'java' ? runJavaTrace(code) : lang === 'go' ? runGoTrace(code) : lang === 'csharp' ? runCsTrace(code) : lang === 'kotlin' ? runKotlinTrace(code) : runTrace(lang === 'typescript' ? stripTypes(code) : code)); } catch (e) { return fromError(e); }
}
