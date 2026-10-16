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
// on the context, so the tracing workers' requests are covered too; of several matching routes the last one added wins
await page.context().route('**/*', r => {
  const u = r.request().url();
  if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
  return r.abort();                                  // fonts etc: not needed offline
});
// Python: the page downloads Pyodide from the CDN; serve the very same files from node_modules/pyodide instead
const PY_TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip' };
await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v[^/]+\/full\//, r => {
  const file = path.join(ROOT, 'node_modules', 'pyodide', new URL(r.request().url()).pathname.split('/full/')[1]);
  if (!fs.existsSync(file)) return r.abort();
  return r.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': PY_TYPES[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
});
// Ruby: the page downloads ruby.wasm and its glue from the CDN; serve the same files from node_modules/@ruby instead
await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@ruby\//, r => {
  const [, pkg, rest] = new URL(r.request().url()).pathname.match(/^\/npm\/@ruby\/([^@]+)@[^/]+\/(.*)$/) || [];
  const file = pkg && path.join(ROOT, 'node_modules', '@ruby', pkg, rest);
  if (!file || !fs.existsSync(file)) return r.abort();
  return r.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': PY_TYPES[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
});
// PHP: the page downloads php-wasm from the CDN; serve the same files from node_modules/php-wasm instead
await page.context().route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/php-wasm@[^/]+\//, r => {
  const file = path.join(ROOT, 'node_modules', 'php-wasm', new URL(r.request().url()).pathname.replace(/^\/npm\/php-wasm@[^/]+\//, ''));
  if (!fs.existsSync(file)) return r.abort();
  return r.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': PY_TYPES[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
});
const snap = async name => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };
const stepLabel = () => page.locator('#stepLabel').innerText();
/** Pick an example and wait until ITS run is shown (the previous example's state panel is still there meanwhile). */
const pick = async name => {
  const n = await page.locator('.state-panel').getAttribute('data-run').then(Number, () => 0);
  await page.selectOption('#example', name);
  await page.waitForFunction(k => { const p = document.querySelector('.state-panel'); return p && +p.dataset.run > k && !p.classList.contains('stale') && !!document.querySelector('#stateBody'); }, n, { timeout: 8000 });
};
/** Finished runs so far; take it BEFORE an edit and pass it to settled(). */
const runs = async () => +(await page.locator('.state-panel').getAttribute('data-run'));
/** Wait until a run newer than `since` has finished for the current code, and its state is shown. */
const settled = since => page.waitForFunction(n => {
  const p = document.querySelector('.state-panel');
  return +p.dataset.run > n && !p.classList.contains('stale') && !!document.querySelector('#stateBody');
}, since, { timeout: 8000 });
/** Edit the code, then wait until it has been run. */
const edit = async (fn, wait = settled) => { const n = await runs(); await fn(); await wait(n); };
/**
 * Replace the whole program. Select-all goes through CodeMirror's own keymap (page.fill's DOM selection could race
 * CodeMirror under load and leave old code behind), and short programs are checked line by line afterwards.
 */
const replaceCode = async code => {
  await page.locator('#editor').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(code);
  const lines = code.split('\n');
  if (lines.length <= 30) {
    await page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.cm-line')].map(l => l.textContent)) === want,
      JSON.stringify(lines), { timeout: 3000 }).catch(() => { throw new Error('the editor does not hold exactly the new code: ' + code); });
  }
};
const typeCode = code => edit(() => replaceCode(code));
const bannerMatches = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('#banner')?.textContent || ''), re.source, { timeout: 8000 });

await page.goto(pathToFileURL(target).href);

// 0. the page starts empty: no code, no example, nothing to step, no error
await page.waitForSelector('#placeholder');
assert.equal(await page.title(), 'Algorithm visualizer', 'the browser tab says what the page is');
assert.equal(await page.locator('.site-header h1').innerText(), 'Algorithm visualizer');
assert.equal(await page.locator('#example').inputValue(), '', 'no example picked');
assert.deepEqual(await page.locator('.cm-line').evaluateAll(ls => ls.map(l => { const c = l.cloneNode(true); c.querySelectorAll('.cm-placeholder').forEach(x => x.remove()); return c.textContent; })),
  [''], 'the editor is empty (apart from its placeholder hint)');
assert.match(await page.locator('.cm-placeholder').innerText(), /^Write or paste your code, or pick an example above$/);
assert.equal(await page.locator('#banner, #stateBody').count(), 0);
assert.ok(await page.locator('#transport').isVisible(), 'the timeline is shown even with no code');
assert.equal(await page.locator('#stepLabel').innerText(), 'No steps yet');
assert.ok(await page.locator('#bPlay').isDisabled() && await page.locator('#scrub').isDisabled(), 'with nothing to step, its controls are disabled');
await snap('00-empty');

// 1. an example is traced and shown at step 1
await pick('Bubble sort');
assert.match(await stepLabel(), /^Step 1 of \d+/);
assert.ok(await page.locator('.cm-line.cm-step-cur').count() === 1, 'one current line');
assert.equal(await page.locator('.cm-line[aria-current="step"]').count(), 1, 'current line is aria-current');
assert.equal(await page.locator('#editor').getAttribute('contenteditable'), 'true', 'the code is always editable');
assert.equal(await page.locator('#btnEdit, #btnRun').count(), 0, 'no Edit code / Visualize button');
await page.click('#bNext'); await page.click('#bNext'); await page.click('#bNext');   // until arr exists
assert.equal(await page.locator('button[data-vt="arr|memory"]').getAttribute('aria-pressed'), 'true', 'containers start in Memory');
assert.match(await page.locator('.var:has(button[data-vt="arr|memory"]) .gcap').innerText(), /Memory layout/);
await page.click('#bFirst');
await snap('01-bubble-sort-start');

// 1a. full-window layout: editor on the left, debugger on the right, the timeline along the bottom; the page does not scroll
const lay = await page.evaluate(() => {
  const r = s => document.querySelector(s).getBoundingClientRect();
  return { scroll: document.documentElement.scrollHeight - innerHeight, code: r('.code-panel'), debug: r('.debug'), transport: r('#transport'), vh: innerHeight, vw: innerWidth };
});
assert.ok(lay.scroll <= 0, 'the page does not scroll: ' + lay.scroll);
assert.ok(lay.code.right <= lay.debug.left && Math.abs(lay.code.top - lay.debug.top) < 1, 'editor left, debugger right, side by side');
assert.ok(Math.abs(lay.code.bottom - lay.debug.bottom) < 1 && lay.code.bottom <= lay.transport.top, 'both columns end above the timeline');
assert.ok(lay.transport.left <= 0 && lay.transport.right >= lay.vw && Math.abs(lay.transport.bottom - lay.vh) < 1, 'the timeline spans the bottom of the window');

// 1b. a text selection stays visible across the current line (CodeMirror draws it beneath the lines)
await page.locator('.cm-line.cm-step-cur').click();
await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowUp'); await page.keyboard.press('Shift+End');
const selection = () => {                                         // CodeMirror draws the selection layer in its next frame
  const cur = document.querySelector('.cm-line.cm-step-cur'), r = cur.getBoundingClientRect();
  const over = [...document.querySelectorAll('.cm-selectionBackground')].some(b => { const q = b.getBoundingClientRect(); return q.width > 0 && q.top < r.bottom && q.bottom > r.top; });
  const bg = getComputedStyle(cur).backgroundColor, sb = document.querySelector('.cm-selectionBackground');
  return over && { bg, sel: getComputedStyle(sb).backgroundColor };
};
const sel = await (await page.waitForFunction(selection, null, { timeout: 3000 }).catch(() => null))?.jsonValue();
assert.ok(sel, 'the selection covers the current line');
const alpha = c => { const a = c.match(/\/\s*([\d.]+)\s*\)$/) || c.match(/^rgba\([^)]*,\s*([\d.]+)\)$/); return a ? +a[1] : 1; };   // color(srgb r g b / a), rgba(r, g, b, a)
assert.ok(alpha(sel.bg) < 0.5, 'the current line is translucent, so the selection shows through: ' + sel.bg);
assert.notEqual(sel.bg, sel.sel, 'selection and current line are different colours');
await page.locator('#bNext').focus();                            // leave the editor for the keyboard checks below

// 1c. the ? next to Variables explains when a value becomes a graph
const helpOpen = () => page.evaluate(() => document.querySelector('#graphHelp').matches(':popover-open'));
await page.click('#graphHelpBtn');
assert.ok(await helpOpen(), 'help opens');
const hb = await page.locator('#graphHelp').boundingBox();
assert.ok(hb.x >= 0 && hb.y >= 0 && hb.x + hb.width <= 1280 && hb.y + hb.height <= 900, 'help fits in the window: ' + JSON.stringify(hb));
assert.match(await page.locator('#graphHelp').innerText(), /How to see your data as a graph[\s\S]*Memory[\s\S]*A list of neighbours[\s\S]*Lists of numbers/);
await page.locator('#graphHelp').evaluate(e => { e.scrollTop = 10; e.dispatchEvent(new Event('scroll')); });
assert.ok(await helpOpen(), 'scrolling the help itself keeps it open');
await page.keyboard.press('Escape');
assert.ok(!(await helpOpen()), 'Escape closes it');
await page.click('#graphHelpBtn'); await page.mouse.click(300, 60);
assert.ok(!(await helpOpen()), 'a click outside closes it');
await page.click('#graphHelpBtn');
const gap = async () => page.evaluate(() => document.querySelector('#graphHelp').getBoundingClientRect().top - document.querySelector('#graphHelpBtn').getBoundingClientRect().bottom);
const gap0 = await gap();
await page.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollBy(0, 120); });
await page.waitForTimeout(100);
assert.ok(await helpOpen(), 'scrolling the page does not close it');
assert.ok(Math.abs((await gap()) - gap0) < 1, 'it stays attached to its button while the page scrolls');
await page.keyboard.press('Escape');
await page.evaluate(() => { window.scrollTo(0, 0); document.body.style.minHeight = ''; });
await page.click('#graphHelpBtn');
const gap1 = await gap();
await page.evaluate(() => { const sp = document.querySelector('.state-panel'); sp.style.paddingBottom = '2000px'; sp.scrollTop = 40; });
await page.waitForTimeout(100);
assert.ok(await helpOpen() && Math.abs((await gap()) - gap1) < 1, 'it follows its button when the debugger panel scrolls');
await page.keyboard.press('Escape');
await page.evaluate(() => { const sp = document.querySelector('.state-panel'); sp.scrollTop = 0; sp.style.paddingBottom = ''; });

// 1d. the i next to the Language picker says what the language includes and what it does not
const infoOpen = () => page.evaluate(() => document.querySelector('#langInfo').matches(':popover-open'));
await page.click('#langInfoBtn');
assert.ok(await infoOpen(), 'language info opens');
const ib = await page.locator('#langInfo').boundingBox(), ibtn = await page.locator('#langInfoBtn').boundingBox();
assert.ok(ib.x >= 0 && ib.x + ib.width <= 1280 && ib.y + ib.height <= 900 && ib.y >= ibtn.y + ibtn.height, 'it fits in the window, under its button: ' + JSON.stringify(ib));
assert.match(await page.locator('#langInfo').innerText(), /What JavaScript includes[\s\S]*Included[\s\S]*Not included[\s\S]*no DOM/);
await snap('16-lang-info');
await page.keyboard.press('Escape');
assert.ok(!(await infoOpen()), 'Escape closes it');

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
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').first().innerText(), /Graph · 6 nodes · 7 edges/);
const graphCard = page.locator('.var:has(button[data-vt="graph|boxes"])');
assert.ok(await graphCard.locator('.g-snode').count() === 6, 'six nodes drawn');
assert.ok(await graphCard.locator('path.g-edge').count() === 7, 'seven edges drawn');
assert.ok(await graphCard.locator('.g-pilltxt').count() > 0, 'variable tags on nodes');
assert.equal(await page.locator('button[data-vt="queue|memory"]').getAttribute('aria-pressed'), 'true', 'other variables keep the default (Memory)');
assert.equal(await page.locator('button[data-vt="queue|graph"]').count(), 0, 'a queue of names is not a graph, so it has no Graph button');
await snap('02-bfs-graph');
await page.locator('button[data-vt="graph|memory"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').first().innerText(), /Memory layout/);
await snap('03-bfs-memory');

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

// 5. editing resets the run: arrow keys in the editor move the cursor, a change runs the code again from step 1
const before = await stepLabel();
await page.click('.cm-line >> nth=0');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
assert.equal(await stepLabel(), before, 'arrow keys in the editor do not step');
const n5 = await runs();
await page.keyboard.press('Control+End'); await page.keyboard.type('\nlet extra = 1;');
assert.equal(await page.locator('.cm-step-cur').count(), 0, 'the old current line is gone as soon as the code changes');
await page.waitForSelector('.state-panel.stale', { timeout: 2000 });   // lasts at least the re-run delay
assert.ok(await page.locator('#bNext').isDisabled(), 'stepping waits for the new run');
await settled(n5);
assert.match(await stepLabel(), /^Step 1 of/, 'back to step 1');
await page.click('#bLast');
assert.match(await page.locator('#stateBody').innerText(), /extra/, 'the edited code is what ran');
assert.equal(await page.locator('button[data-vt="list|graph"]').getAttribute('aria-pressed'), 'true', 'view choices survive a re-run');

// 5b. your own code, including a tree
await typeCode('const t = {v:1, left:{v:2, left:{v:4}, right:{v:5}}, right:{v:3}};\nlet cur = t.left;\ncur = cur.right;');
await page.click('#bLast');
await page.locator('button[data-vt="t|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="t|boxes"]) .gcap').first().innerText(), /Tree · 5 nodes · 4 edges/);
await snap('05-tree');

// 5c. clearing the editor goes back to the empty state, without an error
await page.locator('#editor').focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
await page.waitForSelector('#placeholder', { timeout: 8000 });
assert.equal(await page.locator('#banner').count(), 0, 'no error banner for an empty editor');
assert.equal(await page.locator('#stepLabel').innerText(), 'No steps yet', 'the timeline stays, with nothing to step');

// 6. errors are shown, not swallowed
await replaceCode('let = = 3');
await bannerMatches(/Syntax error/);
assert.equal(await page.locator('#stateBody').count(), 0, 'no stale state next to an error');

// 6b. an infinite loop is stopped instead of freezing the page, and newer code replaces a run in progress
await replaceCode('let n = 0;\nwhile (true) { }');
await bannerMatches(/Stopped after/);
await typeCode('let ok = 1;');                                  // the page is still responsive afterwards
await replaceCode('while (true) { }');
await page.waitForTimeout(600);                                  // that run has started…
await typeCode('let fast = 2;');                                // …and the newer code wins (runner.js also terminates the old worker)
await page.click('#bLast');
assert.match(await page.locator('#stateBody').innerText(), /fast/);

// 6c. editor keys: Tab indents with two spaces, Ctrl+Enter runs at once
await typeCode('let a = 1;');
const ed = page.locator('#editor');
await edit(async () => { await ed.press('End'); await ed.press('Enter'); await ed.press('Tab'); await ed.pressSequentially('a = 2;'); });
assert.equal(await page.locator('.cm-line').nth(1).innerText(), '  a = 2;');
await page.click('#bLast'); assert.match(await stepLabel(), /done$/);
const n6 = await runs();
await ed.press('Control+Enter');                                 // same code: runs again at once, from step 1
await settled(n6);
assert.match(await stepLabel(), /^Step 1 of/);

// 6d. a long program: the current line is scrolled into view
await typeCode(Array.from({ length: 120 }, (_, i) => `let v${i} = ${i};`).join('\n'));
await page.click('#bLast'); await page.click('#bPrev');                // the last step ("done") has no line
const curInView = () => page.waitForFunction(() => {           // CodeMirror scrolls in its next measure frame
  const s = document.querySelector('.cm-scroller').getBoundingClientRect(), c = document.querySelector('.cm-line.cm-step-cur')?.getBoundingClientRect();
  return !!c && c.top >= s.top && c.bottom <= s.bottom;
}, null, { timeout: 2000 }).then(() => true, () => false);
assert.ok(await curInView(), 'last line scrolled into view');
assert.ok(await page.locator('.cm-scroller').evaluate(e => e.scrollTop > 0), 'the editor scrolled');
await page.click('#bFirst');
assert.ok(await curInView(), 'first line scrolled back into view');

// 6e. the Data structures example: graphs, a tree, a list and plain data side by side
await pick('Data structures');
await page.click('#bLast');
for (const v of ['g1', 'tree', 'list', 'tasks']) assert.equal(await page.locator(`button[data-vt="${v}|graph"]`).count(), 1, v + ' can be shown as a graph');
assert.equal(await page.locator('button[data-vt="nums|graph"]').count(), 0, 'plain data has no Graph button');
await page.locator('button[data-vt="tree|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="tree|boxes"]) .gcap').innerText(), /Tree · 4 nodes · 3 edges/);
await page.locator('button[data-vt="weightedNodes|graph"]').click();
const wn = (await page.locator('.var:has(button[data-vt="weightedNodes|boxes"]) svg text').allTextContents()).join(' ');
for (const want of ['id', 'weight', '3', '5']) assert.ok(wn.includes(want), want + ' inside the weightedNodes nodes');
await page.locator('button[data-vt="intervals|graph"]').click();
const iv = await page.locator('.var:has(button[data-vt="intervals|boxes"]) svg text').allTextContents();
assert.ok(iv.includes('start 0') && iv.includes('end 3'), 'edge data on the intervals arrows');

// 6h. breakpoints: set from the gutter, jump with continue / previous (and F8), Play pauses on them, ticks on the timeline
await pick('Bubble sort');
const dots = () => page.locator('.cm-bp-dot:visible').count();       // CodeMirror keeps one invisible spacer in the gutter
assert.ok(await page.locator('#bBpNext').isDisabled(), 'continue is disabled until there is a breakpoint');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^8$/ }).click();   // arr[j] = arr[j + 1];
assert.equal(await dots(), 1, 'clicking a line number sets a breakpoint');
const nTicks = await page.locator('.bp-tick').count();
assert.ok(nTicks >= 2, 'a tick on the timeline for each time the line runs: ' + nTicks);
await page.click('#bBpNext'); const hit1 = await stepLabel();
assert.match(hit1, /· line 8$/, 'continue stops on the breakpoint line');
await page.click('#bBpNext'); const hit2 = await stepLabel();
assert.match(hit2, /· line 8$/); assert.notEqual(hit2, hit1, 'and the next time on to the next hit');
await page.click('#bBpPrev'); assert.equal(await stepLabel(), hit1, 'previous goes back to the earlier hit');
await page.click('#bFirst'); await page.selectOption('#speed', '50'); await page.click('#bPlay');
await page.waitForFunction(() => document.querySelector('#bPlay').getAttribute('aria-label') === 'Play', null, { timeout: 5000 });
assert.equal(await stepLabel(), hit1, 'Play pauses when it reaches a breakpoint');
await page.selectOption('#speed', '500');
await page.locator('body').press('F8'); assert.equal(await stepLabel(), hit2, 'F8 continues');
await page.locator('body').press('Shift+F8'); assert.equal(await stepLabel(), hit1, 'Shift+F8 goes back');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^8$/ }).click();
assert.equal(await dots(), 0, 'clicking again removes it');
assert.ok(await page.locator('#bBpNext').isDisabled());
await page.click('.cm-line >> nth=7'); await page.keyboard.press('F9');
assert.equal(await dots(), 1, 'F9 toggles a breakpoint on the cursor line');
const nEnter = await runs();
await page.keyboard.press('Home'); await page.keyboard.press('Home');            // the first Home stops at the indentation
await page.keyboard.press('Enter');                                              // push the marked line down
await settled(nEnter);
const marked = await page.evaluate(() => [...document.querySelectorAll('.cm-bp-gutter .cm-gutterElement')].filter(e => e.querySelector('.cm-bp-dot') && getComputedStyle(e).visibility !== 'hidden')
  .map(e => e.getBoundingClientRect().top));
const line9 = await page.locator('.cm-line >> nth=8').boundingBox();
assert.ok(marked.length === 1 && Math.abs(marked[0] - line9.y) < 4, 'the breakpoint moves down with its code');
await page.click('#bBpNext'); assert.match(await stepLabel(), /· line 9$/, 'and continue now stops on line 9');
await pick('Reverse a linked list');
assert.equal(await dots(), 0, 'loading an example clears the breakpoints');

// 6g. the divider between the editor and the debugger: drag, keys (which must not step), double-click to reset, remembered
const widths = () => page.evaluate(() => ['.code-panel', '.debug'].map(q => document.querySelector(q).getBoundingClientRect().width));
const [w0] = await widths();
const sp = await page.locator('.splitter').boundingBox();
await page.mouse.move(sp.x + sp.width / 2, sp.y + sp.height / 2); await page.mouse.down();
await page.mouse.move(420, sp.y + sp.height / 2, { steps: 6 }); await page.mouse.up();
const [w1, d1] = await widths();
assert.ok(w1 < w0 - 150 && d1 > w0 + 150, `dragging left narrows the editor and widens the debugger: ${w0} → ${w1} / ${d1}`);
const label0 = await stepLabel(), v0 = +(await page.locator('.splitter').getAttribute('aria-valuenow'));
await page.locator('.splitter').focus(); await page.keyboard.press('ArrowRight');
assert.ok(Math.abs(+(await page.locator('.splitter').getAttribute('aria-valuenow')) - (v0 + 2)) <= 1, 'ArrowRight widens the editor by 2%');
assert.equal(await stepLabel(), label0, 'arrow keys on the divider do not step the program');
assert.ok(Math.abs(+(await page.evaluate(() => localStorage.getItem('algorithm-stepper.split'))) - (v0 + 2)) <= 1, 'the position is remembered');
await page.locator('.splitter').dblclick();
const [w2, d2] = await widths();
assert.ok(Math.abs(w2 - d2) < 1, 'double-click resets to half and half');

// 6i. Python: the same views, traced by Pyodide (here served from node_modules/pyodide)
await page.evaluate(() => {                         // remember whether the "Loading Python" banner was shown
  window.__sawLoading = false;
  new MutationObserver(() => { if (/Loading Python/.test(document.querySelector('#banner')?.textContent || '')) window.__sawLoading = true; })
    .observe(document.body, { subtree: true, childList: true, characterData: true });
});
assert.equal(await page.locator('#example').inputValue(), 'Reverse a linked list');
const nPy = await runs();
await page.selectOption('#lang', 'python');          // an open example is swapped for its Python twin
await page.waitForFunction(k => +document.querySelector('.state-panel').dataset.run > k && !document.querySelector('.state-panel.stale'), nPy, { timeout: 60000 });
assert.ok(await page.evaluate(() => window.__sawLoading), 'the first Python run says Python is loading');
assert.equal(await page.locator('.cm-line').first().innerText(), 'class Node:', 'the Python version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.equal(await page.evaluate(() => localStorage.getItem('algorithm-stepper.lang')), 'python', 'the language is remembered');
await page.click('#bLast');
await page.locator('button[data-vt="head|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="head|boxes"]) .gcap').innerText(), /^Linked list · 3 nodes/);
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every list, tuple, dict, set and object[\s\S]*\{"val": 1, "next": \{"val": 2, "next": None\}\}/, 'the help speaks Python');
await page.keyboard.press('Escape');
await pick('Breadth-first search');
for (let i = 0; i < 20; i++) await page.click('#bNext');
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/);
assert.match(await page.locator('.var:has(button[data-vt="queue|boxes"]) svg').textContent(), /deque\(/, 'Memory names Python types');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();   // order.append(cur)
await page.click('#bFirst'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 18$/, 'breakpoints work in Python too');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();
await replaceCode('def f(:\n    pass');
await bannerMatches(/Syntax error: invalid syntax \(line 1\)/);
await typeCode('while True:\n    pass');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Trace stopped after 3000 steps/, 'a runaway Python loop is stopped');
await typeCode('x = 1\ny = x / 0');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /ZeroDivisionError: division by zero/);
await page.selectOption('#lang', 'javascript');      // own (or edited) code is kept when switching back, never replaced
await page.waitForFunction(() => !document.querySelector('.state-panel.stale'), null, { timeout: 8000 });
assert.equal(await page.locator('.cm-line').first().innerText(), 'x = 1');

// 6j. TypeScript: types are stripped and the JavaScript tracer runs, with the TypeScript line numbers
await pick('Breadth-first search');
const nTs = await runs();
await page.selectOption('#lang', 'typescript');      // the untouched example is swapped for its typed twin
await settled(nTs);
assert.equal(await page.locator('.cm-line').first().innerText(), 'type Graph = Record<string, string[]>;');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^TypeScript code$/);
for (let i = 0; i < 14; i++) await page.click('#bNext');
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();   // order.push(cur), below a type alias
await page.click('#bFirst'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 18$/, 'breakpoints hit the TypeScript line');
assert.equal(await page.locator('.cm-line.cm-step-cur').innerText(), '    order.push(cur);', 'and the highlighted line is that line');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();
await replaceCode('let x: = 1;');
await bannerMatches(/Syntax error: Unexpected token/);
await page.selectOption('#lang', 'javascript');

// 6k. Lua: traced in Fengari; tables count from 1
await pick('Breadth-first search');
const nLua = await runs();
await page.selectOption('#lang', 'lua');
await settled(nLua);
assert.equal(await page.locator('.cm-line').first().innerText(), 'local graph = {');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
for (let i = 0; i < 14; i++) await page.click('#bNext');
const gIdx = await page.locator('.var:has(button[data-vt="graph|boxes"]) .g-idx').allTextContents();
assert.deepEqual(gIdx.slice(0, 2), ['1', '2'], 'Memory numbers a Lua table from 1 (graph.A = {"B", "C"})');
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();   // order[#order + 1] = cur
await page.click('#bFirst'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 16$/, 'breakpoints work in Lua');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every table in your code[\s\S]*\{A = \{"B", "C"\}/, 'the help speaks Lua');
await page.keyboard.press('Escape');
await replaceCode('local x = = 1');
await bannerMatches(/Syntax error: line 1: unexpected symbol near '='/);
await page.selectOption('#lang', 'javascript');

// 6l. Ruby: traced by ruby.wasm (here served from node_modules/@ruby)
await pick('Breadth-first search');
await page.evaluate(() => {                         // remember whether the "Loading Ruby" banner was shown
  window.__sawLoading = false;
  new MutationObserver(() => { if (/Loading Ruby/.test(document.querySelector('#banner')?.textContent || '')) window.__sawLoading = true; })
    .observe(document.body, { subtree: true, childList: true, characterData: true });
});
const nRb = await runs();
await page.selectOption('#lang', 'ruby');
await page.waitForFunction(k => +document.querySelector('.state-panel').dataset.run > k && !document.querySelector('.state-panel.stale'), nRb, { timeout: 60000 });
assert.ok(await page.evaluate(() => window.__sawLoading), 'the first Ruby run says Ruby is loading');
assert.equal(await page.locator('.cm-line').first().innerText(), 'require "set"', 'the Ruby version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^Ruby code$/);
for (let i = 0; i < 14; i++) await page.click('#bNext');
await page.locator('button[data-vt="GRAPH|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="GRAPH|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'symbols name the nodes');
await snap('07-ruby');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();   // order << cur
await page.click('#bFirst'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 18$/, 'breakpoints work in Ruby');
assert.equal(await page.locator('.cm-line.cm-step-cur').innerText(), '    order << cur');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(start=:a\)$/, 'the call stack shows the method and its arguments');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^18$/ }).click();
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, hash, set and object[\s\S]*\{ val: 1, next: \{ val: 2, next: nil \} \}/, 'the help speaks Ruby');
await page.keyboard.press('Escape');
await replaceCode('x = = 1');
await bannerMatches(/Syntax error: line 1: /);
await typeCode('i = 0\nloop { i += 1 }');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Trace stopped after 3000 steps/, 'a runaway Ruby loop is stopped');
await replaceCode('while true; end');                 // no line events at all: only the time limit stops it
await bannerMatches(/Stopped after 3 seconds/);
await edit(() => replaceCode('x = 1\ny = x / 0'),    // the stopped worker is replaced, so Ruby starts again
  n => page.waitForFunction(k => +document.querySelector('.state-panel').dataset.run > k && !document.querySelector('.state-panel.stale'), n, { timeout: 60000 }));
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /ZeroDivisionError: divided by 0/);
await page.selectOption('#lang', 'javascript');

// 6n. PHP: traced by php-wasm (here served from node_modules/php-wasm); the program is rewritten with a step before each statement
await pick('Breadth-first search');
await page.evaluate(() => {                         // remember whether the "Loading PHP" banner was shown
  window.__sawLoading = false;
  new MutationObserver(() => { if (/Loading PHP/.test(document.querySelector('#banner')?.textContent || '')) window.__sawLoading = true; })
    .observe(document.body, { subtree: true, childList: true, characterData: true });
});
const nPhp = await runs();
await page.selectOption('#lang', 'php');
await page.waitForFunction(k => +document.querySelector('.state-panel').dataset.run > k && !document.querySelector('.state-panel.stale'), nPhp, { timeout: 60000 });
assert.ok(await page.evaluate(() => window.__sawLoading), 'the first PHP run says PHP is loading');
assert.equal(await page.locator('.cm-line').first().innerText(), '<?php', 'the PHP version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^PHP code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^19$/ }).click();   // $order[] = $cur;
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 19$/, 'breakpoints work in PHP');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(\$graph=\[.*\$start="A"\)$/, 'the call stack shows the function and its parameters');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^19$/ }).click();
await page.locator('button[data-vt="$graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="$graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/);
assert.ok(await page.locator('.var:has(button[data-vt="$graph|boxes"]) text', { hasText: '∈ $visited' }).count() > 0, '[$name => true] tags the visited nodes');
await snap('10-php');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array and object[\s\S]*\['val' => 1, 'next' => \['val' => 2, 'next' => null\]\]/, 'the help speaks PHP');
await page.keyboard.press('Escape');
await replaceCode('<?php\n$x = = 1;');
await bannerMatches(/Syntax error: line 2: syntax error, unexpected token "="/);
await typeCode('<?php\nwhile (true) { $i = 1; }');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Trace stopped after 3000 steps/, 'a runaway PHP loop is stopped');
await typeCode('<?php\n$x = 1;\n$y = intdiv($x, 0);');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /DivisionByZeroError: Division by zero on line 3/);
await page.selectOption('#lang', 'javascript');

// 6m. C: run by its own interpreter in the worker, offline; pointers are arrows, malloc'd memory has an #id
await pick('Reverse a linked list');
const nC = await runs();
await page.selectOption('#lang', 'c');
await settled(nC);
assert.equal(await page.locator('.cm-line').first().innerText(), '#include <stdio.h>', 'the C version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^C code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^23$/ }).click();   // curr->next = prev;
await page.click('#bBpNext'); await page.click('#bBpNext');            // a fresh run starts at step 1: on to the second hit
assert.match(await stepLabel(), /· line 23$/, 'breakpoints work in C');
assert.equal(await page.locator('#stack .frame.top').innerText(), 'main()', 'main is a frame of its own');
assert.match(await page.locator('.var:has(button[data-vt="curr|boxes"]) svg').textContent(), /Node/, 'Memory names the struct type');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^23$/ }).click();
await page.click('#bLast');
await page.locator('button[data-vt="prev|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="prev|boxes"]) .gcap').innerText(), /^Linked list · 3 nodes/, 'pointers between structs make a graph');
await snap('08-c');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, struct and pointer[\s\S]*struct Node \{ int val; struct Node \*next; \};/, 'the help speaks C');
await page.keyboard.press('Escape');
await pick('Breadth-first search');
for (let i = 0; i < 12; i++) await page.click('#bNext');
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'an adjacency matrix is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'bool visited[N] tags the visited nodes');
await snap('09-c-bfs');
await replaceCode('int main(void) {\n    int x = = 1;\n}');
await bannerMatches(/Syntax error: line 2: expected an expression before '='/);
await typeCode('int main(void) {\n    int a[3] = {1, 2, 3};\n    int i = 3;\n    a[i] = 4;\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Error on line 4: a\[3\] is out of bounds: a has 3 elements \(indexes 0 to 2\)/);
await typeCode('int main(void) {\n    while (1);\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Trace stopped after 3000 steps/, 'a runaway C loop is stopped');
await page.selectOption('#lang', 'javascript');

// 6p. Java: its own interpreter, with Java's library; objects linked by references are graphs
await pick('Breadth-first search');
const nJava = await runs();
await page.selectOption('#lang', 'java');
await settled(nJava);
assert.equal(await page.locator('.cm-line').first().innerText(), 'import java.util.*;', 'the Java version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^Java code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^12$/ }).click();   // order.add(cur);
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 12$/, 'breakpoints work in Java');
assert.match(await page.locator('#stack .frame.top').innerText(), /^Main\.bfs\(start="A"\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^12$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a Map<String, List<String>> is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a HashSet tags the visited nodes');
await snap('12-java');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, List, Map, Set, Deque and object/, 'the help speaks Java');
await page.keyboard.press('Escape');
await typeCode('import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        List<Integer> l = new ArrayList<>(List.of(1, 2, 3, 4));\n        for (int x : l) if (x == 1) l.remove(0);\n    }\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /java\.util\.ConcurrentModificationException/, 'changing a list in its for-each is caught, as in Java');
await replaceCode('public class Main {\n    public static void main(String[] args) {\n        int x = 1\n    }\n}');
await bannerMatches(/Syntax error: line 3: ';' expected at the end of the line/);
await page.selectOption('#lang', 'javascript');

// 6s. Kotlin: its own interpreter, with the JVM's collections; a map of lists is a graph, a set tags what it holds
await pick('Breadth-first search');
const nKt = await runs();
await page.selectOption('#lang', 'kotlin');
await settled(nKt);
assert.equal(await page.locator('.cm-line').first().innerText(), 'val graph = mapOf(', 'the Kotlin version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^Kotlin code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();   // order.add(cur)
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 16$/, 'breakpoints work in Kotlin');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(start="A"\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a Map<String, List<String>> is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a set tags the visited nodes');
await snap('15-kotlin');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every list, map, set, array and object/, 'the help speaks Kotlin');
await page.keyboard.press('Escape');
await typeCode('fun main() {\n    val m = mapOf("a" to 1)\n    println(m.getValue("b"))\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Exception in thread "main" java\.util\.NoSuchElementException: Key b is missing in the map\. \(line 3\)/, 'an exception, as the JVM words it');
await replaceCode('fun main() {\n    val x = 1 2\n}');
await bannerMatches(/Syntax error: line 2: unexpected tokens/);
await page.selectOption('#lang', 'javascript');

// 6t. Swift: its own interpreter; arrays and dictionaries are values, a dictionary of arrays is a graph, a Set tags what it holds
await pick('Breadth-first search');
const nSw = await runs();
await page.selectOption('#lang', 'swift');
await settled(nSw);
assert.equal(await page.locator('.cm-line').first().innerText(), 'let graph: [String: [String]] = [', 'the Swift version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^Swift code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();   // order.append(cur)
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 16$/, 'breakpoints work in Swift');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(start="A"\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^16$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a [String: [String]] is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a Set tags the visited nodes');
await snap('17-swift');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, dictionary, set, struct and object/, 'the help speaks Swift');
await page.keyboard.press('Escape');
await page.click('#langInfoBtn');
assert.match(await page.locator('#langInfo').innerText(), /What Swift includes[\s\S]*Optionals[\s\S]*Not included[\s\S]*async \/ await/, 'the language info speaks Swift');
await page.keyboard.press('Escape');
await typeCode('let a = [1, 2, 3]\nprint(a[5])');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Fatal error: Index out of range \(line 2\)/, 'a fatal error, as the Swift runtime words it');
await replaceCode('let x = 1 2');
await bannerMatches(/Syntax error: line 1: consecutive statements on a line must be separated by ';'/);
await page.selectOption('#lang', 'javascript');

// 6r. C#: its own interpreter, with .NET's library; a Dictionary of Lists is a graph, a HashSet tags what it holds
await pick('Breadth-first search');
const nCs = await runs();
await page.selectOption('#lang', 'csharp');
await settled(nCs);
assert.equal(await page.locator('.cm-line').first().innerText(), 'var graph = new Dictionary<string, List<string>>', 'the C# version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^C# code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^20$/ }).click();   // order.Add(cur);
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 20$/, 'breakpoints work in C#');
assert.match(await page.locator('#stack .frame.top').innerText(), /^Bfs\(start="A"\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^20$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a Dictionary<string, List<string>> is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a HashSet tags the visited nodes');
await snap('14-csharp');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, List, Dictionary, HashSet, Queue, Stack and object/, 'the help speaks C#');
await page.keyboard.press('Escape');
await typeCode('var d = new Dictionary<string, int>();\nConsole.WriteLine(d["missing"]);');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Unhandled exception\. System\.Collections\.Generic\.KeyNotFoundException: The given key 'missing' was not present in the dictionary\. \(line 2\)/, 'an exception, as .NET words it');
await typeCode('Console.WriteLine("start");\nint x = 3.5;');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Error on line 2: CS0266: Cannot implicitly convert type 'double' to 'int'/, 'what the compiler would refuse');
await replaceCode('int a = 1\nConsole.WriteLine(a);');
await bannerMatches(/Syntax error: line 1: CS1002: ; expected/);
await page.selectOption('#lang', 'javascript');

// 6q. Go: its own interpreter, with fmt, sort, strings…; a map of slices is a graph, a map[string]bool tags what it holds
await pick('Breadth-first search');
const nGo = await runs();
await page.selectOption('#lang', 'go');
await page.click('#langInfoBtn');
assert.match(await page.locator('#langInfo').innerText(), /What Go includes[\s\S]*Goroutines, channels and select/, 'the language info follows the picker');
await page.keyboard.press('Escape');
await settled(nGo);
assert.equal(await page.locator('.cm-line').first().innerText(), 'package main', 'the Go version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^Go code$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^21$/ }).click();   // order = append(order, cur)
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 21$/, 'breakpoints work in Go');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(start="A"\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^21$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a map[string][]string is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a map[string]bool tags the visited nodes');
await snap('13-go');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every slice, array, map, struct and pointer/, 'the help speaks Go');
await page.keyboard.press('Escape');
await pick('Reverse a linked list');
await page.click('#bLast');
await page.locator('button[data-vt="prev|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="prev|boxes"]) .gcap').innerText(), /^Linked list · 3 nodes/, 'structs linked by pointers');
await typeCode('package main\n\nimport "fmt"\n\nfunc main() {\n    a := []int{1, 2, 3}\n    i := 5\n    fmt.Println(a[i])\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /panic: runtime error: index out of range \[5\] with length 3 \(line 8\)/, 'a panic, as Go words it');
await replaceCode('package main\n\nfunc main() {\n    x := 5\n}');
await bannerMatches(/Syntax error: line 4: declared and not used: x/);
await replaceCode('package main\n\nfunc main() {\n    for {\n    }\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Trace stopped after 3000 steps/, 'a runaway Go loop is stopped');
await page.selectOption('#lang', 'javascript');

// 6o. C++: the C interpreter with classes and the standard library; a vector is an array, its iterators are tags
await pick('Reverse a linked list');
const nCpp = await runs();
await page.selectOption('#lang', 'cpp');
await settled(nCpp);
assert.equal(await page.locator('.cm-line').first().innerText(), '#include <iostream>', 'the C++ version of the example');
assert.match(await page.locator('.site-header p').innerText(), /^Visualize any algorithm by stepping through your code/, 'the subtitle is the same in every language');
assert.match(await page.locator('.cm-content').getAttribute('aria-label'), /^C\+\+ code$/);
await page.click('#bLast');
await page.locator('button[data-vt="prev|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="prev|boxes"]) .gcap').innerText(), /^Linked list · 3 nodes/, 'objects made with new, linked by pointers');
await pick('Breadth-first search');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^25$/ }).click();   // order.push_back(cur);
await page.click('#bBpNext'); await page.click('#bBpNext');
assert.match(await stepLabel(), /· line 25$/, 'breakpoints work in C++');
assert.match(await page.locator('#stack .frame.top').innerText(), /^bfs\(start='A'\)$/);
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^25$/ }).click();
await page.locator('button[data-vt="graph|graph"]').click();
assert.match(await page.locator('.var:has(button[data-vt="graph|boxes"]) .gcap').innerText(), /Graph · 6 nodes · 7 edges/, 'a map<char, vector<char>> is a graph');
assert.ok(await page.locator('.var:has(button[data-vt="graph|boxes"]) text', { hasText: '∈ visited' }).count() > 0, 'a set<char> tags the visited nodes');
await snap('11-cpp');
await page.click('#graphHelpBtn');
assert.match(await page.locator('#graphHelp').innerText(), /Every array, vector, map, set, string, struct and pointer/, 'the help speaks C++');
await page.keyboard.press('Escape');
await typeCode('#include <vector>\nint main() {\n    std::vector<int> v = {1, 2, 3};\n    int& r = v[0];\n    v.push_back(4);\n    r = 9;\n}');
await page.click('#bLast');
assert.match(await page.locator('#banner').innerText(), /Error on line 6: r is in memory that v gave up when it grew on line 5/, 'a stale reference is caught');
await page.selectOption('#lang', 'javascript');

// 6u. the call tree: a recursive program shows it first; each call under its caller, finished ones with what they returned
await pick('Fibonacci with memo');
assert.equal(await page.locator('.state-panel .sect-head h2').first().innerText(), 'Call tree');
for (let i = 0; i < 25; i++) await page.click('#bNext');
assert.match(await page.locator('#callTree .gcap').innerText(), /^\d+ calls so far · \d+ repeated/, 'memo hits are calls with the same arguments as an earlier one');
assert.equal(await page.locator('#callTree .ct-node.cur').count(), 1, 'the running call is marked');
assert.ok(await page.locator('#callTree .ct-ret').count() > 0, 'finished calls show what they returned');
const cur = await page.locator('#callTree .ct-node.cur').boundingBox(), treeBox = await page.locator('#callTree .graph').boundingBox();
assert.ok(cur.y >= treeBox.y && cur.y + cur.height <= treeBox.y + treeBox.height, 'the running call is scrolled into sight');
await snap('18-call-tree');
await page.click('#calls-stack');
assert.match(await page.locator('#stack .frame.top').innerText(), /^fib\(n=\d\)$/, 'the switch goes back to the stack');
await page.click('#calls-tree');
await page.click('#bLast');
assert.match(await page.locator('#callTree .ct-g').first().textContent(), /^fib\(n=6\) returned 8fib\(6\)→ 8$/, 'fib(6) returned 8 (and the tooltip says so with the names)');
const longRun = since => page.waitForFunction(n => {
  const p = document.querySelector('.state-panel');
  return +p.dataset.run > n && !p.classList.contains('stale') && !!document.querySelector('#stateBody');
}, since, { timeout: 60000 });
for (const [lang, code, ret] of [
  ['python', 'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\nprint(fib(4))', true],
  ['ruby', 'def fib(n)\n  return n if n < 2\n  fib(n - 1) + fib(n - 2)\nend\nputs fib(4)', true],
  ['php', '<?php\nfunction fib(int $n): int { if ($n < 2) return $n; return fib($n - 1) + fib($n - 2); }\necho fib(4);', false],
  ['lua', 'local function fib(n)\n  if n < 2 then return n end\n  return fib(n - 1) + fib(n - 2)\nend\nprint(fib(4))', false],
]) {
  await page.selectOption('#lang', lang);
  await edit(() => replaceCode(code), longRun);
  await page.click('#bLast');
  assert.match(await page.locator('#callTree .gcap').innerText(), /^9 calls so far · 4 repeated/, lang + ': fib(4) makes 9 calls');
  assert.equal(await page.locator('#callTree .ct-ret').count() > 0, ret, lang + (ret ? ' gives' : ' gives no') + ' return values');
}
await page.selectOption('#lang', 'javascript');

// 6v. the grid view: the Longest common subsequence example's table; i tags a row, j a column, the cell they meet at is outlined
await pick('Longest common subsequence');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^7$/ }).click();   // if (a[i - 1] === b[j - 1]) …
for (let k = 0; k < 6; k++) await page.click('#bBpNext');
await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^7$/ }).click();
const grid = page.locator('table.gridv[aria-label="Grid of dp"]');
assert.equal(await grid.locator('td').count(), 30, '5 rows of 6');
assert.equal(await grid.locator('tbody th.tagged').count(), 1, 'i tags one row');
assert.equal(await grid.locator('thead th.tagged').count(), 1, 'j tags one column');
assert.equal(await grid.locator('td.at').count(), 1, 'the cell dp[i][j] is outlined');
for (let k = 0; k < 4 && !(await grid.locator('td.chg').count()); k++) await page.click('#bNext');   // the write shows on the step after it
assert.equal(await grid.locator('td.chg').count(), 1, 'the cell just written is marked');
await snap('19-grid');
await page.locator('button[data-vt="dp|memory"]').click();
assert.equal(await grid.count(), 0, 'the switch shows the memory layout instead');
await page.locator('button[data-vt="dp|grid"]').click();
assert.equal(await grid.count(), 1);
for (const [lang, name] of [['python', 'dp'], ['c', 'dp'], ['php', '$dp'], ['lua', 'dp']]) {   // the example's twin, in a hosted language and an interpreted one
  await edit(() => page.selectOption('#lang', lang), longRun);
  await page.click('#bLast');
  const table = page.locator(`table.gridv[aria-label="Grid of ${name}"]`);
  for (let k = 0; k < 6 && !(await table.count()); k++) await page.click('#bPrev');   // dp is lcs's own: gone once it returns
  assert.equal(await table.locator('td').count(), 30, lang + ': the same 5 × 6 table');
  assert.match(await table.locator('td').last().innerText(), /^3$/, lang + ': filled in to the answer');
}
await page.selectOption('#lang', 'javascript');

// 7. theme: dark mode renders without errors
await page.emulateMedia({ colorScheme: 'dark' });
await pick('Breadth-first search');
await page.click('#bLast');
await snap('06-dark');

assert.deepEqual(errors, [], 'no page errors');
await browser.close();
console.log('browser test ok' + (shots ? ' (screenshots in ' + shots + ')' : ''));
