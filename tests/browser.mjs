#!/usr/bin/env node
/**
 * End-to-end check of the BUILT file in a real browser (Playwright + Chromium).
 *   node build.mjs && node tests/browser.mjs [--shots dir] [--file path.html]
 * Run it against a `--dev` build too: React only prints its warnings (keys, invalid props) in development.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const load = ids => { for (const id of ids.filter(Boolean)) { try { return require(id); } catch { /* next */ } } throw new Error('cannot load ' + ids.join(' | ')); };
const { chromium } = load(['playwright', 'playwright-core', '/home/claude/.npm-global/lib/node_modules/playwright']);
const si = process.argv.indexOf('--shots'); const shots = si > 0 ? process.argv[si + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const fi = process.argv.indexOf('--file');
const target = fi > 0 ? path.resolve(process.argv[fi + 1]) : path.join(ROOT, 'dist', 'algorithm-stepper.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
await page.route('**/*', r => {
  const u = r.request().url();
  if (u.startsWith('file:')) return r.continue();
  return r.abort();                                  // fonts etc: not needed offline
});
const snap = async name => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };
const stepLabel = () => page.locator('#stepLabel').innerText();
const pick = async name => { await page.selectOption('#example', name); await page.waitForSelector('#stateBody'); };

await page.goto(pathToFileURL(target).href);
await page.waitForSelector('#stateBody');

// 1. first example is traced and shown at step 1
assert.match(await stepLabel(), /^Step 1 of \d+/);
assert.ok(await page.locator('.cm-line.cm-step-cur').count() === 1, 'one current line');
assert.equal(await page.locator('.cm-line[aria-current="step"]').count(), 1, 'current line is aria-current');
assert.equal(await page.locator('#editor').getAttribute('contenteditable'), 'false', 'read-only while stepping');
await snap('01-bubble-sort-start');

// 2. stepping forward / back / keyboard
await page.click('#bNext'); assert.match(await stepLabel(), /^Step 2 of/);
assert.ok(await page.locator('.cm-line.cm-step-prev').count() === 1, 'previous line is marked faintly');
await page.click('#bPrev'); assert.match(await stepLabel(), /^Step 1 of/);
await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).blur());   // keys on a focused button are left to the button
await page.locator('body').press('ArrowRight'); assert.match(await stepLabel(), /^Step 2 of/);
await page.click('#bLast'); assert.match(await stepLabel(), /done$/);
assert.match(await page.locator('#banner').innerText(), /Finished/);
assert.match(await page.locator('#out').innerText(), /\[1,2,5,6,9\]/);

// 3. per-variable switch: BFS graph
await pick('Breadth-first search');
await page.click('#bLast');
await page.click('#bFirst');
for (let i = 0; i < 14; i++) await page.click('#bNext');
const graphBtn = page.locator('button[data-vt="graph|graph"]');
assert.equal(await graphBtn.count(), 1, 'graph variable has its own switch');
await graphBtn.click();
await page.waitForSelector('.gwrap svg');
assert.match(await page.locator('.gcap').first().innerText(), /Graph · 6 nodes · 7 edges/);
assert.ok(await page.locator('.g-snode').count() === 6, 'six nodes drawn');
assert.ok(await page.locator('path.g-edge').count() === 7, 'seven edges drawn');
assert.ok(await page.locator('.g-pilltxt').count() > 0, 'variable tags on nodes');
assert.equal(await page.locator('button[data-vt="queue|graph"]').getAttribute('aria-pressed'), 'false', 'other variables stay as boxes');
await snap('02-bfs-graph');
await page.locator('button[data-vt="graph|raw"]').click();
assert.match(await page.locator('.gcap').first().innerText(), /Memory layout/);
await snap('03-bfs-raw');

// 4. linked list becomes a list, and the choice is kept while stepping
await pick('Reverse a linked list');
const listBtn = page.locator('button[data-vt="list|graph"]');
for (let i = 0; i < 30 && !(await listBtn.count()); i++) await page.click('#bNext');   // until `list` exists
await listBtn.click();
const cap = () => page.locator('.var:has(button[data-vt="list|graph"]) .gcap').first().innerText();
await page.click('#bFirst'); for (let i = 0; i < 6; i++) await page.click('#bNext');
assert.match(await cap(), /Linked list · 3 nodes · 2 edges/);
await page.click('#bNext');
assert.match(await cap(), /Linked list/, 'choice survives stepping');
await snap('04-linked-list');

// 5. editing your own code, including a tree
await page.click('#btnEdit');
await page.fill('#editor', 'const t = {v:1, left:{v:2, left:{v:4}, right:{v:5}}, right:{v:3}};\nlet cur = t.left;\ncur = cur.right;');
await page.click('#btnRun');
await page.waitForSelector('#stateBody');
await page.click('#bLast');
await page.locator('button[data-vt="t|graph"]').click();
assert.match(await page.locator('.gcap').first().innerText(), /Tree · 5 nodes · 4 edges/);
await snap('05-tree');

// 6. errors are shown, not swallowed
await page.click('#btnEdit');
await page.fill('#editor', 'let = = 3');
await page.click('#btnRun');
assert.match(await page.locator('#banner').innerText(), /Syntax error/);

// 6b. an infinite loop is stopped instead of freezing the page
await page.fill('#editor', 'let n = 0;\nwhile (true) { }');
await page.click('#btnRun');
await page.waitForFunction(() => /Stopped after/.test(document.querySelector('#banner')?.textContent || ''), null, { timeout: 8000 });
await page.fill('#editor', 'let ok = 1;');                     // the page is still responsive afterwards
await page.click('#btnRun');
await page.waitForSelector('#stateBody');

// 6c. editor keys: Tab indents with two spaces, Ctrl+Enter runs
await page.click('#btnEdit');
await page.fill('#editor', 'let a = 1;');
const ed = page.locator('#editor');
await ed.press('End'); await ed.press('Enter'); await ed.press('Tab'); await ed.pressSequentially('a = 2;');
await ed.press('Control+Enter');
await page.waitForSelector('#stateBody');
assert.equal(await page.locator('.cm-line').nth(1).innerText(), '  a = 2;');
assert.equal(await ed.getAttribute('contenteditable'), 'false', 'Ctrl+Enter ran the code');

// 6d. a long program: the current line is scrolled into view
await page.click('#btnEdit');
await page.fill('#editor', Array.from({ length: 120 }, (_, i) => `let v${i} = ${i};`).join('\n'));
await page.click('#btnRun');
await page.waitForSelector('#stateBody');
await page.click('#bLast'); await page.click('#bPrev');                // the last step ("done") has no line
const curInView = () => page.waitForFunction(() => {           // CodeMirror scrolls in its next measure frame
  const s = document.querySelector('.cm-scroller').getBoundingClientRect(), c = document.querySelector('.cm-line.cm-step-cur')?.getBoundingClientRect();
  return !!c && c.top >= s.top && c.bottom <= s.bottom;
}, null, { timeout: 2000 }).then(() => true, () => false);
assert.ok(await curInView(), 'last line scrolled into view');
assert.ok(await page.locator('.cm-scroller').evaluate(e => e.scrollTop > 0), 'the editor scrolled');
await page.click('#bFirst');
assert.ok(await curInView(), 'first line scrolled back into view');

// 7. theme: dark mode renders without errors
await page.emulateMedia({ colorScheme: 'dark' });
await pick('Breadth-first search');
await page.click('#bLast');
await snap('06-dark');

assert.deepEqual(errors, [], 'no page errors');
await browser.close();
console.log('browser test ok' + (shots ? ' (screenshots in ' + shots + ')' : ''));
