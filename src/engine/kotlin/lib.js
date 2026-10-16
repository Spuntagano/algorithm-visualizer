/**
 * The part of Kotlin's library (and the JVM's under it) that algorithms use, with the JVM's own behaviour where a
 * program can see it: mutableMapOf() and setOf() keep insertion order (LinkedHashMap), hashMapOf() and HashSet iterate
 * in Java's bucket order (sized as Kotlin sizes them), java.util.PriorityQueue keeps Java's heap order, Random(42) is
 * Kotlin's XorWow generator, "%.2f".format rounds half up like Java's Formatter, sorting is stable, and changing a
 * list inside its for loop is a ConcurrentModificationException.
 * makeLib(api) gets the interpreter's helpers (./interp.js) and returns what it calls.
 */
import { javaDouble } from '../java/values.js';

export function makeLib(api) {
  const { D, KC, KCH, KObj, KArr, KFn, UNIT, fail, throwKt, npe, write, toStr, equals, hashOf, compare, callFn, ktType, kindOf, idOf, identityHash, newExc } = api;
  const isInt = v => typeof v === 'number';
  const num = v => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v instanceof D ? v.v : v instanceof KC ? v.c : fail(`a number is needed, not '${ktType(v)}'.`));

  /* ---- the collections ---- */
  class KList { constructor(kind, a = [], mutable = true) { this.kind = kind; this.a = a; this.mutable = mutable; this.mod = 0; } }
  /** LinkedHashMap, HashMap (Java's bucket order), TreeMap */
  class KMap {
    constructor(kind, cap = 16, cmp = null, mutable = true) { this.kind = kind; this.e = []; this.cap = tableSize(cap); this.cmp = cmp; this.seq = 0; this.mutable = mutable; this.mod = 0; this.lookup = new Map(); }
    key(k) { return keyStr(k); }
    find(k) {
      if (this.kind === 'TreeMap') { let lo = 0, hi = this.e.length; while (lo < hi) { const m = (lo + hi) >> 1, c = (this.cmp || compare)(this.e[m].k, k); if (c < 0) lo = m + 1; else if (c > 0) hi = m; else return { at: m, hit: true }; } return { at: lo, hit: false }; }
      const ks = this.key(k);
      if (typeof ks === 'string') { const en = this.lookup.get(ks); return en ? { en, hit: true } : { hit: false }; }
      for (const en of this.e) if (en.h === ks.h && equals(en.k, k)) return { en, hit: true };
      return { hit: false };
    }
    get(k) { const f = this.find(k); return f.hit ? (this.kind === 'TreeMap' ? this.e[f.at] : f.en) : null; }
    put(k, v) {
      const f = this.find(k);
      if (f.hit) { const en = this.kind === 'TreeMap' ? this.e[f.at] : f.en; const old = en.v; en.v = v; return old; }
      const en = { k, v, h: this.kind === 'TreeMap' ? 0 : hashOf(k), seq: this.seq++ };
      if (this.kind === 'TreeMap') this.e.splice(f.at, 0, en);
      else { this.e.push(en); const ks = this.key(k); if (typeof ks === 'string') this.lookup.set(ks, en); }
      this.mod++;
      if (this.kind === 'HashMap' && this.e.length > this.cap * 0.75) this.cap *= 2;
      return null;
    }
    remove(k) {
      const f = this.find(k);
      if (!f.hit) return null;
      const en = this.kind === 'TreeMap' ? this.e[f.at] : f.en;
      this.e.splice(this.e.indexOf(en), 1);
      const ks = this.key(k); if (typeof ks === 'string') this.lookup.delete(ks);
      this.mod++;
      return en;
    }
    clear() { this.e = []; this.lookup.clear(); this.mod++; }
    /** the entries in iteration order */
    order() {
      if (this.kind !== 'HashMap') return this.e;
      const n = this.cap - 1;
      return [...this.e].sort((a, b) => (((a.h ^ (a.h >>> 16)) & n) - ((b.h ^ (b.h >>> 16)) & n)) || a.seq - b.seq);
    }
    get size() { return this.e.length; }
  }
  /** a key for the lookup table: equal values give equal strings (objects with their own hashCode use { h }) */
  function keyStr(k) {
    if (k === null) return 'null';
    if (typeof k === 'number') return 'i' + k;
    if (typeof k === 'bigint') return 'l' + k;
    if (typeof k === 'string') return 's' + k;
    if (k instanceof KC) return 'c' + k.c;
    if (typeof k === 'boolean') return 'b' + k;
    if (k instanceof D) return 'd' + k.v;
    if (k instanceof KObj && !k.cls.data && !hasOwn(k, 'equals') && !hasOwn(k, 'hashCode')) return 'o' + idOf(k);
    return { h: hashOf(k) };
  }
  const hasOwn = (o, n) => { for (let c = o.cls; c; c = c.base) if (c.methods && c.methods.has(n)) return true; return false; };
  const tableSize = n => { let c = 1; while (c < n) c *= 2; return c; };
  /** Kotlin's mapCapacity: the HashMap size hashMapOf(…) and toHashSet() ask for */
  const mapCapacity = n => (n < 3 ? n + 1 : Math.floor(n / 0.75 + 1));
  class KSet { constructor(kind, cap = 16, cmp = null, mutable = true) { this.kind = kind; this.m = new KMap(kind === 'TreeSet' ? 'TreeMap' : kind === 'HashSet' ? 'HashMap' : 'LinkedHashMap', cap, cmp); this.mutable = mutable; } get mod() { return this.m.mod; } items() { return this.m.order().map(en => en.k); } }
  class KDeque { constructor(kind) { this.kind = kind; this.a = []; this.mod = 0; this.mutable = true; } }
  class KPQ { constructor(cmp) { this.q = []; this.cmp = cmp || compare; this.mod = 0; } }
  class KSB { constructor(s = '') { this.s = s; } }
  class KPair { constructor(a, b) { this.a = a; this.b = b; } }
  class KTriple { constructor(a, b, c) { this.a = a; this.b = b; this.c = c; } }
  class KIndexed { constructor(i, v) { this.i = i; this.v = v; } }
  class KEntry { constructor(en, map) { this.en = en; this.map = map; } }
  class KView { constructor(map, part) { this.map = map; this.part = part; } items() { return this.map.order().map(en => (this.part === 'k' ? en.k : this.part === 'v' ? en.v : new KEntry(en, this.map))); } }
  /** IntRange, CharRange, LongRange and their progressions (downTo, step) */
  class KRange { constructor(first, last, step, kind) { this.first = first; this.last = last; this.step = step; this.kind = kind; } }
  /** a lazy Sequence */
  class KSeq { constructor(gen, name = 'TransformingSequence') { this.gen = gen; this.name = name; } }
  class KCmp { constructor(fn) { this.fn = fn; } }
  class KGrouping { constructor(src, key) { this.src = src; this.key = key; } }
  /** Kotlin's Random(seed): XorWow, as kotlin.random.XorWowRandom */
  class KRandom {
    constructor(seed) {
      this.seeded = seed !== undefined;
      if (!this.seeded) return;
      const s1 = Number(BigInt.asIntN(32, BigInt(seed))), s2 = typeof seed === 'bigint' ? Number(BigInt.asIntN(32, seed >> 32n)) : s1 >> 31;
      this.x = s1; this.y = s2; this.z = 0; this.w = 0; this.v = ~s1; this.addend = (s1 << 10) ^ (s2 >>> 4);
      for (let k = 0; k < 64; k++) this.nextInt();
    }
    nextInt() {
      if (!this.seeded) return (Math.random() * 4294967296) | 0;
      let t = this.x;
      t ^= t >>> 2;
      this.x = this.y; this.y = this.z; this.z = this.w;
      const v0 = this.v;
      this.w = v0;
      t = (t ^ (t << 1)) ^ v0 ^ (v0 << 4);
      this.v = t;
      this.addend = (this.addend + 362437) | 0;
      return (t + this.addend) | 0;
    }
    bits(n) { return (this.nextInt() >>> (32 - n)) & (-n >> 31); }
    below(from, until) {
      if (until <= from) throwKt('IllegalArgumentException', `Random range is empty: [${from}, ${until}).`);
      const n = until - from;
      if (n > 0 || n === -2147483648) {
        let r;
        if ((n & -n) === n) r = this.bits(31 - Math.clz32(n));
        else { let v, b; do { b = this.nextInt() >>> 1; v = b % n; } while (b - v + (n - 1) < 0 || b - v + (n - 1) > 2147483647); r = v; }
        return from + r;
      }
      for (;;) { const r = this.nextInt(); if (r >= from && r < until) return r; }
    }
    nextDouble() { return (this.bits(26) * 134217728 + this.bits(27)) / 9007199254740992; }
  }

  /* ---- what a value is: names as the JVM writes them ---- */
  function ktTypeLib(v) {
    if (v instanceof KList) return v.mutable ? 'kotlin.collections.MutableList<…>' : 'kotlin.collections.List<…>';
    if (v instanceof KMap) return v.mutable ? 'kotlin.collections.MutableMap<…>' : 'kotlin.collections.Map<…>';
    if (v instanceof KSet) return v.mutable ? 'kotlin.collections.MutableSet<…>' : 'kotlin.collections.Set<…>';
    if (v instanceof KArr) return v.kind === 'Array' ? 'kotlin.Array<…>' : 'kotlin.' + v.kind;
    if (v instanceof KRange) return 'kotlin.ranges.' + (v.kind === 'Char' ? 'Char' : v.kind === 'Long' ? 'Long' : 'Int') + (v.step === 1 ? 'Range' : 'Progression');
    if (v instanceof KPair) return 'kotlin.Pair<…>';
    if (v instanceof KSB) return 'kotlin.text.StringBuilder';
    return 'kotlin.Any';
  }
  const ARR_CODE = { IntArray: '[I', LongArray: '[J', DoubleArray: '[D', FloatArray: '[F', BooleanArray: '[Z', CharArray: '[C', ShortArray: '[S', ByteArray: '[B' };
  function toStrLib(v) {
    if (v instanceof KList || v instanceof KDeque) return '[' + v.a.map(x => (x === v ? '(this Collection)' : toStr(x))).join(', ') + ']';
    if (v instanceof KSet) return '[' + v.items().map(toStr).join(', ') + ']';
    if (v instanceof KMap) return '{' + v.order().map(en => toStr(en.k) + '=' + toStr(en.v)).join(', ') + '}';
    if (v instanceof KPQ) return '[' + v.q.map(toStr).join(', ') + ']';
    if (v instanceof KView) return '[' + v.items().map(toStr).join(', ') + ']';
    if (v instanceof KEntry) return toStr(v.en.k) + '=' + toStr(v.en.v);
    if (v instanceof KArr) return (ARR_CODE[v.kind] || '[L' + (v.et || 'java.lang.Object') + ';') + '@' + (identityHash(v) >>> 0).toString(16);
    if (v instanceof KSB) return v.s;
    if (v instanceof KPair) return '(' + toStr(v.a) + ', ' + toStr(v.b) + ')';
    if (v instanceof KTriple) return '(' + toStr(v.a) + ', ' + toStr(v.b) + ', ' + toStr(v.c) + ')';
    if (v instanceof KIndexed) return `IndexedValue(index=${v.i}, value=${toStr(v.v)})`;
    if (v instanceof KRange) { const f = toStr(v.first), l = toStr(v.last); return v.step === 1 ? f + '..' + l : v.step > 0 ? `${f}..${l} step ${v.step}` : `${f} downTo ${l} step ${-v.step}`; }
    if (v instanceof KSeq) return 'kotlin.sequences.' + v.name + '@' + (identityHash(v) >>> 0).toString(16);
    if (v instanceof KRandom) return 'kotlin.random.XorWowRandom@' + (identityHash(v) >>> 0).toString(16);
    if (v instanceof KCmp) return 'java.util.Comparator@' + (identityHash(v) >>> 0).toString(16);
    return String(v);
  }
  const javaClass = v => (typeof v === 'number' ? 'java.lang.Integer' : typeof v === 'bigint' ? 'java.lang.Long' : v instanceof D ? (v.f ? 'java.lang.Float' : 'java.lang.Double') : typeof v === 'string' ? 'java.lang.String' : v instanceof KC ? 'java.lang.Character' : typeof v === 'boolean' ? 'java.lang.Boolean' : v instanceof KObj ? api.fullName(v.cls) : v instanceof KList ? 'java.util.' + v.kind : 'java.lang.Object');
  const javaClassOfType = t => ({ Int: 'java.lang.Integer', Long: 'java.lang.Long', Double: 'java.lang.Double', String: 'java.lang.String', Char: 'java.lang.Character', Boolean: 'java.lang.Boolean' }[t.n] || t.n);
  function libEquals(a, b) {
    const seqA = a instanceof KList || a instanceof KDeque, seqB = b instanceof KList || b instanceof KDeque;
    if (seqA || seqB) return seqA && seqB && a.a.length === b.a.length && a.a.every((x, k) => equals(x, b.a[k]));
    if (a instanceof KSet || b instanceof KSet) { if (!(a instanceof KSet && b instanceof KSet)) return false; const x = a.items(), y = b.items(); return x.length === y.length && x.every(e => b.m.get(e) !== null || b.m.find(e).hit); }
    if (a instanceof KMap || b instanceof KMap) { if (!(a instanceof KMap && b instanceof KMap) || a.size !== b.size) return false; return a.e.every(en => { const o = b.find(en.k); return o.hit && equals(en.v, (b.kind === 'TreeMap' ? b.e[o.at] : o.en).v); }); }
    if (a instanceof KPair) return b instanceof KPair && equals(a.a, b.a) && equals(a.b, b.b);
    if (a instanceof KTriple) return b instanceof KTriple && equals(a.a, b.a) && equals(a.b, b.b) && equals(a.c, b.c);
    if (a instanceof KRange) return b instanceof KRange && equals(a.first, b.first) && equals(a.last, b.last) && a.step === b.step;
    if (a instanceof KEntry) return b instanceof KEntry && equals(a.en.k, b.en.k) && equals(a.en.v, b.en.v);
    if (a instanceof KIndexed) return b instanceof KIndexed && a.i === b.i && equals(a.v, b.v);
    return a === b;
  }
  function libHash(v) {
    if (v instanceof KList || v instanceof KDeque) { let h = 1; for (const x of v.a) h = (Math.imul(h, 31) + hashOf(x)) | 0; return h; }
    if (v instanceof KSet) { let h = 0; for (const x of v.items()) h = (h + hashOf(x)) | 0; return h; }
    if (v instanceof KMap) { let h = 0; for (const en of v.e) h = (h + (hashOf(en.k) ^ hashOf(en.v))) | 0; return h; }
    if (v instanceof KPair) return (Math.imul(hashOf(v.a), 31) + hashOf(v.b)) | 0;
    if (v instanceof KTriple) return (Math.imul((Math.imul(hashOf(v.a), 31) + hashOf(v.b)) | 0, 31) + hashOf(v.c)) | 0;
    if (v instanceof KEntry) return hashOf(v.en.k) ^ hashOf(v.en.v);
    return identityHash(v);
  }
  const charLit = c => "'" + ({ 0: '\\u0000', 10: '\\n', 13: '\\r', 9: '\\t', 39: "\\'", 92: '\\\\' }[c] || String.fromCharCode(c)) + "'";

  /* ---- iterating ---- */
  function* rangeItems(r) {
    const { first, last, step, kind } = r;
    if (kind === 'Long') { for (let x = first; step > 0 ? x <= last : x >= last; x += BigInt(step)) yield x; return; }
    const f = kind === 'Char' ? first.c : first, l = kind === 'Char' ? last.c : last;
    for (let x = f; step > 0 ? x <= l : x >= l; x += step) yield kind === 'Char' ? KCH(x) : x;
  }
  /** the elements of anything iterable */
  function* iter(v) {
    if (v === null || v === undefined) npe();
    if (v instanceof KList || v instanceof KDeque) { yield* v.a.slice(); return; }
    if (v instanceof KArr) { yield* v.a; return; }
    if (v instanceof KSet) { yield* v.items(); return; }
    if (v instanceof KMap) { for (const en of v.order().slice()) yield new KEntry(en, v); return; }
    if (v instanceof KView) { yield* v.items(); return; }
    if (v instanceof KRange) { yield* rangeItems(v); return; }
    if (typeof v === 'string') { for (let i = 0; i < v.length; i++) yield KCH(v.charCodeAt(i)); return; }
    if (v instanceof KSeq) { yield* v.gen(); return; }
    if (v instanceof KPQ) { yield* v.q.slice(); return; }
    if (v instanceof KObj) { const it = api.invoke(findMethod(v, 'iterator') || fail(`for-loop range must have an 'iterator()' method.`), [], v, null); yield* iter(it); return; }
    fail(`for-loop range must have an 'iterator()' method (a ${ktType(v)} cannot be looped over).`);
  }
  const findMethod = (o, n) => { for (let c = o.cls; c; c = c.base) { const ms = c.methods && c.methods.get(n); if (ms && ms.length) return ms[0]; } return null; };
  const items = v => [...iter(v)];
  /** for (x in list): Java's iterator, which notices the list changing (and, as in Java, misses it when the second-to-last element is removed) */
  function* iterChecked(v) {
    if (v instanceof KList || v instanceof KDeque) {
      const m0 = v.mod;
      let cur = 0;
      while (cur !== v.a.length) {
        if (v.mod !== m0) throwKt('ConcurrentModificationException');
        if (cur > v.a.length) throwKt('ConcurrentModificationException');
        yield v.a[cur++];
      }
      return;
    }
    if (v instanceof KMap || v instanceof KSet || v instanceof KView) {
      const src = v instanceof KSet ? v.m : v instanceof KView ? v.map : v;
      const m0 = src.mod, es = src.order().slice();
      for (let k = 0; k < es.length; k++) {
        if (src.mod !== m0) throwKt('ConcurrentModificationException');
        const en = es[k];
        yield v instanceof KSet ? en.k : v instanceof KView ? (v.part === 'k' ? en.k : v.part === 'v' ? en.v : new KEntry(en, src)) : new KEntry(en, src);
      }
      return;
    }
    yield* iter(v);
  }

  /* ---- making collections ---- */
  const listOf = xs => new KList(xs.length === 0 ? 'EmptyList' : xs.length === 1 ? 'SingletonList' : 'Arrays$ArrayList', xs, false);
  const mlist = xs => new KList('ArrayList', xs, true);
  function mapFrom(kind, pairs, cap, mutable = true) {
    const m = new KMap(kind, cap, null, mutable);
    for (const p of pairs) { if (!(p instanceof KPair)) fail(`argument type mismatch: actual type is '${ktType(p)}', but 'kotlin.Pair<K, V>' was expected (write key to value).`); m.put(p.a, p.b); }
    return m;
  }
  function setFrom(kind, xs, cap, mutable = true, cmp = null) { const s = new KSet(kind, cap, cmp, mutable); for (const x of xs) s.m.put(x, true); return s; }
  const ARR_ZERO = { IntArray: 0, LongArray: 0n, DoubleArray: new D(0), FloatArray: new D(0, true), BooleanArray: false, CharArray: KCH(0), ShortArray: 0, ByteArray: 0 };
  const pair = (a, b) => new KPair(a, b);

  /* ---- comparators: compareBy, compareByDescending, thenBy, reversed, naturalOrder… ---- */
  const cmpOf = c => (c instanceof KCmp ? c.fn : c instanceof KFn ? (a, b) => Number(callFn(c, [a, b])) : c instanceof KObj ? (a, b) => Number(api.invoke(findMethod(c, 'compare'), [a, b], c, null)) : fail('a Comparator is needed (compareBy { … }, or { a, b -> … }).'));
  const byKeys = (fns, desc = false) => new KCmp((a, b) => { for (const f of fns) { const c = compare(callFn(f, [a]), callFn(f, [b])); if (c) return desc ? -c : c; } return 0; });
  const nullsFirstCmp = (a, b) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : compare(a, b));
  function cmpMethod(c, name, a) {
    const f = cmpOf(c);
    switch (name) {
      case 'reversed': return new KCmp((x, y) => f(y, x));
      case 'thenBy': return new KCmp((x, y) => f(x, y) || compare(callFn(a[0], [x]), callFn(a[0], [y])));
      case 'thenByDescending': return new KCmp((x, y) => f(x, y) || compare(callFn(a[0], [y]), callFn(a[0], [x])));
      case 'thenComparing': return new KCmp((x, y) => f(x, y) || (a[0] instanceof KCmp ? a[0].fn(x, y) : compare(callFn(a[0], [x]), callFn(a[0], [y]))));
      case 'then': return new KCmp((x, y) => f(x, y) || cmpOf(a[0])(x, y));
      case 'compare': return f(a[0], a[1]);
    }
    return undefined;
  }

  /* ---- Java's Formatter: "%.2f".format(x), String.format ---- */
  function fixedHalfUp(x, p) {
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
    const neg = x < 0 || Object.is(x, -0), [m, e] = Math.abs(x).toExponential().split('e');
    const digits = m.replace('.', ''), exp = +e;
    let int = exp >= 0 ? digits.slice(0, exp + 1).padEnd(exp + 1, '0') : '0';
    let frac = exp >= 0 ? digits.slice(exp + 1) : '0'.repeat(-exp - 1) + digits;
    if (frac.length > p) {
      const up = frac[p] >= '5';
      frac = frac.slice(0, p);
      if (up) { const all = (BigInt(int + frac) + 1n).toString().padStart(int.length + frac.length, '0'); int = all.slice(0, all.length - p) || '0'; frac = p ? all.slice(all.length - p) : ''; }
    }
    frac = frac.padEnd(p, '0');
    return (neg && /[1-9]/.test(int + frac) ? '-' : '') + int + (p ? '.' + frac : '');
  }
  const group = s => s.replace(/^(-?\d+)/, m => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  function format(fmt, args) {
    let out = '', ai = 0, i = 0;
    const re = /%(\d+\$)?([-#+ 0,(]*)(\d+)?(\.\d+)?([a-zA-Z%])/y;
    while (i < fmt.length) {
      const pc = fmt.indexOf('%', i);
      if (pc < 0) { out += fmt.slice(i); break; }
      out += fmt.slice(i, pc);
      re.lastIndex = pc;
      const m = re.exec(fmt);
      if (!m) throwKt('UnknownFormatConversionException' in {} ? '' : 'IllegalArgumentException', `Conversion = '${fmt[pc + 1] || '%'}'`);
      i = re.lastIndex;
      const [, pos, flags, w, pr, conv] = m;
      if (conv === 'n') { out += '\n'; continue; }
      if (conv === '%') { out += '%'; continue; }
      const x = pos ? args[parseInt(pos, 10) - 1] : args[ai++];
      if (x === undefined) throwKt('IllegalArgumentException', `Format specifier '%${conv}'`);
      const k = kindOf(x), p = pr ? +pr.slice(1) : null;
      const bad = jt => throwKt('IllegalArgumentException', `${conv} != ${jt}`);
      let s;
      switch (conv.toLowerCase()) {
        case 'd': if (k !== 'Int' && k !== 'Long') bad(javaClass(x)); s = String(x); if (flags.includes(',')) s = group(s); if (flags.includes('+') && !s.startsWith('-')) s = '+' + s; break;
        case 'f': if (k !== 'Double' && k !== 'Float') bad(javaClass(x)); s = fixedHalfUp(x.v, p == null ? 6 : p); if (flags.includes(',')) s = group(s); if (flags.includes('+') && !s.startsWith('-')) s = '+' + s; break;
        case 'e': { if (k !== 'Double' && k !== 'Float') bad(javaClass(x)); const [mm, ee] = x.v.toExponential(p == null ? 6 : p).split('e'); s = mm + 'e' + (ee.startsWith('-') ? '-' : '+') + ee.replace(/^[-+]/, '').padStart(2, '0'); break; }
        case 'x': if (k !== 'Int' && k !== 'Long') bad(javaClass(x)); s = (typeof x === 'bigint' ? BigInt.asUintN(64, x) : x >>> 0).toString(16); break;
        case 'o': s = (x >>> 0).toString(8); break;
        case 'c': s = x instanceof KC ? String.fromCharCode(x.c) : isInt(x) ? String.fromCodePoint(x) : bad(javaClass(x)); break;
        case 'b': s = x === null ? 'false' : typeof x === 'boolean' ? String(x) : 'true'; break;
        case 's': s = toStr(x); if (p != null) s = s.slice(0, p); break;
        default: throwKt('IllegalArgumentException', `Conversion = '${conv}'`);
      }
      if (conv === conv.toUpperCase() && conv !== '%') s = s.toUpperCase();
      if (w) { const n = +w; if (s.length < n) s = flags.includes('-') ? s.padEnd(n) : flags.includes('0') && /[dfx]/.test(conv) ? (s.startsWith('-') ? '-' + s.slice(1).padStart(n - 1, '0') : s.padStart(n, '0')) : s.padStart(n); }
      out += s;
    }
    return out;
  }

  /* ---- the collection functions (Kotlin's extensions on Iterable, Sequence, Array, String, Map) ---- */
  const pred = f => (f instanceof KFn ? x => { const r = callFn(f, [x]); if (typeof r !== 'boolean') fail(`return type mismatch: expected 'kotlin.Boolean', actual '${ktType(r)}'.`); return r; } : fail("a lambda { … } is needed here."));
  const sel = f => (f instanceof KFn ? x => callFn(f, [x]) : f instanceof KCmp ? fail('a lambda { … } is needed here, not a Comparator.') : fail("a lambda { … } is needed here."));
  const noSuch = (msg = 'Collection is empty.') => throwKt('NoSuchElementException', msg);
  const emptyMsg = v => (v instanceof KList || v instanceof KDeque ? 'List is empty.' : v instanceof KArr ? 'Array is empty.' : typeof v === 'string' ? 'Char sequence is empty.' : 'Collection is empty.');
  function sumOf(xs) {
    let kind = null, acc = 0;
    for (const x of xs) {
      const k = kindOf(x);
      if (k === 'Double' || k === 'Float') { if (kind !== 'Double') { acc = Number(acc); kind = 'Double'; } acc += x.v; }
      else if (k === 'Long') { if (kind === null || kind === 'Int') { acc = BigInt(acc); kind = 'Long'; } acc = kind === 'Double' ? acc + Number(x) : BigInt.asIntN(64, acc + x); }
      else if (k === 'Int') { if (kind === null) kind = 'Int'; acc = kind === 'Long' ? BigInt.asIntN(64, acc + BigInt(x)) : kind === 'Double' ? acc + x : (acc + x) | 0; }
      else fail(`unresolved reference 'sum' for '${ktType(x)}' (sum() adds numbers).`);
    }
    return kind === 'Double' ? new D(acc) : kind === 'Long' ? acc : acc;
  }
  const minMax = (xs, max, src) => { if (!xs.length) return noSuch(emptyMsg(src)); return xs.reduce((m, x) => ((max ? compare(x, m) > 0 : compare(x, m) < 0) ? x : m)); };
  /** the target of intermediate operations: a Sequence stays lazy */
  const lazy = (src, gen, name) => (src instanceof KSeq ? new KSeq(gen, name) : null);
  function joinTo(xs, a) {
    const named = a.names || [];
    const arg = (n, k, d) => { const at = named.indexOf(n); return at >= 0 ? a[at] : a[k] !== undefined && !named[k] && !(a[k] instanceof KFn) ? a[k] : d; };
    const sep = arg('separator', 0, ', '), pre = arg('prefix', 1, ''), post = arg('postfix', 2, ''), limit = arg('limit', 3, -1), trunc = arg('truncated', 4, '...');
    const tf = a.find(x => x instanceof KFn) || arg('transform', 5, null);
    let parts = xs.map(x => (tf ? toStr(callFn(tf, [x])) : x instanceof KC ? String.fromCharCode(x.c) : toStr(x)));
    if (limit >= 0 && parts.length > limit) parts = [...parts.slice(0, limit), trunc];
    return toStr(pre) + parts.join(toStr(sep)) + toStr(post);
  }
  /** Iterable functions (on lists, sets, arrays, ranges, strings, sequences, map entries) */
  function iterable(v, name, a) {
    const xs = () => items(v);
    const S = (gen, nm) => lazy(v, gen, nm);
    switch (name) {
      case 'forEach': { for (const x of iterChecked(v)) callFn(a[0], [x]); return UNIT; }
      case 'forEachIndexed': { let k = 0; for (const x of iterChecked(v)) callFn(a[0], [k++, x]); return UNIT; }
      case 'onEach': { if (v instanceof KSeq) return new KSeq(function* () { for (const x of iter(v)) { callFn(a[0], [x]); yield x; } }); for (const x of xs()) callFn(a[0], [x]); return v; }
      case 'map': { const f = sel(a[0]); return S(function* () { for (const x of iter(v)) yield f(x); }) || mlist(xs().map(f)); }
      case 'mapIndexed': { let k = 0; return S(function* () { let j = 0; for (const x of iter(v)) yield callFn(a[0], [j++, x]); }) || mlist(xs().map(x => callFn(a[0], [k++, x]))); }
      case 'mapNotNull': { const f = sel(a[0]); return S(function* () { for (const x of iter(v)) { const y = f(x); if (y !== null) yield y; } }) || mlist(xs().map(f).filter(x => x !== null)); }
      case 'flatMap': { const f = sel(a[0]); return S(function* () { for (const x of iter(v)) yield* iter(f(x)); }, 'FlatteningSequence') || mlist(xs().flatMap(x => items(f(x)))); }
      case 'flatten': return S(function* () { for (const x of iter(v)) yield* iter(x); }, 'FlatteningSequence') || mlist(xs().flatMap(x => items(x)));
      case 'filter': { const p = pred(a[0]); return S(function* () { for (const x of iter(v)) if (p(x)) yield x; }, 'FilteringSequence') || mlist(xs().filter(p)); }
      case 'filterNot': { const p = pred(a[0]); return S(function* () { for (const x of iter(v)) if (!p(x)) yield x; }, 'FilteringSequence') || mlist(xs().filter(x => !p(x))); }
      case 'filterIndexed': { let k = 0; return mlist(xs().filter(x => callFn(a[0], [k++, x]) === true)); }
      case 'filterNotNull': return S(function* () { for (const x of iter(v)) if (x !== null) yield x; }) || mlist(xs().filter(x => x !== null));
      case 'filterIsInstance': return mlist(xs().filter(x => a.targ && api.isInstance(x, a.targ)));
      case 'take': { const n = Number(a[0]); if (n < 0) throwKt('IllegalArgumentException', `Requested element count ${n} is less than zero.`); return S(function* () { let k = 0; if (!n) return; for (const x of iter(v)) { yield x; if (++k >= n) return; } }, 'TakeSequence') || mlist(xs().slice(0, n)); }
      case 'drop': { const n = Number(a[0]); if (n < 0) throwKt('IllegalArgumentException', `Requested element count ${n} is less than zero.`); return S(function* () { let k = 0; for (const x of iter(v)) if (k++ >= n) yield x; }, 'DropSequence') || mlist(xs().slice(n)); }
      case 'takeWhile': { const p = pred(a[0]); return S(function* () { for (const x of iter(v)) { if (!p(x)) return; yield x; } }, 'TakeWhileSequence') || (() => { const out = []; for (const x of xs()) { if (!p(x)) break; out.push(x); } return mlist(out); })(); }
      case 'dropWhile': { const p = pred(a[0]); const out = []; let on = false; for (const x of xs()) { if (on || !p(x)) { on = true; out.push(x); } } return mlist(out); }
      case 'takeLast': { const all = xs(), n = Number(a[0]); return mlist(all.slice(Math.max(0, all.length - n))); }
      case 'dropLast': { const all = xs(), n = Number(a[0]); return mlist(all.slice(0, Math.max(0, all.length - n))); }
      case 'distinct': return S(function* () { const seen = new KMap('HashMap'); for (const x of iter(v)) if (!seen.find(x).hit) { seen.put(x, true); yield x; } }, 'DistinctSequence') || mlist(setFrom('LinkedHashSet', xs()).items());
      case 'distinctBy': { const f = sel(a[0]); const seen = new KMap('HashMap'); return mlist(xs().filter(x => { const k = f(x); if (seen.find(k).hit) return false; seen.put(k, true); return true; })); }
      case 'withIndex': return S(function* () { let k = 0; for (const x of iter(v)) yield new KIndexed(k++, x); }, 'IndexingSequence') || mlist(xs().map((x, k) => new KIndexed(k, x)));
      case 'zip': { const other = items(a[0]); const f = a[1]; const all = xs(); const n = Math.min(all.length, other.length); return mlist(Array.from({ length: n }, (_, k) => (f ? callFn(f, [all[k], other[k]]) : pair(all[k], other[k])))); }
      case 'zipWithNext': { const all = xs(); return mlist(all.slice(1).map((x, k) => (a[0] ? callFn(a[0], [all[k], x]) : pair(all[k], x)))); }
      case 'unzip': { const all = xs(); return pair(mlist(all.map(p => p.a)), mlist(all.map(p => p.b))); }
      case 'chunked': { const all = xs(), n = Number(a[0]), out = []; for (let k = 0; k < all.length; k += n) out.push(mlist(all.slice(k, k + n))); return mlist(a[1] ? out.map(c => callFn(a[1], [c])) : out); }
      case 'windowed': { const all = xs(), n = Number(a[0]), st = a[1] !== undefined && !(a[1] instanceof KFn) ? Number(a[1]) : 1, partial = a[2] === true, out = []; for (let k = 0; k < all.length && (partial || k + n <= all.length); k += st) out.push(mlist(all.slice(k, k + n))); const tf = a.find(x => x instanceof KFn); return mlist(tf ? out.map(c => callFn(tf, [c])) : out); }
      case 'sorted': return S(function* () { yield* xs().sort(compare); }) || mlist(stableSort(xs(), compare));
      case 'sortedDescending': return mlist(stableSort(xs(), (x, y) => compare(y, x)));
      case 'sortedBy': { const f = sel(a[0]); return S(function* () { yield* stableSort(xs(), (x, y) => compare(f(x), f(y))); }) || mlist(stableSort(xs(), (x, y) => nullsFirstCmp(f(x), f(y)))); }
      case 'sortedByDescending': { const f = sel(a[0]); return mlist(stableSort(xs(), (x, y) => nullsFirstCmp(f(y), f(x)))); }
      case 'sortedWith': return mlist(stableSort(xs(), cmpOf(a[0])));
      case 'reversed': return mlist(xs().reverse());
      case 'asReversed': return mlist(xs().reverse());
      case 'shuffled': { const all = xs(), r = a[0] instanceof KRandom ? a[0] : new KRandom(); for (let k = all.length - 1; k > 0; k--) { const j = r.below(0, k + 1); [all[k], all[j]] = [all[j], all[k]]; } return mlist(all); }
      case 'groupBy': { const kf = sel(a[0]), vf = a[1] ? sel(a[1]) : x => x; const m = new KMap('LinkedHashMap'); for (const x of xs()) { const k = kf(x); let en = m.get(k); if (!en) { m.put(k, mlist([])); en = m.get(k); } en.v.a.push(vf(x)); } return m; }
      case 'groupingBy': return new KGrouping(v, sel(a[0]));
      case 'associate': { const f = sel(a[0]); const all = xs(); const m = new KMap('LinkedHashMap', mapCapacity(all.length)); for (const x of all) { const p = f(x); m.put(p.a, p.b); } return m; }
      case 'associateBy': { const kf = sel(a[0]), vf = a[1] ? sel(a[1]) : x => x; const m = new KMap('LinkedHashMap'); for (const x of xs()) m.put(kf(x), vf(x)); return m; }
      case 'associateWith': { const f = sel(a[0]); const m = new KMap('LinkedHashMap'); for (const x of xs()) m.put(x, f(x)); return m; }
      case 'partition': { const p = pred(a[0]); const all = xs(); return pair(mlist(all.filter(p)), mlist(all.filter(x => !p(x)))); }
      case 'fold': return xs().reduce((acc, x) => callFn(a[1], [acc, x]), a[0]);
      case 'foldIndexed': return xs().reduce((acc, x, k) => callFn(a[1], [k, acc, x]), a[0]);
      case 'reduce': { const all = xs(); if (!all.length) throwKt('UnsupportedOperationException', "Empty collection can't be reduced."); return all.slice(1).reduce((acc, x) => callFn(a[0], [acc, x]), all[0]); }
      case 'runningFold': case 'scan': { const out = [a[0]]; let acc = a[0]; for (const x of xs()) { acc = callFn(a[1], [acc, x]); out.push(acc); } return mlist(out); }
      case 'sum': return sumOf(xs());
      case 'sumOf': return sumOf(xs().map(sel(a[0])));
      case 'average': { const all = xs(); if (!all.length) return new D(NaN); return new D(all.reduce((s, x) => s + num(x), 0) / all.length); }
      case 'count': return a[0] ? xs().filter(pred(a[0])).length : xs().length;
      case 'any': return a[0] ? xs().some(pred(a[0])) : xs().length > 0;
      case 'all': return xs().every(pred(a[0]));
      case 'none': return a[0] ? !xs().some(pred(a[0])) : !xs().length;
      case 'max': case 'min': { const all = xs(); if (!all.length) throwKt('NoSuchElementException'); return minMax(all, name === 'max', v); }
      case 'maxOrNull': case 'minOrNull': { const all = xs(); return all.length ? minMax(all, name === 'maxOrNull') : null; }
      case 'maxBy': case 'minBy': case 'maxByOrNull': case 'minByOrNull': { const f = sel(a[0]); const all = xs(); if (!all.length) return name.endsWith('OrNull') ? null : noSuch(); let best = all[0], bk = f(best); for (const x of all.slice(1)) { const k = f(x); if (name.startsWith('max') ? compare(k, bk) > 0 : compare(k, bk) < 0) { best = x; bk = k; } } return best; }
      case 'maxOf': case 'minOf': case 'maxOfOrNull': case 'minOfOrNull': { const all = xs().map(sel(a[0])); if (!all.length) return name.endsWith('OrNull') ? null : noSuch(); return minMax(all, name.startsWith('max')); }
      case 'maxWith': case 'minWith': { const c = cmpOf(a[0]); const all = xs(); if (!all.length) noSuch(); return all.reduce((m, x) => ((name === 'maxWith' ? c(x, m) > 0 : c(x, m) < 0) ? x : m)); }
      case 'first': case 'firstOrNull': case 'last': case 'lastOrNull': case 'single': case 'singleOrNull': case 'find': case 'findLast': {
        const p = a[0] ? pred(a[0]) : null;
        let all = xs();
        if (p) all = all.filter(p);
        const orNull = name.endsWith('OrNull') || name === 'find' || name === 'findLast';
        if (name.startsWith('single') && all.length > 1) { if (orNull) return null; throwKt('IllegalArgumentException', p ? 'Collection contains more than one matching element.' : `${v instanceof KList ? 'List' : 'Collection'} has more than one element.`); }
        if (!all.length) { if (orNull) return null; noSuch(p ? (typeof v === 'string' ? 'Char sequence contains no character matching the predicate.' : 'Collection contains no element matching the predicate.') : emptyMsg(v)); }
        return name.startsWith('last') || name === 'findLast' ? all.at(-1) : all[0];
      }
      case 'indexOfFirst': { const p = pred(a[0]); return xs().findIndex(p); }
      case 'indexOfLast': { const p = pred(a[0]); const all = xs(); for (let k = all.length - 1; k >= 0; k--) if (p(all[k])) return k; return -1; }
      case 'contains': return xs().some(x => equals(x, a[0]));
      case 'containsAll': { const all = xs(); return items(a[0]).every(y => all.some(x => equals(x, y))); }
      case 'indexOf': return xs().findIndex(x => equals(x, a[0]));
      case 'lastIndexOf': { const all = xs(); for (let k = all.length - 1; k >= 0; k--) if (equals(all[k], a[0])) return k; return -1; }
      case 'elementAt': { const all = xs(), k = Number(a[0]); if (k < 0 || k >= all.length) throwKt('IndexOutOfBoundsException', `Collection doesn't contain element at index ${k}.`); return all[k]; }
      case 'elementAtOrNull': { const all = xs(); return all[Number(a[0])] ?? null; }
      case 'joinToString': return joinTo(xs(), a);
      case 'toList': return mlist(xs().slice());
      case 'toMutableList': return mlist(xs().slice());
      case 'toSet': return setFrom('LinkedHashSet', xs(), 16, false);
      case 'toMutableSet': return setFrom('LinkedHashSet', xs());
      case 'toHashSet': { const all = xs(); return setFrom('HashSet', all, mapCapacity(Math.max(all.length, 0))); }
      case 'toSortedSet': return setFrom('TreeSet', xs());
      case 'toTypedArray': case 'toIntArray': case 'toLongArray': case 'toDoubleArray': case 'toCharArray': case 'toBooleanArray': return new KArr({ toTypedArray: 'Array', toIntArray: 'IntArray', toLongArray: 'LongArray', toDoubleArray: 'DoubleArray', toCharArray: 'CharArray', toBooleanArray: 'BooleanArray' }[name], xs().slice());
      case 'toMap': { const m = new KMap('LinkedHashMap'); for (const p of xs()) m.put(p.a, p.b); return m; }
      case 'asSequence': return new KSeq(() => iter(v));
      case 'asIterable': return v;
      case 'iterator': return new KSeq(() => iter(v));
      case 'random': { const all = xs(); if (!all.length) noSuch(`${v instanceof KList ? 'Collection' : 'Collection'} is empty.`); return all[(a[0] instanceof KRandom ? a[0] : new KRandom()).below(0, all.length)]; }
      case 'ifEmpty': return xs().length ? v : callFn(a[0], []);
      case 'isEmpty': return !xs().length;
      case 'isNotEmpty': return xs().length > 0;
      case 'plus': { const extra = a[0] instanceof KList || a[0] instanceof KSet || a[0] instanceof KArr || a[0] instanceof KRange ? items(a[0]) : [a[0]]; return v instanceof KSet ? setFrom('LinkedHashSet', [...v.items(), ...extra]) : mlist([...xs(), ...extra]); }
      case 'minus': { const rm = a[0] instanceof KList || a[0] instanceof KSet || a[0] instanceof KArr ? items(a[0]) : null; let removed = false; const out = xs().filter(x => (rm ? !rm.some(y => equals(x, y)) : removed || !equals(x, a[0]) ? true : (removed = true, false))); return v instanceof KSet ? setFrom('LinkedHashSet', out) : mlist(out); }
      case 'union': return setFrom('LinkedHashSet', [...xs(), ...items(a[0])]);
      case 'intersect': { const o = items(a[0]); return setFrom('LinkedHashSet', xs().filter(x => o.some(y => equals(x, y)))); }
      case 'subtract': { const o = items(a[0]); return setFrom('LinkedHashSet', xs().filter(x => !o.some(y => equals(x, y)))); }
      case 'toString': return toStrLib(v);
      case 'hashCode': return libHash(v);
      case 'equals': return equals(v, a[0]);
      case 'chunkedSequence': return undefined;
      case 'sumBy': return sumOf(xs().map(sel(a[0])));
      case 'count1': return undefined;
    }
    return undefined;
  }
  const stableSort = (xs, cmp) => xs.map((x, k) => [x, k]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map(p => p[0]);

  /* ---- methods of each kind of value ---- */
  const idx = (n, k, what = 'Index') => { const i = Number(k); if (i < 0 || i >= n) throwKt('IndexOutOfBoundsException', `${what} ${i} out of bounds for length ${n}`); return i; };
  const mutableOnly = (v, name) => { if (!v.mutable) fail(`unresolved reference '${name}' (a List made by listOf cannot be changed: use mutableListOf).`.replace("a List made by listOf cannot be changed: use mutableListOf", v instanceof KSet ? 'a Set made by setOf cannot be changed: use mutableSetOf' : v instanceof KMap ? 'a Map made by mapOf cannot be changed: use mutableMapOf' : 'a List made by listOf cannot be changed: use mutableListOf')); };
  function listMethod(v, name, a) {
    const L = v.a;
    switch (name) {
      case 'get': return getIndex(v, [a[0]]);
      case 'getOrNull': { const k = Number(a[0]); return k >= 0 && k < L.length ? L[k] : null; }
      case 'getOrElse': { const k = Number(a[0]); return k >= 0 && k < L.length ? L[k] : callFn(a[1], [k]); }
      case 'subList': { const f = Number(a[0]), t = Number(a[1]); if (f < 0 || t > L.length || f > t) throwKt('IndexOutOfBoundsException', `fromIndex: ${f}, toIndex: ${t}, size: ${L.length}`); return mlist(L.slice(f, t)); }
      case 'slice': return mlist(items(a[0]).map(k => L[idx(L.length, k)]));
      case 'binarySearch': { let lo = 0, hi = L.length - 1; while (lo <= hi) { const m = (lo + hi) >>> 1, c = compare(L[m], a[0]); if (c < 0) lo = m + 1; else if (c > 0) hi = m - 1; else return m; } return -(lo + 1); }
      case 'component1': case 'component2': case 'component3': case 'component4': case 'component5': return L[idx(L.length, +name.slice(-1) - 1)];
    }
    if (['add', 'addAll', 'remove', 'removeAt', 'removeAll', 'retainAll', 'removeIf', 'clear', 'set', 'sort', 'sortBy', 'sortByDescending', 'sortDescending', 'sortWith', 'reverse', 'shuffle', 'fill', 'removeFirst', 'removeLast', 'removeFirstOrNull', 'removeLastOrNull', 'addFirst', 'addLast', 'push', 'pop', 'peek'].includes(name) && !(v instanceof KDeque)) {
      mutableOnly(v, name);
      v.mod++;
      switch (name) {
        case 'add': if (a.length === 2) { const k = Number(a[0]); if (k < 0 || k > L.length) throwKt('IndexOutOfBoundsException', `Index: ${k}, Size: ${L.length}`); L.splice(k, 0, a[1]); return UNIT; } L.push(a[0]); return true;
        case 'addAll': { if (a.length === 2) { L.splice(Number(a[0]), 0, ...items(a[1])); return true; } const xs = items(a[0]); L.push(...xs); return xs.length > 0; }
        case 'remove': { const k = L.findIndex(x => equals(x, a[0])); if (k < 0) { v.mod--; return false; } L.splice(k, 1); return true; }
        case 'removeAt': { const k = idx(L.length, a[0]); return L.splice(k, 1)[0]; }
        case 'removeAll': case 'removeIf': { const p = a[0] instanceof KFn ? pred(a[0]) : (o => x => o.some(y => equals(x, y)))(items(a[0])); const keep = L.filter(x => !p(x)); const r = keep.length !== L.length; v.a = keep; return r; }
        case 'retainAll': { const p = a[0] instanceof KFn ? pred(a[0]) : (o => x => o.some(y => equals(x, y)))(items(a[0])); const keep = L.filter(p); const r = keep.length !== L.length; v.a = keep; return r; }
        case 'clear': L.length = 0; return UNIT;
        case 'set': { const k = idx(L.length, a[0]); const old = L[k]; L[k] = a[1]; v.mod--; return old; }
        case 'sort': { const s = stableSort(L, compare); L.splice(0, L.length, ...s); return UNIT; }
        case 'sortDescending': { const s = stableSort(L, (x, y) => compare(y, x)); L.splice(0, L.length, ...s); return UNIT; }
        case 'sortBy': case 'sortByDescending': { const f = sel(a[0]); const s = stableSort(L, (x, y) => (name === 'sortBy' ? nullsFirstCmp(f(x), f(y)) : nullsFirstCmp(f(y), f(x)))); L.splice(0, L.length, ...s); return UNIT; }
        case 'sortWith': { const s = stableSort(L, cmpOf(a[0])); L.splice(0, L.length, ...s); return UNIT; }
        case 'reverse': L.reverse(); return UNIT;
        case 'shuffle': { const r = a[0] instanceof KRandom ? a[0] : new KRandom(); for (let k = L.length - 1; k > 0; k--) { const j = r.below(0, k + 1); [L[k], L[j]] = [L[j], L[k]]; } return UNIT; }
        case 'fill': L.fill(a[0]); return UNIT;
        case 'removeFirst': if (!L.length) noSuch('List is empty.'); return L.shift();
        case 'removeLast': if (!L.length) noSuch('List is empty.'); return L.pop();
        case 'removeFirstOrNull': return L.length ? L.shift() : null;
        case 'removeLastOrNull': return L.length ? L.pop() : null;
        case 'addFirst': L.unshift(a[0]); return UNIT;
        case 'addLast': L.push(a[0]); return UNIT;
        case 'push': L.push(a[0]); return a[0];
        case 'pop': if (!L.length) throwKt('EmptyStackException' in {} ? '' : 'RuntimeException', 'java.util.EmptyStackException'); return L.pop();
        case 'peek': v.mod--; if (!L.length) throwKt('RuntimeException', 'java.util.EmptyStackException'); return L.at(-1);
      }
    }
    if (name === 'lastIndex') return L.length - 1;
    if (name === 'empty' && v.kind === 'Stack') return !L.length;
    if (name === 'search') return -1;
    return iterable(v, name, a);
  }
  function dequeMethod(v, name, a) {
    const Q = v.a;
    const empty = () => noSuch('ArrayDeque is empty.');
    switch (name) {
      case 'addFirst': case 'offerFirst': case 'push': Q.unshift(a[0]); v.mod++; return name === 'offerFirst' ? true : UNIT;
      case 'addLast': case 'add': case 'offerLast': case 'offer': Q.push(a[0]); v.mod++; return name === 'add' || name.startsWith('offer') ? true : UNIT;
      case 'removeFirst': case 'pop': case 'remove': if (name === 'remove' && a.length) { const k = Q.findIndex(x => equals(x, a[0])); if (k < 0) return false; Q.splice(k, 1); v.mod++; return true; } if (!Q.length) return v.kind === 'ArrayDeque' ? empty() : noSuch(); v.mod++; return Q.shift();
      case 'removeLast': if (!Q.length) return v.kind === 'ArrayDeque' ? empty() : noSuch(); v.mod++; return Q.pop();
      case 'removeFirstOrNull': case 'poll': case 'pollFirst': if (!Q.length) return null; v.mod++; return Q.shift();
      case 'removeLastOrNull': case 'pollLast': if (!Q.length) return null; v.mod++; return Q.pop();
      case 'first': if (!a.length) { if (!Q.length) empty(); return Q[0]; } break;
      case 'last': if (!a.length) { if (!Q.length) empty(); return Q.at(-1); } break;
      case 'peek': case 'peekFirst': case 'firstOrNull': if (!a.length) return Q.length ? Q[0] : null; break;
      case 'peekLast': case 'lastOrNull': if (!a.length) return Q.length ? Q.at(-1) : null; break;
      case 'element': case 'getFirst': if (!Q.length) noSuch(); return Q[0];
      case 'clear': Q.length = 0; v.mod++; return UNIT;
      case 'get': return Q[idx(Q.length, a[0])];
      case 'removeAt': { const k = idx(Q.length, a[0]); v.mod++; return Q.splice(k, 1)[0]; }
    }
    return iterable(v, name, a);
  }
  function pqMethod(v, name, a) {
    const q = v.q, cmp = v.cmp;
    const siftUp = (k, x) => { while (k > 0) { const p = (k - 1) >>> 1, e = q[p]; if (cmp(x, e) >= 0) break; q[k] = e; k = p; } q[k] = x; };
    const siftDown = (k, x, n) => { const half = n >>> 1; while (k < half) { let child = (k << 1) + 1, c = q[child]; const right = child + 1; if (right < n && cmp(c, q[right]) > 0) c = q[child = right]; if (cmp(x, c) <= 0) break; q[k] = c; k = child; } q[k] = x; };
    const poll = () => { if (!q.length) return null; const r = q[0]; const x = q.pop(); if (q.length) siftDown(0, x, q.length); v.mod++; return r; };
    switch (name) {
      case 'add': case 'offer': if (a[0] === null) npe(); q.push(null); siftUp(q.length - 1, a[0]); v.mod++; return true;
      case 'poll': return poll();
      case 'remove': {
        if (!a.length) { if (!q.length) noSuch(); return poll(); }
        const i = q.findIndex(x => equals(x, a[0]));
        if (i < 0) return false;
        const s = q.length - 1;
        if (s === i) q.pop(); else { const moved = q.pop(); siftDown(i, moved, q.length); if (q[i] === moved) siftUp(i, moved); }
        v.mod++;
        return true;
      }
      case 'peek': return q.length ? q[0] : null;
      case 'element': if (!q.length) noSuch(); return q[0];
      case 'clear': q.length = 0; return UNIT;
      case 'contains': return q.some(x => equals(x, a[0]));
      case 'addAll': for (const x of items(a[0])) pqMethod(v, 'add', [x]); return true;
    }
    return iterable(v, name, a);
  }
  function mapMethod(v, name, a) {
    const getV = k => { const en = v.get(k); return en ? en.v : null; };
    switch (name) {
      case 'get': return getV(a[0]);
      case 'getValue': { const en = v.get(a[0]); if (!en) noSuch(`Key ${toStr(a[0])} is missing in the map.`); return en.v; }
      case 'getOrDefault': { const en = v.get(a[0]); return en ? en.v : a[1]; }
      case 'getOrElse': { const en = v.get(a[0]); return en ? en.v : callFn(a[1], []); }
      case 'containsKey': return !!v.get(a[0]);
      case 'containsValue': return v.e.some(en => equals(en.v, a[0]));
      case 'contains': return !!v.get(a[0]);
      case 'isEmpty': return !v.size;
      case 'isNotEmpty': return v.size > 0;
      case 'forEach': { const f = a[0]; const two = f instanceof KFn && f.params && f.params.length === 2; for (const en of iterChecked(v)) callFn(f, two ? [en.en.k, en.en.v] : [en]); return UNIT; }
      case 'map': return mlist(items(v).map(sel(a[0])));
      case 'mapNotNull': return mlist(items(v).map(sel(a[0])).filter(x => x !== null));
      case 'flatMap': return mlist(items(v).flatMap(x => items(sel(a[0])(x))));
      case 'filter': case 'filterNot': { const p = pred(a[0]); const m = new KMap('LinkedHashMap'); for (const en of items(v)) if (p(en) === (name === 'filter')) m.put(en.en.k, en.en.v); return m; }
      case 'filterKeys': case 'filterValues': { const p = pred(a[0]); const m = new KMap('LinkedHashMap'); for (const en of v.order()) if (p(name === 'filterKeys' ? en.k : en.v)) m.put(en.k, en.v); return m; }
      case 'mapValues': case 'mapKeys': { const f = sel(a[0]); const m = new KMap('LinkedHashMap', mapCapacity(v.size)); for (const en of items(v)) m.put(name === 'mapKeys' ? f(en) : en.en.k, name === 'mapValues' ? f(en) : en.en.v); return m; }
      case 'toList': return mlist(v.order().map(en => pair(en.k, en.v)));
      case 'toMutableMap': { const m = new KMap('LinkedHashMap', mapCapacity(v.size)); for (const en of v.order()) m.put(en.k, en.v); return m; }
      case 'toMap': { const m = new KMap('LinkedHashMap', mapCapacity(v.size), null, false); for (const en of v.order()) m.put(en.k, en.v); return m; }
      case 'toSortedMap': { const m = new KMap('TreeMap', 16, a[0] ? cmpOf(a[0]) : null); for (const en of v.order()) m.put(en.k, en.v); return m; }
      case 'plus': { const m = new KMap('LinkedHashMap'); for (const en of v.order()) m.put(en.k, en.v); for (const p of a[0] instanceof KPair ? [a[0]] : a[0] instanceof KMap ? a[0].order().map(en => pair(en.k, en.v)) : items(a[0])) m.put(p.a, p.b); return m; }
      case 'minus': { const m = new KMap('LinkedHashMap'); for (const en of v.order()) if (!equals(en.k, a[0])) m.put(en.k, en.v); return m; }
      case 'firstKey': if (!v.size) noSuch(); return v.order()[0].k;
      case 'lastKey': if (!v.size) noSuch(); return v.order().at(-1).k;
      case 'firstEntry': return v.size ? new KEntry(v.order()[0], v) : null;
      case 'lastEntry': return v.size ? new KEntry(v.order().at(-1), v) : null;
      case 'floorKey': case 'ceilingKey': case 'lowerKey': case 'higherKey': { const es = v.order(); const ok = en => { const c = compare(en.k, a[0]); return name === 'floorKey' ? c <= 0 : name === 'ceilingKey' ? c >= 0 : name === 'lowerKey' ? c < 0 : c > 0; }; const hits = es.filter(ok); return hits.length ? (name === 'floorKey' || name === 'lowerKey' ? hits.at(-1).k : hits[0].k) : null; }
      case 'headMap': case 'tailMap': { const m = new KMap('TreeMap', 16, v.cmp); for (const en of v.order()) if (name === 'headMap' ? compare(en.k, a[0]) < 0 : compare(en.k, a[0]) >= 0) m.put(en.k, en.v); return m; }
      case 'toString': return toStrLib(v);
      case 'equals': return equals(v, a[0]);
      case 'hashCode': return libHash(v);
    }
    if (['put', 'set', 'remove', 'putAll', 'getOrPut', 'clear', 'putIfAbsent', 'merge', 'compute', 'computeIfAbsent', 'removeIf'].includes(name)) {
      mutableOnly(v, name);
      switch (name) {
        case 'put': case 'set': { const old = v.put(a[0], a[1]); return name === 'set' ? UNIT : old; }
        case 'remove': { const en = v.remove(a[0]); return en ? en.v : null; }
        case 'putAll': for (const p of a[0] instanceof KMap ? a[0].order().map(en => pair(en.k, en.v)) : items(a[0])) v.put(p.a, p.b); return UNIT;
        case 'getOrPut': { const en = v.get(a[0]); if (en) return en.v; const x = callFn(a[1], []); v.put(a[0], x); return x; }
        case 'putIfAbsent': { const en = v.get(a[0]); if (en && en.v !== null) return en.v; v.put(a[0], a[1]); return null; }
        case 'computeIfAbsent': { const en = v.get(a[0]); if (en && en.v !== null) return en.v; const x = callFn(a[1], [a[0]]); if (x !== null) v.put(a[0], x); return x; }
        case 'merge': { const en = v.get(a[0]); const x = en && en.v !== null ? callFn(a[2], [en.v, a[1]]) : a[1]; if (x === null) v.remove(a[0]); else v.put(a[0], x); return x; }
        case 'compute': { const en = v.get(a[0]); const x = callFn(a[1], [a[0], en ? en.v : null]); if (x === null) v.remove(a[0]); else v.put(a[0], x); return x; }
        case 'clear': v.clear(); return UNIT;
      }
    }
    return iterable(v, name, a);
  }
  function setMethod(v, name, a) {
    switch (name) {
      case 'add': mutableOnly(v, name); if (v.m.find(a[0]).hit) return false; v.m.put(a[0], true); return true;
      case 'remove': mutableOnly(v, name); return !!v.m.remove(a[0]);
      case 'contains': return v.m.find(a[0]).hit;
      case 'addAll': { mutableOnly(v, name); let ch = false; for (const x of items(a[0])) if (!v.m.find(x).hit) { v.m.put(x, true); ch = true; } return ch; }
      case 'removeAll': { mutableOnly(v, name); let ch = false; if (a[0] instanceof KFn) { const p = pred(a[0]); for (const x of v.items()) if (p(x)) { v.m.remove(x); ch = true; } } else for (const x of items(a[0])) if (v.m.remove(x)) ch = true; return ch; }
      case 'retainAll': { mutableOnly(v, name); const o = items(a[0]); let ch = false; for (const x of v.items()) if (!o.some(y => equals(x, y))) { v.m.remove(x); ch = true; } return ch; }
      case 'clear': mutableOnly(v, name); v.m.clear(); return UNIT;
      case 'first': if (!a.length && v.kind === 'TreeSet') { if (!v.m.size) noSuch(); return v.items()[0]; } break;
      case 'last': if (!a.length && v.kind === 'TreeSet') { if (!v.m.size) noSuch(); return v.items().at(-1); } break;
      case 'pollFirst': { const it = v.items(); if (!it.length) return null; v.m.remove(it[0]); return it[0]; }
      case 'pollLast': { const it = v.items(); if (!it.length) return null; v.m.remove(it.at(-1)); return it.at(-1); }
      case 'floor': case 'ceiling': case 'lower': case 'higher': { const es = v.items(); const ok = x => { const c = compare(x, a[0]); return name === 'floor' ? c <= 0 : name === 'ceiling' ? c >= 0 : name === 'lower' ? c < 0 : c > 0; }; const hits = es.filter(ok); return hits.length ? (name === 'floor' || name === 'lower' ? hits.at(-1) : hits[0]) : null; }
    }
    return iterable(v, name, a);
  }
  function arrMethod(v, name, a) {
    const A = v.a;
    switch (name) {
      case 'get': return getIndex(v, [a[0]]);
      case 'set': setIndex(v, [a[0]], a[1]); return UNIT;
      case 'fill': { const f = a.length > 1 ? Number(a[1]) : 0, t = a.length > 2 ? Number(a[2]) : A.length; for (let k = f; k < t; k++) A[k] = a[0]; return UNIT; }
      case 'sort': { const s = stableSort(A, compare); A.splice(0, A.length, ...s); return UNIT; }
      case 'sortDescending': { const s = stableSort(A, (x, y) => compare(y, x)); A.splice(0, A.length, ...s); return UNIT; }
      case 'sortBy': { const f = sel(a[0]); const s = stableSort(A, (x, y) => compare(f(x), f(y))); A.splice(0, A.length, ...s); return UNIT; }
      case 'sortWith': { const s = stableSort(A, cmpOf(a[0])); A.splice(0, A.length, ...s); return UNIT; }
      case 'reverse': A.reverse(); return UNIT;
      case 'contentToString': return '[' + A.map(toStr).join(', ') + ']';
      case 'contentDeepToString': { const deep = x => (x instanceof KArr ? '[' + x.a.map(deep).join(', ') + ']' : toStr(x)); return deep(v); }
      case 'contentEquals': return a[0] instanceof KArr && a[0].a.length === A.length && A.every((x, k) => equals(x, a[0].a[k]));
      case 'copyOf': { const n = a.length ? Number(a[0]) : A.length; return new KArr(v.kind, Array.from({ length: n }, (_, k) => (k < A.length ? A[k] : ARR_ZERO[v.kind] ?? null))); }
      case 'copyOfRange': return new KArr(v.kind, A.slice(Number(a[0]), Number(a[1])));
      case 'clone': return new KArr(v.kind, A.slice());
      case 'asList': return new KList('Arrays$ArrayList', A, false);
      case 'getOrNull': { const k = Number(a[0]); return k >= 0 && k < A.length ? A[k] : null; }
      case 'getOrElse': { const k = Number(a[0]); return k >= 0 && k < A.length ? A[k] : callFn(a[1], [k]); }
      case 'component1': case 'component2': case 'component3': return A[+name.slice(-1) - 1];
      case 'toString': return toStrLib(v);
      case 'equals': return v === a[0];
      case 'hashCode': return identityHash(v);
      case 'sliceArray': return new KArr(v.kind, items(a[0]).map(k => A[Number(k)]));
    }
    return iterable(v, name, a);
  }
  function strMethod(s, name, a) {
    const n = a.length, S = x => (typeof x === 'string' ? x : x instanceof KC ? String.fromCharCode(x.c) : toStr(x));
    const ic = a.names && a.names.includes('ignoreCase') ? a[a.names.indexOf('ignoreCase')] === true : a.at(-1) === true && typeof a.at(-1) === 'boolean';
    const cmpI = (x, y) => (ic ? x.toLowerCase() === y.toLowerCase() : x === y);
    switch (name) {
      case 'get': return getIndex(s, [a[0]]);
      case 'substring': { const f = Number(a[0]), t = n > 1 ? Number(a[1]) : s.length; if (f < 0 || t > s.length || f > t) throwKt('StringIndexOutOfBoundsException', `begin ${f}, end ${t}, length ${s.length}`); return s.slice(f, t); }
      case 'substringBefore': { const k = s.indexOf(S(a[0])); return k < 0 ? (n > 1 ? a[1] : s) : s.slice(0, k); }
      case 'substringAfter': { const k = s.indexOf(S(a[0])); return k < 0 ? (n > 1 ? a[1] : s) : s.slice(k + S(a[0]).length); }
      case 'substringBeforeLast': { const k = s.lastIndexOf(S(a[0])); return k < 0 ? s : s.slice(0, k); }
      case 'substringAfterLast': { const k = s.lastIndexOf(S(a[0])); return k < 0 ? s : s.slice(k + S(a[0]).length); }
      case 'indexOf': return ic ? s.toLowerCase().indexOf(S(a[0]).toLowerCase(), n > 1 && typeof a[1] === 'number' ? a[1] : 0) : s.indexOf(S(a[0]), n > 1 && typeof a[1] === 'number' ? a[1] : 0);
      case 'lastIndexOf': return s.lastIndexOf(S(a[0]));
      case 'contains': return ic ? s.toLowerCase().includes(S(a[0]).toLowerCase()) : s.includes(S(a[0]));
      case 'startsWith': return ic ? s.toLowerCase().startsWith(S(a[0]).toLowerCase()) : s.startsWith(S(a[0]));
      case 'endsWith': return ic ? s.toLowerCase().endsWith(S(a[0]).toLowerCase()) : s.endsWith(S(a[0]));
      case 'equals': return typeof a[0] === 'string' && cmpI(s, a[0]);
      case 'compareTo': return ic ? Math.sign(s.toLowerCase().localeCompare(S(a[0]).toLowerCase())) : (s < a[0] ? -1 : s > a[0] ? 1 : 0) * 1;
      case 'uppercase': case 'toUpperCase': return s.toUpperCase();
      case 'lowercase': case 'toLowerCase': return s.toLowerCase();
      case 'capitalize': case 'replaceFirstChar': return name === 'replaceFirstChar' ? (s ? toStr(callFn(a[0], [KCH(s.charCodeAt(0))])) + s.slice(1) : s) : s.charAt(0).toUpperCase() + s.slice(1);
      case 'trim': return a[0] instanceof KFn ? (() => { let i = 0, j = s.length; while (i < j && callFn(a[0], [KCH(s.charCodeAt(i))])) i++; while (j > i && callFn(a[0], [KCH(s.charCodeAt(j - 1))])) j--; return s.slice(i, j); })() : s.replace(/^[\s\u0000- ]+|[\s\u0000- ]+$/g, '');
      case 'trimStart': return s.replace(/^\s+/, '');
      case 'trimEnd': return s.replace(/\s+$/, '');
      case 'trimIndent': { const lines = s.split('\n'); if (lines.length && !lines[0].trim()) lines.shift(); if (lines.length && !lines.at(-1).trim()) lines.pop(); const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length)); return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n'); }
      case 'trimMargin': { const m = n ? S(a[0]) : '|'; const lines = s.split('\n'); if (lines.length && !lines[0].trim()) lines.shift(); if (lines.length && !lines.at(-1).trim()) lines.pop(); return lines.map(l => { const t = l.trimStart(); return t.startsWith(m) ? t.slice(m.length) : l; }).join('\n'); }
      case 'split': {
        const seps = a.filter((x, k) => typeof x === 'string' || x instanceof KC).map(S);
        const limit = a.names && a.names.includes('limit') ? Number(a[a.names.indexOf('limit')]) : 0;
        if (!seps.length) fail('split needs a delimiter.');
        const out = [];
        let cur = '', k = 0;
        while (k < s.length) { const m = seps.find(p => p && (ic ? s.slice(k, k + p.length).toLowerCase() === p.toLowerCase() : s.startsWith(p, k))); if (m && (!limit || out.length < limit - 1)) { out.push(cur); cur = ''; k += m.length; } else { cur += s[k]; k++; } }
        out.push(cur);
        return mlist(out);
      }
      case 'lines': return mlist(s.split(/\r?\n/));
      case 'replace': return n >= 2 && (typeof a[0] === 'string' || a[0] instanceof KC) ? (ic ? s.replace(new RegExp(S(a[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), S(a[1])) : s.split(S(a[0])).join(S(a[1]))) : s;
      case 'replaceFirst': return s.replace(S(a[0]), S(a[1]));
      case 'repeat': { const k = Number(a[0]); if (k < 0) throwKt('IllegalArgumentException', `Count 'n' must be non-negative, but was ${k}.`); return s.repeat(k); }
      case 'reversed': return [...s].reverse().join('');
      case 'padStart': case 'padEnd': { const w = Number(a[0]), c = n > 1 ? S(a[1]) : ' '; return name === 'padStart' ? s.padStart(w, c) : s.padEnd(w, c); }
      case 'removePrefix': return s.startsWith(S(a[0])) ? s.slice(S(a[0]).length) : s;
      case 'removeSuffix': return s.endsWith(S(a[0])) ? s.slice(0, s.length - S(a[0]).length) : s;
      case 'removeSurrounding': { const p = S(a[0]), q = n > 1 ? S(a[1]) : p; return s.length >= p.length + q.length && s.startsWith(p) && s.endsWith(q) ? s.slice(p.length, s.length - q.length) : s; }
      case 'toInt': case 'toIntOrNull': case 'toLong': case 'toLongOrNull': {
        const radix = n ? Number(a[0]) : 10, t = s;
        const ok = radix === 10 ? /^[+-]?\d+$/.test(t) : /^[+-]?[0-9a-z]+$/i.test(t) && [...t.replace(/^[+-]/, '').toLowerCase()].every(c => parseInt(c, 36) < radix);
        const isLong = name.startsWith('toLong');
        let v = null;
        if (ok) { const neg = t.startsWith('-'); const digits = t.replace(/^[+-]/, ''); let b = 0n; for (const c of digits.toLowerCase()) b = b * BigInt(radix) + BigInt(parseInt(c, 36)); if (neg) b = -b; if (isLong ? b >= -(2n ** 63n) && b < 2n ** 63n : b >= -2147483648n && b <= 2147483647n) v = isLong ? b : Number(b); }
        if (v === null && !name.endsWith('OrNull')) throwKt('NumberFormatException', `For input string: "${s}"` + (radix !== 10 ? ` under radix ${radix}` : ''));
        return v;
      }
      case 'toDouble': case 'toDoubleOrNull': case 'toFloat': case 'toFloatOrNull': {
        const t = s.trim();
        const v = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(t) ? Number(t.replace(/[fFdD]$/, '')) : /^[+-]?(Infinity|NaN)$/.test(t) ? Number(t) : null;
        if (v === null) { if (name.endsWith('OrNull')) return null; throwKt('NumberFormatException', s.trim() === '' ? 'empty String' : `For input string: "${s}"`); }
        return new D(v, name.startsWith('toFloat'));
      }
      case 'toBoolean': return s.toLowerCase() === 'true';
      case 'toBooleanStrict': if (s === 'true' || s === 'false') return s === 'true'; throwKt('IllegalArgumentException', `The string doesn't represent a boolean value: ${s}`);
      // falls through
      case 'toCharArray': return new KArr('CharArray', [...Array(s.length)].map((_, k) => KCH(s.charCodeAt(k))));
      case 'isEmpty': return s.length === 0;
      case 'isNotEmpty': return s.length > 0;
      case 'isBlank': return !s.trim();
      case 'isNotBlank': return !!s.trim();
      case 'isNullOrEmpty': return !s.length;
      case 'isNullOrBlank': return !s.trim();
      case 'orEmpty': return s;
      case 'ifEmpty': return s.length ? s : callFn(a[0], []);
      case 'ifBlank': return s.trim() ? s : callFn(a[0], []);
      case 'format': return format(s, a);
      case 'toString': return s;
      case 'hashCode': return hashOf(s);
      case 'chunked': { const k = Number(a[0]), out = []; for (let j = 0; j < s.length; j += k) out.push(s.slice(j, j + k)); return mlist(a[1] ? out.map(x => callFn(a[1], [x])) : out); }
      case 'windowed': { const k = Number(a[0]), out = []; for (let j = 0; j + k <= s.length; j++) out.push(s.slice(j, j + k)); return mlist(out); }
      case 'take': return s.slice(0, Number(a[0]));
      case 'drop': return s.slice(Number(a[0]));
      case 'takeLast': return s.slice(Math.max(0, s.length - Number(a[0])));
      case 'dropLast': return s.slice(0, Math.max(0, s.length - Number(a[0])));
      case 'takeWhile': { let k = 0; while (k < s.length && callFn(a[0], [KCH(s.charCodeAt(k))])) k++; return s.slice(0, k); }
      case 'dropWhile': { let k = 0; while (k < s.length && callFn(a[0], [KCH(s.charCodeAt(k))])) k++; return s.slice(k); }
      case 'filter': { const p = pred(a[0]); return [...Array(s.length)].map((_, k) => KCH(s.charCodeAt(k))).filter(p).map(c => String.fromCharCode(c.c)).join(''); }
      case 'filterNot': { const p = pred(a[0]); return [...Array(s.length)].map((_, k) => KCH(s.charCodeAt(k))).filter(c => !p(c)).map(c => String.fromCharCode(c.c)).join(''); }
      case 'lowercaseChar': case 'first': if (!a.length && name === 'first') { if (!s.length) noSuch('Char sequence is empty.'); return KCH(s.charCodeAt(0)); } break;
      case 'last': if (!a.length) { if (!s.length) noSuch('Char sequence is empty.'); return KCH(s.charCodeAt(s.length - 1)); } break;
      case 'lastIndex': return s.length - 1;
      case 'encodeToByteArray': return new KArr('ByteArray', [...new TextEncoder().encode(s)].map(b => (b << 24) >> 24));
      case 'matches': fail('regular expressions are not supported here.');
      // falls through
      case 'codePointAt': return s.codePointAt(Number(a[0]));
      case 'count': if (!a.length) return s.length; break;
      case 'commonPrefixWith': { let k = 0; const o = S(a[0]); while (k < s.length && k < o.length && s[k] === o[k]) k++; return s.slice(0, k); }
    }
    return iterable(s, name, a);
  }
  const CHAR_PROPS = new Set(['code']);
  function charMethod(c, name, a) {
    const s = String.fromCharCode(c.c);
    switch (name) {
      case 'isDigit': return /\p{Nd}/u.test(s);
      case 'isLetter': return /\p{L}/u.test(s);
      case 'isLetterOrDigit': return /[\p{L}\p{Nd}]/u.test(s);
      case 'isUpperCase': return /\p{Lu}/u.test(s);
      case 'isLowerCase': return /\p{Ll}/u.test(s);
      case 'isWhitespace': return /\s/.test(s);
      case 'uppercaseChar': case 'toUpperCase': return KCH(s.toUpperCase().length === 1 ? s.toUpperCase().charCodeAt(0) : c.c);
      case 'lowercaseChar': case 'toLowerCase': return KCH(s.toLowerCase().length === 1 ? s.toLowerCase().charCodeAt(0) : c.c);
      case 'uppercase': return s.toUpperCase();
      case 'lowercase': return s.toLowerCase();
      case 'digitToInt': { const d = parseInt(s, a.length ? Number(a[0]) : 10); if (Number.isNaN(d)) throwKt('IllegalArgumentException', `Char ${s} is not a decimal digit`); return d; }
      case 'digitToIntOrNull': { const d = parseInt(s, 10); return Number.isNaN(d) ? null : d; }
      case 'toInt': return c.c;
      case 'toString': return s;
      case 'toLong': return BigInt(c.c);
      case 'toDouble': return new D(c.c);
      case 'compareTo': return Math.sign(c.c - a[0].c);
      case 'equals': return a[0] instanceof KC && (a[1] === true ? s.toLowerCase() === String.fromCharCode(a[0].c).toLowerCase() : a[0].c === c.c);
      case 'plus': return a[0] instanceof KC ? fail("none of the following candidates is applicable: Char + Char (use a String: \"\" + a + b)") : typeof a[0] === 'string' ? s + a[0] : KCH(c.c + Number(a[0]));
      case 'minus': return a[0] instanceof KC ? c.c - a[0].c : KCH(c.c - Number(a[0]));
      case 'rangeTo': return range(c, a[0], false);
      case 'hashCode': return c.c;
      case 'isSurrogate': return c.c >= 0xd800 && c.c <= 0xdfff;
      case 'titlecase': return s.toUpperCase();
    }
    fail(`unresolved reference '${name}'.`);
  }
  function numMethod(v, name, a) {
    const k = kindOf(v);
    const x = typeof v === 'object' ? v.v : v;
    switch (name) {
      case 'toInt': if (k === 'Double' || k === 'Float') return Number.isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x); return k === 'Long' ? Number(BigInt.asIntN(32, v)) : v;
      case 'toLong': if (k === 'Double' || k === 'Float') return Number.isNaN(x) ? 0n : x >= 9.223372036854776e18 ? 9223372036854775807n : x <= -9.223372036854776e18 ? -9223372036854775808n : BigInt(Math.trunc(x)); return BigInt(v);
      case 'toDouble': return new D(Number(x));
      case 'toFloat': return new D(Number(x), true);
      case 'toShort': return Number(BigInt.asIntN(16, BigInt(Math.trunc(Number(x)))));
      case 'toByte': return Number(BigInt.asIntN(8, BigInt(Math.trunc(Number(x)))));
      case 'toChar': return KCH(Number(BigInt.asUintN(16, BigInt(Math.trunc(Number(x))))));
      case 'toString': return a.length && k !== 'Double' ? (typeof v === 'bigint' ? v : BigInt(v)).toString(Number(a[0])) : toStr(v);
      case 'roundToInt': if (Number.isNaN(x)) throwKt('IllegalArgumentException', 'Cannot round NaN value.'); return Math.max(-2147483648, Math.min(2147483647, Math.floor(x + 0.5)));
      case 'roundToLong': return BigInt(Math.floor(x + 0.5));
      case 'coerceIn': return compare(v, a[0]) < 0 ? a[0] : compare(v, a[1]) > 0 ? a[1] : v;
      case 'coerceAtLeast': return compare(v, a[0]) < 0 ? a[0] : v;
      case 'coerceAtMost': return compare(v, a[0]) > 0 ? a[0] : v;
      case 'pow': { if (k !== 'Double' && k !== 'Float') fail(`unresolved reference 'pow' for '${ktType(v)}' (pow is a Double function: x.toDouble().pow(n)).`); return new D(x ** num(a[0]), v.f); }
      case 'compareTo': return compare(v, a[0]);
      case 'equals': return equals(v, a[0]);
      case 'hashCode': return hashOf(v);
      case 'isNaN': return Number.isNaN(x);
      case 'isInfinite': return !Number.isFinite(x) && !Number.isNaN(x);
      case 'isFinite': return Number.isFinite(x);
      case 'inv': return typeof v === 'bigint' ? ~v : ~v;
      case 'rem': return api.rval({ k: 'bin', op: '%', l: { k: 'const', v }, r: { k: 'const', v: a[0] } });
      case 'mod': { if (k === 'Int' && isInt(a[0])) { if (a[0] === 0) throwKt('ArithmeticException', '/ by zero'); const r = v % a[0]; return r !== 0 && (r < 0) !== (a[0] < 0) ? r + a[0] : r; } if (k === 'Long') { const r = v % BigInt(a[0]); return r !== 0n && (r < 0n) !== (BigInt(a[0]) < 0n) ? r + BigInt(a[0]) : r; } const r = x % num(a[0]); return new D(r !== 0 && (r < 0) !== (num(a[0]) < 0) ? r + num(a[0]) : r); }
      case 'floorDiv': return Math.floor(Number(v) / Number(a[0]));
      case 'countOneBits': { let n = 0, y = v >>> 0; while (y) { n += y & 1; y >>>= 1; } return n; }
      case 'plus': case 'minus': case 'times': case 'div': return api.rval({ k: 'bin', op: { plus: '+', minus: '-', times: '*', div: '/' }[name], l: { k: 'const', v }, r: { k: 'const', v: a[0] } });
      case 'until': case 'downTo': case 'rangeTo': return infix(name, v, a[0]);
      case 'shl': case 'shr': case 'ushr': case 'and': case 'or': case 'xor': return infix(name, v, a[0]);
      case 'absoluteValue': return absOf(v);
      case 'toBigInteger': fail('BigInteger is not supported here (a Long holds 19 digits).');
    }
    fail(`unresolved reference '${name}'.`);
  }
  const absOf = v => (typeof v === 'number' ? (v === -2147483648 ? v : Math.abs(v)) : typeof v === 'bigint' ? (v < 0n ? BigInt.asIntN(64, -v) : v) : new D(Math.abs(v.v), v.f));

  /** obj.name(args) on a value of the library (or a number, a string, a char) */
  function callMethod(v, name, a, e, targs) {
    if (targs && targs.length) a.targ = targs[0];
    if (e && e.args) a.names = e.args.map(x => x.name);
    // scope functions: let, also, apply, run, takeIf, takeUnless
    switch (name) {
      case 'let': case 'run': return callFn(a[0], [v]);
      case 'also': callFn(a[0], [v]); return v;
      case 'apply': { const f = a[0]; api.invoke(Object.assign(Object.create(Object.getPrototypeOf(f)), f, { selfAt: v }), [], v, null); return v; }
      case 'takeIf': return callFn(a[0], [v]) === true ? v : null;
      case 'takeUnless': return callFn(a[0], [v]) === true ? null : v;
      case 'toString': if (v === null) return 'null'; break;
      case 'isNullOrEmpty': if (v === null) return true; break;
      case 'isNullOrBlank': if (v === null) return true; break;
      case 'orEmpty': if (v === null) return a.targ ? mlist([]) : ''; break;
      case 'equals': if (v === null) return a[0] === null; break;
      case 'hashCode': if (v === null) return 0; break;
    }
    if (v === null || v === undefined) npe();
    if (typeof v === 'string') return strMethod(v, name, a);
    if (v instanceof KC) return charMethod(v, name, a);
    if (typeof v === 'number' || typeof v === 'bigint' || v instanceof D) return numMethod(v, name, a);
    if (typeof v === 'boolean') { if (name === 'not') return !v; if (name === 'toString') return String(v); if (name === 'and') return v && a[0]; if (name === 'or') return v || a[0]; if (name === 'xor') return v !== a[0]; if (name === 'compareTo') return v === a[0] ? 0 : v ? 1 : -1; if (name === 'equals') return v === a[0]; if (name === 'hashCode') return v ? 1231 : 1237; }
    if (v instanceof KDeque) return orFail(dequeMethod(v, name, a), v, name);
    if (v instanceof KList) return orFail(listMethod(v, name, a), v, name);
    if (v instanceof KMap) return orFail(mapMethod(v, name, a), v, name);
    if (v instanceof KSet) return orFail(setMethod(v, name, a), v, name);
    if (v instanceof KArr) return orFail(arrMethod(v, name, a), v, name);
    if (v instanceof KPQ) return orFail(pqMethod(v, name, a), v, name);
    if (v instanceof KSB) {
      switch (name) {
        case 'append': v.s += a[0] instanceof KArr ? a[0].a.map(toStr).join('') : toStr(a[0]); return v;
        case 'appendLine': v.s += (a.length ? toStr(a[0]) : '') + '\n'; return v;
        case 'insert': { const k = Number(a[0]); if (k < 0 || k > v.s.length) throwKt('StringIndexOutOfBoundsException', `offset ${k}, length ${v.s.length}`); v.s = v.s.slice(0, k) + toStr(a[1]) + v.s.slice(k); return v; }
        case 'reverse': v.s = [...v.s].reverse().join(''); return v;
        case 'deleteCharAt': { const k = Number(a[0]); if (k < 0 || k >= v.s.length) throwKt('StringIndexOutOfBoundsException', `index ${k},length ${v.s.length}`); v.s = v.s.slice(0, k) + v.s.slice(k + 1); return v; }
        case 'delete': case 'deleteRange': v.s = v.s.slice(0, Number(a[0])) + v.s.slice(Number(a[1])); return v;
        case 'setLength': v.s = v.s.slice(0, Number(a[0])).padEnd(Number(a[0]), '\0'); return UNIT;
        case 'setCharAt': case 'set': v.s = v.s.slice(0, Number(a[0])) + toStr(a[1]) + v.s.slice(Number(a[0]) + 1); return UNIT;
        case 'clear': v.s = ''; return v;
        case 'toString': return v.s;
        case 'get': return KCH(v.s.charCodeAt(idx(v.s.length, a[0])));
        case 'indexOf': return v.s.indexOf(toStr(a[0]));
        case 'isEmpty': return !v.s.length;
        case 'isNotEmpty': return v.s.length > 0;
      }
      return strMethod(v.s, name, a);
    }
    if (v instanceof KRange) {
      switch (name) {
        case 'contains': return contains(v, a[0]);
        case 'reversed': return new KRange(v.last, v.first, -v.step, v.kind);
        case 'step': return infix('step', v, a[0]);
        case 'isEmpty': return v.step > 0 ? compare(v.first, v.last) > 0 : compare(v.first, v.last) < 0;
        case 'random': { const xs = items(v); if (!xs.length) noSuch('Cannot get random in empty range: ' + toStrLib(v)); return xs[(a[0] instanceof KRandom ? a[0] : new KRandom()).below(0, xs.length)]; }
        case 'count': if (!a.length) return items(v).length; break;
      }
      return orFail(iterable(v, name, a), v, name);
    }
    if (v instanceof KPair || v instanceof KTriple) {
      switch (name) {
        case 'toList': return listOf(v instanceof KPair ? [v.a, v.b] : [v.a, v.b, v.c]);
        case 'copy': return v instanceof KPair ? pair(a.names && a.names[0] === 'second' ? v.a : a[0] ?? v.a, a.names && a.names[0] === 'second' ? a[0] : a[1] ?? v.b) : new KTriple(a[0] ?? v.a, a[1] ?? v.b, a[2] ?? v.c);
        case 'component1': return v.a; case 'component2': return v.b; case 'component3': return v.c;
        case 'toString': return toStrLib(v);
        case 'equals': return equals(v, a[0]);
        case 'hashCode': return libHash(v);
      }
    }
    if (v instanceof KEntry) { if (name === 'component1') return v.en.k; if (name === 'component2') return v.en.v; if (name === 'toPair') return pair(v.en.k, v.en.v); if (name === 'setValue') { const o = v.en.v; v.en.v = a[0]; return o; } if (name === 'toString') return toStrLib(v); }
    if (v instanceof KIndexed) { if (name === 'component1') return v.i; if (name === 'component2') return v.v; }
    if (v instanceof KView || v instanceof KSeq) {
      if (v instanceof KView && name === 'remove') { const en = v.map.e.find(x => equals(v.part === 'k' ? x.k : x.v, a[0])); if (!en) return false; v.map.remove(en.k); return true; }
      if (v instanceof KSeq && (name === 'next' || name === 'hasNext')) fail('iterators are not supported here: use for (x in …).');
      return orFail(iterable(v, name, a), v, name);
    }
    if (v instanceof KCmp) { const r = cmpMethod(v, name, a); if (r !== undefined) return r; }
    if (v instanceof KFn) { if (name === 'invoke') return callFn(v, a); const r = cmpMethod(v, name, a); if (r !== undefined) return r; }
    if (v instanceof KRandom) {
      switch (name) {
        case 'nextInt': return a.length === 0 ? v.nextInt() : a.length === 1 ? (a[0] instanceof KRange ? v.below(a[0].first, a[0].last + 1) : v.below(0, Number(a[0]))) : v.below(Number(a[0]), Number(a[1]));
        case 'nextDouble': { const d = v.nextDouble(); return new D(a.length === 0 ? d : a.length === 1 ? d * num(a[0]) : num(a[0]) + d * (num(a[1]) - num(a[0]))); }
        case 'nextBoolean': return v.bits(1) !== 0;
        case 'nextLong': return BigInt(v.nextInt());
      }
    }
    if (v instanceof KGrouping) {
      const m = new KMap('LinkedHashMap');
      for (const x of items(v.src)) { const k = v.key(x); const en = m.get(k); if (name === 'eachCount') m.put(k, en ? en.v + 1 : 1); else if (name === 'fold') m.put(k, callFn(a[1], [en ? en.v : a[0], x])); else if (name === 'reduce') m.put(k, en ? callFn(a[0], [k, en.v, x]) : x); else fail(`unresolved reference '${name}'.`); }
      return m;
    }
    if (v === UNIT) { if (name === 'toString') return 'kotlin.Unit'; }
    fail(`unresolved reference '${name}'.`);
  }
  const orFail = (r, v, name) => (r !== undefined ? r : fail(`unresolved reference '${name}'.` + (v instanceof KList && name === 'length' ? ' (a List has size)' : v instanceof KArr && name === 'length' ? ' (an array has size)' : v instanceof KMap && name === 'add' ? ' (a map has put, or map[key] = value)' : '')));

  /* ---- properties ---- */
  function getProp(v, n) {
    if (v === null || v === undefined) npe();
    if (typeof v === 'string') { if (n === 'length') return v.length; if (n === 'indices') return new KRange(0, v.length - 1, 1, 'Int'); if (n === 'lastIndex') return v.length - 1; }
    if (v instanceof KC) { if (n === 'code') return v.c; if (n === 'category') fail('Char.category is not supported here.'); }
    if (typeof v === 'number' || typeof v === 'bigint' || v instanceof D) { if (n === 'absoluteValue') return absOf(v); if (n === 'sign') return typeof v === 'object' ? new D(Math.sign(v.v)) : typeof v === 'bigint' ? (v > 0n ? 1 : v < 0n ? -1 : 0) : Math.sign(v); }
    if (v instanceof KList || v instanceof KDeque) { if (n === 'size') return v.a.length; if (n === 'indices') return new KRange(0, v.a.length - 1, 1, 'Int'); if (n === 'lastIndex') return v.a.length - 1; }
    if (v instanceof KArr) { if (n === 'size') return v.a.length; if (n === 'indices') return new KRange(0, v.a.length - 1, 1, 'Int'); if (n === 'lastIndex') return v.a.length - 1; }
    if (v instanceof KSet) { if (n === 'size') return v.m.size; }
    if (v instanceof KMap) { if (n === 'size') return v.size; if (n === 'keys') return new KView(v, 'k'); if (n === 'values') return new KView(v, 'v'); if (n === 'entries') return new KView(v, 'e'); }
    if (v instanceof KView) { if (n === 'size') return v.map.size; }
    if (v instanceof KPQ) { if (n === 'size') return v.q.length; }
    if (v instanceof KSB) { if (n === 'length') return v.s.length; }
    if (v instanceof KEntry) { if (n === 'key') return v.en.k; if (n === 'value') return v.en.v; }
    if (v instanceof KPair || v instanceof KTriple) { if (n === 'first') return v.a; if (n === 'second') return v.b; if (n === 'third' && v instanceof KTriple) return v.c; }
    if (v instanceof KIndexed) { if (n === 'index') return v.i; if (n === 'value') return v.v; }
    if (v instanceof KRange) { if (n === 'first' || n === 'start') return v.first; if (n === 'last' || n === 'endInclusive') return v.last; if (n === 'step') return v.step; }
    fail(`unresolved reference '${n}'.` + (v instanceof KList && n === 'length' ? ' (a List has size)' : typeof v === 'string' && n === 'size' ? ' (a String has length)' : v instanceof KArr && n === 'length' ? ' (an array has size)' : ''));
  }
  function setProp(v, n, x) {
    if (v instanceof KSB && n === 'length') { v.s = v.s.slice(0, Number(x)); return; }
    if (v instanceof KEntry && n === 'value') { v.en.v = x; return; }
    fail(`'val' cannot be reassigned.`);
  }
  /** v[k] */
  function getIndex(c, ks) {
    const k = ks[0];
    if (c instanceof KList || c instanceof KDeque) {
      const i = Number(k);
      if (i < 0 || i >= c.a.length) throwKt(c.kind === 'Arrays$ArrayList' || c.kind === 'SingletonList' || c.kind === 'EmptyList' ? (c.kind === 'EmptyList' ? 'IndexOutOfBoundsException' : 'ArrayIndexOutOfBoundsException') : 'IndexOutOfBoundsException', c.kind === 'EmptyList' ? `Empty list doesn't contain element at index ${i}.` : `Index ${i} out of bounds for length ${c.a.length}`);
      return c.a[i];
    }
    if (c instanceof KArr) { const i = Number(k); if (i < 0 || i >= c.a.length) throwKt('ArrayIndexOutOfBoundsException', `Index ${i} out of bounds for length ${c.a.length}`); return c.a[i]; }
    if (typeof c === 'string') { const i = Number(k); if (i < 0 || i >= c.length) throwKt('StringIndexOutOfBoundsException', `Index ${i} out of bounds for length ${c.length}`); return KCH(c.charCodeAt(i)); }
    if (c instanceof KMap) { const en = c.get(k); return en ? en.v : null; }
    if (c instanceof KSB) { const i = Number(k); if (i < 0 || i >= c.s.length) throwKt('StringIndexOutOfBoundsException', `index ${i},length ${c.s.length}`); return KCH(c.s.charCodeAt(i)); }
    if (c instanceof KSet) fail("unresolved reference 'get' (a Set has no positions: use contains, or for (x in set)).");
    fail(`unresolved reference 'get' (a ${ktType(c)} cannot be indexed with [ ]).`);
  }
  function setIndex(c, ks, v) {
    const k = ks[0];
    if (c instanceof KList || c instanceof KDeque) { if (!c.mutable) fail("unresolved reference 'set' (a List made by listOf cannot be changed: use mutableListOf)."); const i = Number(k); if (i < 0 || i >= c.a.length) throwKt('IndexOutOfBoundsException', `Index ${i} out of bounds for length ${c.a.length}`); c.a[i] = v; return; }
    if (c instanceof KArr) { const i = Number(k); if (i < 0 || i >= c.a.length) throwKt('ArrayIndexOutOfBoundsException', `Index ${i} out of bounds for length ${c.a.length}`); c.a[i] = checkElem(c, v); return; }
    if (c instanceof KMap) { if (!c.mutable) fail("unresolved reference 'set' (a Map made by mapOf cannot be changed: use mutableMapOf)."); c.put(k, v); return; }
    if (c instanceof KSB) { const i = Number(k); c.s = c.s.slice(0, i) + toStr(v) + c.s.slice(i + 1); return; }
    if (typeof c === 'string') fail("unresolved reference 'set' (a String cannot be changed: build a new one, or use a StringBuilder).");
    fail(`unresolved reference 'set' (a ${ktType(c)} cannot be indexed with [ ]).`);
  }
  /** an IntArray holds Ints only */
  function checkElem(c, v) {
    const want = { IntArray: 'Int', LongArray: 'Long', DoubleArray: 'Double', BooleanArray: 'Boolean', CharArray: 'Char', FloatArray: 'Float' }[c.kind];
    if (want && kindOf(v) !== want) fail(`assignment type mismatch: actual type is '${ktType(v)}', but 'kotlin.${want}' was expected.`);
    return v;
  }
  const elemType = () => null;

  /* ---- ranges, in, infix functions ---- */
  function range(a, b, excl) {
    const ka = kindOf(a), kb = kindOf(b);
    if (ka === 'Char' && kb === 'Char') return new KRange(a, excl ? KCH(b.c - 1) : b, 1, 'Char');
    if (ka === 'Long' || kb === 'Long') return new KRange(BigInt(a), excl ? BigInt(b) - 1n : BigInt(b), 1, 'Long');
    if (ka === 'Int' && kb === 'Int') return new KRange(a, excl ? b - 1 : b, 1, 'Int');
    if ((ka === 'Double' || ka === 'Int') && (kb === 'Double' || kb === 'Int')) return { closedRange: true, a: num(a), b: num(b), toString: () => `${javaDouble(num(a))}..${javaDouble(num(b))}` };
    if (ka === 'String' && kb === 'String') return { closedRange: true, a, b, str: true };
    fail(`unresolved reference 'rangeTo' for '${ktType(a)}'.`);
  }
  function contains(r, x) {
    if (r instanceof KRange) {
      if (r.kind === 'Char') { if (!(x instanceof KC)) return false; const lo = Math.min(r.first.c, r.last.c), hi = Math.max(r.first.c, r.last.c); return x.c >= lo && x.c <= hi && (x.c - r.first.c) % r.step === 0; }
      if (x instanceof D) return x.v >= Number(r.step > 0 ? r.first : r.last) && x.v <= Number(r.step > 0 ? r.last : r.first);
      if (typeof x !== 'number' && typeof x !== 'bigint') return false;
      const v = BigInt(x), f = BigInt(r.first), l = BigInt(r.last), st = BigInt(r.step);
      return st > 0n ? v >= f && v <= l && (v - f) % st === 0n : v <= f && v >= l && (f - v) % -st === 0n;
    }
    if (r && r.closedRange) return r.str ? x >= r.a && x <= r.b : num(x) >= r.a && num(x) <= r.b;
    if (typeof r === 'string') return r.includes(x instanceof KC ? String.fromCharCode(x.c) : toStr(x));
    if (r instanceof KMap) return !!r.get(x);
    if (r instanceof KSet) return r.m.find(x).hit;
    if (r === null) npe();
    return items(r).some(y => equals(y, x));
  }
  function infix(name, a, b, e) {
    switch (name) {
      case 'to': return pair(a, b);
      case 'until': if (a instanceof KC) return new KRange(a, KCH(b.c - 1), 1, 'Char'); if (typeof a === 'bigint' || typeof b === 'bigint') return new KRange(BigInt(a), BigInt(b) - 1n, 1, 'Long'); return new KRange(a, b - 1, 1, 'Int');
      case 'downTo': return new KRange(a, b, -1, a instanceof KC ? 'Char' : typeof a === 'bigint' ? 'Long' : 'Int');
      case 'step': {
        if (!(a instanceof KRange)) fail(`unresolved reference 'step' for '${ktType(a)}'.`);
        const st = Number(b);
        if (st <= 0) throwKt('IllegalArgumentException', `Step must be positive, was: ${st}.`);
        const s = a.step > 0 ? st : -st;
        // the last element is the last one the steps reach, as Kotlin computes it
        const f = a.kind === 'Char' ? a.first.c : Number(a.first), l = a.kind === 'Char' ? a.last.c : Number(a.last);
        let last = l;
        if (s > 0 && l >= f) last = l - ((l - f) % s); else if (s < 0 && l <= f) last = l + ((f - l) % -s);
        return new KRange(a.first, a.kind === 'Char' ? KCH(last) : a.kind === 'Long' ? BigInt(last) : last, s, a.kind);
      }
      case 'shl': return typeof a === 'bigint' ? BigInt.asIntN(64, a << BigInt(Number(b) & 63)) : a << (b & 31);
      case 'shr': return typeof a === 'bigint' ? a >> BigInt(Number(b) & 63) : a >> (b & 31);
      case 'ushr': return typeof a === 'bigint' ? BigInt.asIntN(64, BigInt.asUintN(64, a) >> BigInt(Number(b) & 63)) : (a >>> (b & 31)) | 0;
      case 'and': return typeof a === 'boolean' ? a && b : typeof a === 'bigint' ? a & BigInt(b) : a & b;
      case 'or': return typeof a === 'boolean' ? a || b : typeof a === 'bigint' ? a | BigInt(b) : a | b;
      case 'xor': return typeof a === 'boolean' ? a !== b : typeof a === 'bigint' ? a ^ BigInt(b) : a ^ b;
      case 'zip': return iterable(a, 'zip', [b]);
      case 'union': case 'intersect': case 'subtract': return iterable(a, name, [b]);
      case 'rangeTo': return range(a, b, false);
      case 'compareTo': return compare(a, b);
      case 'in': return contains(b, a);
      case 'then': case 'thenBy': return cmpMethod(a, name, [b]);
      case 'rem': case 'mod': return numMethod(a, name, [b]);
    }
    fail(`unresolved reference '${name}'.`);
    void e;
  }
  /** list + x and friends, when + is not a number's */
  function collOp(a, op, b) {
    if (op === '+' && (a instanceof KList || a instanceof KSet || a instanceof KArr)) { const r = iterable(a, 'plus', [b]); return a instanceof KArr ? new KArr(a.kind, items(r)) : r; }
    if (op === '-' && (a instanceof KList || a instanceof KSet)) return iterable(a, 'minus', [b]);
    if (a instanceof KMap && op === '+') return mapMethod(a, 'plus', [b]);
    if (a instanceof KMap && op === '-') return mapMethod(a, 'minus', [b]);
    if (a instanceof KSB && op === '+') return a.s + toStr(b);
    return undefined;
  }
  /** list += x (on a mutable list), set += x, map += pair */
  function plusAssign(cur, op, r) {
    if ((cur instanceof KList || cur instanceof KDeque) && cur.mutable) { cur.mod++; if (op === '+') { if (r instanceof KList || r instanceof KSet || r instanceof KArr || r instanceof KRange) cur.a.push(...items(r)); else cur.a.push(r); } else { const k = cur.a.findIndex(x => equals(x, r)); if (k >= 0) cur.a.splice(k, 1); } return true; }
    if (cur instanceof KSet && cur.mutable) { for (const x of r instanceof KList || r instanceof KSet ? items(r) : [r]) if (op === '+') cur.m.put(x, true); else cur.m.remove(x); return true; }
    if (cur instanceof KMap && cur.mutable && op === '+') { for (const p of r instanceof KPair ? [r] : items(r)) cur.put(p.a, p.b); return true; }
    if (cur instanceof KMap && cur.mutable && op === '-') { cur.remove(r); return true; }
    return false;
  }

  /* ---- the global functions: println, listOf, mutableMapOf, repeat, maxOf… ---- */
  const STATIC = new Set(['Math', 'Int', 'Long', 'Double', 'Float', 'Char', 'String', 'Integer', 'Collections', 'Arrays', 'System', 'Character', 'Comparator', 'Boolean', 'Short', 'Byte', 'Random', 'Character']);
  function staticMember(h, n) {
    const MM = { Int: [2147483647, -2147483648], Long: [9223372036854775807n, -9223372036854775808n], Short: [32767, -32768], Byte: [127, -128] };
    if (MM[h] && (n === 'MAX_VALUE' || n === 'MIN_VALUE')) return MM[h][n === 'MAX_VALUE' ? 0 : 1];
    if (h === 'Integer' && (n === 'MAX_VALUE' || n === 'MIN_VALUE')) return MM.Int[n === 'MAX_VALUE' ? 0 : 1];
    if (h === 'Double' || h === 'Float') { const f = h === 'Float'; const V = { MAX_VALUE: f ? 3.4028234663852886e38 : Number.MAX_VALUE, MIN_VALUE: f ? 1.401298464324817e-45 : Number.MIN_VALUE, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN }; if (n in V) return new D(V[n], f); }
    if (h === 'Char' && (n === 'MAX_VALUE' || n === 'MIN_VALUE')) return KCH(n === 'MAX_VALUE' ? 0xffff : 0);
    if (h === 'Math') { if (n === 'PI') return new D(Math.PI); if (n === 'E') return new D(Math.E); }
    if (h === 'Int' && n === 'SIZE_BITS') return 32;
    if (h === 'Random' && n === 'Default') return new KRandom();
    return new KFn({ name: h + '.' + n, native: argv => callStatic(h, n, argv, null) });
  }
  function callStatic(h, n, a) {
    const x = k => num(a[k]);
    if (h === 'Math') {
      switch (n) {
        case 'max': case 'min': { const [p, q] = a; if (kindOf(p) !== kindOf(q)) fail(`none of the following candidates is applicable: Math.${n}(${ktType(p)}, ${ktType(q)}).`); if (p instanceof D) return new D(n === 'max' ? Math.max(p.v, q.v) : Math.min(p.v, q.v)); return compare(p, q) >= 0 === (n === 'max') ? p : q; }
        case 'abs': return absOf(a[0]);
        case 'sqrt': case 'cbrt': case 'floor': case 'ceil': case 'log': case 'log10': case 'exp': case 'sin': case 'cos': case 'tan': case 'atan': case 'asin': case 'acos': {
          if (!(a[0] instanceof D) && !(typeof a[0] === 'number')) fail(`argument type mismatch: actual type is '${ktType(a[0])}', but 'kotlin.Double' was expected.`);
          if (typeof a[0] === 'number') { /* Java's Math takes an int where a double is wanted */ }
          return new D(Math[n](x(0)));
        }
        case 'pow': return new D(x(0) ** x(1));
        case 'round': return a[0] instanceof D && a[0].f ? Math.floor(x(0) + 0.5) : BigInt(Math.floor(x(0) + 0.5));
        case 'atan2': return new D(Math.atan2(x(0), x(1)));
        case 'hypot': return new D(Math.hypot(x(0), x(1)));
        case 'signum': return new D(Math.sign(x(0)));
        case 'floorMod': { const p = Number(a[0]), q = Number(a[1]); return ((p % q) + q) % q; }
        case 'floorDiv': return Math.floor(Number(a[0]) / Number(a[1]));
        case 'random': return new D(Math.random());
        case 'toRadians': return new D(x(0) * Math.PI / 180);
        case 'addExact': case 'multiplyExact': { const r = n === 'addExact' ? a[0] + a[1] : a[0] * a[1]; if ((r | 0) !== r) throwKt('ArithmeticException', 'integer overflow'); return r; }
      }
    }
    if (h === 'Integer' || h === 'Int') {
      if (n === 'parseInt' || n === 'valueOf') return strMethod(a[0], 'toInt', a.slice(1));
      if (n === 'toBinaryString') return (a[0] >>> 0).toString(2);
      if (n === 'toHexString') return (a[0] >>> 0).toString(16);
      if (n === 'max' || n === 'min') return n === 'max' ? Math.max(a[0], a[1]) : Math.min(a[0], a[1]);
      if (n === 'bitCount') return numMethod(a[0], 'countOneBits', []);
    }
    if (h === 'Long' && n === 'parseLong') return strMethod(a[0], 'toLong', a.slice(1));
    if (h === 'Double' && n === 'parseDouble') return strMethod(a[0], 'toDouble', []);
    if (h === 'String') { if (n === 'format') return format(a[0], a.slice(1)); if (n === 'valueOf') return toStr(a[0]); if (n === 'join') return items(a[1] instanceof KList ? a[1] : listOf(a.slice(1))).map(toStr).join(a[0]); }
    if (h === 'Character') { const c = a[0]; if (n === 'isDigit' || n === 'isLetter' || n === 'isLetterOrDigit' || n === 'isUpperCase' || n === 'isLowerCase' || n === 'isWhitespace' || n === 'toUpperCase' || n === 'toLowerCase') return charMethod(c, n, []); if (n === 'getNumericValue') return charMethod(c, 'digitToIntOrNull', []) ?? -1; }
    if (h === 'Collections') {
      switch (n) {
        case 'swap': { const L = a[0].a, i = Number(a[1]), j = Number(a[2]); [L[i], L[j]] = [L[j], L[i]]; a[0].mod++; return UNIT; }
        case 'sort': listMethod(a[0], a[1] ? 'sortWith' : 'sort', a.slice(1)); return UNIT;
        case 'reverse': a[0].a.reverse(); return UNIT;
        case 'max': return minMax(items(a[0]), true);
        case 'min': return minMax(items(a[0]), false);
        case 'frequency': return items(a[0]).filter(y => equals(y, a[1])).length;
        case 'reverseOrder': return new KCmp((p, q) => compare(q, p));
        case 'emptyList': return listOf([]);
        case 'nCopies': return listOf(Array(Number(a[0])).fill(a[1]));
      }
    }
    if (h === 'Arrays') {
      switch (n) {
        case 'sort': return arrMethod(a[0], a[1] ? 'sortWith' : 'sort', a.slice(1));
        case 'toString': return a[0] === null ? 'null' : arrMethod(a[0], 'contentToString', []);
        case 'fill': return arrMethod(a[0], 'fill', [a[1]]);
        case 'asList': return new KList('Arrays$ArrayList', a.length === 1 && a[0] instanceof KArr ? a[0].a : a, false);
        case 'copyOf': return arrMethod(a[0], 'copyOf', [a[1]]);
        case 'deepToString': return arrMethod(a[0], 'contentDeepToString', []);
      }
    }
    if (h === 'System') {
      if (n === 'currentTimeMillis' || n === 'nanoTime') fail(`System.${n} is not supported here (a trace has no clock).`);
      if (n === 'exit') throw Object.assign(new Error('exit'), { exit: Number(a[0]) });
      if (n === 'arraycopy') { const [src, sp, dst, dp, len] = a; const part = src.a.slice(Number(sp), Number(sp) + Number(len)); part.forEach((v2, k) => { dst.a[Number(dp) + k] = v2; }); return UNIT; }
    }
    if (h === 'Comparator') { if (n === 'reverseOrder') return new KCmp((p, q) => compare(q, p)); if (n === 'naturalOrder') return new KCmp(compare); if (n === 'comparingInt' || n === 'comparing') return byKeys([a[0]]); }
    if (h === 'Char' && n === 'toChars') return new KArr('CharArray', [KCH(a[0])]);
    if (h === 'Random') { const r = new KRandom(); return callMethod(r, n, a); }
    fail(`unresolved reference '${n}'.`);
  }
  const GLOBALS = new Set(['println', 'print', 'listOf', 'mutableListOf', 'arrayListOf', 'emptyList', 'listOfNotNull', 'setOf', 'mutableSetOf', 'hashSetOf', 'linkedSetOf', 'sortedSetOf', 'emptySet', 'mapOf', 'mutableMapOf', 'hashMapOf',
    'linkedMapOf', 'sortedMapOf', 'emptyMap', 'arrayOf', 'intArrayOf', 'longArrayOf', 'doubleArrayOf', 'floatArrayOf', 'booleanArrayOf', 'charArrayOf', 'arrayOfNulls', 'emptyArray', 'IntArray', 'LongArray', 'DoubleArray', 'FloatArray',
    'BooleanArray', 'CharArray', 'Array', 'repeat', 'maxOf', 'minOf', 'require', 'requireNotNull', 'check', 'checkNotNull', 'error', 'TODO', 'assert', 'buildString', 'buildList', 'buildMap', 'buildSet', 'Pair', 'Triple',
    'StringBuilder', 'HashMap', 'LinkedHashMap', 'TreeMap', 'HashSet', 'LinkedHashSet', 'TreeSet', 'ArrayList', 'ArrayDeque', 'PriorityQueue', 'LinkedList', 'Stack', 'Random', 'compareBy', 'compareByDescending',
    'naturalOrder', 'reverseOrder', 'Comparator', 'sqrt', 'abs', 'pow', 'max', 'min', 'floor', 'ceil', 'round', 'ln', 'log10', 'log2', 'exp', 'sin', 'cos', 'tan', 'atan2', 'hypot', 'cbrt', 'sign', 'truncate',
    'readln', 'readLine', 'readlnOrNull', 'generateSequence', 'sequenceOf', 'emptySequence', 'lazy', 'exitProcess', 'mutableStateOf', 'with', 'run', 'IllegalArgumentException', 'Exception', 'nullsFirst', 'nullsLast']);
  const PI = new D(Math.PI), E = new D(Math.E);
  function global(n) {
    if (n === 'Unit') return UNIT;
    if (n === 'PI') return PI;
    if (n === 'E') return E;
    if (GLOBALS.has(n)) return new KFn({ name: n, ref: true, native: argv => callGlobal(n, argv.map(v => ({ e: { k: 'const', v } })), null, { rval: x => x.v }) });
    return undefined;
  }
  const mathArg = (v, what) => (v instanceof D ? v.v : typeof v === 'number' || typeof v === 'bigint' ? fail(`argument type mismatch: actual type is '${ktType(v)}', but 'kotlin.Double' was expected (write ${what}(x.toDouble())).`) : fail(`argument type mismatch: actual type is '${ktType(v)}', but 'kotlin.Double' was expected.`));
  function callGlobal(n, args, e, ctx) {
    const rv = x => ctx.rval(x.e);
    const a = args.map(rv);
    a.names = args.map(x => x.name);
    const t0 = ctx.targs && ctx.targs[0], t1 = ctx.targs && ctx.targs[1];
    const lam = () => a.find(x => x instanceof KFn);
    switch (n) {
      case 'println': write((a.length ? (a[0] instanceof KArr && a[0].kind === 'CharArray' ? a[0].a.map(c => String.fromCharCode(c.c)).join('') : toStr(a[0])) : '') + '\n'); return UNIT;
      case 'print': write(a[0] instanceof KArr && a[0].kind === 'CharArray' ? a[0].a.map(c => String.fromCharCode(c.c)).join('') : toStr(a[0])); return UNIT;
      case 'listOf': return a.length === 1 && a[0] instanceof KArr ? listOf(a[0].a.slice()) : listOf(a);
      case 'listOfNotNull': return listOf(a.filter(x => x !== null));
      case 'mutableListOf': case 'arrayListOf': return mlist(a.slice());
      case 'emptyList': return listOf([]);
      case 'setOf': return a.length ? setFrom('LinkedHashSet', a, mapCapacity(a.length), false) : setFrom('LinkedHashSet', [], 16, false);
      case 'mutableSetOf': case 'linkedSetOf': return setFrom('LinkedHashSet', a, mapCapacity(a.length));
      case 'hashSetOf': return setFrom('HashSet', a, a.length ? mapCapacity(a.length) : 16);
      case 'sortedSetOf': return setFrom('TreeSet', a.filter(x => !(x instanceof KCmp)), 16, true, a[0] instanceof KCmp ? a[0].fn : null);
      case 'emptySet': return setFrom('LinkedHashSet', [], 16, false);
      case 'mapOf': return mapFrom('LinkedHashMap', a, mapCapacity(a.length), false);
      case 'mutableMapOf': case 'linkedMapOf': return mapFrom('LinkedHashMap', a, mapCapacity(a.length));
      case 'hashMapOf': return mapFrom('HashMap', a, a.length ? mapCapacity(a.length) : 16);
      case 'sortedMapOf': { const m = new KMap('TreeMap'); for (const p of a) m.put(p.a, p.b); return m; }
      case 'emptyMap': return new KMap('LinkedHashMap', 16, null, false);
      case 'arrayOf': return new KArr('Array', a.slice());
      case 'emptyArray': return new KArr('Array', []);
      case 'intArrayOf': case 'longArrayOf': case 'doubleArrayOf': case 'floatArrayOf': case 'booleanArrayOf': case 'charArrayOf': {
        const kind = n.replace('ArrayOf', '').replace(/^./, c => c.toUpperCase()) + 'Array';
        const arr = new KArr(kind, []);
        for (const x of a) arr.a.push(checkElem(arr, x));
        return arr;
      }
      case 'arrayOfNulls': return new KArr('Array', Array(Number(a[0])).fill(null));
      case 'IntArray': case 'LongArray': case 'DoubleArray': case 'FloatArray': case 'BooleanArray': case 'CharArray': case 'Array': {
        const size = Number(a[0]);
        if (size < 0) throwKt('NegativeArraySizeException' in {} ? '' : 'IllegalArgumentException', String(size));
        if (size > 1e6) fail('the array is too big for this page.');
        const init = lam();
        if (n === 'Array' && !init) fail('no value passed for parameter \'init\' (write Array(n) { … }).');
        const arr = new KArr(n, []);
        for (let k = 0; k < size; k++) arr.a.push(init ? (n === 'Array' ? callFn(init, [k]) : checkElem(arr, callFn(init, [k]))) : ARR_ZERO[n]);
        return arr;
      }
      case 'repeat': { const times = Number(a[0]); for (let k = 0; k < times; k++) callFn(a[1], [k]); return UNIT; }
      case 'maxOf': case 'minOf': { if (a.length < 2) fail(`none of the following candidates is applicable: ${n}(…) needs two values or more.`); for (let k = 1; k < a.length; k++) if (kindOf(a[k]) !== kindOf(a[0]) && kindOf(a[0]) !== 'ref') fail(`argument type mismatch: actual type is '${ktType(a[k])}', but '${ktType(a[0])}' was expected.`); return minMax(a, n === 'maxOf'); }
      case 'require': if (a[0] !== true) throwKt('IllegalArgumentException', a[1] instanceof KFn ? toStr(callFn(a[1], [])) : 'Failed requirement.'); return UNIT;
      case 'check': if (a[0] !== true) throwKt('IllegalStateException', a[1] instanceof KFn ? toStr(callFn(a[1], [])) : 'Check failed.'); return UNIT;
      case 'requireNotNull': if (a[0] === null) throwKt('IllegalArgumentException', a[1] instanceof KFn ? toStr(callFn(a[1], [])) : 'Required value was null.'); return a[0];
      case 'checkNotNull': if (a[0] === null) throwKt('IllegalStateException', a[1] instanceof KFn ? toStr(callFn(a[1], [])) : 'Required value was null.'); return a[0];
      case 'error': throwKt('IllegalStateException', toStr(a[0]));
      // falls through
      case 'TODO': throwKt('NotImplementedError', 'An operation is not implemented' + (a.length ? ': ' + toStr(a[0]) : '.'));
      // falls through
      case 'assert': if (a[0] !== true) throwKt('AssertionError' in {} ? '' : 'Error', 'Assertion failed'); return UNIT;
      case 'buildString': { const sb = new KSB(typeof a[0] === 'string' ? a[0] : ''); api.invoke(Object.assign(Object.create(Object.getPrototypeOf(lam())), lam(), { selfAt: sb }), [], sb, null); return sb.s; }
      case 'buildList': { const l = mlist([]); api.invoke(Object.assign(Object.create(Object.getPrototypeOf(lam())), lam(), { selfAt: l }), [], l, null); return l; }
      case 'buildMap': { const m = new KMap('LinkedHashMap'); api.invoke(Object.assign(Object.create(Object.getPrototypeOf(lam())), lam(), { selfAt: m }), [], m, null); return m; }
      case 'buildSet': { const s = new KSet('LinkedHashSet'); api.invoke(Object.assign(Object.create(Object.getPrototypeOf(lam())), lam(), { selfAt: s }), [], s, null); return s; }
      case 'Pair': return pair(a[0], a[1]);
      case 'Triple': return new KTriple(a[0], a[1], a[2]);
      case 'StringBuilder': return new KSB(a.length ? toStr(a[0]) : '');
      case 'HashMap': case 'LinkedHashMap': case 'TreeMap': {
        const m = new KMap(n === 'TreeMap' ? 'TreeMap' : n, typeof a[0] === 'number' ? Math.max(1, a[0]) : 16, a[0] instanceof KCmp || a[0] instanceof KFn ? cmpOf(a[0]) : null);
        if (a[0] instanceof KMap) { if (n === 'HashMap') m.cap = tableSize(Math.floor(a[0].size / 0.75 + 1)); for (const en of a[0].order()) m.put(en.k, en.v); }
        return m;
      }
      case 'HashSet': case 'LinkedHashSet': case 'TreeSet': {
        const src = a[0] && !(typeof a[0] === 'number') && !(a[0] instanceof KCmp) ? items(a[0]) : [];
        const cap = typeof a[0] === 'number' ? a[0] : src.length ? Math.max(Math.floor(src.length / 0.75) + 1, 16) : 16;
        return setFrom(n, src, cap, true, a[0] instanceof KCmp ? a[0].fn : null);
      }
      case 'ArrayList': case 'LinkedList': return mlist(a[0] && typeof a[0] !== 'number' ? items(a[0]) : []);
      case 'Stack': { const s = mlist([]); s.kind = 'Stack'; return s; }
      case 'ArrayDeque': { const d = new KDeque(e && e.f && false ? 'java' : 'ArrayDeque'); if (a[0] && typeof a[0] !== 'number') d.a = items(a[0]); return d; }
      case 'PriorityQueue': {
        const c = a.find(x => x instanceof KCmp || x instanceof KFn || (x instanceof KObj));
        const q = new KPQ(c ? cmpOf(c) : null);
        const src = a.find(x => x instanceof KList || x instanceof KSet);
        if (src) { q.q = items(src); for (let k = (q.q.length >>> 1) - 1; k >= 0; k--) { const x = q.q[k]; pqDownHeapify(q, k, x); } }
        return q;
      }
      case 'Random': return new KRandom(a.length ? a[0] : undefined);
      case 'compareBy': return byKeys(a.filter(x => x instanceof KFn));
      case 'compareByDescending': return byKeys(a.filter(x => x instanceof KFn), true);
      case 'naturalOrder': return new KCmp(compare);
      case 'reverseOrder': return new KCmp((p, q) => compare(q, p));
      case 'nullsFirst': return new KCmp((p, q) => (p === null ? (q === null ? 0 : -1) : q === null ? 1 : (a[0] ? cmpOf(a[0]) : compare)(p, q)));
      case 'nullsLast': return new KCmp((p, q) => (p === null ? (q === null ? 0 : 1) : q === null ? -1 : (a[0] ? cmpOf(a[0]) : compare)(p, q)));
      case 'Comparator': return new KCmp(cmpOf(lam()));
      case 'sqrt': case 'floor': case 'ceil': case 'ln': case 'log10': case 'log2': case 'exp': case 'sin': case 'cos': case 'tan': case 'cbrt': case 'truncate': {
        const v = mathArg(a[0], n);
        const f = { sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, cbrt: Math.cbrt, truncate: Math.trunc }[n];
        return new D(f(v), a[0].f);
      }
      case 'round': { const v = mathArg(a[0], n); const f = Math.floor(v), d = v - f; return new D(d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1); }
      case 'pow': return new D(mathArg(a[0], n) ** num(a[1]));
      case 'atan2': case 'hypot': return new D(Math[n](mathArg(a[0], n), mathArg(a[1], n)));
      case 'abs': return absOf(a[0]);
      case 'sign': return a[0] instanceof D ? new D(Math.sign(a[0].v)) : Math.sign(a[0]);
      case 'max': case 'min': { const [p, q] = a; if (kindOf(p) !== kindOf(q)) fail(`argument type mismatch: actual type is '${ktType(q)}', but '${ktType(p)}' was expected.`); if (p instanceof D) return new D(Number.isNaN(p.v) || Number.isNaN(q.v) ? NaN : Math[n](p.v, q.v), p.f); return (compare(p, q) >= 0) === (n === 'max') ? p : q; }
      case 'readln': case 'readLine': case 'readlnOrNull': fail(`${n}(): this page has no keyboard input (put the values in the program).`);
      // falls through
      case 'generateSequence': {
        const seed = a.length === 2 ? a[0] : undefined, f = lam();
        return new KSeq(function* () { let x = seed === undefined ? callFn(f, []) : seed instanceof KFn ? callFn(seed, []) : seed; while (x !== null) { yield x; x = seed === undefined ? callFn(f, []) : callFn(f, [x]); } }, 'GeneratorSequence');
      }
      case 'sequenceOf': return new KSeq(function* () { yield* a; });
      case 'emptySequence': return new KSeq(function* () {});
      case 'exitProcess': throw Object.assign(new Error('exit'), { exit: Number(a[0]) });
      case 'with': { const f = a[1]; return api.invoke(Object.assign(Object.create(Object.getPrototypeOf(f)), f, { selfAt: a[0] }), [], a[0], null); }
      case 'run': return callFn(a[0], []);
      case 'lazy': return callFn(a[0], []);
    }
    if (EXC_NAMES.has(n)) { const o = newExc(n, a[0] === undefined ? null : a[0]); if (a[1] instanceof KObj) o.f.set('cause', a[1]); return o; }
    void t0; void t1;
    fail(`unresolved reference '${n}'.` + (n === 'printf' ? ' (Kotlin has no printf: println("%d".format(x)), or a string template "$x")' : n === 'printLn' || n === 'Println' ? ' (it is println)' : n === 'len' || n === 'length' ? ' (use x.length, or list.size)' : n === 'input' ? '' : ''));
  }
  const EXC_NAMES = new Set(['Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'IndexOutOfBoundsException', 'ArithmeticException', 'NumberFormatException',
    'NoSuchElementException', 'UnsupportedOperationException', 'NullPointerException', 'ConcurrentModificationException', 'Error', 'Throwable', 'NotImplementedError', 'ClassCastException']);
  function pqDownHeapify(q, k, x) {
    const a = q.q, n = a.length, half = n >>> 1;
    while (k < half) { let child = (k << 1) + 1, c = a[child]; const right = child + 1; if (right < n && q.cmp(c, a[right]) > 0) c = a[child = right]; if (q.cmp(x, c) <= 0) break; a[k] = c; k = child; }
    a[k] = x;
  }
  function enumStatic(cls, n, a) {
    if (n === 'values') return new KArr('Array', cls.entries.slice());
    if (n === 'entries') return listOf(cls.entries.slice());
    if (n === 'valueOf') { const en = cls.entries.find(x => x.f.get('name') === a[0]); if (!en) throwKt('IllegalArgumentException', `No enum constant ${cls.name}.${a[0]}`); return en; }
    fail(`unresolved reference '${n}'.`);
  }
  /** toString, equals, hashCode on the program's objects; and an exception's printStackTrace */
  function objectMethod(o, n, a, e, isSuper) {
    switch (n) {
      case 'toString': return isSuper ? api.fullName(o.cls) + '@' + (identityHash(o) >>> 0).toString(16) : toStr(o);
      case 'equals': return isSuper ? o === a[0] : equals(o, a[0]);
      case 'hashCode': return isSuper ? identityHash(o) : hashOf(o);
      case 'printStackTrace': write(toStr(o) + '\n', true); return UNIT;
      case 'compareTo': return compare(o, a[0]);
      case 'copy': if (o.cls.data) { const c = new KObj(o.cls); for (const [k, v] of o.f) c.f.set(k, v); const names = (e && e.args || []).map(x => x.name); const pcs = o.cls.pc.filter(p => p.prop); a.forEach((v, k) => { const nm = names[k] || (pcs[k] && pcs[k].name); if (nm) c.f.set(nm, v); }); return c; } break;
      case 'ordinal': return o.f.get('ordinal');
    }
    if (o.cls.data && /^component\d$/.test(n)) { const p = o.cls.pc.filter(x => x.prop)[+n.slice(-1) - 1]; if (p) return o.f.get(p.name); }
    if (o.cls.isEnum || (o.cls.base && o.cls.base.isEnum)) { if (n === 'compareTo') return Math.sign(o.f.get('ordinal') - a[0].f.get('ordinal')); }
    return undefined;
  }
  const objProp = (o, n) => (n === 'javaClass' ? { toString: () => 'class ' + api.fullName(o.cls) } : n === 'simpleName' ? o.cls.name : undefined);

  /* ---- destructuring, varargs, spreading ---- */
  function component(v, k) {
    if (v instanceof KPair) return k === 0 ? v.a : k === 1 ? v.b : fail("destructuring declaration initializer of type Pair must have a 'component3()' function.");
    if (v instanceof KTriple) return [v.a, v.b, v.c][k];
    if (v instanceof KEntry) return k === 0 ? v.en.k : v.en.v;
    if (v instanceof KIndexed) return k === 0 ? v.i : v.v;
    if (v instanceof KList || v instanceof KArr) { if (k >= 5) fail('destructuring a list goes up to component5().'); const L = v.a; if (k >= L.length) throwKt('IndexOutOfBoundsException', `Index ${k} out of bounds for length ${L.length}`); return L[k]; }
    fail(`destructuring declaration initializer of type ${ktType(v)} must have a 'component${k + 1}()' function.`);
  }
  const destructure = (v, n, componentOf) => Array.from({ length: n }, (_, k) => componentOf(v, k));
  const toArray = v => (v instanceof KArr ? v.a : items(v));
  const varargArray = (rest, t) => new KArr(t && { Int: 'IntArray', Long: 'LongArray', Double: 'DoubleArray', Char: 'CharArray', Boolean: 'BooleanArray' }[t.n] || 'Array', rest.flatMap(x => (x instanceof KArr && x.spread ? x.a : [x])));
  const compareLib = (a, b) => (a instanceof KPair || a instanceof KList ? undefined : undefined);

  /* ---- snapshots ---- */
  const clsOf = v => (v instanceof KList ? (v.kind === 'Stack' ? 'Stack' : v.mutable ? 'MutableList' : 'List') : v instanceof KDeque ? 'ArrayDeque' : v instanceof KMap ? (v.kind === 'HashMap' ? 'HashMap' : v.kind === 'TreeMap' ? 'TreeMap' : v.mutable ? 'MutableMap' : 'Map') : v instanceof KSet ? (v.kind === 'HashSet' ? 'HashSet' : v.kind === 'TreeSet' ? 'TreeSet' : v.mutable ? 'MutableSet' : 'Set') : 'PriorityQueue');
  function ser(v, id, ctx, depth, serv) {
    const its = xs => { const n = Math.min(xs.length, 60); return { items: xs.slice(0, n).map(x => serv(x, ctx, depth + 1)), more: xs.length - n }; };
    if (v instanceof KList || v instanceof KDeque) return { t: 'arr', id, len: v.a.length, ...its(v.a), cls: clsOf(v) };
    if (v instanceof KPQ) return { t: 'arr', id, len: v.q.length, ...its(v.q), cls: 'PriorityQueue' };
    if (v instanceof KSet) { const xs = v.items(); return { t: 'set', id, ...its(xs), cls: clsOf(v) }; }
    if (v instanceof KMap) { const es = v.order(), n = Math.min(es.length, 30); return { t: 'map', id, entries: es.slice(0, n).map(en => [serv(en.k, ctx, depth + 1), serv(en.v, ctx, depth + 1)]), more: es.length - n, cls: clsOf(v) }; }
    if (v instanceof KPair || v instanceof KTriple) { const xs = v instanceof KPair ? [v.a, v.b] : [v.a, v.b, v.c]; return { t: 'arr', id, len: xs.length, items: xs.map(x => serv(x, ctx, depth + 1)), more: 0, tn: v instanceof KPair ? 'Pair' : 'Triple' }; }
    if (v instanceof KEntry) return { t: 'obj', id, cls: 'Map.Entry', entries: [['key', serv(v.en.k, ctx, depth + 1)], ['value', serv(v.en.v, ctx, depth + 1)]], more: 0 };
    if (v instanceof KIndexed) return { t: 'obj', id, cls: 'IndexedValue', entries: [['index', serv(v.i, ctx, depth + 1)], ['value', serv(v.v, ctx, depth + 1)]], more: 0 };
    if (v instanceof KSB) return { t: 'p', k: 'str', s: JSON.stringify(v.s.length > 80 ? v.s.slice(0, 80) + '…' : v.s) };
    if (v instanceof KView) { const xs = v.items(); return { t: v.part === 'v' ? 'arr' : 'set', id, len: xs.length, ...its(xs), cls: v.part === 'k' ? 'keys' : v.part === 'v' ? 'values' : 'entries' }; }
    if (v instanceof KRange) return { t: 'p', k: 'sym', s: toStrLib(v) };
    return { t: 'p', k: 'sym', s: toStrLib(v).replace(/@[0-9a-f]+$/, '') };
  }
  const brief = v => (v instanceof KSB ? JSON.stringify(v.s.slice(0, 14)) : v instanceof KList || v instanceof KDeque ? clsOf(v) + '(' + v.a.length + ')' : v instanceof KMap ? clsOf(v) + '(' + v.size + ')' : v instanceof KSet ? clsOf(v) + '(' + v.m.size + ')' : v instanceof KRange ? toStrLib(v) : v instanceof KPair ? toStrLib(v).slice(0, 20) : ktTypeLib(v).replace(/^kotlin\.(collections\.)?/, ''));
  const isInstanceLib = (v, n) => {
    if (v instanceof KList || v instanceof KDeque) return ['List', 'MutableList', 'Collection', 'MutableCollection', 'Iterable', 'ArrayList', 'ArrayDeque'].includes(n) && (v.mutable || !n.startsWith('Mutable'));
    if (v instanceof KSet) return ['Set', 'MutableSet', 'Collection', 'Iterable', 'HashSet', 'LinkedHashSet', 'TreeSet'].includes(n);
    if (v instanceof KMap) return ['Map', 'MutableMap', 'HashMap', 'LinkedHashMap', 'TreeMap'].includes(n);
    if (v instanceof KPair) return n === 'Pair';
    if (v instanceof KTriple) return n === 'Triple';
    if (v instanceof KArr) return n === 'Array' || n === v.kind;
    if (v instanceof KRange) return ['IntRange', 'CharRange', 'LongRange', 'IntProgression', 'Iterable', 'ClosedRange'].includes(n);
    if (v instanceof KSB) return n === 'StringBuilder' || n === 'CharSequence';
    return false;
  };

  return {
    ktType: ktTypeLib, isCollType: n => ['List', 'MutableList', 'Map', 'MutableMap', 'Set', 'MutableSet', 'Array', 'IntArray', 'ArrayList', 'HashMap', 'HashSet'].includes(n), objProp, getProp, setProp, getIndex, setIndex, elemType,
    javaClass, javaClassOfType, contains, range, collOp, libEquals, compareLib, libHash, toStr: toStrLib, infix, isStaticHolder: n => STATIC.has(n), staticMember, callStatic, enumStatic, objectMethod,
    callMethod, global, callGlobal, isGlobal: n => GLOBALS.has(n) || EXC_NAMES.has(n), listOf, toArray, varargArray, destructure, component, iterChecked, plusAssign, charLit, ser, brief, isInstance: isInstanceLib, format, CHAR_PROPS,
  };
}
