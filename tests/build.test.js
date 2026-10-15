import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../build.mjs';

test('the build is one self-contained HTML file', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stepper-')), 'out.html');
  await build({ out });
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<div id="root"><\/div>/);
  assert.equal((html.match(/^<script/gm) || []).length, 1, 'one inline script');
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts (React and acorn are bundled)');
  assert.doesNotMatch(html, /<link rel="stylesheet" href="css\//);
  assert.match(html, /<style>[\s\S]*--chipL/);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'bundled code cannot end the script early');
  // react-dom ~205 KB, CodeMirror ~420 KB (JavaScript, TypeScript and Python grammars), the tracing worker ~330 KB
  // (acorn, and Sucrase ~200 KB so TypeScript runs offline). Python's runtime is downloaded on first use, not counted.
  assert.ok(html.length < 1.25 * 1024 * 1024, 'bundle stays small: ' + html.length);
});
