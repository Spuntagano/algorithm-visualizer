/**
 * Entry point of the tracing Web Worker. The build bundles this file (with acorn and the engine)
 * into a string that runner.js turns into a worker, so the user's code never runs on the page's thread.
 */
import { runTrace } from './trace.js';

self.postMessage({ ready: true });
self.onmessage = e => {
  try { self.postMessage({ trace: runTrace(e.data) }); }
  catch (err) { self.postMessage({ failure: err && err.message ? err.message : String(err) }); }   // syntax errors
};
