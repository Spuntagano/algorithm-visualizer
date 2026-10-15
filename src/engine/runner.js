/**
 * Runs the tracer inside a Web Worker, so an infinite loop (which never reaches a traced statement and so never
 * hits the step limit) can be stopped instead of freezing the page.
 *   JavaScript  a fresh worker per run, terminated when the run ends or is replaced.
 *   Python      one worker that keeps Pyodide loaded between runs (loading it takes seconds); a replaced run is
 *               left to finish and ignored, and the worker is only terminated when a run exceeds TIME_LIMIT.
 * The page itself does not bundle the tracer. Where no worker can start (Node tests), a main-thread tracer can be
 * supplied with setMainThreadTracer().
 */
export const TIME_LIMIT = 3000;   // ms of running before the program is stopped
const START_LIMIT = 2000;         // ms to wait for a JavaScript worker to come up
const PY_START_LIMIT = 120000;    // ms to wait for Python to download and start

// read once: the build pastes the whole worker source in at every place __WORKER_SRC__ is written
const WORKER_SRC = typeof __WORKER_SRC__ === 'undefined' ? null : __WORKER_SRC__;
let blobUrl = null;
/* A tiny module worker that runs the code it is sent first: the tracer itself is too big for a data: URL (browsers cap
   URLs at about 2 MB, which the unminified worker exceeds), so it travels as a message instead. */
const BOOT = 'self.onmessage = e => { self.onmessage = null; (0, eval)(e.data); };';

/**
 * A worker running the bundled tracer. Python's must be a module worker (Pyodide refuses classic ones), and a page
 * opened from disk (file://) cannot start a module worker from a blob: URL: there, a small data: URL bootstrap is
 * started and handed the tracer's code.
 */
function spawn(module = false) {
  if (typeof Worker === 'undefined' || !WORKER_SRC) return null;
  try {
    if (module && typeof location !== 'undefined' && location.protocol === 'file:') {
      const w = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(BOOT), { type: 'module' });
      w.postMessage(WORKER_SRC);                     // runs first: it installs the tracer's own onmessage
      return w;
    }
    blobUrl = blobUrl || URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    return new Worker(blobUrl, module ? { type: 'module' } : undefined);
  } catch { return null; }
}

let mainThreadTracer = null;
/** For environments without workers (tests): fn(code, lang) returns the trace or throws a syntax error. */
export function setMainThreadTracer(fn) { mainThreadTracer = fn; }

const aborted = () => Object.assign(new Error('aborted'), { aborted: true });
const timedOut = () => Object.assign(new Error('Stopped after ' + TIME_LIMIT / 1000 + ' seconds without finishing. Is there an infinite loop?'), { timeout: true });

let nextId = 1;

/**
 * Resolves with the trace. Rejects with an Error for a syntax error, with a `timeout` Error when the program ran
 * longer than TIME_LIMIT, with an `aborted` Error once `signal` aborts, or with a `plain` Error when the tracer
 * cannot start (e.g. Python cannot be downloaded).
 * @param {string} code
 * @param {AbortSignal} [signal]
 * @param {{ lang?: 'javascript' | 'typescript' | 'lua' | 'python', onStatus?: (s: 'loading') => void }} [opts]
 */
export function runTraceAsync(code, signal, { lang = 'javascript', onStatus } = {}) {
  if (signal && signal.aborted) return Promise.reject(aborted());
  if (typeof Worker === 'undefined' || !WORKER_SRC) {
    if (mainThreadTracer) return Promise.resolve().then(() => mainThreadTracer(code, lang));
    return Promise.reject(Object.assign(new Error('This browser could not start the tracing worker.'), { plain: true }));
  }
  return lang === 'python' ? runPython(code, signal, onStatus) : runJavaScript(code, signal, lang);
}

/* JavaScript (and TypeScript, which the worker strips to JavaScript, and Lua): a fresh worker per run, terminated when the run ends, times out or is replaced. */
function runJavaScript(code, signal, lang = 'javascript') {
  const worker = spawn(), id = nextId++;
  if (!worker) return Promise.reject(Object.assign(new Error('This browser could not start the tracing worker.'), { plain: true }));
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = fn => { clearTimeout(timer); worker.terminate(); if (signal) signal.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => done(() => reject(aborted()));
    if (signal) signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(() => reject(Object.assign(new Error('The tracing worker did not start.'), { plain: true }))), START_LIMIT);
    worker.onerror = () => done(() => reject(Object.assign(new Error('The tracing worker failed.'), { plain: true })));
    worker.onmessage = e => {
      const m = e.data;
      if (m.ready) { clearTimeout(timer); timer = setTimeout(() => done(() => reject(timedOut())), TIME_LIMIT); }
      else if (m.trace) done(() => resolve(m.trace));
      else if (m.failure != null) done(() => reject(new Error(m.failure)));
    };
    worker.postMessage({ lang, code, id });
  });
}

/*
 * Python: one worker keeps Pyodide loaded between runs, and runs one at a time in order. A replaced run is left to
 * finish (stopping it would mean loading Python again) and its result is ignored, but it keeps its time limit: a run
 * that exceeds TIME_LIMIT gets the worker terminated, and the runs queued behind it are sent to a fresh one.
 */
let py = null;                                       // { worker, runs: Map(id → run) }
function pythonWorker(onStatus) {
  if (py) return py;
  const worker = spawn(true);
  if (!worker) return null;
  const me = py = { worker, runs: new Map(), onStatus };
  worker.onmessage = e => {
    const m = e.data;
    if (m.loading) { for (const r of me.runs.values()) if (r.onStatus) r.onStatus('loading'); return; }
    const r = me.runs.get(m.id);
    if (r) r.message(m);
  };
  worker.onerror = () => { const runs = [...me.runs.values()]; kill(me); runs.forEach(r => r.fail('Python could not be started.')); };
  return me;
}
function kill(w) {
  w.worker.terminate();
  if (py === w) py = null;
  for (const r of w.runs.values()) clearTimeout(r.timer);
}

function runPython(code, signal, onStatus) {
  return new Promise((resolve, reject) => {
    const run = { id: 0, timer: 0, onStatus, ignored: false };
    const settle = fn => { if (!run.ignored) { run.ignored = true; if (signal) signal.removeEventListener('abort', onAbort); fn(); } };
    const onAbort = () => settle(() => reject(aborted()));
    if (signal) signal.addEventListener('abort', onAbort);
    run.fail = msg => settle(() => reject(Object.assign(new Error(msg), { plain: true })));
    const send = () => {
      const w = pythonWorker(onStatus);
      if (!w) { run.fail('This browser could not start the tracing worker.'); return; }
      run.id = nextId++; run.w = w;
      w.runs.set(run.id, run);
      clearTimeout(run.timer);
      run.timer = setTimeout(() => { w.runs.delete(run.id); run.fail('Python took too long to start.'); }, PY_START_LIMIT);
      w.worker.postMessage({ lang: 'python', code, id: run.id });
    };
    run.message = m => {
      const w = run.w;
      if (m.ready) {                                 // started: from now on it has TIME_LIMIT, even if it was replaced
        clearTimeout(run.timer);
        run.timer = setTimeout(() => {
          w.runs.delete(run.id);
          const queued = [...w.runs.values()];
          kill(w);
          settle(() => reject(timedOut()));
          queued.forEach(q => q.resend());           // the runs that were waiting behind it start again on a new worker
        }, TIME_LIMIT);
        return;
      }
      clearTimeout(run.timer);
      w.runs.delete(run.id);
      if (m.trace) settle(() => resolve(m.trace));
      else if (m.fatal) { kill(w); settle(() => reject(Object.assign(new Error('Python could not be loaded (it is downloaded the first time it is used: are you offline?). ' + m.fatal), { plain: true }))); }
      else settle(() => reject(new Error(m.failure)));
    };
    run.resend = () => { if (run.ignored) return; send(); };
    send();
  });
}
