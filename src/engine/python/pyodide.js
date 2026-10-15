/**
 * Where the Python runtime (Pyodide: CPython compiled to WebAssembly) is loaded from, on demand, the first time
 * Python is run. About 12 MB, so it is not inlined into the page. Keep the version equal to the `pyodide`
 * devDependency, which the tests run against (tests/engine.test.js checks it).
 */
export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
