/**
 * The part of the C++ standard library that algorithms use, on the interpreter's own memory (./interp.js), so that
 * pointers, references and iterators into it are checked like everything else:
 *   string, vector   a heap buffer that grows by doubling, as in libstdc++: &v[i] and v.begin() are plain pointers into
 *                    it, and when it reallocates the old buffer is gone (a stale pointer is caught and explained)
 *   map, set         sorted (unordered_ ones keep their insertion order), one block per element, so references stay valid
 *   queue, stack, deque, priority_queue   one block per element; priority_queue is a binary heap (max first, or min
 *                    with greater<>), shown in its heap order
 *   pair             a plain struct (types.js); function<…> holds anything callable; the std exceptions carry a message
 * Every container value lives in a cell of kind 'obj' whose v is one of the states below; copying a cell clones it.
 * makeStl(api) gets the interpreter functions it needs (memory, values, calls) and returns what the interpreter calls.
 */
let nextUid = 1;
/** The std exceptions (types.js EXCEPTION_BASE says which derives from which) */
export const EXCEPTIONS = new Set(['exception', 'runtime_error', 'logic_error', 'out_of_range', 'invalid_argument', 'length_error', 'overflow_error',
  'domain_error', 'range_error', 'underflow_error', 'bad_function_call']);

export function makeStl(api) {
  const { T, fail, typeName } = api;
  const art = t => { const n = typeName(t); return (/^[aeiou]/.test(n) ? 'an ' : 'a ') + n; };

  /* ---- the states ---- */
  class Seq {                                      // vector<T> and string: size elements in a buffer of cap
    constructor(t) {
      this.t = t; this.uid = nextUid++; this.string = t.name === 'string';
      this.elem = this.string ? T.char : t.args[0];
      this.data = null; this.size = 0; this.cap = 0; this.label = null;
    }
    get es() { return this.elem.size; }
    slot(k) { return { t: this.elem, b: this.data, o: k * this.es, d: (this.label || this.kind()) + '[' + k + ']' }; }
    kind() { return this.string ? 'string' : 'vector'; }
    /** Room for n elements: a new buffer (twice as big) when it is full; the old one is gone */
    reserve(n, why) {
      if (n <= this.cap && this.data) return;
      const cap = Math.max(n, this.cap * 2, this.string ? 15 : 1);
      const b = api.alloc('heap', cap * this.es + (this.string ? 1 : 0), null, (this.label || this.kind()) + "'s buffer");
      b.owner = this; b.line = api.line();
      if (this.data) {
        if (this.size) api.copyMem(b, 0, this.data, 0, this.size * this.es, this.label || 'the ' + this.kind(), true);
        Object.assign(this.data, { freed: true, freedLine: api.line(), realloc: { name: this.label || 'the ' + this.kind(), why } });
      }
      this.data = b; this.cap = cap;
      if (this.string) this.terminate();
    }
    terminate() { api.store(this.data, this.size, T.char, 0, 'the string'); }
    clone() {
      const c = new Seq(this.t);
      if (this.size) { c.reserve(this.size); api.copyMem(c.data, 0, this.data, 0, this.size * this.es, 'the copy'); }
      c.size = this.size;
      if (c.string) { if (!c.data) c.reserve(0); c.terminate(); }
      return c;
    }
    destroy() {
      if (!this.data) return;
      for (let k = 0; k < this.size; k++) api.destroyAt(this.data, k * this.es, this.elem);
      Object.assign(this.data, { freed: true, freedLine: api.line(), gone: (this.label || 'the ' + this.kind()) + ' no longer exists' });
    }
    text() { const out = []; for (let k = 0; k < this.size; k++) out.push(api.load(this.data, k, T.char, 'the string') & 255); return new TextDecoder().decode(new Uint8Array(out)); }
  }
  /** map, set and their unordered and multi kinds: entries, each in its own block (a pair for a map) */
  class Assoc {
    constructor(t) {
      this.t = t; this.uid = nextUid++; this.label = null;
      this.isMap = t.name.includes('map'); this.sorted = !t.name.startsWith('unordered'); this.multi = t.name.startsWith('multi');
      this.key = t.args[0]; this.elem = this.isMap ? api.stlType('pair', [t.args[0], t.args[1]]) : t.args[0];
      this.entries = [];                           // blocks, in order
    }
    keyLv(b) { return { t: this.key, b, o: 0, d: 'a key' }; }
    /** The index of the entry with this key (lv), or ~insertAt */
    find(lv) {
      if (!this.sorted) {
        for (let k = 0; k < this.entries.length; k++) if (api.equal(this.key, this.keyLv(this.entries[k]), lv)) return k;
        return ~this.entries.length;
      }
      let lo = 0, hi = this.entries.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (api.less(this.key, this.keyLv(this.entries[mid]), lv)) lo = mid + 1; else hi = mid; }
      if (lo < this.entries.length && !api.less(this.key, lv, this.keyLv(this.entries[lo]))) {
        if (this.multi) { let k = lo; while (k < this.entries.length && !api.less(this.key, lv, this.keyLv(this.entries[k]))) k++; return ~k; }
        return lo;
      }
      return ~lo;
    }
    /** A new entry at position k; fill(b) gives it its value */
    insertAt(k, fill) {
      const b = api.alloc('heap', this.elem.size, this.elem, (this.label || this.t.name) + ' entry');
      b.owner = this; b.line = api.line();
      fill(b);
      this.entries.splice(k, 0, b);
      return b;
    }
    erase(k) {
      const [b] = this.entries.splice(k, 1);
      api.destroyAt(b, 0, this.elem);
      Object.assign(b, { freed: true, freedLine: api.line(), gone: 'it was erased from ' + (this.label || 'the ' + this.t.name) });
    }
    clone() {
      const c = new Assoc(this.t);
      for (const b of this.entries) c.insertAt(c.entries.length, nb => api.copyMem(nb, 0, b, 0, this.elem.size, 'the copy'));
      return c;
    }
    destroy() { while (this.entries.length) this.erase(this.entries.length - 1); }
  }
  /** queue, stack, deque, priority_queue: elements in blocks, front (or bottom) first; a priority_queue is a heap */
  class Line {
    constructor(t) {
      this.t = t; this.uid = nextUid++; this.label = null; this.elem = t.args[0]; this.items = [];
      this.heap = t.name === 'priority_queue';
      const cmp = t.args[1];                       // greater<…> makes a min-heap
      this.min = !!cmp && cmp.k === 'stl' && cmp.name === 'greater';
      this.cmpType = cmp && cmp.k === 'struct' ? cmp : null;   // a struct with bool operator()(a, b)
    }
    lv(b) { return { t: this.elem, b, o: 0, d: 'an element' }; }
    /** a comes out after b (a has the lower priority) */
    below(a, b) {
      if (this.cmpType) return api.callFunctor(this.cmpType, this.lv(a), this.lv(b));
      return this.min ? api.less(this.elem, this.lv(b), this.lv(a)) : api.less(this.elem, this.lv(a), this.lv(b));
    }
    push(fill) {
      const b = api.alloc('heap', this.elem.size, this.elem, (this.label || this.t.name) + ' element');
      b.owner = this; b.line = api.line();
      fill(b);
      this.items.push(b);
      if (this.heap) { let k = this.items.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (!this.below(this.items[p], this.items[k])) break; [this.items[p], this.items[k]] = [this.items[k], this.items[p]]; k = p; } }
    }
    remove(k) {
      const [b] = this.items.splice(k, 1);
      api.destroyAt(b, 0, this.elem);
      Object.assign(b, { freed: true, freedLine: api.line(), gone: 'it was removed from ' + (this.label || 'the ' + this.t.name) });
    }
    popHeap() {
      const it = this.items, last = it.length - 1;
      [it[0], it[last]] = [it[last], it[0]];
      this.remove(last);
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < it.length && this.below(it[m], it[l])) m = l;
        if (r < it.length && this.below(it[m], it[r])) m = r;
        if (m === k) break;
        [it[m], it[k]] = [it[k], it[m]]; k = m;
      }
    }
    clone() { const c = new Line(this.t); c.items = this.items.map(b => { const nb = api.alloc('heap', this.elem.size, this.elem, b.name); nb.owner = c; api.copyMem(nb, 0, b, 0, this.elem.size, 'the copy'); return nb; }); return c; }
    destroy() { while (this.items.length) this.remove(this.items.length - 1); }
  }
  class Fn {                                       // function<R(A…)>: anything callable, or empty
    constructor(t) { this.t = t; this.uid = nextUid++; this.callable = null; }
    clone() { const c = new Fn(this.t); c.callable = this.callable; return c; }
    destroy() {}
  }
  class Exc {                                      // runtime_error("…") and the other std exceptions
    constructor(t) { this.t = t; this.uid = nextUid++; this.msg = ''; this.whatBlock = null; }
    clone() { const c = new Exc(this.t); c.msg = this.msg; return c; }
    destroy() {}
  }
  class Stream {                                   // cout, cerr: where output goes, and how numbers are written
    constructor(t, err) { this.t = t; this.uid = nextUid++; this.err = err; this.precision = 6; this.fixed = false; this.boolalpha = false; this.width = 0; this.fill = ' '; }
    clone() { return this; }
    destroy() {}
  }
  const STATES = { string: Seq, vector: Seq, map: Assoc, set: Assoc, unordered_map: Assoc, unordered_set: Assoc, multimap: Assoc, multiset: Assoc,
    queue: Line, stack: Line, deque: Line, priority_queue: Line, function: Fn };

  /** A new, empty value of a library type (what `vector<int> v;` makes) */
  function create(t) {
    if (STATES[t.name]) return new STATES[t.name](t);
    if (t.name === 'ostream') return new Stream(t, false);
    if (t.name === 'greater' || t.name === 'less') return { uid: nextUid++, t, clone() { return this; }, destroy() {} };
    if (EXCEPTIONS.has(t.name)) return new Exc(t);
    fail(typeName(t) + ' cannot be made here');
  }
  const isSeq = s => s instanceof Seq, isAssoc = s => s instanceof Assoc, isLine = s => s instanceof Line;

  /* ---- making one: vector<int> v(5, 0), v{1, 2, 3}, string s(3, 'a'), map<…> m = {{…}, …} ---- */
  /** state is new and empty; args: argument expressions (constructor syntax) or the items of a { … } list */
  function construct(state, args, list, d) {
    if (isSeq(state)) {
      if (list) { if (args.length) state.reserve(args.length); for (const it of args) pushNode(state, it, d); return; }   // exactly as big as the list, as in libstdc++
      if (!args.length) { if (state.string) state.reserve(0); return; }
      const a0 = api.rval(args[0]);
      if (state.string && a0.t.k === 'ptr') { appendText(state, api.cstr(a0.v, d), d); return; }
      if (state.string && a0.t.k === 'stl') { appendText(state, textOf(a0), d); return; }
      if (a0.t.k === 'stl' && a0.t === state.t) { copyInto(state, stateOf(a0)); return; }
      if (a0.t.k === 'ptr' && args.length === 2) {   // vector<int> v(a, a + n): a range
        const end = api.rval(args[1]);
        const n = rangeLen(a0, end, d);
        for (let k = 0; k < n; k++) pushLv(state, { t: state.elem, b: a0.v.b, o: a0.v.o + k * state.es, d });
        return;
      }
      if (a0.t.k !== 'int') fail(`${d}: the size of ${art(state.t)} must be a number, not ${art(a0.t)}`);
      const n = Number(a0.v);
      if (n < 0) fail(`${d}: a size cannot be negative (${n})`);
      if (n > 1e6) fail(`${d}: ${n} elements is more than this page can show`);
      state.reserve(n);
      const fillV = args[1] ? api.rval(args[1]) : null;
      for (let k = 0; k < n; k++) { const s = state.slot(k); if (fillV) api.place(s, fillV, d); else api.construct(s.b, s.o, state.elem, [], d); }
      state.size = n;
      if (state.string) state.terminate();
      return;
    }
    if (isAssoc(state)) {
      if (list) { for (const it of args) insertNode(state, it, d); return; }
      if (args.length) { const a0 = api.rval(args[0]); if (a0.t === state.t) { for (const b of stateOf(a0).entries) insertLv(state, { t: state.elem, b, o: 0 }); return; } }
      if (args.length) fail(`${d}: ${typeName(state.t)} is made empty, or from { … } or another ${state.t.name}`);
      return;
    }
    if (isLine(state)) {
      if (list) { for (const it of args) state.push(b => api.initialize(b, 0, state.elem, it, d)); return; }
      if (args.length) { const a0 = api.rval(args[0]); if (a0.t === state.t) { for (const b of stateOf(a0).items) state.push(nb => api.copyMem(nb, 0, b, 0, state.elem.size, d)); return; } }
      return;
    }
    if (state instanceof Fn) { if (args.length) assignFn(state, api.rval(args[0]), d); return; }
    if (state instanceof Exc) {
      if (args.length) { const m = api.rval(args[0]); state.msg = m.t.k === 'ptr' ? api.cstr(m.v, d) : textOf(m); }
      return;
    }
  }
  const assignFn = (state, x, d) => {
    if (x.t.k === 'lambda' || (x.t.k === 'ptr' && x.t.to.k === 'fn') || x.v instanceof api.FnRef) state.callable = x;
    else if (x.t.k === 'stl' && x.t.name === 'function') state.callable = stateOf(x).callable;
    else if (x.t.k === 'int' && x.v == 0) state.callable = null; // eslint-disable-line eqeqeq
    else fail(`${d}: ${art(x.t)} cannot be stored in ${art(state.t)}`);
  };
  const copyInto = (dst, src) => {
    if (src.size) { dst.reserve(src.size); api.copyMem(dst.data, 0, src.data, 0, src.size * src.es, 'the copy'); }
    dst.size = src.size;
    if (dst.string) { if (!dst.data) dst.reserve(0); dst.terminate(); }
  };
  /** The state held by a value of a library type (its location) */
  const stateOf = x => api.stateAt(x.v.b, x.v.o);
  const textOf = x => {
    if (x.t.k === 'ptr') return api.cstr(x.v, 'the string');
    if (x.t.k === 'stl' && x.t.name === 'string') return stateOf(x).text();
    if (x.t.k === 'int' && api.isCharT(x.t)) return String.fromCharCode(Number(x.v) & 255);
    fail(`${art(x.t)} is not a string`);
  };
  const appendText = (s, text, d) => {
    const bytes = new TextEncoder().encode(text);
    s.reserve(s.size + bytes.length, 'the string grew');
    bytes.forEach((c, k) => api.store(s.data, s.size + k, T.char, c > 127 ? c - 256 : c, d));
    s.size += bytes.length;
    s.terminate();
  };
  const rangeLen = (a, b, d) => {
    if (a.v === null || b.v === null || a.v.b !== b.v.b) fail(`${d}: the two iterators are not into the same array or vector`);
    const n = (b.v.o - a.v.o) / (a.t.to.size || 1);
    if (n < 0) fail(`${d}: the range ends before it begins`);
    return n;
  };

  /* ---- adding elements ---- */
  function pushNode(s, node, d) {
    s.reserve(s.size + 1, 'push_back on line ' + api.line());
    const slot = s.slot(s.size);
    api.initialize(slot.b, slot.o, s.elem, node, d);
    s.size++;
    if (s.string) s.terminate();
  }
  function pushLv(s, lv) {
    s.reserve(s.size + 1, 'push_back on line ' + api.line());
    const slot = s.slot(s.size);
    api.place(slot, api.loadLv(lv), slot.d);
    s.size++;
    if (s.string) s.terminate();
  }
  /** m.insert({k, v}), s.insert(x): adds it unless the key is there (multi kinds always add) */
  function insertNode(st, node, d) {
    const tmp = api.temp(st.elem, node, d);
    return insertLv(st, tmp);
  }
  function insertLv(st, lv) {
    const k = st.find(st.isMap ? { ...lv, t: st.key } : { ...lv, t: st.key });
    if (k >= 0) return { b: st.entries[k], added: false };
    const b = st.insertAt(~k, nb => api.copyMem(nb, 0, lv.b, lv.o, st.elem.size, 'the inserted value'));
    return { b, added: true };
  }
  /** m[k]: the value for key k, added (value-initialized) if missing */
  function mapSlot(st, keyNode, d, create = true) {
    const key = api.temp(st.key, keyNode, d);
    let k = st.find(key);
    if (k < 0) {
      if (!create) return null;
      k = ~k;
      st.insertAt(k, b => { api.copyMem(b, 0, key.b, key.o, st.key.size, d); const f = st.elem.fields[1]; api.construct(b, f.off, f.type, [], d); });
    }
    const b = st.entries[k], f = st.elem.fields[1];
    return { t: f.type, b, o: f.off, d: (st.label || 'm') + '[' + keyText(st.key, key) + ']' };
  }
  const keyText = (t, lv) => api.brief(lv.b, t, lv.o);

  /* ---- iterators of map, set: { it, st, b } (b: the entry, null at end) ---- */
  const ITER = new Map();
  const iterType = t => { let it = ITER.get(t); if (!it) { it = { k: 'iter', of: t, size: 8, name: typeName(t) + '::iterator' }; ITER.set(t, it); } return it; };
  const iter = (st, b) => api.val(iterType(st.t), { it: true, st, b });
  const iterAt = (st, k) => iter(st, k < st.entries.length ? st.entries[k] : null);

  /* ---- the methods ---- */
  const need = (args, n, name, d) => { if (args.length < n[0] || args.length > n[1]) fail(`${d}: ${name}() takes ${n[0] === n[1] ? n[0] : n[0] + ' or ' + n[1]} argument${n[1] === 1 ? '' : 's'}, not ${args.length}`); };
  const int = (node, d) => { const x = api.rval(node); if (x.t.k !== 'int') fail(`${d}: an index must be an integer, not ${art(x.t)}`); return Number(x.v); };
  const sz = n => api.val(T.ulong, BigInt(n));
  const vptr = (s, k) => api.val(api.ptr(s.elem), s.data ? new api.Ptr(s.data, k * s.es) : null);
  const empty = (what, st, d) => fail(`${d}: ${st.label || 'the ' + st.t.name} is empty, so there is no element to ${/pop/.test(what) ? 'remove' : 'read'}`);
  /** The index an iterator (a pointer into the buffer) points at */
  const posOf = (s, x, d) => {
    if (x.t.k !== 'ptr' || !x.v || x.v.b !== s.data) fail(`${d}: the iterator is not into ${s.label || 'this ' + s.kind()}`);
    return x.v.o / s.es;
  };

  function call(x, name, args, e) {
    const st = stateOf(x), d = api.text(e);
    if (isSeq(st)) return seqCall(st, name, args, d, e);
    if (isAssoc(st)) return assocCall(st, name, args, d);
    if (isLine(st)) return lineCall(st, name, args, d);
    if (st instanceof Exc && name === 'what') {
      if (!st.whatBlock) st.whatBlock = api.literalOf(st.msg);
      return api.val(api.ptr(T.char), new api.Ptr(st.whatBlock, 0));
    }
    if (st instanceof Fn && name === 'operator()') return null;
    fail(`${typeName(st.t)} has no method ${name}()`);
  }
  function seqCall(s, name, args, d, e) {
    const S = s.string;
    switch (name) {
      case 'size': case 'length': need(args, [0, 0], name, d); return sz(s.size);
      case 'empty': need(args, [0, 0], name, d); return api.val(T.bool, s.size ? 0 : 1);
      case 'capacity': return sz(s.cap);
      case 'push_back': case 'emplace_back':
        need(args, name === 'push_back' ? [1, 1] : [0, 9], name, d);
        if (name === 'emplace_back' && (args.length !== 1 || s.elem.k === 'struct')) {   // v.emplace_back(1, 2): a new element from these arguments
          s.reserve(s.size + 1, 'emplace_back on line ' + api.line());
          const slot = s.slot(s.size); api.construct(slot.b, slot.o, s.elem, args, d); s.size++;
        } else pushNode(s, args[0], d);
        return api.val(T.void, undefined);
      case 'pop_back':
        if (!s.size) empty('pop_back()', s, d);
        api.destroyAt(s.data, (s.size - 1) * s.es, s.elem); s.size--;
        if (S) s.terminate();
        return api.val(T.void, undefined);
      case 'back': case 'front':
        if (!s.size) empty(name + '()', s, d);
        return api.lvVal(s.slot(name === 'back' ? s.size - 1 : 0));
      case 'at': {
        const k = int(args[0], d);
        if (k < 0 || k >= s.size) api.throwStd('out_of_range', `${s.kind()}::at: ${s.label || 'the ' + s.kind()}.at(${k}) is out of range (its size is ${s.size})`);
        return api.lvVal(s.slot(k));
      }
      case 'clear': for (let k = 0; k < s.size; k++) api.destroyAt(s.data, k * s.es, s.elem); s.size = 0; if (S && s.data) s.terminate(); return api.val(T.void, undefined);
      case 'resize': {
        const n = int(args[0], d), fillV = args[1] ? api.rval(args[1]) : null;
        if (n < 0) fail(`${d}: a size cannot be negative`);
        if (n > s.size) { s.reserve(n, 'resize on line ' + api.line()); for (let k = s.size; k < n; k++) { const sl = s.slot(k); if (fillV) api.place(sl, fillV, d); else api.construct(sl.b, sl.o, s.elem, [], d); } }
        else for (let k = n; k < s.size; k++) api.destroyAt(s.data, k * s.es, s.elem);
        s.size = n;
        if (S) s.terminate();
        return api.val(T.void, undefined);
      }
      case 'reserve': s.reserve(int(args[0], d), 'reserve on line ' + api.line()); return api.val(T.void, undefined);
      case 'begin': case 'data': if (!s.data && S) s.reserve(0); return vptr(s, 0);
      case 'end': return vptr(s, s.size);
      case 'rbegin': case 'rend': fail(`${d}: reverse iterators are not supported (use reverse(v.begin(), v.end()) or a loop from the back)`);
      // falls through
      case 'c_str': if (!S) break; if (!s.data) s.reserve(0); return api.val(api.ptr(T.char), new api.Ptr(s.data, 0));
      case 'insert': case 'erase': {
        if (S && args.length && api.rval(args[0]).t.k === 'int') {   // s.erase(pos, n), s.insert(pos, text)
          const pos = int(args[0], d), text = s.text();
          if (pos > s.size) api.throwStd('out_of_range', `basic_string::${name}: position ${pos} is past the end (size ${s.size})`);
          const out = name === 'erase' ? text.slice(0, pos) + (args[1] ? text.slice(pos + int(args[1], d)) : '') : text.slice(0, pos) + textOf(api.rval(args[1])) + text.slice(pos);
          setText(s, out, d); return api.val(T.void, undefined);
        }
        const at = posOf(s, api.rval(args[0]), d);
        if (name === 'erase') {
          const end = args[1] ? posOf(s, api.rval(args[1]), d) : at + 1;
          if (at < 0 || end > s.size || at > end) fail(`${d}: the iterator is outside ${s.label || 'the ' + s.kind()}`);
          const n = end - at;
          for (let k = at; k < end; k++) api.destroyAt(s.data, k * s.es, s.elem);
          if (end < s.size) api.copyMem(s.data, at * s.es, s.data, end * s.es, (s.size - end) * s.es, d, true);
          s.size -= n;
          if (S) s.terminate();
          return vptr(s, at);
        }
        if (at < 0 || at > s.size) fail(`${d}: the iterator is outside ${s.label || 'the ' + s.kind()}`);
        const tmp = api.temp(s.elem, args[1], d);
        s.reserve(s.size + 1, 'insert on line ' + api.line());
        if (at < s.size) api.copyMem(s.data, (at + 1) * s.es, s.data, at * s.es, (s.size - at) * s.es, d, true);
        api.place(s.slot(at), api.loadLv(tmp), d);
        s.size++;
        if (S) s.terminate();
        return vptr(s, at);
      }
      case 'swap': { const o = stateOf(api.rval(args[0])); for (const k of ['data', 'size', 'cap']) [s[k], o[k]] = [o[k], s[k]]; if (s.data) s.data.owner = s; if (o.data) o.data.owner = o; return api.val(T.void, undefined); }
      case 'assign': { const n = int(args[0], d), v = api.rval(args[1]); for (let k = 0; k < s.size; k++) api.destroyAt(s.data, k * s.es, s.elem); s.size = 0; s.reserve(n); for (let k = 0; k < n; k++) api.place(s.slot(k), v, d); s.size = n; return api.val(T.void, undefined); }
    }
    if (S) {
      switch (name) {
        case 'substr': {
          const text = s.text(), pos = args[0] ? int(args[0], d) : 0, n = args[1] ? int(args[1], d) : Infinity;
          if (pos > text.length) api.throwStd('out_of_range', `basic_string::substr: pos ${pos} is past the end (size ${text.length})`);
          return api.makeString(text.substr(pos, n));
        }
        case 'find': case 'rfind': {
          const text = s.text(), what = textOf(api.rval(args[0])), from = args[1] ? int(args[1], d) : undefined;
          const k = name === 'find' ? text.indexOf(what, from) : text.lastIndexOf(what, from);
          return sz(k < 0 ? 18446744073709551615n : k);
        }
        case 'append': appendText(s, textOf(api.rval(args[0])), d); return api.lvVal({ t: s.t, b: null });
        case 'compare': { const a = s.text(), b = textOf(api.rval(args[0])); return api.val(T.int, a < b ? -1 : a > b ? 1 : 0); }
      }
    }
    void e;
    fail(`${d}: ${typeName(s.t)} has no method ${name}()` + (name === 'push' ? ' (a vector uses push_back)' : name === 'length' ? ' (use size())' : ''));
  }
  const setText = (s, text, d) => { for (let k = 0; k < s.size; k++) api.destroyAt(s.data, k, T.char); s.size = 0; appendText(s, text, d); };
  function assocCall(st, name, args, d) {
    switch (name) {
      case 'size': return sz(st.entries.length);
      case 'empty': return api.val(T.bool, st.entries.length ? 0 : 1);
      case 'clear': st.destroy(); return api.val(T.void, undefined);
      case 'count': case 'contains': { const k = st.find(api.temp(st.key, args[0], d)); return name === 'contains' ? api.val(T.bool, k >= 0 ? 1 : 0) : sz(k >= 0 ? (st.multi ? countEq(st, k) : 1) : 0); }
      case 'find': { const k = st.find(api.temp(st.key, args[0], d)); return k >= 0 ? iterAt(st, k) : iter(st, null); }
      case 'insert': case 'emplace': {
        let r;
        if (name === 'emplace' && args.length === 2 && st.isMap) {   // m.emplace(k, v)
          const tmp = api.tempOf(st.elem, d); api.initialize(tmp.b, tmp.o + st.elem.fields[0].off, st.key, args[0], d); api.initialize(tmp.b, tmp.o + st.elem.fields[1].off, st.elem.fields[1].type, args[1], d);
          r = insertLv(st, tmp);
        } else r = insertNode(st, args[0], d);
        return api.makePair(iter(st, r.b), api.val(T.bool, r.added ? 1 : 0));
      }
      case 'erase': {
        const a = args[0], x = api.rval(a);
        if (x.t.k === 'iter') { if (!x.v.b) fail(`${d}: erasing end() (there is no element there)`); const k = st.entries.indexOf(x.v.b); st.erase(k); return iterAt(st, k); }
        const k = st.find(api.temp(st.key, a, d));
        if (k < 0) return sz(0);
        st.erase(k);
        return sz(1);
      }
      case 'at': { const slot = mapSlot(st, args[0], d, false); if (!slot) api.throwStd('out_of_range', `map::at: there is no key ${keyText(st.key, api.temp(st.key, args[0], d))} in ${st.label || 'the map'}`); return api.lvVal(slot); }
      case 'begin': return iterAt(st, 0);
      case 'end': return iter(st, null);
      case 'lower_bound': case 'upper_bound': {
        const key = api.temp(st.key, args[0], d);
        let k = 0;
        while (k < st.entries.length && (name === 'lower_bound' ? api.less(st.key, st.keyLv(st.entries[k]), key) : !api.less(st.key, key, st.keyLv(st.entries[k])))) k++;
        return iterAt(st, k);
      }
    }
    fail(`${d}: ${typeName(st.t)} has no method ${name}()` + (name === 'push_back' ? ' (a set or map uses insert)' : ''));
  }
  const countEq = (st, k) => { let n = 0; for (let j = k; j < st.entries.length && !api.less(st.key, st.keyLv(st.entries[k]), st.keyLv(st.entries[j])); j++) n++; return n; };
  function lineCall(st, name, args, d) {
    const n = st.items.length, kind = st.t.name;
    const top = () => { if (!n) empty(name + '()', st, d); };
    switch (name) {
      case 'size': return sz(n);
      case 'empty': return api.val(T.bool, n ? 0 : 1);
      case 'push': case 'push_back': case 'push_front': case 'emplace': case 'emplace_back': {
        if ((name === 'push_back' || name === 'push_front') && kind !== 'deque') break;
        const front = name === 'push_front';
        if (name.startsWith('emplace') && (args.length !== 1 || st.elem.k === 'struct')) st.push(b => api.construct(b, 0, st.elem, args, d));
        else st.push(b => api.initialize(b, 0, st.elem, args[0], d));
        if (front) st.items.unshift(st.items.pop());
        return api.val(T.void, undefined);
      }
      case 'pop': case 'pop_front': case 'pop_back':
        top();
        if (st.heap) st.popHeap();
        else st.remove(kind === 'stack' || name === 'pop_back' ? n - 1 : 0);
        return api.val(T.void, undefined);
      case 'top': top(); if (kind === 'queue') break; return api.lvVal(st.lv(st.items[kind === 'stack' ? n - 1 : 0]));
      case 'front': top(); if (kind === 'stack' || st.heap) break; return api.lvVal(st.lv(st.items[0]));
      case 'back': top(); if (kind === 'stack' || st.heap) break; return api.lvVal(st.lv(st.items[n - 1]));
      case 'clear': if (kind !== 'deque') break; st.destroy(); return api.val(T.void, undefined);
    }
    if (kind === 'deque' && (name === 'at' || name === 'operator[]')) return null;
    fail(`${d}: ${kind} has no method ${name}()` + (kind === 'queue' && name === 'top' ? ' (a queue has front())' : kind === 'stack' && name === 'front' ? ' (a stack has top())' : ''));
  }

  /** v[i], s[i], m[k], d[i] */
  function index(x, node, d) {
    const st = stateOf(x);
    if (isSeq(st)) {
      const k = int(node, d);
      if (k < 0 || k >= st.size + (st.string ? 1 : 0))
        fail(`${st.label || 'the ' + st.kind()}[${k}] is out of range: ${st.label || 'it'} has ${st.size} element${st.size === 1 ? '' : 's'}` + (st.size ? ` (indexes 0 to ${st.size - 1})` : ''));
      return st.slot(k);
    }
    if (isAssoc(st) && st.isMap && st.sorted !== null) return mapSlot(st, node, d);
    if (isLine(st) && st.t.name === 'deque') { const k = int(node, d); if (k < 0 || k >= st.items.length) fail(`${st.label}[${k}] is out of range: it has ${st.items.length} elements`); return st.lv(st.items[k]); }
    fail(`${d}: ${typeName(st.t)} cannot be indexed with [ ]`);
  }

  /** *it and it->… for an iterator of a map or set */
  function derefIter(x, d) {
    if (!x.v.b) fail(`${d}: the iterator is at end(): it points past the last element`);
    if (x.v.b.freed) fail(`${d}: the element this iterator pointed to was erased on line ${x.v.b.freedLine}`);
    return { t: x.v.st.elem, b: x.v.b, o: 0, d };
  }
  function stepIter(x, by, d) {
    const st = x.v.st;
    let k = x.v.b ? st.entries.indexOf(x.v.b) : st.entries.length;
    if (k < 0) fail(`${d}: the element this iterator pointed to was erased`);
    k += by;
    if (k < 0 || k > st.entries.length) fail(`${d}: moved past the ${k < 0 ? 'beginning' : 'end'} of ${st.label || 'the ' + st.t.name}`);
    return iterAt(st, k);
  }
  const sameIter = (a, b) => a.v.st === b.v.st && a.v.b === b.v.b;

  /** The elements a range-for visits: places (lvalues) */
  function elements(x, d) {
    const st = stateOf(x);
    if (isSeq(st)) { const out = []; for (let k = 0; k < st.size; k++) out.push(st.slot(k)); return out; }
    if (isAssoc(st)) return st.entries.map(b => ({ t: st.elem, b, o: 0, d: (st.label || 'm') + ' entry' }));
    if (isLine(st)) fail(`${d}: a ${st.t.name} cannot be looped over (take its elements with front()/top() and pop())`);
    fail(`${d}: ${art(st.t)} cannot be looped over`);
  }

  /* ---- comparing (==, <) ---- */
  function compare(op, a, b, d) {
    const sa = stateOf(a);
    if (isSeq(sa) && sa.string) {
      const x = sa.text(), y = textOf(b);
      return { '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
    }
    if (b.t !== a.t) fail(`${d}: ${art(a.t)} cannot be compared with ${art(b.t)}`);
    const sb = stateOf(b);
    const la = isSeq(sa) ? [...Array(sa.size).keys()].map(k => sa.slot(k)) : isAssoc(sa) ? sa.entries.map(e => ({ t: sa.elem, b: e, o: 0 })) : sa.items.map(e => sa.lv(e));
    const lb = isSeq(sb) ? [...Array(sb.size).keys()].map(k => sb.slot(k)) : isAssoc(sb) ? sb.entries.map(e => ({ t: sb.elem, b: e, o: 0 })) : sb.items.map(e => sb.lv(e));
    const el = sa.elem;
    if (op === '==' || op === '!=') { const eq = la.length === lb.length && la.every((x, k) => api.equal(el, x, lb[k])); return op === '==' ? eq : !eq; }
    let c = 0;
    for (let k = 0; k < Math.min(la.length, lb.length) && !c; k++) c = api.less(el, la[k], lb[k]) ? -1 : api.less(el, lb[k], la[k]) ? 1 : 0;
    if (!c) c = la.length < lb.length ? -1 : la.length > lb.length ? 1 : 0;
    return { '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
  }

  /* ---- the views ---- */
  /** Names each container after where it is (v, g[1], m["a"]) for the views and messages; returns nothing */
  function label(b, o, t, name, depth = 0) {
    if (depth > 4) return;
    if (t.k === 'stl') {
      const st = api.stateAt(b, o);
      if (!st || !st.uid) return;
      st.label = name;
      if (isSeq(st) && !st.string && (st.elem.k === 'stl' || st.elem.k === 'struct')) for (let k = 0; k < Math.min(st.size, 60); k++) label(st.data, k * st.es, st.elem, name + '[' + k + ']', depth + 1);
      return;
    }
    if (t.k === 'struct') for (const f of t.fields) label(b, o + f.off, f.type, name + '.' + f.name, depth + 1);
    else if (t.k === 'arr' && (t.of.k === 'stl' || t.of.k === 'struct')) for (let k = 0; k < Math.min(t.n, 60); k++) label(b, o + k * t.of.size, t.of, name + '[' + k + ']', depth + 1);
  }
  /** The snapshot node of a container (see src/model.js) */
  function ser(st, ctx, depth, serAt) {
    const id = api.idOf('S' + st.uid);
    if (st instanceof Seq && st.string) return { t: 'p', k: 'str', s: JSON.stringify(clip(st.text())) };
    if (st instanceof Fn) return { t: 'fn', s: st.callable ? (st.callable.v && st.callable.v.name) || 'lambda' : 'empty' };
    if (st instanceof Exc) return { t: 'obj', id, cls: st.t.name, entries: [['what', { t: 'p', k: 'str', s: JSON.stringify(clip(st.msg)) }]], more: 0 };
    if (st instanceof Stream || !(isSeq(st) || isAssoc(st) || isLine(st))) return { t: 'p', k: 'sym', s: typeName(st.t) };
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= 5) return { t: 'trunc', id };
    const tn = typeName(st.t);
    if (isSeq(st)) {
      const n = Math.min(st.size, 60), items = [];
      for (let k = 0; k < n; k++) items.push(serAt(st.data, k * st.es, st.elem, ctx, depth + 1));
      return { t: 'arr', id, len: st.size, items, more: st.size - n, tn };
    }
    if (isAssoc(st)) {
      const n = Math.min(st.entries.length, 30);
      if (!st.isMap) return { t: 'set', id, items: st.entries.slice(0, n).map(b => serAt(b, 0, st.elem, ctx, depth + 1)), more: st.entries.length - n, cls: tn };
      const [kf, vf] = st.elem.fields;
      return { t: 'map', id, entries: st.entries.slice(0, n).map(b => [serAt(b, kf.off, kf.type, ctx, depth + 1), serAt(b, vf.off, vf.type, ctx, depth + 1)]), more: st.entries.length - n, cls: tn };
    }
    const n = Math.min(st.items.length, 60);
    return { t: 'arr', id, len: st.items.length, items: st.items.slice(0, n).map(b => serAt(b, 0, st.elem, ctx, depth + 1)), more: st.items.length - n, tn };
  }
  const clip = s => (s.length > 80 ? s.slice(0, 80) + '…' : s);
  /** One-line value for the call stack */
  function brief(st) {
    if (st instanceof Seq && st.string) { const s = st.text(); return JSON.stringify(s.length > 14 ? s.slice(0, 14) + '…' : s); }
    if (st instanceof Seq) return (st.label || st.kind()) + '(' + st.size + ')';
    if (isAssoc(st)) return (st.label || st.t.name) + '(' + st.entries.length + ')';
    if (isLine(st)) return (st.label || st.t.name) + '(' + st.items.length + ')';
    return typeName(st.t);
  }
  const iterText = x => (x.v.b ? '→ ' + api.brief(x.v.b, x.v.st.elem, 0) : (x.v.st.label || 'it') + '.end()');

  return { create, construct, call, index, derefIter, stepIter, sameIter, iterType, elements, compare, label, ser, brief, iterText,
    assignFn, textOf, appendText, stateOf, isSeq, Stream };
}
