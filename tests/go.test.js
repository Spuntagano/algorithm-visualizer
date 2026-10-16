/** Go: parsed by src/engine/go/parse.js, run by interp.js with the library in lib.js. Outputs were checked against go1.23. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runGoTrace } from '../src/engine/go/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { EXAMPLES, GO_EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

/** a program: imports, then main's body */
const M = (body, imports = ['fmt']) => 'package main\n\n' + imports.map(i => `import "${i}"\n`).join('') + '\nfunc main() {\n' + body + '\n}';
const out = code => { const r = runGoTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runGoTrace(code).error.msg;
const last = code => runGoTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with functions and methods, locals and package variables', () => {
  const r = runGoTrace('package main\n\nimport "fmt"\n\nvar calls = 0\n\ntype Acc struct{ base int }\n\nfunc (a *Acc) Add(x int) int {\n    calls++\n    return a.base + x\n}\n\nfunc main() {\n    a := &Acc{10}\n    r := a.Add(5)\n    fmt.Println(r)\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '15' }]);
  assert.deepEqual(r.steps.map(s => s.line), [15, 16, 10, 11, 17, -1]);
  assert.deepEqual(r.steps[0].stack, [{ name: 'main', args: '', id: 1 }]);
  const inAdd = r.steps[2];
  assert.deepEqual(inAdd.stack.at(-1), { name: '(*Acc).Add', args: 'a=&Acc{…}, x=5', id: 2 });
  assert.deepEqual(inAdd.vars.map(v => [v.name, v.scope]), [['a', 'local'], ['x', 'local'], ['calls', 'global']], 'the receiver, the locals, then the package variables');
  assert.equal(vars(inAdd).a.node.cls, 'Acc', 'a pointer to a struct is drawn as the struct');
  assert.deepEqual(r.steps.at(-1).vars.map(v => v.name), ['a', 'r', 'calls']);
});

test('Go values become snapshot nodes: numbers, strings, runes, slices (len and cap), arrays, maps, structs, pointers, nil', () => {
  const s = last(M([
    '    i, f, b, s, r := 3, 2.0, true, "hi", \'a\'',
    '    var big int64 = 1 << 40',
    '    var none []int',
    '    var m map[string]int',
    '    var p *int',
    '    xs := make([]int, 3, 5)',
    '    arr := [2]string{"x", "y"}',
    '    ages := map[string]int{"ada": 36}',
    '    type P struct{ X, Y int }',
    '    pt := P{1, 2}',
    '    pp := &pt',
    '    n := 7',
    '    pn := &n',
    '    fn := func() {}',
    '    _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _ = i, f, b, s, r, big, none, m, p, xs, arr, ages, pt, pp, n, pn, fn',
  ].join('\n'), []));
  const v = vars(s);
  const prims = Object.fromEntries(['i', 'f', 'b', 's', 'r', 'big', 'none', 'm', 'p', 'pn'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, { i: ['num', '3'], f: ['num', '2'], b: ['bool', 'true'], s: ['str', '"hi"'], r: ['char', "'a'"], big: ['num', '1099511627776'],
    none: ['null', 'nil'], m: ['null', 'nil'], p: ['null', 'nil'], pn: ['ptr', '&n'] });
  assert.deepEqual([v.xs.node.tn, v.xs.node.items.map(x => x.s)], ['[]int len 3 cap 5', ['0', '0', '0']]);
  assert.deepEqual([v.arr.node.tn, v.arr.node.items.map(x => x.s)], ['[2]string', ['"x"', '"y"']]);
  assert.deepEqual([v.ages.node.t, v.ages.node.cls], ['map', 'map[string]int']);
  assert.deepEqual([v.pt.node.cls, v.pt.node.entries.map(e => e[0])], ['P', ['X', 'Y']]);
  assert.deepEqual(v.pp.node, { t: 'ref', id: v.pt.node.id }, 'a pointer is an arrow to the struct it points at');
  assert.deepEqual(v.fn.node, { t: 'fn', s: 'func literal' });
  const idx = last(M('    a := []int{5, 6, 7}\n    i := 2\n    p := &a[1]\n    fmt.Println(a, i, *p)'));
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 1: ['p'], 2: ['i'] }, 'an index and a pointer to a cell tag that cell');
});

test('fmt as Go writes it: verbs, widths, %v of slices, maps (keys sorted), structs and pointers, floats, wrong verbs', () => {
  assert.deepEqual(out(M([
    '    type Point struct{ X, Y int }',
    '    p := Point{1, 2}',
    '    fmt.Printf("%v %+v %#v %T %v\\n", p, p, p, p, &p)',
    '    fmt.Printf("%d|%5d|%-5d|%05d|%x|%X|%o|%b|%c|%q|%U\\n", 42, 42, 42, -42, 255, 255, 8, 5, \'A\', \'A\', \'A\')',
    '    fmt.Printf("%s|%10s|%q|%.2s|%f|%.2f|%8.3f|%e|%g\\n", "go", "go", "go\\n", "golang", 3.14159, 2.675, 3.14159, 123456.789, 0.000012345)',
    '    fmt.Printf("%.1f %.1f %.0f %.0f\\n", 0.25, 0.35, 0.5, 1.5)',
    '    fmt.Printf("%d %s %d\\n", "x", 5)',
    '    fmt.Println(3.0, 1e6, 1234567.0, 100000.0, 0.00001, 1e21, float32(0.1))',
    '    a, b := 0.1, 0.2',
    '    fmt.Println(0.1+0.2, a+b, 7/2, -7/2, -7%3, 7.0/2, 1<<10)',
    '    fmt.Println([]int{1, 2}, []string{"a", "b"}, map[string]int{"z": 1, "a": 2}, [3]bool{true})',
    '    var xs []int',
    '    var m map[string]int',
    '    var e error',
    '    fmt.Println(xs, m, e, xs == nil, len(m))',
    '    fmt.Print("a", "b", 1, 2, "c", 3.5, true, "\\n")',
    '    fmt.Printf("%3d|%x|% x\\n", []int{1, 22}, "hi", "abc")',
  ].join('\n'))), ['{1 2} {X:1 Y:2} main.Point{X:1, Y:2} main.Point &{1 2}', '42|   42|42   |-0042|ff|FF|10|101|A|\'A\'|U+0041',
    'go|        go|"go\\n"|go|3.141590|2.67|   3.142|1.234568e+05|1.2345e-05', '0.2 0.3 0 2', '%!d(string=x) %!s(int=5) %!d(MISSING)',
    '3 1e+06 1.234567e+06 100000 1e-05 1e+21 0.1', '0.3 0.30000000000000004 3 -3 -1 3.5 1024', '[1 2] [a b] map[a:2 z:1] [true false false]',
    '[] map[] <nil> true 0', 'ab1 2c3.5 true', '[  1  22]|6869|61 62 63']);
});

test('Go\'s rules: value semantics of structs and arrays, slices sharing a backing array, append growth, integer overflow, closures per loop round', () => {
  assert.deepEqual(out(M([
    '    a := []int{1, 2, 3, 4, 5}',
    '    b := a[1:3]',
    '    b = append(b, 99)',
    '    fmt.Println(a, b, len(b), cap(b))',
    '    b = append(b, 100, 101, 102)',
    '    b[0] = -1',
    '    fmt.Println(a, b, len(b), cap(b))',
    '    var s []int',
    '    for i := 0; i < 10; i++ {',
    '        s = append(s, i)',
    '        fmt.Print(cap(s), " ")',
    '    }',
    '    fmt.Println()',
    '    arr := [3]int{1, 2, 3}',
    '    arr2 := arr',
    '    arr2[0] = 9',
    '    type P struct{ X, Y int }',
    '    p1 := P{1, 2}',
    '    p2 := p1',
    '    p2.X = 5',
    '    ps := []P{{1, 1}}',
    '    for _, q := range ps {',
    '        q.X = 100',
    '    }',
    '    fmt.Println(arr, arr2, p1, p2, ps, arr == [3]int{1, 2, 3})',
    '    var i8 int8 = 127',
    '    i8++',
    '    var u8 uint8',
    '    u8--',
    '    x := 9223372036854775807',
    '    x++',
    '    fmt.Println(i8, u8, x)',
    '    var fs []func()',
    '    for i := 0; i < 3; i++ {',
    '        fs = append(fs, func() { fmt.Print(i, " ") })',
    '    }',
    '    for _, f := range fs {',
    '        f()',
    '    }',
    '    fmt.Println()',
  ].join('\n'))), ['[1 2 3 99 5] [2 3 99] 3 4', '[1 2 3 99 5] [-1 3 99 100 101 102] 6 8', '1 2 4 4 8 8 8 8 16 16 ', '[1 2 3] [9 2 3] {1 2} {5 2} [{1 1}] true',
    '-128 255 -9223372036854775808', '0 1 2 ']);
  assert.deepEqual(out(M('    s := "héllo"\n    fmt.Println(len(s), s[1], []byte("hé"), []rune("hé"), string(rune(65)))\n    for i, r := range "hé!" {\n        fmt.Print(i, ":", string(r), " ")\n    }\n    fmt.Println()')),
    ['6 195 [104 195 169] [104 233] A', '0:h 1:é 3:! ']);
});

test('types: methods (value and pointer receivers, on nil too), interfaces, embedding, Stringer, generics, closures, defer and recover', () => {
  assert.deepEqual(out([
    'package main', '', 'import (', '    "errors"', '    "fmt"', ')', '',
    'type Shape interface{ Area() float64 }', 'type Rect struct{ W, H float64 }', 'type Circle struct{ R float64 }',
    'func (r Rect) Area() float64    { return r.W * r.H }', 'func (c Circle) Area() float64  { return 3 * c.R * c.R }', 'func (c *Circle) Grow(f float64) { c.R *= f }',
    'type Animal struct{ Name string }', 'func (a Animal) Speak() string { return a.Name + " speaks" }', 'type Dog struct {', '    Animal', '    Breed string', '}',
    'type Color int', 'const (', '    Red Color = iota', '    Green', ')', 'func (c Color) String() string { return [...]string{"Red", "Green"}[c] }',
    'type Tree struct {', '    Left, Right *Tree', '    Val         int', '}',
    'func (t *Tree) Insert(v int) *Tree {', '    if t == nil {', '        return &Tree{Val: v}', '    }', '    if v < t.Val {', '        t.Left = t.Left.Insert(v)', '    } else {', '        t.Right = t.Right.Insert(v)', '    }', '    return t', '}',
    'type Stack[T any] struct{ items []T }', 'func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }',
    'func Map[T, U any](xs []T, f func(T) U) []U {', '    var out []U', '    for _, x := range xs {', '        out = append(out, f(x))', '    }', '    return out', '}',
    'func named() (x int) {', '    defer func() { x *= 2 }()', '    x = 5', '    return x + 1', '}',
    'func safeDiv(a, b int) (res int, err error) {', '    defer func() {', '        if r := recover(); r != nil {', '            err = fmt.Errorf("recovered: %v", r)', '        }', '    }()', '    return a / b, nil', '}',
    'var ErrMissing = errors.New("missing")',
    'func main() {',
    '    for _, s := range []Shape{Rect{3, 4}, Circle{1}} {', '        fmt.Printf("%T %.1f\\n", s, s.Area())', '    }',
    '    c := Circle{2}', '    c.Grow(1.5)', '    d := Dog{Animal{"Rex"}, "lab"}',
    '    fmt.Println(c.R, d.Speak(), d.Name, Green, Red+1)',
    '    var root *Tree', '    for _, v := range []int{5, 3, 8, 1} {', '        root = root.Insert(v)', '    }',
    '    var st Stack[string]', '    st.Push("a")',
    '    fmt.Println(root.Left.Left.Val, root.Right.Val, st.items, Map([]int{1, 2}, func(x int) string { return fmt.Sprint(x * 10) }))',
    '    r, err := safeDiv(1, 0)', '    w := fmt.Errorf("load: %w", ErrMissing)',
    '    fmt.Println(named(), r, err, w, errors.Is(w, ErrMissing))',
    '    for i := 0; i < 2; i++ {', '        defer fmt.Println("deferred", i)', '    }',
    '}',
  ].join('\n')), ['main.Rect 12.0', 'main.Circle 3.0', '3 Rex speaks Rex Green Green', '1 8 [a] [10 20]',
    '12 0 recovered: runtime error: integer divide by zero load: missing true', 'deferred 1', 'deferred 0']);
});

test('the library: sort, slices, strings and Builder, strconv, math, unicode, container/heap', () => {
  assert.deepEqual(out([
    'package main', '', 'import (', '    "container/heap"', '    "fmt"', '    "math"', '    "slices"', '    "sort"', '    "strconv"', '    "strings"', '    "unicode"', ')', '',
    'type IntHeap []int', 'func (h IntHeap) Len() int           { return len(h) }', 'func (h IntHeap) Less(i, j int) bool { return h[i] < h[j] }',
    'func (h IntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }', 'func (h *IntHeap) Push(x any)        { *h = append(*h, x.(int)) }',
    'func (h *IntHeap) Pop() any {', '    old := *h', '    n := len(old)', '    x := old[n-1]', '    *h = old[:n-1]', '    return x', '}',
    'func main() {',
    '    words := []string{"banana", "apple", "cherry", "fig"}',
    '    sort.Slice(words, func(i, j int) bool { return len(words[i]) < len(words[j]) })',
    '    nums := []int{3, 1, 2}', '    sort.Sort(sort.Reverse(sort.IntSlice(nums)))',
    '    ys := []int{4, 2, 9}', '    slices.Sort(ys)', '    i, found := slices.BinarySearch(ys, 9)',
    '    fmt.Println(words, nums, ys, i, found, slices.Contains(ys, 2), slices.Index(ys, 4), sort.SearchInts(ys, 3))',
    '    var sb strings.Builder', '    for i := 0; i < 3; i++ {', '        sb.WriteString(strconv.Itoa(i))', '        sb.WriteByte(\',\')', '    }',
    '    fmt.Println(sb.String(), strings.Split("a,b,,c", ","), strings.Fields("  a b "), strings.Repeat("ab", 2), strings.ToUpper("go"), strings.Index("chicken", "ken"), strings.TrimSpace(" x "))',
    '    n, err := strconv.Atoi("12a")', '    m, _ := strconv.Atoi("-7")',
    '    fmt.Println(n, err, m, strconv.Quote("hi"), strconv.FormatInt(255, 2))',
    '    fmt.Println(math.Sqrt(2), math.Floor(-1.5), math.MaxInt64, math.Inf(1), math.Abs(-3), unicode.IsUpper(\'A\'), string(unicode.ToUpper(\'q\')))',
    '    h := &IntHeap{5, 2, 8}', '    heap.Init(h)', '    heap.Push(h, 3)', '    for h.Len() > 0 {', '        fmt.Print(heap.Pop(h), " ")', '    }', '    fmt.Println()',
    '}',
  ].join('\n')), ['[fig apple banana cherry] [3 2 1] [2 4 9] 2 true true 1 1', '0,1,2, [a b  c] [a b] abab GO 4 x',
    '0 strconv.Atoi: parsing "12a": invalid syntax -7 "hi" 11111111', '1.4142135623730951 -2 9223372036854775807 +Inf 3 true Q', '2 3 5 8 ']);
});

test('panics and what the Go compiler would refuse, with Go\'s messages; runaway programs are stopped', () => {
  const cases = [
    ['    a := []int{1, 2, 3}\n    i := 5\n    fmt.Println(a[i])', 'panic: runtime error: index out of range [5] with length 3 (line 8)'],
    ['    var m map[string]int\n    m["a"] = 1\n    fmt.Println(m)', 'panic: assignment to entry in nil map (line 7)'],
    ['    type N struct{ V int }\n    var p *N\n    fmt.Println(p.V)', 'panic: runtime error: invalid memory address or nil pointer dereference (line 8)'],
    ['    x := 0\n    fmt.Println(10 / x)', 'panic: runtime error: integer divide by zero (line 7)'],
    ['    var i any = 1\n    s := i.(string)\n    fmt.Println(s)', 'panic: interface conversion: interface {} is int, not string (line 7)'],
    ['    fmt.Println("x")\n    panic(fmt.Sprintf("bad %d", 3))', 'panic: bad 3 (line 7)'],
    ['    a := []int{1}\n    fmt.Println(a[1:5])', 'panic: runtime error: slice bounds out of range [:5] with capacity 1 (line 7)'],
    ['    x := 1.5\n    n := 2\n    fmt.Println(x * n)', 'Error on line 8: invalid operation: x * n (mismatched types float64 and int)'],
    ['    var x int = "s"\n    fmt.Println(x)', 'Error on line 6: cannot use "s" (untyped string constant) as int value in variable declaration'],
    ['    fmt.Println("a" + 1)', 'Error on line 6: invalid operation: "a" + 1 (mismatched types untyped string and untyped int)'],
    ['    s := "abc"\n    s[0] = 1\n    fmt.Println(s)', /^Error on line 7: cannot assign to s\[0\] \(neither addressable nor a map index expression\)/],
    ['    x := 3\n    x := 4\n    fmt.Println(x)', 'Error on line 7: no new variables on left side of :='],
    ['    fmt.Println(undefinedThing)', 'Error on line 6: undefined: undefinedThing'],
    ['    for {\n    }\n    fmt.Println()', 'Trace stopped after 3000 steps (possible infinite loop).'],
  ];
  for (const [body, want] of cases) { const m = errorOf(M(body)); if (typeof want === 'string') assert.equal(m, want, body); else assert.match(m, want, body); }
  assert.equal(errorOf('package main\n\nfunc f(n int) int { return f(n + 1) }\n\nfunc main() { f(0) }'), 'Trace stopped: more than 300 nested calls (goroutine stack exceeds the limit).');
  assert.equal(errorOf('package main\n\nimport "fmt"\n\nfunc g() (int, int) { return 1, 2 }\n\nfunc main() {\n    x := g()\n    fmt.Println(x)\n}'), 'Error on line 8: assignment mismatch: 1 variable but g returns 2 values');
  assert.equal(errorOf('package main\n\nimport "math"\n\nfunc main() {\n    n := 2\n    _ = math.Sqrt(n)\n}'), 'Error on line 7: cannot use n (variable of type int) as float64 value in argument to math.Sqrt (convert it: float64(…))');
  assert.deepEqual(runGoTrace(M('    fmt.Println("bye")\n    os.Exit(3)', ['fmt', 'os'])).error, { msg: 'The program called os.Exit(3).', soft: true });
  assert.equal(traceCode(M('    x := 5', []), 'go').error, 'Syntax error: line 5: declared and not used: x');
  assert.equal(traceCode('package main\n\nimport (\n    "fmt"\n    "os"\n)\n\nfunc main() { fmt.Println() }', 'go').error, 'Syntax error: line 5: "os" imported and not used');
  assert.equal(traceCode(M('    x := []int{1, 2\n    fmt.Println(x)'), 'go').error, 'Syntax error: line 6: syntax error: unexpected newline in composite literal; possibly missing comma or }');
  assert.match(traceCode(M('    go fmt.Println()'), 'go').error, /goroutines \(go f\(\)\) are not supported here/);
  assert.match(traceCode('package main\n\nfunc helper() {}', 'go').error, /function main is undeclared in the main package/);
});

test('every Go example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(GO_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one Go twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(GO_EXAMPLES)) {
    const r = runGoTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runGoTrace(GO_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['[1 2 5 6 9]']);
  assert.deepEqual(logs('Binary search'), ['found at index 5']);
  assert.deepEqual(logs('Two sum'), ['[2 3]']);
  assert.deepEqual(logs('Fibonacci with memo'), ['8']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['[A B C D E F]']);
  const bfs = runGoTrace(GO_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur') && s.vars.find(v => v.name === 'queue').node.len > 0);
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited'), 'variables tag the nodes they name or hold (a map[string]bool is a set)');
  const ds = last(GO_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']]) assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'words', 'scores', 'grid', 'p']) assert.equal(kind(ds, n), null, n + ' is data');
  const rev = runGoTrace(GO_EXAMPLES['Reverse a linked list']).steps.at(-1);
  assert.equal(kind(rev, 'prev'), 'Linked list', 'structs linked by pointers (with capitalized fields) are a list');
});

test('every Go example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.go.shapes) for (const [code, , full, name] of items) {
    const r = runGoTrace(full || M('    ' + code + '\n    _ = ' + name, []));
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last(M('    x := ' + HELP.go.fruits + '\n    _ = x', [])), 'x'), null, HELP.go.fruits + ' is data');
});
