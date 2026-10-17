/** The Heap view (src/graph/heap.js): which values can be heaps, their size, tags and order, and the drawing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { MAX_ITEMS, buildHeapView, compare, heapKind, heapMarkers, heapOf, heapSize, isHeapName } from '../src/graph/heap.js';
import { C_EXAMPLES, CPP_EXAMPLES, CS_EXAMPLES, EXAMPLES, GO_EXAMPLES, JAVA_EXAMPLES, KT_EXAMPLES, LUA_EXAMPLES, SWIFT_EXAMPLES, TS_EXAMPLES } from '../src/examples.js';
import { checkHeapExample } from './support/heap-example.js';

const last = (code, lang) => traceCode(code, lang).trace.steps.at(-1);
const labels = h => h.items.map(it => it.s);

test('a list of plain values, or of short tuples, can be a heap; anything else cannot', () => {
  const s = last('const a = [3, 1, 2];\nconst w = ["b", "a"];\nconst pq = [[0, "A"], [4, "B"]];\nconst e = [];\nconst objs = [{ x: 1 }];\nconst rows = [[1, 2, 3, 4]];\nconst o = { a: 1 };');
  assert.deepEqual(labels(heapOf(s, 'a')), ['3', '1', '2']);
  assert.deepEqual(labels(heapOf(s, 'w')), ['"b"', '"a"']);
  assert.deepEqual(labels(heapOf(s, 'pq')), ['[0, "A"]', '[4, "B"]']);
  assert.deepEqual(heapOf(s, 'pq').items[1].key, [4, '"B"']);
  assert.equal(heapOf(s, 'e').len, 0, 'an empty list is an empty heap');
  for (const n of ['objs', 'rows', 'o', 'nope']) assert.equal(heapOf(s, n), null, n);
});

test('compare: numbers as numbers, text as text, tuples item by item', () => {
  assert.ok(compare(2, 10) < 0);
  assert.ok(compare('b', 'a') > 0);
  assert.ok(compare([1, 'z'], [2, 'a']) < 0);
  assert.ok(compare([1, 'b'], [1, 'a']) > 0);
  assert.equal(compare(3, 3), 0);
});

test('named like a heap: heap, pq, minHeap, $heap, priority_queue', () => {
  for (const n of ['heap', 'minHeap', 'max_heap', '$heap', 'pq', 'priority_queue', 'prio']) assert.ok(isHeapName(n), n);
  for (const n of ['arr', 'queue', 'nums', 'apq']) assert.ok(!isHeapName(n), n);
});

test('the heap ends where a size-like variable says, when it is smaller than the list', () => {
  const s = last('const a = [9, 7, 8, 1, 2];\nconst size = 3, n = 5;');
  assert.deepEqual(heapSize(heapOf(s, 'a'), s.vars), { size: 3, by: 'size' });
  const s2 = last('const a = [9, 7, 8];\nconst n = 3;');
  assert.deepEqual(heapSize(heapOf(s2, 'a'), s2.vars), { size: 3, by: null }, 'n is the whole list: nothing past it');
  const s3 = last('const a = [9, 7, 8];\nconst end = 2;');
  assert.deepEqual(heapSize(heapOf(s3, 'a'), s3.vars), { size: 2, by: 'end' }, "heapsort's end");
});

test('index variables are tagged on the tree; values and counts never are', () => {
  const s = last('const heap = [1, 3, 2, 5];\nconst i = 1, parent = 0, smallest = 3, left = 9, x = 2, top = 1, size = 2;');
  assert.deepEqual(heapMarkers(heapOf(s, 'heap'), s.vars, 'heap'), { 0: ['parent'], 1: ['i'], 3: ['smallest'] }, 'left is past the end');
  const lua = last('local heap = {1, 3, 2}\nlocal i = 1', 'lua');
  assert.deepEqual(heapMarkers(heapOf(lua, 'heap'), lua.vars, 'heap'), { 0: ['i'] }, 'Lua counts from 1: i = 1 is the root');
});

test('min or max: from the name, else from how parents compare over the whole run', () => {
  const s = last('const a = [5, 3];');
  assert.equal(heapKind('maxHeap', null, s), 'max');
  assert.equal(heapKind('min_heap', null, s), 'min');
  assert.equal(heapKind('a', null, s), 'max', 'one step alone: 5 over 3 looks like a max-heap');
  const t = traceCode('const a = [1, 4, 2, 6, 5];\na.push(0);\na[5] = 2; a[2] = 0;').trace;
  assert.equal(heapKind('a', t.steps), 'min', 'over the run, the push that breaks the order is outvoted');
  const big = traceCode('const a = [9, 4, 8, 1];\na.push(5);').trace;
  assert.equal(heapKind('a', big.steps), 'max');
});

test('the drawing: children under their parent, the strip below, red for a parent out of order, dashed past the size', () => {
  const s = last('const a = [1, 3, 2, 0, 9, 8];\nconst size = 5, i = 3;');
  const h = heapOf(s, 'a');
  const v = buildHeapView(h, { size: heapSize(h, s.vars), kind: 'min', markers: heapMarkers(h, s.vars, 'a') });
  const rect = k => v.prims.find(p => p.tag === 'g' && p.p['data-heap'] === k).kids.find(x => x.tag === 'rect');
  const mid = k => rect(k).p.x + rect(k).p.width / 2;
  for (let k = 1; k < 6; k++) {
    const p = (k - 1) >> 1;
    assert.ok(rect(k).p.y > rect(p).p.y, 'below its parent');
    assert.ok(k % 2 ? mid(k) < mid(p) : mid(k) > mid(p), 'left child on the left, right on the right');
  }
  assert.ok(Math.abs((mid(1) + mid(2)) / 2 - mid(0)) < 0.01, 'the root centred over its children');
  assert.equal(v.bad, 1, '3 over 0 is out of order; 8 is past the size and does not count');
  assert.equal(v.prims.filter(p => p.tag === 'line' && /bad/.test(p.p.className)).length, 1);
  assert.match(rect(5).p.className, /out/);
  assert.match(rect(3).p.className, /\bat\b/, 'i points at index 3');
  const tag = v.prims.find(p => p.tag === 'g' && p.p['data-heap'] === 3).kids;
  assert.deepEqual(tag.slice(-3).map(x => x.p.className || 'tint'), ['hp-tag-bg', 'tint', 'hp-tag'], "i's label on an opaque backing, over the edges");
  assert.equal(v.prims.filter(p => p.tag === 'rect' && /hp-cell/.test(p.p.className)).length, 6, 'the array as a strip');
  assert.ok(v.prims.some(p => p.tag === 'line' && p.p.className === 'hp-end'), 'a line where the heap ends');
  assert.equal(v.caption, 'Min-heap · 5 items · 1 past size (dashed) · 1 parent out of order (red)');
});

test('the drawing marks the two cells of a swap, and says when the heap is empty or cut short', () => {
  const t = traceCode('const a = [1, 3, 0];\n[a[0], a[2]] = [a[2], a[0]];').trace;
  const v = buildHeapView(heapOf(t.steps.at(-1), 'a'), { prev: heapOf(t.steps.at(-2), 'a') });
  assert.deepEqual([...v.changed], [0, 2]);
  assert.equal(buildHeapView(heapOf(last('const a = [];'), 'a')).caption, 'Min-heap · empty');
  const cut = buildHeapView(heapOf(last('const a = Array.from({ length: 140 }, (_, i) => i);'), 'a'));
  assert.match(cut.caption, /first \d+ shown$/, 'the engine kept only the first cells');
  const items = Array.from({ length: 140 }, (_, i) => ({ key: i, s: String(i) }));
  const long = buildHeapView({ id: 1, items, base: 0, len: 140, more: 0 });
  assert.equal(long.prims.filter(p => p.tag === 'g').length, MAX_ITEMS, 'never more than seven levels');
  assert.match(long.caption, /first 127 shown$/);
});

test('the Binary heap example: a min-heap filled and emptied, in every language', () => {
  for (const [lang, examples] of [['javascript', EXAMPLES], ['typescript', TS_EXAMPLES], ['lua', LUA_EXAMPLES], ['java', JAVA_EXAMPLES], ['kotlin', KT_EXAMPLES],
    ['swift', SWIFT_EXAMPLES], ['csharp', CS_EXAMPLES], ['go', GO_EXAMPLES], ['c', C_EXAMPLES], ['cpp', CPP_EXAMPLES]]) {
    checkHeapExample(traceCode(examples['Binary heap'], lang).trace, 'heap', lang, { tmpSwap: lang === 'kotlin' || lang === 'c' });
  }
});
