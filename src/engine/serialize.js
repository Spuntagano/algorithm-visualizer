/**
 * Turning live JavaScript values into plain, immutable snapshots.
 * The shape of a snapshot "node" is documented in ../model.js.
 */

const MAX_DEPTH = 5;   // how deeply nested values are expanded
const MAX_ITEMS = 60;  // array / Set elements kept per container
const MAX_KEYS = 30;   // object / Map entries kept per container

/** Short single-line preview, used for call-stack arguments and console output. */
export function brief(v, d = 0) {
  if (typeof v === 'string') return JSON.stringify(v.length > 14 ? v.slice(0, 14) + '…' : v);
  if (typeof v === 'function') return 'ƒ';
  if (Array.isArray(v)) return d > 0 ? '[…]' : '[' + v.slice(0, 6).map(x => brief(x, 1)).join(', ') + (v.length > 6 ? ', …' : '') + ']';
  if (v && typeof v === 'object') {
    if (d > 0) return '{…}';
    const ks = Object.keys(v);
    return '{' + ks.slice(0, 3).map(k => k + ': ' + brief(v[k], 1)).join(', ') + (ks.length > 3 ? ', …' : '') + '}';
  }
  return String(v);
}

/** console.log formatting: strings as-is, everything else as JSON when possible. */
export function fmtLog(x) {
  if (typeof x === 'string') return x;
  try { const s = JSON.stringify(x); if (s !== undefined) return s; } catch (e) { /* cyclic */ }
  return brief(x);
}

/**
 * Creates the serializer for one program run. Object ids come from a WeakMap owned by this
 * serializer, so "#3" is the same object in every snapshot of the run.
 */
export function createSerializer() {
  const ids = new WeakMap(); let nextId = 1;

  function ser(v, ctx, depth) {
    const t = typeof v;
    if (v === null) return { t: 'p', k: 'null', s: 'null' };
    if (v === undefined) return { t: 'p', k: 'undef', s: 'undefined' };
    if (t === 'number') return { t: 'p', k: 'num', s: Object.is(v, -0) ? '-0' : String(v) };
    if (t === 'bigint') return { t: 'p', k: 'num', s: v + 'n' };
    if (t === 'boolean') return { t: 'p', k: 'bool', s: String(v) };
    if (t === 'string') return { t: 'p', k: 'str', s: JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v) };
    if (t === 'symbol') return { t: 'p', k: 'sym', s: v.toString() };
    if (t === 'function') return { t: 'fn', s: v.name || 'anonymous' };
    if (v instanceof Date) return { t: 'p', k: 'str', s: isNaN(v) ? 'Invalid Date' : v.toISOString() };
    let id = ids.get(v); if (!id) { id = nextId++; ids.set(v, id); }
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    const kid = x => ser(x, ctx, depth + 1);
    try {
      if (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
        const items = []; const n = Math.min(v.length, MAX_ITEMS);
        for (let i = 0; i < n; i++) items.push(kid(v[i]));
        return { t: 'arr', id, len: v.length, items, more: v.length - n };
      }
      if (v instanceof Map) {
        const entries = []; let i = 0;
        for (const [k, val] of v) { if (i++ >= MAX_KEYS) break; entries.push([kid(k), kid(val)]); }
        return { t: 'map', id, entries, more: Math.max(0, v.size - MAX_KEYS) };
      }
      if (v instanceof Set) {
        const items = []; let i = 0;
        for (const x of v) { if (i++ >= MAX_ITEMS) break; items.push(kid(x)); }
        return { t: 'set', id, items, more: Math.max(0, v.size - MAX_ITEMS) };
      }
      const keys = Object.keys(v), entries = [];
      for (const k of keys.slice(0, MAX_KEYS)) { let val; try { val = v[k]; } catch (e) { val = '[getter threw]'; } entries.push([k, kid(val)]); }
      const ctor = v.constructor && v.constructor.name;
      return { t: 'obj', id, cls: ctor && ctor !== 'Object' ? ctor : '', entries, more: Math.max(0, keys.length - MAX_KEYS) };
    } catch (e) {
      return { t: 'p', k: 'str', s: '[unreadable]' };
    }
  }

  /**
   * Snapshot of the variables visible at one point. `entries` is [[name, thunk, scopeDepth], …]
   * as emitted by instrument.js; `fd` is the current function depth.
   */
  function capture(entries, fd) {
    const items = [];
    for (const [name, thunk, sfd] of entries) {
      let v;
      try { v = thunk(); } catch (e) { continue; }       // not initialised yet (TDZ)
      if (typeof v === 'function') continue;
      const scope = fd === 0 ? 'global' : (sfd === fd ? 'local' : (sfd === 0 ? 'global' : 'closure'));
      items.push({ name, scope, v });
    }
    items.sort((a, b) => (a.scope === 'local' ? 0 : 1) - (b.scope === 'local' ? 0 : 1));
    const ctx = { seen: new Set(), refs: new Set() };
    const vars = items.map(it => ({ name: it.name, scope: it.scope, node: ser(it.v, ctx, 0) }));
    return { vars, refs: [...ctx.refs] };
  }

  return { capture };
}
