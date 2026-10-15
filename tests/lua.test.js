/** Lua: traced in Fengari by src/engine/lua/tracer.js; tables count from 1 in every view. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runLuaTrace } from '../src/engine/lua/tracer.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { LUA_EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildMemoryView } from '../src/graph/memory.js';

const last = code => runLuaTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('a snapshot before every line, with the call stack, locals, upvalues and globals', () => {
  const r = runLuaTrace('local base = 10\nlocal function add(x)\n  local y = x + base\n  return y\nend\nlocal r = add(5)\nprint(r)');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '15' }]);
  assert.deepEqual(r.steps.map(s => s.line), [1, 5, 6, 3, 4, 7, -1], 'Lua itself defines a function at its end line (5)');
  const inside = r.steps[4];
  assert.deepEqual(inside.stack, [{ name: 'add', args: 'x=5' }]);
  assert.deepEqual(inside.vars.map(v => [v.name, v.scope, v.node.s]), [['x', 'local', '5'], ['y', 'local', '15'], ['base', 'closure', '10']],
    'locals first, then upvalues; functions are not variables');
  assert.deepEqual(r.steps.at(-1).vars.map(v => v.name), ['base', 'r'], 'the end still shows the top-level locals');
});

test('Lua values become the same snapshot nodes, and tables are arrays (from 1), objects or maps', () => {
  const s = last([
    'Point = {}', 'Point.__index = Point', 'function Point.new(x) return setmetatable({x = x}, Point) end',
    'list = {10, "s", true, 1.5, 2.0}', 'empty = {}', 'obj = {b = 1, a = {2}}', 'map = {[1] = "a", [5] = "b", k = 3}',
    'p = Point.new(4)', 'same = {list, list}', 'n = nil',
  ].join('\n'));
  const v = vars(s);
  assert.deepEqual(v.list.node.items.map(n => [n.k, n.s]), [['num', '10'], ['str', '"s"'], ['bool', 'true'], ['num', '1.5'], ['num', '2.0']]);
  assert.equal(v.list.node.base, 1, 'numbered from 1');
  assert.equal(v.empty.node.t, 'arr');
  assert.deepEqual(v.obj.node.entries.map(e => e[0]), ['a', 'b'], 'string keys: an object, keys sorted (a Lua table has no order)');
  assert.equal(v.map.node.t, 'map'); assert.deepEqual(v.map.node.entries.map(e => e[0].s), ['1', '5', '"k"']);
  assert.equal(v.p.node.cls, 'Point', 'a table whose metatable is a global class gets its name');
  assert.ok(!('Point' in v), 'the class table itself is hidden, like a JavaScript class');
  assert.deepEqual(v.same.node.items.map(n => n.t), ['ref', 'ref']);
  assert.ok(!('n' in v), 'a nil global does not exist in Lua');
});

test('the views count Lua tables from 1: Memory labels, pointer tags, index-based graphs', () => {
  const s = last('local nums = {5, 2, 9}\nlocal i = 1\nadj = {{2, 3}, {3}, {}}');
  const nums = vars(s).nums.node;
  assert.deepEqual(markersFor(nums, s.vars, 'nums'), { 0: ['i'] }, 'i = 1 points at the first cell');
  const labels = buildMemoryView(s, null, 'nums', true).prims.filter(q => q.p.className === 'g-idx').map(q => q.text);
  assert.deepEqual(labels, ['1', '2', '3']);
  const sem = semanticGraph(s, 'adj');
  assert.deepEqual(sem.nodes.map(n => n.key), ['1', '2', '3']);
  assert.deepEqual(sem.edges.map(e => e.from + '>' + e.to), ['1>2', '1>3', '2>3']);
  assert.equal(semanticGraph(last('adj = {{0, 1}, {}}'), 'adj'), null, '0 is not a node when counting from 1');
});

test('a set written as a table of trues tags the nodes it contains', () => {
  const s = last('local g = {A = {"B"}, B = {"C"}, C = {}}\nlocal visited = {A = true, C = true}');
  const text = buildSemanticView(s, null, 'g', semanticGraph(s, 'g'), true).prims.map(q => q.text);
  assert.equal(text.filter(t => t === '∈ visited').length, 2);
});

test('errors: syntax errors say where, runtime errors end the trace, runaway programs are stopped', () => {
  assert.match(traceCode('local x = = 1', 'lua').error, /^Syntax error: line 1: unexpected symbol near '='/);
  assert.deepEqual(runLuaTrace('local t = nil\nprint(t.x)').error, { msg: "Error on line 2: attempt to index a nil value (local 't')" });
  assert.match(runLuaTrace('while true do end').error.msg, /Trace stopped after 3000 steps/);
  const caught = runLuaTrace('local ok = pcall(function() while true do end end)\nprint(ok)');
  assert.match(caught.error.msg, /Trace stopped/, 'pcall cannot swallow the step limit');
  assert.deepEqual(caught.logs, []);
  assert.match(runLuaTrace('local function f(n) return 1 + f(n + 1) end\nf(1)').error.msg, /more than 300 nested calls/);
});

test('every Lua example runs, and its graphs are found', () => {
  for (const [name, code] of Object.entries(LUA_EXAMPLES)) {
    const r = runLuaTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  assert.deepEqual(runLuaTrace(LUA_EXAMPLES['Breadth-first search']).logs.map(l => l.s), ['A B C D E F']);
  const ds = last(LUA_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph'], ['intervals', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'person', 'scores', 'pair']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every Lua example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.lua.shapes) for (const [code, , full] of items) {
    const program = full || (/^\w+ = /.test(code) ? code : 'g = ' + code);
    const name = program.split('\n').at(-1).match(/^(\w+) =/)[1];
    const r = runLuaTrace(program);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  for (const code of [HELP.lua.age, HELP.lua.fruits]) assert.equal(semanticGraph(last('x = ' + code), 'x'), null, code + ' is data');
});
