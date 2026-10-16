/** The Ruby tracer (src/engine/ruby/tracer.rb), run in Node through the same ruby.wasm version the page downloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DefaultRubyVM } from '@ruby/wasm-wasi/dist/node';
import { RUBY_WASM_VERSION, RUBY_BINARY_URL } from '../src/engine/ruby/ruby.js';
import { RB_EXAMPLES, EXAMPLES } from '../src/examples.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { callTree } from '../src/graph/calltree.js';
import { gridMarkers, gridOf } from '../src/graph/grid.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildMemoryView } from '../src/graph/memory.js';

const require = createRequire(import.meta.url);
const module = await WebAssembly.compile(fs.readFileSync(require.resolve('@ruby/3.4-wasm-wasi/dist/ruby+stdlib.wasm')));
const TRACER = fs.readFileSync(new URL('../src/engine/ruby/tracer.rb', import.meta.url), 'utf8');
/** { steps, logs, error } or { syntax }: a fresh VM per run, as in the worker */
const trace = async src => {
  const { vm } = await DefaultRubyVM(module, { consolePrint: false });
  vm.eval(TRACER);
  globalThis.__rubyCode = src;
  return JSON.parse(vm.eval('require "js"; RubyTracer.trace_json(JS.global[:__rubyCode].to_s)').toString());
};
const last = async src => (await trace(src)).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('the page downloads the same ruby.wasm the tests run', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.devDependencies['@ruby/wasm-wasi'], RUBY_WASM_VERSION, 'src/engine/ruby/ruby.js and package.json must name the same version');
  assert.equal(pkg.devDependencies['@ruby/3.4-wasm-wasi'], RUBY_WASM_VERSION);
  assert.ok(RUBY_BINARY_URL.includes('@ruby/3.4-wasm-wasi@' + RUBY_WASM_VERSION + '/'));
});

test('a snapshot before every line, with the call stack, locals and top-level variables', async () => {
  const r = await trace('def double(x)\n  y = x * 2\n  y\nend\n\nn = 3\nm = double(n)\nputs m');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '6' }]);
  assert.deepEqual(r.steps.map(s => s.line), [1, 6, 7, 2, 3, 8, -1], 'before each line, then the end');
  const inside = r.steps[4];
  assert.deepEqual(inside.stack, [{ name: 'double', args: 'x=3', id: 1 }], 'the call, its arguments and its id (for the call tree)');
  assert.deepEqual(inside.vars.map(v => [v.name, v.scope, v.node.s]), [['x', 'local', '3'], ['y', 'local', '6'], ['n', 'global', '3']],
    'locals first; methods are not variables, and m is not shown before it is assigned');
  assert.equal(r.steps.at(-1).stack.length, 0);
  assert.deepEqual(r.steps.at(-1).vars.map(v => v.name), ['n', 'm']);
});

test('methods show self, blocks see the variables around them, print and p go to the Output panel', async () => {
  const r = await trace([
    'class Counter', '  def initialize', '    @count = 0', '  end', '  def add(k)', '    @count += k', '  end', 'end',
    'c = Counter.new', '[1, 2].each { |k| c.add(k) }', 'print "a", "b\\n"', 'p [1, :x]', '$total = 7',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s), ['ab', '[1, :x]']);
  const inAdd = r.steps.find(s => s.line === 6 && s.stack.at(-1).args === 'k=2');
  assert.deepEqual(inAdd.stack.map(f => f.name), ['Counter#add']);
  const me = vars(inAdd).self.node;
  assert.equal(me.cls, 'Counter');
  assert.deepEqual(me.entries.map(([k, n]) => [k, n.s]), [['count', '1']], 'instance variables, without the @');
  assert.equal(vars(inAdd).c.node.id, me.id, 'self and c are the same object');
  const end = vars(r.steps.at(-1));
  assert.equal(end.$total.node.s, '7', 'the program\'s own $globals are shown');
  assert.ok(!('Counter' in end), 'classes are not variables');
});

test('Ruby values become the same snapshot nodes: arrays, hashes (objects or maps), sets, Structs, symbols', async () => {
  const s = await last([
    'require "set"', 'P = Struct.new(:x, :y)',
    'list = [10, "s", true, 1.5, nil, :sym, 1..3]', 'obj = { b: 1, "a" => [2] }', 'map = { 1 => "a", [2] => "b" }',
    'set = Set[3, 4]', 'pt = P.new(1, 2)', 'same = [list, list]', 'f = ->(x) { x }', 'LIMIT = 5',
  ].join('\n'));
  const v = vars(s);
  assert.deepEqual(v.list.node.items.map(n => [n.k, n.s]),
    [['num', '10'], ['str', '"s"'], ['bool', 'true'], ['num', '1.5'], ['null', 'nil'], ['sym', ':sym'], ['str', '"1..3"']]);
  assert.equal(v.obj.node.t, 'obj'); assert.deepEqual(v.obj.node.entries.map(e => e[0]), ['b', 'a'], 'name keys: an object, in insertion order');
  assert.equal(v.map.node.t, 'map'); assert.deepEqual(v.map.node.entries.map(e => e[0].t), ['p', 'arr']);
  assert.equal(v.set.node.t, 'set');
  assert.equal(v.pt.node.cls, 'P'); assert.deepEqual(v.pt.node.entries.map(e => e[0]), ['x', 'y']);
  assert.deepEqual(v.same.node.items.map(n => n.t), ['ref', 'ref']);
  assert.ok(!('f' in v) && !('P' in v), 'procs and classes are hidden');
  assert.equal(v.LIMIT.node.s, '5', 'the program\'s own constants are shown');
});

test('the views: pointer tags in arrays, symbols name graph nodes, a Set tags the nodes it contains', async () => {
  const s = await last('nums = [5, 2, 9]\ni = 1\ng = { a: [:b], b: [:c], c: [] }\nseen = Set[:a, :c]\ncur = :b');
  assert.deepEqual(markersFor(vars(s).nums.node, s.vars, 'nums'), { 1: ['i'] });
  const labels = buildMemoryView(s, null, 'nums', true).prims.filter(q => q.p.className === 'g-idx').map(q => q.text);
  assert.deepEqual(labels, ['0', '1', '2']);
  const sem = semanticGraph(s, 'g');
  assert.deepEqual(sem.nodes.map(n => n.key), ['a', 'b', 'c']);
  assert.deepEqual(sem.edges.map(e => e.from + '>' + e.to), ['a>b', 'b>c']);
  const text = buildSemanticView(s, null, 'g', sem, true).prims.map(q => q.text);
  assert.equal(text.filter(t => t === '∈ seen').length, 2);
  assert.equal(text.filter(t => t === '↑ cur').length, 1, 'a symbol variable tags the node it names');
});

test('errors: syntax errors say where, runtime errors end the trace, runaway programs are stopped', async () => {
  assert.match((await trace('x = = 1')).syntax, /^line 1: /);
  const err = await trace('a = [1]\nputs "before"\na.fetch(5)\nputs "after"');
  assert.match(err.error.msg, /^IndexError: index 5 outside of array bounds/);
  assert.deepEqual(err.logs.map(l => l.s), ['before']);
  assert.equal(err.steps.at(-2).line, 3, 'the last step is the line that failed');
  assert.match((await trace('i = 0\nloop { i += 1 }')).error.msg, /Trace stopped after 3000 steps/);
  const caught = await trace('begin\n  loop { x = 1 }\nrescue Exception\n  puts "caught"\nend\nloop { y = 1 }');
  assert.match(caught.error.msg, /Trace stopped/, 'rescue Exception cannot swallow the step limit');
  assert.deepEqual(caught.logs, []);
  assert.match((await trace('def f(n) = 1 + f(n + 1)\nf(1)')).error.msg, /more than 300 nested calls/);
});

test('every Ruby example runs, prints like its twin, and its graphs are found', async () => {
  assert.deepEqual(Object.keys(RB_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one Ruby twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(RB_EXAMPLES)) {
    const r = await trace(code);
    assert.ok(!r.syntax, name + ': ' + r.syntax);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  assert.deepEqual((await trace(RB_EXAMPLES['Bubble sort'])).logs.map(l => l.s), ['[1, 2, 5, 6, 9]']);
  assert.deepEqual((await trace(RB_EXAMPLES['Breadth-first search'])).logs.map(l => l.s), ['[:a, :b, :c, :d, :e, :f]']);
  assert.equal(kind(await last(RB_EXAMPLES['Breadth-first search']), 'GRAPH'), 'Graph');
  const ds = await last(RB_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph'], ['intervals', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'person', 'scores', 'pair']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every Ruby example in the graph help really is drawn as a graph', async () => {
  for (const [, items] of HELP.ruby.shapes) for (const [code, , full] of items) {
    const program = full || (/^\w+ = /.test(code) ? code : 'g = ' + code);
    const name = program.split('\n').at(-1).match(/^(\w+) =/)[1];
    const r = await trace(program);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  for (const code of [HELP.ruby.age, HELP.ruby.fruits]) assert.equal(semanticGraph(await last('x = ' + code), 'x'), null, code + ' is data');
});

test('call tree: each call has an idruby and what it returned; a 2D array is a grid', async () => {
  const r = await trace('def fib(n)\n  return n if n < 2\n  fib(n - 1) + fib(n - 2)\nend\ng = [[1, 2], [3, 4]]\nputs fib(3)');
  const tree = callTree(r.steps, r.rets || {});
  assert.deepEqual(tree.nodes.map(n => n.label + (n.ret != null ? '=' + n.ret : '')), ['fib(3)=2', 'fib(2)=1', 'fib(1)=1', 'fib(0)=0', 'fib(1)=1']);
  assert.ok(tree.recursive);
  const g = gridOf(r.steps.at(-1), 'g');
  assert.ok(g, 'a grid');
  assert.deepEqual(g.rows.map(row => row.map(c => c.s).join(' ')), ['1 2', '3 4']);
});

test('the Longest common subsequence example fills its table as a grid', async () => {
  const r = await trace(RB_EXAMPLES['Longest common subsequence']);
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s.trim()).filter(Boolean), ['3']);
  const step = r.steps.findLast(s => s.vars.some(v => v.name === 'dp'));
  assert.deepEqual(gridOf(step, 'dp').rows.map(row => row.map(c => c.s).join('')), ['000000', '000011', '011112', '011222', '011223']);
  const mid = r.steps.find(s => gridOf(s, 'dp') && s.vars.some(v => v.name === 'j'));
  assert.deepEqual(gridMarkers(gridOf(mid, 'dp'), mid.vars, 'dp').cell, [1, 1], 'i and j meet at the first cell worked out');
});
