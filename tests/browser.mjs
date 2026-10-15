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
assert.equal(await page.locator('#example').inputValue(), '', 'no example picked');
assert.deepEqual(await page.locator('.cm-line').evaluateAll(ls => ls.map(l => { const c = l.cloneNode(true); c.querySelectorAll('.cm-placeholder').forEach(x => x.remove()); return c.textContent; })),
  [''], 'the editor is empty (apart from its placeholder hint)');
assert.match(await page.locator('.cm-placeholder').innerText(), /Write or paste JavaScript/);
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
assert.match(await page.locator('.site-header p').innerText(), /^Run Python/);
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

// 7. theme: dark mode renders without errors
await page.emulateMedia({ colorScheme: 'dark' });
await pick('Breadth-first search');
await page.click('#bLast');
await snap('06-dark');

assert.deepEqual(errors, [], 'no page errors');
await browser.close();
console.log('browser test ok' + (shots ? ' (screenshots in ' + shots + ')' : ''));
