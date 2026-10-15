/**
 * The "Graph" view, part 1: decide whether a variable *is* a graph and extract nodes and edges
 * from its keys and values.
 *   keyed    { A: ["B","C"] }, { A: {B: 4} }, Map          indexed  adj = [[1,2],[0]], edges = [[0,1]], matrix [[0,1],[1,0]]
 *   records  objects that point at similar objects: trees, linked lists, node-and-neighbour graphs
 *   refs     records that name each other by key, index or id: { a: {next: ["b"]} }, [{out: [1, 2]}]
 */
import { dispOf, isText, keyOf, short, stepIndex } from '../model.js';

const SEM_MAX = 60;

const LABEL_KEYS = ['val', 'value', 'data', 'key', 'name', 'id', 'label', 'title', 'v', 'x', 'n', 'item', 'char', 'letter', 'weight'];

/** A node's own plain values, shown inside it: primitives and short arrays of primitives, minus the fields in `skip`. */
function fieldRows(o, skip) {
  const rows = [];
  for (const [k, x] of o.entries) {
    if (skip.has(k)) continue;
    if (x.t === 'p' && x.k !== 'null' && x.k !== 'undef') rows.push({ k, text: short(dispOf(x), 16), kind: x.k });
    else if (x.t === 'arr' && !x.more && x.items.every(i => i.t === 'p')) rows.push({ k, text: short('[' + x.items.map(dispOf).join(', ') + ']', 16), kind: '' });
  }
  return rows;
}

function finishSem(kind, keyKind, nodes, edges) {
  const linkKeys = new Set(edges.map(e => e.label).filter(Boolean));   // e.g. an empty children: [] is a link, not a value
  nodes.forEach(n => { if (n.fields) n.fields = n.fields.filter(f => !linkKeys.has(f.k)); });
  const seen = new Set(), list = [];
  const same = e => (e.label || '') + '\u0001' + (e.weight ?? '') + '\u0001' + JSON.stringify(e.attrs || null);   // edges with different values (or weights) stay two
  for (const e of edges) {
    const k = e.from + '\u0001' + e.to + '\u0001' + same(e);
    if (!seen.has(k)) { seen.add(k); list.push({ ...e }); }
  }
  const used = new Set(), out = [];
  list.forEach((e, i) => {                    // A→B plus B→A (same label and values) is one undirected edge
    if (used.has(i)) return;
    if (e.from !== e.to) {
      const j = list.findIndex((f, jj) => jj > i && !used.has(jj) && f.from === e.to && f.to === e.from && same(f) === same(e));
      if (j >= 0) { used.add(j); out.push({ ...e, undirected: true }); return; }
    }
    out.push(e);
  });
  return { kind, keyKind, nodes, edges: out, map: new Map(nodes.map(n => [n.key, n])), rootId: null };
}

/* Fields of an edge written as an object, { to: "B", weight: 4 }: the one naming the target node, and the weight */
const TARGET_KEYS = ['to', 'node', 'target', 'dest', 'id', 'key', 'name', 'vertex', 'neighbor', 'neighbour', 'v', 'n'];
const WEIGHT_KEYS = ['weight', 'w', 'cost', 'dist', 'distance', 'len', 'length', 'capacity', 'cap', 'time'];

/**
 * Reads an edge object. `nodeOf(p, named)` gives the node key a primitive names (or null); `named` is true when the
 * primitive sits in a TARGET_KEYS field. Without such a field, the one field that names a node is the target.
 * @returns {{ to: string, weight: string | undefined, attrs: string[][] } | null}
 */
function edgeObject(o, nodeOf) {
  if (!o || o.t !== 'obj' || o.more) return null;
  const prims = o.entries.filter(([, x]) => x.t === 'p' && x.k !== 'null' && x.k !== 'undef');
  let tf = TARGET_KEYS.map(k => prims.find(([f]) => f === k)).find(e => e && nodeOf(e[1], true) != null), to = tf && nodeOf(tf[1], true);
  if (!tf) {
    const hits = prims.filter(([, x]) => nodeOf(x, false) != null);
    if (hits.length !== 1) return null;
    tf = hits[0]; to = nodeOf(tf[1], false);
  }
  const wf = prims.find(([f, x]) => f !== tf[0] && x.k === 'num' && WEIGHT_KEYS.includes(f));
  const attrs = prims.filter(([f]) => f !== tf[0]).map(([f, x]) => [f, short(dispOf(x), 14)]);   // everything else the edge says
  return { to, weight: wf ? wf[1].s : undefined, attrs };
}

/* { A: ["B","C"], B: ["D"] }  or  { A: {B: 4, C: 2} }  or  { A: [{to: "B", w: 4}] }  or  Map(A → [...])
   A name in a list that has no entry of its own (D above) is a node with no outgoing edges. */
function fromKeyed(root, resolve) {
  if (root.t !== 'obj' && root.t !== 'map') return null;
  const ents = root.entries.map(([k, x]) => [root.t === 'obj' ? k : (k.t === 'p' ? keyOf(k) : null), x]);
  if (ents.length < 2 || ents.some(e => e[0] == null) || root.more) return null;
  const keys = ents.map(e => String(e[0])), keySet = new Set(keys), edges = [];
  const isName = p => p.t === 'p' && (isText(p) || p.k === 'num');
  for (const [k, x] of ents) {
    const from = String(k), add = (to, w, attrs) => edges.push({ from, to: String(to), weight: w, attrs });
    if (x.t === 'arr' || x.t === 'set') {
      if (x.more) return null;
      for (const it of x.items) {
        if (isName(it)) { add(keyOf(it)); continue; }
        if (it.t === 'arr' && it.items.length === 2 && isName(it.items[0]) && it.items[1].t === 'p' && it.items[1].k === 'num') { add(keyOf(it.items[0]), it.items[1].s); continue; }
        // { to: "B", weight: 4 }: a target field may name a node with no entry; otherwise the value must be a key
        const eo = edgeObject(resolve(it), (p, named) => (isName(p) && (named || keySet.has(String(keyOf(p)))) ? String(keyOf(p)) : null));
        if (!eo) return null;
        add(eo.to, eo.weight, eo.attrs);
      }
    } else if (x.t === 'obj' || x.t === 'map') {
      if (x.more) return null;
      for (const [k2, w] of x.entries) {
        const kk = x.t === 'obj' ? k2 : (isName(k2) ? keyOf(k2) : null);
        if (kk != null && w.t === 'p' && w.k === 'num') add(kk, w.s); else return null;
      }
    } else if (x.t === 'p' && (x.k === 'null' || x.k === 'undef')) { /* no neighbours */ }
    else if (x.t === 'p' && keySet.has(String(keyOf(x)))) add(keyOf(x));    // a lone value must be a key: {2: 1, 3: 2} is data
    else return null;
  }
  // at least one edge has to reach another entry, or this is just lists of values: {fruits: ["apple"], veg: ["kale"]}
  if (!edges.some(e => keySet.has(e.to) && e.to !== e.from)) return null;
  // a two-way lookup table, each name mapped to one value that maps straight back (a TypeScript enum: {Red: 0, 0: "Red"}), is data
  const lone = ents.every(([, x]) => x.t === 'p'), pairs = new Set(edges.map(e => e.from + '\u0001' + e.to));
  if (lone && edges.length === ents.length && edges.every(e => pairs.has(e.to + '\u0001' + e.from))) return null;
  const sinks = [...new Set(edges.map(e => e.to).filter(t => !keySet.has(t)))];
  return finishSem('keyed', 'prim', [...keys, ...sinks].map(k => ({ key: k, label: short(k, 10), fields: [] })), edges);
}

/* [[1,2],[0],[0]], [[[1, 4]], [[2, 0, 3]]] or an adjacency matrix [[0,1],[1,0]] named like a graph, or [[0,1],[1,2]] named like an edge list */
function fromIndexed(root0, name, resolve) {
  if (root0.t !== 'arr' || !root0.items.length || root0.more) return null;
  // a list or pair that also appears elsewhere is a reference here (Python even shares equal constant tuples): follow it
  const deref = x => ((x.t === 'ref' || x.t === 'trunc') && resolve(x)) || x;
  const root = { ...root0, items: root0.items.map(x => {
    const r = deref(x);
    return r.t === 'arr' ? { ...r, items: r.items.map(deref) } : r;
  }) };
  const isPair = e => e.t === 'arr' && (e.items.length === 2 || e.items.length === 3) && e.items.slice(0, 2).every(p => p.t === 'p');
  if (/edge/i.test(name) && root.items.every(isPair)) {
    const order = [], seen = new Set(), edges = [];
    root.items.forEach(e => {
      const a = String(keyOf(e.items[0])), b = String(keyOf(e.items[1]));
      [a, b].forEach(k => { if (!seen.has(k)) { seen.add(k); order.push(k); } });
      edges.push({ from: a, to: b, weight: e.items[2] && e.items[2].t === 'p' ? e.items[2].s : undefined });
    });
    return finishSem('edges', 'prim', order.map(k => ({ key: k, label: short(k, 10), fields: [] })), edges);
  }
  const n = root.items.length, base = root0.base || 0;   // nodes are numbered from 1 in a Lua table
  const isIndex = q => q.t === 'p' && q.k === 'num' && /^\d+$/.test(q.s) && +q.s >= base && +q.s < n + base;
  const lists = root.items.every(r => r.t === 'arr' && !r.more) ? root.items : null;
  if (!lists || !/graph|adj|neigh|tree|^g$/i.test(name)) return null;
  // an adjacency matrix: n rows of n numbers, 0 where there is no edge and 1 (or, with 0 down the diagonal, a weight) where there is
  const cells = lists.every(r => r.items.length === n && r.items.every(q => q.t === 'p' && q.k === 'num' && /^\d+(\.\d+)?$/.test(q.s)));
  if (n >= 2 && cells) {
    const ones = lists.every(r => r.items.every(q => +q.s === 0 || +q.s === 1));
    if (ones || lists.every((r, i) => +r.items[i].s === 0)) {
      const edges = [];
      lists.forEach((r, i) => r.items.forEach((q, j) => { if (+q.s !== 0) edges.push({ from: String(i + base), to: String(j + base), weight: ones ? undefined : q.s }); }));
      if (!edges.length) return null;
      return finishSem('matrix', 'prim', root.items.map((_, i) => ({ key: String(i + base), label: String(i + base), fields: [] })), edges);
    }
  }
  // a neighbour is a node number, or a tuple of plain values holding one: [1, 4], [1, 0, 3], [0, 3, 1]…
  const tuples = lists.flatMap(r => r.items.filter(q => q.t !== 'p'));
  if (lists.some(r => r.items.some(q => q.t === 'p' ? !isIndex(q) : q.t !== 'arr' || q.more || !q.items.length || q.items.some(x => x.t !== 'p')))) return null;
  // the node is the first position where every tuple holds a node number; the other values go on the arrow
  const width = Math.min(Infinity, ...tuples.map(q => q.items.length));
  let at = -1;
  for (let k = 0; tuples.length && k < width && at < 0; k++) if (tuples.every(q => isIndex(q.items[k]))) at = k;
  if (tuples.length && at < 0) return null;
  const edges = [];
  lists.forEach((r, i) => r.items.forEach(q => {
    if (q.t === 'p') { edges.push({ from: String(i + base), to: q.s }); return; }
    const to = q.items[at].s, rest = q.items.filter((_, k) => k !== at);
    if (rest.length === 1 && rest[0].k === 'num') edges.push({ from: String(i + base), to, weight: rest[0].s });
    else edges.push({ from: String(i + base), to, attrs: rest.length ? [[null, rest.map(x => short(dispOf(x), 10)).join(', ')]] : undefined });
  }));
  if (!edges.length) return null;
  return finishSem('indexed', 'prim', root.items.map((_, i) => ({ key: String(i + base), label: String(i + base), fields: [] })), edges);
}

/* Objects that point at objects of the same shape: trees, linked lists, node-and-neighbour graphs */
function recordNode(o) {
  const real = x => x.k !== 'null' && x.k !== 'undef';
  const prims = o.entries.filter(([, x]) => x.t === 'p');
  const lk = LABEL_KEYS.find(k => prims.some(([kk, x]) => kk === k && real(x)));
  const le = (lk && prims.find(([kk]) => kk === lk)) || prims.find(([, x]) => real(x));
  return {
    key: String(o.id), label: le ? short(dispOf(le[1]), 10) : '#' + o.id, fields: fieldRows(o, new Set(le ? [le[0]] : [])),
    labelField: le ? { k: le[0], text: short(dispOf(le[1]), 16), kind: le[1].k } : null,
  };
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
    if (kb.length && kb.every(k => ka.includes(k))) return true;     // a leaf that leaves out its links: { val: 2 } under { val, left, right }
    return ka.filter(k => kb.includes(k)).length / Math.max(ka.length, kb.length, 1) >= 0.5;
  };
  if (seen.size < 2 || !pairs.some(similar)) return null;
  return finishSem('records', 'id', [...seen.values()].map(recordNode), edges);
}

/* Field names under which a number is a reference to another node, not just a number */
const LINK_NAME = /next|prev|out|adj|neigh|nbr|edge|link|child|kid|parent|left|right|succ|pred|dep|target|^to$|^from$|^in$/i;

/*
 * Records that name each other by key or index instead of holding each other:
 *   { a: {next: ["b", "c"]}, b: {next: ["c"]} }      nodes are the keys
 *   [{v: "a", out: [1, 2]}, {v: "b", out: [2]}]       nodes are the indices
 *   [{id: "a", next: ["b"]}, {id: "b", next: []}]     nodes are a unique id / key / name field
 *   [{id: "a", edges: [{to: "b", w: 4}]}, …]           edges written as objects (see edgeObject)
 * A field links when every value in it (one value, or an array or Set of them) names a node.
 */
function fromRefRecords(root, resolve) {
  const asObj = n => { const r = resolve(n); return r && r.t === 'obj' ? r : null; };
  const primOf = (o, k) => { const e = o.entries.find(([kk]) => kk === k); return e && e[1].t === 'p' && e[1].k !== 'null' && e[1].k !== 'undef' ? e[1] : null; };
  let recs, strKeys, idKey = null;
  if ((root.t === 'obj' || root.t === 'map') && !root.more && root.entries.length >= 2) {
    recs = root.entries.map(([k, x]) => ({ key: root.t === 'obj' ? k : (k.t === 'p' ? String(keyOf(k)) : null), o: asObj(x) }));
    strKeys = true;
  } else if (root.t === 'arr' && !root.more && root.items.length >= 2) {
    recs = root.items.map((x, i) => ({ key: String(i + (root.base || 0)), o: asObj(x) }));   // by position, from 1 in Lua
    if (recs.every(r => r.o)) {
      idKey = ['id', 'key', 'name'].find(k => {
        const vals = recs.map(r => primOf(r.o, k));
        return vals.every(p => p && (isText(p) || p.k === 'num')) && new Set(vals.map(p => p.s)).size === vals.length;
      }) || null;
      if (idKey) recs.forEach(r => { r.key = String(keyOf(primOf(r.o, idKey))); });
      strKeys = !!idKey && recs.some(r => isText(primOf(r.o, idKey)));
    }
  } else return null;
  if (recs.some(r => r.key == null || !r.o || r.o.more)) return null;

  const keys = new Set(recs.map(r => r.key)), edges = [];
  const target = (field, p, named = false) => {      // the node a primitive names, or null
    if (p.t !== 'p' || (isText(p) ? !strKeys : p.k !== 'num' || !(named || LINK_NAME.test(field)))) return null;
    const k = String(keyOf(p));
    return keys.has(k) ? k : null;
  };
  const link = (field, p) => {                       // { to, weight } for a primitive or an edge object, or null
    if (p.t === 'p') { const to = target(field, p); return to == null ? null : { to }; }
    return edgeObject(resolve(p), (q, named) => target(field, q, named));
  };
  const linkFields = new Set();
  for (const { key, o } of recs) {
    for (const [field, x] of o.entries) {
      if (LABEL_KEYS.includes(field) || field === idKey) continue;
      const c = x.t === 'p' ? null : resolve(x);
      let vals = x.t === 'p' ? [x] : c && (c.t === 'arr' || c.t === 'set') && !c.more ? c.items : null;
      if (!vals) continue;
      if (vals.length && vals.every(p => p.t === 'p' && p.k === 'char')) {         // a C string ends at its '\0'
        const end = vals.findIndex(p => p.s === "'\\0'");
        if (end >= 0) vals = vals.slice(0, end);
      }
      const real = vals.filter(p => !(p.t === 'p' && (p.k === 'null' || p.k === 'undef')));
      const tos = real.map(p => link(field, p));
      if (!tos.length || tos.some(t => t == null)) continue;
      linkFields.add(field);
      tos.forEach(({ to, weight, attrs }) => edges.push({ from: key, to, label: field, weight, attrs }));
    }
  }
  if (!edges.some(e => e.from !== e.to)) return null;

  const nodes = recs.map(({ key, o }) => {
    const prims = o.entries.filter(([k, x]) => x.t === 'p' && x.k !== 'null' && x.k !== 'undef' && !linkFields.has(k) && k !== idKey);
    const lk = root.t === 'arr' && !idKey ? LABEL_KEYS.find(k => prims.some(([kk]) => kk === k)) : null;   // an index says little: show a label field
    const le = lk ? prims.find(([kk]) => kk === lk) : null;
    const idp = idKey ? primOf(o, idKey) : null;
    const labelField = idp ? { k: idKey, text: short(dispOf(idp), 16), kind: idp.k } : le ? { k: le[0], text: short(dispOf(le[1]), 16), kind: le[1].k } : null;
    return { key, label: le ? short(dispOf(le[1]), 10) : short(key, 10), fields: fieldRows(o, new Set([...linkFields, idKey, le && le[0]])), labelField };
  });
  return finishSem('refs', 'prim', nodes, edges);
}

export function semanticGraph(step, name) {
  const v = step.vars.find(x => x.name === name);
  if (!v) return null;
  const { resolve } = stepIndex(step);
  const root = resolve(v.node);
  if (!root) return null;
  const sem = fromKeyed(root, resolve) || fromIndexed(root, name, resolve) || fromRecords(root, resolve) || fromRefRecords(root, resolve);
  if (!sem || sem.nodes.length > SEM_MAX) return null;
  sem.rootId = root.id;
  return sem;
}
