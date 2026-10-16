/**
 * Java values as the interpreter holds them:
 *   int, short, byte  a JavaScript number          long     a BigInt
 *   double, float     a Num (f: it is a float)      char     a one-character JavaScript string
 *   boolean           true / false                  null     null
 *   String            a JStr (string literals are interned, so == between them is true, as in Java)
 *   Integer, Double…  a Box (Integer.valueOf caches -128…127, so == between boxes works as in Java)
 *   an object         a JObj (its class, its fields)      an array  a JArr (its element type, its items)
 *   a lambda          a JFn                               the library's objects: classes of ./lib.js
 */
export class Num { constructor(v, f = false) { this.v = f ? Math.fround(v) : v; this.f = f; } }
export class JStr { constructor(s) { this.s = s; } }
export class Box { constructor(k, v) { this.k = k; this.v = v; } }
export class JObj { constructor(cls) { this.cls = cls; this.f = new Map(); } }
export class JArr { constructor(et, a) { this.et = et; this.a = a; } }
export class JFn { constructor(o) { Object.assign(this, o); } }

/** The kind of a value: int, long, double, float, char, boolean, null, or ref (anything on the heap) */
export const kindOf = v => (typeof v === 'number' ? 'int' : typeof v === 'bigint' ? 'long' : v instanceof Num ? (v.f ? 'float' : 'double')
  : typeof v === 'string' ? 'char' : typeof v === 'boolean' ? 'boolean' : v === null ? 'null' : 'ref');
export const isPrim = v => kindOf(v) !== 'ref' && v !== null;

/** Double.toString and Float.toString: the shortest digits that read back the same, 1.0, 0.1, 1.0E10, 1.0E-5, NaN, Infinity */
export function javaDouble(v, isFloat = false) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  let digits, exp;
  if (isFloat) {                                    // the fewest digits that make the same float
    let p = 1;
    for (; p < 9; p++) if (Math.fround(parseFloat(v.toPrecision(p))) === v) break;
    [digits, exp] = parseFloat(v.toPrecision(p)).toExponential().split('e');
  } else [digits, exp] = v.toExponential().split('e');
  const neg = digits.startsWith('-'), d = digits.replace('-', '').replace('.', ''), e = +exp;
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e-3 && abs < 1e7) {
    if (e >= 0) s = (d.slice(0, e + 1).padEnd(e + 1, '0')) + '.' + (d.slice(e + 1) || '0');
    else s = '0.' + '0'.repeat(-e - 1) + d;
  } else s = d[0] + '.' + (d.slice(1) || '0') + 'E' + e;
  return (neg ? '-' : '') + s;
}

/** String.hashCode: s[0]*31^(n-1) + … in int arithmetic */
export function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }
