/**
 * The part of .NET that algorithms use, with .NET's own behaviour where a program can see it: Dictionary and HashSet
 * enumerate in .NET's entry order (a removed entry's slot is the next one reused), PriorityQueue is .NET's 4-ary heap,
 * List.Sort and Array.Sort are .NET's introsort (not stable), OrderBy is stable, LINQ is lazy, new Random(42) gives
 * .NET's numbers, strings compare as the invariant culture does ("apple" < "Banana"), and numbers print and format as
 * .NET 8 prints them (0.30000000000000004, 1E+17, F2 rounding exact ties to even, "12.50 %").
 * makeLib(api) gets the interpreter's helpers (./interp.js) and returns what it calls.
 */

/* ---- numbers as .NET writes them ---- */
const special = (v, f) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : null);
/** the shortest digits that read back the same: { d: '12345', dp: 4 } for 1234.5 */
function shortest(v, f) {
  let s = Math.abs(v).toExponential();
  if (f) for (let p = 1; p <= 9; p++) { const t = Math.abs(v).toExponential(p - 1); if (Math.fround(+t) === Math.fround(Math.abs(v))) { s = t; break; } }
  const [m, e] = s.split('e');
  return { d: m.replace('.', '').replace(/0+$/, '') || '0', dp: Number(e) + 1 };
}
const fixedOf = (d, dp) => (dp <= 0 ? '0.' + '0'.repeat(-dp) + d : d.length <= dp ? d + '0'.repeat(dp - d.length) : d.slice(0, dp) + '.' + d.slice(dp));
const expOf = (x, min = 2) => (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(min, '0');
/** double.ToString() (and float's): 0.1, 1E+17, 1E-05, Infinity */
export function csDouble(v, f = false) {
  const sp = special(v);
  if (sp) return sp;
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const { d, dp } = shortest(v, f);
  const sci = dp > (f ? 9 : 17) || dp < -3;
  return (v < 0 ? '-' : '') + (sci ? d[0] + (d.length > 1 ? '.' + d.slice(1) : '') + 'E' + expOf(dp - 1) : fixedOf(d, dp));
}
/** x rounded to p decimals, exact ties to even (as .NET 8 formats): '2.68' */
function fixedDigits(x, p) {
  let s = x.toFixed(p);
  if (p < 80) {
    const longer = x.toFixed(Math.min(100, p + 40)), rest = longer.slice(longer.length - (Math.min(100, p + 40) - p));
    if (/^50*$/.test(rest)) { const down = longer.slice(0, longer.length - rest.length).replace(/\.$/, ''); if (Number(down.replace('.', '').at(-1)) % 2 === 0) s = down; }
  }
  return s;
}
const group = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function makeLib(api) {
  const { D, Ch, CH, CObj, CArr, Tup, EnumV, CFn, TypeObj, fail, throwCs, nre, write, conv, copy, zero, kindOf, csType, netType, netOfType, typeText,
    toStr, equals, hashKey, compare, callFn, intOf, numOf, idOf } = api;
  const isInt = v => typeof v === 'number' || typeof v === 'bigint';
  const T = (n, args = []) => ({ k: 't', n, args });
  const INT = T('int'), STR = T('string'), CHR = T('char');
  const tOf = v => (v === null || v === undefined ? null : kindOf(v) !== 'ref' ? T(kindOf(v)) : v instanceof CObj ? T(v.cls.name) : null);

  /* ---- formatting: ToString("F2"), {0,5:N1}, $"{x:P}" ---- */
  /** v formatted with a .NET format string (standard: D F N E G P X C R B, or custom: 0.00, #,##0) */
  function format(v, fmt) {
    if (fmt == null || fmt === '') return toStr(v);
    if (v instanceof EnumV) { if (/^[gGfF]$/.test(fmt)) return toStr(v); if (/^[dD]$/.test(fmt)) return String(v.v); }
    if (v instanceof Ch || typeof v === 'string' || typeof v === 'boolean' || v === null) return toStr(v);
    if (!(isInt(v) || v instanceof D)) { if (v instanceof CObj) { const m = api.findUserMethod(v.cls, 'ToString', 1); if (m) return String(api.invoke(m, [fmt], v, null)); } return toStr(v); }
    const m = /^([A-Za-z])(\d{0,2})$/.exec(fmt);
    const isD = v instanceof D, x = isD ? v.v : Number(v);
    if (!m) return custom(isD ? x : v, fmt);
    const L = m[1], U = L.toUpperCase(), p = m[2] === '' ? null : Number(m[2]);
    const sp = isD ? special(x) : null;
    if (sp && 'FNEGPCR'.includes(U)) return sp;
    const neg = isD ? x < 0 || Object.is(x, -0) : (typeof v === 'bigint' ? v < 0n : v < 0);
    const sgn = s => (neg && /[1-9]/.test(s) ? '-' + s : s);
    switch (U) {
      case 'D': if (isD) throwCs('FormatException', 'Format specifier was invalid.'); { const a = (typeof v === 'bigint' ? (v < 0n ? -v : v) : Math.abs(v)).toString(); return (neg ? '-' : '') + a.padStart(p || 0, '0'); }
      case 'F': return sgn(fixedDigits(Math.abs(x), p == null ? 2 : p));
      case 'N': { const s = fixedDigits(Math.abs(x), p == null ? 2 : p); const [a, b] = s.split('.'); return sgn(group(a) + (b ? '.' + b : '')); }
      case 'P': { const s = fixedDigits(Math.abs(x * 100), p == null ? 2 : p); const [a, b] = s.split('.'); return sgn(group(a) + (b ? '.' + b : '')) + ' %'; }
      case 'C': { const s = fixedDigits(Math.abs(x), p == null ? 2 : p); const [a, b] = s.split('.'); return (neg ? '-' : '') + '¤' + group(a) + (b ? '.' + b : ''); }
      case 'E': { const [mm, e] = Math.abs(x).toExponential(p == null ? 6 : p).split('e'); return (neg ? '-' : '') + mm + (L === 'E' ? 'E' : 'e') + expOf(Number(e), 3); }
      case 'G': case 'R': {
        if (!isD) return String(v);
        if (p == null || p === 0 || U === 'R') { const s = csDouble(x, v.f); return L === 'g' ? s.replace('E', 'e') : s; }
        const [mm, e] = Math.abs(x).toExponential(p - 1).split('e'), ex = Number(e), digits = mm.replace('.', '').replace(/0+$/, '') || '0';
        const s = ex >= p || ex < -5 ? digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + (L === 'G' ? 'E' : 'e') + expOf(ex) : fixedOf(digits, ex + 1);
        return (neg ? '-' : '') + s;
      }
      case 'X': { if (isD) throwCs('FormatException', 'Format specifier was invalid.'); const big = typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(v >>> 0); const s = big.toString(16).padStart(p || 0, '0'); return L === 'X' ? s.toUpperCase() : s; }
      case 'B': { if (isD) throwCs('FormatException', 'Format specifier was invalid.'); const big = typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(v >>> 0); return big.toString(2).padStart(p || 0, '0'); }
    }
    return custom(isD ? x : v, fmt);
  }
  /** a custom format: 0.00, #,##0.0, 000, #.##, 0% */
  function custom(v, fmt) {
    const sections = fmt.split(';');
    let x = typeof v === 'bigint' ? Number(v) : v;
    let f = sections[0];
    if (x < 0 && sections[1] !== undefined) { f = sections[1]; x = -x; }
    else if (x === 0 && sections[2] !== undefined) f = sections[2];
    const pct = f.includes('%');
    if (pct) x *= 100;
    const first = f.search(/[0#]/), lastM = Math.max(f.lastIndexOf('0'), f.lastIndexOf('#'));
    if (first < 0) return f.replace(/\\(.)|'([^']*)'|"([^"]*)"/g, (m0, a, b, c) => a || b || c || '');
    const prefix = f.slice(0, first).replace(/'([^']*)'/g, '$1'), suffix = f.slice(lastM + 1).replace(/'([^']*)'/g, '$1');
    const body = f.slice(first, lastM + 1);
    const dot = body.indexOf('.');
    const intPart = dot < 0 ? body : body.slice(0, dot), decPart = dot < 0 ? '' : body.slice(dot + 1);
    const minInt = (intPart.match(/0/g) || []).length, minDec = (decPart.match(/0/g) || []).length, maxDec = (decPart.match(/[0#]/g) || []).length;
    const grouping = /[0#],[0#]/.test(intPart);
    let s = fixedDigits(Math.abs(x), maxDec);
    let [a, b = ''] = s.split('.');
    while (b.length > minDec && b.endsWith('0')) b = b.slice(0, -1);
    if (a === '0' && minInt === 0) a = '';
    a = a.padStart(minInt, '0');
    if (grouping) a = group(a);
    const out = a + (b ? '.' + b : '');
    return (x < 0 && /[1-9]/.test(out) ? '-' : '') + prefix + out + suffix;
  }
  /** a value in an interpolation hole or a {0,align:fmt} item */
  const formatHole = (v, fmt, align) => { const s = format(v, fmt); return align ? (align < 0 ? s.padEnd(-align) : s.padStart(align)) : s; };
  /** string.Format's composite format: "{0} and {1,5:F2}" */
  function composite(f, args) {
    let out = '';
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      if (c === '{') {
        if (f[i + 1] === '{') { out += '{'; i++; continue; }
        const e = f.indexOf('}', i);
        if (e < 0) throwCs('FormatException', 'Input string was not in a correct format.');
        const m = /^\s*(\d+)\s*(?:,\s*(-?\d+))?\s*(?::(.*))?$/s.exec(f.slice(i + 1, e));
        if (!m) throwCs('FormatException', 'Input string was not in a correct format.');
        const k = Number(m[1]);
        if (k >= args.length) throwCs('FormatException', 'Index (zero based) must be greater than or equal to zero and less than the size of the argument list.');
        out += formatHole(args[k], m[3], m[2] ? Number(m[2]) : 0);
        i = e;
        continue;
      }
      if (c === '}') { if (f[i + 1] === '}') { out += '}'; i++; continue; } throwCs('FormatException', 'Input string was not in a correct format.'); }
      out += c;
    }
    return out;
  }
  const charLit = c => "'" + ({ 0: '\\0', 10: '\\n', 13: '\\r', 9: '\\t', 39: "\\'", 92: '\\\\' }[c] || String.fromCharCode(c)) + "'";

  /* ---- comparing: Comparer<T>.Default (strings as the invariant culture compares them) ---- */
  const collator = new Intl.Collator('en-US');
  function compareDefault(a, b) {
    const ka = kindOf(a), kb = kindOf(b);
    if (ka === 'string' && kb === 'string') return Math.sign(collator.compare(a, b)) || (a < b ? -1 : a > b ? 1 : 0);
    if (a instanceof Ch && b instanceof Ch) return Math.sign(a.c - b.c);
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (a instanceof EnumV && b instanceof EnumV) return Math.sign(a.v - b.v);
    if ((isInt(a) || a instanceof D || a instanceof Ch) && (isInt(b) || b instanceof D || b instanceof Ch)) {
      if (typeof a === 'bigint' || typeof b === 'bigint') { if (!(a instanceof D) && !(b instanceof D)) { const x = BigInt(intOf(a)), y = BigInt(intOf(b)); return x < y ? -1 : x > y ? 1 : 0; } }
      const x = numOf(a), y = numOf(b);
      if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : -1;
      if (Number.isNaN(y)) return 1;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (a instanceof KV || b instanceof KV) throwCs('InvalidOperationException', 'Failed to compare two elements in the array.');
    throwCs('InvalidOperationException', 'Failed to compare two elements in the array.');
  }
  /** a comparison delegate, a Comparer object, or the default */
  const comparer = c => (c === undefined || c === null ? compare : c instanceof Cmp ? c.fn : c instanceof CFn ? (a, b) => Number(intOf(callFn(c, [a, b]))) : fail('CS1503: a Comparison<T> (a lambda (a, b) => …) or an IComparer<T> is needed'));
  class Cmp { constructor(fn, rev = false) { this.fn = rev ? (a, b) => fn(b, a) : fn; } }

  /* ---- .NET's introsort (List.Sort, Array.Sort): insertion sort up to 16 items, then quicksort with heapsort as the fallback ---- */
  function introSort(a, lo, n, cmp) {
    const sw = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
    const swapIfGreater = (i, j) => { if (cmp(a[i], a[j]) > 0) sw(i, j); };
    const insertion = (l, len) => { for (let i = 0; i < len - 1; i++) { const t = a[l + i + 1]; let j = i; while (j >= 0 && cmp(t, a[l + j]) < 0) { a[l + j + 1] = a[l + j]; j--; } a[l + j + 1] = t; } };
    const downHeap = (l, i, len) => { const d = a[l + i - 1]; while (i <= len >> 1) { let child = 2 * i; if (child < len && cmp(a[l + child - 1], a[l + child]) < 0) child++; if (!(cmp(d, a[l + child - 1]) < 0)) break; a[l + i - 1] = a[l + child - 1]; i = child; } a[l + i - 1] = d; };
    const heapSort = (l, len) => { for (let i = len >> 1; i >= 1; i--) downHeap(l, i, len); for (let i = len; i > 1; i--) { sw(l, l + i - 1); downHeap(l, 1, i - 1); } };
    const partition = (l, len) => {
      const hi = l + len - 1, middle = l + ((len - 1) >> 1);
      swapIfGreater(l, middle); swapIfGreater(l, hi); swapIfGreater(middle, hi);
      const pivot = a[middle];
      sw(middle, hi - 1);
      let left = l, right = hi - 1;
      while (left < right) {
        while (cmp(a[++left], pivot) < 0);
        while (cmp(pivot, a[--right]) < 0);
        if (left >= right) break;
        sw(left, right);
      }
      if (left !== hi - 1) sw(left, hi - 1);
      return left;
    };
    const intro = (l, len, depth) => {
      while (len > 1) {
        if (len <= 16) {
          if (len === 2) { swapIfGreater(l, l + 1); return; }
          if (len === 3) { swapIfGreater(l, l + 1); swapIfGreater(l, l + 2); swapIfGreater(l + 1, l + 2); return; }
          insertion(l, len); return;
        }
        if (depth === 0) { heapSort(l, len); return; }
        depth--;
        const p = partition(l, len);
        intro(p + 1, l + len - (p + 1), depth);
        len = p - l;
      }
    };
    if (n > 1) intro(lo, n, 2 * (Math.floor(Math.log2(n)) + 1));
  }
  const stableSort = (xs, cmp) => xs.map((x, k) => [x, k]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map(p => p[0]);

  /* ---- the collections ---- */
  class List { constructor(et, a = []) { this.et = et; this.a = a; this.ver = 0; } }
  /** Dictionary and HashSet: .NET's entries array, a removed entry's slot reused first (so the order is .NET's) */
  class Hashed {
    constructor(kind, kt, vt) { this.kind = kind; this.kt = kt; this.vt = vt; this.e = []; this.free = []; this.map = new Map(); this.count = 0; this.ver = 0; }
    keyOf(k) { const h = hashKey(k); return typeof h === 'string' ? { s: h, user: false } : { s: 'u' + h.userHash, user: true }; }
    find(k) { const { s, user } = this.keyOf(k); const c = this.map.get(s); if (!c) return -1; if (!user) return c[0]; for (const i of c) if (equals(this.e[i].k, k)) return i; return -1; }
    add(k, v) {
      const { s } = this.keyOf(k);
      const i = this.free.length ? this.free.pop() : this.e.length;
      this.e[i] = { k, v };
      if (!this.map.has(s)) this.map.set(s, []);
      this.map.get(s).push(i);
      this.count++; this.ver++;
      return i;
    }
    remove(k) {
      const i = this.find(k);
      if (i < 0) return null;
      const en = this.e[i], { s } = this.keyOf(k), c = this.map.get(s);
      c.splice(c.indexOf(i), 1); if (!c.length) this.map.delete(s);
      this.e[i] = null; this.free.push(i); this.count--;
      if (this.kind === 'HashSet') this.ver++;
      return en;
    }
    clear() { this.e = []; this.free = []; this.map.clear(); this.count = 0; this.ver++; }
    entries() { return this.e.filter(Boolean); }
  }
  /** SortedDictionary and SortedSet: kept in order */
  class Sorted {
    constructor(kind, kt, vt, cmp) { this.kind = kind; this.kt = kt; this.vt = vt; this.a = []; this.cmp = cmp || compare; this.ver = 0; }
    find(k) { let lo = 0, hi = this.a.length; while (lo < hi) { const m = (lo + hi) >> 1, c = this.cmp(this.a[m].k, k); if (c < 0) lo = m + 1; else if (c > 0) hi = m; else return { at: m, hit: true }; } return { at: lo, hit: false }; }
    get count() { return this.a.length; }
    entries() { return this.a; }
  }
  class Queue { constructor(et) { this.et = et; this.a = []; this.ver = 0; } }
  class Stack { constructor(et) { this.et = et; this.a = []; this.ver = 0; } }
  /** PriorityQueue<TElement, TPriority>: .NET's 4-ary min-heap of (element, priority) */
  class PQ { constructor(et, pt, cmp) { this.et = et; this.pt = pt; this.h = []; this.cmp = cmp || compare; this.ver = 0; } }
  class SB { constructor(s = '') { this.s = s; } }
  class KV { constructor(k, v) { this.k = k; this.v = v; } }
  /** a lazy sequence (a LINQ query): run again each time it is enumerated */
  class Seq { constructor(name, gen, et = null, src = null) { this.name = name; this.gen = gen; this.et = et; this.src = src; } [Symbol.iterator]() { return this.gen(); } }
  class Ordered extends Seq { constructor(src, keys, et) { super('OrderedEnumerable', null, et, src); this.keys = keys; this.gen = () => this.sorted()[Symbol.iterator](); } sorted() { const cmp = (a, b) => { for (const { f, desc, cmpr } of this.keys) { const c = cmpr(callFn(f, [a]), callFn(f, [b])); if (c) return desc ? -c : c; } return 0; }; return stableSort([...iter(this.src)], cmp); } }
  class Group extends Seq { constructor(key, items, et) { super('Grouping', () => items[Symbol.iterator](), et); this.key = key; this.items = items; } }
  class View { constructor(d, part) { this.d = d; this.part = part; } }
  class Rand {
    constructor(seed) {
      this.seeded = seed !== undefined;
      if (!this.seeded) return;
      // .NET's seeded generator (Knuth's subtractive method, Net5CompatSeedImpl)
      const MBIG = 2147483647, s = new Int32Array(56);
      let mj = 161803398 - (seed === -2147483648 ? 2147483647 : Math.abs(seed)), mk = 1;
      s[55] = mj;
      for (let i = 1; i < 55; i++) { const ii = (21 * i) % 55; s[ii] = mk; mk = mj - mk; if (mk < 0) mk += MBIG; mj = s[ii]; }
      for (let k = 1; k < 5; k++) for (let i = 1; i < 56; i++) { s[i] -= s[1 + (i + 30) % 55]; if (s[i] < 0) s[i] += MBIG; }
      this.s = s; this.inext = 0; this.inextp = 21;
    }
    sample() {
      if (!this.seeded) return Math.random();
      let a = this.inext, b = this.inextp;
      if (++a >= 56) a = 1;
      if (++b >= 56) b = 1;
      let r = this.s[a] - this.s[b];
      if (r === 2147483647) r--;
      if (r < 0) r += 2147483647;
      this.s[a] = r; this.inext = a; this.inextp = b;
      return r;
    }
    next() { return this.seeded ? this.sample() : Math.floor(Math.random() * 2147483647); }
    double() { return this.seeded ? this.sample() * (1 / 2147483647) : Math.random(); }
  }
  /** a writer: Console.Out, Console.Error */
  class Writer { constructor(err) { this.err = err; } }

  const COLL_TYPES = new Set(['List', 'IList', 'IReadOnlyList', 'ICollection', 'IReadOnlyCollection', 'IEnumerable', 'Dictionary', 'SortedDictionary', 'SortedList', 'IDictionary', 'IReadOnlyDictionary',
    'HashSet', 'SortedSet', 'ISet', 'Queue', 'Stack', 'PriorityQueue', 'LinkedList', 'StringBuilder', 'KeyValuePair', 'Random']);
  const elemTypeOf = c => (c instanceof List || c instanceof Queue || c instanceof Stack ? c.et : c instanceof Hashed || c instanceof Sorted ? c.kt : c instanceof CArr ? c.et : c instanceof Seq ? c.et : typeof c === 'string' ? CHR : null);

  /* ---- enumerating ---- */
  function* iter(v) {
    if (v === null || v === undefined) nre();
    if (v instanceof CArr) { yield* v.a; return; }
    if (typeof v === 'string') { for (let i = 0; i < v.length; i++) yield CH(v.charCodeAt(i)); return; }
    if (v instanceof List) { yield* v.a.slice(); return; }
    if (v instanceof Hashed) { for (const en of v.entries()) yield v.kind === 'HashSet' ? en.k : new KV(en.k, en.v); return; }
    if (v instanceof Sorted) { for (const en of v.a.slice()) yield v.kind === 'SortedSet' ? en.k : new KV(en.k, en.v); return; }
    if (v instanceof Queue) { yield* v.a.slice(); return; }
    if (v instanceof Stack) { yield* v.a.slice().reverse(); return; }
    if (v instanceof Seq) { yield* v.gen(); return; }
    if (v instanceof View) { for (const kv of iter(v.d)) yield v.part === 'k' ? kv.k : kv.v; return; }
    if (v instanceof PQ) fail("CS1579: foreach statement cannot operate on variables of type 'PriorityQueue' because it does not contain a public instance or extension definition for 'GetEnumerator' (use pq.UnorderedItems)");
    fail(`CS1579: foreach statement cannot operate on variables of type '${csType(v)}' because it does not contain a public instance or extension definition for 'GetEnumerator'`);
  }
  /** foreach over a collection: changing it while the loop runs is .NET's InvalidOperationException */
  function* iterChecked(v) {
    const ver = () => (v instanceof List || v instanceof Hashed || v instanceof Sorted || v instanceof Queue || v instanceof Stack ? v.ver : v instanceof View ? v.d.ver : 0);
    const v0 = ver();
    const it = v instanceof List ? (function* () { for (let i = 0; i < v.a.length; i++) { if (ver() !== v0) break; yield v.a[i]; } })() : iter(v);
    for (const x of it) {
      if (ver() !== v0) throwCs('InvalidOperationException', 'Collection was modified; enumeration operation may not execute.');
      yield x;
      if (ver() !== v0) throwCs('InvalidOperationException', 'Collection was modified; enumeration operation may not execute.');
    }
  }
  const items = v => [...iter(v)];

  /* ---- names ---- */
  const tt = t => (t ? typeText(t) : 'object');
  const nt = t => netOfType(t);
  function csTypeLib(v) {
    if (v instanceof List) return `List<${tt(v.et)}>`;
    if (v instanceof Hashed || v instanceof Sorted) return v.kind.endsWith('Set') ? `${v.kind}<${tt(v.kt)}>` : `${v.kind}<${tt(v.kt)}, ${tt(v.vt)}>`;
    if (v instanceof Queue || v instanceof Stack) return `${v instanceof Queue ? 'Queue' : 'Stack'}<${tt(v.et)}>`;
    if (v instanceof PQ) return `PriorityQueue<${tt(v.et)}, ${tt(v.pt)}>`;
    if (v instanceof SB) return 'StringBuilder';
    if (v instanceof KV) return `KeyValuePair<${csType(v.k)}, ${csType(v.v)}>`;
    if (v instanceof Seq) return `IEnumerable<${tt(v.et)}>`;
    if (v instanceof Rand) return 'Random';
    return 'object';
  }
  const G = 'System.Collections.Generic.';
  function netTypeLib(v) {
    if (v instanceof List) return `${G}List\`1[${nt(v.et)}]`;
    if (v instanceof Hashed || v instanceof Sorted) return v.kind.endsWith('Set') ? `${G}${v.kind}\`1[${nt(v.kt)}]` : `${G}${v.kind}\`2[${nt(v.kt)},${nt(v.vt)}]`;
    if (v instanceof Queue || v instanceof Stack) return `${G}${v instanceof Queue ? 'Queue' : 'Stack'}\`1[${nt(v.et)}]`;
    if (v instanceof PQ) return `${G}PriorityQueue\`2[${nt(v.et)},${nt(v.pt)}]`;
    if (v instanceof SB) return 'System.Text.StringBuilder';
    if (v instanceof KV) return `${G}KeyValuePair\`2[${netType(v.k)},${netType(v.v)}]`;
    if (v instanceof Ordered) { const first = items(v.src)[0]; return `System.Linq.OrderedEnumerable\`2[${nt(v.et)},${first === undefined ? 'System.Object' : netType(callFn(v.keys[0].f, [first]))}]`; }
    if (v instanceof Seq && v.lazyTarg) { const r = v.gen().next(); return 'System.Linq.Enumerable+' + v.name + '`2[' + nt(v.targs[0]) + ',' + (r.done ? 'System.Object' : netType(r.value)) + ']'; }
    if (v instanceof Group) return `System.Linq.Grouping\`2[${netType(v.key)},${nt(v.et)}]`;
    if (v instanceof Seq) return 'System.Linq.Enumerable+' + v.name + (v.targs ? '`' + v.targs.length + '[' + v.targs.map(nt).join(',') + ']' : '');
    if (v instanceof View) return `${G}${v.d.kind}\`2+${v.part === 'k' ? 'KeyCollection' : 'ValueCollection'}[${nt(v.d.kt)},${nt(v.d.vt)}]`;
    if (v instanceof Rand) return 'System.Random';
    if (v instanceof Writer) return 'System.IO.TextWriter';
    return 'System.Object';
  }
  function netOfTypeLib(t) {
    const a = t.args || [];
    const n = t.n.replace(/^I(?=[A-Z][a-z])/, '');
    if (['List', 'HashSet', 'SortedSet', 'Queue', 'Stack', 'LinkedList'].includes(n)) return `${G}${n}\`1[${a.map(nt).join(',')}]`;
    if (['Dictionary', 'SortedDictionary', 'KeyValuePair', 'PriorityQueue', 'SortedList'].includes(n)) return `${G}${n}\`2[${a.map(nt).join(',')}]`;
    if (n === 'StringBuilder') return 'System.Text.StringBuilder';
    if (/^[A-Z]$/.test(t.n)) return t.n;
    return 'System.' + t.n;
  }
  function toStrLib(v) {
    const k = kindOf(v);
    if (k === 'int' || k === 'long') return String(v);
    if (k === 'double' || k === 'float') return csDouble(v.v, v.f);
    if (k === 'char') return String.fromCharCode(v.c);
    if (k === 'bool') return v ? 'True' : 'False';
    if (k === 'string') return v;
    if (v instanceof SB) return v.s;
    if (v instanceof KV) return '[' + toStr(v.k) + ', ' + toStr(v.v) + ']';
    return netTypeLib(v);
  }
  const brief = v => (v instanceof SB ? JSON.stringify(v.s.slice(0, 14)) : v instanceof List || v instanceof Queue || v instanceof Stack ? csTypeLib(v) + '(' + v.a.length + ')' : v instanceof Hashed || v instanceof Sorted ? csTypeLib(v) + '(' + v.count + ')' : v instanceof PQ ? csTypeLib(v) + '(' + v.h.length + ')' : csTypeLib(v));
  function ser(v, id, ctx, depth, serv) {
    const its = (xs, f = x => serv(x, ctx, depth + 1)) => { const n = Math.min(xs.length, 60); return { items: xs.slice(0, n).map(f), more: xs.length - n }; };
    if (v instanceof List || v instanceof Queue) return { t: 'arr', id, len: v.a.length, ...its(v.a), cls: csTypeLib(v) };
    if (v instanceof Stack) { const xs = v.a.slice().reverse(); return { t: 'arr', id, len: xs.length, ...its(xs), cls: csTypeLib(v) + ' (top first)' }; }
    if (v instanceof PQ) return { t: 'arr', id, len: v.h.length, ...its(v.h, ([e, p], k) => ({ t: 'arr', id: id * 1000 + k + 1, len: 2, items: [serv(e, ctx, depth + 2), serv(p, ctx, depth + 2)], more: 0, tn: '(element, priority)' })), cls: csTypeLib(v) };
    if (v instanceof Hashed || v instanceof Sorted) {
      const es = v.entries();
      if (v.kind.endsWith('Set')) return { t: 'set', id, ...its(es.map(en => en.k)), cls: csTypeLib(v) };
      const n = Math.min(es.length, 30);
      return { t: 'map', id, entries: es.slice(0, n).map(en => [serv(en.k, ctx, depth + 1), serv(en.v, ctx, depth + 1)]), more: es.length - n, cls: csTypeLib(v) };
    }
    if (v instanceof KV) return { t: 'obj', id, cls: 'KeyValuePair', entries: [['Key', serv(v.k, ctx, depth + 1)], ['Value', serv(v.v, ctx, depth + 1)]], more: 0 };
    if (v instanceof SB) return { t: 'p', k: 'str', s: JSON.stringify(v.s.length > 80 ? v.s.slice(0, 80) + '…' : v.s) };
    if (v instanceof View) { const xs = items(v); return { t: v.part === 'k' ? 'set' : 'arr', id, len: xs.length, ...its(xs), cls: v.part === 'k' ? 'KeyCollection' : 'ValueCollection' }; }
    if (v instanceof Group) return { t: 'arr', id, len: v.items.length, ...its(v.items), cls: 'Grouping ' + toStr(v.key) };
    return { t: 'p', k: 'sym', s: netTypeLib(v) };
  }
  const isInstanceLib = (v, n) => {
    const I = { List: ['List', 'IList', 'IReadOnlyList', 'ICollection', 'IReadOnlyCollection', 'IEnumerable'], Dictionary: ['Dictionary', 'IDictionary', 'IReadOnlyDictionary', 'ICollection', 'IEnumerable', 'IReadOnlyCollection'],
      HashSet: ['HashSet', 'ISet', 'ICollection', 'IEnumerable', 'IReadOnlySet', 'IReadOnlyCollection'], SortedSet: ['SortedSet', 'ISet', 'ICollection', 'IEnumerable'], SortedDictionary: ['SortedDictionary', 'IDictionary', 'IReadOnlyDictionary', 'IEnumerable'],
      Queue: ['Queue', 'IEnumerable', 'IReadOnlyCollection'], Stack: ['Stack', 'IEnumerable', 'IReadOnlyCollection'] };
    const kind = v instanceof List ? 'List' : v instanceof Hashed || v instanceof Sorted ? v.kind : v instanceof Queue ? 'Queue' : v instanceof Stack ? 'Stack' : null;
    if (kind) return (I[kind] || [kind]).includes(n);
    if (v instanceof Seq || v instanceof View) return n === 'IEnumerable';
    if (v instanceof SB) return n === 'StringBuilder';
    if (v instanceof KV) return n === 'KeyValuePair';
    if (v instanceof PQ) return n === 'PriorityQueue';
    return false;
  };

  /* ---- constructing: new List<int>(), new Dictionary<string, int>(), new StringBuilder()… ---- */
  const usesText = () => api.usings().some(u => u.n === 'System.Text');
  function construct(t, a, e) {
    const [x, y] = t.args || [];
    switch (t.n) {
      case 'List': case 'IList': {
        const l = new List(x || null);
        if (a.length && !isInt(a[0])) l.a = items(a[0]).map(v => conv(v, x));
        return l;
      }
      case 'Dictionary': case 'SortedDictionary': case 'SortedList': {
        const d = t.n === 'Dictionary' ? new Hashed('Dictionary', x, y) : new Sorted(t.n, x, y, a.find(z => z instanceof Cmp) ? comparer(a.find(z => z instanceof Cmp)) : null);
        const src = a.find(z => z instanceof Hashed || z instanceof Sorted);
        if (src) for (const kv of iter(src)) dictAdd(d, kv.k, kv.v, true);
        return d;
      }
      case 'HashSet': case 'SortedSet': case 'ISet': {
        const s = t.n === 'SortedSet' ? new Sorted('SortedSet', x, null, a.find(z => z instanceof Cmp) ? comparer(a.find(z => z instanceof Cmp)) : null) : new Hashed('HashSet', x, null);
        const src = a.find(z => z !== null && !isInt(z) && !(z instanceof Cmp));
        if (src) for (const v of iter(src)) setAdd(s, conv(v, x));
        return s;
      }
      case 'Queue': { const q = new Queue(x || null); if (a.length && !isInt(a[0])) q.a = items(a[0]); return q; }
      case 'Stack': { const s = new Stack(x || null); if (a.length && !isInt(a[0])) s.a = items(a[0]); return s; }
      case 'PriorityQueue': { const q = new PQ(x || null, y || null, a.find(z => z instanceof Cmp) ? comparer(a.find(z => z instanceof Cmp)) : null); return q; }
      case 'StringBuilder': if (!usesText() && !t.q) fail("CS0246: The type or namespace name 'StringBuilder' could not be found (are you missing a using directive or an assembly reference?) (add using System.Text;)"); return new SB(typeof a[0] === 'string' ? a[0] : '');
      case 'Random': if (a.length && typeof a[0] !== 'number') fail('CS1503: Argument 1: cannot convert to int'); return new Rand(a.length ? a[0] : undefined);
      case 'string': {
        if (a[0] instanceof Ch) return String.fromCharCode(a[0].c).repeat(Number(intOf(a[1])));
        if (a[0] instanceof CArr) { const cs = a[0].a; const s = a.length === 3 ? cs.slice(Number(a[1]), Number(a[1]) + Number(a[2])) : cs; return s.map(c => String.fromCharCode(c.c)).join(''); }
        fail('CS1729: string does not contain a constructor that takes these arguments');
      }
      // falls through
      case 'KeyValuePair': return new KV(conv(a[0], x), conv(a[1], y));
      case 'object': return new CObj({ name: 'Object', full: 'System.Object', fields: [], props: new Map(), methods: new Map(), ops: new Map(), statics: new Map(), ifaces: [] });
      case 'LinkedList': fail('LinkedList<T> is not supported here (a List<T>, or Nodes of your own)');
    }
    if (/^[A-Z]$/.test(t.n)) fail(`CS0304: Cannot create an instance of the variable type '${t.n}' because it does not have the new() constraint`);
    fail(`CS0246: The type or namespace name '${t.n}' could not be found (are you missing a using directive or an assembly reference?)`);
  }
  /** [1, 2, 3] for a List<int>, a HashSet<int>… */
  function fromItems(t, xs) {
    const c = construct({ ...t, n: t.n === 'IEnumerable' || t.n === 'IList' || t.n === 'IReadOnlyList' || t.n === 'ICollection' ? 'List' : t.n }, [], null);
    for (const x of xs) {
      if (c instanceof List) c.a.push(conv(x, c.et));
      else if (c instanceof Hashed || c instanceof Sorted) { if (c.kind.endsWith('Set')) setAdd(c, conv(x, c.kt)); else fail('CS9174: Cannot initialize type with a collection expression'); }
      else if (c instanceof Queue || c instanceof Stack) c.a.push(x);
    }
    return c;
  }
  function dictAdd(d, k, v, strict) {
    if (k === null) throwCs('ArgumentNullException', null, 'key');
    k = conv(k, d.kt); v = conv(v, d.vt);
    if (d instanceof Hashed) { const i = d.find(k); if (i >= 0) { if (strict) throwCs('ArgumentException', `An item with the same key has already been added. Key: ${toStr(k)}`); d.e[i].v = v; return; } d.add(k, v); return; }
    const f = d.find(k);
    if (f.hit) { if (strict) throwCs('ArgumentException', `An item with the same key has already been added. Key: ${toStr(k)}`); d.a[f.at].v = v; return; }
    d.a.splice(f.at, 0, { k, v }); d.ver++;
  }
  function setAdd(s, k) {
    if (s instanceof Hashed) { if (s.find(k) >= 0) return false; s.add(k, null); return true; }
    const f = s.find(k);
    if (f.hit) return false;
    s.a.splice(f.at, 0, { k }); s.ver++;
    return true;
  }
  const setHas = (s, k) => (s instanceof Hashed ? s.find(k) >= 0 : s.find(k).hit);
  const setRemove = (s, k) => { if (s instanceof Hashed) return s.remove(k) !== null; const f = s.find(k); if (!f.hit) return false; s.a.splice(f.at, 1); s.ver++; return true; };
  function dictGet(d, k) {
    if (k === null) throwCs('ArgumentNullException', null, 'key');
    if (d instanceof Hashed) { const i = d.find(k); return i < 0 ? undefined : d.e[i].v; }
    const f = d.find(k);
    return f.hit ? d.a[f.at].v : undefined;
  }
  const dictRemove = (d, k) => { if (d instanceof Hashed) { const en = d.remove(k); return en; } const f = d.find(k); if (!f.hit) return null; const [en] = d.a.splice(f.at, 1); d.ver++; return en; };

  /* ---- the PriorityQueue's heap (as .NET's: 4 children per node) ---- */
  function pqUp(q, node, i) {
    while (i > 0) { const p = (i - 1) >> 2; if (q.cmp(node[1], q.h[p][1]) < 0) { q.h[i] = q.h[p]; i = p; } else break; }
    q.h[i] = node;
  }
  function pqDown(q, node, i) {
    const n = q.h.length;
    let c;
    while ((c = (i << 2) + 1) < n) {
      let min = q.h[c], mi = c;
      const end = Math.min(c + 4, n);
      while (++c < end) if (q.cmp(q.h[c][1], min[1]) < 0) { min = q.h[c]; mi = c; }
      if (q.cmp(node[1], min[1]) <= 0) break;
      q.h[i] = min; i = mi;
    }
    q.h[i] = node;
  }
  function pqPop(q) {
    if (!q.h.length) throwCs('InvalidOperationException', 'Queue empty.');
    const top = q.h[0];
    const last = q.h.pop();
    if (q.h.length) pqDown(q, last, 0);
    q.ver++;
    return top;
  }

  /* ---- LINQ ---- */
  const pred = (f, what) => (f instanceof CFn ? x => { const r = callFn(f, [x]); if (typeof r !== 'boolean') fail(`CS1662: Cannot convert lambda expression to intended delegate type because some of the return types in the block are not implicitly convertible to the delegate return type (${what} needs a bool)`); return r; } : fail(`CS1503: ${what} needs a function (x => …)`));
  const sel = f => (f instanceof CFn ? x => callFn(f, [x]) : fail('CS1503: a function (x => …) is needed'));
  const empty = () => throwCs('InvalidOperationException', 'Sequence contains no elements');
  const seqName = (op, src) => (src instanceof List ? op + 'ListIterator' : src instanceof CArr ? op + 'ArrayIterator' : op + 'EnumerableIterator');
  function sumOf(xs) {
    let acc = 0, kind = 'int';
    for (const x of xs) {
      if (x === null) continue;
      if (x instanceof D) { if (kind !== 'double') { acc = Number(acc); kind = 'double'; } acc += x.v; }
      else if (typeof x === 'bigint') { if (kind === 'int') { acc = BigInt(acc); kind = 'long'; } acc = kind === 'double' ? acc + Number(x) : acc + x; if (kind === 'long' && BigInt.asIntN(64, acc) !== acc) throwCs('OverflowException'); }
      else if (typeof x === 'number') { acc = kind === 'long' ? acc + BigInt(x) : acc + x; if (kind === 'int' && (acc > 2147483647 || acc < -2147483648)) throwCs('OverflowException'); }
      else fail(`CS1929: '${csType(x)}' values cannot be summed`);
    }
    return kind === 'double' ? new D(acc) : acc;
  }
  const minMax = (xs, max, f) => {
    let best, have = false;
    for (const x0 of xs) { const x = f ? f(x0) : x0; if (x === null) continue; if (!have || (max ? compare(x, best) > 0 : compare(x, best) < 0)) { best = x; have = true; } }
    if (!have) { if (xs.length && xs.every(x => x === null)) return null; return empty(); }
    return best;
  };
  /** LINQ's methods, on any sequence */
  function linq(src, name, a) {
    const xs = () => items(src);
    const et = elemTypeOf(src);
    const S = (op, gen, et2 = et, targs) => { const s = new Seq(op, gen, et2, src); s.targs = targs; return s; };
    switch (name) {
      case 'Where': { const p = a[0] instanceof CFn && a[0].params && a[0].params.length === 2 ? null : pred(a[0], 'Where'); const f = a[0]; return S(seqName('Where', src), function* () { let k = 0; for (const x of iter(src)) if (p ? p(x) : callFn(f, [x, k++])) yield x; }, et, [et]); }
      case 'Select': { const f = a[0]; const two = f instanceof CFn && f.params && f.params.length === 2; const s = S(seqName('Select', src), function* () { let k = 0; for (const x of iter(src)) yield two ? callFn(f, [x, k++]) : callFn(f, [x]); }, null); s.targs = [et, null]; s.lazyTarg = true; return s; }
      case 'SelectMany': { const f = sel(a[0]); return S('SelectManySingleSelectorIterator', function* () { for (const x of iter(src)) yield* iter(f(x)); }, null); }
      case 'OrderBy': case 'OrderByDescending': { const s = new Ordered(src, [{ f: a[0], desc: name === 'OrderByDescending', cmpr: a[1] ? comparer(a[1]) : compare }], et); s.keys[0].kt = null; return s; }
      case 'ThenBy': case 'ThenByDescending': { if (!(src instanceof Ordered)) fail(`CS1061: '${csType(src)}' does not contain a definition for '${name}' (ThenBy follows OrderBy)`); return new Ordered(src.src, [...src.keys, { f: a[0], desc: name === 'ThenByDescending', cmpr: a[1] ? comparer(a[1]) : compare }], et); }
      case 'Order': return new Ordered(src, [{ f: new CFn({ native: ([x]) => x }), desc: false, cmpr: compare }], et);
      case 'OrderDescending': return new Ordered(src, [{ f: new CFn({ native: ([x]) => x }), desc: true, cmpr: compare }], et);
      case 'Reverse': return S('ReverseIterator', function* () { yield* items(src).reverse(); }, et, [et]);
      case 'Take': { const n = Number(intOf(a[0])); return S(src instanceof List ? 'ListPartition' : 'EnumerablePartition', function* () { let k = 0; if (n <= 0) return; for (const x of iter(src)) { yield x; if (++k >= n) return; } }, et, [et]); }
      case 'Skip': { const n = Number(intOf(a[0])); return S(src instanceof List ? 'ListPartition' : 'EnumerablePartition', function* () { let k = 0; for (const x of iter(src)) if (k++ >= n) yield x; }, et, [et]); }
      case 'TakeLast': { const n = Number(intOf(a[0])); return S('ListPartition', function* () { const v = items(src); yield* v.slice(Math.max(0, v.length - n)); }, et, [et]); }
      case 'SkipLast': { const n = Number(intOf(a[0])); return S('ListPartition', function* () { const v = items(src); yield* v.slice(0, Math.max(0, v.length - n)); }, et, [et]); }
      case 'TakeWhile': { const p = pred(a[0], name); return S('TakeWhileIterator', function* () { for (const x of iter(src)) { if (!p(x)) return; yield x; } }, et, [et]); }
      case 'SkipWhile': { const p = pred(a[0], name); return S('SkipWhileIterator', function* () { let on = false; for (const x of iter(src)) { if (on || !p(x)) { on = true; yield x; } } }, et, [et]); }
      case 'Distinct': return S('DistinctIterator', function* () { const seen = new Hashed('HashSet'); for (const x of iter(src)) if (seen.find(x) < 0) { seen.add(x, null); yield x; } }, et, [et]);
      case 'DistinctBy': { const f = sel(a[0]); return S('DistinctByIterator', function* () { const seen = new Hashed('HashSet'); for (const x of iter(src)) { const k = f(x); if (seen.find(k) < 0) { seen.add(k, null); yield x; } } }, et, [et]); }
      case 'Concat': return S('Concat2Iterator', function* () { yield* iter(src); yield* iter(a[0]); }, et, [et]);
      case 'Union': return S('UnionIterator2', function* () { const seen = new Hashed('HashSet'); for (const x of [...iter(src), ...iter(a[0])]) if (seen.find(x) < 0) { seen.add(x, null); yield x; } }, et, [et]);
      case 'Intersect': return S('IntersectIterator', function* () { const other = new Hashed('HashSet'); for (const x of iter(a[0])) if (other.find(x) < 0) other.add(x, null); for (const x of iter(src)) if (other.find(x) >= 0) { other.remove(x); yield x; } }, et, [et]);
      case 'Except': return S('ExceptIterator', function* () { const seen = new Hashed('HashSet'); for (const x of iter(a[0])) if (seen.find(x) < 0) seen.add(x, null); for (const x of iter(src)) if (seen.find(x) < 0) { seen.add(x, null); yield x; } }, et, [et]);
      case 'Append': return S('AppendPrepend1Iterator', function* () { yield* iter(src); yield a[0]; }, et, [et]);
      case 'Prepend': return S('AppendPrepend1Iterator', function* () { yield a[0]; yield* iter(src); }, et, [et]);
      case 'Zip': { const f = a[1]; return S('ZipIterator', function* () { const o = iter(a[0]); for (const x of iter(src)) { const y = o.next(); if (y.done) return; yield f ? callFn(f, [x, y.value]) : new Tup([x, y.value], null); } }, null); }
      case 'GroupBy': {
        const kf = sel(a[0]), vf = a[1] ? sel(a[1]) : null;
        return S('GroupByIterator', function* () {
          const groups = new Hashed('Dictionary');
          for (const x of iter(src)) { const k = kf(x); let i = groups.find(k); if (i < 0) i = groups.add(k, []); groups.e[i].v.push(vf ? vf(x) : x); }
          for (const en of groups.entries()) yield new Group(en.k, en.v, et);
        }, null);
      }
      case 'Chunk': { const n = Number(intOf(a[0])); return S('ChunkIterator', function* () { let cur = []; for (const x of iter(src)) { cur.push(x); if (cur.length === n) { yield new CArr(et, cur); cur = []; } } if (cur.length) yield new CArr(et, cur); }, null); }
      case 'Cast': case 'OfType': return S(name + 'Iterator', function* () { yield* iter(src); }, et);
      case 'AsEnumerable': return src;
      // the ones that run the query
      case 'ToList': return new List(et, xs().map(copy));
      case 'ToArray': return new CArr(et || tOf(xs()[0]), xs().map(copy));
      case 'ToHashSet': { const s = new Hashed('HashSet', et, null); for (const x of xs()) setAdd(s, x); return s; }
      case 'ToDictionary': { const kf = sel(a[0]), vf = a[1] instanceof CFn ? sel(a[1]) : x => x; const d = new Hashed('Dictionary', null, null); for (const x of xs()) dictAdd(d, kf(x), vf(x), true); return d; }
      case 'ToLookup': fail('ToLookup is not supported here (use GroupBy)');
      // falls through
      case 'Count': case 'LongCount': { const n = a[0] ? xs().filter(pred(a[0], 'Count')).length : xs().length; return name === 'LongCount' ? BigInt(n) : n; }
      case 'Any': return a[0] ? xs().some(pred(a[0], 'Any')) : xs().length > 0;
      case 'All': return xs().every(pred(a[0], 'All'));
      case 'Contains': return xs().some(x => equals(x, a[0]));
      case 'Sum': return sumOf(a[0] ? xs().map(sel(a[0])) : xs());
      case 'Average': { const v = (a[0] ? xs().map(sel(a[0])) : xs()).filter(x => x !== null); if (!v.length) empty(); const s = sumOf(v); return new D(numOf(s) / v.length); }
      case 'Min': case 'Max': return minMax(xs(), name === 'Max', a[0] ? sel(a[0]) : null);
      case 'MinBy': case 'MaxBy': { const f = sel(a[0]); const v = xs(); if (!v.length) return et && /^(int|long|double|char|bool)$/.test(et.n) ? empty() : null; let best = v[0], bk = f(best); for (const x of v.slice(1)) { const k = f(x); if (name === 'MaxBy' ? compare(k, bk) > 0 : compare(k, bk) < 0) { best = x; bk = k; } } return best; }
      case 'Aggregate': {
        const v = xs();
        if (a.length === 1) { if (!v.length) empty(); return v.slice(1).reduce((acc, x) => callFn(a[0], [acc, x]), v[0]); }
        const r = v.reduce((acc, x) => callFn(a[1], [acc, x]), a[0]);
        return a[2] ? callFn(a[2], [r]) : r;
      }
      case 'First': case 'FirstOrDefault': case 'Last': case 'LastOrDefault': case 'Single': case 'SingleOrDefault': {
        const p = a[0] instanceof CFn ? pred(a[0], name) : null;
        let v = xs();
        if (p) v = v.filter(p);
        if (name.startsWith('Single') && v.length > 1) throwCs('InvalidOperationException', p ? 'Sequence contains more than one matching element' : 'Sequence contains more than one element');
        if (!v.length) { if (name.endsWith('OrDefault')) return a[0] !== undefined && !(a[0] instanceof CFn) ? a[0] : a[1] !== undefined ? a[1] : zero(et); throwCs('InvalidOperationException', p ? 'Sequence contains no matching element' : 'Sequence contains no elements'); }
        return name.startsWith('Last') ? v.at(-1) : v[0];
      }
      case 'ElementAt': case 'ElementAtOrDefault': { const v = xs(), k = Number(intOf(a[0])); if (k < 0 || k >= v.length) { if (name.endsWith('OrDefault')) return zero(et); throwCs('ArgumentOutOfRangeException', 'Index was out of range. Must be non-negative and less than the size of the collection.', 'index'); } return v[k]; }
      case 'SequenceEqual': { const p = xs(), q = items(a[0]); return p.length === q.length && p.every((x, k) => equals(x, q[k])); }
      case 'DefaultIfEmpty': return S('DefaultIfEmptyIterator', function* () { const v = items(src); if (v.length) yield* v; else yield a[0] !== undefined ? a[0] : zero(et); }, et, [et]);
      case 'ForEach': fail("CS1061: 'IEnumerable' does not contain a definition for 'ForEach' (it is a method of List<T>: call .ToList() first, or use foreach)");
    }
    return undefined;
  }
  const LINQ_NAMES = new Set(['Where', 'Select', 'SelectMany', 'OrderBy', 'OrderByDescending', 'ThenBy', 'ThenByDescending', 'Order', 'OrderDescending', 'Reverse', 'Take', 'Skip', 'TakeLast', 'SkipLast',
    'TakeWhile', 'SkipWhile', 'Distinct', 'DistinctBy', 'Concat', 'Union', 'Intersect', 'Except', 'Append', 'Prepend', 'Zip', 'GroupBy', 'Chunk', 'Cast', 'OfType', 'AsEnumerable', 'ToList', 'ToArray',
    'ToHashSet', 'ToDictionary', 'ToLookup', 'Count', 'LongCount', 'Any', 'All', 'Contains', 'Sum', 'Average', 'Min', 'Max', 'MinBy', 'MaxBy', 'Aggregate', 'First', 'FirstOrDefault', 'Last',
    'LastOrDefault', 'Single', 'SingleOrDefault', 'ElementAt', 'ElementAtOrDefault', 'SequenceEqual', 'DefaultIfEmpty', 'ForEach']);
  const needsLinq = () => { if (!api.usings().some(u => u.n === 'System.Linq') && !implicitUsings()) return true; return false; };
  /** top-level programs get .NET's implicit usings (System, System.Linq, System.Collections.Generic…) */
  const implicitUsings = () => true;
  const isEnumerable = v => v instanceof CArr || typeof v === 'string' || v instanceof List || v instanceof Hashed || v instanceof Sorted || v instanceof Queue || v instanceof Stack || v instanceof Seq || v instanceof View;

  /* ---- strings ---- */
  const outOfRange = (param, msg = 'Index was out of range. Must be non-negative and less than the size of the collection.') => throwCs('ArgumentOutOfRangeException', msg, param);
  const sArg = (v, what) => (typeof v === 'string' ? v : v instanceof Ch ? String.fromCharCode(v.c) : v === null ? throwCs('ArgumentNullException', null, what || 'value') : fail(`CS1503: Argument 1: cannot convert from '${csType(v)}' to 'string'`));
  const isWs = c => /\s/.test(String.fromCharCode(c));
  function stringMethod(s, name, a, refs) {
    const n = a.length;
    switch (name) {
      case 'Substring': {
        const st = Number(intOf(a[0]));
        if (st < 0) outOfRange('startIndex', 'StartIndex cannot be less than zero.');
        if (st > s.length) outOfRange('startIndex', 'startIndex cannot be larger than length of string.');
        if (n === 1) return s.slice(st);
        const len = Number(intOf(a[1]));
        if (len < 0) outOfRange('length', 'Length cannot be less than zero.');
        if (st + len > s.length) outOfRange('length', 'Index and length must refer to a location within the string.');
        return s.substr(st, len);
      }
      case 'IndexOf': case 'LastIndexOf': {
        const x = sArg(a[0]);
        if (name === 'IndexOf') return n > 1 && typeof a[1] === 'number' ? s.indexOf(x, a[1]) : s.indexOf(x);
        return n > 1 && typeof a[1] === 'number' ? s.lastIndexOf(x, a[1]) : s.lastIndexOf(x);
      }
      case 'IndexOfAny': { const set = items(a[0]).map(c => String.fromCharCode(c.c)); for (let i = 0; i < s.length; i++) if (set.includes(s[i])) return i; return -1; }
      case 'Contains': return n > 1 && a[1] instanceof EnumV && /IgnoreCase/.test(toStr(a[1])) ? s.toLowerCase().includes(sArg(a[0]).toLowerCase()) : s.includes(sArg(a[0]));
      case 'StartsWith': return n > 1 && a[1] instanceof EnumV && /IgnoreCase/.test(toStr(a[1])) ? s.toLowerCase().startsWith(sArg(a[0]).toLowerCase()) : s.startsWith(sArg(a[0]));
      case 'EndsWith': return s.endsWith(sArg(a[0]));
      case 'ToUpper': case 'ToUpperInvariant': return s.toUpperCase();
      case 'ToLower': case 'ToLowerInvariant': return s.toLowerCase();
      case 'Trim': case 'TrimStart': case 'TrimEnd': {
        const set = n ? new Set(a.flatMap(x => (x instanceof CArr ? x.a : [x])).map(c => c.c)) : null;
        const drop = c => (set ? set.has(c) : isWs(c));
        let i = 0, j = s.length;
        if (name !== 'TrimEnd') while (i < j && drop(s.charCodeAt(i))) i++;
        if (name !== 'TrimStart') while (j > i && drop(s.charCodeAt(j - 1))) j--;
        return s.slice(i, j);
      }
      case 'Split': {
        let seps = [], opts = 0, count = Infinity;
        for (const x of a) {
          if (x instanceof EnumV) opts = x.v;
          else if (typeof x === 'number') count = x;
          else if (x instanceof CArr) seps.push(...x.a.map(c => (c instanceof Ch ? String.fromCharCode(c.c) : c)));
          else if (x !== null) seps.push(sArg(x));
        }
        let parts;
        if (!seps.length) { parts = []; let cur = ''; for (const c of s) { if (/\s/.test(c)) { parts.push(cur); cur = ''; } else cur += c; } parts.push(cur); }
        else { parts = []; let cur = '', i = 0; while (i < s.length) { const m = seps.find(p => p && s.startsWith(p, i)); if (m && parts.length < count - 1) { parts.push(cur); cur = ''; i += m.length; } else { cur += s[i]; i++; } } parts.push(cur); }
        if (opts & 2) parts = parts.map(p => p.trim());
        if (opts & 1) parts = parts.filter(p => p !== '');
        return new CArr(STR, parts);
      }
      case 'Replace': { const x = sArg(a[0]), y = a[1] === null ? '' : sArg(a[1]); if (x === '') throwCs('ArgumentException', 'String cannot be of zero length.', 'oldValue'); return s.split(x).join(y); }
      case 'Insert': { const i = Number(intOf(a[0])); if (i < 0 || i > s.length) outOfRange('startIndex'); return s.slice(0, i) + sArg(a[1]) + s.slice(i); }
      case 'Remove': { const i = Number(intOf(a[0])); if (i < 0 || i > s.length) outOfRange('startIndex', 'startIndex must be less than length of string.'); return n > 1 ? s.slice(0, i) + s.slice(i + Number(intOf(a[1]))) : s.slice(0, i); }
      case 'PadLeft': case 'PadRight': { const w = Number(intOf(a[0])), c = n > 1 ? String.fromCharCode(a[1].c) : ' '; return name === 'PadLeft' ? s.padStart(w, c) : s.padEnd(w, c); }
      case 'ToCharArray': return new CArr(CHR, [...Array(s.length)].map((_, i) => CH(s.charCodeAt(i))));
      case 'CompareTo': return a[0] === null ? 1 : compare(s, sArg(a[0]));
      case 'Equals': return n > 1 && a[1] instanceof EnumV && /IgnoreCase/.test(toStr(a[1])) ? typeof a[0] === 'string' && s.toLowerCase() === a[0].toLowerCase() : s === a[0];
      case 'ToString': return s;
      case 'GetHashCode': return strHash(s);
      case 'Normalize': return s.normalize();
      case 'Length': return s.length;
      case 'Clone': return s;
      case 'IsNormalized': return true;
    }
    if (LINQ_NAMES.has(name)) return linq(s, name, a);
    void refs;
    return undefined;
  }
  /** string.GetHashCode is random per run in .NET; this one is fixed */
  const strHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0; return h; };

  /* ---- methods of values: list.Add(…), dict.TryGetValue(…), 5.ToString("D3")… ---- */
  function callMethod(v, name, a, refs, e) {
    const n = a.length;
    const setOut = (k, x) => { if (!refs[k]) fail(`CS1620: Argument ${k + 1} must be passed with the 'out' keyword`); refs[k].set(x); refs[k].assigned = true; };
    if (v === null || v === undefined) nre();
    if (typeof v === 'string') { const r = stringMethod(v, name, a, refs); if (r !== undefined) return r; }
    const k = kindOf(v);
    if (k !== 'ref' && k !== 'string') {
      switch (name) {
        case 'ToString': return n ? format(v, a[0]) : toStr(v);
        case 'CompareTo': return a[0] === null ? 1 : compare(v, a[0]);
        case 'Equals': return equals(v, a[0]);
        case 'GetHashCode': return typeof v === 'number' ? v : v instanceof Ch ? v.c | (v.c << 16) : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(BigInt.asIntN(32, v ^ (v >> 32n))) : Math.floor(v.v) | 0;
        case 'GetType': return new TypeObj(k, netType(v));
        case 'HasValue': return true;
        case 'GetValueOrDefault': return v;
      }
    }
    if (v instanceof CArr) {
      switch (name) {
        case 'GetLength': { const d = Number(intOf(a[0])); if (!v.dims) { if (d !== 0) throwCs('IndexOutOfRangeException'); return v.a.length; } if (d < 0 || d >= v.dims.length) throwCs('IndexOutOfRangeException'); return v.dims[d]; }
        case 'GetUpperBound': { const d = Number(intOf(a[0])); return (v.dims ? v.dims[d] : v.a.length) - 1; }
        case 'Clone': return new CArr(v.et, v.a.map(copy), v.dims && v.dims.slice());
        case 'CopyTo': { const dst = a[0], at = Number(intOf(a[1] ?? 0)); if (at + v.a.length > dst.a.length) throwCs('ArgumentException', 'Destination array was not long enough. Check the destination index, length, and the array\'s lower bounds.', 'destinationArray'); v.a.forEach((x, j) => { dst.a[at + j] = copy(x); }); return undefined; }
        case 'GetType': return new TypeObj(csType(v), netType(v));
        case 'ToString': return netType(v);
        case 'Equals': return v === a[0];
        case 'GetHashCode': return idOf(v);
      }
      if (LINQ_NAMES.has(name)) { const r = linq(v, name, a); if (r !== undefined) return r; }
    }
    if (v instanceof List) {
      const L = v.a;
      const idx = (x, max = L.length) => { const i = Number(intOf(x)); if (i < 0 || i >= max) outOfRange('index'); return i; };
      switch (name) {
        case 'Add': L.push(conv(a[0], v.et)); v.ver++; return undefined;
        case 'AddRange': { const xs = items(a[0]); L.push(...xs.map(x => conv(x, v.et))); v.ver++; return undefined; }
        case 'Insert': { const i = Number(intOf(a[0])); if (i < 0 || i > L.length) outOfRange('index', 'Index must be within the bounds of the List.'); L.splice(i, 0, conv(a[1], v.et)); v.ver++; return undefined; }
        case 'InsertRange': { const i = Number(intOf(a[0])); L.splice(i, 0, ...items(a[1])); v.ver++; return undefined; }
        case 'Remove': { const i = L.findIndex(x => equals(x, a[0])); if (i < 0) return false; L.splice(i, 1); v.ver++; return true; }
        case 'RemoveAt': { const i = idx(a[0]); L.splice(i, 1); v.ver++; return undefined; }
        case 'RemoveRange': { const i = Number(intOf(a[0])), c = Number(intOf(a[1])); if (i < 0 || c < 0 || i + c > L.length) throwCs('ArgumentException', 'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'); L.splice(i, c); v.ver++; return undefined; }
        case 'RemoveAll': { const p = pred(a[0], 'RemoveAll'); const keep = L.filter(x => !p(x)); const r = L.length - keep.length; v.a = keep; v.ver++; return r; }
        case 'Clear': L.length = 0; v.ver++; return undefined;
        case 'Contains': return L.some(x => equals(x, a[0]));
        case 'IndexOf': { const from = n > 1 ? Number(intOf(a[1])) : 0; for (let i = from; i < L.length; i++) if (equals(L[i], a[0])) return i; return -1; }
        case 'LastIndexOf': { for (let i = L.length - 1; i >= 0; i--) if (equals(L[i], a[0])) return i; return -1; }
        case 'Find': { const p = pred(a[0], 'Find'); const x = L.find(p); return x === undefined ? zero(v.et) : x; }
        case 'FindLast': { const p = pred(a[0], 'FindLast'); for (let i = L.length - 1; i >= 0; i--) if (p(L[i])) return L[i]; return zero(v.et); }
        case 'FindAll': { const p = pred(a[0], 'FindAll'); return new List(v.et, L.filter(p)); }
        case 'FindIndex': { const p = pred(a.at(-1), 'FindIndex'); return L.findIndex(p); }
        case 'FindLastIndex': { const p = pred(a.at(-1), 'FindLastIndex'); for (let i = L.length - 1; i >= 0; i--) if (p(L[i])) return i; return -1; }
        case 'Exists': return L.some(pred(a[0], 'Exists'));
        case 'TrueForAll': return L.every(pred(a[0], 'TrueForAll'));
        case 'ForEach': { const v0 = v.ver; for (const x of L.slice()) { if (v.ver !== v0) throwCs('InvalidOperationException', 'Collection was modified; enumeration operation may not execute.'); callFn(a[0], [x]); } return undefined; }
        case 'Sort': {
          if (n === 3 || n === 4) fail('List.Sort(index, count, comparer) is not supported here');
          introSort(L, 0, L.length, comparer(a[0])); v.ver++; return undefined;
        }
        case 'Reverse': if (n === 2) { const i = Number(intOf(a[0])), c = Number(intOf(a[1])); const part = L.splice(i, c).reverse(); L.splice(i, 0, ...part); } else L.reverse(); v.ver++; return undefined;
        case 'ToArray': return new CArr(v.et, L.map(copy));
        case 'GetRange': { const i = Number(intOf(a[0])), c = Number(intOf(a[1])); if (i < 0 || c < 0 || i + c > L.length) throwCs('ArgumentException', 'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'); return new List(v.et, L.slice(i, i + c).map(copy)); }
        case 'BinarySearch': { const cmp = comparer(a[1]); let lo = 0, hi = L.length - 1; while (lo <= hi) { const m = lo + ((hi - lo) >> 1), c = cmp(L[m], a[0]); if (c === 0) return m; if (c < 0) lo = m + 1; else hi = m - 1; } return ~lo; }
        case 'ConvertAll': return new List(null, L.map(sel(a[0])));
        case 'CopyTo': { const dst = a[0]; L.forEach((x, j) => { dst.a[j + Number(a[1] ?? 0)] = copy(x); }); return undefined; }
        case 'EnsureCapacity': case 'TrimExcess': return undefined;
        case 'AsReadOnly': return v;
        case 'Slice': { const i = Number(intOf(a[0])), c = Number(intOf(a[1])); return new List(v.et, L.slice(i, i + c)); }
      }
      if (LINQ_NAMES.has(name)) { const r = linq(v, name, a); if (r !== undefined) return r; }
    }
    if (v instanceof Hashed || v instanceof Sorted) {
      const isSet = v.kind.endsWith('Set');
      if (isSet) {
        const other = () => items(a[0]);
        switch (name) {
          case 'Add': return setAdd(v, conv(a[0], v.kt));
          case 'Remove': return setRemove(v, a[0]);
          case 'Contains': return setHas(v, a[0]);
          case 'Clear': if (v instanceof Hashed) v.clear(); else { v.a = []; v.ver++; } return undefined;
          case 'UnionWith': for (const x of other()) setAdd(v, x); return undefined;
          case 'IntersectWith': { const o = other(); for (const x of items(v)) if (!o.some(y => equals(x, y))) setRemove(v, x); return undefined; }
          case 'ExceptWith': for (const x of other()) setRemove(v, x); return undefined;
          case 'SymmetricExceptWith': for (const x of other()) if (!setRemove(v, x)) setAdd(v, x); return undefined;
          case 'IsSubsetOf': { const o = other(); return items(v).every(x => o.some(y => equals(x, y))); }
          case 'IsSupersetOf': return other().every(x => setHas(v, x));
          case 'IsProperSubsetOf': { const o = other(); return items(v).every(x => o.some(y => equals(x, y))) && o.length > v.count; }
          case 'Overlaps': return other().some(x => setHas(v, x));
          case 'SetEquals': { const o = other(); return o.every(x => setHas(v, x)) && items(v).every(x => o.some(y => equals(x, y))); }
          case 'TryGetValue': { const i = v instanceof Hashed ? v.find(a[0]) : -1; setOut(1, i >= 0 ? v.e[i].k : zero(v.kt)); return i >= 0; }
          case 'RemoveWhere': { const p = pred(a[0], 'RemoveWhere'); let r = 0; for (const x of items(v)) if (p(x)) { setRemove(v, x); r++; } return r; }
          case 'GetViewBetween': { const s = new Sorted('SortedSet', v.kt, null, v.cmp); for (const en of v.a) if (v.cmp(en.k, a[0]) >= 0 && v.cmp(en.k, a[1]) <= 0) s.a.push({ k: en.k }); return s; }
          case 'Reverse': return linq(v, 'Reverse', a);
        }
      } else {
        switch (name) {
          case 'Add': dictAdd(v, a[0], a[1], true); return undefined;
          case 'TryAdd': { if (dictGet(v, a[0]) !== undefined) return false; dictAdd(v, a[0], a[1], true); return true; }
          case 'ContainsKey': if (a[0] === null) throwCs('ArgumentNullException', null, 'key'); return dictGet(v, a[0]) !== undefined;
          case 'ContainsValue': return v.entries().some(en => equals(en.v, a[0]));
          case 'Remove': { if (a[0] === null) throwCs('ArgumentNullException', null, 'key'); const en = dictRemove(v, a[0]); if (n > 1) setOut(1, en ? en.v : zero(v.vt)); return !!en; }
          case 'TryGetValue': { const x = dictGet(v, a[0]); setOut(1, x === undefined ? zero(v.vt) : x); return x !== undefined; }
          case 'GetValueOrDefault': { const x = dictGet(v, a[0]); return x === undefined ? (n > 1 ? a[1] : zero(v.vt)) : x; }
          case 'Clear': if (v instanceof Hashed) v.clear(); else { v.a = []; v.ver++; } return undefined;
          case 'EnsureCapacity': case 'TrimExcess': return 0;
        }
      }
      if (LINQ_NAMES.has(name)) { const r = linq(v, name, a); if (r !== undefined) return r; }
    }
    if (v instanceof Queue) {
      switch (name) {
        case 'Enqueue': v.a.push(conv(a[0], v.et)); v.ver++; return undefined;
        case 'Dequeue': if (!v.a.length) throwCs('InvalidOperationException', 'Queue empty.'); v.ver++; return v.a.shift();
        case 'Peek': if (!v.a.length) throwCs('InvalidOperationException', 'Queue empty.'); return v.a[0];
        case 'TryDequeue': if (!v.a.length) { setOut(0, zero(v.et)); return false; } v.ver++; setOut(0, v.a.shift()); return true;
        case 'TryPeek': if (!v.a.length) { setOut(0, zero(v.et)); return false; } setOut(0, v.a[0]); return true;
        case 'Contains': return v.a.some(x => equals(x, a[0]));
        case 'Clear': v.a = []; v.ver++; return undefined;
        case 'ToArray': return new CArr(v.et, v.a.slice());
      }
      if (LINQ_NAMES.has(name)) { const r = linq(v, name, a); if (r !== undefined) return r; }
    }
    if (v instanceof Stack) {
      switch (name) {
        case 'Push': v.a.push(conv(a[0], v.et)); v.ver++; return undefined;
        case 'Pop': if (!v.a.length) throwCs('InvalidOperationException', 'Stack empty.'); v.ver++; return v.a.pop();
        case 'Peek': if (!v.a.length) throwCs('InvalidOperationException', 'Stack empty.'); return v.a.at(-1);
        case 'TryPop': if (!v.a.length) { setOut(0, zero(v.et)); return false; } v.ver++; setOut(0, v.a.pop()); return true;
        case 'TryPeek': if (!v.a.length) { setOut(0, zero(v.et)); return false; } setOut(0, v.a.at(-1)); return true;
        case 'Contains': return v.a.some(x => equals(x, a[0]));
        case 'Clear': v.a = []; v.ver++; return undefined;
        case 'ToArray': return new CArr(v.et, v.a.slice().reverse());
      }
      if (LINQ_NAMES.has(name)) { const r = linq(v, name, a); if (r !== undefined) return r; }
    }
    if (v instanceof PQ) {
      switch (name) {
        case 'Enqueue': { v.h.push(null); pqUp(v, [conv(a[0], v.et), conv(a[1], v.pt)], v.h.length - 1); v.ver++; return undefined; }
        case 'Dequeue': return pqPop(v)[0];
        case 'Peek': if (!v.h.length) throwCs('InvalidOperationException', 'Queue empty.'); return v.h[0][0];
        case 'TryDequeue': if (!v.h.length) { setOut(0, zero(v.et)); setOut(1, zero(v.pt)); return false; } { const [x, p] = pqPop(v); setOut(0, x); setOut(1, p); return true; }
        case 'TryPeek': if (!v.h.length) { setOut(0, zero(v.et)); setOut(1, zero(v.pt)); return false; } setOut(0, v.h[0][0]); setOut(1, v.h[0][1]); return true;
        case 'EnqueueDequeue': { if (v.h.length && v.cmp(a[1], v.h[0][1]) > 0) { const top = v.h[0]; pqDown(v, [a[0], a[1]], 0); return top[0]; } return a[0]; }
        case 'Clear': v.h = []; v.ver++; return undefined;
        case 'EnqueueRange': for (const t of items(a[0])) { v.h.push(null); pqUp(v, t instanceof Tup ? [t.a[0], t.a[1]] : [t, a[1]], v.h.length - 1); } return undefined;
      }
    }
    if (v instanceof SB) {
      switch (name) {
        case 'Append': v.s += n === 0 ? '' : a[0] instanceof CArr ? a[0].a.map(toStr).join('') : n === 2 && a[0] instanceof Ch ? String.fromCharCode(a[0].c).repeat(Number(a[1])) : toStr(a[0]); return v;
        case 'AppendLine': v.s += (n ? toStr(a[0]) : '') + '\n'; return v;
        case 'AppendFormat': v.s += composite(a[0], a.slice(1)); return v;
        case 'Insert': { const i = Number(intOf(a[0])); if (i < 0 || i > v.s.length) outOfRange('index'); v.s = v.s.slice(0, i) + toStr(a[1]) + v.s.slice(i); return v; }
        case 'Remove': { const i = Number(intOf(a[0])), c = Number(intOf(a[1])); if (i < 0 || c < 0 || i + c > v.s.length) outOfRange('length', 'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'); v.s = v.s.slice(0, i) + v.s.slice(i + c); return v; }
        case 'Replace': v.s = v.s.split(toStr(a[0])).join(toStr(a[1])); return v;
        case 'Clear': v.s = ''; return v;
        case 'ToString': return n === 2 ? v.s.substr(Number(a[0]), Number(a[1])) : v.s;
        case 'Equals': return v === a[0];
      }
    }
    if (v instanceof Rand) {
      switch (name) {
        case 'Next': {
          if (n === 0) return v.next();
          if (n === 1) { const max = Number(intOf(a[0])); if (max < 0) outOfRange('maxValue', "'maxValue' must be greater than or equal to zero."); return Math.floor(v.double() * max); }
          const lo = Number(intOf(a[0])), hi = Number(intOf(a[1]));
          if (lo > hi) outOfRange('minValue', "'minValue' cannot be greater than maxValue.");
          return Math.floor(v.double() * (hi - lo)) + lo;
        }
        case 'NextDouble': return new D(v.double());
        case 'NextInt64': { const hi = n ? Number(intOf(a.at(-1))) : 2 ** 53, lo = n === 2 ? Number(intOf(a[0])) : 0; return BigInt(Math.floor(v.double() * (hi - lo)) + lo); }
        case 'Shuffle': { const arr = a[0].a; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(v.double() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return undefined; }
      }
    }
    if (v instanceof KV) {
      if (name === 'Deconstruct') { setOut(0, v.k); setOut(1, v.v); return undefined; }
      if (name === 'ToString') return toStr(v);
    }
    if (v instanceof Tup) {
      switch (name) {
        case 'ToString': return toStr(v);
        case 'Equals': return equals(v, a[0]);
        case 'CompareTo': return compare(v, a[0]);
        case 'GetHashCode': return 0;
      }
    }
    if (v instanceof EnumV) {
      switch (name) {
        case 'ToString': return n ? format(v, a[0]) : toStr(v);
        case 'HasFlag': return (v.v & a[0].v) === a[0].v;
        case 'CompareTo': return Math.sign(v.v - a[0].v);
        case 'Equals': return a[0] instanceof EnumV && a[0].v === v.v && a[0].e === v.e;
        case 'GetHashCode': return v.v;
        case 'GetType': return new TypeObj(v.e.name, v.e.full);
      }
    }
    if (v instanceof TypeObj) { if (name === 'ToString') return v.full; if (name === 'Equals') return a[0] instanceof TypeObj && a[0].full === v.full; }
    if (v instanceof Cmp && name === 'Compare') return v.fn(a[0], a[1]);
    if (v instanceof Writer) { if (name === 'WriteLine' || name === 'Write') { write(writeText(a, name === 'WriteLine'), v.err); return undefined; } }
    if (v instanceof Group || v instanceof View || v instanceof Seq) { const r = linq(v, name, a); if (r !== undefined) return r; }
    if (name === 'GetType') return new TypeObj(csTypeLib(v), netTypeLib(v));
    if (name === 'ToString') return toStr(v);
    if (name === 'Equals') return equals(v, a[0]);
    if (name === 'GetHashCode') return idOf(v);
    if (name === 'GetEnumerator') fail('GetEnumerator is not supported here (use foreach)');
    fail(`CS1061: '${csType(v)}' does not contain a definition for '${name}' and no accessible extension method '${name}' accepting a first argument of type '${csType(v)}' could be found` + hint(v, name));
  }
  const hint = (v, name) => (v instanceof List && name === 'Length' ? ' (a List has Count)' : v instanceof CArr && (name === 'Count' || name === 'Size') ? ' (an array has Length)' : typeof v === 'string' && name === 'Count' ? ' (a string has Length)' : v instanceof Hashed && name === 'Push' ? '' : '');
  const hasMethod = (v, name) => (v instanceof List || v instanceof Hashed || v instanceof Queue || v instanceof Stack || typeof v === 'string') && LINQ_NAMES.has(name) === false;

  /** the text Console.Write(Line) writes for its arguments */
  function writeText(a, line) {
    let s;
    if (!a.length) s = '';
    else if (a.length > 1 && typeof a[0] === 'string') s = composite(a[0], a.slice(1).length === 1 && a[1] instanceof CArr && a[1].et && a[1].et.n === 'object' ? a[1].a : a.slice(1));
    else if (a[0] instanceof CArr && a[0].et && a[0].et.n === 'char') s = a[0].a.map(c => String.fromCharCode(c.c)).join('');
    else s = toStr(a[0]);
    return s + (line ? '\n' : '');
  }

  /* ---- properties: list.Count, s.Length, kv.Key, dict.Keys… ---- */
  function getProp(v, n, e) {
    if (typeof v === 'string') { if (n === 'Length') return v.length; }
    if (v instanceof CArr) { if (n === 'Length') return v.a.length; if (n === 'LongLength') return BigInt(v.a.length); if (n === 'Rank') return v.dims ? v.dims.length : 1; }
    if (v instanceof List) { if (n === 'Count') return v.a.length; if (n === 'Capacity') return Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(1, v.a.length)))); }
    if (v instanceof Hashed || v instanceof Sorted) {
      if (n === 'Count') return v.count;
      if (n === 'Keys' && !v.kind.endsWith('Set')) return new View(v, 'k');
      if (n === 'Values' && !v.kind.endsWith('Set')) return new View(v, 'v');
      if (v.kind === 'SortedSet' && (n === 'Min' || n === 'Max')) return v.a.length ? v.a[n === 'Min' ? 0 : v.a.length - 1].k : zero(v.kt);
      if (n === 'Comparer') return new Cmp(v.cmp || compare);
    }
    if (v instanceof Queue || v instanceof Stack) { if (n === 'Count') return v.a.length; }
    if (v instanceof PQ) { if (n === 'Count') return v.h.length; if (n === 'UnorderedItems') { const s = new Seq('UnorderedItemsCollection', function* () { for (const [x, p] of v.h) yield new Tup([x, p], ['Element', 'Priority']); }); return s; } }
    if (v instanceof SB) { if (n === 'Length') return v.s.length; if (n === 'Capacity') return Math.max(16, v.s.length); }
    if (v instanceof KV) { if (n === 'Key') return v.k; if (n === 'Value') return v.v; }
    if (v instanceof Group) { if (n === 'Key') return v.key; }
    if (v instanceof View) { if (n === 'Count') return v.d.count; }
    if (v instanceof TypeObj) { if (n === 'Name') return v.full.replace(/^.*[.+]/, '').replace(/\[.*$/, ''); if (n === 'FullName') return v.full; }
    if (v instanceof Tup) { const m = /^Item(\d+)$/.exec(n); if (m) return v.a[+m[1] - 1]; }
    if (v instanceof Writer && n === 'NewLine') return '\n';
    if (n === 'Length' && v instanceof List) fail(`CS1061: 'List<${tt(v.et)}>' does not contain a definition for 'Length' (a List has Count)`);
    fail(`CS1061: '${csType(v)}' does not contain a definition for '${n}'` + hint(v, n));
    void e;
  }
  function setProp(v, n, x) {
    if (v instanceof SB && n === 'Length') { const len = Number(intOf(x)); v.s = len <= v.s.length ? v.s.slice(0, len) : v.s + '\0'.repeat(len - v.s.length); return; }
    if (v instanceof List && n === 'Capacity') return;
    if (v instanceof CArr && n === 'Length') fail("CS0200: Property or indexer 'Array.Length' cannot be assigned to -- it is read only");
    if (v instanceof List && n === 'Count') fail("CS0200: Property or indexer 'List<T>.Count' cannot be assigned to -- it is read only");
    if (v instanceof KV) fail(`CS0200: Property or indexer 'KeyValuePair.${n}' cannot be assigned to -- it is read only`);
    fail(`CS1061: '${csType(v)}' does not contain a definition for '${n}'`);
  }
  /** the [] of a List, a Dictionary, a StringBuilder */
  function getIndex(c, a) {
    const k = a[0];
    if (c instanceof List) {
      if (k && k.fromEnd) { const i = c.a.length - k.n; if (i < 0 || i >= c.a.length) outOfRange('index'); return c.a[i]; }
      if (k && k.range) return slice(c, k);
      const i = Number(intOf(k));
      if (i < 0 || i >= c.a.length) outOfRange('index');
      return c.a[i];
    }
    if (c instanceof Hashed || c instanceof Sorted) {
      if (c.kind.endsWith('Set')) fail(`CS0021: Cannot apply indexing with [] to an expression of type '${csTypeLib(c)}' (a set has no positions: use Contains, or foreach)`);
      const v = dictGet(c, k);
      if (v === undefined) throwCs('KeyNotFoundException', `The given key '${toStr(k)}' was not present in the dictionary.`);
      return v;
    }
    if (c instanceof SB) { const i = Number(intOf(k)); if (i < 0 || i >= c.s.length) outOfRange('index'); return CH(c.s.charCodeAt(i)); }
    if (c instanceof Tup) fail("CS0021: Cannot apply indexing with [] to an expression of type 'tuple' (use .Item1, .Item2…)");
    if (c instanceof Queue || c instanceof Stack || c instanceof Seq || c instanceof View) fail(`CS0021: Cannot apply indexing with [] to an expression of type '${csType(c)}'` + (c instanceof Seq ? ' (use .ElementAt(i), or .ToList() first)' : ''));
    fail(`CS0021: Cannot apply indexing with [] to an expression of type '${csType(c)}'`);
  }
  function setIndex(c, a, v) {
    const k = a[0];
    if (c instanceof List) { const i = k && k.fromEnd ? c.a.length - k.n : Number(intOf(k)); if (i < 0 || i >= c.a.length) outOfRange('index'); c.a[i] = conv(v, c.et); c.ver++; return; }
    if (c instanceof Hashed || c instanceof Sorted) { if (c.kind.endsWith('Set')) fail(`CS0021: Cannot apply indexing with [] to an expression of type '${csTypeLib(c)}'`); dictAdd(c, k, v, false); return; }
    if (c instanceof SB) { const i = Number(intOf(k)); if (i < 0 || i >= c.s.length) outOfRange('index'); c.s = c.s.slice(0, i) + toStr(v) + c.s.slice(i + 1); return; }
    fail(`CS0021: Cannot apply indexing with [] to an expression of type '${csType(c)}'`);
  }
  /** a[1..3], s[2..], a[..^1] */
  function slice(c, r) {
    const len = typeof c === 'string' ? c.length : c instanceof List ? c.a.length : c.a.length;
    const at = x => (x === null ? null : x && x.fromEnd ? len - x.n : Number(intOf(x)));
    const lo = r.a === null ? 0 : at(r.a), hi = r.b === null ? len : at(r.b);
    if (lo < 0 || hi > len || lo > hi) outOfRange('length', 'Index was out of range. Must be non-negative and less than or equal to the size of the collection.');
    if (typeof c === 'string') return c.slice(lo, hi);
    if (c instanceof List) return new List(c.et, c.a.slice(lo, hi));
    return new CArr(c.et, c.a.slice(lo, hi).map(copy));
  }

  /* ---- statics: Math.Max, int.Parse, Console.WriteLine, string.Join, Array.Sort, Enumerable.Range… ---- */
  const LIB_ENUMS = {};
  const libEnum = (name, members, ns = 'System') => {
    const e = { name, full: ns + '.' + name, members: [], byVal: new Map(), vals: new Map(), isEnum: true };
    members.forEach(([m, v]) => { const ev = new EnumV(e, v); e.vals.set(m, ev); e.byVal.set(v, m); e.members.push({ name: m, v }); });
    LIB_ENUMS[name] = e;
  };
  libEnum('StringSplitOptions', [['None', 0], ['RemoveEmptyEntries', 1], ['TrimEntries', 2]]);
  libEnum('MidpointRounding', [['ToEven', 0], ['AwayFromZero', 1], ['ToZero', 2], ['ToNegativeInfinity', 3], ['ToPositiveInfinity', 4]]);
  libEnum('StringComparison', [['CurrentCulture', 0], ['CurrentCultureIgnoreCase', 1], ['InvariantCulture', 2], ['InvariantCultureIgnoreCase', 3], ['Ordinal', 4], ['OrdinalIgnoreCase', 5]]);
  const STATIC_TYPES = new Set(['Math', 'Console', 'string', 'String', 'int', 'Int32', 'long', 'Int64', 'double', 'Double', 'float', 'Single', 'char', 'Char', 'bool', 'Boolean', 'byte', 'short', 'uint', 'ulong',
    'Convert', 'Array', 'Enumerable', 'Environment', 'Tuple', 'KeyValuePair', 'Comparer', 'StringComparer', 'Random', 'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'PriorityQueue', 'SortedSet',
    'SortedDictionary', 'StringBuilder', 'object', 'Object', 'MathF', 'Enum', 'DateTime', 'Stopwatch', 'Thread', 'Task', 'BigInteger', 'GC', 'Debug', 'Trace', 'TimeSpan', 'Guid', 'Regex', 'File', ...Object.keys(LIB_ENUMS)]);
  const ALIAS = { String: 'string', Int32: 'int', Int64: 'long', Double: 'double', Single: 'float', Char: 'char', Boolean: 'bool', Object: 'object' };
  const MAXMIN = { int: [2147483647, -2147483648], long: [9223372036854775807n, -9223372036854775808n], short: [32767, -32768], byte: [255, 0], sbyte: [127, -128], uint: [4294967295, 0], ushort: [65535, 0], ulong: [18446744073709551615n, 0n] };
  function staticMember(t0, n, e) {
    const t = ALIAS[t0] || t0;
    if (LIB_ENUMS[t]) { const v = LIB_ENUMS[t].vals.get(n); if (v) return v; }
    if (MAXMIN[t] && (n === 'MaxValue' || n === 'MinValue')) return MAXMIN[t][n === 'MaxValue' ? 0 : 1];
    if (t === 'double' || t === 'float') {
      const f = t === 'float';
      const V = { MaxValue: f ? 3.4028234663852886e38 : Number.MAX_VALUE, MinValue: f ? -3.4028234663852886e38 : -Number.MAX_VALUE, Epsilon: f ? 1.401298464324817e-45 : Number.MIN_VALUE, NaN, PositiveInfinity: Infinity, NegativeInfinity: -Infinity, Pi: Math.PI, E: Math.E };
      if (n in V) return new D(V[n], f);
    }
    if (t === 'char') { if (n === 'MaxValue') return CH(0xffff); if (n === 'MinValue') return CH(0); }
    if (t === 'Math' || t === 'MathF') { if (n === 'PI') return new D(Math.PI, t === 'MathF'); if (n === 'E') return new D(Math.E, t === 'MathF'); if (n === 'Tau') return new D(2 * Math.PI); }
    if (t === 'string' && n === 'Empty') return '';
    if (t === 'Environment' && n === 'NewLine') return '\n';
    if (t === 'Console' && (n === 'Out' || n === 'Error')) return new Writer(n === 'Error');
    if (t === 'Random' && n === 'Shared') return new Rand();
    if (t === 'Comparer' && n === 'Default') return new Cmp(compare);
    if (t === 'StringComparer') { if (n === 'Ordinal') return new Cmp((a, b) => (a < b ? -1 : a > b ? 1 : 0)); if (n === 'OrdinalIgnoreCase') return new Cmp((a, b) => { const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; }); }
    if (['DateTime', 'Stopwatch', 'Thread', 'Task', 'BigInteger', 'TimeSpan', 'Guid', 'Regex', 'File'].includes(t)) fail(`${t} is not supported here`);
    // a method used as a value: char.IsDigit, Console.WriteLine
    return new CFn({ name: t + '.' + n, native: (argv, ee, refs) => callStatic(t, n, argv, refs || [], ee || e) });
  }
  /** parsing as .NET does (invariant culture): int.Parse("42"), double.Parse("2.5") */
  function parseNum(t, s, strict) {
    if (s === null) { if (strict) throwCs('ArgumentNullException', null, 's'); return null; }
    if (typeof s !== 'string') fail(`CS1503: Argument 1: cannot convert from '${csType(s)}' to 'string'`);
    const x = s.trim();
    if (t === 'double' || t === 'float') {
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(x)) return new D(Number(x), t === 'float');
      if (/^[+-]?(Infinity|∞)$/.test(x)) return new D(x.startsWith('-') ? -Infinity : Infinity, t === 'float');
      if (x === 'NaN') return new D(NaN, t === 'float');
      if (strict) throwCs('FormatException', `The input string '${s}' was not in a correct format.`);
      return null;
    }
    if (t === 'bool') { if (/^true$/i.test(x)) return true; if (/^false$/i.test(x)) return false; if (strict) throwCs('FormatException', `String '${s}' was not recognized as a valid Boolean.`); return null; }
    if (t === 'char') { if (s.length === 1) return CH(s.charCodeAt(0)); if (strict) throwCs('FormatException', 'String must be exactly one character long.'); return null; }
    if (!/^[+-]?\d+$/.test(x)) { if (strict) throwCs('FormatException', `The input string '${s}' was not in a correct format.`); return null; }
    const big = BigInt(x);
    const [mx, mn] = MAXMIN[t] || MAXMIN.int;
    if (big > BigInt(mx) || big < BigInt(mn)) { if (strict) throwCs('OverflowException', `Value was either too large or too small for ${t === 'int' ? 'an Int32' : t === 'long' ? 'an Int64' : 'a ' + ({ short: 'Int16', byte: 'Byte', uint: 'UInt32', ulong: 'UInt64', sbyte: 'SByte', ushort: 'UInt16' }[t] || t)}.`); return null; }
    return typeof mx === 'bigint' ? big : Number(big);
  }
  /** Math.Round as .NET does it: scale, round half to even (or away from zero), scale back */
  function round(x, digits, mode) {
    const r = v => (mode === 1 ? Math.sign(v) * Math.round(Math.abs(v)) : mode === 2 ? Math.trunc(v) : mode === 3 ? Math.floor(v) : mode === 4 ? Math.ceil(v) : (() => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1; })());
    if (!digits) return r(x);
    if (Math.abs(x) >= 1e16) return x;
    const p = 10 ** digits;
    return r(x * p) / p;
  }
  function callStatic(t0, n, a, refs, e) {
    const t = ALIAS[t0] || t0;
    const setOut = (k, x) => { if (!refs[k]) fail(`CS1620: Argument ${k + 1} must be passed with the 'out' keyword`); refs[k].set(x); refs[k].assigned = true; };
    const num = k => { const v = a[k]; if (!(isInt(v) || v instanceof D || v instanceof Ch)) fail(`CS1503: Argument ${k + 1}: cannot convert from '${csType(v)}' to 'double'`); return numOf(v); };
    const isF = v => v instanceof D;
    switch (t) {
      case 'Console':
        switch (n) {
          case 'WriteLine': case 'Write': write(writeText(a, n === 'WriteLine')); return undefined;
          case 'ReadLine': case 'Read': case 'ReadKey': fail('Console.' + n + ': this page has no keyboard input (put the values in the program)');
          // falls through
          case 'Clear': case 'Beep': case 'ResetColor': case 'SetCursorPosition': return undefined;
        }
        break;
      case 'Math': case 'MathF': {
        const f32 = t === 'MathF';
        const Dv = x => new D(x, f32);
        switch (n) {
          case 'Max': case 'Min': {
            if (a.length !== 2) fail(`CS1501: No overload for method '${n}' takes ${a.length} arguments`);
            const [x, y] = a;
            if (!isF(x) && !isF(y) && isInt(x) && isInt(y)) { if (typeof x === 'bigint' || typeof y === 'bigint') { const p = BigInt(x), q = BigInt(y); return n === 'Max' ? (p > q ? p : q) : (p < q ? p : q); } return n === 'Max' ? Math.max(x, y) : Math.min(x, y); }
            if (x instanceof Ch && y instanceof Ch) return n === 'Max' ? (x.c > y.c ? x : y) : (x.c < y.c ? x : y);
            const p = num(0), q = num(1);
            return new D(Number.isNaN(p) || Number.isNaN(q) ? NaN : n === 'Max' ? Math.max(p, q) : Math.min(p, q), isF(x) && x.f && (!isF(y) || y.f));
          }
          case 'Abs': {
            const x = a[0];
            if (typeof x === 'number') { if (x === -2147483648) throwCs('OverflowException', 'Negating the minimum value of a twos complement number is invalid.'); return Math.abs(x); }
            if (typeof x === 'bigint') { if (x === -9223372036854775808n) throwCs('OverflowException', 'Negating the minimum value of a twos complement number is invalid.'); return x < 0n ? -x : x; }
            return new D(Math.abs(num(0)), isF(x) && x.f);
          }
          case 'Sign': return Math.sign(num(0));
          case 'Clamp': { const [x, lo, hi] = a; if (compare(lo, hi) > 0) throwCs('ArgumentException', `'${toStr(lo)}' cannot be greater than ${toStr(hi)}.`); return compare(x, lo) < 0 ? lo : compare(x, hi) > 0 ? hi : x; }
          case 'Round': {
            const digits = a.length > 1 && isInt(a[1]) ? Number(a[1]) : 0, mode = a.find(x => x instanceof EnumV);
            if (isInt(a[0])) return a.length === 1 ? Dv(Number(a[0])) : Dv(Number(a[0]));
            return Dv(round(num(0), digits, mode ? mode.v : 0));
          }
          case 'Floor': return Dv(Math.floor(num(0)));
          case 'Ceiling': return Dv(Math.ceil(num(0)));
          case 'Truncate': return Dv(Math.trunc(num(0)));
          case 'Sqrt': return Dv(Math.sqrt(num(0)));
          case 'Cbrt': return Dv(Math.cbrt(num(0)));
          case 'Pow': return Dv(num(0) ** num(1));
          case 'Exp': return Dv(Math.exp(num(0)));
          case 'Log': return Dv(a.length > 1 ? Math.log(num(0)) / Math.log(num(1)) : Math.log(num(0)));
          case 'Log2': return Dv(Math.log2(num(0)));
          case 'Log10': return Dv(Math.log10(num(0)));
          case 'Sin': case 'Cos': case 'Tan': case 'Asin': case 'Acos': case 'Atan': case 'Sinh': case 'Cosh': case 'Tanh': return Dv(Math[n.toLowerCase()](num(0)));
          case 'Atan2': return Dv(Math.atan2(num(0), num(1)));
          case 'Hypot': fail("CS0117: 'Math' does not contain a definition for 'Hypot' (use Math.Sqrt(x * x + y * y))");
          // falls through
          case 'BigMul': return BigInt(intOf(a[0])) * BigInt(intOf(a[1]));
          case 'DivRem': { if (a.length === 3) { const q = Math.trunc(Number(a[0]) / Number(a[1])); setOut(2, Number(a[0]) % Number(a[1])); return q; } return new Tup([Math.trunc(Number(a[0]) / Number(a[1])), Number(a[0]) % Number(a[1])]); }
        }
        break;
      }
      case 'int': case 'long': case 'short': case 'byte': case 'uint': case 'ulong': case 'double': case 'float': case 'bool': case 'char': {
        if (n === 'Parse') return parseNum(t, a[0], true);
        if (n === 'TryParse') { const r = parseNum(t, a[0], false); setOut(a.length - 1, r === null ? (t === 'bool' ? false : t === 'char' ? CH(0) : t === 'double' || t === 'float' ? new D(0, t === 'float') : t === 'long' || t === 'ulong' ? 0n : 0) : r); return r !== null; }
        if (t === 'double' || t === 'float') {
          const x = () => num(0);
          if (n === 'IsNaN') return Number.isNaN(x());
          if (n === 'IsInfinity') return !Number.isFinite(x()) && !Number.isNaN(x());
          if (n === 'IsPositiveInfinity') return x() === Infinity;
          if (n === 'IsNegativeInfinity') return x() === -Infinity;
          if (n === 'IsFinite') return Number.isFinite(x());
          if (n === 'IsInteger') return Number.isInteger(x());
        }
        if (t === 'char') {
          const c = a[0] instanceof Ch ? a[0].c : typeof a[0] === 'string' ? a[0].charCodeAt(Number(a[1] || 0)) : fail(`CS1503: Argument 1: cannot convert from '${csType(a[0])}' to 'char'`);
          const s = String.fromCharCode(c);
          switch (n) {
            case 'IsDigit': return /\p{Nd}/u.test(s);
            case 'IsLetter': return /\p{L}/u.test(s);
            case 'IsLetterOrDigit': return /[\p{L}\p{Nd}]/u.test(s);
            case 'IsUpper': return /\p{Lu}/u.test(s);
            case 'IsLower': return /\p{Ll}/u.test(s);
            case 'IsWhiteSpace': return /\s/.test(s);
            case 'IsPunctuation': return /\p{P}/u.test(s);
            case 'IsSymbol': return /\p{S}/u.test(s);
            case 'IsNumber': return /\p{N}/u.test(s);
            case 'IsControl': return /\p{Cc}/u.test(s);
            case 'IsSeparator': return /\p{Z}/u.test(s);
            case 'IsAscii': return c < 128;
            case 'IsAsciiDigit': return c >= 48 && c <= 57;
            case 'IsAsciiLetter': return /[A-Za-z]/.test(s);
            case 'IsAsciiLetterOrDigit': return /[A-Za-z0-9]/.test(s);
            case 'IsAsciiLetterUpper': return /[A-Z]/.test(s);
            case 'IsAsciiLetterLower': return /[a-z]/.test(s);
            case 'ToUpper': case 'ToUpperInvariant': return CH(s.toUpperCase().length === 1 ? s.toUpperCase().charCodeAt(0) : c);
            case 'ToLower': case 'ToLowerInvariant': return CH(s.toLowerCase().length === 1 ? s.toLowerCase().charCodeAt(0) : c);
            case 'GetNumericValue': return new D(/\d/.test(s) ? Number(s) : -1);
            case 'ToString': return s;
            case 'IsSurrogate': return c >= 0xd800 && c <= 0xdfff;
          }
        }
        if (n === 'Max' || n === 'Min' || n === 'Abs' || n === 'Clamp' || n === 'Sign') return callStatic('Math', n, a, refs, e);
        break;
      }
      case 'string':
        switch (n) {
          case 'Join': {
            const sep = a[0] instanceof Ch ? String.fromCharCode(a[0].c) : a[0] === null ? '' : sArg(a[0]);
            const rest = a.slice(1);
            const xs = rest.length === 1 && (isEnumerable(rest[0]) && typeof rest[0] !== 'string') ? items(rest[0]) : rest;
            return xs.map(toStr).join(sep);
          }
          case 'Concat': { const xs = a.length === 1 && isEnumerable(a[0]) && typeof a[0] !== 'string' ? items(a[0]) : a; return xs.map(toStr).join(''); }
          case 'Format': return composite(sArg(a[0]), a.length === 2 && a[1] instanceof CArr && a[1].et && a[1].et.n === 'object' ? a[1].a : a.slice(1));
          case 'IsNullOrEmpty': return a[0] === null || a[0] === '';
          case 'IsNullOrWhiteSpace': return a[0] === null || /^\s*$/.test(a[0]);
          case 'Compare': { if (a[0] === null || a[1] === null) return a[0] === a[1] ? 0 : a[0] === null ? -1 : 1; const ic = a[2] === true || (a[2] instanceof EnumV && /IgnoreCase/.test(toStr(a[2]))); const ord = a[2] instanceof EnumV && /^Ordinal/.test(toStr(a[2])); const x = ic ? a[0].toLowerCase() : a[0], y = ic ? a[1].toLowerCase() : a[1]; return ord ? (x < y ? -1 : x > y ? 1 : 0) : compare(x, y); }
          case 'CompareOrdinal': return a[0] < a[1] ? -1 : a[0] > a[1] ? 1 : 0;
          case 'Equals': return a[2] instanceof EnumV && /IgnoreCase/.test(toStr(a[2])) ? (a[0] || '').toLowerCase() === (a[1] || '').toLowerCase() : a[0] === a[1];
          case 'Empty': return '';
        }
        break;
      case 'Convert':
        switch (n) {
          case 'ToInt32': case 'ToInt64': case 'ToInt16': case 'ToByte': {
            const tt2 = { ToInt32: 'int', ToInt64: 'long', ToInt16: 'short', ToByte: 'byte' }[n];
            const x = a[0];
            if (typeof x === 'string') { if (a.length > 1) { const b = Number(a[1]); const v = parseInt(x, b); if (Number.isNaN(v)) throwCs('FormatException', 'Could not find any recognizable digits.'); return tt2 === 'long' ? BigInt(v) : v | 0; } return parseNum(tt2, x, true); }
            if (x === null) return tt2 === 'long' ? 0n : 0;
            if (x instanceof D) { const r = round(x.v, 0, 0); const [mx, mn] = MAXMIN[tt2]; if (r > Number(mx) || r < Number(mn) || Number.isNaN(r)) throwCs('OverflowException', `Value was either too large or too small for ${tt2 === 'int' ? 'an Int32' : 'an Int64'}.`); return tt2 === 'long' ? BigInt(r) : r; }
            if (typeof x === 'boolean') return tt2 === 'long' ? BigInt(+x) : +x;
            if (x instanceof Ch) return tt2 === 'long' ? BigInt(x.c) : x.c;
            if (isInt(x)) { const [mx, mn] = MAXMIN[tt2]; if (BigInt(x) > BigInt(mx) || BigInt(x) < BigInt(mn)) throwCs('OverflowException', `Value was either too large or too small for ${tt2 === 'int' ? 'an Int32' : 'an Int64'}.`); return tt2 === 'long' ? BigInt(x) : Number(x); }
            break;
          }
          case 'ToDouble': case 'ToSingle': { const x = a[0]; if (typeof x === 'string') return parseNum('double', x, true); if (typeof x === 'boolean') return new D(+x); if (x === null) return new D(0); return new D(numOf(x), n === 'ToSingle'); }
          case 'ToString': if (a.length > 1 && isInt(a[0])) { const b = Number(a[1]); let v = BigInt(a[0]); if (v < 0n) v = BigInt.asUintN(typeof a[0] === 'bigint' ? 64 : 32, v); return v.toString(b); } return toStr(a[0]);
          case 'ToChar': return a[0] instanceof Ch ? a[0] : typeof a[0] === 'string' ? (a[0].length === 1 ? CH(a[0].charCodeAt(0)) : throwCs('FormatException', 'String must be exactly one character long.')) : CH(Number(intOf(a[0])) & 0xffff);
          case 'ToBoolean': { const x = a[0]; if (typeof x === 'string') return parseNum('bool', x, true); return isInt(x) ? Number(x) !== 0 : x instanceof D ? x.v !== 0 : !!x; }
        }
        break;
      case 'Array': {
        const arr = a[0];
        const need = () => { if (!(arr instanceof CArr)) { if (arr === null) throwCs('ArgumentNullException', null, 'array'); fail(`CS1503: Argument 1: cannot convert from '${csType(arr)}' to 'System.Array'`); } };
        switch (n) {
          case 'Sort': need(); { if (a[1] instanceof CArr) fail('Array.Sort(keys, items) is not supported here'); if (a.length >= 3 && isInt(a[1])) { introSort(arr.a, Number(a[1]), Number(a[2]), comparer(a[3])); return undefined; } introSort(arr.a, 0, arr.a.length, comparer(a[1])); return undefined; }
          case 'Reverse': need(); if (a.length === 3) { const i = Number(a[1]), c = Number(a[2]); const part = arr.a.slice(i, i + c).reverse(); arr.a.splice(i, c, ...part); } else arr.a.reverse(); return undefined;
          case 'IndexOf': need(); return arr.a.findIndex(x => equals(x, a[1]));
          case 'LastIndexOf': need(); { for (let i = arr.a.length - 1; i >= 0; i--) if (equals(arr.a[i], a[1])) return i; return -1; }
          case 'Fill': need(); { const lo = a.length > 2 ? Number(a[2]) : 0, c = a.length > 3 ? Number(a[3]) : arr.a.length - lo; for (let i = lo; i < lo + c; i++) arr.a[i] = copy(conv(a[1], arr.et)); return undefined; }
          case 'Clear': need(); { const lo = a.length > 1 ? Number(a[1]) : 0, c = a.length > 2 ? Number(a[2]) : arr.a.length; for (let i = lo; i < lo + c; i++) arr.a[i] = zero(arr.et); return undefined; }
          case 'Copy': {
            if (a.length === 3) { const len = Number(intOf(a[2])); if (len > a[0].a.length || len > a[1].a.length) throwCs('ArgumentException', 'Source array was not long enough. Check the source index, length, and the array\'s lower bounds.', 'sourceArray'); for (let i = 0; i < len; i++) a[1].a[i] = copy(a[0].a[i]); return undefined; }
            const [src, si, dst, di, len] = [a[0], Number(a[1]), a[2], Number(a[3]), Number(a[4])];
            if (si + len > src.a.length || di + len > dst.a.length) throwCs('ArgumentException', 'Destination array was not long enough. Check the destination index, length, and the array\'s lower bounds.', 'destinationArray');
            const part = src.a.slice(si, si + len).map(copy);
            part.forEach((x, j) => { dst.a[di + j] = x; });
            return undefined;
          }
          case 'Resize': { const r = refs[0]; if (!r) fail("CS1620: Argument 1 must be passed with the 'ref' keyword"); const old = r.get(), len = Number(intOf(a[1])); const na = new CArr(old ? old.et : null, Array.from({ length: len }, (_, j) => (old && j < old.a.length ? old.a[j] : zero(old ? old.et : null)))); r.set(na); return undefined; }
          case 'BinarySearch': need(); { const cmp = comparer(a[2]); let lo = 0, hi = arr.a.length - 1; while (lo <= hi) { const m = lo + ((hi - lo) >> 1), c = cmp(arr.a[m], a[1]); if (c === 0) return m; if (c < 0) lo = m + 1; else hi = m - 1; } return ~lo; }
          case 'Exists': need(); return arr.a.some(pred(a[1], 'Exists'));
          case 'TrueForAll': need(); return arr.a.every(pred(a[1], 'TrueForAll'));
          case 'Find': need(); { const x = arr.a.find(pred(a[1], 'Find')); return x === undefined ? zero(arr.et) : x; }
          case 'FindIndex': need(); return arr.a.findIndex(pred(a[1], 'FindIndex'));
          case 'FindAll': need(); return new CArr(arr.et, arr.a.filter(pred(a[1], 'FindAll')));
          case 'ConvertAll': need(); return new CArr(null, arr.a.map(sel(a[1])));
          case 'ForEach': need(); arr.a.forEach(x => callFn(a[1], [x])); return undefined;
          case 'Empty': return new CArr(null, []);
          case 'AsReadOnly': return new List(arr.et, arr.a);
        }
        break;
      }
      case 'Enumerable':
        switch (n) {
          case 'Range': { const start = Number(intOf(a[0])), c = Number(intOf(a[1])); if (c < 0) outOfRange('count', 'Specified argument was out of the range of valid values.'); return new Seq('RangeIterator', function* () { for (let i = 0; i < c; i++) yield start + i; }, INT); }
          case 'Repeat': { const c = Number(intOf(a[1])); const s = new Seq('RepeatIterator', function* () { for (let i = 0; i < c; i++) yield a[0]; }, tOf(a[0])); s.targs = [tOf(a[0])]; return s; }
          case 'Empty': return new Seq('EmptyPartition', function* () {}, null);
        }
        if (LINQ_NAMES.has(n) && a.length) return linq(a[0], n, a.slice(1));
        break;
      case 'Environment': if (n === 'Exit') throw Object.assign(new Error('exit'), { exit: Number(intOf(a[0])) }); break;
      case 'Tuple': if (n === 'Create') return new Tup(a.map(copy), null); break;
      case 'KeyValuePair': if (n === 'Create') return new KV(a[0], a[1]); break;
      case 'Comparer': if (n === 'Create') return new Cmp((x, y) => Number(intOf(callFn(a[0], [x, y])))); break;
      case 'object': if (n === 'ReferenceEquals') return a[0] === a[1]; if (n === 'Equals') return equals(a[0], a[1]); break;
      case 'Enum': {
        if (n === 'GetValues' || n === 'GetNames') fail('Enum.' + n + ' is not supported here');
        break;
      }
    }
    if (['DateTime', 'Stopwatch', 'Thread', 'Task', 'BigInteger', 'GC', 'Debug', 'Trace', 'TimeSpan', 'Guid', 'Regex', 'File'].includes(t)) {
      if ((t === 'Debug' || t === 'Trace') && (n === 'WriteLine' || n === 'Assert' || n === 'Write')) { if (n === 'Assert') { if (a[0] === false) throwCs('Exception', 'Assertion failed: ' + (a[1] || '')); return undefined; } return undefined; }
      if (t === 'Thread' && n === 'Sleep') return undefined;
      fail(`${t}.${n} is not supported here`);
    }
    fail(`CS0117: '${t0}' does not contain a definition for '${n}'` + (t === 'Console' && n === 'Writeline' ? ' (it is WriteLine)' : t === 'Math' && n === 'Power' ? ' (it is Math.Pow)' : ''));
  }
  /** an enum's statics: Enum.Parse, Color.Red.ToString()… */
  function enumStatic(en, n) { fail(`CS0117: '${en.name}' does not contain a definition for '${n}'`); }
  /** methods every object has: ToString, Equals, GetHashCode, GetType (base.ToString() skips the program's override) */
  function objectMethod(o, n, a, e, toStrFn, equalsFn, hashKeyFn, isBase) {
    switch (n) {
      case 'ToString': if (isBase) return o.cls.record ? (() => { const s = toStr(o); return s; })() : o.cls.full; return toStrFn(o);
      case 'Equals': return isBase ? (o.cls.record || o.cls.isStruct ? equalsFn(o, a[0]) : o === a[0]) : equalsFn(o, a[0]);
      case 'GetHashCode': { const h = hashKeyFn(o); return typeof h === 'string' ? strHash(h) : Number(h.userHash); }
      case 'GetType': return new TypeObj(o.cls.name, o.cls.full);
      case 'MemberwiseClone': { const c = new CObj(o.cls); for (const [k, x] of o.f) c.f.set(k, x); return c; }
      case 'Deconstruct': return undefined;
    }
    return undefined;
  }
  const objProp = () => undefined;
  /** using static System.Math; → Max(…) means Math.Max(…) */
  function usingStatic(n) {
    for (const u of api.usings()) if (u.stat) { const t = u.n.replace(/^System\./, ''); if (t === 'Math' || t === 'Console' || t === 'Convert' || t === 'Array') return t; }
    void n;
    return null;
  }
  const NAMESPACES = /^System(\.|$)/;
  function deconstruct(v, n) {
    if (v instanceof KV && n === 2) return [v.k, v.v];
    return null;
  }

  return {
    csType: csTypeLib, netType: netTypeLib, netOfType: netOfTypeLib, isCollType: n => COLL_TYPES.has(n), kv: (k, v) => new KV(k, v), slice, getProp, setProp, getIndex, setIndex,
    elemType: c => (c instanceof List ? c.et : c instanceof Hashed || c instanceof Sorted ? c.vt : null), objProp, formatHole, staticMember, knowsType: n => STATIC_TYPES.has(n) || COLL_TYPES.has(n),
    callStatic, enumStatic, objectMethod, hasMethod, callMethod, usingStatic, construct, fromItems, deconstruct, iter, iterChecked, libEquals: (a, b) => (a instanceof KV && b instanceof KV ? equals(a.k, b.k) && equals(a.v, b.v) : a === b),
    hashKey: v => (v instanceof KV ? 'kv(' + hashKey(v.k) + ',' + hashKey(v.v) + ')' : null), compareDefault, toStr: toStrLib, charLit, ser, brief, isInstance: isInstanceLib,
    knowsNamespace: n => NAMESPACES.test(n), format, composite, needsLinq,
  };
}
