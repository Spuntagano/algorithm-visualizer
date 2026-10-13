/**
 * The "Graph" view, part 1: decide whether a variable *is* a graph and extract nodes and edges
 * from its keys and values.
 *   keyed    { A: ["B","C"] }, { A: {B: 4} }, Map          indexed  adj = [[1,2],[0]], edges = [[0,1]]
 *   records  objects that point at similar objects: trees, linked lists, node-and-neighbour graphs
 */
import { dispOf, keyOf, short, stepIndex } from '../model.js';

const SEM_MAX = 60;

const LABEL_KEYS = ['val', 'value', 'data', 'key', 'name', 'id', 'label', 'title', 'v', 'x', 'n', 'item', 'char', 'letter', 'weight'];

function finishSem(kind, keyKind, nodes, edges) {
  const seen = new Set(), list = [];
  for (const e of edges) {
    const k = e.from + '\u0001' + e.to + '\u0001' + (e.label || '');
    if (!seen.has(k)) { seen.add(k); list.push({ ...e }); }
  }
  const used = new Set(), out = [];
  list.forEach((e, i) => {                    // A→B plus B→A (same label) is one undirected edge
    if (used.has(i)) return;
    if (e.from !== e.to) {
      const j = list.findIndex((f, jj) => jj > i && !used.has(jj) && f.from === e.to && f.to === e.from && (f.label || '') === (e.label || ''));
      if (j >= 0) { used.add(j); out.push({ ...e, undirected: true }); return; }
    }
    out.push(e);
  });
  return { kind, keyKind, nodes, edges: out, map: new Map(nodes.map(n => [n.key, n])), rootId: null };
}

/* { A: ["B","C"], B: ["D"] }  or  { A: {B: 4, C: 2} }  or  Map(A → [...])  */
function fromKeyed(root) {
  if (root.t !== 'obj' && root.t !== 'map') return null;
  const ents = root.entries.map(([k, x]) => [root.t === 'obj' ? k : (k.t === 'p' ? keyOf(k) : null), x]);
  if (ents.length < 2 || ents.some(e => e[0] == null) || root.more) return null;
  const keys = ents.map(e => String(e[0])), keySet = new Set(keys), edges = [];
  for (const [k, x] of ents) {
    const from = String(k), add = (to, w) => edges.push({ from, to: String(to), weight: w });
    if (x.t === 'arr' || x.t === 'set') {
      if (x.more) return null;
      for (const it of x.items) {
        if (it.t === 'p' && keySet.has(String(keyOf(it)))) add(keyOf(it));
        else if (it.t === 'arr' && it.items.length === 2 && it.items[0].t === 'p' && keySet.has(String(keyOf(it.items[0]))) && it.items[1].t === 'p' && it.items[1].k === 'num') add(keyOf(it.items[0]), it.items[1].s);
        else return null;
      }
    } else if (x.t === 'obj' || x.t === 'map') {
      for (const [k2, w] of x.entries) {
        const kk = x.t === 'obj' ? k2 : (k2.t === 'p' ? keyOf(k2) : null);
        if (kk != null && keySet.has(String(kk)) && w.t === 'p' && w.k === 'num') add(kk, w.s); else return null;
      }
    } else if (x.t === 'p' && (x.k === 'null' || x.k === 'undef')) { /* no neighbours */ }
    else if (x.t === 'p' && keySet.has(String(keyOf(x)))) add(keyOf(x));
    else return null;
  }
  if (!edges.length) return null;
  return finishSem('keyed', 'prim', keys.map(k => ({ key: k, label: short(k, 10), caption: '' })), edges);
}

/* [[1,2],[0],[0]] named like a graph, or [[0,1],[1,2]] named like an edge list */
function fromIndexed(root, name) {
  if (root.t !== 'arr' || !root.items.length || root.more) return null;
  const isPair = e => e.t === 'arr' && (e.items.length === 2 || e.items.length === 3) && e.items.slice(0, 2).every(p => p.t === 'p');
  if (/edge/i.test(name) && root.items.every(isPair)) {
    const order = [], seen = new Set(), edges = [];
    root.items.forEach(e => {
      const a = String(keyOf(e.items[0])), b = String(keyOf(e.items[1]));
      [a, b].forEach(k => { if (!seen.has(k)) { seen.add(k); order.push(k); } });
      edges.push({ from: a, to: b, weight: e.items[2] && e.items[2].t === 'p' ? e.items[2].s : undefined });
    });
    return finishSem('edges', 'prim', order.map(k => ({ key: k, label: short(k, 10), caption: '' })), edges);
  }
  const n = root.items.length;
  if (/graph|adj|neigh|tree|^g$/i.test(name) && root.items.every(r => r.t === 'arr' && !r.more && r.items.every(q => q.t === 'p' && q.k === 'num' && /^\d+$/.test(q.s) && +q.s < n))) {
    const edges = [];
    root.items.forEach((r, i) => r.items.forEach(q => edges.push({ from: String(i), to: q.s })));
    if (!edges.length) return null;
    return finishSem('indexed', 'prim', root.items.map((_, i) => ({ key: String(i), label: String(i), caption: '' })), edges);
  }
  return null;
}

/* Objects that point at objects of the same shape: trees, linked lists, node-and-neighbour graphs */
function recordNode(o) {
  const real = x => x.k !== 'null' && x.k !== 'undef';
  const prims = o.entries.filter(([, x]) => x.t === 'p');
  const lk = LABEL_KEYS.find(k => prims.some(([kk, x]) => kk === k && real(x)));
  const le = (lk && prims.find(([kk]) => kk === lk)) || prims.find(([, x]) => real(x));
  const caption = prims.filter(q => q !== le && real(q[1])).slice(0, 2).map(([k, x]) => short(k + ':' + dispOf(x), 11)).join(' ');
  return { key: String(o.id), label: le ? short(dispOf(le[1]), 10) : '#' + o.id, caption };
}

function fromRecords(root, resolve) {
  const asObj = n => { const r = resolve(n); return r && r.t === 'obj' ? r : null; };
  const roots = [];
  if (root.t === 'obj') roots.push(root);
  else if (root.t === 'arr' || root.t === 'set') root.items.forEach(it => { const o = asObj(it); if (o) roots.push(o); });
  else if (root.t === 'map') root.entries.forEach(([, x]) => { const o = asObj(x); if (o) roots.push(o); });
  if (!roots.length) return null;
  const seen = new Map(), queue = [], edges = [], pairs = [];
  const touch = o => { if (!seen.has(o.id)) { seen.set(o.id, o); queue.push(o); } };
  roots.forEach(touch);
  while (queue.length) {
    const o = queue.shift();
    if (seen.size > SEM_MAX) return null;
    for (const [k, x] of o.entries) {
      const targets = [], t = asObj(x);
      if (t) targets.push(t);
      else { const c = resolve(x); if (c && (c.t === 'arr' || c.t === 'set')) c.items.forEach(it => { const ot = asObj(it); if (ot) targets.push(ot); }); }
      targets.forEach(tt => { touch(tt); edges.push({ from: String(o.id), to: String(tt.id), label: k }); pairs.push([o, tt]); });
    }
  }
  const keysOf = o => o.entries.map(e => e[0]);
  const similar = ([a, b]) => {
    if (a.cls && a.cls === b.cls) return true;
    const ka = keysOf(a), kb = keysOf(b);
    return ka.filter(k => kb.includes(k)).length / Math.max(ka.length, kb.length, 1) >= 0.5;
  };
  if (seen.size < 2 || !pairs.some(similar)) return null;
  return finishSem('records', 'id', [...seen.values()].map(recordNode), edges);
}

export function semanticGraph(step, name) {
  const v = step.vars.find(x => x.name === name);
  if (!v) return null;
  const { resolve } = stepIndex(step);
  const root = resolve(v.node);
  if (!root) return null;
  const sem = fromKeyed(root) || fromIndexed(root, name) || fromRecords(root, resolve);
  if (!sem || sem.nodes.length > SEM_MAX) return null;
  sem.rootId = root.id;
  return sem;
}
