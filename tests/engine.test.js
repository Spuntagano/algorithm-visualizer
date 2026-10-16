import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrace } from '../src/engine/trace.js';
import { EXAMPLES } from '../src/examples.js';

const logs = t => t.logs.map(l => l.s);

test('every bundled example runs to completion', () => {
  for (const [name, code] of Object.entries(EXAMPLES)) {
    const t = runTrace(code);
    assert.equal(t.error, null, name);
    assert.ok(t.steps.length > 3, name);
    assert.equal(t.steps.at(-1).line, -1, name + ': last step marks the end');
  }
});

test('bubble sort sorts, and the final snapshot shows it', () => {
  const t = runTrace(EXAMPLES['Bubble sort']);
  assert.deepEqual(logs(t), ['[1,2,5,6,9]']);
  const data = t.steps.at(-1).vars.find(v => v.name === 'data').node;
  assert.deepEqual(data.items.map(i => i.s), ['1', '2', '5', '6', '9']);
});

test('snapshots are copies: earlier steps keep their old values', () => {
  const t = runTrace('const a = [1, 2]; a.push(3); a[0] = 9;');
  const at = i => t.steps[i].vars.find(v => v.name === 'a')?.node.items.map(x => x.s).join(',');
  assert.equal(at(1), '1,2');
  assert.equal(at(2), '1,2,3');
  assert.equal(at(3), '9,2,3');
});

test('object ids are stable across steps, and repeated objects become refs', () => {
  const t = runTrace('const a = {n: 1}; const b = a; a.n = 2;');
  const last = t.steps.at(-1);
  const a = last.vars.find(v => v.name === 'a').node, b = last.vars.find(v => v.name === 'b').node;
  assert.equal(a.t, 'obj'); assert.equal(b.t, 'ref'); assert.equal(b.id, a.id);
  assert.equal(t.steps[1].vars.find(v => v.name === 'a').node.id, a.id);
});

test('call stack tracks function entry and exit', () => {
  const t = runTrace('function f(n) { return n; }\nf(7);\nf(8);');
  const depths = t.steps.map(s => s.stack.length);
  assert.ok(depths.includes(1));
  assert.equal(depths.at(-1), 0);
  const inside = t.steps.find(s => s.stack.length === 1);
  assert.deepEqual(inside.stack[0], { name: 'f', args: 'n=7', id: 1 });
});

test('Maps, Sets and class instances are serialised', () => {
  const t = runTrace('class P { constructor(){ this.x = 1; } }\nconst m = new Map([["k", 1]]); const s = new Set([1, 2]); const p = new P();');
  const v = n => t.steps.at(-1).vars.find(x => x.name === n).node;
  assert.equal(v('m').t, 'map'); assert.equal(v('s').t, 'set');
  assert.equal(v('p').t, 'obj'); assert.equal(v('p').cls, 'P');
});

test('control flow without braces, switch, try/catch and arrows are instrumented', () => {
  const t = runTrace(`const sq = x => { const y = x*x; return y; };
for (const v of [1,2,3].map(sq)) console.log(v);
let i = 0; do i++; while (i < 3);
switch (i) { case 3: { let z = 1; console.log(z); break; } default: console.log('no'); }
try { null.x } catch (e) { console.log('caught') } finally { console.log('f') }`);
  assert.equal(t.error, null);
  assert.deepEqual(logs(t), ['1', '4', '9', '1', 'caught', 'f']);
});

test('program errors are reported with the steps recorded so far', () => {
  const t = runTrace('const a = [1];\nundefinedFn();');
  assert.match(t.error.msg, /ReferenceError/);
  assert.equal(t.steps.length, 2);
});

test('infinite loops and runaway recursion are stopped', () => {
  const loop = runTrace('let n = 0; while (true) { n++; }');
  assert.equal(loop.steps.length, 3000); assert.equal(loop.error.soft, true);
  const rec = runTrace('function f(n) { return f(n + 1); } f(0);');
  assert.match(rec.error.msg, /nested calls/);
});

test('syntax errors throw so the UI can show them', () => {
  assert.throws(() => runTrace('let = = 3'), /Unexpected token/);
});

test('a run that was superseded is dropped: an aborted signal rejects, and traceCodeAsync gives null', async () => {
  const { runTraceAsync, setMainThreadTracer } = await import('../src/engine/runner.js');
  const { traceCodeAsync } = await import('../src/hooks/useStepper.js');
  setMainThreadTracer(code => runTrace(code));        // Node has no Worker: the page never needs this
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(runTraceAsync('let a = 1;', ctl.signal), e => e.aborted === true);
  assert.equal(await traceCodeAsync('let a = 1;', ctl.signal), null);
  assert.ok((await traceCodeAsync('let a = 1;')).trace, 'without a signal it still runs');
});
