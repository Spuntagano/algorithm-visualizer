/**
 * The Java interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and
 * before each test of a loop), in the format of src/model.js. Values are described in ./values.js; the library
 * (collections, strings, Math, System.out…) is ./lib.js.
 *
 * Java's rules are kept where programs can see them: int and long overflow, integer division, char arithmetic,
 * string identity (== versus equals), the Integer cache, HashMap's iteration order, the order in which constructors
 * and field initializers run, and Java's exceptions (with its helpful NullPointerException messages).
 *
 * runJavaTrace(source) returns { steps, logs, error }, or throws an Error ("line N: …") for a syntax error.
 */
import { parseJava, PRIMS } from './parse.js';
import { Box, JArr, JFn, JObj, JStr, Num, javaDouble, kindOf, strHash } from './values.js';
import { makeLib } from './lib.js';

const MAX_STEPS = 3000;   // stop runaway loops
const MAX_CALLS = 300;    // stop runaway recursion
const MAX_DEPTH = 5;      // how deeply nested values are expanded
const MAX_ITEMS = 60;     // array / list elements kept per container

class StopRun extends Error {}
class ExitRun extends Error {}
/** A Java exception in flight */
class Thrown extends Error { constructor(obj) { super('a Java exception'); this.obj = obj; } }
/** What javac would refuse, met while running: "Error on line N: …" */
class JError extends Error {}
const UNSET = Symbol('not assigned yet');
const BREAK = 'break', CONTINUE = 'continue';

const WRAPPER = { int: 'Integer', long: 'Long', double: 'Double', float: 'Float', char: 'Character', boolean: 'Boolean', short: 'Short', byte: 'Byte' };
const UNWRAP = Object.fromEntries(Object.entries(WRAPPER).map(([k, v]) => [v, k]));
/** Java's own exceptions: name → [the one it extends, its package] */
const EXCEPTIONS = {
  Throwable: [null, 'java.lang'], Exception: ['Throwable', 'java.lang'], Error: ['Throwable', 'java.lang'], RuntimeException: ['Exception', 'java.lang'],
  ArithmeticException: ['RuntimeException', 'java.lang'], NullPointerException: ['RuntimeException', 'java.lang'],
  IndexOutOfBoundsException: ['RuntimeException', 'java.lang'], ArrayIndexOutOfBoundsException: ['IndexOutOfBoundsException', 'java.lang'],
  StringIndexOutOfBoundsException: ['IndexOutOfBoundsException', 'java.lang'], ClassCastException: ['RuntimeException', 'java.lang'],
  IllegalArgumentException: ['RuntimeException', 'java.lang'], NumberFormatException: ['IllegalArgumentException', 'java.lang'],
  IllegalStateException: ['RuntimeException', 'java.lang'], UnsupportedOperationException: ['RuntimeException', 'java.lang'],
  NegativeArraySizeException: ['RuntimeException', 'java.lang'], ArrayStoreException: ['RuntimeException', 'java.lang'],
  StackOverflowError: ['Error', 'java.lang'], OutOfMemoryError: ['Error', 'java.lang'], AssertionError: ['Error', 'java.lang'],
  CloneNotSupportedException: ['Exception', 'java.lang'], InterruptedException: ['Exception', 'java.lang'],
  NoSuchElementException: ['RuntimeException', 'java.util'], ConcurrentModificationException: ['RuntimeException', 'java.util'],
  EmptyStackException: ['RuntimeException', 'java.util'], InputMismatchException: ['NoSuchElementException', 'java.util'],
  IOException: ['Exception', 'java.io'], FileNotFoundException: ['IOException', 'java.io'], UncheckedIOException: ['RuntimeException', 'java.io'],
};

export function runJavaTrace(src) {
  const prog = parseJava(src);
  const steps = [], logs = [], stack = [], frames = [];
  const rets = {}; let calls = 0;   // every call's frame gets an id; rets: what the call returned, by that id
  let line = 0, stopped = null, outBuf = '', errBuf = '', finalVars = null;
  const fail = msg => { throw new JError(msg); };

  /* ---- output ---- */
  const write = (s, err) => {
    if (err) { errBuf += s; let k; while ((k = errBuf.indexOf('\n')) >= 0) { logs.push({ type: 'error', s: errBuf.slice(0, k) }); errBuf = errBuf.slice(k + 1); } return; }
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k) }); outBuf = outBuf.slice(k + 1); }
  };

  /* ---- classes ---- */
  const classes = new Map();                       // name (simple, and Outer.Inner) → class
  /** A class at run time: its declaration, superclass, interfaces, members, static fields */
  function makeClass(decl, outer, env = null) {
    const c = {
      name: decl.name, decl, kind: decl.kind, outer, env, sup: null, ifaces: [], fields: [], methods: new Map(), ctors: [], statics: new Map(),
      inits: [], staticInits: [], ready: false, isAbstract: !!decl.isAbstract, isInterface: decl.kind === 'interface', isStatic: decl.isStatic || decl.kind !== 'class' || !outer,
      enumValues: null, comps: decl.comps || null, builtin: false,
    };
    for (const m of decl.members.flatMap(x => (x.k === 'fields' ? x.list : [x]))) {
      if (m.k === 'field') { if (m.isStatic) c.staticInits.push(m); else { c.fields.push(m); c.inits.push(m); } }
      else if (m.k === 'method') { const list = c.methods.get(m.name) || []; list.push({ ...m, owner: c }); c.methods.set(m.name, list); }
      else if (m.k === 'ctor') c.ctors.push({ ...m, owner: c, name: decl.name });
      else if (m.k === 'init') (m.isStatic ? c.staticInits : c.inits).push(m);
      else if (m.k === 'class') { const inner = makeClass(m, c); register(inner, c.name + '.' + m.name); }
    }
    if (c.comps) for (const p of c.comps) { c.fields.push({ name: p.name, type: p.type, k: 'field', line: decl.line }); if (!c.methods.has(p.name)) c.methods.set(p.name, [{ k: 'method', name: p.name, params: [], ret: p.type, native: self => self.f.get(p.name), owner: c }]); }
    return c;
  }
  function register(c, qual) {
    if (classes.has(c.name) && classes.get(c.name) !== c && !classes.get(c.name).builtin) { /* the same simple name twice: only Outer.Inner finds the second */ }
    else classes.set(c.name, c);
    if (qual) classes.set(qual, c);
  }
  /** Superclasses and interfaces, once every class is known */
  function link(c) {
    const d = c.decl;
    if (d.ext) c.sup = classFor(d.ext.name, d.line, true);
    else if (c.kind === 'enum' || c.kind === 'record' || !c.isInterface) c.sup = c.kind === 'class' && !EXCEPTIONS[c.name] ? null : null;
    c.ifaces = (d.impls || []).map(t => classFor(t.name, d.line, false)).filter(Boolean);
    if (c.sup && c.sup.isInterface) fail(`${c.name} extends ${c.sup.name}, which is an interface (use implements)`);
  }
  const classFor = (name, l, required) => {
    const c = classes.get(name);
    if (c) return c;
    if (EXCEPTIONS[name]) return builtinException(name);
    if (required && !lib.knows(name)) { line = l; fail(`cannot find symbol: class ${name}`); }
    return null;
  };
  /** The class of one of Java's exceptions, made when first needed, so programs can extend and catch them */
  function builtinException(name) {
    if (classes.has(name)) return classes.get(name);
    const [sup, pkg] = EXCEPTIONS[name];
    const c = { name, kind: 'class', builtin: true, pkg, sup: sup ? builtinException(sup) : null, ifaces: [], fields: [], methods: new Map(), ctors: [],
      statics: new Map(), inits: [], staticInits: [], ready: true, isAbstract: false, isInterface: false, isStatic: true, decl: { members: [] } };
    classes.set(name, c);
    return c;
  }
  const isThrowable = c => { for (let x = c; x; x = x.sup) if (x.name === 'Throwable' && x.builtin) return true; return false; };
  /** Is class c the class t, or does it extend or implement it? */
  function subclass(c, t) {
    if (!c) return false;
    if (c === t) return true;
    if (subclass(c.sup, t)) return true;
    return c.ifaces.some(i => subclass(i, t));
  }
  /** Static fields get their first values when the class is first used, as in Java */
  function initClass(c) {
    if (c.ready) return;
    c.ready = true;
    if (c.sup) initClass(c.sup);
    for (const m of c.staticInits) {
      if (m.k === 'field') c.statics.set(m.name, { v: defaultOf(m.type), type: m.type });
    }
    if (c.kind === 'enum') {
      c.enumValues = c.decl.enumConsts.map((ec, ord) => {
        line = ec.line;
        const cls = ec.body ? anonClass(ec, c, ec.body) : c;
        const o = construct(cls, ec.args.map(a => rval(a)), ec.line, { enumName: ec.name, ordinal: ord });
        c.statics.set(ec.name, { v: o, type: { name: c.name, dims: 0 }, enumConst: true });
        return o;
      });
    }
    for (const m of c.staticInits) {
      line = m.line;
      withFrame({ name: c.name + '.<clinit>', cls: c, self: null, hidden: true }, () => {
        if (m.k === 'field' && m.init) c.statics.get(m.name).v = coerce(m.init.k === 'arrayInit' ? arrayFrom(m.init, m.type) : rval(m.init), m.type, m.name);
        else if (m.k === 'init') execBody(m.body);
      });
    }
  }
  const anonClasses = new WeakMap();
  /** new Comparator<T>() { … }, an enum constant with a body: a class made on the spot */
  function anonClass(n, base, members) {
    let c = anonClasses.get(n);
    if (!c) {
      const decl = { k: 'class', kind: 'class', name: base.name, members, line: n.line, ext: null, impls: [], isStatic: true, enumConsts: [] };
      c = makeClass(decl, frame() ? frame().cls : null);
      c.anon = true;
      if (base.isInterface) c.ifaces = [base]; else c.sup = base;
      c.ready = true;
      anonClasses.set(n, c);
    }
    return c;
  }

  /* ---- values ---- */
  const interned = new Map();
  const str = s => { let v = interned.get(s); if (!v) { v = new JStr(s); interned.set(s, v); } return v; };
  const jstr = s => new JStr(s);
  const intCache = new Map(), charCache = new Map(), longCache = new Map();
  const TRUE = new Box('Boolean', true), FALSE = new Box('Boolean', false);
  /** Autoboxing: Integer.valueOf (and Long, Character…) with their caches */
  function box(v) {
    switch (kindOf(v)) {
      case 'int': { if (v >= -128 && v <= 127) { let b = intCache.get(v); if (!b) intCache.set(v, b = new Box('Integer', v)); return b; } return new Box('Integer', v); }
      case 'long': { if (v >= -128n && v <= 127n) { let b = longCache.get(v); if (!b) longCache.set(v, b = new Box('Long', v)); return b; } return new Box('Long', v); }
      case 'char': { const c = v.charCodeAt(0); if (c < 128) { let b = charCache.get(v); if (!b) charCache.set(v, b = new Box('Character', v)); return b; } return new Box('Character', v); }
      case 'boolean': return v ? TRUE : FALSE;
      case 'double': case 'float': return new Box(v.f ? 'Float' : 'Double', v);
      default: return v;
    }
  }
  /** Unboxing: a primitive (a null Integer is a NullPointerException) */
  const unbox = (v, what) => {
    if (v instanceof Box) return v.v;
    if (v === null) throwJava('NullPointerException', `Cannot unbox ${what || 'the value'} because it is null`);
    return v;
  };
  const defaultOf = t => {
    if (!t || t.dims) return null;
    switch (t.name) {
      case 'int': case 'short': case 'byte': return 0;
      case 'long': return 0n;
      case 'double': return new Num(0);
      case 'float': return new Num(0, true);
      case 'char': return '\0';
      case 'boolean': return false;
      default: return null;
    }
  };
  const typeLabel = t => (t ? t.name + (t.args && t.args.length ? '<' + t.args.map(typeLabel).join(', ') + '>' : '') + '[]'.repeat(t.dims || 0) : '?');
  /** The type of a value, as Java writes it */
  function typeOfValue(v) {
    const k = kindOf(v);
    if (k !== 'ref') return k;
    if (v instanceof JStr) return 'String';
    if (v instanceof Box) return v.k;
    if (v instanceof JArr) return typeLabel(v.et) + '[]';
    if (v instanceof JObj) return v.cls.name;
    if (v instanceof JFn) return 'lambda';
    return lib.className(v);
  }
  const art = n => (/^[aeiouAEIOU]/.test(n) ? 'an ' : 'a ') + n;

  /** Java's assignment conversions: widening, boxing and unboxing; what javac refuses is an error */
  function coerce(v, t, what) {
    if (!t || t.name === 'var') return v;
    const k = kindOf(v), d = what ? ` (${what})` : '';
    if (t.dims) {
      if (v === null || v instanceof JArr) return v;
      fail(`incompatible types${d}: ${typeOfValue(v)} cannot be converted to ${typeLabel(t)}`);
    }
    if (PRIMS.has(t.name)) {
      const x = v instanceof Box ? unbox(v) : v === null ? throwJava('NullPointerException', `Cannot unbox ${what || 'a null value'} (it is null) to ${t.name}`) : v;
      const xk = kindOf(x);
      const bad = () => fail(`incompatible types${d}: ${xk === 'ref' ? typeOfValue(x) : xk} cannot be converted to ${t.name}` +
        (['int', 'long', 'char', 'short', 'byte', 'float'].includes(t.name) && ['double', 'float', 'long'].includes(xk) ? ` (a possible loss of precision: write (${t.name}) to convert)` : ''));
      switch (t.name) {
        case 'int': if (xk === 'int') return x; if (xk === 'char') return x.charCodeAt(0); return bad();
        case 'short': if (xk === 'int') return (x << 16) >> 16; if (xk === 'char') return (x.charCodeAt(0) << 16) >> 16; return bad();
        case 'byte': if (xk === 'int') return (x << 24) >> 24; return bad();
        case 'long': if (xk === 'long') return x; if (xk === 'int') return BigInt(x); if (xk === 'char') return BigInt(x.charCodeAt(0)); return bad();
        case 'double': if (xk === 'double') return x; if (xk === 'float') return new Num(x.v); if (xk === 'int') return new Num(x); if (xk === 'long') return new Num(Number(x)); if (xk === 'char') return new Num(x.charCodeAt(0)); return bad();
        case 'float': if (xk === 'float') return x; if (xk === 'int') return new Num(x, true); if (xk === 'long') return new Num(Number(x), true); if (xk === 'char') return new Num(x.charCodeAt(0), true); return bad();
        case 'char': if (xk === 'char') return x; if (xk === 'int' && x >= 0 && x <= 0xffff) return String.fromCharCode(x); return bad();
        case 'boolean': if (xk === 'boolean') return x; return bad();
      }
    }
    if (k !== 'ref' && k !== 'null') {                 // boxing into Integer, Object, a type parameter…
      const want = UNWRAP[t.name];
      if (want && want !== k && !(want === 'double' && k === 'int' && false)) {
        if (want === 'long' && k === 'int') fail(`incompatible types${d}: int cannot be converted to Long (write ${what ? '' : ''}a long: 5L)`);
        fail(`incompatible types${d}: ${k} cannot be converted to ${t.name}`);
      }
      if (t.name === 'String') fail(`incompatible types${d}: ${k} cannot be converted to String (use String.valueOf(…) or "" + …)`);
      return box(v);
    }
    if (v === null) return v;
    if (t.name === 'String' && !(v instanceof JStr)) fail(`incompatible types${d}: ${typeOfValue(v)} cannot be converted to String`);
    if (UNWRAP[t.name] && v instanceof Box && v.k !== t.name) fail(`incompatible types${d}: ${v.k} cannot be converted to ${t.name}`);
    const c = classes.get(t.name);
    if (c && !c.builtin && v instanceof JObj && !subclass(v.cls, c)) fail(`incompatible types${d}: ${v.cls.name} cannot be converted to ${t.name}`);
    if (c && !c.builtin && (v instanceof JStr || v instanceof Box || v instanceof JArr)) fail(`incompatible types${d}: ${typeOfValue(v)} cannot be converted to ${t.name}`);
    return v;
  }
  /** An explicit cast: (int) 3.9 is 3, (char) 66 is 'B', (byte) 200 is -56, (Dog) animal checks */
  function castTo(t, v, d) {
    if (t.dims || !PRIMS.has(t.name)) {
      if (v === null) return null;
      if (kindOf(v) !== 'ref') return coerce(v, t, d);
      const c = classes.get(t.name);
      if (c && !c.builtin && v instanceof JObj && !subclass(v.cls, c)) throwJava('ClassCastException', `class ${v.cls.name} cannot be cast to class ${c.name}`);
      if (t.name === 'String' && !(v instanceof JStr)) throwJava('ClassCastException', `class ${typeOfValue(v)} cannot be cast to class java.lang.String`);
      if (UNWRAP[t.name] && !(v instanceof Box && v.k === t.name)) throwJava('ClassCastException', `class ${typeOfValue(v)} cannot be cast to class java.lang.${t.name}`);
      return v;
    }
    const x = unbox(v, d), k = kindOf(x);
    if (t.name === 'boolean') { if (k !== 'boolean') fail(`incompatible types: ${k} cannot be converted to boolean`); return x; }
    if (k === 'boolean') fail(`incompatible types: boolean cannot be converted to ${t.name}`);
    const n = k === 'char' ? x.charCodeAt(0) : k === 'long' ? x : k === 'int' ? x : x.v;
    switch (t.name) {
      case 'int': return typeof n === 'bigint' ? Number(BigInt.asIntN(32, n)) : typeof n === 'number' && !Number.isInteger(n) || Math.abs(n) > 2147483647 ? toIntSat(n, 32) : n | 0;
      case 'long': return typeof n === 'bigint' ? n : Number.isInteger(n) && Math.abs(n) < 2 ** 53 ? BigInt(n) : BigInt(toIntSat(n, 64));
      case 'short': return (Number(typeof n === 'bigint' ? BigInt.asIntN(32, n) : toIntSat(n, 32)) << 16) >> 16;
      case 'byte': return (Number(typeof n === 'bigint' ? BigInt.asIntN(32, n) : toIntSat(n, 32)) << 24) >> 24;
      case 'char': return String.fromCharCode(Number(typeof n === 'bigint' ? BigInt.asUintN(16, n) : toIntSat(n, 32) & 0xffff));
      case 'double': return new Num(Number(n));
      case 'float': return new Num(Number(n), true);
    }
    return x;
  }
  /** (int) of a double: toward zero, NaN is 0, and too big is the biggest (Java saturates) */
  function toIntSat(n, bits) {
    if (Number.isNaN(n)) return bits === 64 ? 0n : 0;
    const t = Math.trunc(n);
    if (bits === 64) { if (t >= 9223372036854775807) return 9223372036854775807n; if (t <= -9223372036854775808) return -9223372036854775808n; return BigInt(t); }
    return t >= 2147483647 ? 2147483647 : t <= -2147483648 ? -2147483648 : t;
  }

  /* ---- exceptions ---- */
  /** Throws one of Java's exceptions */
  function throwJava(name, msg) {
    const c = builtinException(name), o = new JObj(c);
    o.f.set('message', msg == null ? null : jstr(msg));
    o.f.set('cause', null);
    o.line = line;
    throw new Thrown(o);
  }
  const npe = (what, because) => throwJava('NullPointerException', `Cannot ${what} because ${because} is null`);
  const javaName = c => (c.builtin ? c.pkg + '.' + c.name : c.name);
  const exceptionText = o => { const m = o.f.get('message'); return javaName(o.cls) + (m ? ': ' + m.s : ''); };

  /* ---- arithmetic ---- */
  /** Binary numeric promotion: the kind both sides are computed in */
  function promote(ka, kb) {
    if (ka === 'double' || kb === 'double') return 'double';
    if (ka === 'float' || kb === 'float') return 'float';
    if (ka === 'long' || kb === 'long') return 'long';
    return 'int';
  }
  const asKind = (x, k) => {
    const xk = kindOf(x);
    const n = xk === 'char' ? x.charCodeAt(0) : xk === 'double' || xk === 'float' ? x.v : x;
    if (k === 'long') return typeof n === 'bigint' ? n : BigInt(n);
    if (k === 'double' || k === 'float') return Number(n);
    return n;
  };
  const NUMERIC = new Set(['int', 'long', 'double', 'float', 'char']);
  function binop(op, a, b, e) {
    if (op === '+' && (a instanceof JStr || b instanceof JStr)) return jstr(toStr(a) + toStr(b));
    if (op === '==' || op === '!=') {
      const eq = sameValue(a, b);
      return op === '==' ? eq : !eq;
    }
    const x = a instanceof Box ? a.v : a, y = b instanceof Box ? b.v : b;
    if (x === null || y === null) throwJava('NullPointerException', `Cannot use ${op} on null` + (e ? ` (${srcText(e)})` : ''));
    const ka = kindOf(x), kb = kindOf(y);
    if (ka === 'boolean' && kb === 'boolean') {
      if (op === '&') return x && y; if (op === '|') return x || y; if (op === '^') return x !== y;
      fail(`bad operand types for ${op}: boolean and boolean`);
    }
    if (!NUMERIC.has(ka) || !NUMERIC.has(kb)) fail(`bad operand types for ${op}: ${typeOfValue(a)} and ${typeOfValue(b)}` + (op === '-' && (a instanceof JStr) ? '' : ''));
    if (op === '<<' || op === '>>' || op === '>>>') {
      const k = ka === 'long' ? 'long' : 'int', v = asKind(x, k), n = Number(asKind(y, 'long') & (k === 'long' ? 63n : 31n));
      if (k === 'long') return op === '<<' ? BigInt.asIntN(64, v << BigInt(n)) : op === '>>' ? v >> BigInt(n) : BigInt.asIntN(64, BigInt.asUintN(64, v) >> BigInt(n));
      return op === '<<' ? v << n : op === '>>' ? v >> n : (v >>> n) | 0;
    }
    const k = promote(ka, kb), p = asKind(x, k), q = asKind(y, k);
    switch (op) {
      case '<': return p < q; case '>': return p > q; case '<=': return p <= q; case '>=': return p >= q;
    }
    if (k === 'double' || k === 'float') {
      let r;
      switch (op) {
        case '+': r = p + q; break; case '-': r = p - q; break; case '*': r = p * q; break; case '/': r = p / q; break;
        case '%': r = p % q; break;
        default: fail(`bad operand types for ${op}: ${k} and ${k}`);
      }
      return new Num(r, k === 'float');
    }
    if ((op === '/' || op === '%') && (q === 0 || q === 0n)) throwJava('ArithmeticException', '/ by zero');
    if (k === 'long') {
      let r;
      switch (op) {
        case '+': r = p + q; break; case '-': r = p - q; break; case '*': r = p * q; break; case '/': r = p / q; break;
        case '%': r = p % q; break; case '&': r = p & q; break; case '|': r = p | q; break; case '^': r = p ^ q; break;
      }
      return BigInt.asIntN(64, r);
    }
    switch (op) {
      case '+': return (p + q) | 0; case '-': return (p - q) | 0; case '*': return Math.imul(p, q);
      case '/': return (p / q) | 0; case '%': return (p % q) | 0;
      case '&': return p & q; case '|': return p | q; case '^': return p ^ q;
    }
    fail('cannot apply ' + op);
  }
  /** == in Java: numbers by value, everything else (Strings, boxes, objects) by identity */
  function sameValue(a, b) {
    const pa = a !== null && kindOf(a) !== 'ref', pb = b !== null && kindOf(b) !== 'ref';
    if (pa || pb) {
      const x = pa ? a : unbox(a, 'a value'), y = pb ? b : unbox(b, 'a value');
      if (typeof x === 'boolean' || typeof y === 'boolean') return x === y;
      const k = promote(kindOf(x), kindOf(y));
      return asKind(x, k) === asKind(y, k);
    }
    return a === b;
  }
  const truthy = (v, what) => {
    const x = v instanceof Box ? v.v : v;
    if (typeof x !== 'boolean') fail(`incompatible types: ${typeOfValue(v)} cannot be converted to boolean${what ? ' (' + what + ')' : ''}`);
    return x;
  };

  /* ---- toString, equals, hashCode, compareTo (also for the library) ---- */
  const identity = new WeakMap();
  let nextHash = 0x1b6d3586;
  /** Object.hashCode: a number that stays the same for an object */
  const identityHash = o => { let h = identity.get(o); if (h == null) { nextHash = (Math.imul(nextHash ^ (nextHash >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0; h = nextHash & 0x7fffffff; identity.set(o, h); } return h; };
  function toStr(v) {
    const k = kindOf(v);
    switch (k) {
      case 'null': return 'null';
      case 'int': return String(v);
      case 'long': return String(v);
      case 'double': return javaDouble(v.v);
      case 'float': return javaDouble(v.v, true);
      case 'char': return v;
      case 'boolean': return String(v);
    }
    if (v instanceof JStr) return v.s;
    if (v instanceof Box) return toStr(v.v);
    if (v instanceof JArr) return '[' + ({ int: 'I', long: 'J', double: 'D', float: 'F', char: 'C', boolean: 'Z', byte: 'B', short: 'S' }[v.et.dims ? '' : v.et.name] || 'L' + v.et.name + ';') + '@' + identityHash(v).toString(16);
    if (v instanceof JObj) {
      const m = findMethod(v.cls, 'toString', [], true);
      if (m && !m.objectDefault) return toStr(invoke(m, v, []));
      return defaultToString(v);
    }
    if (v instanceof JFn) return 'Main$$Lambda@' + identityHash(v).toString(16);
    return lib.toStr(v);
  }
  function defaultToString(o) {
    const c = o.cls;
    if (c.kind === 'enum' || (c.sup && c.sup.kind === 'enum' && o.enumName)) return o.enumName;
    if (c.comps) return c.name + '[' + c.comps.map(p => p.name + '=' + toStr(o.f.get(p.name))).join(', ') + ']';
    if (isThrowable(c)) return exceptionText(o);
    return c.name + '@' + identityHash(o).toString(16);
  }
  function equalsV(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a instanceof JStr) return b instanceof JStr && a.s === b.s;
    if (a instanceof Box) return b instanceof Box && a.k === b.k && sameValue(a.v, b.v);
    if (kindOf(a) !== 'ref') return sameValue(a, b);
    if (a instanceof JObj) {
      const m = findMethod(a.cls, 'equals', [b], true);
      if (m && !m.objectDefault) return truthy(invoke(m, a, [b]));
      if (a.cls.comps && b instanceof JObj && b.cls === a.cls) return a.cls.comps.every(p => equalsV(a.f.get(p.name), b.f.get(p.name)));
      return false;
    }
    if (a instanceof JArr || a instanceof JFn) return false;
    return lib.equals(a, b);
  }
  function hashOf(v) {
    if (v === null) return 0;
    if (v instanceof JStr) return strHash(v.s);
    if (v instanceof Box) return hashOf(v.v);
    switch (kindOf(v)) {
      case 'int': return v;
      case 'long': return Number(BigInt.asIntN(32, v ^ (BigInt.asUintN(64, v) >> 32n)));
      case 'char': return v.charCodeAt(0);
      case 'boolean': return v ? 1231 : 1237;
      case 'double': case 'float': { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v.v); return dv.getInt32(0) ^ dv.getInt32(4); }
    }
    if (v instanceof JObj) {
      const m = findMethod(v.cls, 'hashCode', [], true);
      if (m && !m.objectDefault) return Number(unbox(invoke(m, v, [])));
      if (v.cls.comps) return v.cls.comps.reduce((h, p) => (Math.imul(h, 31) + hashOf(v.f.get(p.name))) | 0, 0);
      return identityHash(v);
    }
    if (v instanceof JArr || v instanceof JFn) return identityHash(v);
    return lib.hash(v);
  }
  /** Natural ordering (Comparable): numbers, strings, chars, booleans, enums, a class's compareTo */
  function compareV(a, b) {
    if (a === null || b === null) throwJava('NullPointerException', 'Cannot compare with null');
    if (a instanceof JStr && b instanceof JStr) {
      const n = Math.min(a.s.length, b.s.length);
      for (let k = 0; k < n; k++) if (a.s[k] !== b.s[k]) return a.s.charCodeAt(k) - b.s.charCodeAt(k);
      return a.s.length - b.s.length;
    }
    const x = a instanceof Box ? a.v : a, y = b instanceof Box ? b.v : b;
    if (kindOf(x) !== 'ref' && kindOf(y) !== 'ref') {
      if (typeof x === 'boolean') return x === y ? 0 : x ? 1 : -1;
      const k = promote(kindOf(x), kindOf(y)), p = asKind(x, k), q = asKind(y, k);
      return p < q ? -1 : p > q ? 1 : 0;
    }
    if (a instanceof JObj) {
      if (a.ordinal != null && b instanceof JObj && b.ordinal != null) return a.ordinal - b.ordinal;
      const m = findMethod(a.cls, 'compareTo', [b], true);
      if (m) return Number(unbox(invoke(m, a, [b])));
    }
    throwJava('ClassCastException', `class ${typeOfValue(a)} cannot be cast to class java.lang.Comparable (it has no compareTo: implement Comparable<${typeOfValue(a)}>, or give a Comparator)`);
  }
  /** Calls a lambda, a method reference, or an object implementing a functional interface (a Comparator…) */
  function callFn(f, args, methodName) {
    if (f === null) throwJava('NullPointerException', `Cannot invoke "${methodName || 'apply'}()" because the function is null`);
    if (f instanceof JFn) {
      if (f.native) return f.native(args);
      return callLambda(f, args);
    }
    if (f instanceof JObj) {
      const m = methodName ? findMethod(f.cls, methodName, args, false) : null;
      const target = m || singleMethod(f.cls);
      if (!target) fail(`${f.cls.name} has no method ${methodName || 'to call'}`);
      return invoke(target, f, args);
    }
    if (lib.isComparatorLike(f)) return lib.callComparator(f, args);
    fail(`${typeOfValue(f)} is not a function`);
  }
  /** The one method an object of a functional interface implements (for a Comparator: compare) */
  function singleMethod(c) {
    for (let x = c; x; x = x.sup) for (const list of x.methods.values()) for (const m of list) if (!m.isStatic && m.body && m.name !== 'toString' && m.name !== 'equals' && m.name !== 'hashCode') return m;
    return null;
  }

  /* ---- frames and names ---- */
  const frame = () => frames[frames.length - 1];
  /** A local variable, a captured one, or null */
  function localVar(name) {
    const f = frame();
    if (!f) return null;
    for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].get(name); if (r) return r; }
    for (const sc of f.env || []) { const r = sc.get(name); if (r) return r; }
    return null;
  }
  /** A field of an object (its class or a superclass), or null */
  const instField = (o, name) => (o.f.has(name) ? { o, name } : null);
  /** A static field visible from class c (its own, a superclass's, an enclosing class's) */
  function staticField(c, name) {
    for (let x = c; x; x = x.outer) {
      for (let y = x; y; y = y.sup) { initClass(y); if (y.statics.has(name)) return y.statics.get(name); for (const i of y.ifaces) { initClass(i); if (i.statics.has(name)) return i.statics.get(name); } }
    }
    return null;
  }
  /** What a simple name means here: a local, a field of this (or of the enclosing object), a static field */
  function resolveName(name) {
    const r = localVar(name);
    if (r) return { local: r };
    const f = frame();
    for (let self = f && f.self; self; self = self.outerSelf) {
      const fd = instField(self, name);
      if (fd) return { field: fd };
    }
    if (f && f.cls) { const st = staticField(f.cls, name); if (st) return { stat: st }; }
    return null;
  }

  /* ---- places (lvalues): get(), set(v), type ---- */
  function place(e) {
    switch (e.k) {
      case 'name': {
        const r = resolveName(e.name);
        if (!r) fail(`cannot find symbol: variable ${e.name}`);
        if (r.local) return { get: () => { if (r.local.v === UNSET) fail(`variable ${e.name} might not have been initialized`); return r.local.v; }, set: v => { r.local.v = v; }, type: r.local.type, d: e.name };
        if (r.field) { const { o, name } = r.field; return { get: () => o.f.get(name), set: v => o.f.set(name, v), type: fieldType(o.cls, name), d: e.name }; }
        return { get: () => r.stat.v, set: v => { if (r.stat.enumConst) fail(`cannot assign a value to final variable ${e.name}`); r.stat.v = v; }, type: r.stat.type, d: e.name };
      }
      case 'field': {
        const st = staticTarget(e.e);
        if (st && st.cls) { initClass(st.cls); const s = staticField(st.cls, e.name); if (!s) fail(`cannot find symbol: variable ${e.name} in class ${st.cls.name}`); return { get: () => s.v, set: v => { s.v = v; }, type: s.type, d: st.cls.name + '.' + e.name }; }
        const o = rval(e.e);
        if (o === null) npe(`assign field "${e.name}"`, `"${srcText(e.e)}"`);
        if (o instanceof JArr) { if (e.name === 'length') fail('cannot assign a value to final variable length'); }
        if (!(o instanceof JObj) || !o.f.has(e.name)) {
          if (o instanceof JObj) { const s = staticField(o.cls, e.name); if (s) return { get: () => s.v, set: v => { s.v = v; }, type: s.type, d: e.name }; }
          fail(`cannot find symbol: variable ${e.name}` + (o instanceof JObj ? ` in ${o.cls.name}` : ''));
        }
        return { get: () => o.f.get(e.name), set: v => o.f.set(e.name, v), type: fieldType(o.cls, e.name), d: srcText(e) };
      }
      case 'index': {
        const a = rval(e.a);
        const ix = unbox(rval(e.i), 'the index');
        if (a === null) npe('store to int array', `"${srcText(e.a)}"`);
        if (!(a instanceof JArr)) fail(`array required, but ${typeOfValue(a)} found` + (lib.isList(a) ? ` (a List is read with ${srcText(e.a)}.get(${srcText(e.i)}))` : ''));
        const k = kindOf(ix) === 'char' ? ix.charCodeAt(0) : ix;
        if (typeof k !== 'number') fail(`incompatible types: ${typeOfValue(ix)} cannot be converted to int (an index)`);
        const at = () => { if (k < 0 || k >= a.a.length) throwJava('ArrayIndexOutOfBoundsException', `Index ${k} out of bounds for length ${a.a.length}`); };
        return { get: () => { at(); return a.a[k]; }, set: v => { at(); a.a[k] = v; }, type: a.et, d: `${srcText(e.a)}[${k}]` };
      }
      case 'paren': return place(e.e);
      default: fail('unexpected type: required variable, found value');
    }
  }
  const fieldType = (c, name) => { for (let x = c; x; x = x.sup) { const f = x.fields.find(fd => fd.name === name); if (f) return f.type; } return null; };

  /* ---- expressions ---- */
  /** The source of an expression, for messages */
  const srcText = e => {
    switch (e.k) {
      case 'name': return e.name;
      case 'field': return srcText(e.e) + '.' + e.name;
      case 'call': return (e.target ? srcText(e.target) + '.' : '') + e.name + '(' + (e.args.length ? '…' : '') + ')';
      case 'index': return srcText(e.a) + '[' + srcText(e.i) + ']';
      case 'this': return 'this';
      case 'lit': return e.v === null ? 'null' : typeof e.v === 'object' && e.v && 's' in e.v ? JSON.stringify(e.v.s) : String(e.v && e.v.d != null ? e.v.d : e.v);
      case 'paren': return '(' + srcText(e.e) + ')';
      default: return 'the value';
    }
  };
  /** Is this expression a class name (for a static field or method)? { cls } or { lib: name } */
  function staticTarget(e) {
    const qual = x => (x.k === 'name' ? x.name : x.k === 'field' ? (qual(x.e) || '\0') + '.' + x.name : null);
    const q = e.k === 'field' ? qual(e) : null;
    if (q && /^javax?\./.test(q) && !resolveName('java')) {   // java.util.Arrays: the class Arrays
      const n = q.split('.').pop();
      if (lib.knows(n)) return { lib: n };
      if (EXCEPTIONS[n]) return { cls: builtinException(n) };
    }
    if (e.k === 'name' && !resolveName(e.name)) {
      const c = classes.get(e.name);
      if (c) return { cls: c };
      if (lib.knows(e.name)) return { lib: e.name };
      if (EXCEPTIONS[e.name]) return { cls: builtinException(e.name) };
    }
    if (e.k === 'field' && e.e.k === 'name' && classes.has(e.e.name + '.' + e.name) && !resolveName(e.e.name)) return { cls: classes.get(e.e.name + '.' + e.name) };
    if (e.k === 'typeRef') return { type: e.type };
    return null;
  }
  function rval(e) {
    switch (e.k) {
      case 'lit': {
        const v = e.v;
        if (v === null || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return v;
        if ('s' in v) return str(v.s);
        if ('c' in v) return v.c;
        return new Num(v.d, v.f);
      }
      case 'paren': return rval(e.e);
      case 'name': {
        const r = resolveName(e.name);
        if (r) return place(e).get();
        if (classes.has(e.name) || lib.knows(e.name)) fail(`${e.name} is a class: use ${e.name}.something`);
        fail(`cannot find symbol: variable ${e.name}`);
      }
      // falls through
      case 'field': {
        const st = staticTarget(e.e);
        if (st && st.lib) return lib.staticField(st.lib, e.name, e);
        if (st && st.cls) return place(e).get();
        const o = rval(e.e);
        if (o === null) npe(`read field "${e.name}"`, `"${srcText(e.e)}"`);
        if (o instanceof JArr && e.name === 'length') return o.a.length;
        if (o instanceof JObj && o.f.has(e.name)) return o.f.get(e.name);
        if (o instanceof JObj) { const s = staticField(o.cls, e.name); if (s) return s.v; }
        fail(`cannot find symbol: variable ${e.name}` + (o instanceof JObj ? ` in class ${o.cls.name}` : o instanceof JStr && e.name === 'length' ? ' (a String has length(): ' + srcText(e.e) + '.length())' : lib.isList(o) && e.name === 'length' ? ' (a List has size())' : ''));
      }
      // falls through
      case 'index': return place(e).get();
      case 'this': {
        const f = frame();
        if (!f || !f.self) fail('non-static variable this cannot be referenced from a static context');
        if (e.qual) { for (let s = f.self; s; s = s.outerSelf) if (s.cls.name === e.qual.name || subclass(s.cls, classes.get(e.qual.name))) return s; }
        return f.self;
      }
      case 'assign': {
        const p = place(e.l);
        if (e.op === '=') { const v = e.r.k === 'arrayInit' ? arrayFrom(e.r, p.type) : rval(e.r); const c = coerce(v, p.type, p.d); p.set(c); return c; }
        const cur = p.get(), r = rval(e.r);
        const res = binop(e.op.slice(0, -1), cur, r, e);
        const c = p.type && PRIMS.has(p.type.name) && !p.type.dims ? castTo(p.type, res) : res instanceof JStr ? res : coerce(res, p.type, p.d);   // x += 1.5 narrows, as in Java
        p.set(c);
        return c;
      }
      case 'pre': case 'post': {
        const p = place(e.e), cur = p.get();
        if (cur === null) npe(`${e.op} ${srcText(e.e)}`, `"${srcText(e.e)}"`);
        const nv = binop(e.op === '++' ? '+' : '-', cur, 1, e);
        const c = p.type && PRIMS.has(p.type.name) ? castTo(p.type, nv) : coerce(nv, p.type, p.d);
        p.set(c);
        return e.k === 'pre' ? c : cur;
      }
      case 'un': {
        const v = rval(e.e);
        if (e.op === '!') return !truthy(v, '!');
        const x = unbox(v, srcText(e.e)), k = kindOf(x);
        if (!NUMERIC.has(k)) fail(`bad operand type ${typeOfValue(v)} for unary operator '${e.op}'`);
        const kk = k === 'char' ? 'int' : k, n = asKind(x, kk);
        if (e.op === '+') return kk === 'double' || kk === 'float' ? new Num(n, kk === 'float') : n;
        if (e.op === '-') return kk === 'long' ? BigInt.asIntN(64, -n) : kk === 'int' ? (-n) | 0 : new Num(-n, kk === 'float');
        if (kk === 'long') return ~n;
        if (kk === 'int') return ~n;
        fail(`bad operand type ${k} for unary operator '~'`);
      }
      // falls through
      case 'bin': return binop(e.op, rval(e.l), rval(e.r), e);
      case 'and': return truthy(rval(e.l), '&&') && truthy(rval(e.r), '&&');
      case 'or': return truthy(rval(e.l), '||') || truthy(rval(e.r), '||');
      case 'cond': return truthy(rval(e.c), '?:') ? rval(e.a) : rval(e.b);
      case 'cast': return castTo(e.type, rval(e.e), srcText(e.e));
      case 'instanceof': {
        const v = rval(e.e);
        const yes = instanceOf(v, e.type);
        if (yes && e.bind) frame().scopes.at(-1).set(e.bind, { v, type: e.type });
        return yes;
      }
      case 'call': return callExpr(e);
      case 'new': return newExpr(e);
      case 'newArray': {
        if (e.init) return arrayFrom(e.init, { ...e.type, dims: e.dims.length + e.extra });
        const sizes = e.dims.map(d => { const n = unbox(rval(d), 'the size'); const k = typeof n === 'string' ? n.charCodeAt(0) : n; if (typeof k !== 'number') fail('incompatible types: the size of an array must be an int'); if (k < 0) throwJava('NegativeArraySizeException', String(k)); return k; });
        return makeArray(e.type, sizes, e.extra);
      }
      case 'arrayInit': fail('an array initializer { … } needs its type here: new int[]{ … }');
      // falls through
      case 'lambda': return makeLambda(e);
      case 'methodRef': return methodRef(e);
      case 'switch': return switchExpr(e);
      case 'ctorCall': fail('a call to this(…) or super(…) must be the first statement of a constructor');
      // falls through
      case 'classLit': return str(e.e.k === 'name' ? e.e.name : 'class');
      case 'typeRef': fail('a type is not a value here');
      // falls through
      case 'super': fail("'super' can only be used as super.method(…) or super(…)");
      // falls through
      default: fail('cannot evaluate ' + e.k);
    }
  }
  function instanceOf(v, t) {
    if (v === null) return false;
    if (t.dims) return v instanceof JArr;
    if (t.name === 'Object') return true;
    if (t.name === 'String') return v instanceof JStr;
    if (UNWRAP[t.name]) return v instanceof Box && v.k === t.name;
    if (t.name === 'Number') return v instanceof Box && !['Character', 'Boolean'].includes(v.k);
    if (t.name === 'Comparable') return v instanceof JStr || v instanceof Box || (v instanceof JObj && !!findMethod(v.cls, 'compareTo', [v], true));
    const c = classes.get(t.name) || (EXCEPTIONS[t.name] ? builtinException(t.name) : null);
    if (c) return v instanceof JObj && subclass(v.cls, c);
    return lib.instanceOf(v, t.name);
  }
  /** new int[3][4]: zeros (or nulls) of the element type, a dimension at a time */
  function makeArray(t, sizes, extra) {
    const dims = sizes.length + extra;
    const build = k => {
      const et = { name: t.name, args: t.args, dims: dims - k - 1 };
      const n = sizes[k];
      return new JArr(et, Array.from({ length: n }, () => (k + 1 < sizes.length ? build(k + 1) : defaultOf(et))));
    };
    return build(0);
  }
  /** {1, 2, 3} as an array of type t */
  function arrayFrom(init, t) {
    if (!t || !t.dims) fail('illegal initializer for ' + typeLabel(t) + ' (an array initializer { … } needs an array type)');
    const et = { ...t, dims: t.dims - 1 };
    return new JArr(et, init.items.map(it => (it.k === 'arrayInit' ? arrayFrom(it, et) : coerce(rval(it), et, 'an element'))));
  }

  /* ---- lambdas and method references ---- */
  function makeLambda(e) {
    const f = frame();
    return new JFn({ params: e.params, body: e.body, env: f ? [...[...f.scopes].reverse(), ...(f.env || [])] : [], self: f ? f.self : null, cls: f ? f.cls : null, line: e.line, name: 'lambda' });
  }
  function callLambda(fn, args) {
    if (args.length !== fn.params.length) fail(`the lambda takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, but is given ${args.length}`);
    const scope = new Map(fn.params.map((p, k) => [p, { v: args[k], type: null }]));
    return withFrame({ name: 'lambda', cls: fn.cls, self: fn.self, env: fn.env, scopes: [scope], args: fn.params.map((p, k) => p + '=' + brief(args[k])).join(', ') }, () => {
      if (fn.body.k !== 'block') { line = fn.body.line || line; return rval(fn.body); }
      const r = execBody(fn.body);
      return r && r.ret !== undefined ? r.ret : undefined;
    });
  }
  /** Integer::compare, String::length, System.out::println, this::helper, Node::new, int[]::new */
  function methodRef(e) {
    const name = e.name, st = staticTarget(e.target);
    const arity = (() => {                        // P::name takes one argument (the object), Integer::compare two
      if (st && st.cls) { const ms = allNamed(st.cls, name); if (ms.length) return ms[0].isStatic ? ms[0].params.length : ms[0].params.length + 1; }
      if (st && st.lib) return /^(compare|compareTo|sum|max|min|equals|pow)$/.test(name) ? 2 : 1;
      return /^(compare|equals)$/.test(name) ? 2 : 1;
    })();
    const mk = (fnc, label) => new JFn({ native: fnc, name: label, arity });
    if (st && st.type) { const t = st.type; return mk(args => (t.dims ? makeArray({ ...t, dims: 0 }, [unbox(args[0])], t.dims - 1) : newObject(t.name, args, e)), typeLabel(t) + '::new'); }
    if (st && (st.cls || st.lib)) {
      const cname = st.cls ? st.cls.name : st.lib;
      if (name === 'new') return mk(args => newObject(cname, args, e), cname + '::new');
      return mk(args => {
        if (st.cls) {
          const m = findMethod(st.cls, name, args, false);
          if (m && m.isStatic) return invoke(m, null, args);
          const inst = findMethod(st.cls, name, args.slice(1), false);
          if (inst && args[0] instanceof JObj) return invoke(inst, args[0], args.slice(1));
          fail(`invalid method reference: ${cname}::${name}`);
        }
        return lib.staticOrUnbound(st.lib, name, args, e);
      }, cname + '::' + name);
    }
    const target = e.target.k === 'super' ? frame().self : rval(e.target);
    if (target === null) npe(`use ${srcText(e.target)}::${name}`, `"${srcText(e.target)}"`);
    return mk(args => callMethodOn(target, name, args, e, e.target.k === 'super'), srcText(e.target) + '::' + name);
  }

  /* ---- calls ---- */
  /** How well an argument fits a parameter type: 3 exactly, 2 widening, 1 boxing or Object, -1 not at all */
  function fit(v, t) {
    if (!t) return 1;
    const k = kindOf(v);
    if (t.dims) return v === null ? 1 : v instanceof JArr && (v.et.dims === t.dims - 1) && (v.et.name === t.name || !PRIMS.has(t.name)) ? 3 : -1;
    if (PRIMS.has(t.name)) {
      const x = v instanceof Box ? v.v : v, xk = kindOf(x), base = v instanceof Box ? -1 : 0;
      if (x === null) return -1;
      if (xk === t.name) return 3 + base;
      const widen = { int: ['long', 'float', 'double'], char: ['int', 'long', 'float', 'double'], long: ['float', 'double'], float: ['double'] };
      if ((widen[xk] || []).includes(t.name)) return 2 + base - ['int', 'long', 'float', 'double'].indexOf(t.name) * 0.1;
      return -1;
    }
    if (k === 'null') return 1;
    if (k !== 'ref') { const w = WRAPPER[k]; return t.name === w ? 2 : t.name === 'Object' || t.name === 'Number' || t.name === 'Comparable' || !knownType(t.name) ? 1 : -1; }
    if (t.name === 'Object') return 1;
    if (t.name === 'String') return v instanceof JStr ? 3 : -1;
    if (UNWRAP[t.name]) return v instanceof Box && v.k === t.name ? 3 : -1;
    const c = classes.get(t.name);
    if (c && !c.builtin) return v instanceof JObj && subclass(v.cls, c) ? (v.cls === c ? 3 : 2) : v instanceof JFn && c.isInterface ? 2 : -1;
    if (c && c.builtin) return v instanceof JObj && subclass(v.cls, c) ? 2 : -1;
    return 1;
  }
  const knownType = n => PRIMS.has(n) || n === 'String' || !!UNWRAP[n] || classes.has(n) || lib.knows(n);
  /** The best method called name for these arguments, in class c or its superclasses and interfaces */
  function findMethod(c, name, args, quiet) {
    let best = null, bestScore = -Infinity;
    const seen = new Set();
    const visit = (x, depth) => {
      if (!x || seen.has(x)) return;
      seen.add(x);
      for (const m of x.methods.get(name) || []) {
        const ps = m.params, va = ps.length && ps.at(-1).varargs;
        if (!(args.length === ps.length || (va && args.length >= ps.length - 1))) continue;
        let score = -depth * 0.01;
        let ok = true;
        args.forEach((a, k) => {
          const pt = va && k >= ps.length - 1 ? (args.length === ps.length && args[k] instanceof JArr ? ps[k].type : { ...ps.at(-1).type, dims: ps.at(-1).type.dims - 1 }) : ps[k].type;
          const s = fit(a, pt);
          if (s < 0) ok = false; else score += s;
        });
        if (va) score -= 0.5;
        if (ok && score > bestScore && (m.body || m.native || !best)) { best = m; bestScore = score; }
      }
      visit(x.sup, depth + 1);
      x.ifaces.forEach(i => visit(i, depth + 1));
    };
    visit(c, 0);
    if (!best && !quiet) return null;
    return best;
  }
  const argText = args => args.map(typeOfValue).join(', ');
  /** Binds the arguments to the parameters (with varargs) and runs the method */
  function invoke(m, self, args, label) {
    if (m.native) return m.native(self, args);
    if (!m.body) fail(`${m.owner.name}.${m.name}() is abstract: it has no body to run`);
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls.');
    const ps = m.params, scope = new Map();
    ps.forEach((p, k) => {
      let v;
      if (p.varargs && !(args.length === ps.length && (args[k] instanceof JArr || args[k] === null))) v = new JArr({ ...p.type, dims: p.type.dims - 1 }, args.slice(k).map(a => coerce(a, { ...p.type, dims: p.type.dims - 1 }, p.name)));
      else v = coerce(args[k], p.type, p.name);
      scope.set(p.name, { v, type: p.type });
    });
    const name = label || (m.k === 'ctor' ? 'new ' + m.owner.name : (m.owner.decl.implicit ? '' : m.owner.name + '.') + m.name);
    return withFrame({ name, cls: m.owner, self: m.isStatic ? null : self, scopes: [scope], env: m.owner.env, method: m,
      args: ps.map(p => p.name + '=' + brief(scope.get(p.name).v)).join(', ') }, () => {
      const r = execBody(m.body);
      if (m.k === 'ctor') return undefined;
      const ret = m.ret;
      if (ret && ret.name === 'void' && !ret.dims) return undefined;
      if (!r || r.ret === undefined) fail(`missing return statement in ${m.name}()`);
      return coerce(r.ret, ret, 'the returned value');
    });
  }
  function withFrame(fr, fn) {
    const f = { scopes: [new Map()], ...fr };
    const id = fr.hidden ? 0 : ++calls;
    if (id) stack.push({ name: f.name, args: (f.args || '').slice(0, 70), id });
    frames.push(f);
    try { const r = fn(); if (id && r !== undefined) rets[id] = brief(r); return r; } finally { if (frames.length === 1 && f.isMain) finalVars = captureVars(f); frames.pop(); if (!fr.hidden) stack.pop(); }
  }
  const evalArgs = args => args.map(a => (a.k === 'arrayInit' ? fail('an array initializer { … } cannot be an argument: new int[]{ … }') : rval(a)));
  function callExpr(e) {
    const name = e.name;
    if (!e.target) {                                  // f(…): a method of this class, or of an enclosing one
      const args = evalArgs(e.args);
      const f = frame();
      for (let c = f && f.cls; c; c = c.outer) {
        const m = findMethod(c, name, args, true);
        if (!m) continue;
        if (m.isStatic) return invoke(m, null, args);
        let self = f.self;
        while (self && !subclass(self.cls, m.owner)) self = self.outerSelf;
        if (!self) fail(`non-static method ${name}(${argText(args)}) cannot be referenced from a static context (make it static, or call it on an object)`);
        return invokeVirtual(self, name, args, m);
      }
      for (let c = f && f.cls; c; c = c.outer) {
        const en = c.kind === 'enum' ? c : c.sup && c.sup.kind === 'enum' ? c.sup : null;
        if (en && (name === 'values' || name === 'valueOf')) { initClass(en); return enumStatic(en, name, args); }
      }
      if (f && f.self && ['name', 'ordinal', 'toString', 'hashCode', 'equals', 'getClass', 'compareTo', 'getMessage'].includes(name)) return objectMethod(f.self, name, args, e);
      const cands = f && f.cls ? allNamed(f.cls, name) : [];
      if (cands.length) fail(`method ${name} cannot be applied to given types: it takes (${cands[0].params.map(p => typeLabel(p.type)).join(', ')}), but is given (${argText(args)})`);
      fail(`cannot find symbol: method ${name}(${argText(args)})` + (lib.knows(name) ? '' : ''));
    }
    if (e.target.k === 'super') { const f = frame(); const m = findMethod(f.cls.sup, name, evalArgs(e.args), false); if (!m) { const args = evalArgs(e.args); return objectMethod(f.self, name, args, e); } return invoke(m, f.self, evalArgs(e.args)); }
    const st = staticTarget(e.target);
    if (st && st.cls && !st.cls.builtin) {
      initClass(st.cls);
      const args = evalArgs(e.args), m = findMethod(st.cls, name, args, false);
      if (st.cls.kind === 'enum' && (name === 'values' || name === 'valueOf') && !m) return enumStatic(st.cls, name, args);
      if (!m) fail(`cannot find symbol: method ${name}(${argText(args)}) in class ${st.cls.name}`);
      if (!m.isStatic) fail(`non-static method ${name}(…) cannot be referenced from a static context (call it on an object of ${st.cls.name})`);
      return invoke(m, null, args);
    }
    if (st && st.lib) return lib.callStatic(st.lib, name, evalArgs(e.args), e);
    const target = rval(e.target);
    return callMethodOn(target, name, evalArgs(e.args), e);
  }
  const allNamed = (c, name) => { const out = []; for (let x = c; x; x = x.outer) for (let y = x; y; y = y.sup) out.push(...(y.methods.get(name) || [])); return out; };
  /** obj.name(args): a class's own method (the object's real class first), a String's, a box's, the library's */
  function callMethodOn(target, name, args, e, nonVirtual = false) {
    if (target === null) npe(`invoke "${typeOfMethod(e)}${name}()"`, `"${srcText(e.target)}"`);
    if (target instanceof JObj) {
      if (nonVirtual) { const m = findMethod(frame().cls.sup, name, args, false); if (m) return invoke(m, target, args); return objectMethod(target, name, args, e); }
      return invokeVirtual(target, name, args, null, e);
    }
    if (target instanceof JFn) return lib.fnMethod(target, name, args, e);
    if (target instanceof JArr) {
      if (name === 'clone') return new JArr(target.et, target.a.slice());
      if (name === 'length') fail(`cannot find symbol: method length() (an array has the field length: ${srcText(e.target)}.length)`);
      return objectMethod(target, name, args, e);
    }
    return lib.callMethod(target, name, args, e);
  }
  /** "String." in 'Cannot invoke "String.length()"': the declared type of what the method was called on */
  const typeOfMethod = e => {
    if (!e || !e.target || !['name', 'field', 'index'].includes(e.target.k)) return '';
    try { const p = place(e.target); return p.type && p.type.name !== 'var' ? p.type.name + '[]'.repeat(p.type.dims || 0) + '.' : ''; } catch { return ''; }
  };
  function invokeVirtual(self, name, args, hint, e) {
    const m = findMethod(self.cls, name, args, true);
    if (m && (m.body || m.native)) return invoke(m, self, args);
    if (m && !m.body) fail(`${self.cls.name}.${name}() is abstract`);
    if (hint) return invoke(hint, self, args);
    return objectMethod(self, name, args, e);
  }
  /** The methods every object has (Object's, Enum's, Throwable's, a record's) */
  function objectMethod(o, name, args, e) {
    switch (name) {
      case 'toString': return jstr(o instanceof JObj ? defaultToString(o) : toStr(o));
      case 'equals': return o instanceof JObj && o.cls.comps ? equalsV(o, args[0]) : o === args[0];
      case 'hashCode': return o instanceof JObj && o.cls.comps ? hashOf(o) : identityHash(o);
      case 'getClass': return lib.classOf(o instanceof JObj ? o.cls.name : typeOfValue(o));
    }
    if (o instanceof JObj && o.enumName != null) {
      if (name === 'name') return str(o.enumName);
      if (name === 'ordinal') return o.ordinal;
      if (name === 'compareTo') return o.ordinal - args[0].ordinal;
    }
    if (o instanceof JObj && isThrowable(o.cls)) {
      if (name === 'getMessage' || name === 'getLocalizedMessage') return o.f.get('message');
      if (name === 'getCause') return o.f.get('cause');
      if (name === 'printStackTrace') { write(exceptionText(o) + '\n\tat line ' + (o.line || line) + '\n', true); return undefined; }
    }
    const what = o instanceof JObj ? o.cls.name : typeOfValue(o);
    const others = o instanceof JObj ? allNamed(o.cls, name) : [];
    if (others.length) fail(`method ${name} in ${what} cannot be applied to given types: it takes (${others[0].params.map(p => typeLabel(p.type)).join(', ')}), but is given (${argText(args)})`);
    fail(`cannot find symbol: method ${name}(${argText(args)}) in ${what}` + (e && e.target ? ` (${srcText(e.target)} is ${art(what)})` : ''));
  }
  function enumStatic(c, name, args) {
    if (name === 'values') return new JArr({ name: c.name, dims: 0 }, c.enumValues.slice());
    const s = toStr(args[0]), v = c.enumValues.find(o => o.enumName === s);
    if (!v) throwJava('IllegalArgumentException', `No enum constant ${c.name}.${s}`);
    return v;
  }

  /* ---- new ---- */
  function newExpr(e) {
    const args = evalArgs(e.args);
    if (e.body) {                                     // an anonymous class
      const base = classes.get(e.type.name);
      const iface = base || { name: e.type.name, isInterface: true, sup: null, ifaces: [], methods: new Map(), fields: [], statics: new Map(), decl: { members: [] }, builtin: true, ready: true };
      const c = anonClass(e, iface, e.body);
      const f = frame();
      c.env = f ? [...[...f.scopes].reverse(), ...(f.env || [])] : [];
      const o = construct(c, args, e.line, { outerSelf: f ? f.self : null });
      return o;
    }
    return newObject(e.type.name, args, e);
  }
  function newObject(name, args, e) {
    const c = classes.get(name) || (EXCEPTIONS[name] ? builtinException(name) : null);
    if (!c) {
      if (lib.knows(name)) return lib.construct(name, args, e);
      fail(`cannot find symbol: class ${name}`);
    }
    if (c.isInterface) fail(`${name} is abstract; cannot be instantiated (it is an interface: make an object of a class that implements it)`);
    if (c.isAbstract) fail(`${name} is abstract; cannot be instantiated`);
    if (c.kind === 'enum') fail(`enum classes may not be instantiated (use ${name}.${c.decl.enumConsts[0] ? c.decl.enumConsts[0].name : 'A'})`);
    const f = frame();
    let outerSelf = null;
    if (!c.isStatic && c.outer && f && f.self) for (let s = f.self; s; s = s.outerSelf) if (subclass(s.cls, c.outer)) { outerSelf = s; break; }
    return construct(c, args, e.line, { outerSelf });
  }
  /** Makes an object: its fields at their defaults, then its constructor (and the ones it calls) */
  function construct(c, args, l, extra = {}) {
    initClass(c);
    const o = new JObj(c);
    Object.assign(o, extra);
    if (extra.enumName != null) { o.enumName = extra.enumName; o.ordinal = extra.ordinal; }
    for (let x = c; x; x = x.sup) for (const fd of x.fields) if (!o.f.has(fd.name)) o.f.set(fd.name, defaultOf(fd.type));
    if (isThrowable(c)) { o.f.set('message', null); o.f.set('cause', null); o.line = l; }
    runCtor(c, o, args, l);
    return o;
  }
  /** One class's constructor: super(…) or this(…) first, then the field initializers, then the body */
  function runCtor(c, o, args, l) {
    if (c.builtin) {                                  // Exception(), Exception(String), Exception(String, Throwable)
      if (args[0] instanceof JStr || args[0] === null) o.f.set('message', args[0]);
      else if (args[0] instanceof JObj) { o.f.set('cause', args[0]); o.f.set('message', jstr(exceptionText(args[0]))); }
      if (args[1] instanceof JObj) o.f.set('cause', args[1]);
      return;
    }
    if (c.comps && !c.ctors.some(k => !k.compact && k.params.length === c.comps.length)) {   // a record's canonical constructor
      if (args.length !== c.comps.length) fail(`constructor ${c.name} in record ${c.name} cannot be applied to given types: it takes (${c.comps.map(p => typeLabel(p.type)).join(', ')})`);
      const compact = c.ctors.find(k => k.compact);
      const vals = args.map((a, k) => coerce(a, c.comps[k].type, c.comps[k].name));
      if (compact) {
        const scope = new Map(c.comps.map((p, k) => [p.name, { v: vals[k], type: p.type }]));
        withFrame({ name: 'new ' + c.name, cls: c, self: o, scopes: [scope], args: c.comps.map((p, k) => p.name + '=' + brief(vals[k])).join(', ') }, () => execBody(compact.body));
        c.comps.forEach(p => o.f.set(p.name, scope.get(p.name).v));
      } else c.comps.forEach((p, k) => o.f.set(p.name, vals[k]));
      return;
    }
    const ctors = c.ctors.filter(k => !k.compact);
    if (!ctors.length) {
      if (args.length && !c.anon) fail(`constructor ${c.name} in class ${c.name} cannot be applied to given types: it has no constructor that takes (${argText(args)}) (only the default one, with no arguments)`);
      if (c.sup) runCtor(c.sup, o, c.anon ? args : [], l);
      fieldInits(c, o);
      return;
    }
    let best = null, bestScore = -Infinity;
    for (const k of ctors) {
      const va = k.params.length && k.params.at(-1).varargs;
      if (!(args.length === k.params.length || (va && args.length >= k.params.length - 1))) continue;
      let s = 0, ok = true;
      args.forEach((a, j) => { const f = fit(a, j < k.params.length && !(va && j >= k.params.length - 1) ? k.params[j].type : { ...k.params.at(-1).type, dims: k.params.at(-1).type.dims - 1 }); if (f < 0) ok = false; else s += f; });
      if (ok && s > bestScore) { best = k; bestScore = s; }
    }
    if (!best) fail(`constructor ${c.name} in class ${c.name} cannot be applied to given types: it is given (${argText(args)}), but takes ${ctors.map(k => '(' + k.params.map(p => typeLabel(p.type)).join(', ') + ')').join(' or ')}`);
    const body = best.body.items, first = body[0];
    const explicit = first && first.k === 'expr' && first.e.k === 'ctorCall' ? first.e : null;
    const scope = new Map();
    best.params.forEach((p, k) => scope.set(p.name, { v: p.varargs ? new JArr({ ...p.type, dims: p.type.dims - 1 }, args.slice(k)) : coerce(args[k], p.type, p.name), type: p.type }));
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls.');
    withFrame({ name: 'new ' + c.name, cls: c, self: o, scopes: [scope], env: c.env, args: best.params.map(p => p.name + '=' + brief(scope.get(p.name).v)).join(', ') }, () => {
      if (explicit) {
        step(first.line);
        const a = evalArgs(explicit.args);
        if (explicit.sup) { if (!c.sup) { if (a.length) fail('constructor Object in class Object cannot be applied to given types'); } else runCtor(c.sup, o, a, l); fieldInits(c, o); }
        else runCtor(c, o, a, l);                    // this(…): that constructor does the field initializers
      } else { if (c.sup) runCtor(c.sup, o, [], l); fieldInits(c, o); }
      for (const s of explicit ? body.slice(1) : body) { const r = exec(s); if (r && r.ret !== undefined) break; if (r) break; }
    });
  }
  /** int count = 0; and { … } blocks, in order, when an object is made */
  function fieldInits(c, o) {
    for (const m of c.inits) {
      line = m.line;
      if (m.k === 'field' && m.init) o.f.set(m.name, coerce(m.init.k === 'arrayInit' ? arrayFrom(m.init, m.type) : rval(m.init), m.type, m.name));
      else if (m.k === 'init') execBody(m.body);
    }
  }

  /* ---- statements ---- */
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  const scoped = fn => { const f = frame(); f.scopes.push(new Map()); try { return fn(); } finally { f.scopes.pop(); } };
  const execBody = b => scoped(() => { for (const s of b.items) { const r = exec(s); if (r) return r; } return undefined; });
  const sub = (s, parent) => exec(s, s.line === parent.line && s.k !== 'block');
  /** Does a break or continue (with its label) stop at this loop? */
  const caught = (r, label) => r && (r.k === BREAK || r.k === CONTINUE) && (!r.label || r.label === label);
  function exec(s, quiet = false, label = null) {
    const at = l => { if (!quiet) step(l); else line = l; };
    switch (s.k) {
      case 'block': return execBody(s);
      case 'empty': at(s.line); return undefined;
      case 'var': {
        at(s.line);
        for (const d of s.decls) {
          const t = s.type.name === 'var' ? null : d.dims ? { ...s.type, dims: s.type.dims + d.dims } : s.type;
          if (s.type.name === 'var' && !d.init) fail(`cannot infer type for local variable ${d.name} (var needs a value: var ${d.name} = …;)`);
          if (localVar(d.name) && frame().scopes.some(sc => sc.has(d.name))) fail(`variable ${d.name} is already defined in this method`);
          const v = d.init ? coerce(d.init.k === 'arrayInit' ? arrayFrom(d.init, t) : rval(d.init), t, d.name) : UNSET;
          frame().scopes.at(-1).set(d.name, { v, type: t || { name: 'var', dims: 0 } });
        }
        return undefined;
      }
      case 'expr': at(s.line); rval(s.e); return undefined;
      case 'if': at(s.line); return truthy(rval(s.c), 'if') ? sub(s.a, s) : s.b ? sub(s.b, s) : undefined;
      case 'while':
        for (;;) {
          at(s.line);
          if (!truthy(rval(s.c), 'while')) return undefined;
          const r = sub(s.body, s);
          if (caught(r, label)) { if (r.k === BREAK) return undefined; continue; }
          if (r) return r;
        }
      // falls through
      case 'do':
        at(s.line);
        for (;;) {
          const r = sub(s.body, s);
          if (caught(r, label)) { if (r.k === BREAK) return undefined; } else if (r) return r;
          step(s.cline);
          if (!truthy(rval(s.c), 'while')) return undefined;
        }
      // falls through
      case 'for':
        return scoped(() => {
          at(s.line);
          if (s.init) { if (s.init.k === 'var') exec(s.init, true); else s.init.es.forEach(rval); }
          for (;;) {
            if (s.c && !truthy(rval(s.c), 'for')) return undefined;
            const r = sub(s.body, s);
            if (caught(r, label)) { if (r.k === BREAK) return undefined; } else if (r) return r;
            s.step.forEach(rval);
            at(s.line);
          }
        });
      case 'foreach':
        return scoped(() => {
          at(s.line);
          const it = iterate(rval(s.iter), s);
          for (;;) {
            const nx = it();
            if (nx.done) return undefined;
            const r = scoped(() => { frame().scopes.at(-1).set(s.name, { v: s.type.name === 'var' ? nx.v : coerce(nx.v, s.type, s.name), type: s.type }); return sub(s.body, s); });
            if (caught(r, label)) { if (r.k === BREAK) return undefined; } else if (r) return r;
            at(s.line);
          }
        });
      case 'label': {
        const r = exec(s.body, quiet, s.label);
        if (r && r.k === BREAK && r.label === s.label) return undefined;
        return r;
      }
      case 'return': {
        at(s.line);
        return { ret: s.e ? rval(s.e) : undefined, k: 'return' };
      }
      case 'break': at(s.line); return { k: BREAK, label: s.label };
      case 'continue': at(s.line); return { k: CONTINUE, label: s.label };
      case 'throw': {
        at(s.line);
        const v = rval(s.e);
        if (v === null) throwJava('NullPointerException', 'Cannot throw exception because the value is null');
        if (!(v instanceof JObj) || !isThrowable(v.cls)) fail(`incompatible types: ${typeOfValue(v)} cannot be converted to Throwable`);
        if (!v.line) v.line = s.line;
        throw new Thrown(v);
      }
      case 'switch': {
        at(s.line);
        const r = runSwitch(s, false);
        if (r && r.k === BREAK && !r.label) return undefined;
        return r;
      }
      case 'yield': at(s.line); return { k: 'yield', v: rval(s.e) };
      case 'arrowExpr': at(s.line); rval(s.e); return undefined;
      case 'try': return runTry(s);
      case 'assert': at(s.line); return undefined;   // assertions are off by default, as when java runs without -ea
      case 'localClass': { const c = makeClass(s.decl, frame().cls); c.env = [...[...frame().scopes].reverse(), ...(frame().env || [])]; register(c); link(c); return undefined; }
      default: fail('cannot run ' + s.k);
    }
  }
  function runTry(s) {
    let result, pending = null;
    try {
      result = execBody(s.body);
    } catch (err) {
      if (!(err instanceof Thrown)) { pending = err; }
      else {
        const c = s.catches.find(cc => cc.types.some(t => instanceOf(err.obj, t)));
        if (!c) pending = err;
        else {
          try { result = scoped(() => { frame().scopes.at(-1).set(c.name, { v: err.obj, type: c.types[0] }); line = c.line; return execBody(c.body); }); }
          catch (err2) { pending = err2; }
        }
      }
    }
    if (s.fin) {
      if (pending instanceof StopRun || pending instanceof ExitRun) throw pending;
      const f = execBody(s.fin);
      if (f) return f;                                // a return in finally wins
    }
    if (pending) throw pending;
    return result;
  }
  /** switch: the matching case, then on (falling through, for case …:) to a break */
  function runSwitch(s, asExpr) {
    const v = rval(s.e);
    const x = v instanceof Box ? v.v : v;
    if (v === null) throwJava('NullPointerException', `Cannot invoke switch on null (${srcText(s.e)})`);
    const matches = lab => {
      if (lab === null) return false;
      if (lab.k === 'name' && lab.label && x instanceof JObj && x.enumName != null) return x.enumName === lab.name;
      return sameValue(x instanceof JStr ? x : x, rval(lab)) || (x instanceof JStr && equalsV(x, rval(lab)));
    };
    let at = s.cases.findIndex(c => c.labels && c.labels.some(matches));
    if (at < 0) at = s.cases.findIndex(c => !c.labels || c.labels.includes(null));
    if (at < 0) { if (asExpr) fail('the switch expression does not cover all possible input values (add a default)'); return undefined; }
    if (s.arrow) {
      const body = s.cases[at].body[0];
      if (body.k === 'arrowExpr') { line = body.line; if (asExpr) { step(body.line); return { k: 'yield', v: rval(body.e) }; } return exec(body); }
      const r = exec(body);
      return r;
    }
    return scoped(() => {
      for (let k = at; k < s.cases.length; k++) for (const st of s.cases[k].body) { const r = exec(st); if (r) return r; }
      return undefined;
    });
  }
  function switchExpr(e) {
    const r = runSwitch(e, true);
    if (!r || r.k !== 'yield') fail('the switch expression must give a value (yield, or case … -> value)');
    return r.v;
  }
  /** for (x : …): arrays, the library's collections (with Java's ConcurrentModificationException), Iterables of one's own */
  function iterate(v, s) {
    if (v === null) npe('iterate', `"${srcText(s.iter)}"`);
    if (v instanceof JArr) { let k = 0; return () => (k < v.a.length ? { v: v.a[k++] } : { done: true }); }
    if (v instanceof JObj) {
      const itObj = callMethodOn(v, 'iterator', [], { target: s.iter });
      return () => (truthy(callMethodOn(itObj, 'hasNext', [], null)) ? { v: callMethodOn(itObj, 'next', [], null) } : { done: true });
    }
    return lib.iterator(v, srcText(s.iter));
  }

  /* ---- snapshots ---- */
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = o => { let n = ids.get(o); if (!n) { n = nextId++; ids.set(o, n); } return n; };
  const prim = (k, s) => ({ t: 'p', k, s });
  const charText = c => { const n = c.charCodeAt(0); const esc = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 39: "\\'", 92: '\\\\' }; return "'" + (esc[n] || (n < 32 ? '\\u' + n.toString(16).padStart(4, '0') : c)) + "'"; };
  function ser(v, ctx, depth) {
    if (v === UNSET) return prim('undef', '?');
    switch (kindOf(v)) {
      case 'null': return prim('null', 'null');
      case 'int': return prim('num', String(v));
      case 'long': return prim('num', String(v));
      case 'double': return prim('num', javaDouble(v.v));
      case 'float': return prim('num', javaDouble(v.v, true));
      case 'char': return prim('char', charText(v));
      case 'boolean': return prim('bool', String(v));
    }
    if (v instanceof JStr) return prim('str', JSON.stringify(v.s.length > 80 ? v.s.slice(0, 80) + '…' : v.s));
    if (v instanceof Box) return ser(v.v, ctx, depth);
    if (v instanceof JFn) return { t: 'fn', s: v.name || 'lambda' };
    if (v instanceof JObj && v.enumName != null) return prim('sym', v.cls.name.replace(/\..*/, '') + '.' + v.enumName);
    const id = idOf(v);
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    if (v instanceof JArr) {
      const n = Math.min(v.a.length, MAX_ITEMS);
      return { t: 'arr', id, len: v.a.length, items: v.a.slice(0, n).map(x => ser(x, ctx, depth + 1)), more: v.a.length - n, tn: typeLabel(v.et) + '[' + v.a.length + ']' };
    }
    if (v instanceof JObj) {
      const entries = [];
      for (const [k, x] of v.f) if (!(isThrowable(v.cls) && k === 'cause' && x === null)) entries.push([k, ser(x, ctx, depth + 1)]);
      return { t: 'obj', id, cls: v.cls.anon ? 'anonymous ' + v.cls.name : v.cls.name, entries: entries.slice(0, 30), more: Math.max(0, entries.length - 30) };
    }
    return lib.ser(v, id, ctx, depth, ser);
  }
  /** One-line value for the call stack */
  function brief(v) {
    const k = kindOf(v);
    if (k !== 'ref') return k === 'char' ? charText(v) : toStrSafe(v);
    if (v instanceof JStr) return JSON.stringify(v.s.length > 14 ? v.s.slice(0, 14) + '…' : v.s);
    if (v instanceof Box) return brief(v.v);
    if (v instanceof JArr) return typeLabel(v.et) + '[' + v.a.length + ']';
    if (v instanceof JObj) return v.enumName != null ? v.enumName : v.cls.name + '{…}';
    if (v instanceof JFn) return v.name || 'lambda';
    return lib.brief(v);
  }
  const toStrSafe = v => { try { return toStr(v); } catch { return '?'; } };
  /** The variables a step shows: locals (and this), then the static fields of the program's classes */
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set() };
    const named = new Map();
    if (f) {
      for (const sc of [...(f.env || [])].reverse()) for (const [n, r] of sc) if (!named.has(n)) named.set(n, r);
      if (f.self && !f.hidden) named.set('this', { v: f.self });
      for (const sc of f.scopes) for (const [n, r] of sc) { named.delete(n); if (!r.hidden) named.set(n, r); }   // main's (empty) args is not shown
    }
    const vars = [...named].map(([n, r]) => ({ name: n, scope: 'local', node: ser(r.v, ctx, 0) }));
    const counts = new Map();
    for (const c of new Set(classes.values())) if (!c.builtin && c.ready) for (const n of c.statics.keys()) counts.set(n, (counts.get(n) || 0) + 1);
    for (const c of new Set(classes.values())) {
      if (c.builtin || !c.ready) continue;
      for (const [n, r] of c.statics) {
        if (r.enumConst) continue;
        const name = counts.get(n) > 1 || named.has(n) ? c.name + '.' + n : n;
        vars.push({ name, scope: 'global', node: ser(r.v, ctx, 0) });
      }
    }
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }

  /* ---- the library ---- */
  const lib = makeLib({
    Num, JStr, Box, JObj, JArr, JFn, str, jstr, box, unbox, toStr, equalsV, hashOf, compareV, callFn, throwJava, fail, write,
    kindOf, typeOfValue, coerce, castTo, sameValue, truthy, binop, invoke, findMethod, idOf, identityHash, line: () => line,
    exit: code => { finalVars = captureVars(frame()); throw new ExitRun(String(code)); }, newObject, makeArray, defaultOf, steps: () => steps.length,
  });

  /* ---- run: find main(), run it ---- */
  let error = null;
  try {
    for (const d of prog.types) register(makeClass(d, null));
    const all = new Set(classes.values());
    for (const c of all) if (!c.builtin) link(c);
    for (const c of all) if (!c.builtin && c.sup && c.sup.builtin) { /* extends Exception: fine */ }
    const withMain = [...all].filter(c => !c.builtin && (c.methods.get('main') || []).some(m => m.params.length <= 1));
    const mainCls = withMain.find(c => c.name === 'Main') || withMain.find(c => c.decl.mods && c.decl.mods.has && c.decl.mods.has('public')) || withMain[0];
    if (!mainCls) throw Object.assign(new Error('there is no main method: a Java program starts in public static void main(String[] args) { … }'), { noMain: true });
    const main = mainCls.methods.get('main').find(m => m.params.length <= 1);
    initClass(mainCls);
    const args = main.params.length ? [new JArr({ name: 'String', dims: 0 }, [])] : [];
    const self = main.isStatic ? null : construct(mainCls, [], main.line);
    withFrame({ name: (mainCls.decl.implicit ? '' : mainCls.name + '.') + 'main', cls: mainCls, self, scopes: [new Map(main.params.map((p, k) => [p.name, { v: args[k], type: p.type, hidden: true }]))], isMain: true, args: '' }, () => {
      for (const st of main.body.items) { const r = exec(st); if (r) break; }   // in the frame's own scope: main's variables stay for the last step
    });
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof ExitRun) error = e.message === '0' ? null : { msg: `The program called System.exit(${e.message}).`, soft: true };
    else if (e instanceof Thrown) error = { msg: `Exception in thread "main" ${exceptionText(e.obj)} (line ${e.obj.line || line})` };
    else if (e instanceof JError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e && e.noMain) throw new Error(e.message);
    else if (e instanceof RangeError) error = { msg: `Error on line ${line}: java.lang.StackOverflowError (the program went too deep)` };
    else throw e;
  }
  if (outBuf) logs.push({ type: 'log', s: outBuf });
  if (errBuf) logs.push({ type: 'error', s: errBuf });
  if (!error || (error.soft && !stopped)) {
    const c = finalVars || captureVars(null);
    steps.push({ line: -1, stack: [], vars: c.vars, refs: c.refs, logs: logs.length });
  }
  return { steps, logs, error, rets };
}
