/**
 * Entry point of the tracing Web Worker. The build bundles this file (with acorn, the JavaScript engine and the
 * Python tracer's source) into a string that runner.js turns into a worker, so the user's code never runs on the
 * page's thread.
 *
 * Messages in:  { lang: 'javascript' | 'typescript' | 'lua' | 'python' | 'ruby' | 'php' | 'c' | 'cpp', code, id, engine? }
 *               (engine: the packed engine TypeScript, Lua, C or C++ needs, from build.mjs bundleEngines)
 * Messages out: { ready, id } when a run starts, then { trace, id } or { failure, id } (a syntax error);
 *               for Python, Ruby and PHP also { loading } while the runtime downloads, and { fatal, id } if it cannot be loaded.
 */
import { runTrace } from './trace.js';
import { PYODIDE_URL } from './python/pyodide.js';
import TRACER_PY from './python/tracer.py';
import { RUBY_BINARY_URL, RUBY_GLUE_URL } from './ruby/ruby.js';
import TRACER_RB from './ruby/tracer.rb';
import { PHP_BASE_URL, PHP_WASM_FILE } from './php/php.js';
import TRACER_PHP from './php/tracer.php';

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

let ruby = null;                                     // a promise of { DefaultRubyVM, module }: compiled once, a fresh VM per run
function loadRuby() {
  if (!ruby) {
    self.postMessage({ loading: true });
    ruby = (async () => {
      (0, eval)(await (await fetch(RUBY_GLUE_URL)).text());   // the browser glue (it defines self['ruby-wasm-wasi'])
      const { DefaultRubyVM } = self['ruby-wasm-wasi'];
      const module = await WebAssembly.compileStreaming(fetch(RUBY_BINARY_URL));
      return { DefaultRubyVM, module };
    })();
    ruby.catch(() => { ruby = null; });
  }
  return ruby;
}

/* A fresh Ruby VM for every run (a few hundred ms), so classes, methods and globals never leak from one run to the next. */
async function runRuby(code, id) {
  let rb;
  try { rb = await loadRuby(); }
  catch (err) { self.postMessage({ fatal: String(err && err.message ? err.message : err), id }); return; }
  const { vm } = await rb.DefaultRubyVM(rb.module, { consolePrint: false });
  vm.eval(TRACER_RB);
  self.__rubyCode = code;                              // handed over through the JS bridge, so it needs no escaping
  self.postMessage({ ready: true, id });
  const out = JSON.parse(vm.eval('require "js"; RubyTracer.trace_json(JS.global[:__rubyCode].to_s)').toString());
  self.postMessage(out.syntax ? { failure: out.syntax, id } : { trace: out, id });
}

let php = null;                                      // a promise of { PhpWeb, module }: compiled once, a fresh PHP per run
function loadPhp() {
  if (!php) {
    self.postMessage({ loading: true });
    php = (async () => {
      // PHP's browser build expects a page: it looks up document and window (only for its SDL graphics), and queues runs
      // with Web Locks, which a worker started from a data: URL is not given. Without them it uses a lock of its own.
      if (!self.document) { self.window = self; self.document = { querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {} }; }
      try { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); } catch { /* none to hide */ }
      const [{ PhpWeb }, module] = await Promise.all([
        import(/* not bundled */ PHP_BASE_URL + 'PhpWeb.mjs'),
        WebAssembly.compileStreaming(fetch(PHP_BASE_URL + PHP_WASM_FILE)),
      ]);
      return { PhpWeb, module };
    })();
    php.catch(() => { php = null; });
  }
  return php;
}
/** The program as base64 (of its UTF-8), to go into the tracer's source as a plain string */
const base64 = s => { const b = new TextEncoder().encode(s); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(t); };

/* A fresh PHP for every run (about 100 ms), so functions and classes never leak from one run to the next. */
async function runPhp(code, id) {
  let rt;
  try { rt = await loadPhp(); }
  catch (err) { self.postMessage({ fatal: String(err && err.message ? err.message : err), id }); return; }
  const p = new rt.PhpWeb({
    autoTransaction: false,
    instantiateWasm(imports, done) { WebAssembly.instantiate(rt.module, imports).then(inst => done(inst, rt.module)); return {}; },
  });
  let out = '';
  p.addEventListener('output', e => { out += e.detail.join(''); });
  await p.binary;
  self.postMessage({ ready: true, id });
  await p.run(TRACER_PHP.replace("'__AT_CODE__'", "'" + base64(code) + "'"));
  const k = out.lastIndexOf('\x01');
  if (k < 0) { self.postMessage({ failure: 'PHP stopped without saying why.', id }); return; }
  const res = JSON.parse(out.slice(k + 1));
  self.postMessage(res.syntax ? { failure: res.syntax, id } : { trace: res, id });
}

/** Unpacks an engine (gzip, base64) and runs its bundle: its exports, e.g. { runLuaTrace } */
async function unpack(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const src = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return new Function(src + '\nreturn __engine;')();
}

async function handle({ lang, code, id, engine }) {
  if (lang === 'ruby') { await runRuby(code, id); return; }
  if (lang === 'php') { await runPhp(code, id); return; }
  if (lang !== 'python') {
    let eng = null;
    if (lang !== 'javascript') {
      try { eng = await unpack(engine); }
      catch (err) { self.postMessage({ failure: 'The ' + lang + ' engine could not be unpacked: ' + (err && err.message ? err.message : err), id }); return; }
    }
    self.postMessage({ ready: true, id });
    try { self.postMessage({ trace: lang === 'lua' ? eng.runLuaTrace(code) : lang === 'c' ? eng.runCTrace(code) : lang === 'cpp' ? eng.runCppTrace(code) : runTrace(eng ? eng.stripTypes(code) : code), id }); }
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
