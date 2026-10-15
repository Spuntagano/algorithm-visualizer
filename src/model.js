/**
 * Helpers for reading the snapshots produced by engine/serialize.js.
 *
 * A snapshot "node" is a plain, immutable copy of one value:
 *   { t: 'p',   k: 'num'|'str'|'bool'|'null'|'undef'|'sym', s: 'display text' }   primitive
 *   { t: 'arr', id, len, items: [node], more }                  array / typed array
 *   { t: 'obj', id, cls, entries: [[key, node]], more }         object (cls = class name, '' for plain)
 *   { t: 'map', id, entries: [[node, node]], more }
 *   { t: 'set', id, items: [node], more }
 *   { t: 'ref', id }     an object already shown elsewhere in the same snapshot
 *   { t: 'trunc', id }   nesting deeper than MAX_DEPTH
 *   { t: 'fn', s: 'name' }
 *
 * A step is { line, stack: [{name, args}], vars: [{name, scope, node}], refs: [id], logs: n }.
 * `more` counts items that were cut off by the size limits.
 * Arrays may have `base: 1` (Lua tables numbered from 1): views number their cells, and index-based rules count, from it.
 * Python values (engine/python/tracer.py) use the same nodes, plus the type name: `cls` on arrays, sets and maps
 * ('list', 'tuple', 'deque', 'set', 'dict'…) and `tn` on dicts shown as objects (their keys are all strings).
 * C values (engine/c/interp.js) add `tn` on arrays (the C type: 'int[5]'), primitives of kind 'char' ("'a'") and
 * 'ptr' (a pointer into an array or to a scalar: s '&nums[2]', with `to` (the array's id) and `at` (the index) when
 * it points at an array cell); a pointer to a struct or to the start of an array is shown as that memory itself.
 */

export const isCont = n => n.t === 'arr' || n.t === 'obj' || n.t === 'map' || n.t === 'set';

export const clip = s => s.length > 22 ? s.slice(0, 21) + '…' : s;

export const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The name a primitive gives a node: a string's text, a Ruby symbol without its colon (:b names node b), else as shown. */
export const keyOf = p => (p.k === 'str' ? JSON.parse(p.s) : p.k === 'sym' && p.s.startsWith(':') ? p.s.slice(1)
  : p.k === 'char' ? p.s.slice(1, -1) : p.s);

/** A string, a Ruby symbol (:b names node "b") or a C char ('b'): any can name a node. */
export const isText = p => p.k === 'str' || p.k === 'char' || (p.k === 'sym' && p.s.startsWith(':'));

export const dispOf = p => (p.k === 'str' ? keyOf(p) : p.s);

/* Every expanded container in a step by id, and a resolver that follows "↪ #id" references. */
export function stepIndex(step) {
  const byId = new Map();
  const index = n => {
    if (n.t === 'arr' || n.t === 'set') { if (!byId.has(n.id)) byId.set(n.id, n); n.items.forEach(index); }
    else if (n.t === 'obj' || n.t === 'map') {
      if (!byId.has(n.id)) byId.set(n.id, n);
      n.entries.forEach(([k, x]) => { if (n.t === 'map') index(k); index(x); });
    }
  };
  step.vars.forEach(x => index(x.node));
  const resolve = n => (n.t === 'ref' || n.t === 'trunc') ? (byId.get(n.id) || null) : (isCont(n) ? n : null);
  return { byId, resolve };
}

export function markersFor(arr, vars, selfName) {
  const m = {};
  for (const v of vars) {
    if (v.name === selfName || v.node.t !== 'p') continue;
    let i;
    if (v.node.k === 'ptr') { if (v.node.to !== arr.id) continue; i = v.node.at; }   // a C pointer to one of its cells
    else if (v.node.k !== 'num' || !/^\d+$/.test(v.node.s)) continue;
    else i = +v.node.s - (arr.base || 0);          // a Lua array starts at 1: i = 1 points at the first cell
    if (i >= 0 && i < arr.items.length) (m[i] = m[i] || []).push(v.name);
  }
  return m;
}
