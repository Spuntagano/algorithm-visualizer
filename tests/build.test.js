import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ENGINES, build, bundleEngines } from '../build.mjs';

test('the build is one self-contained HTML file', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visualizer-')), 'out.html');
  await build({ out });
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<div id="root"><\/div>/);
  assert.equal((html.match(/^<script/gm) || []).length, 1, 'one inline script');
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts (React and acorn are bundled)');
  assert.doesNotMatch(html, /<link rel="stylesheet" href="css\//);
  assert.match(html, /<style>[\s\S]*--chipL/);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'bundled code cannot end the script early');
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
