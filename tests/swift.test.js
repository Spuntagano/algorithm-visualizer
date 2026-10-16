/** Swift: parsed by src/engine/swift/parse.js, run by interp.js with the library in lib.js. Outputs were checked against Swift 6.0.3 (Linux). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runSwiftTrace } from '../src/engine/swift/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { EXAMPLES, SWIFT_EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const out = code => { const r = runSwiftTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runSwiftTrace(code).error.msg;
const last = code => runSwiftTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with the top-level code, methods and closures, locals, self and globals', () => {
  const r = runSwiftTrace('var calls = 0\n\nstruct Acc {\n    let base: Int\n    func add(_ x: Int) -> Int {\n        calls += 1\n        return base + x\n    }\n}\n\nlet a = Acc(base: 10)\nlet r = a.add(5)\nprint(r)\n[1, 2].forEach { x in\n    print(x)\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s), ['15', '1', '2']);
  assert.deepEqual(r.steps.map(s => s.line), [1, 11, 12, 6, 7, 13, 14, 15, 15, -1]);
  assert.deepEqual(r.steps[3].stack, [{ name: 'main', args: '', id: 1 }, { name: 'Acc.add', args: 'x=5', id: 2 }]);
  assert.deepEqual(r.steps[3].vars.map(v => [v.name, v.scope]), [['self', 'local'], ['x', 'local'], ['calls', 'global'], ['a', 'global']], 'self, the locals, then the globals');
  assert.equal(vars(r.steps[3]).self.node.cls, 'Acc');
  assert.deepEqual(r.steps[7].stack.at(-1), { name: 'closure', args: 'x=1', id: 3 }, 'a closure is a frame');
});

test('Swift values become snapshot nodes: numbers, characters, strings, optionals, collections, structs, classes, enums, tuples', () => {
  const s = last([
    'struct P { var x: Int; var s: String }', 'class C { var next: C? = nil }', 'enum Color { case red, green }',
    'let i = 3, d = 2.0, c: Character = "a", b = true, s = "hi"', 'let none: Int? = nil, some: Int? = 4',
    'var arr = [1, 2, 3]', 'let dict = ["k": 1]', 'let set: Set = [2]', 'let p = P(x: 1, s: "a")', 'let obj = C()', 'let col = Color.green',
    'let t = (1, "x")', 'let named = (x: 1, y: 2)', 'let r = 0..<5', 'let sq = { (x: Int) in x * x }',
  ].join('\n'));
  const v = vars(s);
  const prims = Object.fromEntries(['i', 'd', 'c', 'b', 's', 'none', 'some', 'col', 'r'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, { i: ['num', '3'], d: ['num', '2.0'], c: ['char', '"a"'], b: ['bool', 'true'], s: ['str', '"hi"'], none: ['null', 'nil'], some: ['num', '4'],
    col: ['sym', '.green'], r: ['sym', '0..<5'] });
  assert.deepEqual([v.arr.node.tn, v.arr.node.items.map(x => x.s)], ['[Int]', ['1', '2', '3']]);
  assert.deepEqual([v.dict.node.t, v.dict.node.cls, v.set.node.t, v.set.node.cls], ['map', '[String: Int]', 'set', 'Set<Int>']);
  assert.deepEqual([v.p.node.cls, v.p.node.entries.map(e => e[0]), v.obj.node.cls], ['P', ['x', 's'], 'C']);
  assert.deepEqual([v.t.node.tn, v.named.node.entries.map(e => e[0])], ['tuple', ['x', 'y']]);
  assert.deepEqual(v.sq.node, { t: 'fn', s: 'closure' });
  const idx = last('let a = [5, 6, 7]\nlet i = 2');
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 2: ['i'] });
  // a value held in two places is two boxes; a class instance is one, referred to twice
  const two = last('let a = [1, 2]\nlet b = a\nclass K {}\nlet k = K()\nlet k2 = k');
  assert.notEqual(vars(two).a.node.id, vars(two).b.node.id);
  assert.deepEqual(vars(two).k2.node, { t: 'ref', id: vars(two).k.node.id });
});

test("Swift's values and printing: copies of arrays and structs, shared classes, Int and Double rules, Characters, Optional(…)", () => {
  assert.deepEqual(out([
    'var a = [1, 2, 3]', 'var b = a', 'b.append(4)', 'struct P { var x: Int }', 'class C { var x = 0 }',
    'var p = P(x: 1); var q = p; q.x = 9', 'let c = C(); let d = c; d.x = 9', 'print(a, b, p.x, q.x, c.x)',
    'print(7 / 2, -7 / 2, -7 % 3, 0.1 + 0.2, 1e16, 100.0, 2.5e-7, 1.0 / 3, Double(7) / 2)',
    'print(Int.max, Int.min, Int(3.99), Int(-3.99), 1 << 62, 5 &+ Int.max)',
    'let s = "héllo 👋🏽"', 'print(s.count, s.utf8.count, Array(s).count, s.uppercased(), s.first!, s.last!)',
    'let o: Int? = 3; let n: String? = nil', 'print(o as Any, n as Any, o!, [o, nil] as [Int?], o ?? 0, n ?? "none")',
    'print([1: "a"], [String: Int](), Set([2]), (1, "x"), (x: 1, y: 2.5), [P(x: 1)], P(x: 2), C())',
  ].join('\n')), ['[1, 2, 3] [1, 2, 3, 4] 1 9 9', '3 -3 -1 0.30000000000000004 1e+16 100.0 2.5e-07 0.3333333333333333 3.5',
    '9223372036854775807 -9223372036854775808 3 -3 4611686018427387904 -9223372036854775804', '7 15 7 HÉLLO 👋🏽 h 👋🏽',
    'Optional(3) nil 3 [Optional(3), nil] 3 none', '[1: "a"] [:] [2] (1, "x") (x: 1, y: 2.5) [main.P(x: 1)] P(x: 2) main.C']);
});

test('the sequence functions, dictionaries, sets, strings and ranges', () => {
  assert.deepEqual(out([
    'let words = ["banana", "Apple", "cherry", "apple"]',
    'print(words.sorted(), words.sorted { $0.lowercased() < $1.lowercased() }, words.map { $0.count }, words.filter { $0.hasPrefix("a") })',
    'print(words.reduce(0) { $0 + $1.count }, words.joined(separator: "-"), words.firstIndex(of: "cherry")!, words.contains("kiwi"))',
    'print(Dictionary(grouping: words, by: { $0.count }).sorted { $0.key < $1.key }.map { "\\($0.key):\\($0.value)" })',
    'print(Array(zip([1, 2, 3], ["a", "b"])), (1...10).filter { $0 % 3 == 0 }, Array(stride(from: 10, to: 0, by: -4)), Array((0..<5).reversed()))',
    'print("a,b,,c".split(separator: ","), "hello world".split(separator: " ").map { $0.uppercased() }, String("swift".reversed()), "abc".contains("bc"))',
    'var counts: [Character: Int] = [:]', 'for ch in "mississippi" { counts[ch, default: 0] += 1 }',
    'print(counts.keys.sorted(), counts["s"]!, counts.values.reduce(0, +), counts.filter { $0.value > 2 }.count)',
    'let nums = [4, 8, 15, 16, 23, 42]',
    'print(nums.min()!, nums.max()!, nums.prefix(2), nums.suffix(2), Array(nums[1...3]), nums.enumerated().filter { $0.offset % 2 == 0 }.map { $0.element })',
    'print(nums.compactMap { $0 > 10 ? $0 * 2 : nil }, nums.allSatisfy { $0 > 0 }, nums.reversed(), [[1, 2], [3]].flatMap { $0 })',
  ].join('\n')), ['["Apple", "apple", "banana", "cherry"] ["Apple", "apple", "banana", "cherry"] [6, 5, 6, 5] ["apple"]', '22 banana-Apple-cherry-apple 2 false',
    '["5:[\\"Apple\\", \\"apple\\"]", "6:[\\"banana\\", \\"cherry\\"]"]', '[(1, "a"), (2, "b")] [3, 6, 9] [10, 6, 2] [4, 3, 2, 1, 0]',
    '["a", "b", "c"] ["HELLO", "WORLD"] tfiws true', '["i", "m", "p", "s"] 4 11 2', '4 42 [4, 8] [23, 42] [8, 15, 16] [4, 15, 23]',
    '[30, 32, 46, 84] true ReversedCollection<Array<Int>>(_base: [4, 8, 15, 16, 23, 42]) [1, 2, 3]']);
});

test('types: protocols with extensions, classes that override, enums with raw and associated values, errors, inout, closures', () => {
  assert.deepEqual(out([
    'protocol Shape { var area: Double { get } }', 'extension Shape { func describe() -> String { "area \\(area)" } }',
    'struct Rect: Shape { let w: Double, h: Double; var area: Double { w * h } }',
    'class Circle: Shape, CustomStringConvertible {', '    let r: Double', '    init(r: Double) { self.r = r }', '    var area: Double { 3 * r * r }',
    '    var description: String { "Circle(r: \\(r))" }', '}',
    'class Animal { func sound() -> String { "..." }; func speak() -> String { "says " + sound() } }',
    'class Dog: Animal { override func sound() -> String { "woof" } }', 'enum Op: String, CaseIterable { case add = "+", mul = "*" }',
    'indirect enum Expr { case num(Int); case bin(Op, Expr, Expr)', '    func eval() -> Int {', '        switch self {', '        case .num(let n): return n',
    '        case let .bin(op, l, r): return op == .add ? l.eval() + r.eval() : l.eval() * r.eval()', '        }', '    }', '}',
    'enum BankError: Error { case insufficient(needed: Int) }', 'func withdraw(_ amount: Int, from balance: inout Int) throws {',
    '    guard amount <= balance else { throw BankError.insufficient(needed: amount - balance) }', '    balance -= amount', '}',
    'let shapes: [Shape] = [Rect(w: 2, h: 3), Circle(r: 1)]',
    'print(shapes.map { $0.describe() }, shapes[1], Dog().speak(), Op.allCases.map { $0.rawValue }, Op(rawValue: "*")!)',
    'print(Expr.bin(.add, .num(2), .bin(.mul, .num(3), .num(4))).eval())', 'var balance = 50', 'do {', '    try withdraw(20, from: &balance)',
    '    try withdraw(40, from: &balance)', '} catch BankError.insufficient(let needed) {', '    print("short by \\(needed)")', '}',
    'print(balance, (try? withdraw(1, from: &balance)) != nil, balance)', 'var fs: [() -> Int] = []', 'for i in 0..<3 { fs.append { i * 10 } }', 'print(fs.map { $0() })',
  ].join('\n')), ['["area 6.0", "area 3.0"] Circle(r: 1.0) says woof ["+", "*"] mul', '14', 'short by 10', '30 true 29', '[0, 10, 20]']);
});

test('more of the language: generic classes with nested types, inout memo, tuple sorting, String.Index, slices, if expressions, Character ranges', () => {
  assert.deepEqual(out([
    "class LinkedList<T> {",
    "    class Node { var value: T; var next: Node?; init(_ v: T) { value = v } }",
    "    var head: Node?",
    "    var count = 0",
    "    func push(_ v: T) { let n = Node(v); n.next = head; head = n; count += 1 }",
    "    func toArray() -> [T] { var out: [T] = []; var cur = head; while let c = cur { out.append(c.value); cur = c.next }; return out }",
    "}",
    "let ll = LinkedList<String>()",
    "ll.push(\"a\"); ll.push(\"b\")",
    "print(ll.toArray(), ll.count)",
    "protocol Resettable { mutating func reset() }",
    "struct Score: Resettable { var points = 10; mutating func reset() { points = 0 } }",
    "var sc = Score(); sc.reset(); print(sc.points)",
    "struct Config { static let shared = Config(); let name = \"default\"; struct Inner { let v = 3 } }",
    "print(Config.shared.name, Config.Inner().v)",
    "func apply(_ f: (Int) -> Int, to x: Int) -> Int { f(x) }",
    "func compose(_ f: @escaping (Int) -> Int, _ g: @escaping (Int) -> Int) -> (Int) -> Int { { g(f($0)) } }",
    "print(apply({ $0 * 3 }, to: 4), compose({ $0 + 1 }, { $0 * 10 })(2))",
    "func fibm(_ n: Int, _ memo: inout [Int: Int]) -> Int {",
    "    if n < 2 { return n }",
    "    if let v = memo[n] { return v }",
    "    let r = fibm(n - 1, &memo) + fibm(n - 2, &memo)",
    "    memo[n] = r",
    "    return r",
    "}",
    "var mm: [Int: Int] = [:]",
    "print(fibm(40, &mm), mm.count)",
    "struct Student { let name: String; let grade: Int; let age: Int }",
    "let ss = [Student(name: \"Bo\", grade: 90, age: 20), Student(name: \"Al\", grade: 90, age: 19), Student(name: \"Cy\", grade: 85, age: 21)]",
    "print(ss.sorted { ($0.grade, $1.name) > ($1.grade, $0.name) }.map { $0.name })",
    "let digits = \"a1b22c333\".filter { $0.isNumber }.map { Int(String($0))! }",
    "print(digits, digits.reduce(0, +))",
    "let a: Set = [1, 2, 3, 4], b: Set = [3, 4, 5]",
    "print(a.intersection(b).sorted(), a.union(b).sorted(), a.symmetricDifference(b).sorted(), a.isSuperset(of: [1, 2]), b.isDisjoint(with: [9]))",
    "var arr = [3, 1, 2]",
    "arr.swapAt(0, 2)",
    "let sortedArr = arr.sorted()",
    "print(arr, sortedArr, arr == sortedArr, arr.sorted() == [1, 2, 3])",
    "let s = \"hello\"",
    "var idx = s.startIndex",
    "var outStr = \"\"",
    "while idx != s.endIndex { outStr = String(s[idx]) + outStr; idx = s.index(after: idx) }",
    "print(outStr)",
    "let opt: [Int]? = nil",
    "print(opt?.count ?? -1, opt == nil)",
    "let nested: [String: [String: Int]] = [\"a\": [\"x\": 1]]",
    "print(nested[\"a\"]?[\"x\"] ?? 0, nested[\"b\"]?[\"x\"] ?? 0)",
    "var counts = [String: Int]()",
    "[\"x\", \"y\", \"x\"].forEach { counts[$0, default: 0] += 1 }",
    "print(counts.sorted { $0.key < $1.key })",
    "print(Array(repeating: \"-\", count: 3).joined(), (1...4).map { String($0) }.joined(separator: \"+\"))",
    "print([1, 2, 3, 4, 5].split(separator: 3))",
  ].join('\n')), ["[\"b\", \"a\"] 2", "0", "default 3", "12 30", "102334155 39", "[\"Al\", \"Bo\", \"Cy\"]", "[1, 2, 2, 3, 3, 3] 14", "[3, 4] [1, 2, 3, 4, 5] [1, 2, 5] true true", "[2, 1, 3] [1, 2, 3] false true", "olleh", "-1 true", "1 0", "[(key: \"x\", value: 2), (key: \"y\", value: 1)]", "--- 1+2+3+4", "[ArraySlice([1, 2]), ArraySlice([4, 5])]"]);
  assert.deepEqual(out([
    "func isLower(_ c: Character) -> Bool { c >= \"a\" && c <= \"z\" }",
    "print(isLower(\"q\"), isLower(\"Q\"), \"b\" > \"a\")",
    "let caesar = String(\"abcxyz\".map { c -> Character in",
    "    let v = Int(c.asciiValue!) - 97",
    "    return Character(UnicodeScalar(UInt8((v + 3) % 26 + 97)))",
    "})",
    "print(caesar)",
    "let total = [1, 2, 3]",
    "    .map { $0 * 2 }",
    "    .filter { $0 > 2 }",
    "    .reduce(0, +)",
    "print(total)",
    "let grade = 85",
    "let letter = grade >= 90 ? \"A\" : grade >= 80 ? \"B\" : \"C\"",
    "print(letter)",
    "var visited = Array(repeating: false, count: 4)",
    "visited[2] = true",
    "print(visited.firstIndex(of: true)!, visited.filter { !$0 }.count)",
    "struct Edge { let to: Int; let w: Int }",
    "var adj = [[Edge]](repeating: [], count: 3)",
    "adj[0].append(Edge(to: 1, w: 5))",
    "adj[0].append(Edge(to: 2, w: 1))",
    "print(adj[0].map { $0.to }, adj[0].min { $0.w < $1.w }!.to)",
    "let sc = \"Hello, World\".unicodeScalars.filter { $0.value < 97 }.count",
    "print(sc, \"abc\".unicodeScalars.map { $0.value })",
    "func binary(_ n: Int) -> String { n < 2 ? String(n) : binary(n / 2) + String(n % 2) }",
    "print(binary(10))",
    "var seen = Set<String>()",
    "let dupes = [\"a\", \"b\", \"a\", \"c\", \"b\"].filter { !seen.insert($0).inserted }",
    "print(dupes)",
    "let pairs = Dictionary(uniqueKeysWithValues: zip([\"x\", \"y\"], [1, 2]))",
    "print(pairs[\"y\"]!, pairs.count)",
    "var str = \"\"",
    "for i in 1...3 { str += \"\\(i),\" }",
    "str.removeLast()",
    "print(str, str.count)",
    "let v = if grade > 50 { \"pass\" } else { \"fail\" }",
    "print(v)",
  ].join('\n')), ["true false true", "defabc", "10", "B", "2 3", "[1, 2] 2", "4 [97, 98, 99]", "1010", "[\"a\", \"b\"]", "2 2", "1,2,3 5", "pass"]);
  assert.equal(errorOf('let a = [1, 2, 3].dropFirst()\nprint(a[0])'), 'Fatal error: Index out of bounds (line 2)', 'a slice keeps its indices');
});

test("the runtime's fatal errors and the compiler's errors, in Swift's words", () => {
  const cases = [
    ['let a = [1, 2, 3]\nprint(a[5])', 'Fatal error: Index out of range (line 2)'],
    ['var x: Int? = nil\nprint(x!)', 'Fatal error: Unexpectedly found nil while unwrapping an Optional value (line 2)'],
    ['var i = Int.max\ni += 1', 'Fatal error: arithmetic overflow (line 2)'],
    ['var a: [Int] = []\na.removeLast()', "Fatal error: Can't remove last element from an empty collection (line 2)"],
    ['let z = 0\nprint(10 / z)', 'Fatal error: Division by zero (line 2)'],
    ['let r = 5...1', 'Fatal error: Range requires lowerBound <= upperBound (line 1)'],
    ['enum E: Error { case boom }\nfunc f() throws { throw E.boom }\ntry f()', 'Fatal error: Error raised at top level: main.E.boom (line 2)'],
    ['precondition(1 > 2, "nope")', 'Precondition failed: nope (line 1)'],
    ['let x = 5\nx = 6', "Error on line 2: cannot assign to value: 'x' is a 'let' constant"],
    ['print(y)', "Error on line 1: cannot find 'y' in scope"],
    ['let d = 2.5\nlet i = 2\nprint(d * i)', "Error on line 3: binary operator '*' cannot be applied to operands of type 'Double' and 'Int'"],
    ['let s = "abc"\nprint(s[0])', "Error on line 2: 'subscript(_:)' is unavailable: cannot subscript String with an Int, use a String.Index instead."],
    ['let o: Int? = 3\nprint(o + 1)', "Error on line 2: value of optional type 'Int?' must be unwrapped to a value of type 'Int'"],
    ['let x: Int = 2.5', "Error on line 1: cannot convert value of type 'Double' to specified type 'Int'"],
    ['let a = [1, 2]\na.append(3)', "Error on line 2: cannot use mutating member on immutable value: 'a' is a 'let' constant"],
    ['func f(_ n: Int) -> Int {\n    if n > 0 { return 1 }\n}\nprint(f(1))', "Error on line 3: missing return in global function expected to return 'Int'"],
    ['func g(x: Int) {}\ng(3)', "Error on line 2: missing argument label 'x:' in call"],
    ['func f() throws -> Int { 1 }\nlet v = f()', "Error on line 2: call can throw but is not marked with 'try'"],
    ['struct P { var x: Int }\nprint(P(x: 1) == P(x: 1))', "Error on line 2: referencing operator function '==' on 'Equatable' requires that 'P' conform to 'Equatable'"],
    ['while true { }', 'Trace stopped after 3000 steps (possible infinite loop).'],
  ];
  for (const [code, want] of cases) assert.equal(errorOf(code), want, code);
  assert.equal(errorOf('func f(_ n: Int) -> Int { f(n + 1) }\nprint(f(0))'), 'Trace stopped: more than 400 nested calls (the stack would overflow).');
  assert.equal(traceCode('let x = 1 2', 'swift').error, "Syntax error: line 1: consecutive statements on a line must be separated by ';'");
  assert.equal(traceCode('let s = "abc', 'swift').error, 'Syntax error: line 1: unterminated string literal');
  // the output before an error is kept, and the steps up to it
  const r = runSwiftTrace('print("before")\nlet a: [Int] = []\nprint(a[0])');
  assert.deepEqual([r.logs.map(l => l.s), r.steps.at(-1).line], [['before'], 3]);
});

test('every Swift example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(SWIFT_EXAMPLES), Object.keys(EXAMPLES), 'one Swift twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(SWIFT_EXAMPLES)) {
    const r = runSwiftTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runSwiftTrace(SWIFT_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['[1, 2, 5, 6, 9]']);
  assert.deepEqual(logs('Binary search'), ['found at index 5']);
  assert.deepEqual(logs('Two sum'), ['[2, 3]']);
  assert.deepEqual(logs('Fibonacci with memo'), ['8']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['["A", "B", "C", "D", "E", "F"]']);
  const bfs = runSwiftTrace(SWIFT_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur') && s.vars.find(v => v.name === 'queue').node.len > 0);
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited'), 'variables tag the nodes they name or hold');
  const ds = last(SWIFT_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Linked list'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']]) assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'words', 'scores', 'primes', 'p']) assert.equal(kind(ds, n), null, n + ' is data');
  assert.deepEqual([vars(ds).nums.node.items[0].s, vars(ds).copy.node.items[0].s], ['5', '99'], 'changing the copy leaves nums as it was');
});

test('every Swift example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.swift.shapes) for (const [code, , full, name] of items) {
    const r = runSwiftTrace(full || code);
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last('let x = ' + HELP.swift.fruits), 'x'), null, HELP.swift.fruits + ' is data');
});
