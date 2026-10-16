/**
 * The part of Go's standard library that algorithms use, with Go's own output where a program can see it: fmt's
 * verbs (%v, %+v, %#v, %T, %q, widths and flags, and %!d(string=x) for a wrong verb), maps printed with their keys
 * sorted, floats printed the way strconv does (1e+06, 0.30000000000000004), sort, slices, strings (and Builder),
 * strconv (with its error messages), math, unicode, errors (Is, As, %w), container/heap and os.Exit.
 * makeLib(api) gets the interpreter's helpers (./interp.js) and returns what it calls.
 */

/** Go's shortest float, split into digits and a decimal point position: 1234.5 → { d: '12345', dp: 4, neg } */
function digitsOf(v, f32) {
  let s = Math.abs(v).toExponential();
  if (f32) for (let p = 1; p <= 9; p++) { const t = Math.abs(v).toExponential(p - 1); if (Math.fround(+t) === Math.fround(Math.abs(v))) { s = t; break; } }
  const [m, e] = s.split('e');
  return { d: m.replace('.', '').replace(/0+$/, '') || '0', dp: Number(e) + 1, neg: v < 0 || Object.is(v, -0) };
}
const expPart = x => 'e' + (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(2, '0');
/** %e of digits: d.ddde+XX */
const eForm = (d, dp) => d[0] + (d.length > 1 ? '.' + d.slice(1) : '') + expPart(dp - 1);
/** fixed notation of digits */
const fForm = (d, dp) => (dp <= 0 ? '0.' + '0'.repeat(-dp) + d : d.length <= dp ? d + '0'.repeat(dp - d.length) : d.slice(0, dp) + '.' + d.slice(dp));
const special = v => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : null);
/** A float as fmt's %v (and Println) writes it: the shortest digits, %e from 1e+06 (1e+21 for %#v) or below 1e-4 */
export function fmtFloat(v, f32 = false, sharp = false) {
  const sp = special(v);
  if (sp) return sp;
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const { d, dp, neg } = digitsOf(v, f32);
  const x = dp - 1;
  return (neg ? '-' : '') + (x < -4 || x >= (sharp ? 21 : 6) ? eForm(d, dp) : fForm(d, dp));
}
/** %.Nf, rounding an exact tie to even like strconv (JavaScript's toFixed rounds it up) */
function toFixed(v, p) {
  const sp = special(v);
  if (sp) return sp;
  let s = Math.abs(v).toFixed(p);
  if (p < 80) {
    const long = Math.abs(v).toFixed(Math.min(100, p + 40));
    const rest = long.slice(long.length - (Math.min(100, p + 40) - p));
    if (/^50*$/.test(rest)) {                        // an exact tie: toFixed went up; go to the even neighbour
      const down = long.slice(0, long.length - rest.length).replace(/\.$/, '');
      const last = down.replace('.', '').at(-1);
      if (Number(last) % 2 === 0) s = down;
    }
  }
  return (v < 0 || Object.is(v, -0)) && /[1-9]/.test(s) ? '-' + s : (Object.is(v, -0) ? '-' + s : s);
}
/** %e with a precision */
function toExp(v, p) {
  const sp = special(v);
  if (sp) return sp;
  const [m, e] = v.toExponential(p).split('e');
  return m + expPart(Number(e));
}
/** %g: shortest (p < 0) or p significant digits; %e when the exponent is < -4 or ≥ the precision */
function toG(v, p, f32, sharp) {
  const sp = special(v);
  if (sp) return sp;
  if (v === 0) return '0';
  let d, dp, neg = v < 0, eprec;
  if (p < 0) { ({ d, dp } = digitsOf(v, f32)); eprec = 6; }
  else {
    if (p === 0) p = 1;
    const [m, e] = Math.abs(v).toExponential(p - 1).split('e');
    d = m.replace('.', ''); dp = Number(e) + 1;
    if (!sharp) d = d.replace(/0+$/, '') || '0';
    eprec = p;
    if (eprec > d.length && d.length >= dp) eprec = d.length;
  }
  const x = dp - 1;
  return (neg ? '-' : '') + (x < -4 || x >= eprec ? eForm(d, dp) : fForm(d, dp));
}

export function makeLib(api) {
  const { F, GStruct, GArr, GSlice, GMap, GPtr, GFn, fail, panic, write, zero, copy, equal, under, typeName, dynType,
    methodOf, invokeMethod, callFn, intOf, num, isConstExpr, typeMatches } = api;
  const BASIC_STR = { k: 'basic', name: 'string' }, BASIC_INT = { k: 'basic', name: 'int' };
  const isNum = v => typeof v === 'number' || typeof v === 'bigint';

  /* ---- errors ---- */
  class GErr { constructor(msg, kind = '*errors.errorString', wrapped = null) { this.msg = msg; this.kind = kind; this.wrapped = wrapped; } }
  const runtimeError = (msg, plain) => new GErr((plain ? '' : 'runtime error: ') + msg, 'runtime.Error');

  /* ---- strings and bytes ---- */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ascii = s => /^[\x00-\x7f]*$/.test(s);
  const utf8 = s => (ascii(s) ? Array.from(s, c => c.charCodeAt(0)) : Array.from(enc.encode(s)));
  const fromUtf8 = bytes => (bytes.every(b => b < 128) ? String.fromCharCode(...bytes) : dec.decode(new Uint8Array(bytes)));
  const blen = s => (ascii(s) ? s.length : enc.encode(s).length);
  /** a JavaScript string index → Go's byte offset */
  const byteAt = (s, i) => (i < 0 ? -1 : blen(s.slice(0, i)));
  const sliceOf = (items, elemT) => new GSlice({ k: 'slice', elem: elemT }, { a: items }, 0, items.length, items.length);
  const itemsOf = s => (s === null || s === undefined ? [] : s instanceof GArr ? s.a : s.arr.a.slice(s.off, s.off + s.len));
  const strings = xs => itemsOf(xs).map(x => (typeof x === 'string' ? x : fail('a []string is needed')));

  /* ---- maps: keys by value (structs and arrays field by field), entries in insertion order ---- */
  const idOf = api.idOf;
  function mapKey(k) {
    if (isNum(k)) return 'i' + k;
    if (k instanceof F) return Number.isInteger(k.v) && !Object.is(k.v, -0) ? 'i' + k.v : 'f' + k.v;
    if (typeof k === 'string') return 's' + k;
    if (typeof k === 'boolean') return 'b' + k;
    if (k === null) return 'nil';
    if (k instanceof GStruct) return 'S' + typeName(k.t) + '{' + [...k.f.values()].map(mapKey).join(',') + '}';
    if (k instanceof GArr) return 'A[' + k.a.map(mapKey).join(',') + ']';
    if (k instanceof GPtr) return 'p' + idOf(k.key);
    if (k instanceof GSlice || k instanceof GMap) panic('hash of unhashable type ' + typeName(k.t));
    if (k instanceof GErr) return 'e' + idOf(k);
    return 'o' + idOf(k);
  }
  const mapGet = (m, k) => {
    const en = m && !m.nil ? m.m.get(mapKey(k)) : undefined;
    return en ? [en.v, true] : [m ? zero(under(m.t).val) : null, false];
  };
  const mapSet = (m, k, v) => {
    if (m.nil) panic('assignment to entry in nil map');
    const key = mapKey(k), en = m.m.get(key);
    if (en) en.v = v; else m.m.set(key, { k: copy(k), v });
  };
  const mapDelete = (m, k) => { if (!m.nil) m.m.delete(mapKey(k)); };
  /** fmt prints a map with its keys sorted: numbers, then strings, in order */
  function cmpKeys(a, b) {
    if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof F || b instanceof F) return num(a) - num(b);
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (a instanceof GStruct && b instanceof GStruct) { const x = [...a.f.values()], y = [...b.f.values()]; for (let i = 0; i < x.length; i++) { const c = cmpKeys(x[i], y[i]); if (c) return c; } return 0; }
    if (a instanceof GArr && b instanceof GArr) { for (let i = 0; i < a.a.length; i++) { const c = cmpKeys(a.a[i], b.a[i]); if (c) return c; } return 0; }
    return 0;
  }
  const sortedEntries = m => [...m.m.values()].sort((x, y) => cmpKeys(x.k, y.k));

  /* ---- fmt ---- */
  /** v's String() or Error(), if fmt would call it (a pointer receiver's method only on a pointer) */
  function stringer(v) {
    if (v === null || v === undefined || typeof v !== 'object' || v instanceof F) return null;
    if (v instanceof GErr) return v.msg;
    if (v instanceof NBox) { for (const name of ['Error', 'String']) { const m = methodOf(v, name); if (m && m.params.length === 0 && (!m.recv || m.recv.type.k !== 'ptr')) { const r = invokeMethod(v.v, m, [], null); if (typeof r === 'string') return r; } } return null; }
    for (const name of ['Error', 'String']) {
      const m = methodOf(v, name);
      if (m && !m.native && (!m.recv || m.recv.type.k !== 'ptr' || v instanceof GPtr) && m.params.length === 0) {
        if (v instanceof GPtr && v.get() === null) return null;
        const r = invokeMethod(v, m, [], null);
        if (typeof r === 'string') return r;
      }
    }
    return null;
  }
  const addr = v => '0xc' + (0x000010000 + idOf(v instanceof GPtr ? v.key : v) * 0x18).toString(16).padStart(9, '0');
  /** %v (plus: field names; sharp: Go syntax) */
  function fmtV(v, plus, sharp, depth = 0) {
    if (v === undefined) return '<nil>';
    if (!sharp) { const s = stringer(v); if (s !== null) return s; }
    if (v instanceof NBox) return fmtV(v.v, plus, sharp, depth);
    if (v === null) return sharp ? 'nil' : '<nil>';
    if (isNum(v)) return String(v);
    if (v instanceof F) return fmtFloat(v.v, v.f32, sharp);
    if (typeof v === 'string') return sharp ? JSON.stringify(v) : v;
    if (typeof v === 'boolean') return String(v);
    if (v instanceof GSlice || v instanceof GArr) {
      const items = itemsOf(v);
      if (v instanceof GSlice && v.nil && !sharp) return '[]';
      if (sharp) return (v instanceof GSlice && v.nil ? typeName(v.t) + '(nil)' : typeName(v.t) + '{' + items.map(x => fmtV(x, plus, sharp, depth + 1)).join(', ') + '}');
      return '[' + items.map(x => fmtV(x, plus, sharp, depth + 1)).join(' ') + ']';
    }
    if (v instanceof GMap) {
      const es = sortedEntries(v);
      if (sharp) return typeName(v.t) + (v.nil ? '(nil)' : '{' + es.map(en => fmtV(en.k, plus, sharp, depth + 1) + ':' + fmtV(en.v, plus, sharp, depth + 1)).join(', ') + '}');
      return 'map[' + es.map(en => fmtV(en.k, plus, sharp, depth + 1) + ':' + fmtV(en.v, plus, sharp, depth + 1)).join(' ') + ']';
    }
    if (v instanceof GStruct) {
      const fs = [...v.f];
      if (sharp) return typeName(v.t) + '{' + fs.map(([k, x]) => k + ':' + fmtV(x, plus, sharp, depth + 1)).join(', ') + '}';
      return '{' + fs.map(([k, x]) => (plus ? k + ':' : '') + fmtV(x, plus, sharp, depth + 1)).join(' ') + '}';
    }
    if (v instanceof GPtr) {
      const t = v.get();
      if (depth === 0 && (t instanceof GStruct || t instanceof GArr || t instanceof GSlice || t instanceof GMap)) return '&' + fmtV(t, plus, sharp, 1);
      return sharp ? '(*' + typeName(v.t) + ')(' + addr(v) + ')' : addr(v);
    }
    if (v instanceof GFn) return addr(v);
    if (v instanceof Rev) return '&{' + fmtV(v.x, plus, sharp, depth + 1) + '}';
    return String(v);
  }
  const pad = (s, spec) => {
    const w = spec.width;
    if (w == null || s.length >= w) return s;
    if (spec.minus) return s + ' '.repeat(w - s.length);
    if (spec.zero && spec.numeric) { const sign = /^[+-]/.test(s) ? s[0] : ''; return sign + '0'.repeat(w - s.length) + s.slice(sign.length); }
    return ' '.repeat(w - s.length) + s;
  };
  const sign = (s, spec, neg) => (neg ? '-' : spec.plus ? '+' : spec.space ? ' ' : '') + s;
  const quote = s => '"' + [...s].map(c => ({ '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' }[c] || (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0') : c))).join('') + '"';
  const quoteRune = r => "'" + ({ 39: "\\'", 92: '\\\\', 10: '\\n', 9: '\\t', 13: '\\r', 0: '\\x00' }[r] || String.fromCodePoint(r)) + "'";
  const bad = (verb, v) => (v === null ? '%!' + verb + '(<nil>)' : '%!' + verb + '(' + dynType(v) + '=' + fmtV(v, false, false) + ')');
  const isBytes = v => v instanceof GSlice && under(v.t).elem && under(v.t).elem.k === 'basic' && under(v.t).elem.name === 'uint8';
  /** One argument under one verb; slices, maps and structs take the verb element by element, like fmt */
  function fmtArg(v, verb, spec, depth = 0) {
    if (v instanceof NBox && verb !== 'v' && verb !== 's' && verb !== 'q' && verb !== 'T') v = v.v;
    if (verb === 'v') return pad(spec.plus && isNum(v) ? sign(String(v).replace('-', ''), spec, v < 0) : fmtV(v, spec.plus, spec.sharp, depth), spec);
    if (verb === 'T') return pad(dynType(v), spec);
    if (verb === 'p') return v instanceof GPtr || v instanceof GSlice || v instanceof GMap || v instanceof GFn ? pad(addr(v instanceof GSlice ? v.arr : v), spec) : bad(verb, v);
    if ((verb === 's' || verb === 'q' || verb === 'x' || verb === 'X') && isBytes(v)) return fmtArg(fromUtf8(itemsOf(v)), verb, spec, depth);
    if (v instanceof GSlice || v instanceof GArr) return '[' + itemsOf(v).map(x => fmtArg(x, verb, spec, depth + 1)).join(' ') + ']';
    if ((verb === 's' || verb === 'q') && v !== null) { const s = stringer(v); if (s !== null) return fmtArg(s, verb, spec, depth); }
    if (v instanceof GMap) return 'map[' + sortedEntries(v).map(en => fmtArg(en.k, verb, spec, depth + 1) + ':' + fmtArg(en.v, verb, spec, depth + 1)).join(' ') + ']';
    if (v instanceof GStruct) return '{' + [...v.f].map(([k, x]) => (spec.plus ? k + ':' : '') + fmtArg(x, verb, spec, depth + 1)).join(' ') + '}';
    if (v instanceof GPtr && depth === 0 && v.get() instanceof GStruct) return '&' + fmtArg(v.get(), verb, spec, 1);
    const num = { ...spec, numeric: true };
    switch (verb) {
      case 'd': case 'b': case 'o': case 'O': case 'x': case 'X': {
        if (typeof v === 'string' && (verb === 'x' || verb === 'X')) { const h = utf8(v).map(b => b.toString(16).padStart(2, '0')).join(spec.space ? ' ' : ''); return pad(verb === 'X' ? h.toUpperCase() : h, spec); }
        if (v instanceof F && (verb === 'x' || verb === 'X' || verb === 'b')) return bad(verb, v);
        if (!isNum(v)) return bad(verb, v);
        const big = BigInt(v), neg = big < 0n, abs = neg ? -big : big;
        let s = abs.toString({ d: 10, b: 2, o: 8, O: 8, x: 16, X: 16 }[verb]);
        if (verb === 'X') s = s.toUpperCase();
        if (spec.prec != null) s = s.padStart(spec.prec, '0');
        if (spec.sharp) s = ({ b: '0b', o: '0', x: '0x', X: '0X' }[verb] || '') + s;
        if (verb === 'O') s = '0o' + s;
        return pad(sign(s, spec, neg), spec.prec != null ? { ...num, zero: false } : num);
      }
      case 'c': return isNum(v) ? pad(String.fromCodePoint(Number(v)), spec) : bad(verb, v);
      case 'U': return isNum(v) ? pad('U+' + Number(v).toString(16).toUpperCase().padStart(4, '0'), spec) : bad(verb, v);
      case 'q': if (typeof v === 'string') return pad(quote(v), spec); if (isNum(v)) return pad(quoteRune(Number(v)), spec); return bad(verb, v);
      case 's': return typeof v === 'string' ? pad(spec.prec != null ? [...v].slice(0, spec.prec).join('') : v, spec) : bad(verb, v);
      case 't': return typeof v === 'boolean' ? pad(String(v), spec) : bad(verb, v);
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
        if (!(v instanceof F)) return bad(verb, v);
        const x = v.v, p = spec.prec;
        let s = verb === 'f' || verb === 'F' ? toFixed(x, p == null ? 6 : p) : verb === 'e' || verb === 'E' ? toExp(x, p == null ? 6 : p) : toG(x, p == null ? -1 : p, v.f32, spec.sharp);
        if (verb === 'E' || verb === 'G') s = s.toUpperCase();
        const neg = s.startsWith('-');
        return pad(sign(neg ? s.slice(1) : s, spec, neg), Number.isFinite(x) ? num : spec);
      }
    }
    return '%!' + verb + '(' + dynType(v) + '=' + fmtV(v, false, false) + ')';
  }
  /** Printf's format string */
  function sprintf(f, args) {
    let out = '', ai = 0;
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      if (c !== '%') { out += c; continue; }
      const spec = {};
      let j = i + 1;
      for (; j < f.length && '+-# 0'.includes(f[j]); j++) spec[{ '+': 'plus', '-': 'minus', '#': 'sharp', ' ': 'space', 0: 'zero' }[f[j]]] = true;
      const numAt = () => { let s = ''; while (/[0-9]/.test(f[j] || '')) s += f[j++]; return s; };
      if (f[j] === '*') { j++; const w = args[ai++]; spec.width = Number(w); if (spec.width < 0) { spec.minus = true; spec.width = -spec.width; } } else { const w = numAt(); if (w) spec.width = Number(w); }
      if (f[j] === '.') { j++; if (f[j] === '*') { j++; spec.prec = Number(args[ai++]); } else spec.prec = Number(numAt() || 0); }
      const verb = f[j];
      i = j;
      if (verb === undefined) { out += '%!(NOVERB)'; break; }
      if (verb === '%') { out += '%'; continue; }
      if (ai >= args.length) { out += '%!' + verb + '(MISSING)'; continue; }
      const v = args[ai++];
      out += verb === 'w' ? fmtV(v, false, false) : fmtArg(v, verb, spec);
    }
    if (ai < args.length) out += '%!(EXTRA ' + args.slice(ai).map(v => dynType(v) + '=' + fmtV(v, false, false)).join(', ') + ')';
    return out;
  }
  /** Print and Sprint: a space between two operands when neither is a string */
  const sprint = vs => vs.map((v, k) => (k && typeof v !== 'string' && typeof vs[k - 1] !== 'string' ? ' ' : '') + fmtV(v, false, false)).join('');
  const sprintln = vs => vs.map(v => fmtV(v, false, false)).join(' ') + '\n';

  /* ---- sort: Go's insertion sort and symMerge (sort.Stable), in place, calling less(i, j) on the slice ---- */
  function stableSort(n, less, swap) {
    const insertion = (a, b) => { for (let i = a + 1; i < b; i++) for (let j = i; j > a && less(j, j - 1); j--) swap(j, j - 1); };
    const swapRange = (a, b, k) => { for (let i = 0; i < k; i++) swap(a + i, b + i); };
    const rotate = (a, m, b) => {
      let i = m - a, j = b - m;
      while (i !== j) { if (i > j) { swapRange(m - i, m, j); i -= j; } else { swapRange(m - i, m + j - i, i); j -= i; } }
      swapRange(m - i, m, i);
    };
    const symMerge = (a, m, b) => {
      if (m - a === 1) { let i = m, j = b; while (i < j) { const h = (i + j) >>> 1; if (less(h, a)) i = h + 1; else j = h; } for (let k = a; k < i - 1; k++) swap(k, k + 1); return; }
      if (b - m === 1) { let i = a, j = m; while (i < j) { const h = (i + j) >>> 1; if (!less(m, h)) i = h + 1; else j = h; } for (let k = m; k > i; k--) swap(k, k - 1); return; }
      const mid = (a + b) >>> 1, nn = mid + m;
      let start, r;
      if (m > mid) { start = nn - b; r = mid; } else { start = a; r = m; }
      const p = nn - 1;
      while (start < r) { const c = (start + r) >>> 1; if (!less(p - c, c)) start = c + 1; else r = c; }
      const end = nn - start;
      if (start < m && m < end) rotate(start, m, end);
      if (a < start && start < mid) symMerge(a, start, mid);
      if (mid < end && end < b) symMerge(mid, end, b);
    };
    let block = 20, a = 0, b = block;
    while (b <= n) { insertion(a, b); a = b; b += block; }
    insertion(a, n);
    while (block < n) {
      a = 0; b = 2 * block;
      while (b <= n) { symMerge(a, a + block, b); a = b; b += 2 * block; }
      if (a + block < n) symMerge(a, a + block, n);
      block *= 2;
    }
  }
  const sliceSort = (s, lessIdx) => {
    if (s === null || s.len < 2) return;
    const a = s.arr.a, o = s.off;
    stableSort(s.len, lessIdx, (i, j) => { const t = a[o + i]; a[o + i] = a[o + j]; a[o + j] = t; });
  };
  const ordered = (x, y) => (isNum(x) && isNum(y) ? x < y : x instanceof F || y instanceof F ? num(x) < num(y) || (Number.isNaN(num(x)) && !Number.isNaN(num(y))) : x < y);
  const cmpOrdered = (x, y) => (ordered(x, y) ? -1 : ordered(y, x) ? 1 : 0);
  const sortOrdered = s => { if (s) { const a = s.arr.a, o = s.off; sliceSort(s, (i, j) => ordered(a[o + i], a[o + j])); } };
  const asBool = v => (typeof v === 'boolean' ? v : fail('the function must return bool'));
  /** a value with Len, Less and Swap methods (sort.Interface, heap.Interface) */
  const iface = (h, what) => {
    const m = name => { const f = methodOf(h, name); if (!f) fail(`cannot use ${dynType(h)} as ${what} value: missing method ${name}`); return f; };
    if (h instanceof Rev) { const inner = iface(h.x, what); return { ...inner, less: (i, j) => inner.less(j, i) }; }
    if (h instanceof OSlice) { const s = h.s, arr = () => s.arr.a; return { len: () => s.len, less: (i, j) => ordered(arr()[s.off + i], arr()[s.off + j]), swap: (i, j) => { const a = arr(), t = a[s.off + i]; a[s.off + i] = a[s.off + j]; a[s.off + j] = t; } }; }
    const call = (name, args) => invokeMethod(h, m(name), args, null);
    return { len: () => Number(call('Len', [])), less: (i, j) => asBool(call('Less', [i, j])), swap: (i, j) => call('Swap', [i, j]), call };
  };
  class Rev { constructor(x) { this.x = x; } }
  /** sort.IntSlice(xs) and its kin: a slice sorted in its natural order */
  class OSlice { constructor(s) { this.s = s; } }
  /** A value of a named basic type (type Color int) passed to fmt, so that its String() method is found */
  class NBox { constructor(t, v) { this.t = t; this.v = v; } }

  /* ---- container/heap: Go's up and down, calling the program's Len, Less, Swap, Push, Pop ---- */
  function heapOps(h) {
    const o = iface(h, 'heap.Interface');
    const up = j => { for (;;) { const i = Math.floor((j - 1) / 2); if (i === j || j <= 0 || !o.less(j, i)) break; o.swap(i, j); j = i; } };
    const down = (i0, n) => {
      let i = i0;
      for (;;) {
        const j1 = 2 * i + 1;
        if (j1 >= n || j1 < 0) break;
        let j = j1;
        const j2 = j1 + 1;
        if (j2 < n && o.less(j2, j1)) j = j2;
        if (!o.less(j, i)) break;
        o.swap(i, j); i = j;
      }
      return i > i0;
    };
    return { o, up, down };
  }

  /* ---- strconv ---- */
  const numError = (fn, s, why) => new GErr(`strconv.${fn}: parsing ${quote(s)}: ${why}`, '*strconv.NumError');
  function parseInt(s, base, bits, fn) {
    let t = s, neg = false;
    if (t[0] === '+' || t[0] === '-') { neg = t[0] === '-'; t = t.slice(1); }
    if (base === 0) { if (/^0[xX]/.test(t)) { base = 16; t = t.slice(2); } else if (/^0[bB]/.test(t)) { base = 2; t = t.slice(2); } else if (/^0[oO]/.test(t)) { base = 8; t = t.slice(2); } else if (/^0./.test(t)) { base = 8; t = t.slice(1); } else base = 10; t = t.replace(/_/g, ''); }
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
    if (!t.length || ![...t.toLowerCase()].every(c => digits.includes(c))) return [0, numError(fn, s, 'invalid syntax')];
    let v = 0n;
    for (const c of t.toLowerCase()) v = v * BigInt(base) + BigInt(digits.indexOf(c));
    if (neg) v = -v;
    const b = BigInt(bits || 64), lo = -(1n << (b - 1n)), hi = (1n << (b - 1n)) - 1n;
    if (v < lo || v > hi) return [Number(v < lo ? lo : hi) === Number(v < lo ? lo : hi) && (v < lo ? lo : hi) >= -9007199254740991n && (v < lo ? lo : hi) <= 9007199254740991n ? Number(v < lo ? lo : hi) : v < lo ? lo : hi, numError(fn, s, 'value out of range')];
    return [v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v, null];
  }
  function formatFloat(x, fm, prec, bits) {
    const f32 = bits === 32;
    if (fm === 'f') { if (prec >= 0) return toFixed(x, prec); const sp = special(x); if (sp) return sp; if (x === 0) return '0'; const { d, dp, neg } = digitsOf(x, f32); return (neg ? '-' : '') + fForm(d, dp); }
    if (fm === 'e' || fm === 'E') { let s; if (prec >= 0) s = toExp(x, prec); else { const sp = special(x); if (sp) s = sp; else if (x === 0) s = '0e+00'; else { const { d, dp, neg } = digitsOf(x, f32); s = (neg ? '-' : '') + eForm(d, dp); } } return fm === 'E' ? s.toUpperCase() : s; }
    if (fm === 'g' || fm === 'G') { const s = toG(x, prec, f32, false); return fm === 'G' ? s.toUpperCase() : s; }
    fail(`strconv.FormatFloat: format '${fm}' is not supported here`);
  }

  /* ---- unicode ---- */
  const ch = r => String.fromCodePoint(Number(r));
  const UNI = {
    IsLetter: r => /\p{L}/u.test(ch(r)), IsDigit: r => /\p{Nd}/u.test(ch(r)), IsNumber: r => /\p{N}/u.test(ch(r)), IsSpace: r => /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(ch(r)),
    IsUpper: r => /\p{Lu}/u.test(ch(r)), IsLower: r => /\p{Ll}/u.test(ch(r)), IsPunct: r => /\p{P}/u.test(ch(r)), IsPrint: r => !/[\p{C}\p{Z}]/u.test(ch(r)) || ch(r) === ' ',
    ToUpper: r => ch(r).toUpperCase().codePointAt(0), ToLower: r => ch(r).toLowerCase().codePointAt(0), IsControl: r => /\p{Cc}/u.test(ch(r)),
  };

  /* ---- the packages ---- */
  const PKGS = new Set(['fmt', 'strings', 'strconv', 'sort', 'slices', 'math', 'unicode', 'errors', 'os', 'container/heap', 'math/rand', 'unicode/utf8', 'maps', 'cmp']);
  const pkgName = p => p.split('/').pop();
  const fl = (v, what) => (v instanceof F ? v.v : isNum(v) ? Number(v) : fail(`cannot use ${fmtV(v)} (${dynType(v)}) as float64 value in argument to ${what}`));
  const F64 = x => new F(x);
  const lit = x => { const f = new F(x); f.lit = true; return f; };
  const CONSTS = {
    math: {
      Pi: lit(Math.PI), E: lit(Math.E), Sqrt2: lit(Math.SQRT2), Ln2: lit(Math.LN2), Ln10: lit(Math.LN10), Phi: lit((1 + Math.sqrt(5)) / 2),
      MaxInt: 9223372036854775807n, MinInt: -9223372036854775808n, MaxInt64: 9223372036854775807n, MinInt64: -9223372036854775808n,
      MaxInt32: 2147483647, MinInt32: -2147483648, MaxInt16: 32767, MinInt16: -32768, MaxInt8: 127, MinInt8: -128,
      MaxUint8: 255, MaxUint16: 65535, MaxUint32: 4294967295, MaxUint64: 18446744073709551615n, MaxUint: 18446744073709551615n,
      MaxFloat64: lit(Number.MAX_VALUE), SmallestNonzeroFloat64: lit(Number.MIN_VALUE), MaxFloat32: lit(3.4028234663852886e38),
    },
    unicode: { MaxRune: 0x10ffff },
    utf8: { RuneError: 0xfffd, UTFMax: 4 },
  };
  const isConst = (pkg, name) => !!(CONSTS[pkgName(pkg)] && name in CONSTS[pkgName(pkg)]);
  /** pkg.Name used as a value: a constant, os.Args, or a function value */
  function member(pkg, name, e) {
    const p = pkgName(pkg);
    if (CONSTS[p] && name in CONSTS[p]) return CONSTS[p][name];
    if (p === 'os' && (name === 'Stdout' || name === 'Stderr')) return { osFile: name };
    if (p === 'os' && name === 'Args') return sliceOf(['/tmp/main'], BASIC_STR);
    return new GFn({ native: args => callVals(pkg, name, args, e, null), name: p + '.' + name });
  }
  /** pkg.Name(args) */
  function call(pkg, name, argAsts, e, { rval, eval1, staticOf }) {
    let vals;
    if (argAsts.length === 1 && argAsts[0].k === 'call') { const v = eval1(argAsts[0]); vals = Array.isArray(v) ? v : [v]; }
    else vals = argAsts.map(a => rval(a));
    if (pkgName(pkg) === 'fmt') vals = vals.map((v, k) => { const t = argAsts[k] && staticOf && staticOf(argAsts[k]); return t && t.k === 'named' && !t.lib && under(t).k === 'basic' && (t.methods.has('String') || t.methods.has('Error')) && (isNum(v) || typeof v === 'string' || v instanceof F || typeof v === 'boolean') ? new NBox(t, v) : v; });
    if (e && e.spread) { const last = vals.pop(); vals.push(...itemsOf(last)); vals.spread = true; }
    return callVals(pkg, name, vals, e, argAsts);
  }
  /** an argument that must be a float64: an int variable is a compile error in Go (an int constant is fine) */
  const floatArg = (vals, asts, k, what) => {
    const v = vals[k];
    if (isNum(v) && asts && asts[k] && !isConstExpr(asts[k])) fail(`cannot use ${srcText(asts[k])} (variable of type int) as float64 value in argument to ${what} (convert it: float64(…))`);
    return fl(v, what);
  };
  const srcText = a => (a.k === 'name' ? a.name : 'value');
  const need = (vals, n, what) => { if (vals.length < n) fail(`not enough arguments in call to ${what}`); if (vals.length > n) fail(`too many arguments in call to ${what}`); };
  const callBool = (fn, args) => asBool(callFn(fn, args));
  const S = (v, what) => (typeof v === 'string' ? v : fail(`cannot use ${fmtV(v)} (${dynType(v)}) as string value in argument to ${what}`));
  function callVals(pkg, name, vals, e, asts) {
    const p = pkgName(pkg), what = p + '.' + name;
    const a = vals;
    switch (p) {
      case 'fmt':
        switch (name) {
          case 'Println': write(sprintln(a)); return undefined;
          case 'Print': write(sprint(a)); return undefined;
          case 'Printf': write(sprintf(S(a[0], what), a.slice(1))); return undefined;
          case 'Sprintf': return sprintf(S(a[0], what), a.slice(1));
          case 'Sprint': return sprint(a);
          case 'Sprintln': return sprintln(a);
          case 'Errorf': { const args = a.slice(1), f = S(a[0], what); const wi = (f.match(/%[^%a-zA-Z]*[a-zA-Z%]/g) || []).filter(x => x !== '%%').findIndex(x => x.endsWith('w')); return new GErr(sprintf(f, args), wi >= 0 ? '*fmt.wrapError' : '*errors.errorString', wi >= 0 ? args[wi] : null); }
          case 'Fprintln': case 'Fprintf': case 'Fprint': {
            const f = a[0];
            if (!f || !f.osFile) fail(`${what} here can write to os.Stdout or os.Stderr`);
            const s = name === 'Fprintln' ? sprintln(a.slice(1)) : name === 'Fprintf' ? sprintf(S(a[1], what), a.slice(2)) : sprint(a.slice(1));
            write(s, f.osFile === 'Stderr'); return undefined;
          }
          case 'Scan': case 'Scanln': case 'Scanf': case 'Sscanf': case 'Sscan': fail(`${what}: this page has no input to read (put the values in the program)`);
        }
        break;
      case 'strings': {
        const s = () => S(a[0], what);
        switch (name) {
          case 'Contains': return s().includes(S(a[1], what));
          case 'ContainsRune': return s().includes(ch(a[1]));
          case 'ContainsAny': return [...S(a[1], what)].some(c => s().includes(c));
          case 'HasPrefix': return s().startsWith(S(a[1], what));
          case 'HasSuffix': return s().endsWith(S(a[1], what));
          case 'Index': return byteAt(s(), s().indexOf(S(a[1], what)));
          case 'IndexByte': case 'IndexRune': return byteAt(s(), s().indexOf(ch(a[1])));
          case 'LastIndex': return byteAt(s(), s().lastIndexOf(S(a[1], what)));
          case 'IndexAny': { const x = s(), set = S(a[1], what); const k = [...x].findIndex(c => set.includes(c)); return k < 0 ? -1 : blen([...x].slice(0, k).join('')); }
          case 'Split': { const sep = S(a[1], what); const parts = sep === '' ? [...s()] : s().split(sep); return sliceOf(parts, BASIC_STR); }
          case 'SplitN': { const sep = S(a[1], what), n = Number(a[2]); if (n === 0) return sliceOf([], BASIC_STR); const all = sep === '' ? [...s()] : s().split(sep); if (n < 0 || all.length <= n) return sliceOf(all, BASIC_STR); return sliceOf([...all.slice(0, n - 1), all.slice(n - 1).join(sep)], BASIC_STR); }
          case 'Fields': return sliceOf(s().split(/[\s\x85\xa0]+/).filter(Boolean), BASIC_STR);
          case 'Join': return strings(a[0]).join(S(a[1], what));
          case 'Repeat': { const n = Number(intOf(a[1])); if (n < 0) panic('strings: negative Repeat count'); if (n * s().length > 1e6) fail('strings.Repeat: the result is too long for this page'); return s().repeat(n); }
          case 'Replace': { const n = Number(intOf(a[3])); let x = s(), out = '', k = 0; const old = S(a[1], what), nw = S(a[2], what); if (old === '') return n < 0 ? [...x].join(nw) : x; while (n < 0 || k < n) { const i = x.indexOf(old); if (i < 0) break; out += x.slice(0, i) + nw; x = x.slice(i + old.length); k++; } return out + x; }
          case 'ReplaceAll': { const old = S(a[1], what); return old === '' ? S(a[2], what) + [...s()].join(S(a[2], what)) + S(a[2], what) : s().split(old).join(S(a[2], what)); }
          case 'ToUpper': return s().toUpperCase();
          case 'ToLower': return s().toLowerCase();
          case 'Title': return s().replace(/(^|[^\p{L}\p{N}_'])(\p{L})/gu, (m, b, c) => b + c.toUpperCase());
          case 'TrimSpace': return s().replace(/^[\s\x85\xa0]+|[\s\x85\xa0]+$/g, '');
          case 'Trim': case 'TrimLeft': case 'TrimRight': {
            const set = [...S(a[1], what)], cs = [...s()];
            let i = 0, j = cs.length;
            if (name !== 'TrimRight') while (i < j && set.includes(cs[i])) i++;
            if (name !== 'TrimLeft') while (j > i && set.includes(cs[j - 1])) j--;
            return cs.slice(i, j).join('');
          }
          case 'TrimPrefix': return s().startsWith(S(a[1], what)) ? s().slice(S(a[1], what).length) : s();
          case 'TrimSuffix': return S(a[1], what) && s().endsWith(S(a[1], what)) ? s().slice(0, s().length - S(a[1], what).length) : s();
          case 'TrimFunc': { const cs = [...s()]; let i = 0, j = cs.length; while (i < j && callBool(a[1], [cs[i].codePointAt(0)])) i++; while (j > i && callBool(a[1], [cs[j - 1].codePointAt(0)])) j--; return cs.slice(i, j).join(''); }
          case 'Count': { const sub = S(a[1], what); return sub === '' ? [...s()].length + 1 : s().split(sub).length - 1; }
          case 'EqualFold': return s().toLowerCase() === S(a[1], what).toLowerCase();
          case 'Compare': return cmpOrdered(s(), S(a[1], what));
          case 'Cut': { const sep = S(a[1], what), i = s().indexOf(sep); return i < 0 ? [s(), '', false] : [s().slice(0, i), s().slice(i + sep.length), true]; }
          case 'Map': return [...s()].map(c => { const r = callFn(a[0], [c.codePointAt(0)]); return r < 0 ? '' : ch(r); }).join('');
          case 'IndexFunc': { const cs = [...s()]; const k = cs.findIndex(c => callBool(a[1], [c.codePointAt(0)])); return k < 0 ? -1 : blen(cs.slice(0, k).join('')); }
          case 'FieldsFunc': { const out = []; let cur = ''; for (const c of s()) { if (callBool(a[1], [c.codePointAt(0)])) { if (cur) out.push(cur); cur = ''; } else cur += c; } if (cur) out.push(cur); return sliceOf(out, BASIC_STR); }
          case 'NewReplacer': fail('strings.NewReplacer is not supported here (use strings.ReplaceAll)');
        }
        break;
      }
      case 'strconv':
        switch (name) {
          case 'Itoa': return String(intOf(a[0]));
          case 'Atoi': { const s = S(a[0], what); const [v, err] = parseInt(s, 10, 64, 'Atoi'); return [err ? 0 : v, err]; }
          case 'ParseInt': return parseInt(S(a[0], what), Number(a[1]), Number(a[2]), 'ParseInt');
          case 'ParseFloat': {
            const s = S(a[0], what), t = s.replace(/^[+-]/, '').toLowerCase();
            if (/^(inf|infinity)$/.test(t)) return [F64(s[0] === '-' ? -Infinity : Infinity), null];
            if (t === 'nan') return [F64(NaN), null];
            if (!/^(\d[\d_]*\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return [F64(0), numError('ParseFloat', s, 'invalid syntax')];
            const v = Number(s.replace(/_/g, ''));
            return [F64(v), Number.isFinite(v) ? null : numError('ParseFloat', s, 'value out of range')];
          }
          case 'ParseBool': { const s = S(a[0], what); if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(s)) return [true, null]; if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(s)) return [false, null]; return [false, numError('ParseBool', s, 'invalid syntax')]; }
          case 'FormatInt': { const v = BigInt(a[0]), b = Number(a[1]); return (v < 0n ? '-' : '') + (v < 0n ? -v : v).toString(b); }
          case 'FormatBool': return String(a[0]);
          case 'FormatFloat': return formatFloat(fl(a[0], what), ch(a[1]), Number(a[2]), Number(a[3]));
          case 'Quote': return quote(S(a[0], what));
          case 'QuoteRune': return quoteRune(Number(a[0]));
        }
        break;
      case 'math': {
        const x = k => floatArg(a, asts, k, what);
        const M1 = { Sqrt: Math.sqrt, Abs: Math.abs, Floor: Math.floor, Ceil: Math.ceil, Trunc: Math.trunc, Log: Math.log, Log2: Math.log2, Log10: Math.log10, Log1p: Math.log1p, Exp: Math.exp, Exp2: v => 2 ** v,
          Sin: Math.sin, Cos: Math.cos, Tan: Math.tan, Asin: Math.asin, Acos: Math.acos, Atan: Math.atan, Sinh: Math.sinh, Cosh: Math.cosh, Tanh: Math.tanh, Cbrt: Math.cbrt,
          Round: v => (v < 0 ? -Math.round(-v) : Math.round(v)), RoundToEven: v => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r; } };
        if (M1[name]) { need(a, 1, what); return F64(M1[name](x(0))); }
        const M2 = { Pow: (p, q) => p ** q, Max: (p, q) => (Number.isNaN(p) || Number.isNaN(q) ? NaN : Math.max(p, q)), Min: (p, q) => (Number.isNaN(p) || Number.isNaN(q) ? NaN : Math.min(p, q)), Mod: (p, q) => p % q, Atan2: Math.atan2, Hypot: Math.hypot, Remainder: (p, q) => p - Math.round(p / q) * q, Dim: (p, q) => Math.max(p - q, 0), Copysign: (p, q) => Math.sign(q) * Math.abs(p) || (Object.is(q, -0) || q < 0 ? -Math.abs(p) : Math.abs(p)) };
        if (M2[name]) { need(a, 2, what); return F64(M2[name](x(0), x(1))); }
        switch (name) {
          case 'Inf': return F64(Number(intOf(a[0])) >= 0 ? Infinity : -Infinity);
          case 'NaN': return F64(NaN);
          case 'IsNaN': return Number.isNaN(x(0));
          case 'IsInf': { const v = x(0), s = Number(intOf(a[1])); return s > 0 ? v === Infinity : s < 0 ? v === -Infinity : !Number.isFinite(v) && !Number.isNaN(v); }
          case 'Signbit': { const v = x(0); return v < 0 || Object.is(v, -0); }
          case 'Modf': { const v = x(0), ip = Math.trunc(v); return [F64(ip), F64(v - ip)]; }
        }
        break;
      }
      case 'sort':
        switch (name) {
          case 'Ints': case 'Strings': case 'Float64s': sortOrdered(a[0]); return undefined;
          case 'IntsAreSorted': case 'StringsAreSorted': case 'Float64sAreSorted': { const xs = itemsOf(a[0]); return xs.every((v, k) => !k || !ordered(v, xs[k - 1])); }
          case 'Slice': case 'SliceStable': { const s = a[0]; if (s !== null && !(s instanceof GSlice)) fail(`${what}: ${dynType(s)} is not a slice`); sliceSort(s, (i, j) => callBool(a[1], [i, j])); return undefined; }
          case 'SliceIsSorted': { const n = a[0] ? a[0].len : 0; for (let i = n - 1; i > 0; i--) if (callBool(a[1], [i, i - 1])) return false; return true; }
          case 'Sort': case 'Stable': { const o = iface(a[0], 'sort.Interface'); stableSort(o.len(), o.less, o.swap); return undefined; }
          case 'IsSorted': { const o = iface(a[0], 'sort.Interface'); for (let i = o.len() - 1; i > 0; i--) if (o.less(i, i - 1)) return false; return true; }
          case 'Reverse': return new Rev(a[0]);
          case 'IntSlice': case 'StringSlice': case 'Float64Slice': return new OSlice(a[0]);
          case 'Search': { let i = 0, j = Number(intOf(a[0])); while (i < j) { const h = (i + j) >>> 1; if (!callBool(a[1], [h])) i = h + 1; else j = h; } return i; }
          case 'SearchInts': case 'SearchStrings': case 'SearchFloat64s': { const xs = itemsOf(a[0]); let i = 0, j = xs.length; while (i < j) { const h = (i + j) >>> 1; if (ordered(xs[h], a[1])) i = h + 1; else j = h; } return i; }
        }
        break;
      case 'slices': {
        const s = a[0], xs = () => itemsOf(s);
        switch (name) {
          case 'Sort': sortOrdered(s); return undefined;
          case 'SortFunc': case 'SortStableFunc': { if (!s) return undefined; const arr = s.arr.a, o = s.off; sliceSort(s, (i, j) => Number(callFn(a[1], [arr[o + i], arr[o + j]])) < 0); return undefined; }
          case 'Contains': return xs().some(x => equal(x, a[1]));
          case 'Index': return xs().findIndex(x => equal(x, a[1]));
          case 'IndexFunc': return xs().findIndex(x => callBool(a[1], [x]));
          case 'ContainsFunc': return xs().some(x => callBool(a[1], [x]));
          case 'Reverse': { if (s) { const arr = s.arr.a; for (let i = s.off, j = s.off + s.len - 1; i < j; i++, j--) [arr[i], arr[j]] = [arr[j], arr[i]]; } return undefined; }
          case 'Max': case 'Min': { const v = xs(); if (!v.length) panic(`slices.${name}: empty list`); return v.reduce((m, x) => (name === 'Max' ? ordered(m, x) : ordered(x, m)) ? x : m); }
          case 'Equal': { const p = xs(), q = itemsOf(a[1]); return p.length === q.length && p.every((x, k) => equal(x, q[k])); }
          case 'BinarySearch': { const v = xs(); let i = 0, j = v.length; while (i < j) { const h = (i + j) >>> 1; if (ordered(v[h], a[1])) i = h + 1; else j = h; } return [i, i < v.length && equal(v[i], a[1])]; }
          case 'IsSorted': { const v = xs(); return v.every((x, k) => !k || !ordered(x, v[k - 1])); }
          case 'Clone': return s === null ? null : new GSlice(s.t, { a: xs().map(copy) }, 0, s.len, s.len);
          case 'Insert': { const k = Number(intOf(a[1])), v = xs(); if (k < 0 || k > v.length) panic(`slice bounds out of range [${k}:${v.length}]`); const items = [...v.slice(0, k), ...a.slice(2), ...v.slice(k)]; return new GSlice(s.t, { a: items }, 0, items.length, items.length); }
          case 'Delete': { const i = Number(intOf(a[1])), j = Number(intOf(a[2])); if (i < 0 || j > s.len || i > j) panic(`slice bounds out of range [${i}:${j}]`); const arr = s.arr.a, o = s.off; const rest = arr.slice(o + j, o + s.len); rest.forEach((x, k) => { arr[o + i + k] = x; }); for (let k = s.len - (j - i); k < s.len; k++) arr[o + k] = zero(under(s.t).elem); return new GSlice(s.t, s.arr, s.off, s.len - (j - i), s.cap); }
        }
        break;
      }
      case 'cmp': if (name === 'Compare') return cmpOrdered(a[0], a[1]); if (name === 'Less') return ordered(a[0], a[1]); break;
      case 'unicode': if (UNI[name]) { need(a, 1, what); return UNI[name](intOf(a[0])); } break;
      case 'utf8':
        if (name === 'RuneCountInString') return [...S(a[0], what)].length;
        if (name === 'RuneLen') return blen(ch(a[0]));
        if (name === 'ValidString') return !S(a[0], what).includes('\ufffd');
        break;
      case 'errors':
        switch (name) {
          case 'New': return new GErr(S(a[0], what));
          case 'Unwrap': return unwrap(a[0]);
          case 'Is': { for (let x = a[0], n = 0; x !== null && x !== undefined && n < 100; x = unwrap(x), n++) if (equal(x, a[1])) return true; return a[0] === null && a[1] === null; }
          case 'As': {
            const target = a[1];
            if (!(target instanceof GPtr)) panic('errors: target must be a non-nil pointer');
            for (let x = a[0], n = 0; x !== null && x !== undefined && n < 100; x = unwrap(x), n++) if (typeMatches(x, target.t)) { target.set(x); return true; }
            return false;
          }
          case 'Join': { const es = a.filter(x => x !== null); return es.length ? new GErr(es.map(x => fmtV(x)).join('\n'), '*errors.joinError') : null; }
        }
        break;
      case 'os':
        if (name === 'Exit') api.exit(Number(intOf(a[0])));
        if (name === 'ReadFile' || name === 'Open') fail(`${what}: this page has no files`);
        break;
      case 'heap': {
        const h = a[0];
        const { o, up, down } = heapOps(h);
        switch (name) {
          case 'Init': { const n = o.len(); for (let i = Math.floor(n / 2) - 1; i >= 0; i--) down(i, n); return undefined; }
          case 'Push': o.call('Push', [a[1]]); up(o.len() - 1); return undefined;
          case 'Pop': { const n = o.len() - 1; o.swap(0, n); down(0, n); return o.call('Pop', []); }
          case 'Remove': { const i = Number(intOf(a[1])), n = o.len() - 1; if (n !== i) { o.swap(i, n); if (!down(i, n)) up(i); } return o.call('Pop', []); }
          case 'Fix': { const i = Number(intOf(a[1])); if (!down(i, o.len())) up(i); return undefined; }
        }
        break;
      }
      case 'rand':
        switch (name) {
          case 'Intn': { const n = Number(intOf(a[0])); if (n <= 0) panic('invalid argument to Intn'); return Math.floor(Math.random() * n); }
          case 'Int': return Math.floor(Math.random() * 2 ** 53);
          case 'Float64': return F64(Math.random());
          case 'Perm': { const n = Number(intOf(a[0])), xs = Array.from({ length: n }, (_, k) => k); for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return sliceOf(xs, BASIC_INT); }
          case 'Shuffle': { const n = Number(intOf(a[0])); for (let i = n - 1; i > 0; i--) callFn(a[1], [i, Math.floor(Math.random() * (i + 1))]); return undefined; }
          case 'Seed': return undefined;
        }
        break;
      case 'maps': fail(`${what} returns an iterator, which is not supported here (range over the map instead)`);
    }
    fail(`undefined: ${what}` + (p === 'fmt' && name === 'PrintLn' ? ' (it is Println)' : p === 'strings' && name === 'Length' ? ' (use len(s))' : ''));
  }
  /** an error's Unwrap(): fmt.Errorf's %w, or the program's own Unwrap method */
  function unwrap(x) {
    if (x instanceof GErr) return x.wrapped;
    const m = x && methodOf(x, 'Unwrap');
    return m ? invokeMethod(x, m, [], null) : null;
  }

  /* ---- library types and their methods ---- */
  const BUILDER = { k: 'named', lib: true, name: 'strings.Builder', under: { k: 'struct', fields: [{ name: 'buf', type: BASIC_STR }] }, methods: new Map() };
  const TYPES = {
    'strings.Builder': BUILDER,
    'sort.Interface': { k: 'iface', name: 'sort.Interface', methods: [{ name: 'Len' }, { name: 'Less' }, { name: 'Swap' }] },
    'heap.Interface': { k: 'iface', name: 'heap.Interface', methods: [{ name: 'Len' }, { name: 'Less' }, { name: 'Swap' }, { name: 'Push' }, { name: 'Pop' }] },
    'fmt.Stringer': { k: 'iface', name: 'fmt.Stringer', methods: [{ name: 'String' }] },
    'sort.IntSlice': { k: 'named', lib: true, name: 'sort.IntSlice', under: { k: 'slice', elem: BASIC_INT }, methods: new Map() },
    'sort.StringSlice': { k: 'named', lib: true, name: 'sort.StringSlice', under: { k: 'slice', elem: BASIC_STR }, methods: new Map() },
  };
  const target = v => (v instanceof GPtr ? v.get() : v);
  const isBuilder = v => { const t = target(v); return t instanceof GStruct && t.t === BUILDER; };
  const BUILDER_METHODS = ['WriteString', 'WriteByte', 'WriteRune', 'String', 'Len', 'Reset', 'Grow', 'Cap'];
  const hasMethod = (v, name) => (v instanceof GErr && name === 'Error') || (isBuilder(v) && BUILDER_METHODS.includes(name)) || ((v instanceof Rev || v instanceof OSlice) && ['Len', 'Less', 'Swap'].includes(name));
  function method(v, name, argv) {
    if (v instanceof GErr) return v.msg;
    if (isBuilder(v)) {
      const b = target(v), s = b.f.get('buf');
      switch (name) {
        case 'WriteString': b.f.set('buf', s + S(argv[0], 'WriteString')); return [blen(argv[0]), null];
        case 'WriteByte': b.f.set('buf', s + fromUtf8([Number(argv[0]) & 255])); return null;
        case 'WriteRune': b.f.set('buf', s + ch(argv[0])); return [blen(ch(argv[0])), null];
        case 'String': return s;
        case 'Len': return blen(s);
        case 'Cap': return blen(s);
        case 'Reset': b.f.set('buf', ''); return undefined;
        case 'Grow': return undefined;
      }
    }
    if (v instanceof Rev || v instanceof OSlice) { const o = iface(v, 'sort.Interface'); if (name === 'Len') return o.len(); if (name === 'Less') return o.less(Number(argv[0]), Number(argv[1])); if (name === 'Swap') return o.swap(Number(argv[0]), Number(argv[1])); }
    fail(`undefined method ${name}`);
  }

  /** What a panic prints for its value: an error's Error(), a Stringer's String(), else the value as print would */
  function panicText(v) {
    if (v instanceof GErr) return v.msg;
    const s = stringer(v);
    if (s !== null) return s + (v instanceof GStruct || v instanceof GPtr ? '' : '');
    if (typeof v === 'string') return v;
    if (isNum(v) || v instanceof F || typeof v === 'boolean') return (v instanceof F ? toExp(v.v, 6) : String(v)) + (isNum(v) ? '' : '');
    return fmtV(v, false, true);
  }
  function ser(v, id) {
    if (v instanceof GErr) return { t: 'p', k: 'sym', s: 'error(' + JSON.stringify(v.msg.length > 40 ? v.msg.slice(0, 40) + '…' : v.msg) + ')' };
    if (v instanceof Rev) return { t: 'p', k: 'sym', s: 'sort.Reverse(…)' };
    if (v && v.osFile) return { t: 'p', k: 'sym', s: 'os.' + v.osFile };
    void id;
    return { t: 'p', k: 'sym', s: String(v) };
  }
  const typeOfLib = v => (v instanceof NBox ? typeName(v.t) : v instanceof GErr ? v.kind : v instanceof OSlice ? 'sort.IntSlice' : v instanceof Rev ? '*sort.reverse' : v && v.osFile ? '*os.File' : '?');

  return {
    knows: path => PKGS.has(path), type: name => TYPES[name] || null, typeOf: typeOfLib, sprint: v => fmtV(v, false, false), sprintV: fmtV,
    hasMethod, method, member, call, isConst, quoteRune, mapGet, mapSet, mapDelete, mapKey, utf8, fromUtf8, runtimeError, panicText, ser, GErr,
  };
}
