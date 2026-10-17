import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ENGINES, build, bundleEngines } from '../build.mjs';
import { LANG_NAMES } from '../src/editor.js';

test('the build is one self-contained HTML file', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visualizer-')), 'out.html');
  await build({ out });
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<div id="root">\s*<!--[^>]*-->\s*<div class="prerender">/, 'the app mounts in #root, over the text for crawlers');
  assert.equal((html.match(/^<script>/gm) || []).length, 2, 'one inline script of code, and the Google tag\'s loader');
  assert.equal((html.match(/googletagmanager\.com/g) || []).length, 1, 'the only script from elsewhere is the Google tag');
  assert.match(html, /id: 'G-G14L8V66QF',(?:[^\n]*\n){3}\s*enabled: \['algorithmvisualizer\.io', 'spuntagano\.github\.io'\]\.includes\(location\.hostname\) && !new URLSearchParams\(location\.hash\.slice\(1\)\)\.has\('embed'\),/,
    'and only on the published site, never embedded in another page');
  assert.match(html, /try \{ if \(localStorage\.getItem\('algorithm-visualizer\.analytics'\) === 'yes'\) window\.analytics\.load\(\); \}/, 'loaded at start only for a visitor who said yes');
  assert.equal((html.match(/analytics\.load\(\)/g) || []).length, 2, 'and otherwise only from the consent banner or About (the one other call)');
  assert.equal((html.match(/<script type="application\/ld\+json">/g) || []).length, 1, 'and the structured data, which is not code');
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts (React and acorn are bundled)');
  assert.doesNotMatch(html, /<link rel="stylesheet" href="css\//);
  assert.match(html, /<style>[\s\S]*--chipL/);
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'bundled code cannot end its script early (the others close the Google tag and the structured data)');
  // react-dom ~205 KB, CodeMirror ~430 KB (its grammars), the tracing worker (acorn, the JavaScript tracer), and the
  // engines packed: Sucrase ~200 KB so TypeScript runs offline, Fengari ~210 KB so Lua does, the C (and C++) interpreter ~150 KB, the Java one ~100 KB, the Kotlin one ~130 KB, the Swift one ~155 KB, the C# one ~150 KB, the Go one ~90 KB,
  // about a third of that gzipped and base64'd. Python, Ruby and PHP are downloaded on first use.
  // The limit was 1.5 MB until the Kotlin, C# and Go interpreters were added (each 40-80 KB packed); 1.75 MB left room for one more, which Swift took (~65 KB packed).
  assert.ok(html.length < 1.75 * 1024 * 1024, 'bundle stays small: ' + html.length);
  assert.doesNotMatch(html, /luaL_newstate|isTSX|use after free/, 'the engines (Fengari, Sucrase, C) are not in the page as plain code');
});

test('each packed engine unpacks to a bundle that exports what the worker calls, and works', async () => {
  const packed = await bundleEngines();
  assert.deepEqual(Object.keys(packed), Object.keys(ENGINES));
  // run as in the worker: a scope without Node's process, require or modules (Fengari would take its Node path)
  const load = lang => vm.runInNewContext(zlib.gunzipSync(Buffer.from(packed[lang], 'base64')).toString('utf8') + '\n__engine',
    { TextEncoder, TextDecoder, console });
  assert.equal(load('typescript').stripTypes('let x: number = 1;').trim(), 'let x = 1;');
  assert.deepEqual(Array.from(load('lua').runLuaTrace('print(1 + 1)').logs, l => l.s), ['2']);
  assert.deepEqual(Array.from(load('c').runCTrace('#include <stdio.h>\nint main(void) { printf("%d\\n", 6 * 7); return 0; }').logs, l => l.s), ['42']);
  assert.deepEqual(Array.from(load('java').runJavaTrace('public class Main { public static void main(String[] a) { System.out.println(6 * 7); } }').logs, l => l.s), ['42']);
  assert.deepEqual(Array.from(load('kotlin').runKotlinTrace('fun main() { println(6 * 7) }').logs, l => l.s), ['42']);
  assert.deepEqual(Array.from(load('swift').runSwiftTrace('print(6 * 7, "é".count)').logs, l => l.s), ['42 1']);
  assert.deepEqual(Array.from(load('csharp').runCsTrace('Console.WriteLine(6 * 7);').logs, l => l.s), ['42']);
  assert.deepEqual(Array.from(load('go').runGoTrace('package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(6 * 7) }').logs, l => l.s), ['42']);
  assert.deepEqual(Array.from(load('cpp').runCppTrace('#include <iostream>\nint main() { std::cout << 6 * 7 << std::endl; }').logs, l => l.s), ['42']);
  for (const [lang, b64] of Object.entries(packed)) assert.ok(b64.length < 140 * 1024, lang + ' packs small: ' + b64.length);
});

test('search engines and link previews get a title, a description, a preview image and text without running anything', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visualizer-')), 'out.html');
  await build({ out });
  const html = fs.readFileSync(out, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const meta = (attr, name) => (head.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) || [])[1];
  const SITE = 'https://algorithmvisualizer.io/';
  const title = head.match(/<title>([^<]+)<\/title>/)[1];
  assert.ok(title.length >= 30 && title.length <= 65, 'a title search results show in full: ' + title);
  const desc = meta('name', 'description');
  assert.ok(desc && desc.length >= 110 && desc.length <= 160, 'a description of a search snippet\'s length: ' + (desc || '').length);
  assert.match(head, new RegExp(`<link rel="canonical" href="${SITE}">`));
  assert.equal(meta('property', 'og:title'), title);
  assert.equal(meta('property', 'og:description'), desc);
  assert.equal(meta('property', 'og:url'), SITE);
  assert.equal(meta('property', 'og:image'), SITE + 'og-image.png', 'an absolute address: previews do not resolve relative ones');
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.match(head, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/, 'the tab icon is in the page');
  const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.url, SITE);
  assert.deepEqual(ld.programmingLanguage, Object.values(LANG_NAMES), 'the structured data names every language the picker has');
  const text = html.match(/<div class="prerender">([\s\S]*?)<\/div>\s*<\/div>/)[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const name of Object.values(LANG_NAMES)) assert.ok(text.includes(name), name + ' is named in the text for crawlers');
  // the files published beside the page (tools/og-images.mjs makes them; .github/workflows/pages.yml copies public/)
  const size = f => { const b = fs.readFileSync(new URL('../public/' + f, import.meta.url)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(size('og-image.png'), [1200, 630]);
  assert.deepEqual(size('apple-touch-icon.png'), [180, 180]);
  assert.match(fs.readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'), /cp public\/\* site\//);
});
