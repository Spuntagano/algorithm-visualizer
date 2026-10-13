/**
 * Runs runTrace() inside a Web Worker so an infinite loop (which never reaches a traced statement
 * and so never hits the step limit) can be stopped instead of freezing the page.
 * Where no worker is available (tests, or a page that forbids blob workers) it runs on the main thread.
 */
import { runTrace } from './trace.js';

export const TIME_LIMIT = 3000;   // ms of running before the program is stopped
const START_LIMIT = 2000;         // ms to wait for the worker itself to come up

let workerUrl = null;
function spawn() {
  if (typeof Worker === 'undefined' || typeof __WORKER_SRC__ === 'undefined') return null;
  try {
    workerUrl = workerUrl || URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
    return new Worker(workerUrl);
  } catch { return null; }
}

/**
 * Resolves with the trace. Rejects with an Error for a syntax error, or with a `timeout` Error
 * when the program ran longer than TIME_LIMIT.
 */
export function runTraceAsync(code) {
  const worker = spawn();
  if (!worker) return Promise.resolve().then(() => runTrace(code));
  return new Promise((resolve, reject) => {
    let timer = 0;
    const finish = fn => { clearTimeout(timer); worker.terminate(); fn(); };
    const fallback = () => finish(() => { try { resolve(runTrace(code)); } catch (e) { reject(e); } });
    timer = setTimeout(fallback, START_LIMIT);                 // the worker never came up
    worker.onerror = fallback;
    worker.onmessage = e => {
      const m = e.data;
      if (m.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(() => reject(Object.assign(
          new Error('Stopped after ' + TIME_LIMIT / 1000 + ' seconds without finishing. Is there an infinite loop?'), { timeout: true }))), TIME_LIMIT);
      } else if (m.trace) finish(() => resolve(m.trace));
      else finish(() => reject(new Error(m.failure)));
    };
    worker.postMessage(code);
  });
}
