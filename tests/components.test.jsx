/** React components, rendered to markup on the server (no DOM needed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { App } from '../src/components/App.jsx';
import { Graph } from '../src/components/Graph.jsx';
import { StepContext, Value } from '../src/components/Values.jsx';
import { Variables } from '../src/components/Variables.jsx';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { traceCode } from '../src/hooks/useStepper.js';
import { highlightCode } from '@lezer/highlight';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { EditorState, EditorView, highlight, setStep, stepField, stepLines } from '../src/editor.js';
import { EXAMPLES } from '../src/examples.js';

const count = (s, re) => (s.match(re) || []).length;
const stepAt = (code, i) => traceCode(code).trace.steps[i];

test('App starts already stepping, on the first example', () => {
  const m = html(<App />);
  assert.match(m, /id="stateBody"/);
  assert.match(m, /Step 1 of \d+/);
  assert.equal(count(m, /class="code-editor"/g), 1, 'the read-only editor is mounted (its lines need a DOM: see the stepField tests and tests/browser.mjs)');
  assert.match(m, /<option value="Bubble sort" selected="">|<option selected="" value="Bubble sort">/);
  assert.equal(count(m, /<option value="[^"]+">/g) + 1 >= Object.keys(EXAMPLES).length, true);
  assert.doesNotMatch(m, /id="btnRun"/, 'Visualize button is only shown while editing');
  assert.match(m, /id="btnEdit"/);
});

test('Value: only the cell that changed is marked', () => {
  const t = traceCode('const a = [1, 2, 3]; a[1] = 9;').trace.steps;
  const node = s => s.vars.find(v => v.name === 'a').node;
  const m = html(
    <StepContext.Provider value={{ diff: true, refs: new Set() }}>
      <Value node={node(t[2])} prev={node(t[1])} />
    </StepContext.Provider>);
  assert.equal(count(m, /cellbox chg/g), 1);
  assert.match(m, /cellbox chg"><span class="prim num chg">9</);
  assert.match(m, /length 3/);
});

test('Value: pointer tags show under the right cell, and nothing is marked without a previous step', () => {
  const s = stepAt('const arr = [5, 6, 7]; let i = 1;', 2);
  const arr = s.vars.find(v => v.name === 'arr').node;
  const m = html(
    <StepContext.Provider value={{ diff: false, refs: new Set() }}>
      <Value node={arr} markers={{ 1: ['i'] }} />
    </StepContext.Provider>);
  assert.match(m, /<div class="idx">1<\/div><div class="ptrs"><span class="chip"[^>]*>i</);
  assert.doesNotMatch(m, /chg/);
});

test('Value: Sets, Maps, objects and shared objects', () => {
  const s = stepAt('const o = {a: 1}; const p = o; const m = new Map([["k", o]]); const st = new Set([1, 2]);', 4);
  const v = n => s.vars.find(x => x.name === n).node;
  const ctx = { diff: false, refs: new Set(s.refs) };
  const render = n => html(<StepContext.Provider value={ctx}><Value node={v(n)} /></StepContext.Provider>);
  assert.match(render('st'), /Set · size 2/);
  assert.match(render('m'), /Map · size 1/);
  assert.match(render('p'), /class="ref"[^>]*>→ #1</, 'second reference to the same object');
  assert.match(render('o'), /class="badge"[^>]*>#1</, 'shared object is badged');
});

test('Graph: each graph gets its own marker ids', () => {
  const s = stepAt('const g = {A:["B"],B:["C"],C:[]};', 1);
  const view = buildSemanticView(s, null, 'g', semanticGraph(s, 'g'), true);
  const m = html(<><Graph caption="one" view={view} label="a" /><Graph caption="two" view={view} label="b" /></>);
  const ids = [...m.matchAll(/<marker id="([^"]+)"/g)].map(x => x[1]);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, 'marker ids must not collide');
  for (const [, ref] of m.matchAll(/marker-end="url\(#([^)]+)\)"/g)) assert.ok(ids.includes(ref), 'arrow refers to a defined marker: ' + ref);
});

test('Variables: switching one variable to Graph does not affect the others', () => {
  const t = traceCode(EXAMPLES['Breadth-first search']).trace.steps;
  const step = t[20], prev = t[19];
  const m = html(<Variables step={step} prev={prev} stepNo={20} views={{ graph: 'graph' }} onView={() => {}} showPtrs />);
  assert.match(m, /<button[^>]*aria-pressed="true"[^>]*data-vt="graph\|graph"|data-vt="graph\|graph"[^>]*aria-pressed="true"/);
  assert.match(m, /data-vt="queue\|boxes"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-vt="queue\|boxes"/);
  assert.equal(count(m, /class="g-snode/g), 6);
  assert.match(m, /Graph · 6 nodes · 7 edges/);
});

test('Variables: Raw is only offered when a graph pattern exists', () => {
  const step = traceCode('const plain = {a: 1, b: [1, 2]}; const g = {A:["B"],B:[]};').trace.steps.at(-1);
  const m = html(<Variables step={step} prev={null} stepNo={0} views={{}} onView={() => {}} showPtrs />);
  assert.equal(count(m, /data-vt="g\|raw"/g), 1);
  assert.equal(count(m, /data-vt="plain\|raw"/g), 0);
});

test('traceCode reports problems instead of throwing', () => {
  assert.match(traceCode('let = = 3').error, /^Syntax error: /);
  assert.match(traceCode('   ').error, /nothing to run/);
  assert.ok(traceCode('1 + 1').trace.steps.length > 0);
});

/** [text, css] for each highlighted token, with the CSS rule the HighlightStyle generated for its class. */
function colours(code) {
  const rules = Object.fromEntries(highlight.module.getRules().split('\n').map(r => r.match(/^\.(\S+) \{(.*)\}$/)).filter(Boolean).map(m => [m[1], m[2]]));
  const out = [];
  highlightCode(code, javascriptLanguage.parser.parse(code), highlight, (text, cls) => { if (cls) out.push([text, cls.split(' ').map(c => rules[c]).join(';')]); }, () => out.push(['\n', '']));
  return out;
}

test('editor highlighting uses the theme variables, and a multi-line comment is coloured on every line', () => {
  const tok = colours('const x = "a" + 1; // hi\nlet b = true;');
  const css = text => (tok.find(([t]) => t === text) || [])[1] || '';
  assert.match(css('const'), /var\(--code-kw\)/);
  assert.match(css('true'), /var\(--code-kw\)/);
  assert.match(css('"a"'), /var\(--code-str\)/);
  assert.match(css('1'), /var\(--code-num\)/);
  assert.match(css('// hi'), /var\(--code-com\).*italic/);
  const lines = colours('/* one\ntwo */\nlet y;').map(([t, c]) => t === '\n' ? '\n' : c).join('').split('\n');
  assert.match(lines[0], /--code-com/); assert.match(lines[1], /--code-com/);
});

test('stepField: one current line, a faint previous line, aria-current, cleared by an edit', () => {
  let st = EditorState.create({ doc: 'a\nb\nc\nd', extensions: stepField });
  assert.deepEqual(stepLines(st), { cur: [], prev: [] });
  st = st.update({ effects: setStep.of({ line: 3, prevLine: 2 }) }).state;
  assert.deepEqual(stepLines(st), { cur: [3], prev: [2] });
  const attrs = [];
  for (const set of st.facet(EditorView.decorations)) if (typeof set !== 'function') set.between(0, st.doc.length, (_f, _t, d) => { attrs.push(d.spec.attributes); });
  assert.deepEqual(attrs, [undefined, { 'aria-current': 'step' }], 'only the current line is aria-current');
  st = st.update({ effects: setStep.of({ line: 2, prevLine: 2 }) }).state;
  assert.deepEqual(stepLines(st), { cur: [2], prev: [] }, 'a line that repeats is only marked current');
  st = st.update({ effects: setStep.of({ line: 9, prevLine: 0 }) }).state;
  assert.deepEqual(stepLines(st), { cur: [], prev: [] }, 'out-of-range lines are ignored');
  st = st.update({ effects: setStep.of({ line: 1, prevLine: 4 }) }).state;
  assert.deepEqual(stepLines(st), { cur: [1], prev: [4] });
  assert.deepEqual(stepLines(st.update({ changes: { from: 0, insert: 'x' } }).state), { cur: [], prev: [] }, 'an edit clears the step');
  const both = st.update({ changes: { from: 0, insert: 'x\n' }, effects: setStep.of({ line: 2, prevLine: 0 }) }).state;
  assert.deepEqual(stepLines(both), { cur: [2], prev: [] }, 'new code and its step in one transaction');
});
