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
  assert.deepEqual(r.kinds, []);
});

test('variables that point into a graph show up as tags on its nodes', () => {
  const t = runTrace('const g = {A:["B"],B:["C"],C:[]}; const seen = new Set(["A"]); let cur = "B";');
  const s = t.steps.at(-1), sem = semanticGraph(s, 'g');
  const text = buildSemanticView(s, null, 'g', sem, true).prims.map(q => q.text);
  assert.ok(text.includes('↑ cur'), 'cur tag'); assert.ok(text.includes('∈ seen'), 'seen tag');
});

test('"Raw" memory-layout graphs: no overlaps, no edges through nodes, no crossings', () => {
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

test('"Raw" memory layout: 200 random nested structures have no overlaps, no edges through nodes, no crossings', () => {
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
