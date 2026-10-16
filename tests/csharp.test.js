/** C#: parsed by src/engine/cs/parse.js, run by interp.js with the library in lib.js. Outputs were checked against .NET 8. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runCsTrace } from '../src/engine/cs/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { CS_EXAMPLES, EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const out = code => { const r = runCsTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runCsTrace(code).error.msg;
const last = code => runCsTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with constructors, methods and local functions, locals, this and static fields', () => {
  const r = runCsTrace('class Program\n{\n    static int calls = 0;\n    int baseValue;\n    Program(int b) { baseValue = b; }\n    int Add(int x)\n    {\n        calls++;\n        return baseValue + x;\n    }\n    static void Main()\n    {\n        var m = new Program(10);\n        int r = m.Add(5);\n        System.Console.WriteLine(r);\n    }\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '15' }]);
  assert.deepEqual(r.steps.map(s => s.line), [13, 5, 14, 8, 9, 15, -1]);
  assert.deepEqual(r.steps[1].stack, [{ name: 'Program.Main', args: '', id: 1 }, { name: 'new Program', args: 'b=10', id: 2 }]);
  const inAdd = r.steps[3];
  assert.deepEqual(inAdd.stack.at(-1), { name: 'Program.Add', args: 'x=5', id: 3 });
  assert.deepEqual(inAdd.vars.map(v => [v.name, v.scope]), [['this', 'local'], ['x', 'local'], ['calls', 'global']], 'this, the locals, then the static fields');
  assert.equal(vars(inAdd).this.node.cls, 'Program');
  const top = runCsTrace('int total = 0;\nint Square(int x) => x * x;\nfor (int i = 1; i <= 2; i++) total += Square(i);\nConsole.WriteLine(total);');
  assert.deepEqual(top.logs.map(l => l.s), ['5']);
  assert.deepEqual(top.steps.map(st => st.line), [1, 3, 3, 2, 3, 3, 2, 3, 4, -1], 'the hoisted local function is not a step of its own');
  assert.deepEqual(top.steps[3].stack, [{ name: 'Main', args: '', id: 1 }, { name: 'Square', args: 'x=1', id: 2 }], 'top-level statements run as Main; a local function is a frame');
  assert.deepEqual(top.steps[3].vars.map(v => [v.name, v.scope]), [['x', 'local'], ['total', 'global']], 'a local function sees the top-level variables');
});

test('C# values become snapshot nodes: numbers, chars, strings, arrays (and int[,]), collections, records, structs, tuples, enums, null', () => {
  const s = last([
    'int i = 3; long l = 1L << 40; double d = 2; float f = 0.1f; char c = \'a\'; bool b = true; string s = "hi"; string none = null; int? maybe = null;',
    'int[] arr = { 1, 2, 3 }; int[,] grid = new int[2, 3]; var list = new List<int> { 3, 1 }; var map = new Dictionary<string, int> { ["k"] = 1 };',
    'var set = new HashSet<string> { "b", "a" }; var q = new Queue<int>(); q.Enqueue(5); var sb = new System.Text.StringBuilder("x");',
    'var pt = new P(1, "a"); var v = new V { X = 2 }; var t = (1, "x"); var named = (min: 1, max: 9); Color col = Color.Green; Func<int, int> sq = x => x * x;',
    'enum Color { Red, Green }', 'record P(int X, string S);', 'struct V { public int X; }',
  ].join('\n'));
  const v = vars(s);
  const prims = Object.fromEntries(['i', 'l', 'd', 'f', 'c', 'b', 's', 'none', 'maybe', 'col', 'sb'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, { i: ['num', '3'], l: ['num', '1099511627776'], d: ['num', '2'], f: ['num', '0.1'], c: ['char', "'a'"], b: ['bool', 'true'],
    s: ['str', '"hi"'], none: ['null', 'null'], maybe: ['null', 'null'], col: ['sym', 'Color.Green'], sb: ['str', '"x"'] });
  assert.deepEqual([v.arr.node.tn, v.arr.node.items.map(x => x.s)], ['int[3]', ['1', '2', '3']]);
  assert.deepEqual([v.grid.node.tn, v.grid.node.items.length, v.grid.node.items[0].items.length], ['int[2,3]', 2, 3], 'a rectangular array is drawn as its rows');
  assert.deepEqual([v.list.node.cls, v.list.node.items.map(x => x.s)], ['List<int>', ['3', '1']]);
  assert.deepEqual([v.map.node.t, v.map.node.cls], ['map', 'Dictionary<string, int>']);
  assert.deepEqual([v.set.node.t, v.set.node.items.map(x => x.s)], ['set', ['"b"', '"a"']], 'a HashSet in .NET\'s order');
  assert.deepEqual([v.pt.node.cls, v.pt.node.entries.map(e => e[0])], ['P', ['X', 'S']]);
  assert.deepEqual([v.v.node.cls, v.t.node.tn, v.named.node.entries.map(e => e[0])], ['V', '(int, string)', ['min', 'max']], 'a tuple is a pair; a named one an object');
  assert.deepEqual(v.sq.node, { t: 'fn', s: 'lambda' });
  const idx = last('int[] a = { 5, 6, 7 };\nint i = 2;');
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 2: ['i'] });
});

test('.NET\'s numbers: int overflow, integer division, char arithmetic, casts, and doubles printed as .NET 8 prints them', () => {
  assert.deepEqual(out([
    'int big = int.MaxValue;', 'big++;',
    'Console.WriteLine($"{big} {7 / 2} {-7 / 2} {-7 % 3} {7.0 / 2} {\'a\' + 1} {(char)(\'a\' + 1)} {(int)3.99} {(int)-3.99} {1L << 40} {int.MaxValue * 2L}");',
    'Console.WriteLine($"{0.1 + 0.2} {1.0} {1e15} {1e17} {1e-5} {0.0001} {1.0 / 0} {0.0 / 0} {1f / 3} {(float)0.1} {double.MaxValue}");',
    'Console.WriteLine($"{Math.Round(2.5)} {Math.Round(3.5)} {Math.Round(2.675, 2)} {2.675:F2} {0.125:F2} {1234567.891:N2} {0.1234:P1} {42:D5} {255:X} {3.14159:0.00} {12.0:E2}");',
    'Console.WriteLine("{0,5}|{1,-5}|{2:F3}|{0:D3}", 7, "ab", Math.PI);',
    'double avg = 7 / 2;', 'Console.WriteLine(avg + " " + true + " " + \'c\' + 1 + 2);',
  ].join('\n')), ['-2147483648 3 -3 -1 3.5 98 b 3 -3 1099511627776 4294967294',
    '0.30000000000000004 1 1000000000000000 1E+17 1E-05 0.0001 Infinity NaN 0.33333334 0.1 1.7976931348623157E+308',
    '2 4 2.68 2.67 0.12 1,234,567.89 12.3 % 00042 FF 3.14 1.20E+001', '    7|ab   |3.142|007', '3 True c12']);
});

test('.NET\'s orders: Dictionary and HashSet reuse a removed slot, PriorityQueue is a 4-ary heap, List.Sort is introsort, strings sort by culture, new Random(42)', () => {
  assert.deepEqual(out([
    'var d = new Dictionary<string, int> { ["b"] = 1, ["a"] = 2 };', 'd.Remove("b"); d["c"] = 3;', 'Console.WriteLine(string.Join(" ", d));',
    'var hs = new HashSet<int> { 5, 1, 9, 3 };', 'hs.Remove(1); hs.Remove(9); hs.Add(7); hs.Add(8); hs.Add(2);', 'Console.WriteLine(string.Join(" ", hs));',
    'var pq = new PriorityQueue<string, int>();', 'foreach (var (e, p) in new[] { ("a", 5), ("b", 1), ("c", 3), ("d", 1), ("e", 4), ("f", 2), ("g", 0) }) pq.Enqueue(e, p);',
    'Console.WriteLine(string.Join(" ", pq.UnorderedItems.Select(x => x.Element)) + " | " + pq.Dequeue() + pq.Dequeue() + pq.Dequeue());',
    'var ps = Enumerable.Range(0, 20).Select(i => (k: i % 3, i)).ToList();', 'ps.Sort((a, b) => a.k.CompareTo(b.k));', 'Console.WriteLine(string.Join(" ", ps.Select(p => p.i)));',
    'var stable = Enumerable.Range(0, 20).OrderBy(i => i % 3);', 'Console.WriteLine(string.Join(" ", stable));',
    'var names = new List<string> { "banana", "Apple", "cherry", "apple", "Banana" };', 'names.Sort();', 'Console.WriteLine(string.Join(" ", names));',
    'var r = new Random(42);', 'Console.WriteLine(r.Next(100) + " " + r.Next(100) + " " + r.Next());',
  ].join('\n')), ['[c, 3] [a, 2]', '5 8 7 3 2', 'g b c d e a f | gbd', '0 15 12 18 6 9 3 4 7 10 13 1 16 19 8 11 2 14 17 5',
    '0 3 6 9 12 15 18 1 4 7 10 13 16 19 2 5 8 11 14 17', 'apple Apple banana Banana cherry', '66 14 269548474']);
});

test('types: inheritance and C#\'s constructor order, properties, structs as values, records with with, operators, patterns, ref and out, closures', () => {
  assert.deepEqual(out([
    'var shapes = new List<Shape> { new Circle(1), new Square(2) };', 'foreach (var s in shapes) Console.WriteLine(s);',
    'Vec a = new Vec(1, 2), b = a;', 'b.X = 10;', 'var arr = new Vec[2];', 'arr[0].X = 5;', 'Console.WriteLine($"{a} {b} {a + b} {arr[0]} {arr[1]}");',
    'var p1 = new Person("Ada", 36);', 'var p2 = p1 with { Age = 17 };', 'Console.WriteLine($"{p1} {p2.IsAdult} {p1 == new Person("Ada", 36)}");',
    'int x = 1, y = 2;', 'Swap(ref x, ref y);', 'Console.WriteLine($"{x} {y} {(TryHalf(10, out int h) ? h : -1)} {TryHalf(7, out _)}");',
    'foreach (var o in new object[] { null, -5, 7, "", "abc", 2.5 }) Console.Write(Classify(o) + "; ");', 'Console.WriteLine();',
    'var actions = new List<Action>();', 'for (int i = 0; i < 3; i++) actions.Add(() => Console.Write(i));', 'foreach (var i in new[] { 0, 1, 2 }) actions.Add(() => Console.Write(i));',
    'foreach (var act in actions) act();', 'Console.WriteLine();',
    'void Swap(ref int m, ref int n) { (m, n) = (n, m); }',
    'bool TryHalf(int n, out int half) { half = n / 2; return n % 2 == 0; }',
    'string Classify(object o) => o switch { null => "null", int n when n < 0 => "negative", int n => $"int {n}", string { Length: 0 } => "empty", string s => s, _ => "other" };',
    'abstract class Shape', '{', '    static int count;', '    public int Id { get; }', '    protected Shape() { Id = ++count; Console.WriteLine("Shape " + Id); }', '    public abstract double Area();',
    '    public override string ToString() => $"{GetType().Name}#{Id} {Area():F2}";', '}',
    'class Circle : Shape', '{', '    readonly string tag = Log("Circle field");', '    public double R { get; }', '    public Circle(double r) { R = r; Console.WriteLine("Circle"); }',
    '    public override double Area() => Math.PI * R * R;', '    static string Log(string s) { Console.WriteLine(s); return s; }', '}',
    'class Square : Shape { public double Side { get; } public Square(double s) => Side = s; public override double Area() => Side * Side; }',
    'struct Vec { public int X, Y; public Vec(int x, int y) { X = x; Y = y; } public static Vec operator +(Vec a, Vec b) => new Vec(a.X + b.X, a.Y + b.Y); public override string ToString() => $"({X}, {Y})"; }',
    'record Person(string Name, int Age) { public bool IsAdult => Age >= 18; }',
  ].join('\n')), ['Circle field', 'Shape 1', 'Circle', 'Shape 2', 'Circle#1 3.14', 'Square#2 4.00', '(1, 2) (10, 2) (11, 4) (5, 0) (0, 0)',
    'Person { Name = Ada, Age = 36, IsAdult = True } False True', '2 1 5 False', 'null; negative; int 7; empty; abc; other; ', '333012']);
});

test('the library: strings, StringBuilder, LINQ (lazy), collections, parsing, Math, and printing what has no ToString', () => {
  assert.deepEqual(out([
    'string s = "Hello, World";',
    'Console.WriteLine(s.Substring(7) + s[..5] + s[^1] + s.IndexOf(\'o\') + s.Replace("l", "L") + s.ToUpper() + s.Split(", ").Length + s.Contains("World"));',
    'var sb = new System.Text.StringBuilder();', 'sb.Append(1).Append(\'x\').Append("yz").Insert(0, "<");', 'Console.WriteLine(sb + " " + sb.Length);',
    'var nums = new List<int> { 5, 3, 8, 1 };', 'var query = nums.Where(n => n > 2);', 'nums.Add(10);',
    'Console.WriteLine(string.Join(" ", query.OrderBy(n => n).Select(n => n * 10)) + " " + nums.Sum() + " " + nums.Max() + " " + nums.Average() + " " + nums.Count(n => n % 2 == 0));',
    'Console.WriteLine(string.Join(" ", "the cat the dog the end".Split(\' \').GroupBy(w => w).OrderByDescending(g => g.Count()).ThenBy(g => g.Key).Select(g => g.Key + ":" + g.Count())));',
    'Console.WriteLine($"{int.Parse("42") + 1} {int.TryParse("x1", out int bad)} {bad} {double.Parse("2.5")} {Convert.ToString(10, 2)} {Math.Max(3, 7.5)} {Math.Pow(2, 10)} {Math.Abs(-4)}");',
    'var st = new Stack<int>(); st.Push(1); st.Push(2); var q = new Queue<int>(); q.Enqueue(1); q.Enqueue(2);',
    'Console.WriteLine(string.Join(",", st) + " " + q.Peek() + " " + st.Peek());',
    'Console.WriteLine(nums); Console.WriteLine(new int[] { 1 }); Console.WriteLine(nums.Select(x => x)); Console.WriteLine((1, "a")); Console.WriteLine(new KeyValuePair<string, int>("k", 1));',
  ].join('\n')), ['WorldHellod4HeLLo, WorLdHELLO, WORLD2True', '<1xyz 5', '30 50 80 100 27 10 5.4 2', 'the:3 cat:1 dog:1 end:1', '43 False 0 2.5 1010 7.5 1024 4',
    '2,1 1 2', 'System.Collections.Generic.List`1[System.Int32]', 'System.Int32[]', 'System.Linq.Enumerable+SelectListIterator`2[System.Int32,System.Int32]', '(1, a)', '[k, 1]']);
});

test('exceptions with .NET\'s messages, try / catch / finally, and what the C# compiler would refuse', () => {
  assert.deepEqual(out([
    'void Try(Action a) { try { a(); } catch (Exception e) { Console.WriteLine(e.GetType().Name + ": " + e.Message); } finally { Console.Write(""); } }',
    'Try(() => { var a = new int[3]; a[3] = 1; });', 'Try(() => { var l = new List<int>(); var x = l[0]; });', 'Try(() => { var d = new Dictionary<string, int>(); var x = d["k"]; });',
    'Try(() => { string s = null; var n = s.Length; });', 'Try(() => { int z = 0; var n = 1 / z; });', 'Try(() => { new Queue<int>().Dequeue(); });', 'Try(() => int.Parse("abc"));',
    'Try(() => { var l = new List<int> { 1, 2 }; foreach (var x in l) l.Add(x); });', 'Try(() => new List<int>().First());', 'Try(() => throw new MyEx("custom", 7));',
    'class MyEx : Exception { public int Code { get; } public MyEx(string m, int c) : base(m) { Code = c; } }',
  ].join('\n')), ['IndexOutOfRangeException: Index was outside the bounds of the array.', "ArgumentOutOfRangeException: Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')",
    "KeyNotFoundException: The given key 'k' was not present in the dictionary.", 'NullReferenceException: Object reference not set to an instance of an object.', 'DivideByZeroException: Attempted to divide by zero.',
    'InvalidOperationException: Queue empty.', "FormatException: The input string 'abc' was not in a correct format.", 'InvalidOperationException: Collection was modified; enumeration operation may not execute.',
    'InvalidOperationException: Sequence contains no elements', 'MyEx: custom']);
  const cases = [
    ['int[] a = { 1, 2, 3 };\nConsole.WriteLine(a[3]);', 'Unhandled exception. System.IndexOutOfRangeException: Index was outside the bounds of the array. (line 2)'],
    ['throw new InvalidOperationException("nope");', 'Unhandled exception. System.InvalidOperationException: nope (line 1)'],
    ['int x = 3.5;', "Error on line 1: CS0266: Cannot implicitly convert type 'double' to 'int'. An explicit conversion exists (are you missing a cast?)"],
    ['long big = 5;\nint small = big;', "Error on line 2: CS0266: Cannot implicitly convert type 'long' to 'int'. An explicit conversion exists (are you missing a cast?)"],
    ['Console.WriteLine(y);', "Error on line 1: CS0103: The name 'y' does not exist in the current context"],
    ['int x;\nConsole.WriteLine(x);', "Error on line 2: CS0165: Use of unassigned local variable 'x'"],
    ['for (int i = 0; i < 3; i++) { int i = 5; }', "Error on line 1: CS0136: A local or parameter named 'i' cannot be declared in this scope because that name is used in an enclosing local scope to define a local or parameter"],
    ['int x = 5;\nswitch (x) { case 5: Console.WriteLine("five"); case 6: break; }', "Error on line 2: CS0163: Control cannot fall through from one case label ('case 5:') to another"],
    ['Console.WriteLine(Foo(2));\nint Foo(int x) { if (x > 0) return 1; }', "Error on line 2: CS0161: 'Foo(int)': not all code paths return a value"],
    ['var list = new List<int> { 1 };\nConsole.WriteLine(list.Length);', "Error on line 2: CS1061: 'List<int>' does not contain a definition for 'Length' (a List has Count)"],
    ['char c = "a";', "Error on line 1: CS0029: Cannot implicitly convert type 'string' to 'char'"],
    ['while (true) { }', 'Trace stopped after 3000 steps (possible infinite loop).'],
    ['int F(int n) => F(n + 1);\nF(0);', 'Trace stopped: more than 300 nested calls (the stack would overflow: Stack overflow.).'],
  ];
  for (const [code, want] of cases) assert.equal(errorOf(code), want, code);
  assert.equal(traceCode('int a = 1\nConsole.WriteLine(a);', 'csharp').error, 'Syntax error: line 1: CS1002: ; expected (at the end of the line)');
  assert.equal(traceCode('class A { }\nA a = new A();', 'csharp').error, 'Syntax error: line 2: CS8803: Top-level statements must precede namespace and type declarations.');
  assert.match(traceCode('class A { }', 'csharp').error, /CS5001: Program does not contain a static 'Main' method/);
  assert.match(errorOf('var sb = new StringBuilder();'), /CS0246: The type or namespace name 'StringBuilder' could not be found/, 'StringBuilder needs using System.Text, as with .NET\'s implicit usings');
  assert.match(errorOf('Console.ReadLine();'), /this page has no keyboard input/);
  assert.deepEqual(runCsTrace('Console.WriteLine("bye");\nEnvironment.Exit(3);').error, { msg: 'The program called Environment.Exit(3).', soft: true });
});

test('every C# example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(CS_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one C# twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(CS_EXAMPLES)) {
    const r = runCsTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runCsTrace(CS_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['1, 2, 5, 6, 9']);
  assert.deepEqual(logs('Binary search'), ['found at index 5']);
  assert.deepEqual(logs('Two sum'), ['[2, 3]']);
  assert.deepEqual(logs('Fibonacci with memo'), ['8']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['A, B, C, D, E, F']);
  const bfs = runCsTrace(CS_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur') && s.vars.find(v => v.name === 'queue').node.len > 0);
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited'), 'variables tag the nodes they name or hold');
  const ds = last(CS_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']]) assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'words', 'scores', 'primes', 'p', 'grid']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every C# example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.csharp.shapes) for (const [code, , full, name] of items) {
    const r = runCsTrace(full || code);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last('var x = ' + HELP.csharp.fruits + ';'), 'x'), null, HELP.csharp.fruits + ' is data');
});
