/** The Grid view's data (src/graph/grid.js): which values are grids, what changed, which variables index them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { changedCells, gridMarkers, gridOf } from '../src/graph/grid.js';
import { C_EXAMPLES, CPP_EXAMPLES, CS_EXAMPLES, EXAMPLES, GO_EXAMPLES, JAVA_EXAMPLES, KT_EXAMPLES, LUA_EXAMPLES, SWIFT_EXAMPLES, TS_EXAMPLES } from '../src/examples.js';

const last = (code, lang) => traceCode(code, lang).trace.steps.at(-1);
const cells = g => g.rows.map(r => r.map(c => (c ? c.s : '·')).join(' '));

test('an array of arrays of plain values is a grid', () => {
  const s = last('const g = [[1, 2, 3], [4, 5, 6]];\nconst b = [["X", "O"], ["", "X"]];');
  assert.deepEqual(cells(gridOf(s, 'g')), ['1 2 3', '4 5 6']);
  assert.equal(gridOf(s, 'g').cols, 3);
  assert.deepEqual(cells(gridOf(s, 'b')), ['"X" "O"', '"" "X"']);
});

test('not a grid: a flat array, one row, rows holding objects, an empty table', () => {
  const s = last('const a = [1, 2];\nconst one = [[1, 2]];\nconst objs = [[{ x: 1 }], [{ x: 2 }]];\nconst none = [[], []];\nconst o = { a: [1] };');
  for (const n of ['a', 'one', 'objs', 'none', 'o']) assert.equal(gridOf(s, n), null, n);
});

test('shorter rows leave empty cells; rows shared by reference are still rows', () => {
  const s = last('const t = [[1], [1, 1], [1, 2, 1]];\nconst r = [0, 0];\nconst same = [r, r];');
  assert.deepEqual(cells(gridOf(s, 't')), ['1 · ·', '1 1 ·', '1 2 1']);
  assert.deepEqual(cells(gridOf(s, 'same')), ['0 0', '0 0']);
});

test('the cells that changed since the previous step', () => {
  const t = traceCode('const g = [[0, 0], [0, 0]];\ng[1][0] = 5;\ng[1][0] = 5;').trace;
  const at = i => gridOf(t.steps[i], 'g');
  assert.deepEqual([...changedCells(at(2), at(1))], ['1,0']);
  assert.deepEqual([...changedCells(at(3), at(2))], [], 'the same value again is no change');
  assert.deepEqual([...changedCells(at(2), null)], [], 'nothing to compare with');
});

test('i, r, row… tag rows and j, c, col… columns; the cell they meet at is the one being worked on', () => {
  const s = last('const dp = [[0, 0, 0], [0, 0, 0]];\nconst i = 1, j = 2, k = 0, n = 3;');
  const m = gridMarkers(gridOf(s, 'dp'), s.vars, 'dp');
  assert.deepEqual(m.rows, { 0: ['k'], 1: ['i'] }, 'n = 3 is past the last row and column; k could be either');
  assert.deepEqual(m.cols, { 0: ['k'], 2: ['j'] });
  assert.equal(m.cell, null, 'two tagged rows: no one cell');
  const s2 = last('const dp = [[0, 0, 0], [0, 0, 0]];\nconst r = 1, c = 2;');
  assert.deepEqual(gridMarkers(gridOf(s2, 'dp'), s2.vars, 'dp').cell, [1, 2]);
  const s3 = last('const dp = [[0, 0, 0], [0, 0, 0]];\nconst r = 1, c = 2, m = 1, rows = 1;');
  assert.deepEqual(gridMarkers(gridOf(s3, 'dp'), s3.vars, 'dp').cell, [1, 2], 'm and rows are sizes: they tag nothing');
});

test('every language: its 2D arrays are grids', () => {
  const progs = {
    lua: ['local g = {{1, 2}, {3, 4}}', 'g'],
    java: ['class Main { public static void main(String[] a) { int[][] g = {{1, 2}, {3, 4}}; } }', 'g'],
    kotlin: ['fun main() { val g = arrayOf(intArrayOf(1, 2), intArrayOf(3, 4)) }', 'g'],
    swift: ['let g = [[1, 2], [3, 4]]', 'g'],
    csharp: ['class P { static void Main() { var g = new int[2, 2] { { 1, 2 }, { 3, 4 } }; } }', 'g'],
    go: ['package main\nfunc main() { g := [][]int{{1, 2}, {3, 4}}; _ = g }', 'g'],
    c: ['int main(void) { int g[2][2] = {{1, 2}, {3, 4}}; return 0; }', 'g'],
    cpp: ['#include <vector>\nint main() { std::vector<std::vector<int>> g = {{1, 2}, {3, 4}}; }', 'g'],
  };
  for (const [lang, [code, name]] of Object.entries(progs)) {
    const r = traceCode(code, lang).trace;
    const step = r.steps.findLast(st => st.vars.some(v => v.name === name));
    const g = gridOf(step, name);
    assert.ok(g, lang);
    assert.deepEqual(cells(g), ['1 2', '3 4'], lang);
    if (lang === 'lua') assert.equal(g.base, 1, 'Lua numbers its rows and columns from 1');
  }
});

test('the Longest common subsequence example fills its table as a grid, in every language', () => {
  for (const [lang, examples] of [['javascript', EXAMPLES], ['typescript', TS_EXAMPLES], ['lua', LUA_EXAMPLES], ['java', JAVA_EXAMPLES], ['kotlin', KT_EXAMPLES],
    ['swift', SWIFT_EXAMPLES], ['csharp', CS_EXAMPLES], ['go', GO_EXAMPLES], ['c', C_EXAMPLES], ['cpp', CPP_EXAMPLES]]) {
    const t = traceCode(examples['Longest common subsequence'], lang).trace;
    assert.equal(t.error, null, lang);
    assert.deepEqual(t.logs.map(l => l.s), ['3'], lang + ': "ABCB" and "BDCAB" share BCB');
    const step = t.steps.findLast(s => s.vars.some(v => v.name === 'dp'));
    assert.deepEqual(cells(gridOf(step, 'dp')).map(r => r.replace(/ /g, '')), ['000000', '000011', '011112', '011222', '011223'], lang);
    const mid = t.steps.find(s => gridOf(s, 'dp') && s.vars.some(v => v.name === 'j'));
    assert.ok(gridMarkers(gridOf(mid, 'dp'), mid.vars, 'dp').cell, lang + ': i and j meet at a cell');
  }
});
