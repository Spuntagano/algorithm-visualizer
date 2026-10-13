#!/usr/bin/env node
/**
 * Uses the TypeScript checker (no type annotations needed) purely as a linter for what breaks a
 * module project: names that are not defined or imported, imports of names a module does not export,
 * relative imports that do not resolve, and unused imports/variables. Ordinary type noise is ignored.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let tsc;
try { tsc = require.resolve('typescript/bin/tsc'); } catch { tsc = process.env.TSC || ''; }
if (!tsc) { console.error('typescript not found: run `npm install` first'); process.exit(2); }

const KEEP = new Set([2304, 2305, 2307, 2459, 2460, 2448, 2454, 2552, 2614, 6133, 6192, 6196, 6198]);
const r = spawnSync(process.execPath, [tsc, '-p', path.join(ROOT, 'jsconfig.json'), '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const problems = (r.stdout + r.stderr).split('\n').filter(l => {
  if (!/^(src|tests)\//.test(l)) return false;                     // only our own files, not node_modules
  const m = l.match(/error TS(\d+): (.*)/);
  if (!m || !KEEP.has(+m[1])) return false;
  if (+m[1] === 2307 && !/'\.\.?\//.test(m[2])) return false;     // packages without type declarations are fine
  return true;
});
if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log('lint ok: all names resolve, no unused imports');
