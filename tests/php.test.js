/** The PHP tracer (src/engine/php/tracer.php), run in Node through the same php-wasm version the page downloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PhpNode } from 'php-wasm/PhpNode';
import { PHP_BASE_URL, PHP_WASM_FILE, PHP_WASM_VERSION } from '../src/engine/php/php.js';
import { EXAMPLES, PHP_EXAMPLES } from '../src/examples.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { callTree } from '../src/graph/calltree.js';
import { gridMarkers, gridOf } from '../src/graph/grid.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const require = createRequire(import.meta.url);
const TRACER = fs.readFileSync(new URL('../src/engine/php/tracer.php', import.meta.url), 'utf8');
/** { steps, logs, error } or { syntax }: a fresh PHP per run, as in the worker */
const trace = async src => {
  const php = new PhpNode({ version: '8.4' });
  let out = '';
  php.addEventListener('output', e => { out += e.detail.join(''); });
  await php.binary;
  await php.run(TRACER.replace("'__AT_CODE__'", "'" + Buffer.from(src).toString('base64') + "'"));
  return JSON.parse(out.slice(out.lastIndexOf('\x01') + 1));
};
const last = async src => (await trace(src)).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('the page downloads the same php-wasm the tests run, and its PHP 8.4 browser build', () => {
  assert.equal(require('../package.json').devDependencies['php-wasm'], PHP_WASM_VERSION, 'src/engine/php/php.js and package.json must name the same version');
  assert.ok(PHP_BASE_URL.endsWith('/php-wasm@' + PHP_WASM_VERSION + '/'));
  const dir = require.resolve('php-wasm/package.json').replace(/package\.json$/, '');
  assert.ok(fs.readFileSync(dir + 'php8.4-web.mjs', 'utf8').includes(PHP_WASM_FILE), 'php8.4-web.mjs loads ' + PHP_WASM_FILE);
  assert.ok(fs.existsSync(dir + PHP_WASM_FILE));
});

test('a snapshot before every statement, with the call stack, locals and globals', async () => {
  const r = await trace('<?php\nfunction double(int $x): int {\n    $y = $x * 2;\n    return $y;\n}\n$n = 3;\n$m = double($n);\necho $m, "\\n";');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '6' }]);
  assert.deepEqual(r.steps.map(s => s.line), [6, 7, 3, 4, 8, -1], 'before each statement (a function declaration is not one), then the end');
  const inside = r.steps[3];
  assert.deepEqual(inside.stack, [{ name: 'double', args: '$x=3' }]);
  assert.deepEqual(inside.vars.map(v => [v.name, v.scope, v.node.s]), [['$x', 'local', '3'], ['$y', 'local', '6'], ['$n', 'global', '3']],
    'locals first, then the globals; $m does not exist yet');
  assert.deepEqual(r.steps.at(-1).vars.map(v => v.name), ['$n', '$m']);
  const loop = await trace('<?php\nfor ($i = 0; $i < 2; $i++) $s = $i;\nwhile (false) {}\n');
  assert.deepEqual(loop.steps.map(s => s.line), [2, 2, 2, 2, 2, 3, -1], 'a loop takes a step on its line after each round of its body');
});

test('methods show $this, closures and callbacks get steps, output is split into lines', async () => {
  const r = await trace([
    '<?php', 'class Counter {', '    private int $count = 0;', '    public function add(int $k): void {', '        $this->count += $k;', '    }', '}',
    '$c = new Counter();', 'array_map(function ($k) use ($c) {', '    $c->add($k);', '}, [1, 2]);', 'print "a"; echo "b\\n", 1.5, "\\n";', 'printf("%05.1f", 2);',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s), ['ab', '1.5', '002.0']);
  const inAdd = r.steps.find(s => s.line === 5 && s.stack.at(-1).args === '$k=2');
  assert.deepEqual(inAdd.stack.map(f => f.name), ['{closure}', 'Counter->add'], 'array_map itself is not a frame of the program');
  const me = vars(inAdd).$this.node;
  assert.equal(me.cls, 'Counter');
  assert.deepEqual(me.entries.map(([k, n]) => [k, n.s]), [['count', '1']], 'private properties, by name');
  assert.equal(vars(inAdd).$c.node.id, me.id, '$this and $c are the same object');
});

test('PHP values become the same snapshot nodes: lists, keyed arrays (objects or maps), objects, SPL, enums', async () => {
  const s = await last([
    '<?php', 'enum Suit { case Hearts; }', 'class P { public function __construct(public int $x = 1, protected ?P $next = null) {} }',
    '$list = [10, "s", true, 1.5, 2.0, null];', '$empty = [];', '$assoc = ["b" => 1, "a" => [2]];', '$map = [1 => "a", 5 => "b"];',
    '$p = new P();', '$same = [$p, $p];', '$st = new SplStack(); $st->push(1); $st->push(2);', '$suit = Suit::Hearts;', '$f = fn() => 1;',
  ].join('\n'));
  const v = vars(s);
  assert.deepEqual(v.$list.node.items.map(n => [n.k, n.s]), [['num', '10'], ['str', '"s"'], ['bool', 'true'], ['num', '1.5'], ['num', '2.0'], ['null', 'null']]);
  assert.equal(v.$list.node.cls, 'array');
  assert.equal(v.$empty.node.t, 'arr');
  assert.deepEqual([v.$assoc.node.t, v.$assoc.node.entries.map(e => e[0])], ['obj', ['b', 'a']], 'string keys: an object, in order');
  assert.deepEqual([v.$map.node.t, v.$map.node.entries.map(e => e[0].s)], ['map', ['1', '5']]);
  assert.deepEqual([v.$p.node.cls, v.$p.node.entries.map(e => e[0])], ['P', ['x', 'next']], 'protected properties too, by name');
  assert.deepEqual(v.$same.node.items.map(n => n.t), ['ref', 'ref'], 'objects are shared (arrays are copied)');
  assert.deepEqual([v.$st.node.cls, v.$st.node.items.map(n => n.s)], ['SplStack', ['1', '2']], 'bottom to top, as pushed');
  assert.deepEqual([v.$suit.node.k, v.$suit.node.s], ['sym', 'Suit::Hearts']);
  assert.ok(!('$f' in v), 'closures are hidden');
  const idx = await last('<?php\n$a = [5, 6, 7];\n$i = 2;');
  assert.deepEqual(markersFor(vars(idx).$a.node, idx.vars, '$a'), { 2: ['$i'] }, 'an int tags the cell it indexes');
});

test('the program is rewritten without moving its lines: every kind of statement still runs', async () => {
  const r = await trace([
    '<?php',
    'declare(strict_types=1);',
    'if (true): $a = 1; else: $a = 2; endif;',
    'foreach ([1, 2] as $x) if ($x > 1) $b = $x; else $c = $x;',
    'switch ($a) { case 1: $d = "one"; break; default: $d = "?"; }',
    '$k = 0; do { $k++; } while ($k < 3);',
    'try { throw new LogicException("x"); } catch (LogicException $e) { $caught = true; } finally { $fin = 1; }',
    '$m = match ($k) { 3 => "three", default => "?" };',
    '$o = new class { public int $v = 4; public function get(): int { return $this->v; } };',
    '$g = (function () { yield 1; yield 2; })();',
    '$sum = array_sum(iterator_to_array($g));',
    'function &ref(array &$arr) { return $arr; }',
    '$h = <<<EOT',
    '  heredoc {$d}',
    '  EOT;',
    'echo "$a $b $c $d $k $m {$o->get()} $sum $h ", Suit::class ?? "", "\\n";',
    'class Suit {}',
  ].join('\n'));
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s), ['1 2 1 one 3 three 4 3 heredoc one Suit']);
  assert.equal(new Set(r.steps.map(s => s.line)).has(2), false, 'no step before declare (it must stay the first statement)');
});

test('errors: syntax errors say where, exceptions and fatal errors end the trace, warnings are shown, runaway programs are stopped', async () => {
  assert.equal((await trace('<?php\n$x = = 1;')).syntax, 'line 2: syntax error, unexpected token "="');
  const ex = await trace('<?php\n$x = 1;\necho "before\\n";\n$y = intdiv($x, 0);\necho "after";');
  assert.deepEqual(ex.error, { msg: 'DivisionByZeroError: Division by zero on line 4' });
  assert.deepEqual(ex.logs.map(l => l.s), ['before']);
  assert.equal(ex.steps.at(-1).line, 4, 'the last step is the line that failed');
  assert.deepEqual((await trace('<?php\nnope();')).error, { msg: 'Error: Call to undefined function nope() on line 2' });
  assert.deepEqual((await trace('<?php\n$a = 1;\nfunction g() {}\nfunction g() {}')).error, { msg: 'Fatal error: Cannot redeclare function g() (previously declared on line 3) on line 4' });
  assert.match((await trace('<?php\ndeclare(strict_types=1);\nfunction f(int $x) { return $x; }\nf("5");')).error.msg,
    /^TypeError: f\(\): Argument #1 \(\$x\) must be of type int, string given, called on line 4$/);
  const warn = await trace('<?php\n$a = [1];\necho $a[3] ?? "none", "\\n";\necho $a[5];\necho "still running\\n";');
  assert.deepEqual(warn.logs, [{ type: 'log', s: 'none' }, { type: 'warn', s: 'Warning: Undefined array key 5 on line 4' }, { type: 'log', s: 'still running' }]);
  assert.match((await trace('<?php\nwhile (true) { $i = 1; }')).error.msg, /Trace stopped after 3000 steps/);
  assert.match((await trace('<?php\nfor (;;);')).error.msg, /Trace stopped after 3000 steps/, 'an empty loop is stopped too');
  const caught = await trace('<?php\ntry { while (true) { $i = 1; } } catch (Exception $e) { echo "caught"; }');
  assert.match(caught.error.msg, /Trace stopped/, 'catch (Exception) cannot swallow the step limit');
  assert.deepEqual(caught.logs, []);
  assert.match((await trace('<?php\nfunction f($n) { return f($n + 1); }\nf(0);')).error.msg, /more than 300 nested calls/);
});

test('exit() and die() end the run like the end of the program; the opening tag is optional', async () => {
  const r = await trace('<?php\n$x = 1;\nexit;\n$x = 2;');
  assert.equal(r.error, null);
  assert.equal(vars(r.steps.at(-1)).$x.node.s, '1');
  assert.deepEqual((await trace('<?php\nfunction f() { exit(3); }\nf();')).error, { msg: 'The program called exit(3).', soft: true });
  assert.deepEqual((await trace('<?php\ndie("bye\\n");')).logs.map(l => l.s), ['bye']);
  assert.deepEqual((await trace('$v = 2;\necho $v * 3;')).logs.map(l => l.s), ['6'], 'code without <?php runs as PHP');
  assert.deepEqual((await trace('<p><?php $x = 1; ?> <b><?= $x ?></b></p>')).logs.map(l => l.s), ['<p> <b>1</b></p>'], 'text outside the tags is printed');
});

test('every PHP example runs, prints like its twin, and its graphs are found', async () => {
  assert.deepEqual(Object.keys(PHP_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one PHP twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(PHP_EXAMPLES)) {
    const r = await trace(code);
    assert.ok(!r.syntax, name + ': ' + r.syntax);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  assert.deepEqual((await trace(PHP_EXAMPLES['Breadth-first search'])).logs.map(l => l.s), ['A B C D E F']);
  assert.deepEqual((await trace(PHP_EXAMPLES['Two sum'])).logs.map(l => l.s), ['[2,3]']);
  const ds = await last(PHP_EXAMPLES['Data structures']);
  for (const [n, k] of [['$g1', 'Graph'], ['$g2', 'Graph'], ['$adj', 'Graph'], ['$edges', 'Graph'], ['$tree', 'Tree'], ['$linked', 'Linked list'], ['$jobs', 'Graph'], ['$intervals', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['$nums', '$person', '$scores', '$pair', '$stack']) assert.equal(kind(ds, n), null, n + ' is data');
  const text = buildSemanticView(ds, null, '$g1', semanticGraph(ds, '$g1'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ $cur') && text.filter(t => t === '∈ $visited').length === 2, 'variables tag the nodes they name or contain');
});

test('every PHP example in the graph help really is drawn as a graph', async () => {
  for (const [, items] of HELP.php.shapes) for (const [code, , full] of items) {
    const program = full || '<?php\n' + (/^\$\w+ = /.test(code) ? code : '$g = ' + code) + ';';
    const name = program.split('\n').at(-1).match(/^(\$\w+) =/)[1];
    const r = await trace(program);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  for (const code of [HELP.php.age, HELP.php.fruits]) assert.equal(semanticGraph(await last('<?php $x = ' + code + ';'), '$x'), null, code + ' is data');
});

test('call tree: PHP gives no call ids, so calls are told apart by their stacks; a 2D array is a grid', async () => {
  const r = await trace('<?php\nfunction fib(int $n): int { if ($n < 2) return $n; return fib($n - 1) + fib($n - 2); }\n$g = [[1, 2], [3, 4]];\necho fib(3);');
  const tree = callTree(r.steps, r.rets || {});
  assert.deepEqual(tree.nodes.map(n => n.label + (n.ret != null ? '=' + n.ret : '')), ['fib(3)', 'fib(2)', 'fib(1)', 'fib(0)', 'fib(1)']);
  assert.ok(tree.recursive);
  const g = gridOf(r.steps.at(-1), '$g');
  assert.ok(g, 'a grid');
  assert.deepEqual(g.rows.map(row => row.map(c => c.s).join(' ')), ['1 2', '3 4']);
});

test('the Longest common subsequence example fills its table as a grid', async () => {
  const r = await trace(PHP_EXAMPLES['Longest common subsequence']);
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s.trim()).filter(Boolean), ['3']);
  const step = r.steps.findLast(s => s.vars.some(v => v.name === '$dp'));
  assert.deepEqual(gridOf(step, '$dp').rows.map(row => row.map(c => c.s).join('')), ['000000', '000011', '011112', '011222', '011223']);
  const mid = r.steps.find(s => gridOf(s, '$dp') && s.vars.some(v => v.name === '$j'));
  assert.deepEqual(gridMarkers(gridOf(mid, '$dp'), mid.vars, '$dp').cell, [1, 1], 'i and j meet at the first cell worked out');
});
