/** Defined by build.mjs: the bundled tracing worker as source text. Undefined when running unbundled (tests). */
declare const __WORKER_SRC__: string | undefined;

/** The build loads .py files as text (build.mjs). */
declare module '*.py' { const source: string; export default source; }
