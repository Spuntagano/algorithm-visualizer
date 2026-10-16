#!/usr/bin/env node
/**
 * Builds ONE self-contained HTML file (dist/algorithm-stepper.html): esbuild bundles src/main.jsx
 * together with React and acorn, and the stylesheets from css/ are inlined. One file is what the
 * page needs to be published or opened from disk.
 *
 *   node build.mjs                 production build (minified)
 *   node build.mjs --dev           unminified, with React's development warnings
 *   node build.mjs --watch         rebuild on every change (implies --dev) and serve it on http://localhost:8000/ (--port n)
 *   node build.mjs --out file.html
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const common = dev => ({
  bundle: true, write: false, format: 'iife', target: 'es2020', legalComments: 'none',
  minify: !dev, sourcemap: false, logLevel: 'silent',
});

/**
 * The engines only some languages need (Sucrase for TypeScript, Fengari for Lua, the C and C++, Java, Kotlin, C# and Go interpreters), each bundled on its
 * own, gzipped and base64'd: the worker is handed and unpacks only the one a run needs (engine/worker.js). This keeps
 * the page one file that works offline, a third the size it would be with them as plain code.
 */
export const ENGINES = { typescript: 'src/engine/typescript.js', lua: 'src/engine/lua/tracer.js', c: 'src/engine/c/interp.js', cpp: 'src/engine/c/cpp.js',
  java: 'src/engine/java/interp.js', kotlin: 'src/engine/kotlin/interp.js', csharp: 'src/engine/cs/interp.js', go: 'src/engine/go/interp.js' };
export async function bundleEngines({ dev = false } = {}) {
  // Fengari (Lua) is written for Node too: its Node-only modules are never used in a worker, so they are stubbed out
  const nodeOnly = { name: 'node-only', setup(b) {
    b.onResolve({ filter: /^(fs|os|path|child_process|crypto|readline-sync|tmp)$/ }, () => ({ path: 'empty', namespace: 'node-only' }));
    b.onLoad({ filter: /.*/, namespace: 'node-only' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  } };
  const out = {};
  for (const [lang, entry] of Object.entries(ENGINES)) {
    const r = await esbuild.build({ ...common(dev), entryPoints: [path.join(ROOT, entry)], globalName: '__engine', plugins: [nodeOnly],
      define: { 'process.env.FENGARICONF': 'undefined' } });
    out[lang] = zlib.gzipSync(r.outputFiles[0].text, { level: 9 }).toString('base64');
  }
  return out;
}

export async function bundleJs({ dev = false } = {}) {
  // the tracing worker is bundled first and embedded as text; the page starts it from a Blob
  const w = await esbuild.build({ ...common(dev), entryPoints: [path.join(ROOT, 'src/engine/worker.js')], loader: { '.py': 'text', '.rb': 'text', '.php': 'text' } });
  const r = await esbuild.build({
    ...common(dev), entryPoints: [path.join(ROOT, 'src/main.jsx')], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"', __WORKER_SRC__: JSON.stringify(w.outputFiles[0].text),
      __ENGINES__: JSON.stringify(await bundleEngines({ dev })) },
  });
  // "</script" inside a string would end the inline <script>; "<\/script" means the same thing to JS
  return r.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
}

export async function build({ out, dev = false } = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const block = (name, fn) => {
    const re = new RegExp(`[ \\t]*<!-- build:${name} -->[\\s\\S]*?<!-- endbuild -->`);
    const m = html.match(re);
    if (!m) throw new Error(`index.html is missing the build:${name} block`);
    html = html.replace(re, () => fn(m[0]));
  };
  block('css', b => {
    const hrefs = [...b.matchAll(/href="([^"]+\.css)"/g)].map(m => m[1]);
    const css = hrefs.map(h => `/* ${h} */\n` + fs.readFileSync(path.join(ROOT, h), 'utf8').trim()).join('\n\n');
    return `<style>\n${css}\n</style>`;
  });
  const js = await bundleJs({ dev });
  block('js', () => `<script>\n${js}\n</script>`);
  const file = out || path.join(ROOT, 'dist', 'algorithm-stepper.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html) };
}

/** Serves the built page at http://localhost:<port>/, read fresh on every request so rebuilds show on reload. */
function serve(file, port) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (new URL(req.url, 'http://x').pathname !== '/') { res.writeHead(404).end('not found'); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(503, { 'content-type': 'text/plain' }).end('not built yet'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
    });
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${port} is in use: pass --port <n>` : e.message); process.exit(1); });
  server.listen(port, () => console.log(`serving http://localhost:${port}/`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv, watch = arg.includes('--watch'), dev = watch || arg.includes('--dev');
  const oi = arg.indexOf('--out'), out = oi > 0 ? path.resolve(arg[oi + 1]) : undefined;
  const once = async () => {
    try { const r = await build({ out, dev }); console.log(`built ${path.relative(process.cwd(), r.file)}  (${(r.bytes / 1024).toFixed(1)} KB${dev ? ', dev' : ''})`); }
    catch (e) { console.error(e.message || e); if (!watch) process.exit(1); }
  };
  await once();
  if (watch) {
    let t;
    for (const dir of ['src', 'css', '.']) fs.watch(path.join(ROOT, dir), { recursive: dir !== '.' }, (_, f) => {
      if (dir === '.' && f !== 'index.html') return;
      clearTimeout(t); t = setTimeout(once, 80);
    });
    console.log('watching src/, css/ and index.html …');
    serve(out || path.join(ROOT, 'dist', 'algorithm-stepper.html'), arg.includes('--port') ? +arg[arg.indexOf('--port') + 1] : 8000);
  }
}
