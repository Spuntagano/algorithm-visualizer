/**
 * Entry point of the tracing Web Worker. The build bundles this file (with acorn, the JavaScript engine and the
 * Python tracer's source) into a string that runner.js turns into a worker, so the user's code never runs on the
 * page's thread.
 *
 * Messages in:  { lang: 'javascript' | 'typescript' | 'lua' | 'python', code, id }
 * Messages out: { ready, id } when a run starts, then { trace, id } or { failure, id } (a syntax error);
 *               for Python also { loading } while Pyodide downloads, and { fatal, id } if it cannot be loaded.
 */
import { runTrace } from './trace.js';
import { stripTypes } from './typescript.js';
import { runLuaTrace } from './lua/tracer.js';
import { PYODIDE_URL } from './python/pyodide.js';
import TRACER_PY from './python/tracer.py';

let python = null;                                   // a promise of the loaded Pyodide, made on the first Python run
function loadPython() {
  if (!python) {
    self.postMessage({ loading: true });
    python = (async () => {
      // Pyodide only runs in a module worker (runner.js starts Python's worker as one), and is loaded as a module
      const { loadPyodide } = await import(/* not bundled */ PYODIDE_URL + 'pyodide.mjs');
      const py = await loadPyodide({ indexURL: PYODIDE_URL });
      py.runPython(TRACER_PY);
      return py;
    })();
    python.catch(() => { python = null; });          // a failed download can be retried by the next run
  }
  return python;
}

async function handle({ lang, code, id }) {
  if (lang !== 'python') {
    self.postMessage({ ready: true, id });
    try { self.postMessage({ trace: lang === 'lua' ? runLuaTrace(code) : runTrace(lang === 'typescript' ? stripTypes(code) : code), id }); }
    catch (err) { self.postMessage({ failure: err && err.message ? err.message : String(err), id }); }
    return;
  }
  let py;
  try { py = await loadPython(); }
  catch (err) { self.postMessage({ fatal: String(err && err.message ? err.message : err), id }); return; }
  self.postMessage({ ready: true, id });
  const out = JSON.parse(py.globals.get('trace_json')(code));
  self.postMessage(out.syntax ? { failure: out.syntax, id } : { trace: out, id });
}

let queue = Promise.resolve();                       // one run at a time, in order
self.onmessage = e => { queue = queue.then(() => handle(e.data)); };
