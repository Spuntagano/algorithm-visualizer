/** C++: the C interpreter with its C++ parts (src/engine/c/interp.js, parse.js) and the standard library (stl.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runCppTrace } from '../src/engine/c/cpp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { CPP_EXAMPLES, EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildVarGraph } from '../src/graph/memory.js';

const H = '#include <bits/stdc++.h>\nusing namespace std;\n';
const main = body => H + 'int main() {\n' + body + '\n    return 0;\n}';
const out = code => { const r = runCppTrace(code); assert.equal(r.error, null, JSON.stringify(r.error)); return r.logs.map(l => l.s); };
const errorOf = code => runCppTrace(code).error.msg;
const last = code => runCppTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('steps, the call stack with methods and references, locals and globals', () => {
  const r = runCppTrace(H + 'struct Acc {\n    int total = 0;\n    void add(int& x) { total += x; x = 0; }\n};\nint main() {\n    Acc a;\n    int n = 5;\n    a.add(n);\n    cout << a.total << " " << n << endl;\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs.map(l => l.s), ['5 0']);
  assert.deepEqual(r.steps.map(s => s.line), [8, 9, 10, 5, 5, 11, -1]);
  const inAdd = r.steps[3];
  assert.deepEqual(inAdd.stack, [{ name: 'main', args: '' }, { name: 'Acc::add', args: 'x=5' }], 'a method is Class::name');
  const v = vars(inAdd);
  assert.equal(v.x.node.s, '5', 'a reference shows the value it refers to');
  assert.equal(v.this.node.cls, 'Acc', 'this is the object');
  assert.deepEqual(r.steps.at(-1).vars.map(x => [x.name, x.node.t === 'p' ? x.node.s : x.node.cls]), [['a', 'Acc'], ['n', '0']]);
});

test('library values become snapshot nodes: vectors, strings, maps, sets, pairs, adapters; iterators tag cells', () => {
  const s = last(main([
    '    vector<int> nums = {5, 2, 9};', '    auto it = nums.begin() + 1;', '    int* p = &nums[2];',
    '    vector<vector<int>> g(2, vector<int>(2, 7));', '    string name = "Ada";', '    map<string, int> m = {{"b", 2}, {"a", 1}};',
    '    set<int> st = {3, 1};', '    unordered_map<int, int> u; u[7] = 1; u[3] = 2;', '    pair<int, string> pr = {1, "one"};',
    '    stack<int> s; s.push(1); s.push(2);', '    priority_queue<int> pq; pq.push(1); pq.push(5);', '    bool ok = 1 < 2;', '    auto f = [](int x) { return x; };',
  ].join('\n')));
  const v = vars(s);
  assert.deepEqual([v.nums.node.t, v.nums.node.tn, v.nums.node.items.map(x => x.s)], ['arr', 'vector<int>', ['5', '2', '9']]);
  assert.deepEqual(v.it.node, { t: 'p', k: 'ptr', s: '&nums[1]', to: v.nums.node.id, at: 1 }, 'an iterator into a vector names and tags its cell');
  assert.equal(v.p.node.s, '&nums[2]');
  assert.deepEqual(markersFor(v.nums.node, s.vars, 'nums'), { 1: ['it'], 2: ['p'] });
  assert.equal(v.g.node.items[1].tn, 'vector<int>', 'a vector of vectors');
  assert.deepEqual([v.name.node.k, v.name.node.s], ['str', '"Ada"'], 'a string is shown as text');
  assert.deepEqual([v.m.node.t, v.m.node.cls, v.m.node.entries.map(e => e[0].s)], ['map', 'map<string, int>', ['"a"', '"b"']], 'a map is sorted');
  assert.deepEqual(v.u.node.entries.map(e => e[0].s), ['7', '3'], 'an unordered_map keeps the order things were added');
  assert.deepEqual([v.st.node.t, v.st.node.items.map(x => x.s)], ['set', ['1', '3']]);
  assert.deepEqual([v.pr.node.cls, v.pr.node.entries.map(e => e[0])], ['pair<int, string>', ['first', 'second']]);
  assert.deepEqual([v.s.node.tn, v.s.node.items.map(x => x.s)], ['stack<int>', ['1', '2']], 'a stack, bottom first');
  assert.deepEqual(v.pq.node.items.map(x => x.s), ['5', '1'], 'a priority_queue in its heap order');
  assert.deepEqual([v.ok.node.k, v.ok.node.s], ['bool', 'true'], 'comparisons are bool in C++');
  assert.deepEqual(v.f.node, { t: 'fn', s: 'lambda' });
  assert.equal(buildVarGraph(s, 'm').root.title, 'map<string, int>(2)');
});

test('classes: constructors, member initializers, destructors in order, methods, statics, operators', () => {
  assert.deepEqual(out(H + [
    'struct T { int id; T(int i) : id(i) { cout << "make " << id << endl; } ~T() { cout << "drop " << id << endl; } };',
    'class Counter {', '    int n = 0;', 'public:', '    static int made;', '    Counter() { made++; }', '    Counter& add(int k) { n += k; return *this; }', '    int get() const { return n; }', '};',
    'int Counter::made = 0;',
    'struct V { int x, y; V(int x, int y); V operator+(const V& o) const; bool operator<(const V& o) const { return x < o.x; } };',
    'V::V(int x, int y) : x(x), y(y) {}', 'V V::operator+(const V& o) const { return V(x + o.x, y + o.y); }',
    'ostream& operator<<(ostream& os, const V& v) { return os << "(" << v.x << "," << v.y << ")"; }',
    'int main() {', '    T a(1);', '    { T b(2); }', '    T* c = new T(3);', '    delete c;',
    '    Counter k; k.add(2).add(3); Counter k2;', '    cout << k.get() << " " << Counter::made << endl;',
    '    V p(1, 2), q(3, 4);', '    cout << p + q << " " << (q < p) << endl;', '    return 0;', '}',
  ].join('\n')), ['make 1', 'make 2', 'drop 2', 'make 3', 'drop 3', '5 2', '(4,6) 0', 'drop 1']);
});

test('references, overloads with default arguments, lambdas and their captures, function<>', () => {
  assert.deepEqual(out(H + [
    'void inc(int& x) { x++; }', 'int& pick(vector<int>& v, int i) { return v[i]; }',
    'int f(int) { return 1; }', 'int f(double) { return 2; }', 'int f(string) { return 3; }', 'int g(int a, int b = 10) { return a + b; }',
    'int main() {', '    int a = 1; inc(a); int& r = a; r = 10;', '    vector<int> v = {1, 2}; pick(v, 1) = 7;',
    '    cout << a << " " << v[1] << " " << f(1) << f(1.5) << f("s") << " " << g(1) << " " << g(1, 2) << endl;',
    '    int n = 1; auto byVal = [=]() { return n; }; auto byRef = [&]() { return n; }; n = 5;',
    '    function<int(int)> fact = [&](int k) { return k <= 1 ? 1 : k * fact(k - 1); };',
    '    cout << byVal() << byRef() << fact(5) << endl;', '    return 0;', '}',
  ].join('\n')), ['10 7 123 11 3', '15120']);
});

test('the standard library: vector, string, map, set, the adapters, the algorithms, cout', () => {
  assert.deepEqual(out(main([
    '    vector<int> v; for (int i = 0; i < 5; i++) v.push_back(i * i); v.pop_back(); v.insert(v.begin() + 1, 99); v.erase(v.begin());',
    '    sort(v.begin(), v.end(), greater<int>()); for (int x : v) cout << x << ","; cout << v.size() << endl;',
    '    string s = "hello"; s += " world"; s[0] = \'H\'; cout << s << "|" << s.substr(6, 3) << "|" << s.find("wor") << "|" << (s.find("z") == string::npos) << "|" << to_string(4) + "!" << "|" << stoi("12") * 2 << endl;',
    '    map<string, int> m; m["b"] = 2; m["a"] = 1; m["c"]; for (auto& [k, x] : m) cout << k << x; cout << " " << m.count("a") << m.size();',
    '    auto it = m.find("b"); cout << " " << it->first << it->second << (m.find("q") == m.end()) << endl;',
    '    set<int> st = {3, 1, 2}; st.insert(0); st.erase(2); for (int x : st) cout << x; cout << endl;',
    '    stack<int> sk; sk.push(1); sk.push(2); queue<int> q; q.push(1); q.push(2); priority_queue<int, vector<int>, greater<int>> mn; for (int x : {5, 1, 9}) mn.push(x);',
    '    cout << sk.top() << q.front() << mn.top() << endl;',
    '    vector<int> w = {4, 2, 7, 2, 9}; cout << *max_element(w.begin(), w.end()) << count(w.begin(), w.end(), 2) << accumulate(w.begin(), w.end(), 0);',
    '    sort(w.begin(), w.end()); cout << " " << (lower_bound(w.begin(), w.end(), 7) - w.begin()) << binary_search(w.begin(), w.end(), 3) << max(3, 8) << min({5, 2, 8}) << endl;',
    '    vector<pair<int, string>> ps = {{2, "b"}, {1, "z"}, {2, "a"}}; sort(ps.begin(), ps.end()); for (auto& [n, t] : ps) cout << n << t; cout << endl;',
    '    cout << 3.14159 << " " << 2.0 << " " << 0.1 + 0.2 << " " << true << " " << fixed << setprecision(2) << 3.14159 << " " << setw(4) << 7 << "|" << boolalpha << (1 < 2) << endl;',
  ].join('\n'))), ['99,9,4,1,4', 'Hello world|wor|6|1|4!|24', 'a1b2c0 13 b21', '013', '211', '9224 3082', '1z2a2b', '3.14159 2 0.3 1 3.14    7|true']);
});

test('exceptions: throw, catch by type, the library\'s own, and an uncaught one', () => {
  assert.deepEqual(out(main([
    '    vector<int> v(3);', '    try { v.at(5) = 1; } catch (const out_of_range& e) { cout << "caught: " << e.what() << endl; }',
    '    try { throw runtime_error("boom"); } catch (exception& e) { cout << e.what() << endl; }', '    try { throw 42; } catch (int x) { cout << x << endl; }',
    '    try { try { throw 1; } catch (...) { cout << "inner" << endl; throw; } } catch (int x) { cout << "again " << x << endl; }',
  ].join('\n'))), ['caught: vector::at: v.at(5) is out of range (its size is 3)', 'boom', '42', 'inner', 'again 1']);
  assert.equal(errorOf(main('    throw runtime_error("bad thing");')), 'Error on line 4: the program threw std::runtime_error (bad thing) and nothing caught it');
  assert.equal(errorOf(main('    map<string, int> m;\n    cout << m.at("x");')), 'Error on line 5: the program threw std::out_of_range (map::at: there is no key "x" in m) and nothing caught it');
});

test('memory errors C++ would not catch: out of range, stale references and iterators, empty containers, delete', () => {
  const cases = [
    ['vector<int> v = {1, 2, 3};\n    int x = v[3];', /^Error on line 5: v\[3\] is out of range: v has 3 elements \(indexes 0 to 2\)$/],
    ['vector<int> v = {1};\n    int& r = v[0];\n    v.push_back(2);\n    r = 5;', /line 7: r is in memory that v gave up when it grew on line 6 \(push_back on line 6\): pointers, references and iterators into a vector or string are no longer valid after it reallocates/],
    ['vector<int> v = {1, 2, 3};\n    for (auto it = v.begin(); it != v.end(); ++it) if (*it == 2) v.push_back(4);', /\*it is in memory that v gave up when it grew/],
    ['vector<int> v;\n    v.pop_back();', /v is empty, so there is no element to remove/],
    ['stack<int> s;\n    s.top();', /s is empty, so there is no element to read/],
    ['int* p = new int(5);\n    delete p;\n    delete p;', /line 6: delete p: this memory was already deleted on line 5 \(double delete\)/],
    ['int* p = new int[3];\n    delete p;', /memory from new\[\] needs delete\[\]/],
    ['int* p = new int(1);\n    delete p;\n    *p = 2;', /\*p is in memory that was deleted on line 5 \(use after delete\)/],
    ['vector<int> v = {1, 2};\n    cout << v;', /cout cannot print a vector<int> \(print its elements in a loop\)/],
    ['int x;\n    cin >> x;', /cin: this page has no keyboard input/],
    ['map<int, int> m = {{1, 1}};\n    auto it = m.find(1);\n    m.erase(1);\n    cout << it->second;', /the element this iterator pointed to was erased on line 6/],
  ];
  for (const [body, re] of cases) assert.match(errorOf(main('    ' + body)), re, body);
  assert.match(errorOf(H + 'int f(int a) { return a; }\nint main() {\n    f("x");\n}'), /f\(\) is given \(char \*\), but it takes \(int\)/);
  assert.match(errorOf(H + 'struct P { int x; };\nint main() {\n    set<P> s;\n    s.insert(P{1});\n    s.insert(P{2});\n}'), /P has no operator< , so it cannot be sorted or put in a map or set/);
});

test('syntax: what is not supported says so', () => {
  const syntax = code => traceCode(code, 'cpp').error;
  assert.match(syntax(H + 'template <typename T> T id(T x) { return x; }\nint main() {}'), /line 3: templates \(other than the standard library's: vector, map…\) are not supported/);
  assert.match(syntax(H + 'struct A {}; struct B : A {};\nint main() {}'), /line 3: inheritance \(struct B : …\) is not supported yet/);
  assert.match(syntax('#include <iostream>\nint main() {\n    int x = = 1;\n}'), /line 3: expected an expression before '='/);
  assert.match(syntax('#include "mine.h"\nint main() {}'), /only the standard headers \(<iostream>, <vector>, <map>…\)/);
  assert.match(syntax(H + 'int f() { return 1; }'), /there is no main\(\) function: a C\+\+ program starts in int main\(\)/);
  assert.match(syntax(main('    array<int, 3> a = {1, 2, 3};')), /line 4: std::array is not supported here \(use a plain array or a vector\)/);
  assert.match(syntax(main('    list<int> l;')), /std::list is not supported here \(use a vector or a deque\)/);
  assert.deepEqual(out(main('    cout << numeric_limits<int>::max() << " " << numeric_limits<long long>::min() << " " << numeric_limits<double>::infinity() << endl;')),
    ['2147483647 -9223372036854775808 inf'], 'numeric_limits is there');
});

test('every C++ example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(CPP_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one C++ twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(CPP_EXAMPLES)) {
    const r = runCppTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runCppTrace(CPP_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['1 2 5 6 9 ']);
  assert.deepEqual(logs('Two sum (unordered_map)'), ['[2, 3]']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['A B C D E F ']);
  const bfs = runCppTrace(CPP_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur'));
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const text = buildSemanticView(bfs, null, 'graph', semanticGraph(bfs, 'graph'), true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur') && text.includes('∈ visited'), 'a char variable and a set<char> tag the nodes');
  const ds = last(CPP_EXAMPLES['Data structures']);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'word', 'scores', 'p', 'st']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every C++ example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.cpp.shapes) for (const [code, , full, name] of items) {
    const r = runCppTrace(full ? H + full : main('    ' + code));
    assert.equal(r.error, null, code);
    assert.ok(semanticGraph(r.steps.at(-1), name), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last(main('    struct { int age; } x = {1};')), 'x'), null, HELP.cpp.age + ' is data');
  assert.equal(semanticGraph(last(main('    auto x = ' + HELP.cpp.fruits + ';')), 'x'), null, HELP.cpp.fruits + ' is data');
});
