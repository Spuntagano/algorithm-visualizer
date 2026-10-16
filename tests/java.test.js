/** Java: parsed by src/engine/java/parse.js, run by interp.js with the library in lib.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runJavaTrace } from '../src/engine/java/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { EXAMPLES, JAVA_EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const M = body => 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n' + body + '\n    }\n}';
const out = code => { const r = runJavaTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runJavaTrace(code).error.msg;
const last = code => runJavaTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with constructors and methods, locals, this and static fields', () => {
  const r = runJavaTrace('public class Main {\n    static int calls = 0;\n    int base;\n    Main(int b) { base = b; }\n    int add(int x) {\n        calls++;\n        return base + x;\n    }\n    public static void main(String[] args) {\n        Main m = new Main(10);\n        int r = m.add(5);\n        System.out.println(r);\n    }\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '15' }]);
  assert.deepEqual(r.steps.map(s => s.line), [10, 4, 11, 6, 7, 12, -1]);
  assert.deepEqual(r.steps[1].stack, [{ name: 'Main.main', args: '', id: 1 }, { name: 'new Main', args: 'b=10', id: 2 }]);
  const inAdd = r.steps[4];
  assert.deepEqual(inAdd.stack.at(-1), { name: 'Main.add', args: 'x=5', id: 3 });
  assert.deepEqual(inAdd.vars.map(v => [v.name, v.scope]), [['this', 'local'], ['x', 'local'], ['calls', 'global']], 'this, the locals, then the static fields');
  assert.equal(vars(inAdd).this.node.cls, 'Main');
  assert.deepEqual(r.steps.at(-1).vars.map(v => v.name), ['m', 'r', 'calls'], 'main\'s String[] args is not shown');
});

test('Java values become snapshot nodes: primitives, Strings, arrays, objects, records, enums, collections', () => {
  const s = last('import java.util.*;\npublic class Main {\n    enum Color { RED, GREEN }\n    record P(int x, String s) {}\n    public static void main(String[] args) {\n' + [
    'int i = 3; long l = 1L << 40; double d = 2; float f = 0.1f; char c = \'a\'; boolean b = true; String s = "hi"; Integer boxed = 7; String none = null;',
    'int[] arr = {1, 2, 3}; int[][] grid = new int[2][2]; Color col = Color.GREEN; P p = new P(1, "a");',
    'List<Integer> list = new ArrayList<>(List.of(3, 1)); Map<String, Integer> map = new HashMap<>(Map.of("k", 1)); Set<String> set = new TreeSet<>(List.of("b", "a"));',
    'Deque<Integer> dq = new ArrayDeque<>(List.of(1, 2)); PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 3)); StringBuilder sb = new StringBuilder("x");',
    'Runnable run = () -> {}; int unset;',
  ].join('\n') + '\n    }\n}');
  const v = vars(s);
  const prims = Object.fromEntries(['i', 'l', 'd', 'f', 'c', 'b', 's', 'boxed', 'none', 'col', 'sb'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, { i: ['num', '3'], l: ['num', '1099511627776'], d: ['num', '2.0'], f: ['num', '0.1'], c: ['char', "'a'"], b: ['bool', 'true'],
    s: ['str', '"hi"'], boxed: ['num', '7'], none: ['null', 'null'], col: ['sym', 'Color.GREEN'], sb: ['str', '"x"'] });
  assert.deepEqual([v.arr.node.tn, v.arr.node.items.map(x => x.s)], ['int[3]', ['1', '2', '3']]);
  assert.equal(v.grid.node.items[0].tn, 'int[2]');
  assert.deepEqual([v.p.node.cls, v.p.node.entries.map(e => e[0])], ['P', ['x', 's']]);
  assert.deepEqual([v.list.node.cls, v.list.node.items.map(x => x.s)], ['ArrayList', ['3', '1']]);
  assert.deepEqual([v.map.node.t, v.map.node.cls], ['map', 'HashMap']);
  assert.deepEqual([v.set.node.t, v.set.node.items.map(x => x.s)], ['set', ['"a"', '"b"']]);
  assert.deepEqual(v.pq.node.items.map(x => x.s), ['1', '5', '3'], 'a PriorityQueue in its heap order');
  assert.deepEqual(v.run.node, { t: 'fn', s: 'lambda' });
  assert.ok(!('unset' in v) || v.unset.node.s === '?', 'a variable not assigned yet');
  const idx = last(M('        int[] a = {5, 6, 7};\n        int i = 2;'));
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 2: ['i'] });
});

test('Java\'s rules: int and long overflow, division, char arithmetic, casts, how doubles print', () => {
  assert.deepEqual(out(M('System.out.println(Integer.MAX_VALUE + 1 + " " + (Integer.MAX_VALUE + 1L) + " " + 7 / 2 + " " + -7 / 2 + " " + -7 % 2 + " " + 7.0 / 2 + " " + (char)(\'a\' + 1) + " " + (\'a\' + 1) + " " + (int) 3.99 + " " + (int) -3.99 + " " + (byte) 200 + " " + (int) 1e20 + " " + (1 << 33) + " " + (-8 >>> 28));')),
    ['-2147483648 2147483648 3 -3 -1 3.5 b 98 3 -3 -56 2147483647 2 15']);
  assert.deepEqual(out(M('System.out.println(1.0 + " " + 0.1 + 0.2 + " " + (0.1 + 0.2) + " " + 100.0 / 3 + " " + 1e7 + " " + 1.0e-5 + " " + 123456789.0 + " " + (float) 0.1 + " " + 1.0f / 3 + " " + 1.0 / 0 + " " + 0.0 / 0);')),
    ['1.0 0.10.2 0.30000000000000004 33.333333333333336 1.0E7 1.0E-5 1.23456789E8 0.1 0.33333334 Infinity NaN']);
  assert.deepEqual(out(M('int x = 10; x += 2.7; char c = \'a\'; c += 2; short s = 1; s *= 1000; System.out.println(x + " " + c + " " + s);')), ['12 c 1000'], 'compound assignment narrows, as in Java');
});

test('identity: the Integer cache, == on Strings, equals, and HashMap\'s own iteration order', () => {
  assert.deepEqual(out(M('Integer a = 127, b = 127, c = 128, d = 128; String s = "hi", t = "hi", u = new String("hi"), w = "h" + "i".toString();\nSystem.out.println((a == b) + " " + (c == d) + " " + c.equals(d) + " " + (s == t) + " " + (s == u) + " " + s.equals(u) + " " + (s == w));')),
    ['true false true true false true false']);
  assert.deepEqual(out(M('Map<String, Integer> m = new HashMap<>(); for (String w : new String[]{"banana", "apple", "cherry", "date", "elderberry", "fig"}) m.put(w, w.length()); System.out.println(m);\nSystem.out.println(new HashSet<>(List.of(100, 3, 17, 42, 1)) + " " + "apple".hashCode());')),
    ['{banana=6, date=4, apple=5, cherry=6, fig=3, elderberry=10}', '[17, 1, 3, 100, 42] 93029210']);
  assert.deepEqual(out(M('Random r = new Random(42); System.out.println(r.nextInt() + " " + r.nextInt(100));')), ['-1170105035 63'], 'java.util.Random is Java\'s generator');
});

test('classes: inheritance and constructor order, abstract methods, interfaces with default methods, anonymous classes, records, enums', () => {
  assert.deepEqual(out([
    'import java.util.*;', 'import java.util.function.*;',
    'abstract class Animal {', '    protected String name;', '    Animal(String name) { this.name = name; System.out.println("Animal " + name); }', '    abstract String sound();',
    '    public String toString() { return name + " says " + sound(); }', '}',
    'class Dog extends Animal {', '    private int tricks = 1;', '    Dog(String n) { super(n); System.out.println("Dog " + tricks); }', '    String sound() { return "woof"; }', '}',
    'class Puppy extends Dog { Puppy() { this("pup"); } Puppy(String n) { super(n); } @Override String sound() { return "yip"; } }',
    'interface Shape { double area(); default String label() { return "shape " + area(); } }',
    'record Circle(double r) implements Shape { public double area() { return 3 * r * r; } }',
    'enum Color { RED, GREEN, BLUE; Color next() { return values()[(ordinal() + 1) % values().length]; } }',
    'public class Main {', '    public static void main(String[] args) {',
    '        Animal a = new Puppy();', '        System.out.println(a + " " + (a instanceof Dog));',
    '        Shape sq = new Shape() { public double area() { return 4.0; } };',
    '        for (Shape s : List.of(new Circle(1), sq)) System.out.println(s.label());',
    '        Function<Integer, Integer> twice = x -> x * 2; BiFunction<Integer, Integer, Integer> add = Integer::sum;',
    '        System.out.println(twice.apply(21) + " " + add.apply(2, 3) + " " + new Circle(2) + " " + Color.BLUE.next() + " " + Color.valueOf("GREEN").ordinal());',
    '        switch (Color.BLUE) { case RED: System.out.println("r"); break; case BLUE: System.out.println("b"); default: System.out.println("fall"); }',
    '        String s = switch (Color.RED) { case RED -> "red"; default -> "?"; };', '        System.out.println(s);',
    '    }', '}',
  ].join('\n')), ['Animal pup', 'Dog 1', 'pup says yip true', 'shape 3.0', 'shape 4.0', '42 5 Circle[r=2.0] RED 1', 'b', 'fall', 'red']);
});

test('the library: lists, deques, priority queues, maps, sets, strings, StringBuilder, printf, arrays, comparators', () => {
  assert.deepEqual(out(M([
    'List<Integer> l = new ArrayList<>(List.of(5, 3, 8)); l.add(1, 9); l.remove(Integer.valueOf(8)); l.remove(0); Collections.sort(l); System.out.println(l + " " + l.get(0) + " " + l.contains(9));',
    'Deque<Integer> st = new ArrayDeque<>(); st.push(1); st.push(2); Queue<String> q = new LinkedList<>(); q.offer("a"); q.offer("b"); System.out.println(st.pop() + " " + st.peek() + " " + q.poll() + " " + q.size());',
    'PriorityQueue<Integer> pq = new PriorityQueue<>(Comparator.reverseOrder()); for (int x : new int[]{3, 1, 4, 1, 5}) pq.offer(x); System.out.println(pq + " " + pq.poll() + " " + pq);',
    'TreeMap<String, Integer> tm = new TreeMap<>(); tm.put("b", 2); tm.put("a", 1); tm.put("c", 3); System.out.println(tm + " " + tm.firstKey() + " " + tm.floorKey("bb") + " " + tm.headMap("c"));',
    'Map<Character, Integer> cnt = new TreeMap<>(); for (char ch : "banana".toCharArray()) cnt.merge(ch, 1, Integer::sum); System.out.println(cnt);',
    'Map<String, List<Integer>> g = new HashMap<>(); g.computeIfAbsent("x", k -> new ArrayList<>()).add(1); for (Map.Entry<String, List<Integer>> en : g.entrySet()) System.out.println(en.getKey() + "=" + en.getValue());',
    'String s = "Hello, World"; System.out.println(s.length() + " " + s.charAt(4) + " " + s.substring(7) + " " + s.indexOf("o") + " " + new StringBuilder(s).reverse() + " " + String.join("-", "a", "b") + " " + Arrays.toString("a,b,,c,,".split(",")) + " " + "abc".compareTo("abd"));',
    'System.out.printf("%d|%5d|%-5d|%05d|%.2f|%s|%c|%b|%,d|%x%n", 42, 42, 42, 42, 3.14159, "hi", \'z\', true, 1234567, 255);',
    'System.out.println(String.format("%.1f %.1f %.2f", 0.25, 0.35, 1.005));',
    'int[] a = {5, 2, 9}; Arrays.sort(a); Integer[] b = {3, 1, 2}; Arrays.sort(b, (x, y) -> y - x); System.out.println(Arrays.toString(a) + " " + Arrays.toString(b) + " " + Arrays.deepToString(new int[2][2]));',
  ].join('\n'))), ['[3, 9] 3 true', '2 1 a 1', '[5, 4, 3, 1, 1] 5 [4, 1, 3, 1]', '{a=1, b=2, c=3} a b {a=1, b=2}', '{a=3, b=1, n=2}', 'x=[1]',
    '12 o World 4 dlroW ,olleH a-b [a, b, , c] -1', '42|   42|42   |00042|3.14|hi|z|true|1,234,567|ff', '0.3 0.4 1.01', '[2, 5, 9] [3, 2, 1] [[0, 0], [0, 0]]']);
  assert.deepEqual(out('import java.util.*;\nrecord P(String name, int age) {}\npublic class Main {\n    public static void main(String[] args) {\n        List<P> ps = new ArrayList<>(List.of(new P("b", 30), new P("a", 30), new P("c", 20)));\n        ps.sort(Comparator.comparingInt(P::age).thenComparing(P::name));\n        System.out.println(ps);\n        ps.sort(Comparator.comparing(P::name).reversed());\n        System.out.println(ps.get(0).name());\n    }\n}'),
    ['[P[name=c, age=20], P[name=a, age=30], P[name=b, age=30]]', 'c']);
});

test('exceptions: try / catch / finally, Java\'s own exceptions with their messages, exceptions of one\'s own, uncaught ones', () => {
  assert.deepEqual(out([
    'class MyEx extends RuntimeException { MyEx(String m) { super(m); } }', 'public class Main {',
    '    static int f(int x) { if (x < 0) throw new MyEx("negative: " + x); return x; }', '    public static void main(String[] args) {',
    '        try { f(-1); } catch (MyEx e) { System.out.println("caught " + e.getMessage()); } finally { System.out.println("finally"); }',
    '        try { int[] a = new int[2]; a[2] = 1; } catch (ArrayIndexOutOfBoundsException e) { System.out.println(e.getMessage()); }',
    '        try { String s = null; s.length(); } catch (NullPointerException e) { System.out.println(e.getMessage()); }',
    '        try { Object o = "s"; Integer i = (Integer) o; } catch (ClassCastException e) { System.out.println("cce"); }',
    '        try { Integer.parseInt("x1"); } catch (NumberFormatException | ArithmeticException e) { System.out.println(e.getMessage()); }',
    '        try { throw new IllegalStateException("bad"); } catch (RuntimeException e) { System.out.println(e); }',
    '    }', '}',
  ].join('\n')), ['caught negative: -1', 'finally', 'Index 2 out of bounds for length 2', 'Cannot invoke "String.length()" because "s" is null', 'cce', 'For input string: "x1"', 'java.lang.IllegalStateException: bad']);
  const cases = [
    ['int[] a = new int[3];\n        a[3] = 1;', 'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 3 (line 6)'],
    ['int x = 5 / 0;', 'Exception in thread "main" java.lang.ArithmeticException: / by zero (line 5)'],
    ['List<Integer> l = new ArrayList<>(List.of(1, 2, 3, 4));\n        for (int x : l) if (x == 1) l.remove(0);', /java\.util\.ConcurrentModificationException: l was changed while a for-each loop was going through it/],
    ['Map<String, Integer> m = new HashMap<>();\n        int v = m.get("missing");', /NullPointerException: Cannot unbox v \(it is null\) to int/],
    ['List<Integer> l = List.of(1, 2);\n        l.add(3);', /UnsupportedOperationException: this list cannot be changed \(List\.of makes an unmodifiable list/],
    ['throw new RuntimeException("boom");', 'Exception in thread "main" java.lang.RuntimeException: boom (line 5)'],
  ];
  for (const [body, want] of cases) { const m = errorOf(M('        ' + body)); if (typeof want === 'string') assert.equal(m, want); else assert.match(m, want); }
  assert.deepEqual(out(M('List<Integer> l = new ArrayList<>(List.of(1, 2, 3));\nfor (Integer x : l) if (x == 2) l.remove(x);\nSystem.out.println(l);')), ['[1, 3]'],
    'removing the second-to-last element ends the loop quietly, as in Java');
});

test('what javac would refuse is reported where it runs; runaway programs are stopped; exit', () => {
  assert.match(errorOf(M('        int x = "hello";')), /^Error on line 5: incompatible types \(x\): String cannot be converted to int$/);
  assert.match(errorOf(M('        double d = 3.5;\n        int i = d;')), /double cannot be converted to int \(a possible loss of precision: write \(int\) to convert\)/);
  assert.match(errorOf(M('        System.out.println(undefinedVar);')), /cannot find symbol: variable undefinedVar/);
  assert.match(errorOf('public class Main {\n    void helper() {}\n    public static void main(String[] args) {\n        helper();\n    }\n}'), /non-static method helper\(\) cannot be referenced from a static context/);
  assert.match(errorOf(M('        Scanner sc = new Scanner(System.in);')), /this page has no keyboard input/);
  assert.match(errorOf(M('        while (true) { }')), /Trace stopped after 3000 steps/);
  assert.match(errorOf('public class Main {\n    static int f(int n) { return f(n + 1); }\n    public static void main(String[] args) { f(0); }\n}'), /more than 300 nested calls/);
  assert.deepEqual(runJavaTrace(M('        System.exit(3);')).error, { msg: 'The program called System.exit(3).', soft: true });
  assert.equal(traceCode(M('        int x = 1\n        int y = 2;'), 'java').error, "Syntax error: line 5: ';' expected at the end of the line");
  assert.match(traceCode('public class Main {}', 'java').error, /there is no main method/);
  assert.deepEqual(out('void main() {\n    int total = 0;\n    for (int i = 1; i <= 4; i++) total += square(i);\n    System.out.println(total);\n}\nint square(int x) { return x * x; }'), ['30'], 'a compact source file (Java 21+)');
});

test('every Java example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(JAVA_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one Java twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(JAVA_EXAMPLES)) {
    const r = runJavaTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runJavaTrace(JAVA_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['[1, 2, 5, 6, 9]']);
  assert.deepEqual(logs('Two sum'), ['[2, 3]']);
  assert.deepEqual(logs('Breadth-first search'), ['[A, B, C, D, E, F]']);
  const bfs = runJavaTrace(JAVA_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur') && s.vars.find(v => v.name === 'queue').node.len > 0);
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited') && text.includes('∈ queue'), 'variables tag the nodes they name or hold');
  const ds = last(JAVA_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']]) assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'words', 'scores', 'primes', 'p']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every Java example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.java.shapes) for (const [code, , full, name] of items) {
    const r = runJavaTrace(full || M('        ' + code));
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last(M('        List<String> x = ' + HELP.java.fruits + ';')), 'x'), null, HELP.java.fruits + ' is data');
});
