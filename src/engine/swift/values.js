/**
 * Swift values as the interpreter holds them. Int is a BigInt (64 bits, checked), Double a JavaScript number, other
 * number types (UInt8, Int32, Float…) an SNum, Bool, String and nil (null) themselves, a Character an SChar (one per
 * text, so == works), an Optional that holds a value a Some. Arrays (SArr), dictionaries (SDict), sets (SSet), tuples
 * (STuple), struct values (SVal) and Somes are value types: `sh` marks one that more than one place holds, and the place
 * that changes it copies it first (copy on write), so Swift's value semantics hold. Class instances (SObj) are shared.
 */
export class Some { constructor(v) { this.v = v; this.sh = false; } }
export class SChar { constructor(c) { this.c = c; } }
const CHARS = new Map();
export const CH = c => { let x = CHARS.get(c); if (!x) { x = new SChar(c); CHARS.set(c, x); } return x; };
export class SNum { constructor(t, v) { this.t = t; this.v = v; } }
export class SArr { constructor(a, et = null) { this.a = a; this.et = et; this.sh = false; this.off = 0; } }
export class SDict { constructor(kt = null, vt = null) { this.m = new Map(); this.kt = kt; this.vt = vt; this.sh = false; } }
export class SSet { constructor(et = null) { this.m = new Map(); this.et = et; this.sh = false; } }
export class STuple { constructor(a, labels = null) { this.a = a; this.labels = labels; this.sh = false; } }
export class SVal { constructor(T) { this.T = T; this.f = new Map(); this.sh = false; } }
export class SObj { constructor(T) { this.T = T; this.f = new Map(); } }
export class SEnum { constructor(T, c, p = null) { this.T = T; this.c = c; this.p = p; } }
export class SFn { constructor(o) { Object.assign(this, o); } }
export class SRange { constructor(lo, hi, closed) { this.lo = lo; this.hi = hi; this.closed = closed; } }
export class SStride { constructor(from, to, by, through) { this.from = from; this.to = to; this.by = by; this.through = through; } }
/** a String.Index: the position of a Character */
export class SIdx { constructor(i) { this.i = i; } }
/** a type used as a value (Int.self, or a name like Int before .max) */
export class SType { constructor(t) { this.t = t; } }
/** .member with no type to look it up in yet (.whitespaces, .down): the library knows what it means */
export class SImplicit { constructor(name) { this.name = name; } }
export const UNSET = Symbol('unset');
export const VOID = Object.freeze({ void: true });

export const INT_KINDS = { Int8: [8, true], Int16: [16, true], Int32: [32, true], Int64: [64, true], UInt: [64, false], UInt8: [8, false], UInt16: [16, false], UInt32: [32, false], UInt64: [64, false] };

/** is it a value of a value type that copy on write applies to */
export const isVal = v => v instanceof SArr || v instanceof SDict || v instanceof SSet || v instanceof STuple || v instanceof SVal || v instanceof Some;
/** marks a value that is now held by one more place */
export function share(v) { if (isVal(v)) v.sh = true; return v; }
/** a copy of a shared value, for the place about to change it (what it holds is shared by both now) */
export function copyVal(v) {
  if (v instanceof SArr) { const c = new SArr(v.a.map(share), v.et); c.off = v.off; return c; }
  if (v instanceof SDict) { const c = new SDict(v.kt, v.vt); for (const [k, [a, b]] of v.m) c.m.set(k, [a, share(b)]); return c; }
  if (v instanceof SSet) { const c = new SSet(v.et); for (const [k, x] of v.m) c.m.set(k, x); return c; }
  if (v instanceof STuple) return new STuple(v.a.map(share), v.labels);
  if (v instanceof SVal) { const c = new SVal(v.T); for (const [k, x] of v.f) c.f.set(k, share(x)); return c; }
  if (v instanceof Some) return new Some(share(v.v));
  return v;
}

/** Swift's description of a Double: the shortest digits that read back the same, with an exponent below 1e-4 or above
 * 2^53 (2^24 for a Float), where whole numbers stop being exact */
export function swiftDouble(x, float = false) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  let digits, exp;
  if (float) {
    let p = 1;
    for (; p < 10; p++) if (Math.fround(+x.toPrecision(p)) === x) break;
    [digits, exp] = x.toExponential(p - 1).split('e');
  } else [digits, exp] = x.toExponential().split('e');
  const neg = digits[0] === '-';
  if (neg) digits = digits.slice(1);
  let e = +exp;
  const ds = digits.replace('.', '');
  let out;
  if (e < -4 || Math.abs(x) > (float ? 2 ** 24 : 2 ** 53)) {
    out = ds[0] + (ds.length > 1 ? '.' + ds.slice(1) : '') + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
  } else if (e < 0) out = '0.' + '0'.repeat(-e - 1) + ds;
  else if (ds.length <= e + 1) out = ds + '0'.repeat(e + 1 - ds.length) + '.0';
  else out = ds.slice(0, e + 1) + '.' + ds.slice(e + 1);
  return (neg ? '-' : '') + out;
}

/** the Characters of a String (extended grapheme clusters) */
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
export function chars(s) {
  if (!/[^\x00-\x7f]/.test(s)) { const out = s.split(''); return joinCrLf(out); }
  if (SEG) return Array.from(SEG.segment(s), x => x.segment);
  return joinCrLf(Array.from(s));
}
function joinCrLf(a) { for (let k = 0; k < a.length - 1; k++) if (a[k] === '\r' && a[k + 1] === '\n') a.splice(k, 2, '\r\n'); return a; }
export const charCount = s => (/[^\x00-\x7f]/.test(s) ? chars(s).length : joinCrLf(s.split('')).length);
