/**
 * Where Ruby (CRuby 3.4 compiled to WebAssembly: ruby.wasm) is loaded from, on demand, the first time Ruby is run:
 * the interpreter with its standard library (about 8 MB to download) and the small browser glue that starts it.
 * Keep the version equal to the @ruby/wasm-wasi and @ruby/3.4-wasm-wasi devDependencies the tests run against.
 */
export const RUBY_WASM_VERSION = '2.10.1';
export const RUBY_GLUE_URL = `https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi@${RUBY_WASM_VERSION}/dist/browser.umd.js`;
export const RUBY_BINARY_URL = `https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@${RUBY_WASM_VERSION}/dist/ruby+stdlib.wasm`;
