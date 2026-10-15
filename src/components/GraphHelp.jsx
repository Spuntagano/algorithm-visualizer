/**
 * The "?" next to the Variables heading: a short guide, for someone new to the app, to the three views and to every
 * shape of data the Graph view can draw. A native popover (top layer, so the panel's overflow cannot clip it; Escape
 * and an outside click close it), placed under its button. Written for the language picked in the header; every
 * example here is checked by tests (tests/components.test.jsx for JavaScript, tests/python.test.js, lua.test.js, ruby.test.js, php.test.js, c.test.js and cpp.test.js for the others).
 */
import { useEffect, useRef } from 'react';

/**
 * Everything the guide says that depends on the language. SHAPES items are [example, explanation, program?, variable?]:
 * `program` is what the tests run for an example that is not a whole program on its own, and `variable` the one in it
 * that is drawn (C's programs declare several). `groups` says which of the four kinds of shape each group of SHAPES is
 * (C has no dictionaries, so it has no neighbour lists by name), and `names` renames a kind in the explanations.
 */
const NODE_CLASS = 'class Node:\n    def __init__(self, name, nbrs=()):\n        self.name = name\n        self.nbrs = list(nbrs)\n';
export const HELP = {
  javascript: {
    values: 'Every array, object, Map and Set',
    memory: 'each array or object is a box',
    containers: 'an array or Set',
    shapes: [
      ['A list of neighbours for each name', [
        ['{ A: ["B", "C"], B: ["C"], C: [] }', 'A points to B and C, B points to C. A Map, or Sets instead of arrays, work too.'],
        ['{ A: { B: 4, C: 2 }, B: { C: 1 } }', 'The same, with a number (weight) on each arrow. [["B", 4]] pairs work too.'],
        ['{ A: [{ to: "B", start: 0, end: 3 }], B: [] }', 'Each arrow written as an object; its other fields are written on the arrow.'],
      ]],
      ['Objects inside objects', [
        ['{ val: 1, next: { val: 2, next: null } }', 'A linked list.'],
        ['{ val: 1, left: { val: 2 }, right: { val: 3 } }', 'A binary tree.'],
        ['{ name: "a", children: [{ name: "b" }, { name: "c" }] }', 'A tree.'],
        ['a = { id: "A", nbrs: [b, c] }', 'Objects that list other objects: any graph.', 'const b = { id: "B" }, c = { id: "C" };\nconst a = { id: "A", nbrs: [b, c] };'],
      ]],
      ['Objects that name each other', [
        ['{ a: { next: ["b"] }, b: { next: [] } }', 'By key.'],
        ['[{ id: "test", deps: ["build"] }, { id: "build", deps: [] }]', 'By an id, key or name field.'],
        ['[{ v: "a", out: [1] }, { v: "b", out: [] }]', 'By position in the array.'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['const adj = [[1, 2], [2], []]', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be g.'],
        ['const adj = [[[0, 3, 1], [1, 5, 2]], [[4, 7, 2]], []]', 'The same with lists of values: the node is the first position where every list holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
        ['const edges = [[0, 1], [1, 2]]', 'One [from, to] pair per arrow. The name must contain edge.'],
      ]],
    ],
    arrowObject: '{ to: "B", w: 4 }', pair: '[from, to]', tuples: ['[1, 0, 3]', '[0, 3, 1]', '[0, 1, 3]'],
    nodeData: '{ id: 1, weight: 3 }', arrowData: '{ to: "B", start: 0, end: 3 }', age: '{ age: 1 }', fruits: '{ fruits: ["apple"] }',
  },
  python: {
    values: 'Every list, tuple, dict, set and object',
    memory: 'each list, dict or object is a box',
    containers: 'a list or set',
    shapes: [
      ['A list of neighbours for each name', [
        ['{"A": ["B", "C"], "B": ["C"], "C": []}', 'A points to B and C, B points to C. Sets instead of lists work too.'],
        ['{"A": {"B": 4, "C": 2}, "B": {"C": 1}}', 'The same, with a number (weight) on each arrow. [("B", 4)] pairs work too.'],
        ['{"A": [{"to": "B", "start": 0, "end": 3}], "B": []}', 'Each arrow written as a dict; its other keys are written on the arrow.'],
      ]],
      ['Objects inside objects (dicts, or objects of your own classes)', [
        ['{"val": 1, "next": {"val": 2, "next": None}}', 'A linked list.'],
        ['{"val": 1, "left": {"val": 2}, "right": {"val": 3}}', 'A binary tree.'],
        ['{"name": "a", "children": [{"name": "b"}, {"name": "c"}]}', 'A tree.'],
        ['a = Node("A", [b, c])', 'Objects of a class (here with name and nbrs attributes) that list other objects: any graph.',
          NODE_CLASS + 'b, c = Node("B"), Node("C")\na = Node("A", [b, c])'],
      ]],
      ['Dicts that name each other', [
        ['{"a": {"next": ["b"]}, "b": {"next": []}}', 'By key.'],
        ['[{"id": "test", "deps": ["build"]}, {"id": "build", "deps": []}]', 'By an id, key or name key.'],
        ['[{"v": "a", "out": [1]}, {"v": "b", "out": []}]', 'By position in the list.'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['adj = [[1, 2], [2], []]', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be g.'],
        ['adj = [[(0, 3, 1), (1, 5, 2)], [(4, 7, 2)], []]', 'The same with tuples (or lists) of values: the node is the first position where every tuple holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
        ['edges = [(0, 1), (1, 2)]', 'One (from, to) pair per arrow. The name must contain edge.'],
      ]],
    ],
    arrowObject: '{"to": "B", "w": 4}', pair: '(from, to)', tuples: ['(1, 0, 3)', '(0, 3, 1)', '(0, 1, 3)'],
    nodeData: '{"id": 1, "weight": 3}', arrowData: '{"to": "B", "start": 0, "end": 3}', age: '{"age": 1}', fruits: '{"fruits": ["apple"]}',
  },
  lua: {
    values: 'Every table',
    memory: 'each table is a box',
    containers: 'a list table (or a set of trues)',
    shapes: [
      ['A list of neighbours for each name', [
        ['{A = {"B", "C"}, B = {"C"}, C = {}}', 'A points to B and C, B points to C. A set of trues, {B = true}, works too.'],
        ['{A = {B = 4, C = 2}, B = {C = 1}}', 'The same, with a number (weight) on each arrow. {{"B", 4}} pairs work too.'],
        ['{A = {{to = "B", start = 0, finish = 3}}, B = {}}', 'Each arrow written as a table; its other fields are written on the arrow.'],
      ]],
      ['Tables inside tables', [
        ['{val = 1, next = {val = 2}}', 'A linked list.'],
        ['{val = 1, left = {val = 2}, right = {val = 3}}', 'A binary tree.'],
        ['{name = "a", children = {{name = "b"}, {name = "c"}}}', 'A tree.'],
        ['a = Node.new("A", {b, c})', 'Objects of a class (a metatable with name and nbrs fields) that list other objects: any graph.',
          'Node = {}\nNode.__index = Node\nfunction Node.new(name, nbrs) return setmetatable({name = name, nbrs = nbrs or {}}, Node) end\nb, c = Node.new("B"), Node.new("C")\na = Node.new("A", {b, c})'],
      ]],
      ['Tables that name each other', [
        ['{a = {next = {"b"}}, b = {next = {}}}', 'By key.'],
        ['{{id = "test", deps = {"build"}}, {id = "build", deps = {}}}', 'By an id, key or name field.'],
        ['{{v = "a", out = {2}}, {v = "b", out = {}}}', 'By position in the list, counting from 1.'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['adj = {{2, 3}, {3}, {}}', 'The neighbours of node 1, 2, 3… (Lua counts from 1). The name must contain adj, graph, neigh or tree, or be g.'],
        ['adj = {{{1, 4, 2}, {2, 6, 3}}, {{5, 8, 3}}, {}}', 'The same with lists of values: the node is the first position where every list holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
        ['edges = {{1, 2}, {2, 3}}', 'One {from, to} pair per arrow. The name must contain edge.'],
      ]],
    ],
    arrowObject: '{to = "B", w = 4}', pair: '{from, to}', tuples: ['{2, 0, 3}', '{0, 3, 2}', '{0, 2, 3}'],
    nodeData: '{id = 1, weight = 3}', arrowData: '{to = "B", start = 0, finish = 3}', age: '{age = 1}', fruits: '{fruits = {"apple"}}',
  },
  ruby: {
    values: 'Every array, hash, set and object',
    memory: 'each array, hash or object is a box',
    containers: 'an array or Set',
    shapes: [
      ['A list of neighbours for each name', [
        ['{ "A" => ["B", "C"], "B" => ["C"], "C" => [] }', 'A points to B and C, B points to C. Symbols ({ a: [:b] }) or Sets instead of arrays work too.'],
        ['{ A: { B: 4, C: 2 }, B: { C: 1 } }', 'The same, with a number (weight) on each arrow. [["B", 4]] pairs work too.'],
        ['{ A: [{ to: "B", start: 0, end: 3 }], B: [] }', 'Each arrow written as a hash; its other keys are written on the arrow.'],
      ]],
      ['Objects inside objects (hashes, Structs, or objects of your own classes)', [
        ['{ val: 1, next: { val: 2, next: nil } }', 'A linked list.'],
        ['{ val: 1, left: { val: 2 }, right: { val: 3 } }', 'A binary tree.'],
        ['{ name: "a", children: [{ name: "b" }, { name: "c" }] }', 'A tree.'],
        ['a = Node.new("A", [b, c])', 'Objects (here a Struct with name and nbrs) that list other objects: any graph.',
          'Node = Struct.new(:name, :nbrs)\nb, c = Node.new("B", []), Node.new("C", [])\na = Node.new("A", [b, c])'],
      ]],
      ['Hashes that name each other', [
        ['{ a: { next: [:b] }, b: { next: [] } }', 'By key.'],
        ['[{ id: "test", deps: ["build"] }, { id: "build", deps: [] }]', 'By an id, key or name key.'],
        ['[{ v: "a", out: [1] }, { v: "b", out: [] }]', 'By position in the array.'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['adj = [[1, 2], [2], []]', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be g.'],
        ['adj = [[[0, 3, 1], [1, 5, 2]], [[4, 7, 2]], []]', 'The same with arrays of values: the node is the first position where every array holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
        ['edges = [[0, 1], [1, 2]]', 'One [from, to] pair per arrow. The name must contain edge.'],
      ]],
    ],
    arrowObject: '{ to: "B", w: 4 }', pair: '[from, to]', tuples: ['[1, 0, 3]', '[0, 3, 1]', '[0, 1, 3]'],
    nodeData: '{ id: 1, weight: 3 }', arrowData: '{ to: "B", start: 0, end: 3 }', age: '{ age: 1 }', fruits: '{ fruits: ["apple"] }',
  },
  php: {
    values: 'Every array and object',
    memory: 'each array or object is a box',
    containers: 'an array (or a set written as [$name => true])',
    shapes: [
      ['A list of neighbours for each name', [
        ["['A' => ['B', 'C'], 'B' => ['C'], 'C' => []]", "A points to B and C, B points to C. A set written as ['B' => true] works too."],
        ["['A' => ['B' => 4, 'C' => 2], 'B' => ['C' => 1]]", "The same, with a number (weight) on each arrow. [['B', 4]] pairs work too."],
        ["['A' => [['to' => 'B', 'start' => 0, 'end' => 3]], 'B' => []]", 'Each arrow written as an array; its other keys are written on the arrow.'],
      ]],
      ['Objects inside objects (arrays, or objects of your own classes)', [
        ["['val' => 1, 'next' => ['val' => 2, 'next' => null]]", 'A linked list.'],
        ["['val' => 1, 'left' => ['val' => 2], 'right' => ['val' => 3]]", 'A binary tree.'],
        ["['name' => 'a', 'children' => [['name' => 'b'], ['name' => 'c']]]", 'A tree.'],
        ["$a = new Node('A', [$b, $c])", 'Objects of a class (here with name and nbrs properties) that list other objects: any graph.',
          "<?php\nclass Node { public function __construct(public string $name, public array $nbrs = []) {} }\n$b = new Node('B'); $c = new Node('C');\n$a = new Node('A', [$b, $c]);"],
      ]],
      ['Arrays that name each other', [
        ["['a' => ['next' => ['b']], 'b' => ['next' => []]]", 'By key.'],
        ["[['id' => 'test', 'deps' => ['build']], ['id' => 'build', 'deps' => []]]", 'By an id, key or name key.'],
        ["[['v' => 'a', 'out' => [1]], ['v' => 'b', 'out' => []]]", 'By position in the array.'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['$adj = [[1, 2], [2], []]', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be $g.'],
        ['$adj = [[[0, 3, 1], [1, 5, 2]], [[4, 7, 2]], []]', 'The same with arrays of values: the node is the first position where every array holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
        ['$edges = [[0, 1], [1, 2]]', 'One [from, to] pair per arrow. The name must contain edge.'],
      ]],
    ],
    arrowObject: "['to' => 'B', 'w' => 4]", pair: '[from, to]', tuples: ['[1, 0, 3]', '[0, 3, 1]', '[0, 1, 3]'],
    nodeData: "['id' => 1, 'weight' => 3]", arrowData: "['to' => 'B', 'start' => 0, 'end' => 3]", age: "['age' => 1]", fruits: "['fruits' => ['apple']]",
  },
  cpp: {
    values: 'Every array, vector, map, set, string, struct and pointer',
    memory: 'each array, container or object is a box, and a pointer is an arrow to what it points at',
    containers: 'a vector, set or map (or a vector<bool> of flags, one per node)',
    names: { keyed: 'Neighbour lists (in a map)', nested: 'Objects that point at objects', named: 'Objects that name each other' },
    shapes: [
      ['A list of neighbours for each name (in a map)', [
        ['map<string, vector<string>> g = {{"A", {"B", "C"}}, {"B", {"C"}}, {"C", {}}};', 'A points to B and C, B points to C. Sets, or char or int keys, work too.', null, 'g'],
        ["map<char, map<char, int>> g = {{'A', {{'B', 4}, {'C', 2}}}, {'B', {{'C', 1}}}};", 'The same, with a number (weight) on each arrow. vector<pair<char, int>> pairs work too.', null, 'g'],
        ['map<string, vector<Edge>> g;  // struct Edge { string to; int start, end; };', 'Each arrow written as a struct; its other fields are written on the arrow.',
          'struct Edge { string to; int start, end; };\nint main() {\n    map<string, vector<Edge>> g = {{"A", {{"B", 0, 3}}}, {"B", {}}};\n}', 'g'],
      ]],
      ['Objects that point at each other (pointers, or new)', [
        ['struct Node { int val; Node* next; };', 'A linked list: next points at the next node, and nullptr ends it.',
          'struct Node { int val; Node* next; };\nint main() {\n    Node* list = new Node{1, new Node{2, nullptr}};\n}', 'list'],
        ['struct Tree { int val; Tree *left, *right; };', 'A binary tree.',
          'struct Tree { int val; Tree *left, *right; };\nint main() {\n    Tree* root = new Tree{1, new Tree{2, nullptr, nullptr}, new Tree{3, nullptr, nullptr}};\n}', 'root'],
        ['struct Vertex { char name; vector<Vertex*> nbrs; };', 'Objects that hold pointers to other objects: any graph.',
          "struct Vertex { char name; vector<Vertex*> nbrs; };\nint main() {\n    Vertex b{'B'}, c{'C'};\n    Vertex a{'A', {&b, &c}};\n}", 'a'],
      ]],
      ['Objects that name each other', [
        ['vector<Job> jobs = {{"test", {"build"}}, {"build", {}}};  // struct Job { string id; vector<string> deps; };', 'By an id, key or name field.',
          'struct Job { string id; vector<string> deps; };\nint main() {\n    vector<Job> jobs = {{"test", {"build"}}, {"build", {}}};\n}', 'jobs'],
        ["vector<Item> items = {{'a', {1}}, {'b', {}}};  // struct Item { char v; vector<int> out; };", 'By position in the vector.',
          "struct Item { char v; vector<int> out; };\nint main() {\n    vector<Item> items = {{'a', {1}}, {'b', {}}};\n}", 'items'],
      ]],
      ['Lists of numbers (the variable\'s name decides)', [
        ['vector<vector<int>> adj = {{1, 2}, {2}, {}};', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be g.', null, 'adj'],
        ['vector<vector<pair<int, int>>> adj = {{{1, 4}, {2, 7}}, {{2, 1}}, {}};', 'The same with (node, weight) pairs, or longer lists of values: the node is the first position where every one holds a node number. One other number is a weight; more are written on the arrow.', null, 'adj'],
        ['vector<vector<int>> graph = {{0, 1, 1}, {0, 0, 1}, {0, 0, 0}};', 'An adjacency matrix: graph[a][b] is 1 (or a weight) when a points to b.', null, 'graph'],
        ['vector<pair<int, int>> edges = {{0, 1}, {1, 2}};', 'One {from, to} pair per arrow. The name must contain edge.', null, 'edges'],
      ]],
    ],
    arrowObject: 'Edge{"B", 4} (to, w)', pair: '{from, to}', tuples: ['{1, 0, 3}', '{0, 3, 1}', '{0, 1, 3}'],
    nodeData: 'Task{.id = 1, .weight = 3}', arrowData: 'Edge{.to = "B", .start = 0, .end = 3}', age: 'struct { int age; }', fruits: 'vector<string>{"apple"}',
  },
  c: {
    values: 'Every array, struct and pointer',
    memory: 'each array or struct is a box, and a pointer is an arrow to the memory it points at',
    containers: 'an array (or an array of bool flags, one per node)',
    groups: ['nested', 'named', 'numbers'],
    names: { nested: 'Structs that point at structs', named: 'Structs that name each other', numbers: 'Arrays of numbers' },
    shapes: [
      ['Structs that point at each other', [
        ['struct Node { int val; struct Node *next; };', 'A linked list: next points at the next node, and NULL ends it.',
          'struct Node { int val; struct Node *next; };\nint main(void) {\n    struct Node c = {3, NULL}, b = {2, &c}, a = {1, &b};\n    return 0;\n}', 'a'],
        ['struct Tree { int val; struct Tree *left, *right; };', 'A binary tree.',
          'struct Tree { int val; struct Tree *left, *right; };\nint main(void) {\n    struct Tree l = {2, NULL, NULL}, r = {3, NULL, NULL}, root = {1, &l, &r};\n    return 0;\n}', 'root'],
        ['struct Vertex { char name; struct Vertex *nbrs[3]; };', 'Structs holding pointers to other structs (malloc\'d or not): any graph.',
          'struct Vertex { char name; struct Vertex *nbrs[3]; };\nint main(void) {\n    struct Vertex b = {\'B\'}, c = {\'C\'}, a = {\'A\', {&b, &c}};\n    b.nbrs[0] = &c;\n    return 0;\n}', 'a'],
      ]],
      ['Structs that name each other', [
        ['struct Job { char id; char next[3]; } jobs[] = {{\'A\', "BC"}, {\'B\', "C"}, {\'C\', ""}};', 'By an id, key or name field: A points to B and C.', null, 'jobs'],
        ['struct Item { int val; int next; } items[] = {{5, 2}, {9, -1}, {7, 1}};', 'By position in the array: a list kept in an array (-1 ends it).', null, 'items'],
      ]],
      ['Arrays of numbers (the variable\'s name decides)', [
        ['int adj[3][3] = {{0, 1, 1}, {0, 0, 1}, {0, 0, 0}};', 'An adjacency matrix: adj[a][b] is 1 when a points to b. The name must contain adj, graph, neigh or tree, or be g.'],
        ['int graph[3][3] = {{0, 4, 2}, {0, 0, 5}, {0, 1, 0}};', 'The same with weights: 0 is no edge (and the diagonal is all 0).'],
        ['int edges[2][2] = {{0, 1}, {1, 2}};', 'One {from, to} pair per arrow; a third number is its weight. The name must contain edge.'],
      ]],
    ],
    arrowObject: '{.to = 1, .w = 4}', pair: '{from, to}', tuples: ['{1, 0, 3}', '{0, 3, 1}', '{0, 1, 3}'],
    nodeData: '{.id = 1, .weight = 3}', arrowData: '{.to = 1, .start = 0, .end = 3}', age: 'struct { int age; }', fruits: '{"apple", "pear"}',
  },
};
/** The JavaScript shapes (kept under their old name for the tests). */
export const SHAPES = HELP.javascript.shapes;
const GROUPS = ['keyed', 'nested', 'named', 'numbers'];
const NAMES = { keyed: 'Neighbour lists', nested: 'Objects inside objects', named: 'Objects that name each other', numbers: 'Lists of numbers' };

/** @param lang  'javascript' | 'typescript' | 'lua' | 'python' | 'ruby' | 'php' | 'c' | 'cpp': which language the guide's examples are written in (TypeScript uses JavaScript's) */
export function GraphHelp({ lang = 'javascript' }) {
  const h = HELP[lang] || HELP.javascript;
  const groups = h.groups || GROUPS, no = id => groups.indexOf(id) + 1, has = id => groups.includes(id);
  const title = id => <b>{no(id)}. {(h.names && h.names[id]) || NAMES[id]}:</b>;
  const btn = useRef(null), pop = useRef(null);

  useEffect(() => {
    const p = pop.current;
    /* Placed in page coordinates (position: absolute in the top layer), so it scrolls along with its button; closing it on
       scroll instead would also close it right after it opens when a tap follows a scroll, or when a phone's address bar moves. */
    const place = () => {
      const r = btn.current.getBoundingClientRect(), w = Math.min(520, window.innerWidth - 32);
      Object.assign(p.style, {
        width: w + 'px',
        left: window.scrollX + Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)) + 'px',
        top: window.scrollY + r.bottom + 6 + 'px',
        maxHeight: Math.max(160, window.innerHeight - r.bottom - 22) + 'px',   // fits below the button; longer text scrolls inside
      });
    };
    const onToggle = e => { if (e.newState === 'open') place(); };
    // follow the button when the window is resized or the debugger panel it sits in scrolls (never when the help itself scrolls)
    const follow = e => { if (p.matches(':popover-open') && !(e.target instanceof Node && p.contains(e.target))) place(); };
    p.addEventListener('beforetoggle', onToggle);
    window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true);
    return () => { p.removeEventListener('beforetoggle', onToggle); window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, []);

  return (
    <>
      <button ref={btn} type="button" className="help-btn" id="graphHelpBtn" popoverTarget="graphHelp"
        title="How to see your data as a graph" aria-label="How to see your data as a graph">?</button>
      <div ref={pop} id="graphHelp" className="help-pop" popover="auto" role="dialog" aria-labelledby="graphHelpTitle">
        <h3 id="graphHelpTitle">How to see your data as a graph</h3>
        <p>{h.values} in your code gets buttons to choose how it is drawn:</p>
        <dl className="help-views">
          <div><dt>Memory</dt><dd>How your data is stored: {h.memory}, and arrows show what refers to what. Shown first.</dd></div>
          <div><dt>Boxes</dt><dd>The values themselves, nested inside each other.</dd></div>
          <div><dt>Graph</dt><dd>Circles and arrows (nodes and edges). This button only appears when your data has one of the shapes below.</dd></div>
        </dl>

        <h4>Shapes that can be drawn as a graph</h4>
        {h.shapes.map(([title, items], i) => (
          <section key={title} className="help-group">
            <h5>{i + 1}. {title}</h5>
            <ul>
              {items.map(([code, what]) => <li key={code}><code>{code}</code><span>{what}</span></li>)}
            </ul>
          </section>
        ))}

        <h4>How connections are found</h4>
        <p>The app checks the shapes in the order {['keyed', 'numbers', 'nested', 'named'].filter(has).map(no).join(', ')} and uses the first one that fits. For each one:</p>
        <ul className="help-notes">
          {has('keyed') && <li>{title('keyed')} every key is a node. Each name in a key's list is an arrow from that key to the node with
            that name. A name that has no key of its own still becomes a node. In <code className="inline">{h.arrowObject}</code>,
            the target is the first of <i>to, node, target, dest, id, key, name, vertex, neighbor, v, n</i>; the weight is
            a <i>weight, w, cost, dist, length, capacity</i> or <i>time</i> field.</li>}
          <li>{title('nested')} every object is a node, and a field holding another object (or a list of them)
            is an arrow, labelled with the field's name. The same object is always the same node, so shared objects and
            loops connect correctly.</li>
          <li>{title('named')} a node is named by its key, by a field <i>id</i>, <i>key</i> or <i>name</i> that
            every object has and that is different in each, or else by its position. A field becomes arrows when every value in
            it is the name of another node.</li>
          <li>{title('numbers')} in <code className="inline">adj</code>, list number <i>i</i> holds the neighbours of
            node <i>i</i>, as numbers or as lists of values; a square table of 0s and 1s (or of weights, with 0s down the diagonal)
            is an adjacency matrix, where row <i>a</i>, column <i>b</i> is the arrow from <i>a</i> to <i>b</i>. In those lists the node is the first position where every list holds a
            number of a node that exists (<i>{h.tuples[0]}</i>, <i>{h.tuples[1]}</i> and <i>{h.tuples[2]}</i> all work); if several positions fit, the
            first one is used. In <code className="inline">edges</code>, each <i>{h.pair}</i> is
            one arrow, and a third number is its weight.</li>
        </ul>

        <h5>Making sure the right values are connected</h5>
        <ul className="help-notes">
          <li><b>All or nothing:</b> a list counts as connections only if every value in it is a node's name.{has('keyed') ? <> In shape {no('keyed')}, one
            value that is not a name means the data is not a graph at all; in shape {no('named')}, that field is shown as data instead.</> : <> Otherwise
            that field is shown as data.</>}</li>
          <li><b>Names must match:</b> an arrow is only drawn to a node that exists, matched by its exact name (or number).
            At least one arrow must lead to another entry, so lists of plain values are never mistaken for a graph.</li>
          <li><b>Numbers are careful:</b> a number is a connection only in a field named like a link (<i>next, out, to, parent,
            deps</i>…), or in a number list named <i>adj</i> or <i>edges</i>. Elsewhere it stays a number.</li>
          <li><b>Labels are never links:</b> <i>val, value, data, key, name, id, label, title, weight</i> and similar fields name
            or describe the node itself.</li>
          <li><b>Objects must look alike:</b> objects inside objects are only drawn as a graph when they share at least half of their
            fields (or one is a smaller version of the other, like a leaf), so ordinary nested settings stay as data.</li>
          <li><b>Two-way and repeated arrows:</b> A → B and B → A with the same values become one line without arrowheads; the same
            arrow listed twice is drawn once, but arrows with different values stay separate.</li>
          <li><b>Size:</b> up to 60 nodes.</li>
        </ul>

        <h4>What you see in a graph</h4>
        <ul className="help-notes">
          <li><b>Data in a node:</b> a node <code className="inline">{h.nodeData}</code> shows <i>id 1</i> and <i>weight 3</i> inside it.</li>
          <li><b>Data on an arrow:</b> <code className="inline">{h.arrowData}</code> shows <i>start 0</i> and <i>end 3</i> on the arrow.</li>
          <li><b>Tags:</b> <i>↑ cur</i> marks the node a variable points at, <i>∈ visited</i> the nodes {h.containers} contains. Untick <i>Pointer tags</i> to hide them.</li>
          <li><b>Changes</b> since the last step are highlighted.</li>
          <li><b>The layout adapts:</b> a chain is drawn as a list, one start that branches as a tree, anything else as a graph.</li>
        </ul>

        <h4>Good to know</h4>
        <ul className="help-notes">
          <li>A number only counts as a link in a field named like one: <i>next, prev, out, in, to, from, adj, neighbours, edges, links, children,
            parent, left, right, deps</i>… So <code className="inline">{h.age}</code> stays a plain number.</li>
          <li>Lists of plain values, like <code className="inline">{h.fruits}</code>, are data, not a graph.</li>
          <li>If your data stops being a graph while you step, the card shows its values and says so.</li>
        </ul>
      </div>
    </>
  );
}
