/** Kotlin: parsed by src/engine/kotlin/parse.js, run by interp.js with the library in lib.js. Outputs were checked against Kotlin 2.1 (JVM 21). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runKotlinTrace } from '../src/engine/kotlin/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { EXAMPLES, KT_EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const M = body => 'fun main() {\n' + body + '\n}';
const out = code => { const r = runKotlinTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runKotlinTrace(code).error.msg;
const last = code => runKotlinTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with functions, methods and lambdas, locals, this and top-level properties', () => {
  const r = runKotlinTrace('var calls = 0\n\nclass Acc(val base: Int) {\n    fun add(x: Int): Int {\n        calls++\n        return base + x\n    }\n}\n\nfun main() {\n    val a = Acc(10)\n    val r = a.add(5)\n    println(r)\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '15' }]);
  assert.deepEqual(r.steps.map(s => s.line), [11, 12, 5, 6, 13, -1]);
  assert.deepEqual(r.steps[2].stack, [{ name: 'main', args: '', id: 1 }, { name: 'Acc.add', args: 'x=5', id: 2 }]);
  assert.deepEqual(r.steps[2].vars.map(v => [v.name, v.scope]), [['this', 'local'], ['x', 'local'], ['calls', 'global']], 'this, the locals, then the top-level properties');
  assert.equal(vars(r.steps[2]).this.node.cls, 'Acc');
  const lam = runKotlinTrace(M('    listOf(1, 2).forEach { x ->\n        println(x)\n    }'));
  assert.deepEqual(lam.steps[1].stack.at(-1), { name: 'lambda', args: 'x=1', id: 2 }, 'a lambda is a frame');
});

test('Kotlin values become snapshot nodes: numbers, chars, strings, arrays, collections, data classes, pairs, enums, null', () => {
  const s = last('enum class Color { RED, GREEN }\ndata class P(val x: Int, val s: String)\n\nfun main() {\n' + [
    '    val i = 3; val l = 1L shl 40; val d = 2.0; val f = 0.1f; val c = \'a\'; val b = true; val s = "hi"; val none: String? = null',
    '    val arr = intArrayOf(1, 2, 3); val list = mutableListOf(3, 1); val map = mutableMapOf("k" to 1); val set = hashSetOf("b", "a")',
    '    val p = P(1, "a"); val pr = 1 to "x"; val col = Color.GREEN; val sb = StringBuilder("x"); val r = 1..5; val sq = { x: Int -> x * x }',
  ].join('\n') + '\n}');
  const v = vars(s);
  const prims = Object.fromEntries(['i', 'l', 'd', 'f', 'c', 'b', 's', 'none', 'col', 'sb', 'r'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, { i: ['num', '3'], l: ['num', '1099511627776'], d: ['num', '2.0'], f: ['num', '0.1'], c: ['char', "'a'"], b: ['bool', 'true'],
    s: ['str', '"hi"'], none: ['null', 'null'], col: ['sym', 'Color.GREEN'], sb: ['str', '"x"'], r: ['sym', '1..5'] });
  assert.deepEqual([v.arr.node.tn, v.arr.node.items.map(x => x.s)], ['IntArray(3)', ['1', '2', '3']]);
  assert.deepEqual([v.list.node.cls, v.list.node.items.map(x => x.s)], ['MutableList', ['3', '1']]);
  assert.deepEqual([v.map.node.t, v.map.node.cls, v.set.node.cls], ['map', 'MutableMap', 'HashSet']);
  assert.deepEqual([v.p.node.cls, v.p.node.entries.map(e => e[0]), v.pr.node.tn], ['P', ['x', 's'], 'Pair']);
  assert.deepEqual(v.sq.node, { t: 'fn', s: 'lambda' });
  const idx = last(M('    val a = intArrayOf(5, 6, 7)\n    val i = 2'));
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 2: ['i'] });
});

test('the JVM\'s rules and orders: Int overflow, Char arithmetic, doubles printed as Java prints them, HashMap buckets, insertion-ordered maps, Random(42)', () => {
  assert.deepEqual(out(M([
    '    println("${Int.MAX_VALUE + 1} ${7 / 2} ${-7 / 2} ${-7 % 2} ${\'a\' + 1} ${\'b\' - \'a\'} ${\'a\'.code} ${65.toChar()} ${3.99.toInt()} ${1L shl 40}")',
    '    println("${1.0} ${0.1 + 0.2} ${1e10} ${1.0 / 0} ${1.5f} ${10000000.0} ${0.0001}")',
    '    println(hashMapOf("banana" to 6, "apple" to 5, "cherry" to 6, "date" to 4, "elderberry" to 10, "fig" to 3))',
    '    println(hashSetOf(100, 3, 17, 42, 1))',
    '    println(mutableMapOf("b" to 1, "a" to 2))',
    '    val r = kotlin.random.Random(42)',
    '    println("${r.nextInt()} ${r.nextInt(100)} ${r.nextInt(5, 10)} ${r.nextDouble()}")',
    '    println("%.2f %5d %-4s| %x %c %b %,d".format(3.14159, 42, "ab", 255, \'z\', true, 1234567) + " " + String.format("%.1f %.1f", 0.25, 0.35))',
  ].join('\n'))), ['-2147483648 3 -3 -1 b 1 97 A 3 1099511627776', '1.0 0.30000000000000004 1.0E10 Infinity 1.5 1.0E7 1.0E-4',
    '{banana=6, date=4, apple=5, cherry=6, fig=3, elderberry=10}', '[17, 1, 42, 3, 100]', '{b=1, a=2}', '972016666 40 6 0.9737425933886793', '3.14    42 ab  | ff z true 1,234,567 0.3 0.4']);
});

test('the collection functions, strings and ranges', () => {
  assert.deepEqual(out(M([
    '    val words = listOf("banana", "Apple", "cherry", "apple")',
    '    println(words.sorted())', '    println(words.groupBy { it.length })', '    println(words.joinToString(", ", prefix = "[", postfix = "]") { it.take(2) })',
    '    println(listOf(1, 2, 3, 4).partition { it % 2 == 0 })', '    println((1..10).chunked(3))', '    println(listOf(1, 2, 3).zip(listOf("a", "b")))',
    '    println(listOf(1, 2, 3).fold(0) { acc, x -> acc + x })', '    println(listOf("a", "bb").associateWith { it.length })',
    '    println("Hello".reversed() + " " + "a,b,,c".split(",") + " " + "abc".substring(1) + " " + "hello".count { it == \'l\' })',
    '    println("${1..5} ${0 until 5} ${10 downTo 1 step 3} ${(1..10 step 3).toList()} ${\'a\'..\'e\'}")',
    '    println("hello world".filter { it != \' \' }.groupingBy { it }.eachCount())',
    '    println(listOf("bb", "a", "ccc", "dd").sortedWith(compareBy<String> { it.length }.thenByDescending { it }))',
  ].join('\n'))), ['[Apple, apple, banana, cherry]', '{6=[banana, cherry], 5=[Apple, apple]}', '[ba, Ap, ch, ap]', '([2, 4], [1, 3])', '[[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]',
    '[(1, a), (2, b)]', '6', '{a=1, bb=2}', 'olleH [a, b, , c] bc 2', '1..5 0..4 10 downTo 1 step 3 [1, 4, 7, 10] a..e', '{h=1, e=1, l=3, o=2, w=1, r=1, d=1}', '[a, dd, bb, ccc]']);
});

test('classes: Kotlin\'s init order, properties, data classes, enums, sealed classes and when, objects, extensions, labels, non-local return', () => {
  assert.deepEqual(out([
    'abstract class Base(val id: Int) { init { println("Base init $id") }; abstract val name: String; override fun toString() = "$name#$id" }',
    'class Circle(id: Int, val r: Double) : Base(id) { val tag = log("Circle prop"); init { println("Circle init") }; override val name = "circle"',
    '    companion object { fun log(s: String): String { println(s); return s } } }',
    'data class Point(val x: Int, val y: Int) { operator fun plus(o: Point) = Point(x + o.x, y + o.y) }',
    'enum class Dir(val dx: Int) { NORTH(0), EAST(1), SOUTH(0), WEST(-1); fun turnRight() = values()[(ordinal + 1) % values().size] }',
    'sealed class Expr', 'class Num(val v: Int) : Expr()', 'class Add(val l: Expr, val r: Expr) : Expr()',
    'fun eval(e: Expr): Int = when (e) { is Num -> e.v; is Add -> eval(e.l) + eval(e.r) }',
    'object Counter { var count = 0; fun next(): Int { count++; return count } }',
    'fun Int.isEven() = this % 2 == 0',
    'fun firstEven(xs: List<Int>): Int? { xs.forEach { if (it % 2 == 0) return it }; return null }',
    'fun main() {',
    '    println(Circle(1, 1.0))',
    '    val p = Point(1, 2) + Point(3, 4)', '    val (a, b) = p',
    '    println("$p $a $b ${p.copy(y = 0)} ${p == Point(4, 6)} ${p.hashCode()}")',
    '    var d = Dir.NORTH', '    repeat(5) { d = d.turnRight() }', '    println("$d ${d.dx} ${Dir.valueOf("WEST").ordinal} ${Dir.entries}")',
    '    println(eval(Add(Num(2), Add(Num(3), Num(4)))))', '    Counter.next(); Counter.next()', '    println("${Counter.count} ${4.isEven()} ${firstEven(listOf(1, 3, 4))}")',
    '    outer@ for (i in 1..3) { for (j in 1..3) { if (j == 2) continue@outer; if (i == 3) break@outer; print("$i$j ") } }', '    println()',
    '    val fs = mutableListOf<() -> Int>()', '    for (i in 0 until 3) fs.add { i * 10 }', '    println(fs.map { it() })',
    '    val r = try { "12x".toInt() } catch (e: NumberFormatException) { println(e.message); -1 } finally { println("done") }', '    println(r)',
    '}',
  ].join('\n')), ['Base init 1', 'Circle prop', 'Circle init', 'circle#1', 'Point(x=4, y=6) 4 6 Point(x=4, y=0) true 130', 'EAST 1 3 [NORTH, EAST, SOUTH, WEST]', '9', '2 true 4',
    '11 21 ', '[0, 10, 20]', 'For input string: "12x"', 'done', '-1']);
});

test('exceptions with the JVM\'s messages, and what the Kotlin compiler would refuse, as K2 words it', () => {
  const cases = [
    ['    val a = listOf(1, 2, 3)\n    println(a[5])', 'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 3 (line 3)'],
    ['    val a = mutableListOf(1, 2, 3)\n    println(a[5])', 'Exception in thread "main" java.lang.IndexOutOfBoundsException: Index 5 out of bounds for length 3 (line 3)'],
    ['    val x = 0\n    println(10 / x)', 'Exception in thread "main" java.lang.ArithmeticException: / by zero (line 3)'],
    ['    val s: String? = null\n    println(s!!.length)', 'Exception in thread "main" java.lang.NullPointerException (line 3)'],
    ['    println(emptyList<Int>().first())', 'Exception in thread "main" java.util.NoSuchElementException: List is empty. (line 2)'],
    ['    val m = mapOf("a" to 1)\n    println(m.getValue("b"))', 'Exception in thread "main" java.util.NoSuchElementException: Key b is missing in the map. (line 3)'],
    ['    error("boom")', 'Exception in thread "main" java.lang.IllegalStateException: boom (line 2)'],
    ['    val a = mutableListOf(1, 2, 3)\n    for (x in a) if (x == 1) a.remove(x)', 'Exception in thread "main" java.util.ConcurrentModificationException (line 3)'],
    ['    val x = 1\n    x = 2', "Error on line 3: 'val' cannot be reassigned."],
    ['    println(y)', "Error on line 2: unresolved reference 'y'."],
    ['    val d: Double = 5', "Error on line 2: initializer type mismatch: expected 'kotlin.Double', actual 'kotlin.Int'."],
    ['    val s: String? = null\n    println(s.length)', "Error on line 3: only safe (?.) or non-null asserted (!!.) calls are allowed on a nullable receiver of type 'kotlin.String?'."],
    ['    var x: Int\n    println(x)', "Error on line 3: variable 'x' must be initialized."],
    ['    val x = 5\n    val r = when (x) { 1 -> "a" }', "Error on line 3: 'when' expression must be exhaustive. Add an 'else' branch."],
    ['    while (true) { }', 'Trace stopped after 3000 steps (possible infinite loop).'],
  ];
  for (const [body, want] of cases) assert.equal(errorOf(M(body)), want, body);
  assert.equal(errorOf('fun f(n: Int): Int = f(n + 1)\nfun main() { f(0) }'), 'Trace stopped: more than 300 nested calls (java.lang.StackOverflowError).');
  assert.match(errorOf(M('    val l = listOf(1)\n    l.add(2)')), /^Error on line 3: unresolved reference 'add'/, 'listOf makes a read-only List');
  assert.equal(traceCode(M('    val x = 1 2'), 'kotlin').error, "Syntax error: line 2: unexpected tokens (use ';' to separate expressions on the same line): '2'.");
  assert.match(traceCode('fun helper() {}', 'kotlin').error, /no main function found/);
  assert.match(errorOf(M('    readln()')), /this page has no keyboard input/);
});

test('every Kotlin example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(KT_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one Kotlin twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(KT_EXAMPLES)) {
    const r = runKotlinTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runKotlinTrace(KT_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['[1, 2, 5, 6, 9]']);
  assert.deepEqual(logs('Binary search'), ['found at index 5']);
  assert.deepEqual(logs('Two sum'), ['[2, 3]']);
  assert.deepEqual(logs('Fibonacci with memo'), ['8']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['[A, B, C, D, E, F]']);
  const bfs = runKotlinTrace(KT_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur') && s.vars.find(v => v.name === 'queue').node.len > 0);
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited'), 'variables tag the nodes they name or hold');
  const ds = last(KT_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']]) assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'words', 'scores', 'primes', 'p']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every Kotlin example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.kotlin.shapes) for (const [code, , full, name] of items) {
    const r = runKotlinTrace(full || M('    ' + code));
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last(M('    val x = ' + HELP.kotlin.fruits)), 'x'), null, HELP.kotlin.fruits + ' is data');
});
