import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrace } from '../src/engine/trace.js';
import { EXAMPLES } from '../src/examples.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildMemoryView } from '../src/graph/memory.js';
import { analyse } from './support/geometry.js';

/** Render the semantic graph of every variable at every step; return the kinds found and any geometry problems. */
function semAll(code, { checkCrossings = true } = {}) {
  const t = runTrace(code), kinds = new Set(); let rendered = 0; const problems = [];
  t.steps.forEach((s, i) => s.vars.forEach(v => {
    const sem = semanticGraph(s, v.name); if (!sem) return;
    const r = buildSemanticView(s, i ? t.steps[i - 1] : null, v.name, sem, true);
    const kind = r.caption.split(' · ')[0];
    kinds.add(v.name + ':' + kind); rendered++;
    const a = analyse(r, /g-snode/, /g-edge/);
    a.problems.forEach(p => problems.push(`${v.name}@${i}: ${p}`));
    if (checkCrossings && (kind === 'Tree' || kind === 'Linked list') && a.crossings) problems.push(`${v.name}@${i}: ${a.crossings} crossings in a ${kind}`);
  }));
  return { kinds: [...kinds], rendered, problems };
}
const has = (res, prefix) => res.kinds.some(k => k.startsWith(prefix));

test('breadth-first search example is detected as a graph', () => {
  const r = semAll(EXAMPLES['Breadth-first search']);
  assert.ok(has(r, 'graph:Graph'), r.kinds.join());
  assert.deepEqual(r.problems, []);
});

test('linked-list example is detected as a linked list, with no crossings', () => {
  const r = semAll(EXAMPLES['Reverse a linked list']);
  assert.ok(has(r, 'list:Linked list'), r.kinds.join());
  assert.deepEqual(r.problems, []);
});

test('binary tree becomes a tree', () => {
  const r = semAll(`const tree = {v:1, left:{v:2,left:{v:4,left:null,right:null},right:{v:5,left:null,right:null}}, right:{v:3,left:null,right:{v:7,left:{v:8,left:null,right:null},right:null}}};
tree.right.right.right = {v:9, left:null, right:null}; const probe = tree.left;`);
  assert.ok(has(r, 'tree:Tree'), r.kinds.join());
  assert.deepEqual(r.problems, []);
});

for (const [name, code, expect] of [
  ['undirected adjacency', 'const g = {A:["B","C"],B:["A","C","D"],C:["A","B"],D:["B","E"],E:["D"]}; const seen = new Set(["A","B"]); const cur = "C";', 'g:Undirected graph'],
  ['weighted object', 'const graph = {A:{B:4,C:2},B:{D:5},C:{B:1,D:8},D:{}}; let u = "C";', 'graph:Graph'],
  ['Map adjacency', 'const g = new Map([["x",["y","z"]],["y",["z"]],["z",["x"]]]);', 'g:Graph'],
  ['edge list', 'const edges = [[0,1],[1,2],[2,0],[2,3,7]];', 'edges:'],
  ['index adjacency', 'const adj = [[1,2],[3],[3],[]]; let node = 1;', 'adj:'],
  ['back edge and self loop', 'const g = {A:["B","D"],B:["C"],C:["D","A"],D:["E"],E:["E"]};', 'g:'],
  ['two components', 'const g = {A:["B"],B:[],X:["Y"],Y:["Z"],Z:[]};', 'g:'],
  ['doubly linked list', 'function N(v){return {val:v,next:null,prev:null};} const a=N(1),b=N(2),c=N(3); a.next=b;b.prev=a;b.next=c;c.prev=b;', 'a:'],
  ['tree with parent links', 'function T(v,p){return {val:v,parent:p,kids:[]};} const root=T("r",null); const a=T("a",root),b=T("b",root),c=T("c",a); root.kids.push(a,b); a.kids.push(c);', 'root:'],
  ['node objects with neighbour arrays', 'function V(id){return {id,nbrs:[]};} const a=V("a"),b=V("b"),c=V("c"),d=V("d"); a.nbrs.push(b,c); b.nbrs.push(d,a); c.nbrs.push(d);', 'a:'],
  ['adjacency with a node that has no entry', 'const g = {"a": ["b", "c"], "b": ["c"]};', 'g:Graph'],
  ['Map adjacency with a sink', 'const g = new Map([["a",["b","c"]],["b",["c"]]]);', 'g:Graph'],
  ['weighted, with a sink', 'const graph = {A:{B:4,C:2},B:{C:1}}; const pq = [["A",0]];', 'graph:Graph'],
  ['neighbours as objects', 'const graph = { A: [{ node: "B", weight: 4 }, { node: "C", weight: 2 }], B: [{ node: "C", weight: 1 }], C: [] };', 'graph:Graph'],
  ['node array with edge objects', 'const graph = [{ id: "A", edges: [{ to: "B", w: 4 }, { to: "C", w: 2 }] }, { id: "B", edges: [{ to: "C", w: 1 }] }, { id: "C", edges: [] }];', 'graph:Graph'],
  ['edge objects with extra values (intervals)', "const graph = { '0': [{ v: 1, start: 0, end: 3 }, { v: 2, start: 1, end: 5 }], '1': [{ v: 3, start: 7, end: 8 }], '2': [{ v: 3, start: 4, end: 7 }] };", 'graph:Graph'],
  ['index adjacency of [node, …] tuples', 'const graph = [ [ [ 1, 0, 3 ], [ 2, 1, 5 ] ], [ [ 3, 7, 8 ] ], [ [ 3, 4, 7 ] ], [] ];', 'graph:Graph'],
  ['records naming each other by key', 'const nodes={a:{next:["b","c"]},b:{next:["c"]},c:{next:[]}}; let cur = "b";', 'nodes:Graph'],
  ['records naming each other by index', 'const nodes=[{v:"a",out:[1,2]},{v:"b",out:[2]},{v:"c",out:[]}]; let i = 0;', 'nodes:Graph'],
  ['records naming each other by id', 'const tasks=[{id:"build",deps:[]},{id:"test",deps:["build"]},{id:"ship",deps:["test","build"]}];', 'tasks:Graph'],
  ['parent indices (arrows point up, so drawn as a graph)', 'const t=[{v:"r",parent:null},{v:"a",parent:0},{v:"b",parent:0},{v:"c",parent:1}];', 't:'],
  ['binary tree whose leaves leave out left / right', 'const tree = { val: 1, left: { val: 2 }, right: { val: 3 } };', 'tree:Tree'],
  ['wide tree with captions', 'const t={val:"root",h:3,kids:[{val:"a",h:2,kids:[{val:"a1",h:1,kids:[]},{val:"a2",h:1,kids:[]},{val:"a3",h:1,kids:[]}]},{val:"b",h:1,kids:[]},{val:"c",h:2,kids:[{val:"c1",h:1,kids:[]}]}]};', 't:Tree'],
]) {
  test('semantic graph: ' + name, () => {
    const r = semAll(code);
    assert.ok(has(r, expect), `expected ${expect}, got ${r.kinds.join()}`);
    assert.deepEqual(r.problems, []);
  });
}

test('plain data is NOT mistaken for a graph', () => {
  const r = semAll('const config={db:{host:"h",port:1},cache:{ttl:5}}; const counts={a:1,b:2,c:3}; const names=["x","y"]; const m=new Map([["k",1],["j",2]]); const grid=[[1,2],[3,4]]; const memo={2:1,3:2,4:3,5:5};');
  const r2 = semAll('const people=[{name:"A",age:1},{name:"B",age:0}]; const rows=[{id:1,qty:2},{id:2,qty:1}]; const users={a:{name:"a"},b:{name:"b"}}; const tr={en:{hello:"hi"},fr:{hello:"salut"}}; const scores=[{v:3,best:[1,0]},{v:4,best:[0]}];');
  assert.deepEqual(r2.kinds, [], 'numbers in ordinary fields, and a record naming itself, are not links');
  const r3 = semAll('const groups={fruits:["apple","pear"],veg:["kale"]}; const pairs={a:[1,2],b:[2,3]}; const marks={alice:{math:90},bob:{math:70}};');
  assert.deepEqual(r3.kinds, [], 'lists of values that never name another entry are not a graph');
  const r4 = semAll('const teams={t1:[{name:"bob",age:30}],t2:[{name:"amy",age:25}]}; const orders=[{id:1,items:[{sku:5,qty:2}]},{id:2,items:[{sku:1,qty:1}]}]; const pts={a:[{x:1,y:2}],b:[{x:3,y:4}]};');
  assert.deepEqual(r4.kinds, [], 'arrays of objects that never name another entry are data');
  assert.deepEqual(r.kinds, []);
});

test('variables that point into a graph show up as tags on its nodes', () => {
  const t = runTrace('const g = {A:["B"],B:["C"],C:[]}; const seen = new Set(["A"]); let cur = "B";');
  const s = t.steps.at(-1), sem = semanticGraph(s, 'g');
  const text = buildSemanticView(s, null, 'g', sem, true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur'), 'cur tag'); assert.ok(text.includes('∈ seen'), 'seen tag');
});

test('"Memory" layout graphs: no overlaps, no edges through nodes, no crossings', () => {
  const programs = [
    ...Object.values(EXAMPLES),
    'const tree = {v:1, left:{v:2,left:{v:4},right:{v:5}}, right:{v:3}}; const x = tree.left;',
    'const people=[{name:"A",tags:["x","y"],friend:{name:"B",pals:[{n:1},{n:2}],meta:{k:[1,2,3],j:{deep:{deeper:[1]}}}}},{name:"C",tags:[],friend:null}]; people[1].friend=people[0];',
    'const cyc={n:1,kids:[]}; cyc.self=cyc; cyc.kids.push({parent:cyc,name:"c1"},{parent:cyc,name:"c2"}); const m=new Map([["k",{a:1}],["j",[1,{b:2}]]]); const st=new Set([1,2,{q:1}]);',
    'const arr=[]; for(let i=0;i<14;i++){ arr.push({id:i,tags:i%3?["t"]:[],sub:i%4===0?{k:i}:null}); }',
  ];
  let graphs = 0; const problems = [];
  for (const code of programs) {
    const t = runTrace(code);
    t.steps.forEach((s, i) => s.vars.forEach(v => {
      const r = buildMemoryView(s, i ? t.steps[i - 1] : null, v.name, true); if (!r) return; graphs++;
      const a = analyse(r, /g-node/, /g-edge/);
      a.problems.forEach(p => problems.push(p)); if (a.crossings) problems.push(`${a.crossings} crossings`);
    }));
  }
  assert.ok(graphs > 300, 'rendered ' + graphs);
  assert.deepEqual(problems, []);
});

test('"Memory" layout: 200 random nested structures have no overlaps, no edges through nodes, no crossings', () => {
  let seed = 777; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const lit = () => rnd() < 0.5 ? String(Math.floor(rnd() * 100)) : JSON.stringify('s' + Math.floor(rnd() * 9));
  let budget = 0;
  const gen = d => {                                  // objects, arrays, Maps and Sets, nested up to 5 deep
    if (d > 4 || budget-- <= 0 || rnd() < 0.3) return lit();
    const n = Math.floor(rnd() * 5), kids = () => Array.from({ length: n }, () => gen(d + 1));
    const r = rnd();
    if (r < 0.4) return '{' + kids().map((v, i) => 'k' + i + ':' + v).join(',') + '}';
    if (r < 0.75) return '[' + kids().join(',') + ']';
    if (r < 0.9) return 'new Map([' + kids().map((v, i) => '["m' + i + '",' + v + ']').join(',') + '])';
    return 'new Set([' + kids().join(',') + '])';
  };
  const problems = []; let graphs = 0;
  for (let trial = 0; trial < 200; trial++) {
    budget = 10 + Math.floor(rnd() * 30);
    const code = 'const x = ' + gen(0) + ';';
    const s = runTrace(code).steps.at(-1);
    const r = buildMemoryView(s, null, 'x', true); if (!r) continue; graphs++;
    const a = analyse(r, /g-node/, /g-edge/);
    a.problems.forEach(p => problems.push(`${code}: ${p}`)); if (a.crossings) problems.push(`${code}: ${a.crossings} crossings`);
  }
  assert.ok(graphs > 120, 'rendered ' + graphs);
  assert.deepEqual(problems, []);
});

test('layered layout: 300 random graphs have no overlaps and no edges through nodes', () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let tested = 0; const problems = [];
  for (let trial = 0; trial < 300; trial++) {
    const n = 3 + Math.floor(rnd() * 22), dens = 0.5 + rnd() * 2.2, undirected = rnd() < 0.4, weighted = rnd() < 0.3;
    const names = [...Array(n).keys()].map(i => String.fromCharCode(65 + i % 26) + (i >= 26 ? i : ''));
    const adj = {}; names.forEach(k => { adj[k] = []; });
    for (let e = 0, m = Math.floor(n * dens); e < m; e++) {
      const a = names[Math.floor(rnd() * n)], b = names[Math.floor(rnd() * n)];
      if (rnd() < 0.9 && a === b) continue; adj[a].push(b); if (undirected) adj[b].push(a);
    }
    const body = weighted
      ? '{' + names.map(k => JSON.stringify(k) + ':{' + [...new Set(adj[k])].map(x => JSON.stringify(x) + ':' + (1 + Math.floor(rnd() * 9))).join(',') + '}').join(',') + '}'
      : JSON.stringify(adj);
    const t = runTrace(`const g = ${body}; let cur = ${JSON.stringify(names[0])};`);
    const s = t.steps.at(-1), sem = semanticGraph(s, 'g'); if (!sem) continue;
    const a = analyse(buildSemanticView(s, null, 'g', sem, true), /g-snode/, /g-edge/);
    tested++; a.problems.forEach(p => problems.push(`trial ${trial}: ${p}`));
  }
  assert.ok(tested > 250, 'tested ' + tested);
  assert.deepEqual(problems, []);
});

test('records that name each other: one edge per array element, labelled and tagged', () => {
  const s = runTrace('const nodes=[{v:"a",out:[1,2]},{v:"b",out:[2]},{v:"c",out:[]}]; let i = 1;').steps.at(-1);
  const sem = semanticGraph(s, 'nodes');
  assert.deepEqual(sem.edges.map(e => e.from + '>' + e.to), ['0>1', '0>2', '1>2']);
  assert.deepEqual(sem.nodes.map(n => n.label), ['a', 'b', 'c'], 'a label field beats the index');
  const text = buildSemanticView(s, null, 'nodes', sem, true).prims.map(q => q.text);
  assert.ok(text.includes('↑ i'), 'an index variable tags its node');
  const byKey = semanticGraph(runTrace('const g={a:{cost:3,next:["b"]},b:{cost:1,next:[]}};').steps.at(-1), 'g');
  assert.deepEqual(byKey.nodes.map(n => [n.label, n.fields.map(f => f.k + '=' + f.text)]), [['a', ['cost=3']], ['b', ['cost=1']]], 'keys label the nodes; link fields are not shown as values');
});

test('a name with no entry of its own becomes a node with no outgoing edges', () => {
  const sem = semanticGraph(runTrace('const g = {"a": ["b", "c"], "b": ["c"]};').steps.at(-1), 'g');
  assert.deepEqual(sem.nodes.map(n => n.key), ['a', 'b', 'c']);
  assert.deepEqual(sem.edges.map(e => e.from + '>' + e.to), ['a>b', 'a>c', 'b>c']);
  const w = semanticGraph(runTrace('const g = {A: {B: 4, C: 2}, B: {C: 1}};').steps.at(-1), 'g');
  assert.deepEqual(w.edges.map(e => e.from + '>' + e.to + ':' + e.weight), ['A>B:4', 'A>C:2', 'B>C:1'], 'weights kept, nodes are the names (not object ids)');
});

test('edges written as objects: the target field names the node, a weight field labels the edge', () => {
  const edges = code => semanticGraph(runTrace('const g = ' + code + ';').steps.at(-1), 'g').edges.map(e => e.from + '>' + e.to + (e.weight ? ':' + e.weight : ''));
  assert.deepEqual(edges('{ A: [{ node: "B", weight: 4 }, { node: "C", weight: 2 }], B: [{ node: "C", weight: 1 }] }'), ['A>B:4', 'A>C:2', 'B>C:1'], 'C has no entry: still a node');
  assert.deepEqual(edges('new Map([["A", [{ to: "B", cost: 3 }]], ["B", [{ to: "C", cost: 1 }]]])'), ['A>B:3', 'B>C:1']);
  assert.deepEqual(edges('[{ id: 0, adj: [{ to: 1, w: 5 }, { to: 2, w: 1 }] }, { id: 1, adj: [{ to: 2, w: 2 }] }, { id: 2, adj: [] }]'), ['0>1:5', '0>2:1', '1>2:2'], 'numeric ids in a target field');
  assert.deepEqual(edges('[{ id: "A", roads: [{ city: "B", km: 3 }] }, { id: "B", roads: [{ city: "C", km: 1 }] }, { id: "C", roads: [] }]'), ['A>B', 'B>C'],
    'an unknown field that is the only one naming a node is the target; km is not a weight field');
  const s = runTrace('const g = { A: [{ to: "B", w: 4 }], B: [] };').steps.at(-1);
  assert.ok(buildSemanticView(s, null, 'g', semanticGraph(s, 'g'), true).prims.some(q => q.text === '4'), 'the weight is drawn on the edge');
});

const texts = view => view.prims.map(q => q.text).filter(Boolean);

test('a node shows all of its own values, not just two', () => {
  const s = runTrace('const graph = [{ id: "A", color: "red", dist: 0, seen: true, tags: ["x", "y"], edges: [{ to: "B", w: 4 }] }, { id: "B", color: "blue", dist: 4, seen: false, tags: [], edges: [] }];').steps.at(-1);
  const sem = semanticGraph(s, 'graph');
  assert.deepEqual(sem.nodes[0].fields.map(f => f.k + '=' + f.text), ['color=red', 'dist=0', 'seen=true', 'tags=[x, y]'], 'id and edges are not values');
  const t = texts(buildSemanticView(s, null, 'graph', sem, true));
  for (const want of ['color', 'red', 'dist', '0', 'seen', 'true', 'tags', '[x, y]', 'blue', 'false']) assert.ok(t.includes(want), want + ' drawn');
  const tree = semanticGraph(runTrace('const t = { val: 1, left: { val: 2, left: null, right: null }, right: null };').steps.at(-1), 't');
  assert.deepEqual(tree.nodes.map(n => n.fields.length), [0, 0], 'a plain tree node has nothing extra (links and nulls are not values)');
});

test('a node shows only its own values: other variables, even other graphs keyed by the same names, add nothing', () => {
  const code = 'const g1 = { A: ["B", "C"], B: ["D"], C: ["D"], D: [] };\nconst g6 = { A: new Set(["B", "C"]), B: new Set(["C"]), C: new Set() };\nconst dist = { A: 0, B: 4, C: 6, D: 1 };';
  const s = runTrace(code).steps.at(-1), sem = semanticGraph(s, 'g1'), t = texts(buildSemanticView(s, null, 'g1', sem, true));
  assert.deepEqual(sem.nodes.map(n => n.rows.length), [0, 0, 0, 0]);
  assert.ok(!t.includes('g6') && !t.includes('dist'), 'neither another graph nor a table keyed by node shows up in the nodes');
});

test('a value of the node itself that changed since the last step is marked', () => {
  const steps = runTrace('const g = [{ id: "A", dist: 9, next: ["B"] }, { id: "B", dist: 9, next: [] }];\ng[1].dist = 4;').steps;
  const s = steps.at(-1), view = buildSemanticView(s, steps.at(-2), 'g', semanticGraph(s, 'g'), true);
  assert.equal(view.prims.filter(q => /g-frow chg/.test(q.p.className || '')).length, 1, 'only B.dist changed');
  assert.ok(view.changed);
});

test('a node with values besides its label lists every field with its key: { id: 1, weight: 3 } reads "id 1 / weight 3"', () => {
  const rows = code => {
    const s = runTrace('const g = ' + code + ';').steps.at(-1), sem = semanticGraph(s, 'g');
    const view = buildSemanticView(s, null, 'g', sem, true);
    return { rows: sem.nodes.map(n => n.rows.map(r => r.k + ' ' + r.text).join(' / ')), text: texts(view) };
  };
  const byId = rows('[{ id: 1, weight: 3, next: [2] }, { id: 2, weight: 5, next: [] }]');
  assert.deepEqual(byId.rows, ['id 1 / weight 3', 'id 2 / weight 5']);
  for (const want of ['id', '1', 'weight', '3']) assert.ok(byId.text.includes(want), want + ' drawn');
  assert.deepEqual(rows('{ id: 1, weight: 3, children: [{ id: 2, weight: 5, children: [] }] }').rows, ['id 1 / weight 3', 'id 2 / weight 5'],
    'an empty children: [] is a link with nothing in it, not a value');
  const plain = rows('{ val: 1, left: { val: 2, left: null, right: null }, right: null }');
  assert.deepEqual(plain.rows, ['', ''], 'a node with only its label keeps the compact title');
  assert.ok(plain.text.includes('1') && !plain.text.includes('val'), 'title only, no "val" row');
});

test('an edge object\'s other values are drawn on its arrow as key value lines', () => {
  const s = runTrace("const graph = { '0': [{ v: 1, start: 0, end: 3 }, { v: 2, start: 1, end: 5 }], '1': [{ v: 3, start: 7, end: 8 }], '2': [{ v: 3, start: 4, end: 7 }] };").steps.at(-1);
  const sem = semanticGraph(s, 'graph'), t = texts(buildSemanticView(s, null, 'graph', sem, true));
  assert.deepEqual(sem.edges.map(e => e.from + '>' + e.to + ' ' + e.lines.join(' / ')), ['0>1 start 0 / end 3', '0>2 start 1 / end 5', '1>3 start 7 / end 8', '2>3 start 4 / end 7']);
  for (const want of ['start 0', 'end 3', 'start 7', 'end 8']) assert.ok(t.includes(want), want + ' drawn');
  const two = semanticGraph(runTrace('const g = { A: [{ to: "B", t: 1 }, { to: "B", t: 2 }], B: [{ to: "A", t: 9 }] };').steps.at(-1), 'g');
  assert.equal(two.edges.length, 3, 'edges with different values are not merged, nor folded into one undirected edge');
  const w = runTrace('const g = { A: [{ to: "B", w: 4 }], B: [] };').steps.at(-1), ws = semanticGraph(w, 'g');
  buildSemanticView(w, null, 'g', ws, true);
  assert.deepEqual(ws.edges[0].lines, ['4'], 'a weight alone stays a bare number');
});

test('an edge whose values changed since the last step is marked', () => {
  const steps = runTrace('const g = { A: [{ to: "B", start: 0 }], B: [] };\ng.A[0].start = 5;').steps;
  const s = steps.at(-1), view = buildSemanticView(s, steps.at(-2), 'g', semanticGraph(s, 'g'), true);
  assert.ok(view.prims.some(q => q.tag === 'path' && /chg/.test(q.p.className)), 'edge marked');
  assert.ok(view.prims.some(q => q.text === 'start 5' && /chg/.test(q.p.className)), 'its label marked');
});

test('the "Data structures" example shows each shape as intended', () => {
  const r = semAll(EXAMPLES['Data structures']);
  for (const want of ['g1:Graph', 'g2:Graph', 'g3:Graph', 'g4:Graph', 'g5:Graph', 'g6:Graph', 'g7:Undirected graph', 'adj:Graph', 'edgeList:Graph',
    'tree:Tree', 'family:Tree', 'list:Linked list', 'va:Graph', 'byKey:Graph', 'byIndex:Graph', 'tasks:Tree', 'cyc:Graph',
    'towns:Graph', 'jobs:Graph', 'weightedNodes:Graph', 'chain:Linked list', 'intervals:Graph', 'roads:Graph']) assert.ok(r.kinds.includes(want), 'missing ' + want + ' in ' + r.kinds.join());
  for (const plain of ['nums:', 'typed:', 'person:', 'scores:', 'p:', 'shared:', 'pair:', 'visited:']) assert.ok(!r.kinds.some(k => k.startsWith(plain)), plain + ' is data, not a graph');
  assert.deepEqual(r.problems, []);
});

test('the "Data structures" example has nodes with data and edges with data', () => {
  const s = runTrace(EXAMPLES['Data structures']).steps.at(-1);
  const show = name => { const sem = semanticGraph(s, name); buildSemanticView(s, null, name, sem, true); return sem; };
  assert.deepEqual(show('towns').nodes.map(n => n.label + ': ' + n.rows.map(r => r.k + ' ' + r.text).join(', ')), ['a: color red, cost 2', 'b: color blue, cost 5', 'c: color green, cost 1']);
  assert.deepEqual(show('weightedNodes').nodes.map(n => n.rows.map(r => r.k + ' ' + r.text).join(', ')), ['id 1, weight 3', 'id 2, weight 5', 'id 3, weight 1']);
  assert.deepEqual(show('chain').nodes.map(n => n.rows.map(r => r.k + ' ' + r.text).join(', ')), ['val 1, color red', 'val 2, color blue']);
  assert.deepEqual(show('intervals').edges.map(e => e.lines.join(' / ')), ['start 0 / end 3', 'start 1 / end 5', 'start 7 / end 8', 'start 4 / end 7']);
  assert.deepEqual(show('roads').edges.map(e => e.lines.join('')), ['4', '2', '1']);
});

test('index adjacency with [node, …] tuples: the node is the first position holding node numbers, the rest goes on the arrow', () => {
  const lines = (name, code) => {
    const s = runTrace(code).steps.at(-1), sem = semanticGraph(s, name);
    if (!sem) return null;
    buildSemanticView(s, null, name, sem, true);
    return sem.edges.map(e => e.from + '>' + e.to + (e.lines.length ? ' ' + e.lines.join('/') : ''));
  };
  assert.deepEqual(lines('graph', 'const graph = [ [ [ 1, 0, 3 ], [ 2, 1, 5 ] ], [ [ 3, 7, 8 ] ], [ [ 3, 4, 7 ] ], [] ];'), ['0>1 0, 3', '0>2 1, 5', '1>3 7, 8', '2>3 4, 7']);
  assert.deepEqual(lines('adj', 'const adj = [[[1, 4], [2, 1]], [[2, 2]], []];'), ['0>1 4', '0>2 1', '1>2 2'], 'one extra number is a weight');
  assert.deepEqual(lines('adj', 'const adj = [[1, [2, 9]], [], []];'), ['0>1', '0>2 9'], 'numbers and tuples can be mixed');
  const want = ['0>1 0, 3', '0>2 1, 5', '1>3 7, 8', '2>3 4, 7'];
  assert.deepEqual(lines('graph', 'const graph = [[[0,1,3],[1,2,5]],[[7,3,8]],[[4,3,7]],[]];'), want, 'node in the middle');
  assert.deepEqual(lines('graph', 'const graph = [[[0,3,1],[1,5,2]],[[7,8,3]],[[4,7,3]],[]];'), want, 'node last');
  assert.deepEqual(lines('adj', 'const adj = [[[4, 1], [9, 2]], [[6, 2]], []];'), ['0>1 4', '0>2 9', '1>2 6'], '[weight, node] pairs');
  assert.deepEqual(lines('adj', 'const adj = [[[1, 2]], [[0, 0]], [[1, 1]]];'), ['0>1 2', '1>0 0', '2>1 1'],
    'when several positions could be the node, the first one is used; arrows with different weights are not merged');
  assert.equal(lines('adj', 'const adj = [[[7, 8]], []];'), null, 'no position holds node numbers');
  assert.equal(lines('lines', 'const lines = [[[1, 0, 3]], [[0, 2, 2]]];'), null, 'like plain number lists, the variable name decides');
});

test('Memory view pointer tags: one arrow under each pointed-at cell, the names below it, cells keep their width', () => {
  const s = runTrace('const arr = [5, 2, 9, 1, 6]; let i = 1, j = 2, lo = 2, pivot = 4;').steps.at(-1);
  const view = buildMemoryView(s, null, 'arr', true);
  const arrows = view.prims.filter(q => q.p.className === 'g-ptrarrow');
  const names = view.prims.filter(q => q.p.className === 'g-chiptxt').map(q => q.text);
  assert.equal(arrows.length, 3, 'cells 1, 2 and 4: one arrow each, however many names point there');
  assert.deepEqual(names, ['i', 'j', 'lo', 'pivot'], 'names on their own, without an arrow glued to them');
  const cells = view.prims.filter(q => q.tag === 'rect' && q.p.className.startsWith('g-cell'));
  const plain = buildMemoryView(runTrace('const arr = [5, 2, 9, 1, 6];').steps.at(-1), null, 'arr', true);
  const plainCells = plain.prims.filter(q => q.tag === 'rect' && q.p.className.startsWith('g-cell'));
  assert.deepEqual(cells.map(c => c.p.width), plainCells.map(c => c.p.width), 'pointer names never change the width of the cells');
  const crowd = buildMemoryView(runTrace('const arr = [5, 2, 9, 1]; let currentIndex = 0, i = 1, j = 2;').steps.at(-1), null, 'arr', true);
  const boxes = crowd.prims.filter(q => q.p.className === 'g-chiptxt').map(q => ({ t: q.text, y: q.p.y, a: q.p.x - q.text.length * 3.6, b: q.p.x + q.text.length * 3.6 }));
  for (const u of boxes) for (const v of boxes) if (u !== v && u.y === v.y) assert.ok(u.b <= v.a || v.b <= u.a, `"${u.t}" and "${v.t}" do not overlap`);
  assert.ok(boxes.find(q => q.t === 'i').y > boxes.find(q => q.t === 'currentIndex').y, 'a name that would overlap a long one moves down a row');
  const pv = view.prims.find(q => q.text === 'pivot');
  assert.ok(pv.p.x + 'pivot'.length * 7.2 / 2 <= view.width, 'a name past the last cell still fits in the drawing');
  const below = n => view.prims.find(q => q.text === n).p.y, arrowY = arrows[1].p.y;
  assert.ok(below('j') > arrowY && below('lo') > below('j'), 'names are stacked under the arrow');
});
