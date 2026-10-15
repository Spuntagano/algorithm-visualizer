/**
 * Where PHP (PHP 8.4 compiled to WebAssembly by the php-wasm project) is loaded from, on demand, the first time PHP is
 * run: the small loader modules and the interpreter itself (about 3 MB to download). Keep the version equal to the
 * php-wasm devDependency the tests run against; PHP_WASM_FILE is the 8.4 browser build named in its php8.4-web.mjs.
 */
export const PHP_WASM_VERSION = '0.2.0';
export const PHP_BASE_URL = `https://cdn.jsdelivr.net/npm/php-wasm@${PHP_WASM_VERSION}/`;
export const PHP_WASM_FILE = '6733ae879e026f8b36961884052b87de4def4e15.wasm';
