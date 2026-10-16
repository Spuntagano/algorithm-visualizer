/**
 * The Swift standard library the interpreter (./interp.js) offers, and the parts of Foundation algorithms use:
 * print and descriptions as Swift writes them, Int / Double / Character / String and their conversions, Array,
 * Dictionary, Set, tuples, ranges and stride, the sequence functions (map, filter, reduce, sorted…), min / max / abs /
 * swap / zip, Foundation's math and String(format:). Fatal errors have the runtime's words.
 */
import { Some, SChar, CH, SNum, SArr, SDict, SSet, STuple, SVal, SObj, SEnum, SFn, SRange, SStride, SIdx, SType, SImplicit, VOID, INT_KINDS, share, isVal, swiftDouble, chars, charCount } from './values.js';

const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;
const TRAIL = { removeAll: 'where', first: 'where', last: 'where', firstIndex: 'where', lastIndex: 'where', contains: 'where', count: 'where', sorted: 'by', sort: 'by',
  min: 'by', max: 'by', split: 'whereSeparator', prefix: 'while', drop: 'while' };
const GLOBALS = new Set(['print', 'debugPrint', 'min', 'max', 'abs', 'swap', 'stride', 'zip', 'sqrt', 'pow', 'floor', 'ceil', 'round', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan',
  'atan', 'atan2', 'asin', 'acos', 'hypot', 'trunc', 'fmod', 'cbrt', 'readLine', 'type', 'precondition', 'assert', 'fatalError', 'preconditionFailure', 'assertionFailure', 'exit',
  'repeatElement', 'Optional', 'Int', 'Double', 'Float', 'String', 'Character', 'Bool', 'Array', 'Set', 'Dictionary', 'UnicodeScalar', 'numericCast', 'sequence', ...Object.keys(INT_KINDS)]);

export function makeLib(ctx) {
  const { fail, trap, write, typeName, invoke } = ctx;

  /* ---- numbers ---- */
  function intKind(t, v, literal) {
    const [bits, signed] = INT_KINDS[t];
    const lo = signed ? -(2n ** BigInt(bits - 1)) : 0n, hi = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
    if (v < lo || v > hi) { if (literal) fail(v < 0n && !signed ? `negative integer '${v}' overflows when stored into unsigned type '${t}'` : `integer literal '${v}' overflows when stored into '${t}'`); trap('arithmetic overflow'); }
    return t === 'Int' || t === 'Int64' && false ? v : new SNum(t, v);
  }
  const fitsInt = (t, v) => { const [bits, signed] = INT_KINDS[t]; const lo = signed ? -(2n ** BigInt(bits - 1)) : 0n, hi = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n; return v >= lo && v <= hi; };
  function numOp(op, a, b) {
    if (a.t === 'Float') {
      const x = a.v, y = b.v, F = Math.fround;
      switch (op) {
        case '+': return new SNum('Float', F(x + y)); case '-': return new SNum('Float', F(x - y)); case '*': return new SNum('Float', F(x * y)); case '/': return new SNum('Float', F(x / y));
        case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
      }
      fail(`binary operator '${op}' cannot be applied to two 'Float' operands`);
    }
    const x = a.v, y = b.v, t = a.t, [bits] = INT_KINDS[t];
    const wrap = v => new SNum(t, INT_KINDS[t][1] ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v));
    switch (op) {
      case '+': return intKind(t, x + y); case '-': return intKind(t, x - y); case '*': return intKind(t, x * y);
      case '/': if (y === 0n) trap('Division by zero'); return intKind(t, x / y);
      case '%': if (y === 0n) trap('Division by zero in remainder operation'); return new SNum(t, x % y);
      case '&+': return wrap(x + y); case '&-': return wrap(x - y); case '&*': return wrap(x * y);
      case '&': return new SNum(t, x & y); case '|': return new SNum(t, x | y); case '^': return new SNum(t, x ^ y);
      case '<<': return wrap(y >= BigInt(bits) ? 0n : x << y); case '>>': return new SNum(t, x >> y);
      case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
    }
    fail(`binary operator '${op}' cannot be applied to two '${t}' operands`);
  }
  function numNeg(v) {
    if (v.t === 'Float') return new SNum('Float', -v.v);
    if (!INT_KINDS[v.t][1]) fail(`unary operator '-' cannot be applied to an operand of type '${v.t}'`);
    return intKind(v.t, -v.v);
  }
  const toNum = v => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v instanceof SNum ? Number(v.v) : NaN);
  /** Int(x) from a Double: towards zero, a fatal error when it does not fit */
  function intFromDouble(x, t = 'Int') {
    if (!Number.isFinite(x)) trap(`${typeof x === 'number' ? 'Double' : 'Float'} value cannot be converted to ${t} because it is either infinite or NaN`);
    const v = BigInt(Math.trunc(x));
    if (t === 'Int' ? v > I64_MAX || v < I64_MIN : !fitsInt(t, v)) trap(`Double value cannot be converted to ${t} because the result would be ${v < 0n ? 'less than ' + t + '.min' : 'greater than ' + t + '.max'}`);
    return t === 'Int' ? v : new SNum(t, v);
  }

  /* ---- descriptions ---- */
  const tname = T => T.name;
  const userDesc = (v, prop) => {
    if (!(v instanceof SVal || v instanceof SObj || v instanceof SEnum)) return null;
    if (!(ctx.conforms(v.T, prop === 'description' ? 'CustomStringConvertible' : 'CustomDebugStringConvertible'))) return null;
    const cp = ctx.findComputed(v.T, prop);
    if (cp || hasStoredProp(v, prop)) { const s = ctx.instanceMember(v, prop, null, v.T, true); return typeof s === 'string' ? s : null; }
    return null;
  };
  const hasStoredProp = (v, n) => v.f && v.f.has(n);
  function describe(v) {
    if (v === null) return 'nil';
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'number') return swiftDouble(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return String(v);
    if (v instanceof SChar) return v.c;
    if (v instanceof SNum) return v.t === 'Float' ? swiftDouble(v.v, true) : v.t === 'Unicode.Scalar' ? String.fromCodePoint(Number(v.v)) : String(v.v);
    if (v instanceof Some) return 'Optional(' + debugDescribe(v.v) + ')';
    if (v === VOID) return '()';
    const u = userDesc(v, 'description');
    if (u !== null) return u;
    if (v instanceof SArr && v.revOf) return `ReversedCollection<Array<${typeName(v.revOf).slice(1, -1)}>>(_base: ${describe(v.revOf)})`;
    if (v instanceof SArr) return '[' + v.a.map(debugDescribe).join(', ') + ']';
    if (v instanceof SSet) return '[' + [...v.m.values()].map(debugDescribe).join(', ') + ']';
    if (v instanceof SDict) return v.m.size ? '[' + [...v.m.values()].map(([k, x]) => debugDescribe(k) + ': ' + debugDescribe(x)).join(', ') + ']' : '[:]';
    if (v instanceof STuple) return '(' + v.a.map((x, k) => (v.labels && v.labels[k] ? v.labels[k] + ': ' : '') + debugDescribe(x)).join(', ') + ')';
    if (v instanceof SVal) return v.T.short + '(' + [...v.f].map(([k, x]) => k + ': ' + debugDescribe(x)).join(', ') + ')';
    if (v instanceof SObj) return 'main.' + tname(v.T);
    if (v instanceof SEnum) return v.c + payload(v);
    if (v instanceof SRange) return (v.lo === null ? '' : describe(v.lo)) + (v.closed ? '...' : '..<') + (v.hi === null ? '' : describe(v.hi));
    if (v instanceof SStride) return `StrideTo<Int>(_start: ${describe(v.from)}, _end: ${describe(v.to)}, _stride: ${describe(v.by)})`.replace('StrideTo', v.through ? 'StrideThrough' : 'StrideTo');
    if (v instanceof SFn) return '(Function)';
    if (v instanceof SIdx) return `Index(_rawBits: ${v.i})`;
    if (v instanceof SType) return typeDesc(v.t);
    if (v instanceof SImplicit) return '.' + v.name;
    return String(v);
  }
  /** a type as print shows it: Array<Int>, Dictionary<String, Int>, Optional<Int> */
  function typeDesc(t) {
    if (!t) return 'Any';
    if (t.arr) return 'Array<' + typeDesc(t.arr) + '>';
    if (t.dict) return 'Dictionary<' + typeDesc(t.dict[0]) + ', ' + typeDesc(t.dict[1]) + '>';
    if (t.set) return 'Set<' + typeDesc(t.set) + '>';
    if (t.opt) return 'Optional<' + typeDesc(t.opt) + '>';
    if (t.tuple) return '(' + t.tuple.map(typeDesc).join(', ') + ')';
    return ctx.typeText(t);
  }
  function payload(v) {
    if (!v.p) return '';
    const c = v.T.cases.get(v.c);
    return '(' + v.p.map((x, k) => (c.assoc[k] && c.assoc[k].label ? c.assoc[k].label + ': ' : '') + debugDescribe(x)).join(', ') + ')';
  }
  const quote = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + '"';
  function debugDescribe(v) {
    if (typeof v === 'string') return quote(v);
    if (v instanceof SChar) return quote(v.c);
    if (v instanceof SNum && v.t === 'Unicode.Scalar') return quote(String.fromCodePoint(Number(v.v)));
    const d = userDesc(v, 'debugDescription');
    if (d !== null) return d;
    const u = userDesc(v, 'description');
    if (u !== null) return u;
    if (v instanceof SVal) return 'main.' + tname(v.T) + '(' + [...v.f].map(([k, x]) => k + ': ' + debugDescribe(x)).join(', ') + ')';
    if (v instanceof SEnum) return 'main.' + tname(v.T) + '.' + v.c + payload(v);
    if (v instanceof SRange) return (v.lo === null ? '' : debugDescribe(v.lo)) + (v.closed ? '...' : '..<') + (v.hi === null ? '' : debugDescribe(v.hi));
    if (v instanceof SArr && v.slice) return 'ArraySlice(' + describe(v) + ')';
    return describe(v);
  }

  /* ---- hashing, equality, order ---- */
  function hashKey(v) {
    if (typeof v === 'bigint') return 'i' + v;
    if (typeof v === 'number') return 'd' + (Object.is(v, -0) ? 0 : v);
    if (typeof v === 'string') return 's' + v.normalize('NFC');
    if (typeof v === 'boolean') return 'b' + v;
    if (v === null) return 'n';
    if (v instanceof SChar) return 'c' + v.c;
    if (v instanceof SNum) return 'u' + v.t + v.v;
    if (v instanceof Some) return 'o' + hashKey(v.v);
    if (v instanceof SArr) return 'a[' + v.a.map(hashKey).join(',') + ']';
    if (v instanceof STuple) fail(`type '${typeName(v)}' does not conform to protocol 'Hashable'`);
    if (v instanceof SSet) return 'S{' + [...v.m.keys()].sort().join(',') + '}';
    if (v instanceof SDict) return 'D{' + [...v.m].map(([k, [, x]]) => k + ':' + hashKey(x)).sort().join(',') + '}';
    if (v instanceof SVal || v instanceof SEnum) {
      if (!ctx.conforms(v.T, 'Hashable') && !(v instanceof SEnum && !v.T.caseList.some(c => c.assoc))) fail(`type '${v.T.name}' does not conform to protocol 'Hashable'`);
      if (v instanceof SEnum) return 'e' + v.T.name + '.' + v.c + (v.p ? '(' + v.p.map(hashKey).join(',') + ')' : '');
      return 'v' + v.T.name + '{' + [...v.f].map(([k, x]) => k + '=' + hashKey(x)).join(',') + '}';
    }
    if (v instanceof SObj) { if (!ctx.conforms(v.T, 'Hashable')) fail(`type '${v.T.name}' does not conform to protocol 'Hashable'`); return 'O' + ctx.idOf(v); }
    if (v instanceof SRange) return 'r' + hashKey(v.lo) + (v.closed ? '...' : '..<') + hashKey(v.hi);
    fail(`type '${typeName(v)}' does not conform to protocol 'Hashable'`);
  }
  const cpCompare = (a, b) => { const x = Array.from(a.normalize('NFC')), y = Array.from(b.normalize('NFC')); for (let k = 0; k < Math.min(x.length, y.length); k++) { const d = x[k].codePointAt(0) - y[k].codePointAt(0); if (d) return d < 0 ? -1 : 1; } return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0; };
  /** < as Comparable has it (numbers, strings, characters, tuples, and the program's own <) */
  function compare(a, b) {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof SNum && b instanceof SNum) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string') return cpCompare(a, b);
    if (a instanceof SChar && b instanceof SChar) return cpCompare(a.c, b.c);
    if (typeof a === 'boolean' || typeof b === 'boolean') fail(`referencing operator function '<' on 'Comparable' requires that 'Bool' conform to 'Comparable'`);
    if (a instanceof STuple && b instanceof STuple) { for (let k = 0; k < a.a.length; k++) { const c = compare(a.a[k], b.a[k]); if (c) return c; } return 0; }
    if (a instanceof Some || a === null || b instanceof Some || b === null) fail(`value of optional type '${typeName(a instanceof Some || a === null ? a : b)}' must be unwrapped to a value of type '${typeName(a instanceof Some ? a.v : b instanceof Some ? b.v : a)}'`);
    return ctx.less(a, b) ? -1 : ctx.less(b, a) ? 1 : 0;
  }
  const items = v => v.a;

  /* ---- functions given as arguments ---- */
  function callF(f, ...vals) {
    if (f instanceof SFn) {
      if (f.native) return f.native(vals.map(v => ({ label: null, v })), null);
      return invoke(f, vals, f.self || null);
    }
    if (f instanceof SType) return construct(f.t, vals.map(v => ({ label: null, v })), null);
    fail(`cannot call value of non-function type '${typeName(f)}'`);
  }
  const bool = (v, what) => { if (typeof v !== 'boolean') fail(`cannot convert value of type '${typeName(v)}' to closure result type 'Bool'${what ? '' : ''}`); return v; };
  const lt = f => (a, b) => bool(callF(f, a, b));
  const sortWith = (xs, less) => xs.slice().sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
  const natural = xs => xs.slice().sort(compare);

  /* ---- collections ---- */
  /** the type of an array's elements, for literals added to it */
  const elemType = a => a.et || (a.a.length ? typeOfVal(a.a[0]) : null);
  const typeOfVal = v => (typeof v === 'number' ? { n: 'Double' } : typeof v === 'bigint' ? { n: 'Int' } : v instanceof SChar ? { n: 'Character' } : v instanceof SNum ? { n: v.t } : v instanceof Some ? { opt: typeOfVal(v.v) || { n: 'Any' } } : null);
  function arrIndex(a, idx) {
    if (typeof idx !== 'bigint') fail(`no exact matches in call to subscript`);
    const k = Number(idx) - a.off;
    if (k < 0 || k >= a.a.length || idx < 0n) trap(a.slice ? 'Index out of bounds' : 'Index out of range');   // an ArraySlice words it so
    return k;
  }
  function toSet(a, et) {
    const s = new SSet(et || a.et);
    for (const x of a.a) s.m.set(hashKey(x), share(x));
    return s;
  }
  function rangeBounds(r, count, off = 0) {
    const lo = r.lo === null ? off : Number(toInt(r.lo)), hiRaw = r.hi === null ? off + count : Number(toInt(r.hi)) + (r.closed ? 1 : 0);
    return [lo, hiRaw];
  }
  const toInt = v => { if (typeof v !== 'bigint') fail(`cannot convert value of type '${typeName(v)}' to expected argument type 'Int'`); return v; };
  function subGet(base, idx) {
    if (base instanceof SArr) {
      if (idx instanceof SRange) {
        const [lo, hi] = rangeBounds(idx, base.a.length, base.off);
        if (lo < base.off || hi > base.off + base.a.length || lo > hi) trap('Array index is out of range');
        const s = new SArr(base.a.slice(lo - base.off, hi - base.off).map(share), base.et);
        s.off = lo; s.slice = true;
        return s;
      }
      return base.a[arrIndex(base, idx)];
    }
    if (base instanceof SDict) { const en = base.m.get(hashKey(idx)); return en ? new Some(share(en[1])) : null; }
    if (typeof base === 'string') {
      if (typeof idx === 'bigint') fail(`'subscript(_:)' is unavailable: cannot subscript String with an Int, use a String.Index instead.`);
      if (idx instanceof SIdx) { const cs = chars(base); if (idx.i < 0 || idx.i >= cs.length) trap('String index is out of bounds'); return CH(cs[idx.i]); }
      if (idx instanceof SRange) {
        if (typeof idx.lo === 'bigint' || typeof idx.hi === 'bigint') fail(`'subscript(_:)' is unavailable: cannot subscript String with an integer range, use a String.Index range instead.`);
        const cs = chars(base);
        const lo = idx.lo ? idx.lo.i : 0, hi = idx.hi ? idx.hi.i + (idx.closed ? 1 : 0) : cs.length;
        if (lo < 0 || hi > cs.length || lo > hi) trap('String index is out of bounds');
        return cs.slice(lo, hi).join('');
      }
    }
    if (base instanceof STuple) fail(`value of type '${typeName(base)}' has no subscripts`);
    fail(`value of type '${typeName(base)}' has no subscripts`);
  }
  function subSet(base, idx, v, ve) {
    if (base instanceof SArr) {
      if (idx instanceof SRange) {
        const [lo, hi] = rangeBounds(idx, base.a.length, base.off);
        if (lo < base.off || hi > base.off + base.a.length) trap('Array index is out of range');
        if (!(v instanceof SArr)) fail(`cannot assign value of type '${typeName(v)}' to subscript of type 'ArraySlice<${typeName(base).slice(1, -1)}>'`);
        base.a.splice(lo - base.off, hi - lo, ...v.a.map(share));
        return;
      }
      const k = arrIndex(base, idx);
      base.a[k] = ctx.conv(v, elemType(base), ve, 'assign');
      return;
    }
    if (base instanceof SDict) {
      const key = hashKey(idx);
      if (v === null) { base.m.delete(key); return; }
      const x = v instanceof Some && !(base.vt && base.vt.opt) ? v.v : v;
      const old = base.m.get(key);
      base.m.set(key, [old ? old[0] : idx, base.vt ? ctx.conv(x, base.vt, ve, 'assign') : x]);
      return;
    }
    fail(`cannot assign through subscript: '${typeName(base)}' has no setter`);
  }
  const dictGet = (d, k) => { const en = d.m.get(hashKey(k)); return en ? { v: en[1] } : null; };
  function rangeContains(r, v) {
    if (v === null) return false;
    let x = v;
    if (typeof r.lo === 'number' && typeof x === 'bigint') x = Number(x);
    if (r.lo !== null && compare(x, r.lo) < 0) return false;
    if (r.hi !== null) { const c = compare(x, r.hi); if (r.closed ? c > 0 : c >= 0) return false; }
    return true;
  }
  function patternMatch(a, b) { if (a instanceof SRange) return rangeContains(a, b); return ctx.equal(a, b, null); }
  function* rangeIter(r) {
    if (typeof r.lo !== 'bigint' || (r.hi !== null && typeof r.hi !== 'bigint')) fail(`for-in loop requires '${typeName(r)}' to conform to 'Sequence'`);
    for (let k = r.lo; r.hi === null || (r.closed ? k <= r.hi : k < r.hi); k++) yield k;
  }
  function* strideIter(s) {
    const isD = typeof s.from === 'number' || typeof s.to === 'number' || typeof s.by === 'number';
    const by = isD ? toNum(s.by) : s.by;
    if (isD) {
      const from = toNum(s.from), to = toNum(s.to);
      if (by === 0) trap('Stride size must not be zero');
      for (let k = 0; ; k++) { const x = from + k * by; if (by > 0 ? (s.through ? x > to : x >= to) : (s.through ? x < to : x <= to)) break; yield x; }
      return;
    }
    if (by === 0n) trap('Stride size must not be zero');
    for (let x = s.from; by > 0n ? (s.through ? x <= s.to : x < s.to) : (s.through ? x >= s.to : x > s.to); x += by) yield x;
  }
  /** what a for-in loop goes through (a copy: changing the array in the loop does not change the loop) */
  function iterate(seq, e) {
    if (seq instanceof SArr) return seq.a.slice();
    if (seq instanceof SRange) return rangeIter(seq);
    if (seq instanceof SStride) return strideIter(seq);
    if (typeof seq === 'string') return chars(seq).map(CH);
    if (seq instanceof SDict) return [...seq.m.values()].map(([k, v]) => new STuple([k, v], ['key', 'value']));
    if (seq instanceof SSet) return [...seq.m.values()];
    if (seq === null || seq instanceof Some) fail(`for-in loop requires '${seq === null ? 'Optional<Any>' : typeName(seq)}' to conform to 'Sequence'; did you mean to unwrap optional?`);
    if (seq instanceof SVal || seq instanceof SObj) {
      // a Sequence of the program's own: makeIterator() and next()
      const it = ctx.instanceMember(seq, 'makeIterator', null, seq.T, true);
      if (it) { const iter = callF(it); const out = []; const nx = () => callF(ctx.instanceMember(iter, 'next', null, iter.T)); for (let x = nx(), n = 0; x !== null && n < 100000; x = nx(), n++) out.push(x instanceof Some ? x.v : x); return out; }
    }
    fail(`for-in loop requires '${typeName(seq)}' to conform to 'Sequence'`);
    void e;
  }
  /** the elements of any sequence, as a list */
  function seqItems(v) {
    if (v instanceof SArr) return v.a;
    if (v instanceof SRange) { const out = []; for (const x of rangeIter(v)) { out.push(x); if (out.length > 1e6) trap('the sequence is too long'); } return out; }
    if (v instanceof SStride) return [...strideIter(v)];
    if (typeof v === 'string') return chars(v).map(CH);
    if (v instanceof SSet) return [...v.m.values()];
    if (v instanceof SDict) return [...v.m.values()].map(([k, x]) => new STuple([k, x], ['key', 'value']));
    return [...iterate(v)];
  }
  const arrOf = (xs, et = null) => new SArr(xs.map(share), et);
  /** an ArraySlice of arr: its indices go on from where it starts in arr */
  const slice = (xs, arr, from) => { const s = arrOf(xs, arr.et); s.off = arr.off + from; s.slice = true; return s; };
  const opt = v => (v === undefined || v === null ? null : new Some(v));

  /* ---- argument helpers ---- */
  const lbl = (args, k, want, name) => {
    const a = args[k];
    if (!a) fail(`missing argument for parameter ${want ? `'${want}'` : '#' + (k + 1)} in call`);
    if ((a.label || null) !== (want || null) && !(a.trailing && want && !a.label)) {
      if (!want) fail(`extraneous argument label '${a.label}:' in call`);
      if (!a.label) fail(`missing argument label '${want}:' in call`);
      fail(`incorrect argument label in call (have '${a.label}:', expected '${want}:')`);
    }
    void name;
    return a.v;
  };
  const noArgs = (args, name) => { if (args.length) fail(`argument passed to call that takes no arguments`); void name; };
  const argc = (args, n) => { if (args.length > n) fail('extra argument in call'); };
  const hasLabel = (args, l) => args.some(a => a.label === l);

  /* ---- print ---- */
  function print(args, debug) {
    let sep = ' ', term = '\n';
    const vals = [];
    for (const a of args) {
      if (a.label === 'separator') sep = a.v;
      else if (a.label === 'terminator') term = a.v;
      else if (a.label) fail(`extraneous argument label '${a.label}:' in call`);
      else vals.push(a.v);
    }
    write(vals.map(debug ? debugDescribe : describe).join(sep) + term);
    return VOID;
  }

  /* ---- String(format:) ---- */
  function format(fmt, vals) {
    let k = 0;
    return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?(hh|h|ll|l|q|L|z|t|j)?([diouxXeEfFgGcs@%])/g, (m, flags, width, prec, len, conv) => {
      if (conv === '%') return '%';
      const v = vals[k++];
      if (v === undefined) return '';
      let s;
      const num = toNum(v instanceof Some ? v.v : v);
      switch (conv) {
        case 'd': case 'i': s = typeof v === 'bigint' || v instanceof SNum ? String(v instanceof SNum ? v.v : v) : String(Math.trunc(num)); break;
        case 'u': s = String(typeof v === 'bigint' ? BigInt.asUintN(64, v) : v instanceof SNum ? v.v : num); break;
        case 'x': case 'X': { const n = typeof v === 'bigint' ? BigInt.asUintN(64, v) : v instanceof SNum ? v.v : BigInt(Math.trunc(num)); s = n.toString(16); if (conv === 'X') s = s.toUpperCase(); if (flags.includes('#') && n) s = (conv === 'X' ? '0X' : '0x') + s; break; }
        case 'o': s = (typeof v === 'bigint' ? BigInt.asUintN(64, v) : v instanceof SNum ? v.v : BigInt(Math.trunc(num))).toString(8); break;
        case 'f': case 'F': s = fixed(num, prec === undefined ? 6 : +prec); break;
        case 'e': case 'E': { s = num.toExponential(prec === undefined ? 6 : +prec).replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'E') s = s.toUpperCase(); break; }
        case 'g': case 'G': { const p = prec === undefined ? 6 : +prec || 1; const ex = num === 0 ? 0 : Math.floor(Math.log10(Math.abs(num))); s = ex < -4 || ex >= p ? num.toExponential(p - 1).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2') : String(+num.toFixed(Math.max(0, p - 1 - ex))); if (conv === 'G') s = s.toUpperCase(); break; }
        case 'c': s = v instanceof SChar ? v.c : String.fromCharCode(num); break;
        case 's': case '@': s = describe(v); break;
      }
      if (flags.includes('+') && 'dieEfFgG'.includes(conv) && num >= 0) s = '+' + s;
      else if (flags.includes(' ') && 'dieEfFgG'.includes(conv) && num >= 0) s = ' ' + s;
      const w = width === '*' ? Number(vals[k++]) : width ? +width : 0;
      if (s.length < w) {
        if (flags.includes('-')) s = s.padEnd(w);
        else if (flags.includes('0') && 'diouxXeEfFgG'.includes(conv)) { const sign = /^[+\- ]/.test(s) ? s[0] : ''; s = sign + s.slice(sign.length).padStart(w - sign.length, '0'); }
        else s = s.padStart(w);
      }
      void len;
      return s;
    });
  }
  /** %.Nf as C prints it: the exact binary value, rounded half to even */
  function fixed(x, p) {
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
    let s = x.toFixed(Math.min(p, 100));
    // toFixed rounds the exact value half up; C rounds the exact value to even: they differ only on exact ties
    const scaled = Math.abs(x) * 10 ** p;
    if (p <= 15 && Number.isInteger(scaled * 2) && !Number.isInteger(scaled) && Math.abs(x) * 10 ** p < 2 ** 52) {
      const lo = Math.floor(scaled), r = lo % 2 === 0 ? lo : lo + 1;
      s = (x < 0 ? '-' : '') + (r / 10 ** p).toFixed(p);
    }
    return s;
  }

  /* ---- construction: Int(…), String(…), [Int](repeating:count:)… ---- */
  function construct(t, args, e) {
    if (t.arr) {
      if (!args.length) return new SArr([], t.arr);
      if (hasLabel(args, 'repeating')) { const v = lbl(args, 0, 'repeating'), n = toInt(lbl(args, 1, 'count')); if (n < 0n) trap("Can't construct Array with count < 0"); const x = ctx.conv(v, t.arr, args[0].e, 'argument'); return new SArr(Array.from({ length: Number(n) }, () => share(x)), t.arr); }
      return new SArr(seqItems(lbl(args, 0, null)).map(share), t.arr);
    }
    if (t.set) { if (!args.length) return new SSet(t.set); return toSet(new SArr(seqItems(lbl(args, 0, null))), t.set); }
    if (t.dict) { if (!args.length) return new SDict(t.dict[0], t.dict[1]); return dictInit(args, t.dict[0], t.dict[1]); }
    if (t.opt) return args.length ? new Some(args[0].v) : null;
    const n = t.n;
    switch (n) {
      case 'Array': {
        if (!args.length) fail('generic parameter \'Element\' could not be inferred');
        if (hasLabel(args, 'repeating')) { const v = lbl(args, 0, 'repeating'), c = toInt(lbl(args, 1, 'count')); if (c < 0n) trap("Can't construct Array with count < 0"); return new SArr(Array.from({ length: Number(c) }, () => share(v)), typeOfVal(v)); }
        const a = lbl(args, 0, null);
        return new SArr(seqItems(a).map(share), a instanceof SArr ? a.et : typeof a === 'string' ? { n: 'Character' } : a instanceof SRange ? { n: 'Int' } : null);
      }
      case 'Set': if (!args.length) fail('generic parameter \'Element\' could not be inferred'); return toSet(new SArr(seqItems(lbl(args, 0, null))), null);
      case 'Dictionary': return dictInit(args, null, null);
    }
    return callGlobal(n, args, e);
  }
  function dictInit(args, kt, vt) {
    const d = new SDict(kt, vt);
    if (hasLabel(args, 'uniqueKeysWithValues')) {
      for (const p of seqItems(lbl(args, 0, 'uniqueKeysWithValues'))) { const key = hashKey(p.a[0]); if (d.m.has(key)) trap(`Duplicate values for key: '${describe(p.a[0])}'`); d.m.set(key, [p.a[0], share(p.a[1])]); }
      return d;
    }
    if (hasLabel(args, 'grouping')) {
      const xs = seqItems(lbl(args, 0, 'grouping')), f = lbl(args, 1, 'by');
      for (const x of xs) { const k = callF(f, x), key = hashKey(k); if (!d.m.has(key)) d.m.set(key, [k, new SArr([])]); d.m.get(key)[1].a.push(share(x)); }
      return d;
    }
    if (args.length === 2 && args[1].label === 'uniquingKeysWith') {
      const f = args[1].v;
      for (const p of seqItems(args[0].v)) { const key = hashKey(p.a[0]); d.m.set(key, d.m.has(key) ? [d.m.get(key)[0], callF(f, d.m.get(key)[1], p.a[1])] : [p.a[0], share(p.a[1])]); }
      return d;
    }
    if (!args.length) return d;
    fail('no exact matches in call to initializer');
  }
  const hasGlobal = n => GLOBALS.has(n);
  function callGlobal(n, args, e) {
    const a0 = args[0] && args[0].v;
    const unlabeled = () => args.forEach(a => { if (a.label) fail(`extraneous argument label '${a.label}:' in call`); });
    switch (n) {
      case 'print': return print(args, false);
      case 'debugPrint': return print(args, true);
      case 'min': case 'max': {
        unlabeled();
        if (args.length < 2) fail(`missing argument for parameter #2 in call`);
        let vals = args.map(a => (a.v instanceof Some || a.v === null ? fail(`value of optional type '${typeName(a.v)}' must be unwrapped to a value of type '${a.v === null ? 'Int' : typeName(a.v.v)}'`) : a.v));
        if (vals.some(v => typeof v === 'number') && vals.some(v => typeof v === 'bigint')) vals = vals.map((v, k) => (typeof v === 'bigint' ? (args[k].e && isLit(args[k].e) ? Number(v) : fail(`conflicting arguments to generic parameter 'T' ('Double' vs. 'Int')`)) : v));
        let best = vals[0];
        for (const v of vals.slice(1)) { const c = compare(v, best); if (n === 'min' ? c < 0 : c > 0 && true) best = v; else if (n === 'max' && c === 0) best = v; }
        return best;
      }
      case 'abs': { unlabeled(); const v = a0; if (typeof v === 'bigint') { if (v === I64_MIN) trap('Negation overflow'); return v < 0n ? -v : v; } if (typeof v === 'number') return Math.abs(v); if (v instanceof SNum) return v.t === 'Float' ? new SNum('Float', Math.abs(v.v)) : new SNum(v.t, v.v < 0n ? -v.v : v.v); fail(`global function 'abs' requires that '${typeName(v)}' conform to 'Comparable'`); }
      case 'swap': {
        if (args.length !== 2 || !args[0].place || !args[1].place) fail(`passing value of type '${typeName(a0)}' to an inout parameter requires explicit '&'`);
        const x = args[0].v, y = args[1].v;
        ctx.lvalue(args[0].place, 'inout'); ctx.lvalue(args[1].place, 'inout');
        ctx.assignTo(args[0].place, share(y), null); ctx.assignTo(args[1].place, share(x), null);
        return VOID;
      }
      case 'stride': {
        const from = lbl(args, 0, 'from'), through = args[1] && args[1].label === 'through';
        const to = lbl(args, 1, through ? 'through' : 'to'), by = lbl(args, 2, 'by');
        let [f, t, b] = [from, to, by];
        if ([f, t, b].some(x => typeof x === 'number')) [f, t, b] = [f, t, b].map((x, k) => (typeof x === 'bigint' && args[k].e && isLit(args[k].e) ? Number(x) : x));
        return new SStride(f, t, b, through);
      }
      case 'zip': { unlabeled(); const xs = seqItems(a0), ys = seqItems(args[1].v); return arrOf(xs.slice(0, Math.min(xs.length, ys.length)).map((x, k) => new STuple([share(x), share(ys[k])]))); }
      case 'sqrt': case 'floor': case 'ceil': case 'round': case 'log': case 'log2': case 'log10': case 'exp': case 'sin': case 'cos': case 'tan': case 'atan': case 'asin': case 'acos': case 'trunc': case 'cbrt': {
        unlabeled();
        const v = a0;
        if (typeof v === 'bigint' && !(args[0].e && isLit(args[0].e))) fail(`no exact matches in call to global function '${n}'`);
        const x = toNum(v), F = { sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, round: x => (x < 0 ? -Math.round(-x) : Math.round(x)), log: Math.log, log2: Math.log2, log10: Math.log10, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, asin: Math.asin, acos: Math.acos, trunc: Math.trunc, cbrt: Math.cbrt }[n];
        const r = F(x);
        return v instanceof SNum && v.t === 'Float' ? new SNum('Float', Math.fround(r)) : r;
      }
      case 'pow': case 'atan2': case 'hypot': case 'fmod': {
        unlabeled();
        const [x, y] = args.map(a => a.v);
        if ((typeof x === 'bigint' && !isLit(args[0].e)) || (typeof y === 'bigint' && !isLit(args[1].e))) fail(n === 'pow' && typeof x === 'bigint' ? `cannot convert value of type 'Int' to expected argument type 'Double'` : `no exact matches in call to global function '${n}'`);
        const a = toNum(x), b = toNum(y);
        return n === 'pow' ? Math.pow(a, b) : n === 'atan2' ? Math.atan2(a, b) : n === 'hypot' ? Math.hypot(a, b) : a % b;
      }
      case 'readLine': return null;
      case 'type': return new SType(ctx.typeOfValue(lbl(args, 0, 'of')) || { n: typeName(a0) });
      case 'precondition': case 'assert': {
        const c = args[0].v;
        if (typeof c !== 'boolean') fail(`cannot convert value of type '${typeName(c)}' to expected argument type 'Bool'`);
        if (!c) ctx.trapRaw((n === 'assert' ? 'Assertion failed' : 'Precondition failed') + (args[1] ? ': ' + describe(args[1].v) : ''));
        return VOID;
      }
      case 'fatalError': trap(args.length ? describe(a0) : ''); break;
      case 'preconditionFailure': ctx.trapRaw('Fatal error' + (args.length ? ': ' + describe(a0) : '')); break;
      case 'assertionFailure': ctx.trapRaw('Fatal error' + (args.length ? ': ' + describe(a0) : '')); break;
      case 'exit': throw { exit: Number(toInt(a0)) };
      case 'repeatElement': return new SArr(Array.from({ length: Number(toInt(lbl(args, 1, 'count'))) }, () => share(a0)));
      case 'numericCast': return a0;
      case 'Optional': unlabeled(); return a0 === null || a0 instanceof Some ? a0 : new Some(a0);
      case 'sequence': fail('sequence(first:next:) is not supported here');
      case 'Int': case 'Int8': case 'Int16': case 'Int32': case 'Int64': case 'UInt': case 'UInt8': case 'UInt16': case 'UInt32': case 'UInt64': return toIntType(n, args, e);
      case 'Double': case 'Float': {
        if (!args.length) return n === 'Float' ? new SNum('Float', 0) : 0;
        const v = a0;
        argc(args, 1);
        let r;
        if (typeof v === 'string') { const t = v.trim() === v && /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan|0x[0-9a-fA-F]+)$/i.test(v) ? Number(v.replace(/^([+-]?)inf(inity)?$/i, '$1Infinity')) : null; return t === null || Number.isNaN(t) && !/nan/i.test(v) ? null : new Some(n === 'Float' ? new SNum('Float', Math.fround(t)) : t); }
        if (args[0].label === 'exactly') fail('Double(exactly:) is not supported here');
        r = toNum(v);
        if (Number.isNaN(r) && !(typeof v === 'number')) fail(`no exact matches in call to initializer`);
        return n === 'Float' ? new SNum('Float', Math.fround(r)) : r;
      }
      case 'String': return toStr(args);
      case 'Character': {
        unlabeled();
        const v = a0;
        if (v instanceof SChar) return v;
        if (v instanceof SNum && v.t === 'Unicode.Scalar') return CH(String.fromCodePoint(Number(v.v)));
        if (typeof v !== 'string') fail(`no exact matches in call to initializer`);
        if (charCount(v) !== 1) trap(`Can't form a Character from a String containing more than one extended grapheme cluster`);
        return CH(v);
      }
      case 'UnicodeScalar': {
        const v = a0;
        if (v instanceof SNum && v.t === 'UInt8' || typeof v === 'bigint' && isLit(args[0].e) && v >= 0n && v < 256n) return new SNum('Unicode.Scalar', v instanceof SNum ? v.v : v);   // UnicodeScalar(98): the literal is a UInt8
        const cp = typeof v === 'bigint' ? Number(v) : v instanceof SNum ? Number(v.v) : typeof v === 'string' && charCount(v) === 1 ? v.codePointAt(0) : fail('no exact matches in call to initializer');
        if (typeof v === 'string') return new SNum('Unicode.Scalar', BigInt(cp));
        return cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? null : new Some(new SNum('Unicode.Scalar', BigInt(cp)));
      }
      case 'Bool': { const v = a0; if (typeof v === 'string') return v === 'true' ? new Some(true) : v === 'false' ? new Some(false) : null; if (typeof v === 'boolean') return v; fail('no exact matches in call to initializer'); }
      case 'Array': case 'Set': case 'Dictionary': return construct({ n }, args, e);
    }
    fail(`cannot find '${n}' in scope`);
  }
  const isLit = e => !!e && (e.k === 'num' || e.k === 'unary' && isLit(e.e) || e.paren && e.k === 'num');
  function toIntType(n, args, e) {
    if (!args.length) return n === 'Int' ? 0n : new SNum(n, 0n);
    const v = args[0].v;
    if (args[0].label === 'exactly') { const x = toNum(v); return Number.isInteger(x) ? new Some(n === 'Int' ? BigInt(x) : new SNum(n, BigInt(x))) : null; }
    if (args[0].label === 'truncatingIfNeeded') { const [bits, signed] = INT_KINDS[n] || [64, true]; const x = typeof v === 'bigint' ? v : v instanceof SNum ? v.v : BigInt(Math.trunc(toNum(v))); const r = signed ? BigInt.asIntN(bits, x) : BigInt.asUintN(bits, x); return n === 'Int' ? r : new SNum(n, r); }
    if (args[0].label && args[0].label !== 'clamping') fail(`extraneous argument label '${args[0].label}:' in call`);
    if (typeof v === 'string') {
      const radix = args[1] ? Number(lbl(args, 1, 'radix')) : 10;
      const ok = radix === 10 ? /^[+-]?\d+$/.test(v) : new RegExp(`^[+-]?[${'0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix)}]+$`, 'i').test(v);
      if (!ok) return null;
      let r;
      if (radix === 10) r = BigInt(v);
      else { const neg = v[0] === '-'; r = [...v.replace(/^[+-]/, '').toLowerCase()].reduce((acc, ch) => acc * BigInt(radix) + BigInt(parseInt(ch, radix)), 0n); if (neg) r = -r; }
      if (n === 'Int' ? r > I64_MAX || r < I64_MIN : !fitsInt(n, r)) return null;
      return new Some(n === 'Int' ? r : new SNum(n, r));
    }
    if (typeof v === 'number') return intFromDouble(v, n);
    if (v instanceof SNum && v.t === 'Float') return intFromDouble(v.v, n);
    let x;
    if (typeof v === 'bigint') x = v;
    else if (v instanceof SNum) x = v.v;
    else if (v instanceof SChar) fail(`no exact matches in call to initializer`);
    else if (v instanceof Some || v === null) fail(`value of optional type '${typeName(v)}' must be unwrapped to a value of type '${v === null ? 'UInt8' : typeName(v.v)}'`);
    else if (typeof v === 'boolean') fail(`no exact matches in call to initializer`);
    else fail(`no exact matches in call to initializer`);
    if (args[0].e && isLit(args[0].e) && !(n === 'Int' ? x <= I64_MAX && x >= I64_MIN : fitsInt(n, x))) fail(x < 0n && !INT_KINDS[n][1] ? `negative integer '${x}' overflows when stored into unsigned type '${n}'` : `integer literal '${x}' overflows when stored into '${n}'`);
    if (args[0].label === 'clamping') { const [bits, signed] = INT_KINDS[n] || [64, true]; const lo = signed ? -(2n ** BigInt(bits - 1)) : 0n, hi = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n; x = x < lo ? lo : x > hi ? hi : x; }
    if (n === 'Int' ? x > I64_MAX || x < I64_MIN : !fitsInt(n, x)) trap('Not enough bits to represent the passed value');
    void e;
    return n === 'Int' ? x : new SNum(n, x);
  }
  function toStr(args) {
    if (!args.length) return '';
    const a = args[0];
    if (a.label === 'repeating') { const v = a.v, c = toInt(lbl(args, 1, 'count')); if (c < 0n) trap('Negative count not allowed'); return (v instanceof SChar ? v.c : v).repeat(Number(c)); }
    if (a.label === 'describing') return describe(a.v);
    if (a.label === 'reflecting') return debugDescribe(a.v);
    if (a.label === 'format') {
      if (!ctx.hasFoundation()) fail(`no exact matches in call to initializer`);
      return format(a.v, args.slice(1).map(x => x.v));
    }
    if (a.label) fail(`extraneous argument label '${a.label}:' in call`);
    const v = a.v;
    if (args[1] && args[1].label === 'radix') {
      const r = Number(toInt(args[1].v));
      let s = (typeof v === 'bigint' ? v : v.v).toString(r);
      if (args[2] && args[2].label === 'uppercase' && args[2].v) s = s.toUpperCase();
      return s;
    }
    if (v instanceof SArr && (v.a.every(x => x instanceof SChar) && (v.a.length || (v.et && v.et.n === 'Character')))) return v.a.map(x => x.c).join('');
    if (v instanceof SArr && v.reversedString) return v.a.map(x => x.c).join('');
    return describe(v);
  }

  /* ---- static members: Int.max, Double.pi… ---- */
  function staticMember(T, name, args, e, tref) {
    if (T === 'Int' || INT_KINDS[T]) {
      const [bits, signed] = INT_KINDS[T] || [64, true];
      const mk = v => (T === 'Int' ? v : new SNum(T, v));
      switch (name) {
        case 'max': return mk(signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n);
        case 'min': return mk(signed ? -(2n ** BigInt(bits - 1)) : 0n);
        case 'zero': return mk(0n);
        case 'bitWidth': return BigInt(bits);
        case 'random': {
          const r = lbl(args || [], 0, 'in');
          if (!(r instanceof SRange)) fail('no exact matches in call to static method \'random\'');
          const lo = r.lo, hi = r.closed ? r.hi : r.hi - 1n;
          if (hi < lo) trap('Range must not be empty');
          return mk(lo + BigInt(Math.floor(Math.random() * Number(hi - lo + 1n))));
        }
        case 'init': return new SFn({ name: T + '.init', native: a => toIntType(T, a, e) });
      }
    }
    if (T === 'Double' || T === 'Float' || T === 'CGFloat') {
      const mk = v => (T === 'Float' ? new SNum('Float', Math.fround(v)) : v);
      switch (name) {
        case 'pi': return mk(Math.PI);
        case 'infinity': return mk(Infinity);
        case 'nan': return mk(NaN);
        case 'greatestFiniteMagnitude': return mk(T === 'Float' ? 3.4028234663852886e38 : Number.MAX_VALUE);
        case 'leastNonzeroMagnitude': return mk(T === 'Float' ? 1.401298464324817e-45 : 5e-324);
        case 'leastNormalMagnitude': return mk(T === 'Float' ? 1.1754943508222875e-38 : 2.2250738585072014e-308);
        case 'ulpOfOne': return mk(T === 'Float' ? 1.1920928955078125e-7 : Number.EPSILON);
        case 'zero': return mk(0);
        case 'random': { const r = lbl(args || [], 0, 'in'); const lo = toNum(r.lo), hi = toNum(r.hi); return mk(lo + Math.random() * (hi - lo)); }
        case 'init': return new SFn({ name: T + '.init', native: a => callGlobal(T, a, e) });
      }
    }
    if (T === 'String' && name === 'init') return new SFn({ name: 'String.init', native: a => toStr(a) });
    if (T === 'Character' && name === 'init') return new SFn({ name: 'Character.init', native: a => callGlobal('Character', a, e) });
    if (T === 'Bool' && name === 'random') return Math.random() < 0.5;
    if (T === 'Array' || T === 'Set' || T === 'Dictionary') { if (name === 'init') return new SFn({ name: T + '.init', native: a => construct(tref || { n: T }, a, e) }); }
    if (args && name === 'init') return construct(tref || { n: T }, args, e);
    fail(`type '${typeof T === 'string' ? T : ctx.typeText(T)}' has no member '${name}'`);
  }

  /* ---- members (properties) ---- */
  function member(v, name, e) {
    if (typeof v === 'bigint' || v instanceof SNum && v.t !== 'Float' && v.t !== 'Unicode.Scalar') return intMember(v, name, null, e);
    if (typeof v === 'number' || v instanceof SNum && v.t === 'Float') return dblMember(v, name, null, e);
    if (typeof v === 'string') return strMember(v, name, null, e);
    if (v instanceof SChar) return charMember(v, name, null, e);
    if (v instanceof SNum && v.t === 'Unicode.Scalar') { if (name === 'value') return new SNum('UInt32', v.v); if (name === 'isASCII') return v.v < 128n; if (name === 'properties') return v; if (name === 'description') return describe(v); }
    if (v instanceof SArr) return arrMember(v, name, null, e);
    if (v instanceof SDict) return dictMember(v, name, null, e);
    if (v instanceof SSet) return setMember(v, name, null, e);
    if (v instanceof SRange) return rangeMember(v, name, null, e);
    if (v instanceof STuple) {
      const k = v.labels ? v.labels.indexOf(name) : -1;
      if (k >= 0) return v.a[k];
      fail(`value of tuple type '${typeName(v)}' has no member '${name}'`);
    }
    if (v instanceof SStride) return arrMember(new SArr([...strideIter(v)]), name, null, e);
    if (typeof v === 'boolean' && name === 'description') return String(v);
    if (typeof v === 'boolean' && name === 'toggle') fail('toggle needs ()');
    if (v instanceof SIdx && name === 'utf16Offset') return BigInt(v.i);
    fail(`value of type '${typeName(v)}' has no member '${name}'`);
  }
  /** v.name(args): the library's methods; recvE is the receiver's expression, for the ones that change it */
  function callMethod(v, name, e, recvE) {
    const elemT = v instanceof SArr ? elemType(v) : v instanceof SSet ? v.et : null;
    // a trailing closure has no label: give it the one the method's closure parameter has
    const args = e.args.map(a => ({ label: a.trailing && !a.label && TRAIL[name] !== undefined && e.args.length === 1 ? TRAIL[name] : a.label, v: a.e.k === 'inout' ? ctx.rval(a.e.e) : contextual(a, v, name, elemT), e: a.e, place: a.e.k === 'inout' ? a.e.e : null, trailing: !!a.trailing }));
    if (typeof v === 'boolean' && name === 'toggle') { noArgs(args); ctx.checkMutable(recvE); ctx.assignTo(recvE, !v, null); return VOID; }
    if (typeof v === 'bigint' || v instanceof SNum && v.t !== 'Float' && v.t !== 'Unicode.Scalar') return intMember(v, name, args, e);
    if (typeof v === 'number' || v instanceof SNum && v.t === 'Float') return dblMember(v, name, args, e, recvE);
    if (typeof v === 'string') return strMember(v, name, args, e, recvE);
    if (v instanceof SChar) return charMember(v, name, args, e);
    if (v instanceof SArr) return arrMember(v, name, args, e, recvE);
    if (v instanceof SDict) return dictMember(v, name, args, e, recvE);
    if (v instanceof SSet) return setMember(v, name, args, e, recvE);
    if (v instanceof SRange) return rangeMember(v, name, args, e);
    if (v instanceof SStride) return arrMember(new SArr([...strideIter(v)]), name, args, e, null);
    if (v instanceof SFn) { if (name === 'callAsFunction') return callF(v, ...args.map(a => a.v)); }
    if (v instanceof STuple) fail(`value of tuple type '${typeName(v)}' has no member '${name}'`);
    fail(`value of type '${typeName(v)}' has no member '${name}'`);
  }
  /** an argument's value, with the type the method expects (append(1) to a [Double] appends 1.0) */
  function contextual(a, v, name, elemT) {
    const e = a.e;
    if (elemT && ['append', 'insert', 'contains', 'firstIndex', 'lastIndex', 'remove', 'update'].includes(name) && !a.label || elemT && a.label === 'of' && ['firstIndex', 'lastIndex'].includes(name)) return ctx.stored(ctx.rvalT(e, elemT), e);
    if (v instanceof SArr && name === 'append' && a.label === 'contentsOf' && elemT) return ctx.stored(ctx.rvalT(e, { arr: elemT }), e);
    if (v instanceof SDict && (name === 'updateValue' && !a.label)) return ctx.stored(ctx.rvalT(e, v.vt), e);
    if (v instanceof SDict && (name === 'removeValue' || a.label === 'forKey' || name === 'index')) return ctx.rvalT(e, ctx.keyType(v));
    if (v instanceof SSet && ['insert', 'remove', 'contains'].includes(name) && !a.label) return ctx.stored(ctx.rvalT(e, v.et || (v.m.size ? typeOfVal(v.m.values().next().value) : null)), e);
    if ((name === 'reduce') && !a.label && e.k === 'num') return ctx.rval(e);
    return ctx.stored(ctx.rval(e), e);
  }
  /** the receiver, made unique and checked to be a var, for a method that changes it */
  const mut = recvE => { if (!recvE) fail('cannot use mutating member on immutable value: function call returns immutable value'); return ctx.lvalue(recvE, 'mutating'); };
  const setStr = (recvE, s) => { ctx.checkMutable(recvE); ctx.assignTo(recvE, s, null); };

  function intMember(v, name, args, e) {
    const x = typeof v === 'bigint' ? v : v.v, T = typeof v === 'bigint' ? 'Int' : v.t;
    const mk = r => (T === 'Int' ? r : new SNum(T, r));
    const prop = !args;
    switch (name) {
      case 'description': return String(x);
      case 'magnitude': return T === 'Int' ? new SNum('UInt', x < 0n ? -x : x) : mk(x < 0n ? -x : x);
      case 'nonzeroBitCount': return BigInt([...BigInt.asUintN(64, x).toString(2)].filter(c => c === '1').length);
      case 'leadingZeroBitCount': { const bits = INT_KINDS[T] ? INT_KINDS[T][0] : 64; const s = BigInt.asUintN(bits, x).toString(2); return BigInt(x === 0n ? bits : bits - s.length); }
      case 'trailingZeroBitCount': { if (x === 0n) return 64n; let n = 0n, y = BigInt.asUintN(64, x); while (!(y & 1n)) { y >>= 1n; n++; } return n; }
      case 'bitWidth': return BigInt(INT_KINDS[T] ? INT_KINDS[T][0] : 64);
      case 'words': return arrOf([x]);
    }
    if (prop) {
      if (['isMultiple', 'signum', 'quotientAndRemainder', 'advanced', 'distance', 'addingReportingOverflow', 'multipliedReportingOverflow'].includes(name)) return new SFn({ name, native: a => intMember(v, name, a, e) });
      fail(`value of type '${T}' has no member '${name}'`);
    }
    switch (name) {
      case 'isMultiple': { const d = toBig(lbl(args, 0, 'of')); return d === 0n ? x === 0n : x % d === 0n; }
      case 'signum': noArgs(args); return mk(x > 0n ? 1n : x < 0n ? -1n : 0n);
      case 'quotientAndRemainder': { const d = toBig(lbl(args, 0, 'dividingBy')); if (d === 0n) trap('Division by zero'); return new STuple([mk(x / d), mk(x % d)], ['quotient', 'remainder']); }
      case 'advanced': return mk(x + toBig(lbl(args, 0, 'by')));
      case 'distance': return mk(toBig(lbl(args, 0, 'to')) - x);
      case 'addingReportingOverflow': { const r = x + toBig(args[0].v); return new STuple([mk(BigInt.asIntN(64, r)), r !== BigInt.asIntN(64, r)], ['partialValue', 'overflow']); }
      case 'multipliedReportingOverflow': { const r = x * toBig(lbl(args, 0, 'by')); return new STuple([mk(BigInt.asIntN(64, r)), r !== BigInt.asIntN(64, r)], ['partialValue', 'overflow']); }
    }
    fail(`value of type '${T}' has no member '${name}'`);
  }
  const toBig = v => (typeof v === 'bigint' ? v : v instanceof SNum ? v.v : fail(`cannot convert value of type '${typeName(v)}' to expected argument type 'Int'`));
  function dblMember(v, name, args, e) {
    const isF = v instanceof SNum, x = isF ? v.v : v;
    const mk = r => (isF ? new SNum('Float', Math.fround(r)) : r);
    switch (name) {
      case 'description': return describe(v);
      case 'isNaN': return Number.isNaN(x);
      case 'isInfinite': return !Number.isFinite(x) && !Number.isNaN(x);
      case 'isFinite': return Number.isFinite(x);
      case 'isZero': return x === 0;
      case 'magnitude': return mk(Math.abs(x));
      case 'sign': return new SImplicit(x < 0 || Object.is(x, -0) ? 'minus' : 'plus');
      case 'nextUp': { const b = new Float64Array([x]), u = new BigInt64Array(b.buffer); u[0] += x >= 0 ? 1n : -1n; return b[0]; }
      case 'ulp': return mk(Math.abs(x) * Number.EPSILON);
      case 'exponent': return BigInt(Math.floor(Math.log2(Math.abs(x))));
    }
    if (!args) {
      if (['rounded', 'squareRoot', 'truncatingRemainder', 'remainder', 'round', 'formTruncatingRemainder', 'isLess', 'addingProduct'].includes(name)) return new SFn({ name, native: a => dblMember(v, name, a, e) });
      fail(`value of type '${isF ? 'Float' : 'Double'}' has no member '${name}'`);
    }
    switch (name) {
      case 'rounded': {
        const rule = args.length ? args[0].v : null;
        const nm = rule instanceof SImplicit ? rule.name : rule === null ? 'toNearestOrAwayFromZero' : fail('no exact matches in call to instance method \'rounded\'');
        return mk(roundRule(x, nm));
      }
      case 'squareRoot': noArgs(args); return mk(Math.sqrt(x));
      case 'truncatingRemainder': return mk(x % toNum(lbl(args, 0, 'dividingBy')));
      case 'remainder': { const d = toNum(lbl(args, 0, 'dividingBy')); return mk(x - d * Math.round(x / d)); }
      case 'isLess': return x < toNum(lbl(args, 0, 'than'));
      case 'addingProduct': return mk(x + toNum(args[0].v) * toNum(args[1].v));
    }
    fail(`value of type '${isF ? 'Float' : 'Double'}' has no member '${name}'`);
  }
  function roundRule(x, nm) {
    switch (nm) {
      case 'toNearestOrAwayFromZero': return x < 0 ? -Math.round(-x) : Math.round(x);
      case 'toNearestOrEven': { const r = Math.round(x); return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r; }
      case 'up': return Math.ceil(x);
      case 'down': return Math.floor(x);
      case 'towardZero': return Math.trunc(x);
      case 'awayFromZero': return x < 0 ? Math.floor(x) : Math.ceil(x);
    }
    fail(`type 'FloatingPointRoundingRule' has no member '${nm}'`);
  }
  /* -- Character -- */
  const isLetter = c => /^\p{L}/u.test(c);
  function charMember(v, name, args, e) {
    const c = v.c;
    const cp = c.codePointAt(0);
    switch (name) {
      case 'isLetter': return isLetter(c);
      case 'isNumber': return /^\p{N}/u.test(c);
      case 'isWholeNumber': return /^\p{Nd}$/u.test(c) || /^[\u2150-\u218f]$/u.test(c);
      case 'wholeNumberValue': return /^\p{Nd}$/u.test(c) ? new Some(BigInt(parseInt(c.normalize('NFKD'), 10) || +c || 0)) : null;
      case 'isHexDigit': return /^[0-9a-fA-F]$/.test(c);
      case 'hexDigitValue': return /^[0-9a-fA-F]$/.test(c) ? new Some(BigInt(parseInt(c, 16))) : null;
      case 'isUppercase': return c !== c.toLowerCase() && c === c.toUpperCase();
      case 'isLowercase': return c !== c.toUpperCase() && c === c.toLowerCase();
      case 'isCased': return c.toUpperCase() !== c.toLowerCase();
      case 'isWhitespace': return /^\s+$/u.test(c);
      case 'isNewline': return /^[\n\r\u000b\u000c\u0085\u2028\u2029]|^\r\n$/.test(c);
      case 'isPunctuation': return /^\p{P}/u.test(c);
      case 'isSymbol': return /^\p{S}/u.test(c);
      case 'isMathSymbol': return /^\p{Sm}/u.test(c);
      case 'isASCII': return cp < 128 && c.length === 1;
      case 'isAlphanumeric': fail(`value of type 'Character' has no member 'isAlphanumeric'`); break;
      case 'asciiValue': return cp < 128 && (c.length === 1 || c === '\r\n') ? new Some(new SNum('UInt8', BigInt(c === '\r\n' ? 10 : cp))) : null;
      case 'description': return c;
      case 'unicodeScalars': return arrOf(Array.from(c).map(x => new SNum('Unicode.Scalar', BigInt(x.codePointAt(0)))));
      case 'utf8': return arrOf([...new TextEncoder().encode(c)].map(b => new SNum('UInt8', BigInt(b))));
    }
    if (!args) {
      if (['uppercased', 'lowercased'].includes(name)) return new SFn({ name, native: a => charMember(v, name, a, e) });
      fail(`value of type 'Character' has no member '${name}'`);
    }
    switch (name) {
      case 'uppercased': noArgs(args); return c.toUpperCase();
      case 'lowercased': noArgs(args); return c.toLowerCase();
    }
    fail(`value of type 'Character' has no member '${name}'`);
  }
  /* -- String -- */
  const charArr = s => chars(s).map(CH);
  const asChar = (v, what) => (v instanceof SChar ? v.c : typeof v === 'string' ? v : fail(`cannot convert value of type '${typeName(v)}' to expected argument type '${what || 'Character'}'`));
  const ws = new Set([' ', '\t', '\n', '\r', '\u000b', '\u000c', '\u0085', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000']);
  function charSet(v) {
    const n = v instanceof SImplicit ? v.name : fail('no exact matches in call to instance method');
    switch (n) {
      case 'whitespaces': return c => c === ' ' || c === '\t' || /^[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$/.test(c);
      case 'whitespacesAndNewlines': return c => ws.has(c) || /^[\u2000-\u200a]$/.test(c) || c === '\r\n';
      case 'newlines': return c => /^[\n\r\u000b\u000c\u0085\u2028\u2029]$/.test(c) || c === '\r\n';
      case 'punctuationCharacters': return c => /^\p{P}$/u.test(c);
      case 'letters': return c => /^\p{L}/u.test(c);
      case 'decimalDigits': return c => /^\p{Nd}$/u.test(c);
      case 'alphanumerics': return c => /^[\p{L}\p{N}]/u.test(c);
      case 'uppercaseLetters': return c => /^\p{Lu}/u.test(c);
      case 'lowercaseLetters': return c => /^\p{Ll}/u.test(c);
      case 'symbols': return c => /^\p{S}/u.test(c);
    }
    fail(`type 'CharacterSet' has no member '${n}'`);
  }
  const needFoundation = (name, T) => { if (!ctx.hasFoundation()) fail(`value of type '${T}' has no member '${name}'`); };
  function strMember(s, name, args, e, recvE) {
    switch (name) {
      case 'count': if (args) break; return BigInt(charCount(s));
      case 'isEmpty': if (args) break; return s.length === 0;
      case 'first': if (args) break; { const cs = chars(s); return cs.length ? new Some(CH(cs[0])) : null; }
      case 'last': if (args) break; { const cs = chars(s); return cs.length ? new Some(CH(cs[cs.length - 1])) : null; }
      case 'startIndex': return new SIdx(0);
      case 'endIndex': return new SIdx(charCount(s));
      case 'indices': return arrOf(chars(s).map((_, k) => new SIdx(k)));
      case 'description': return s;
      case 'utf8': return arrOf([...new TextEncoder().encode(s)].map(b => new SNum('UInt8', BigInt(b))));
      case 'utf16': return arrOf(Array.from({ length: s.length }, (_, k) => new SNum('UInt16', BigInt(s.charCodeAt(k)))));
      case 'unicodeScalars': return arrOf(Array.from(s).map(x => new SNum('Unicode.Scalar', BigInt(x.codePointAt(0)))));
      case 'capitalized': needFoundation(name, 'String'); return s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
      case 'lazy': return arrOf(charArr(s));
    }
    if (!args) return new SFn({ name, native: a => strMember(s, name, a, e, recvE) });
    const cs = () => chars(s);
    switch (name) {
      case 'uppercased': noArgs(args); return s.toUpperCase();
      case 'lowercased': noArgs(args); return s.toLowerCase();
      case 'hasPrefix': return s.startsWith(lbl(args, 0, null));
      case 'hasSuffix': return s.endsWith(lbl(args, 0, null));
      case 'contains': {
        if (args[0].label === 'where') return cs().some(c => bool(callF(args[0].v, CH(c))));
        const x = lbl(args, 0, null);
        if (x instanceof SChar) return cs().includes(x.c);
        if (typeof x === 'string') { if (!ctx.hasFoundation() && false) fail(''); return s.includes(x); }
        fail(`cannot convert value of type '${typeName(x)}' to expected argument type 'Character'`);
      }
      case 'append': {
        const x = args[0].label === 'contentsOf' ? args[0].v : lbl(args, 0, null);
        setStr(recvE, s + asChar(x, 'String'));
        return VOID;
      }
      case 'insert': { const c = asChar(lbl(args, 0, null)), at = lbl(args, 1, 'at'); const a = cs(); if (!(at instanceof SIdx) || at.i > a.length) trap('String index is out of bounds'); a.splice(at.i, 0, c); setStr(recvE, a.join('')); return VOID; }
      case 'remove': { const at = lbl(args, 0, 'at'); const a = cs(); if (!(at instanceof SIdx) || at.i >= a.length) trap('String index is out of bounds'); const [c] = a.splice(at.i, 1); setStr(recvE, a.join('')); return CH(c); }
      case 'removeLast': case 'removeFirst': {
        const a = cs();
        const k = args.length ? Number(toInt(args[0].v)) : null;
        if (k === null) { if (!a.length) trap(`Can't remove ${name === 'removeLast' ? 'last' : 'first'} element from an empty collection`); const c = name === 'removeLast' ? a.pop() : a.shift(); setStr(recvE, a.join('')); return CH(c); }
        if (k > a.length) trap(`Can't remove more items from a collection than it contains`);
        setStr(recvE, (name === 'removeLast' ? a.slice(0, a.length - k) : a.slice(k)).join('')); return VOID;
      }
      case 'popLast': { const a = cs(); if (!a.length) return null; const c = a.pop(); setStr(recvE, a.join('')); return new Some(CH(c)); }
      case 'removeAll': { if (args.length && args[0].label === 'where') { const f = args[0].v; setStr(recvE, cs().filter(c => !bool(callF(f, CH(c)))).join('')); return VOID; } setStr(recvE, ''); return VOID; }
      case 'reverse': setStr(recvE, cs().reverse().join('')); return VOID;
      case 'reversed': { const r = arrOf(charArr(s).reverse(), { n: 'Character' }); r.reversedString = true; return r; }
      case 'split': return splitStr(s, args);
      case 'components': { needFoundation('components', 'String'); const sep = lbl(args, 0, 'separatedBy'); if (sep instanceof SImplicit) { const f = charSet(sep); const out = []; let cur = ''; for (const c of cs()) { if (f(c)) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return arrOf(out, { n: 'String' }); } return arrOf(s.split(asChar(sep, 'String')), { n: 'String' }); }
      case 'trimmingCharacters': { needFoundation(name, 'String'); const f = charSet(lbl(args, 0, 'in')); const a = cs(); let i = 0, j = a.length; while (i < j && f(a[i])) i++; while (j > i && f(a[j - 1])) j--; return a.slice(i, j).join(''); }
      case 'replacingOccurrences': { needFoundation(name, 'String'); const of = lbl(args, 0, 'of'), w = lbl(args, 1, 'with'); return asChar(of, 'String') === '' ? s : s.split(asChar(of, 'String')).join(asChar(w, 'String')); }
      case 'replacing': { const of = lbl(args, 0, null), w = lbl(args, 1, 'with'); return s.split(asChar(of, 'String')).join(asChar(w, 'String')); }
      case 'prefix': { if (args[0].label === 'while') { const a = cs(); let k = 0; while (k < a.length && bool(callF(args[0].v, CH(a[k])))) k++; return a.slice(0, k).join(''); } const n = Number(toInt(lbl(args, 0, null))); if (n < 0) trap("Can't take a prefix of negative length from a collection"); return cs().slice(0, n).join(''); }
      case 'suffix': { const n = Number(toInt(lbl(args, 0, null))); if (n < 0) trap("Can't take a suffix of negative length from a collection"); const a = cs(); return a.slice(Math.max(0, a.length - n)).join(''); }
      case 'dropFirst': { const n = args.length ? Number(toInt(args[0].v)) : 1; if (n < 0) trap("Can't drop a prefix of negative length from a collection"); return cs().slice(n).join(''); }
      case 'dropLast': { const n = args.length ? Number(toInt(args[0].v)) : 1; if (n < 0) trap("Can't drop a suffix of negative length from a collection"); const a = cs(); return a.slice(0, Math.max(0, a.length - n)).join(''); }
      case 'index': {
        const i = args[0].label ? null : lbl(args, 0, null);
        if (args[1] && args[1].label === 'offsetBy') { const k = i.i + Number(toInt(args[1].v)); if (k < 0 || k > charCount(s)) trap('String index is out of bounds'); if (args[2] && args[2].label === 'limitedBy') { const lim = args[2].v.i; if ((Number(toInt(args[1].v)) >= 0 && k > lim) || (Number(toInt(args[1].v)) < 0 && k < lim)) return null; return new Some(new SIdx(k)); } return new SIdx(k); }
        if (args[0].label === 'after') { const k = args[0].v.i + 1; if (k > charCount(s)) trap('String index is out of bounds'); return new SIdx(k); }
        if (args[0].label === 'before') { const k = args[0].v.i - 1; if (k < 0) trap('String index is out of bounds'); return new SIdx(k); }
        fail('no exact matches in call to instance method \'index\'');
      }
      case 'distance': return BigInt(lbl(args, 1, 'to').i - lbl(args, 0, 'from').i);
      case 'firstIndex': case 'lastIndex': {
        const a = cs();
        const f = args[0].label === 'where' ? c => bool(callF(args[0].v, CH(c))) : (x => c => c === x)(asChar(lbl(args, 0, 'of')));
        if (name === 'firstIndex') { const k = a.findIndex(f); return k < 0 ? null : new Some(new SIdx(k)); }
        for (let k = a.length - 1; k >= 0; k--) if (f(a[k])) return new Some(new SIdx(k));
        return null;
      }
      case 'range': { needFoundation(name, 'String'); const of = asChar(lbl(args, 0, 'of'), 'String'); const a = cs(); const k = a.join('').indexOf(of); if (k < 0) return null; const lo = chars(s.slice(0, k)).length; return new Some(new SRange(new SIdx(lo), new SIdx(lo + charCount(of)), false)); }
      case 'starts': return s.startsWith(asChar(lbl(args, 0, 'with'), 'String'));
      case 'padding': { needFoundation(name, 'String'); const n = Number(toInt(lbl(args, 0, 'toLength'))), p = asChar(lbl(args, 1, 'withPad'), 'String'); const a = cs(); if (a.length >= n) return a.slice(0, n).join(''); let out = s; while (charCount(out) < n) out += p; return chars(out).slice(0, n).join(''); }
      case 'joined': fail(`value of type 'String' has no member 'joined'`); break;
      case 'filter': return cs().filter(c => bool(callF(args[0].v, CH(c)))).join('');
      case 'map': case 'compactMap': case 'flatMap': case 'forEach': case 'reduce': case 'sorted': case 'enumerated': case 'allSatisfy': case 'min': case 'max': case 'count': case 'shuffled': case 'randomElement': case 'elementsEqual': case 'zip': case 'firstIndexWhere':
        return arrMember(new SArr(charArr(s), { n: 'Character' }), name, args, e, null);
      case 'lowercase': break;
    }
    fail(`value of type 'String' has no member '${name}'`);
  }
  function splitStr(s, args) {
    let maxSplits = Infinity, omit = true, f;
    for (const a of args) {
      if (a.label === 'separator') { const sep = a.v; if (typeof sep === 'string' && charCount(sep) !== 1) { const parts = s.split(sep); return arrOf(omit ? parts.filter(Boolean) : parts, { n: 'String' }); } const c = asChar(sep); f = x => x === c; }
      else if (a.label === 'maxSplits') maxSplits = Number(toInt(a.v));
      else if (a.label === 'omittingEmptySubsequences') omit = a.v;
      else if (a.label === 'whereSeparator' || a.label === null && a.v instanceof SFn) { const g = a.v; f = x => bool(callF(g, CH(x))); }
      else if (a.label === null) { const c = asChar(a.v); f = x => x === c; }
      else fail(`extraneous argument label '${a.label}:' in call`);
    }
    const out = [];
    let cur = '', n = 0;
    for (const c of chars(s)) {
      if (n < maxSplits && f(c)) { if (cur || !omit) { out.push(cur); n++; } cur = ''; continue; }
      cur += c;
    }
    if (cur || !omit) out.push(cur);
    return arrOf(out, { n: 'String' });
  }
  /* -- Array -- */
  function arrMember(arr, name, args, e, recvE) {
    const a = arr.a;
    if (!a.length) ctx.setNilType(elemType(arr));
    switch (name) {
      case 'count': if (args) break; return BigInt(a.length);
      case 'isEmpty': if (args) break; return a.length === 0;
      case 'first': if (args) break; return opt(a[0]);
      case 'last': if (args) break; return opt(a.length ? a[a.length - 1] : undefined);
      case 'indices': return new SRange(BigInt(arr.off), BigInt(arr.off + a.length), false);
      case 'startIndex': return BigInt(arr.off);
      case 'endIndex': return BigInt(arr.off + a.length);
      case 'capacity': return BigInt(a.length);
      case 'description': return describe(arr);
      case 'lazy': return arr;
    }
    if (!args) return new SFn({ name, native: x => arrMember(arr, name, x, e, recvE) });
    const f0 = () => args[0].v;
    switch (name) {
      case 'append': {
        const me = mut(recvE);
        if (args[0].label === 'contentsOf') { for (const x of seqItems(args[0].v)) me.a.push(ctx.conv(share(x), elemType(me), null, 'argument')); return VOID; }
        argc(args, 1);
        me.a.push(ctx.conv(lbl(args, 0, null), elemType(me), args[0].e, 'argument'));
        return VOID;
      }
      case 'insert': {
        const me = mut(recvE);
        const at = Number(toInt(lbl(args, 1, 'at'))) - me.off;
        if (at < 0 || at > me.a.length) trap('Array index is out of range');
        if (args[0].label === 'contentsOf') me.a.splice(at, 0, ...seqItems(args[0].v).map(share));
        else me.a.splice(at, 0, ctx.conv(lbl(args, 0, null), elemType(me), args[0].e, 'argument'));
        return VOID;
      }
      case 'remove': { const me = mut(recvE); const k = Number(toInt(lbl(args, 0, 'at'))) - me.off; if (k < 0 || k >= me.a.length) trap('Index out of range'); return me.a.splice(k, 1)[0]; }
      case 'removeLast': case 'removeFirst': {
        const me = mut(recvE);
        if (!args.length) { if (!me.a.length) trap(`Can't remove ${name === 'removeLast' ? 'last' : 'first'} element from an empty collection`); return name === 'removeLast' ? me.a.pop() : me.a.shift(); }
        const k = Number(toInt(args[0].v));
        if (k < 0) trap(`Number of elements to remove should be non-negative`);
        if (k > me.a.length) trap(`Can't remove more items from a collection than it ${name === 'removeLast' ? 'contains' : 'has'}`);
        if (name === 'removeLast') me.a.splice(me.a.length - k, k); else me.a.splice(0, k);
        return VOID;
      }
      case 'popLast': { const me = mut(recvE); return me.a.length ? new Some(me.a.pop()) : null; }
      case 'popFirst': fail(`value of type '${typeName(arr)}' has no member 'popFirst'`); break;
      case 'removeAll': {
        const me = mut(recvE);
        if (args.length && args[0].label === 'where') { const f = args[0].v; me.a = me.a.filter(x => !bool(callF(f, x))); return VOID; }
        me.a.length = 0; return VOID;
      }
      case 'removeSubrange': { const me = mut(recvE); const [lo, hi] = rangeBounds(args[0].v, me.a.length); if (lo < 0 || hi > me.a.length) trap('Array replace: subrange extends past the end'); me.a.splice(lo, hi - lo); return VOID; }
      case 'replaceSubrange': { const me = mut(recvE); const [lo, hi] = rangeBounds(args[0].v, me.a.length); me.a.splice(lo, hi - lo, ...seqItems(lbl(args, 1, 'with')).map(share)); return VOID; }
      case 'swapAt': { const me = mut(recvE); const i = arrIndex(me, toInt(args[0].v)), j = arrIndex(me, toInt(args[1].v)); [me.a[i], me.a[j]] = [me.a[j], me.a[i]]; return VOID; }
      case 'reverse': { const me = mut(recvE); me.a.reverse(); return VOID; }
      case 'sort': {
        const me = mut(recvE);
        const by = args.length ? lbl(args, 0, 'by') : null;
        me.a = by ? sortWith(me.a, lt(by)) : natural(me.a);
        return VOID;
      }
      case 'shuffle': { const me = mut(recvE); for (let k = me.a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [me.a[k], me.a[j]] = [me.a[j], me.a[k]]; } return VOID; }
      case 'reserveCapacity': mut(recvE); return VOID;
      case 'sorted': { const by = args.length ? lbl(args, 0, 'by') : null; return arrOf(by ? sortWith(a, lt(by)) : natural(a), arr.et); }
      case 'reversed': { const r = arrOf(a.slice().reverse(), arr.et); r.revOf = arr; return r; }
      case 'shuffled': { const b = a.slice(); for (let k = b.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [b[k], b[j]] = [b[j], b[k]]; } return arrOf(b, arr.et); }
      case 'randomElement': return a.length ? new Some(a[Math.floor(Math.random() * a.length)]) : null;
      case 'contains': {
        if (args[0].label === 'where') return a.some(x => bool(callF(f0(), x)));
        const x = lbl(args, 0, null);
        return a.some(y => ctx.eqVals(y, x, null));
      }
      case 'allSatisfy': return a.every(x => bool(callF(f0(), x)));
      case 'firstIndex': case 'lastIndex': case 'first': case 'last': {
        const pred = args[0].label === 'where' ? x => bool(callF(args[0].v, x)) : (y => x => ctx.eqVals(x, y, null))(lbl(args, 0, 'of'));
        if (name === 'first' || name === 'last') { if (args[0].label !== 'where') fail(`incorrect argument label in call (have '${args[0].label}:', expected 'where:')`); }
        if (name === 'firstIndex' || name === 'first') { const k = a.findIndex(pred); return k < 0 ? null : new Some(name === 'first' ? a[k] : BigInt(k + arr.off)); }
        for (let k = a.length - 1; k >= 0; k--) if (pred(a[k])) return new Some(name === 'last' ? a[k] : BigInt(k + arr.off));
        return null;
      }
      case 'min': case 'max': {
        if (!a.length) return null;
        const less = args.length ? lt(lbl(args, 0, 'by')) : (x, y) => compare(x, y) < 0;
        let best = a[0];
        for (const x of a.slice(1)) if (name === 'min' ? less(x, best) : !less(x, best)) best = x;
        return new Some(best);
      }
      case 'map': return arrOf(a.map(x => callF(f0(), x)));
      case 'compactMap': return arrOf(a.map(x => callF(f0(), x)).filter(x => x !== null).map(x => (x instanceof Some ? x.v : x)));
      case 'flatMap': return arrOf(a.flatMap(x => { const r = callF(f0(), x); return r instanceof Some ? [r.v] : r === null ? [] : seqItems(r); }));
      case 'filter': return arrOf(a.filter(x => bool(callF(f0(), x))), arr.et);
      case 'forEach': for (const x of a.slice()) callF(f0(), x); return VOID;
      case 'reduce': {
        if (args[0].label === 'into') {
          let acc = share(args[0].v);
          const f = args[1].v;
          for (const x of a) { const r = invokeInout(f, acc, x); acc = r; }
          return acc;
        }
        let acc = args[0].v;
        if (typeof acc === 'bigint' && a.length && typeof a[0] === 'number' && args[0].e && isLit(args[0].e)) acc = Number(acc);
        for (const x of a) acc = callF(args[1].v, acc, x);
        return acc;
      }
      case 'enumerated': return arrOf(a.map((x, k) => new STuple([BigInt(k), share(x)], ['offset', 'element'])));
      case 'joined': {
        const sep = args.length ? lbl(args, 0, 'separator') : '';
        if (a.every(x => typeof x === 'string')) return a.join(sep);
        if (a.every(x => x instanceof SArr) && !args.length) return arrOf(a.flatMap(x => x.a));
        if (a.every(x => x instanceof SArr) && args.length) { const out = []; a.forEach((x, k) => { if (k) out.push(...seqItems(sep)); out.push(...x.a); }); return arrOf(out); }
        fail(`referencing instance method 'joined(separator:)' on 'Sequence' requires that '${typeName(a[0])}' conform to 'StringProtocol'`);
      }
      case 'prefix': { if (args[0].label === 'while') { let k = 0; while (k < a.length && bool(callF(args[0].v, a[k]))) k++; return slice(a.slice(0, k), arr, 0); } const n = Number(toInt(lbl(args, 0, null))); if (n < 0) trap("Can't take a prefix of negative length from a collection"); return slice(a.slice(0, n), arr, 0); }
      case 'suffix': { const n = Number(toInt(lbl(args, 0, null))); if (n < 0) trap("Can't take a suffix of negative length from a collection"); return slice(a.slice(Math.max(0, a.length - n)), arr, Math.max(0, a.length - n)); }
      case 'dropFirst': { const n = args.length ? Number(toInt(args[0].v)) : 1; if (n < 0) trap("Can't drop a prefix of negative length from a collection"); return slice(a.slice(n), arr, Math.min(n, a.length)); }
      case 'dropLast': { const n = args.length ? Number(toInt(args[0].v)) : 1; if (n < 0) trap("Can't drop a suffix of negative length from a collection"); return slice(a.slice(0, Math.max(0, a.length - n)), arr, 0); }
      case 'starts': { const p = seqItems(lbl(args, 0, 'with')); return p.length <= a.length && p.every((x, k) => ctx.eqVals(x, a[k], null)); }
      case 'elementsEqual': { const p = seqItems(lbl(args, 0, null)); return p.length === a.length && p.every((x, k) => ctx.eqVals(x, a[k], null)); }
      case 'count': if (args[0].label === 'where') return BigInt(a.filter(x => bool(callF(args[0].v, x))).length); break;
      case 'split': { const sep = args[0].label === 'separator' ? args[0].v : null, f = args[0].label === 'whereSeparator' ? args[0].v : null; const out = []; let cur = []; for (const x of a) { if (f ? bool(callF(f, x)) : ctx.eqVals(x, sep, null)) { if (cur.length) out.push(slice(cur, arr, 0)); cur = []; } else cur.push(x); } if (cur.length) out.push(slice(cur, arr, 0)); return arrOf(out); }
      case 'index': { const i = Number(toInt(lbl(args, 0, null))); if (args[1].label === 'offsetBy') return BigInt(i + Number(toInt(args[1].v))); fail('no exact matches in call to instance method \'index\''); }
      case 'difference': fail('difference(from:) is not supported here');
      case 'firstIndexWhere': break;
      case 'zip': break;
    }
    fail(`value of type '${typeName(arr)}' has no member '${name}'`);
  }
  /** reduce(into:)'s closure changes its first argument in place */
  function invokeInout(f, acc, x) {
    if (!(f instanceof SFn) || f.native) { callF(f, acc, x); return acc; }
    const ps = f.params || [];
    const fake = new SFn({ ...f, params: ps.length ? ps.map((p, k) => (k === 0 ? { ...p, type: { n: 'Any', inout: true } } : p)) : ps });
    // the closure's first parameter ($0 or a name) is inout: run it with a mutable binding and take what it left there
    const holder = { v: acc };
    const r = invoke(new SFn({ ...fake, inoutFirst: holder }), [acc, x], null);
    void r;
    return holder.v;
  }
  /* -- Dictionary -- */
  function dictMember(d, name, args, e, recvE) {
    const es = () => [...d.m.values()];
    switch (name) {
      case 'count': if (args) break; return BigInt(d.m.size);
      case 'isEmpty': if (args) break; return d.m.size === 0;
      case 'keys': { const s = arrOf(es().map(([k]) => k), d.kt); s.keysOf = true; return s; }
      case 'values': return arrOf(es().map(([, v]) => v), d.vt);
      case 'first': if (args) break; { const x = es()[0]; return x ? new Some(new STuple([x[0], share(x[1])], ['key', 'value'])) : null; }
      case 'description': return describe(d);
    }
    if (!args) return new SFn({ name, native: x => dictMember(d, name, x, e, recvE) });
    const pairs = () => es().map(([k, v]) => new STuple([k, share(v)], ['key', 'value']));
    switch (name) {
      case 'removeValue': { const me = mut(recvE); const key = hashKey(lbl(args, 0, 'forKey')); const en = me.m.get(key); if (!en) return null; me.m.delete(key); return new Some(en[1]); }
      case 'updateValue': { const me = mut(recvE); const v = lbl(args, 0, null), k = lbl(args, 1, 'forKey'); const key = hashKey(k); const en = me.m.get(key); me.m.set(key, [en ? en[0] : k, me.vt ? ctx.conv(v, me.vt, null, 'argument') : v]); return en ? new Some(en[1]) : null; }
      case 'removeAll': { const me = mut(recvE); if (args.length && args[0].label === 'where') { for (const [key, [k, v]] of [...me.m]) if (bool(callF(args[0].v, new STuple([k, v], ['key', 'value'])))) me.m.delete(key); return VOID; } me.m.clear(); return VOID; }
      case 'merge': { const me = mut(recvE); const other = args[0].v, f = args[1].v; for (const p of seqItems(other)) { const [k, v] = p.a; const key = hashKey(k); me.m.set(key, me.m.has(key) ? [me.m.get(key)[0], callF(f, me.m.get(key)[1], v)] : [k, share(v)]); } return VOID; }
      case 'merging': { const out = new SDict(d.kt, d.vt); for (const [k, v] of d.m) out.m.set(k, [v[0], share(v[1])]); const f = args[1].v; for (const p of seqItems(args[0].v)) { const [k, v] = p.a; const key = hashKey(k); out.m.set(key, out.m.has(key) ? [out.m.get(key)[0], callF(f, out.m.get(key)[1], v)] : [k, share(v)]); } return out; }
      case 'mapValues': { const out = new SDict(d.kt, null); for (const [key, [k, v]] of d.m) out.m.set(key, [k, callF(args[0].v, v)]); return out; }
      case 'compactMapValues': { const out = new SDict(d.kt, null); for (const [key, [k, v]] of d.m) { const r = callF(args[0].v, v); if (r !== null) out.m.set(key, [k, r instanceof Some ? r.v : r]); } return out; }
      case 'filter': { const out = new SDict(d.kt, d.vt); for (const [key, [k, v]] of d.m) if (bool(callF(args[0].v, new STuple([k, v], ['key', 'value'])))) out.m.set(key, [k, share(v)]); return out; }
      case 'contains': if (args[0].label === 'where') return pairs().some(p => bool(callF(args[0].v, p))); break;
      case 'index': break;
      case 'sorted': case 'map': case 'compactMap': case 'flatMap': case 'forEach': case 'reduce': case 'min': case 'max': case 'allSatisfy': case 'enumerated': case 'first': case 'count': case 'randomElement':
        return arrMember(new SArr(pairs()), name, args, e, null);
    }
    fail(`value of type '${typeName(d)}' has no member '${name}'`);
  }
  /* -- Set -- */
  function setMember(s, name, args, e, recvE) {
    const vs = () => [...s.m.values()];
    switch (name) {
      case 'count': if (args) break; return BigInt(s.m.size);
      case 'isEmpty': if (args) break; return s.m.size === 0;
      case 'first': if (args) break; return opt(vs()[0]);
      case 'description': return describe(s);
    }
    if (!args) return new SFn({ name, native: x => setMember(s, name, x, e, recvE) });
    const other = () => { const o = args[0].v; return o instanceof SSet ? o : toSet(new SArr(seqItems(o)), s.et); };
    const mk = keys => { const out = new SSet(s.et); for (const k of keys) out.m.set(k, s.m.get(k) ?? other().m.get(k)); return out; };
    switch (name) {
      case 'insert': { const me = mut(recvE); const x = ctx.conv(lbl(args, 0, null), me.et, args[0].e, 'argument'); const key = hashKey(x); if (me.m.has(key)) return new STuple([false, me.m.get(key)], ['inserted', 'memberAfterInsert']); me.m.set(key, x); return new STuple([true, x], ['inserted', 'memberAfterInsert']); }
      case 'remove': { const me = mut(recvE); const key = hashKey(lbl(args, 0, null)); if (!me.m.has(key)) return null; const x = me.m.get(key); me.m.delete(key); return new Some(x); }
      case 'removeAll': { const me = mut(recvE); if (args.length && args[0].label === 'where') { for (const [k, x] of [...me.m]) if (bool(callF(args[0].v, x))) me.m.delete(k); return VOID; } me.m.clear(); return VOID; }
      case 'removeFirst': { const me = mut(recvE); if (!me.m.size) trap("Can't removeFirst from an empty Set"); const [k, x] = me.m.entries().next().value; me.m.delete(k); return x; }
      case 'popFirst': { const me = mut(recvE); if (!me.m.size) return null; const [k, x] = me.m.entries().next().value; me.m.delete(k); return new Some(x); }
      case 'contains': if (args[0].label === 'where') return vs().some(x => bool(callF(args[0].v, x))); return s.m.has(hashKey(lbl(args, 0, null)));
      case 'union': { const o = other(); const out = new SSet(s.et); for (const [k, x] of s.m) out.m.set(k, x); for (const [k, x] of o.m) if (!out.m.has(k)) out.m.set(k, x); return out; }
      case 'intersection': { const o = other(); return mk([...s.m.keys()].filter(k => o.m.has(k))); }
      case 'subtracting': { const o = other(); return mk([...s.m.keys()].filter(k => !o.m.has(k))); }
      case 'symmetricDifference': { const o = other(); const out = mk([...s.m.keys()].filter(k => !o.m.has(k))); for (const [k, x] of o.m) if (!s.m.has(k)) out.m.set(k, x); return out; }
      case 'formUnion': { const me = mut(recvE); for (const [k, x] of other().m) if (!me.m.has(k)) me.m.set(k, x); return VOID; }
      case 'formIntersection': { const me = mut(recvE); const o = other(); for (const k of [...me.m.keys()]) if (!o.m.has(k)) me.m.delete(k); return VOID; }
      case 'subtract': { const me = mut(recvE); for (const k of other().m.keys()) me.m.delete(k); return VOID; }
      case 'formSymmetricDifference': { const me = mut(recvE); for (const [k, x] of other().m) { if (me.m.has(k)) me.m.delete(k); else me.m.set(k, x); } return VOID; }
      case 'isSubset': { const o = other(); return [...s.m.keys()].every(k => o.m.has(k)); }
      case 'isSuperset': { const o = other(); return [...o.m.keys()].every(k => s.m.has(k)); }
      case 'isStrictSubset': { const o = other(); return s.m.size < o.m.size && [...s.m.keys()].every(k => o.m.has(k)); }
      case 'isStrictSuperset': { const o = other(); return s.m.size > o.m.size && [...o.m.keys()].every(k => s.m.has(k)); }
      case 'isDisjoint': { const o = other(); return ![...s.m.keys()].some(k => o.m.has(k)); }
      case 'filter': { const out = new SSet(s.et); for (const [k, x] of s.m) if (bool(callF(args[0].v, x))) out.m.set(k, x); return out; }
      case 'sorted': case 'map': case 'compactMap': case 'flatMap': case 'forEach': case 'reduce': case 'min': case 'max': case 'allSatisfy': case 'enumerated': case 'first': case 'count': case 'randomElement': case 'reversed': case 'joined':
        return arrMember(new SArr(vs(), s.et), name, args, e, null);
    }
    fail(`value of type '${typeName(s)}' has no member '${name}'`);
  }
  /* -- ranges -- */
  function rangeMember(r, name, args, e) {
    switch (name) {
      case 'lowerBound': return r.lo;
      case 'upperBound': return r.hi;
      case 'count': if (args) break; if (typeof r.lo !== 'bigint') fail(`referencing property 'count' on 'ClosedRange' requires that '${typeName(r.lo)}' conform to 'Strideable'`); { const n = r.hi - r.lo + (r.closed ? 1n : 0n); return n < 0n ? 0n : n; }
      case 'isEmpty': if (args) break; return r.closed ? false : compare(r.lo, r.hi) === 0;
      case 'first': if (args) break; return r.closed || compare(r.lo, r.hi) < 0 ? new Some(r.lo) : null;
      case 'last': if (args) break; return r.closed ? new Some(r.hi) : compare(r.lo, r.hi) < 0 ? new Some(r.hi - 1n) : null;
      case 'description': return describe(r);
    }
    if (!args) return new SFn({ name, native: x => rangeMember(r, name, x, e) });
    switch (name) {
      case 'contains': if (args[0].label !== 'where') return rangeContains(r, typeof r.lo === 'number' ? (typeof args[0].v === 'bigint' && isLit(args[0].e) ? Number(args[0].v) : args[0].v) : args[0].v); break;
      case 'clamped': { const o = lbl(args, 0, 'to'); const lo = compare(r.lo, o.lo) < 0 ? o.lo : r.lo, hi = compare(r.hi, o.hi) > 0 ? o.hi : r.hi; return new SRange(lo, hi, r.closed); }
      case 'overlaps': { const o = args[0].v; return compare(r.lo, o.hi) < (o.closed ? 1 : 0) && compare(o.lo, r.hi) < (r.closed ? 1 : 0); }
    }
    return arrMember(new SArr(seqItems(r), { n: typeName(r.lo) }), name, args, e, null);
  }

  return {
    intKind, numOp, numNeg, describe, debugDescribe, hashKey, compare, items, toSet, charCount, subGet, subSet, dictGet, arrIndex, patternMatch, rangeContains, iterate,
    member, callMethod, construct, hasGlobal, callGlobal, staticMember, format, callF,
  };
}

export { SVal, SObj, SEnum, isVal };
