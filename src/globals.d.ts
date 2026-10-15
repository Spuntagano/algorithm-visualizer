/** Defined by build.mjs: the bundled tracing worker as source text. Undefined when running unbundled (tests). */
declare const __WORKER_SRC__: string | undefined;

/** The build loads .py, .rb and .php files as text (build.mjs). */
declare module '*.py' { const source: string; export default source; }
declare module '*.rb' { const source: string; export default source; }
declare module '*.php' { const source: string; export default source; }
/** Set by the build: the packed engines, gzipped and base64'd, by language (build.mjs bundleEngines). */
declare const __ENGINES__: Record<string, string>;
