/** The Python tracer (src/engine/python/tracer.py), run in Node through the same Pyodide version the page downloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadPyodide } from 'pyodide';
import { PYODIDE_VERSION } from '../src/engine/python/pyodide.js';
import { PY_EXAMPLES } from '../src/examples.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { semanticGraph } from '../src/graph/semantic.js';
import { callTree } from '../src/graph/calltree.js';
import { gridMarkers, gridOf } from '../src/graph/grid.js';
import { checkHeapExample } from './support/heap-example.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildMemoryView } from '../src/graph/memory.js';

const py = await loadPyodide();
py.runPython(fs.readFileSync(new URL('../src/engine/python/tracer.py', import.meta.url), 'utf8'));
/** { steps, logs, error } or { syntax } */
const trace = src => JSON.parse(py.globals.get('trace_json')(src));
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('the page downloads the same Pyodide the tests run', () => {
  const pkg = createRequire(import.meta.url)('../package.json');
  assert.equal(pkg.devDependencies.pyodide, PYODIDE_VERSION, 'src/engine/python/pyodide.js and package.json must name the same version');
});

test('a snapshot before every line, with the call stack, locals and globals', () => {
  const r = trace('def double(x):\n    y = x * 2\n    return y\n\nn = 3\nm = double(n)\nprint(m)');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '6' }]);
  assert.deepEqual(r.steps.map(s => s.line), [1, 5, 6, 2, 3, 7, -1], 'before each line, then the end');
  const inside = r.steps[4];
  assert.deepEqual(inside.stack, [{ name: 'double', args: 'x=3', id: 1 }], 'the call, its arguments and its id (for the call tree)');
  assert.deepEqual(inside.vars.map(v => [v.name, v.scope, v.node.s]), [['x', 'local', '3'], ['y', 'local', '6'], ['n', 'global', '3']],
    'locals first; functions are not variables');
  assert.equal(r.steps.at(-1).stack.length, 0);
});

test('Python values become the same snapshot nodes as JavaScript values, with their type names', () => {
  const s = trace([
    'from collections import deque', 'class P:', '    def __init__(self):', '        self.x = 1',
    'a = [1, "s", None, True, 2.5]', 't = (1, 2)', 'd = {"k": [1]}', 'm = {1: "one"}', 'st = {3}', 'q = deque([1])', 'o = P()', 'same = [a, a]',
  ].join('\n')).steps.at(-1);
  const v = vars(s);
  assert.deepEqual(v.a.node.items.map(n => [n.k, n.s]), [['num', '1'], ['str', '"s"'], ['null', 'None'], ['bool', 'True'], ['num', '2.5']]);
  assert.equal(v.a.node.cls, 'list'); assert.equal(v.t.node.cls, 'tuple'); assert.equal(v.q.node.cls, 'deque');
  assert.equal(v.d.node.t, 'obj', 'a dict with string keys is an object'); assert.equal(v.d.node.tn, 'dict');
  assert.equal(v.m.node.t, 'map', 'other keys: a map'); assert.equal(v.st.node.t, 'set');
  assert.equal(v.o.node.t, 'obj'); assert.equal(v.o.node.cls, 'P'); assert.deepEqual(v.o.node.entries.map(e => e[0]), ['x']);
  assert.deepEqual(v.same.node.items.map(n => n.t), ['ref', 'ref'], 'the same list twice: references, as in JavaScript');
  assert.ok(!('P' in v) && !('deque' in v), 'classes and imports are not variables');
  assert.match(JSON.stringify(buildMemoryView(s, null, 't', true).prims), /"tuple\(2\)"/, 'Memory shows the Python type (in the box title)');
});

test('errors: syntax errors are reported, the program\'s own errors end the trace, runaway programs are stopped', () => {
  assert.match(trace('def f(:\n    pass').syntax, /line 1/);
  assert.deepEqual(trace('x = 1\ny = x / 0').error, { msg: 'ZeroDivisionError: division by zero' });
  assert.match(trace('while True:\n    pass').error.msg, /Trace stopped after 3000 steps/);
  const caught = trace('try:\n    while True:\n        pass\nexcept Exception:\n    print("caught")');
  assert.match(caught.error.msg, /Trace stopped/, 'the step limit is not swallowed by except Exception');
  assert.deepEqual(caught.logs, []);
  assert.match(trace('def f(n):\n    return f(n + 1)\nf(0)').error.msg, /more than 300 nested calls/);
});

test('every Python example runs, and its graphs are found', () => {
  for (const [name, code] of Object.entries(PY_EXAMPLES)) {
    const r = trace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const bfs = trace(PY_EXAMPLES['Breadth-first search']);
  assert.deepEqual(bfs.logs.map(l => l.s), ["['A', 'B', 'C', 'D', 'E', 'F']"]);
  assert.equal(kind(bfs.steps[20], 'graph'), 'Graph');
  const ds = trace(PY_EXAMPLES['Data structures']).steps.at(-1);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Graph'], ['g3', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph'], ['intervals', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'person', 'scores', 'pair']) assert.equal(kind(ds, n), null, n + ' is data');
  const rev = trace(PY_EXAMPLES['Reverse a linked list']).steps.at(-1);
  assert.equal(kind(rev, 'head'), 'Linked list');
});

test('every Python example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.python.shapes) for (const [code, , full] of items) {
    const program = full || (/^\w+ = /.test(code) ? code : 'g = ' + code);
    const name = program.split('\n').at(-1).match(/^(\w+) =/)[1];
    const r = trace(program);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  for (const code of [HELP.python.age, HELP.python.fruits]) assert.equal(semanticGraph(trace('x = ' + code).steps.at(-1), 'x'), null, code + ' is data');
});

test('call tree: each call has an idpython and what it returned; a 2D array is a grid', async () => {
  const r = await trace('def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\ng = [[1, 2], [3, 4]]\nprint(fib(3))');
  const tree = callTree(r.steps, r.rets || {});
  assert.deepEqual(tree.nodes.map(n => n.label + (n.ret != null ? '=' + n.ret : '')), ['fib(3)=2', 'fib(2)=1', 'fib(1)=1', 'fib(0)=0', 'fib(1)=1']);
  assert.ok(tree.recursive);
  const g = gridOf(r.steps.at(-1), 'g');
  assert.ok(g, 'a grid');
  assert.deepEqual(g.rows.map(row => row.map(c => c.s).join(' ')), ['1 2', '3 4']);
});

test('the Longest common subsequence example fills its table as a grid', async () => {
  const r = await trace(PY_EXAMPLES['Longest common subsequence']);
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s.trim()).filter(Boolean), ['3']);
  const step = r.steps.findLast(s => s.vars.some(v => v.name === 'dp'));
  assert.deepEqual(gridOf(step, 'dp').rows.map(row => row.map(c => c.s).join('')), ['000000', '000011', '011112', '011222', '011223']);
  const mid = r.steps.find(s => gridOf(s, 'dp') && s.vars.some(v => v.name === 'j'));
  assert.deepEqual(gridMarkers(gridOf(mid, 'dp'), mid.vars, 'dp').cell, [1, 1], 'i and j meet at the first cell worked out');
});

test('the Binary heap example is a min-heap in the Heap view', async () => {
  checkHeapExample(await trace(PY_EXAMPLES['Binary heap']), 'heap', 'python');
});
