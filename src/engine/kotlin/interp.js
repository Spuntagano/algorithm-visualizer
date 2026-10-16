/**
 * The Kotlin interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and
 * before each test of a loop), in the format of src/model.js. The library (println, collections and their extension
 * functions, strings, ranges, kotlin.math…) is ./lib.js.
 *
 * Values: Int (and Short, Byte) is a JavaScript number, Long a BigInt, Double and Float a D, Char a KC (one per code, so
 * == works), Boolean, String and null are themselves, Unit is UNIT; an object is a KObj, an array a KArr, a lambda or a
 * function reference a KFn. Collections are the JVM's (./lib.js), with their orders: a HashMap iterates in its bucket
 * order, mutableMapOf() in insertion order.
 *
 * runKotlinTrace(source) returns { steps, logs, error }, or throws an Error ("line N: …") for a syntax error.
 */
import { parseKotlin } from './parse.js';
import { makeLib } from './lib.js';
import { javaDouble } from '../java/values.js';

const MAX_STEPS = 3000, MAX_CALLS = 300, MAX_DEPTH = 5, MAX_ITEMS = 60;

export class D { constructor(v, f = false) { this.v = f ? Math.fround(v) : v; this.f = f; } }
export class KC { constructor(c) { this.c = c; } }
const CHARS = new Map();
export const KCH = c => { let x = CHARS.get(c); if (!x) { x = new KC(c); CHARS.set(c, x); } return x; };
export class KObj { constructor(cls) { this.cls = cls; this.f = new Map(); } }
export class KArr { constructor(kind, a) { this.kind = kind; this.a = a; } }
export class KFn { constructor(o) { Object.assign(this, o); } }
export const UNIT = Object.freeze({ unit: true });
class StopRun extends Error {}
/** a Kotlin exception in flight */
export class Thrown extends Error { constructor(obj, line) { super('thrown'); this.obj = obj; this.line = line; } }
/** what the Kotlin compiler would refuse, met while running */
class KtError extends Error {}
/** return, break, continue (with their labels) */
class Jump { constructor(k, label, v, target) { this.k = k; this.label = label; this.v = v; this.target = target; } }
const UNSET = Symbol('unset');

export function runKotlinTrace(src) {
  const prog = parseKotlin(src);
  const steps = [], logs = [], stack = [], frames = [];
  let line = 0, stopped = null, outBuf = '', finalVars = null;
  const fail = (msg, l) => { if (l) line = l; throw new KtError(msg); };
  const write = (s, err) => {
    if (err) { logs.push(...s.replace(/\n$/, '').split('\n').map(x => ({ type: 'error', s: x }))); return; }
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k) }); outBuf = outBuf.slice(k + 1); }
  };

  /* ---- classes ---- */
  const classes = new Map();
  const topFuns = new Map(), extFuns = new Map(), topProps = new Map();
  function makeClass(d, outer) {
    const c = { name: d.name, decl: d, kind: d.kind, data: d.mods.has('data'), isEnum: d.kind === 'enum', isObject: d.kind === 'object' || d.kind === 'companion' || d.kind === 'anon',
      isInterface: d.kind === 'interface', isAbstract: d.mods.has('abstract') || d.mods.has('sealed'), open: d.mods.has('open') || d.mods.has('abstract') || d.mods.has('sealed') || d.kind === 'interface',
      sealed: d.mods.has('sealed'), base: null, ifaces: [], props: new Map(), order: [], methods: new Map(), ctors: [], nested: new Map(), outer, companion: null, instance: null, pc: d.pc || [], tps: d.tps };
    for (const m of d.members) {
      if (m.k === 'class') {
        const n = makeClass(m, c);
        if (m.kind === 'companion') c.companion = n; else c.nested.set(m.name, n);
        continue;
      }
      if (m.k === 'fun') { const fn = funFn(m, c); if (m.recv) addExt(fn); else { if (!c.methods.has(m.name)) c.methods.set(m.name, []); c.methods.get(m.name).push(fn); } }
      else if (m.k === 'prop') { c.props.set(m.name, { ...m, cls: c }); c.order.push({ k: 'prop', p: m }); }
      else if (m.k === 'init') c.order.push({ k: 'init', body: m.body });
      else if (m.k === 'ctor') c.ctors.push({ ...m, cls: c });
      else if (m.k === 'destructure') fail('destructuring declarations are only allowed for local variables/values.', m.line);
    }
    for (const p of c.pc) if (p.prop) c.props.set(p.name, { k: 'prop', mods: p.mods, mutable: p.prop === 'var', name: p.name, type: p.type, fromPc: true, cls: c, line: p.line });
    if (c.isEnum) c.entries = [];
    if (!outer || d.kind !== 'anon') classes.set(c.name, c);
    if (outer && d.kind !== 'anon') classes.set(outer.name + '.' + c.name, c);
    return c;
  }
  function funFn(m, c) {
    return new KFn({ name: m.name, params: m.params, ret: m.ret, body: m.body, expr: m.expr, cls: c, mods: m.mods, recv: m.recv, line: m.line, isAbstract: !m.body && !m.expr, tps: m.tps });
  }
  function addExt(fn) { if (!extFuns.has(fn.name)) extFuns.set(fn.name, []); extFuns.get(fn.name).push(fn); }
  // the built-in exceptions, so a program's own can extend them
  const EXC = {};
  const builtinExc = (name, base, pkg = 'java.lang') => { const c = { name, full: pkg + '.' + name, builtin: true, base: base ? EXC[base] : null, props: new Map(), order: [], methods: new Map(), ctors: [], nested: new Map(), ifaces: [], pc: [], open: true }; EXC[name] = c; classes.set(name, c); return c; };
  builtinExc('Throwable', null);
  builtinExc('Exception', 'Throwable'); builtinExc('Error', 'Throwable');
  for (const [n, b, p] of [['RuntimeException', 'Exception'], ['IllegalArgumentException', 'RuntimeException'], ['IllegalStateException', 'RuntimeException'], ['NumberFormatException', 'IllegalArgumentException'],
    ['IndexOutOfBoundsException', 'RuntimeException'], ['ArrayIndexOutOfBoundsException', 'IndexOutOfBoundsException'], ['StringIndexOutOfBoundsException', 'IndexOutOfBoundsException'],
    ['ArithmeticException', 'RuntimeException'], ['NullPointerException', 'RuntimeException'], ['UnsupportedOperationException', 'RuntimeException'], ['ClassCastException', 'RuntimeException'],
    ['NoSuchElementException', 'RuntimeException', 'java.util'], ['ConcurrentModificationException', 'RuntimeException', 'java.util'], ['StackOverflowError', 'Error'],
    ['NotImplementedError', 'Error', 'kotlin'], ['KotlinNullPointerException', 'NullPointerException', 'kotlin']]) builtinExc(n, b, p);
  const isExc = c => { for (let x = c; x; x = x.base) if (x === EXC.Throwable) return true; return false; };
  const newExc = (name, msg = null) => { const o = new KObj(EXC[name]); o.f.set('message', msg); o.f.set('cause', null); return o; };
  const throwKt = (name, msg = null) => { throw new Thrown(newExc(name, msg), line); };
  const npe = () => throwKt('NullPointerException');
  const fullName = c => c.full || ((c.outer ? fullName(c.outer) + '.' : '') + c.name);

  /* ---- types ---- */
  const KTN = { Int: 'kotlin.Int', Long: 'kotlin.Long', Double: 'kotlin.Double', Float: 'kotlin.Float', Char: 'kotlin.Char', Boolean: 'kotlin.Boolean', String: 'kotlin.String', Short: 'kotlin.Short', Byte: 'kotlin.Byte', Unit: 'kotlin.Unit', Any: 'kotlin.Any', Nothing: 'kotlin.Nothing' };
  /** a value's type as Kotlin's messages name it: kotlin.Int, kotlin.String, Person */
  function ktType(v) {
    if (typeof v === 'number') return 'kotlin.Int';
    if (typeof v === 'bigint') return 'kotlin.Long';
    if (v instanceof D) return v.f ? 'kotlin.Float' : 'kotlin.Double';
    if (v instanceof KC) return 'kotlin.Char';
    if (typeof v === 'boolean') return 'kotlin.Boolean';
    if (typeof v === 'string') return 'kotlin.String';
    if (v === null || v === undefined) return 'kotlin.Nothing?';
    if (v === UNIT) return 'kotlin.Unit';
    if (v instanceof KObj) return v.cls.name;
    return lib.ktType(v);
  }
  const typeText = t => (!t ? 'kotlin.Any' : t.n === 'fn' ? '(' + t.params.map(typeText).join(', ') + ') -> ' + typeText(t.ret) : (KTN[t.n] || t.n) + (t.args && t.args.length ? '<' + t.args.map(typeText).join(', ') + '>' : '') + (t.nul ? '?' : ''));
  const kindOf = v => (typeof v === 'number' ? 'Int' : typeof v === 'bigint' ? 'Long' : v instanceof D ? (v.f ? 'Float' : 'Double') : v instanceof KC ? 'Char' : typeof v === 'boolean' ? 'Boolean' : typeof v === 'string' ? 'String' : v === null || v === undefined ? 'null' : 'ref');
  const NUMS = new Set(['Int', 'Long', 'Double', 'Float', 'Short', 'Byte']);
  const findClass = n => classes.get(n) || (frame() && frame().cls ? nested(frame().cls, n) : null);
  const nested = (c, n) => { for (let x = c; x; x = x.outer || x.base) if (x.nested && x.nested.has(n)) return x.nested.get(n); return null; };
  /** Is the integer literal (or -literal) e? Kotlin lets it become a Long, a Short or a Byte */
  const intLit = e => !!e && ((e.k === 'lit' && e.kind === 'int') || (e.k === 'un' && e.op === '-' && intLit(e.e)) || (e.k === 'paren' && intLit(e.e)));
  /** assigning v where type t is declared: Kotlin converts nothing on its own (an integer literal may become a Long) */
  function conv(v, t, ast, how = 'initializer') {
    if (!t || v === UNSET) return v;
    const n = t.n;
    if (v === null || v === undefined) {
      if (t.nul || n === 'Any?' || /^[A-Z]$/.test(n) || (t.tp)) return null;
      if (frame() && frame().tps && frame().tps.includes(n)) return null;
      fail(`null cannot be a value of a non-null type '${typeText(t)}'.`);
    }
    const mismatch = () => fail(how === 'initializer' ? `initializer type mismatch: expected '${typeText(t)}', actual '${ktType(v)}'.` : how === 'return' ? `return type mismatch: expected '${typeText(t)}', actual '${ktType(v)}'.` : `${how} type mismatch: actual type is '${ktType(v)}', but '${typeText(t)}' was expected.`);
    const k = kindOf(v);
    switch (n) {
      case 'Int': case 'Short': case 'Byte': if (k === 'Int') return v; if (k === 'Long' && intLit(ast) && v >= -2147483648n && v <= 2147483647n) return Number(v); return mismatch();
      case 'Long': if (k === 'Long') return v; if (k === 'Int' && intLit(ast)) return BigInt(v); return mismatch();
      case 'Double': if (k === 'Double') return v; return mismatch();
      case 'Float': if (k === 'Float') return v; return mismatch();
      case 'Char': case 'Boolean': case 'String': if (k !== n) mismatch(); return v;
      case 'Unit': return v;
    }
    if (k !== 'ref' && (findClass(n) || lib.isCollType(n))) mismatch();
    return v;
  }

  /* ---- frames and names ---- */
  const frame = () => frames[frames.length - 1];
  function lookupVar(name) {
    const f = frame();
    if (!f) return null;
    for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].get(name); if (r) return r; }
    for (const sc of f.env || []) { const r = sc.get(name); if (r) return r; }
    return null;
  }
  function declare(name, v, t, opts = {}) {
    if (name === '_') return null;
    const f = frame(), scope = f.scopes.at(-1);
    if (scope.has(name) && !scope.get(name).isFn) fail(`conflicting declarations: ${opts.mutable ? 'var' : 'val'} ${name}: ${t ? typeText(t) : ktType(v)}`);
    const r = { v, t, name, ...opts };
    scope.set(name, r);
    return r;
  }
  const scoped = fn => { const f = frame(); f.scopes.push(new Map()); try { return fn(); } finally { f.scopes.pop(); } };

  /* ---- members ---- */
  function findMethods(c, name) { const out = []; for (let x = c; x; x = x.base) { for (const m of (x.methods && x.methods.get(name)) || []) if (!out.some(o => o.params.length === m.params.length)) out.push(m); for (const it of x.ifaces || []) for (const m of (it.methods && it.methods.get(name)) || []) if (!out.some(o => o.params.length === m.params.length) && (m.body || m.expr)) out.push(m); } return out; }
  function findProp(c, name) { for (let x = c; x; x = x.base) { if (x.props && x.props.has(name)) return x.props.get(name); for (const it of x.ifaces || []) if (it.props && it.props.has(name)) return it.props.get(name); } return null; }
  /** the most derived override of m for obj */
  function virt(obj, m) {
    if (!(obj instanceof KObj)) return m;
    for (let c = obj.cls; c; c = c.base) for (const x of (c.methods && c.methods.get(m.name)) || []) if (x.params.length === m.params.length && (x.body || x.expr)) return x;
    for (let c = obj.cls; c; c = c.base) for (const it of c.ifaces || []) for (const x of (it.methods && it.methods.get(m.name)) || []) if (x.params.length === m.params.length && (x.body || x.expr)) return x;
    return m;
  }
  /** obj.name: a property (its getter), a field, or a method as a function value */
  function getMember(obj, n, e) {
    if (obj instanceof KObj) {
      const p = findProp(obj.cls, n);
      if (p && p.get && !p.get.auto) return callAccessor(p, obj, 'get');
      if (p && p.delegate) return lazyGet(obj, p);
      if (obj.f.has(n)) { const v = obj.f.get(n); if (v === UNSET) throwKt('UninitializedPropertyAccessException' in EXC ? 'UninitializedPropertyAccessException' : 'IllegalStateException', `lateinit property ${n} has not been initialized`); return v; }
      if (isExc(obj.cls) && (n === 'message' || n === 'cause')) return obj.f.get(n) ?? null;
      if (obj.cls.companion && findProp(obj.cls.companion, n)) return getMember(objectOf(obj.cls.companion), n, e);
      const ms = findMethods(obj.cls, n);
      if (ms.length) return new KFn({ name: n, native: argv => invoke(virt(obj, ms[0]), argv, obj, null) });
      if (obj.cls.isEnum && (n === 'name' || n === 'ordinal')) return obj.f.get(n);
      const ext = extProp(n, obj);
      if (ext) return ext;
      return lib.objProp(obj, n, e) ?? fail(`unresolved reference '${n}'.`);
    }
    const ext = extProp(n, obj);
    if (ext !== undefined) return ext;
    return lib.getProp(obj, n, e);
  }
  function setMember(obj, n, v, e) {
    if (obj instanceof KObj) {
      const p = findProp(obj.cls, n);
      if (p) {
        if (!p.mutable && !inInitOf(obj)) fail("'val' cannot be reassigned.");
        if (p.set && p.set.mods && p.set.mods.has('private') && frame().self !== obj) fail(`cannot assign to '${n}': the setter is private in '${obj.cls.name}'.`);
        if (p.set && !p.set.auto) { callAccessor(p, obj, 'set', v); return; }
        obj.f.set(n, conv(v, p.type, e && e.r, 'assignment'));
        return;
      }
      if (obj.f.has(n)) { obj.f.set(n, v); return; }
      fail(`unresolved reference '${n}'.`);
    }
    lib.setProp(obj, n, v, e);
  }
  const inInitOf = o => frames.some(f => f.initOf === o);
  /** a property's get() or set(value), with field as its backing field */
  function callAccessor(p, obj, which, value) {
    const acc = p[which];
    const fn = new KFn({ name: (which === 'get' ? 'get-' : 'set-') + p.name, params: which === 'set' ? [{ name: acc.param || 'value', type: p.type }] : [], ret: which === 'get' ? p.type : null,
      body: acc.body, expr: acc.expr, cls: p.cls, accessor: true, field: { obj, name: p.name }, line: (acc.body || acc.expr || p).line });
    const r = invoke(fn, which === 'set' ? [value] : [], obj, null);
    return which === 'get' ? r : undefined;
  }
  /** val x by lazy { … } */
  function lazyGet(obj, p) {
    const key = '$lazy$' + p.name, store = obj ? obj.f : lazyTop;
    if (!store.has(key)) { const d = p.delegate; if (!(d.k === 'call' && d.f.k === 'name' && d.f.n === 'lazy')) fail('only by lazy { … } delegates are supported here.'); store.set(key, callFn(rval(d.args[0].e), [])); }
    return store.get(key);
  }
  const lazyTop = new Map();
  /** an extension function or property called on v */
  function extFor(name, v, argc) {
    for (const fn of extFuns.get(name) || []) if ((argc === undefined || fn.params.length === argc || fn.params.some(p => p.def || p.vararg)) && recvMatches(v, fn.recv)) return fn;
    return null;
  }
  function extProp(n, v) {
    for (const p of extProps.get(n) || []) if (recvMatches(v, p.recv)) return callAccessorExt(p, v);
    return undefined;
  }
  const extProps = new Map();
  function callAccessorExt(p, v) {
    const acc = p.get || fail(`extension property '${p.name}' has no getter.`);
    const fn = new KFn({ name: 'get-' + p.name, params: [], ret: p.type, body: acc.body, expr: acc.expr, cls: null, line: p.line });
    return invoke(fn, [], v, null);
  }
  function recvMatches(v, t) {
    if (!t) return true;
    if (v === null) return !!t.nul;
    return isInstance(v, t) || /^[A-Z]$/.test(t.n) || (frame() && false);
  }
  /** v is T */
  function isInstance(v, t) {
    if (v === null || v === undefined) return !!(t && t.nul);
    const n = t.n, k = kindOf(v);
    if (n === 'Any') return true;
    if (k !== 'ref') return n === k || (n === 'Comparable' && k !== 'Boolean') || (n === 'Number' && NUMS.has(k)) || (n === 'CharSequence' && k === 'String');
    if (v instanceof KObj) {
      for (let c = v.cls; c; c = c.base) { if (c.name === n) return true; if ((c.ifaces || []).some(x => x.name === n || ifaceExt(x, n))) return true; }
      if (n === 'Comparable') return !!findMethods(v.cls, 'compareTo').length;
      if (n === 'Throwable') return isExc(v.cls);
      return false;
    }
    if (v instanceof KFn) return n === 'fn' || n === 'Function';
    return lib.isInstance(v, n);
  }
  const ifaceExt = (c, n) => (c.ifaces || []).some(x => x.name === n || ifaceExt(x, n));

  /* ---- places: get(), set(v), type ---- */
  function place(e) {
    switch (e.k) {
      case 'name': {
        const r = lookupVar(e.n);
        if (r) return { get: () => { if (r.v === UNSET) fail(`variable '${e.n}' must be initialized.`); return r.v; }, set: v => { if (!r.mutable && r.v !== UNSET) fail("'val' cannot be reassigned."); r.v = v; }, type: r.t, local: r, d: e.n };
        const f = frame();
        if (f && f.field && e.n === 'field') return { get: () => f.field.obj ? f.field.obj.f.get(f.field.name) : topProps.get(f.field.name).v, set: v => { if (f.field.obj) f.field.obj.f.set(f.field.name, v); else topProps.get(f.field.name).v = v; }, type: null };
        const self = f && f.self;
        if (self instanceof KObj && (findProp(self.cls, e.n) || self.f.has(e.n))) return { get: () => getMember(self, e.n, e), set: v => setMember(self, e.n, v, { r: null }), type: (findProp(self.cls, e.n) || {}).type, d: e.n };
        for (let c = f && f.cls; c; c = c.outer) {
          if (c.companion && findProp(c.companion, e.n)) { const o = objectOf(c.companion); return { get: () => getMember(o, e.n, e), set: v => setMember(o, e.n, v, {}), type: findProp(c.companion, e.n).type }; }
          if (c.isObject && findProp(c, e.n)) { const o = objectOf(c); return { get: () => getMember(o, e.n, e), set: v => setMember(o, e.n, v, {}), type: findProp(c, e.n).type }; }
        }
        const tp = topProps.get(e.n);
        if (tp) return { get: () => topGet(tp), set: v => { if (!tp.p.mutable) fail("'val' cannot be reassigned."); if (tp.p.set && !tp.p.set.auto) { callTopSet(tp, v); return; } tp.v = conv(v, tp.p.type, null, 'assignment'); }, type: tp.p.type, d: e.n, top: tp };
        fail(`unresolved reference '${e.n}'.`);
      }
      // falls through
      case 'member': {
        const cls = typeRef(e.e);
        if (cls) { const o = cls.isObject ? objectOf(cls) : cls.companion ? objectOf(cls.companion) : null; if (o) return { get: () => getMember(o, e.n, e), set: v => setMember(o, e.n, v, e), type: (findProp(o.cls, e.n) || {}).type }; }
        const obj = rval(e.e);
        if (obj === null) { if (e.safe) return { get: () => null, set: () => {}, type: null }; nullReceiver(e.e); }
        return { get: () => getMember(obj, e.n, e), set: v => setMember(obj, e.n, v, e), type: obj instanceof KObj && findProp(obj.cls, e.n) ? findProp(obj.cls, e.n).type : null, d: srcOf(e) };
      }
      case 'index': {
        const c = rval(e.e);
        if (c === null) nullReceiver(e.e);
        const ks = e.args.map(x => rval(x));
        if (c instanceof KObj) {
          const g = findMethods(c.cls, 'get'), s = findMethods(c.cls, 'set');
          return { get: () => (g.length ? invoke(virt(c, g[0]), ks, c, null) : fail(`unresolved reference 'get'.`)), set: v => (s.length ? invoke(virt(c, s[0]), [...ks, v], c, null) : fail(`unresolved reference 'set'.`)), type: null };
        }
        return { get: () => lib.getIndex(c, ks, e), set: v => lib.setIndex(c, ks, v, e), type: lib.elemType(c), d: srcOf(e), coll: c, key: ks[0] };
      }
      case 'paren': return place(e.e);
      case 'this': return { get: () => rval(e), set: () => fail('variable expected.'), type: null };
    }
    fail('variable expected.');
  }
  /** a call on a nullable value that is null: the compiler would have asked for ?. or !! */
  function nullReceiver(e) {
    const r = e && e.k === 'name' ? lookupVar(e.n) : null;
    fail(`only safe (?.) or non-null asserted (!!.) calls are allowed on a nullable receiver of type '${r && r.t ? typeText({ ...r.t, nul: true }) : 'kotlin.Nothing?'}'.`);
  }
  /** a top-level property, initialized on first use */
  function topGet(tp) {
    if (tp.p.delegate) return lazyGet(null, tp.p);
    if (tp.p.get && !tp.p.get.auto) { const fn = new KFn({ name: 'get-' + tp.p.name, params: [], ret: tp.p.type, body: tp.p.get.body, expr: tp.p.get.expr, cls: null, accessor: true, field: { obj: null, name: tp.p.name }, line: tp.p.line }); return invoke(fn, [], null, null); }
    if (tp.v === UNSET) { if (tp.p.mods.has('lateinit')) throwKt('IllegalStateException', `lateinit property ${tp.p.name} has not been initialized`); }
    return tp.v;
  }
  function callTopSet(tp, v) { const fn = new KFn({ name: 'set-' + tp.p.name, params: [{ name: tp.p.set.param || 'value', type: tp.p.type }], body: tp.p.set.body, expr: tp.p.set.expr, cls: null, accessor: true, field: { obj: null, name: tp.p.name }, line: tp.p.line }); invoke(fn, [v], null, null); }
  /** a class or object that a name (or A.B) stands for, else null */
  function typeRef(e) {
    if (e.k === 'name') { if (lookupVar(e.n) || topProps.has(e.n)) return null; const self = frame() && frame().self; if (self instanceof KObj && findProp(self.cls, e.n)) return null; const c = findClass(e.n); return c || null; }
    if (e.k === 'member') { const outer = typeRef(e.e); if (outer && outer.nested && outer.nested.has(e.n)) return outer.nested.get(e.n); if (outer && outer.companion && outer.companion.name === e.n) return outer.companion; }
    return null;
  }
  /** an object declaration's single instance (created on first use, like Kotlin) */
  function objectOf(c) {
    if (!c.instance) { const o = new KObj(c); c.instance = o; initObj(c, o, [], null); }
    return c.instance;
  }

  /* ---- expressions ---- */
  const srcOf = e => {
    switch (e.k) {
      case 'name': return e.n;
      case 'member': return srcOf(e.e) + (e.safe ? '?.' : '.') + e.n;
      case 'index': return srcOf(e.e) + '[' + e.args.map(srcOf).join(', ') + ']';
      case 'call': return srcOf(e.f) + '(…)';
      case 'lit': return e.kind === 'string' ? JSON.stringify(e.v) : e.kind === 'char' ? "'" + e.v + "'" : String(e.v);
      case 'this': return 'this';
      default: return 'expression';
    }
  };
  function rval(e) {
    const v = eval1(e);
    if (v === UNSET) fail(`variable '${srcOf(e)}' must be initialized.`);
    return v;
  }
  function eval1(e) {
    switch (e.k) {
      case 'lit':
        switch (e.kind) {
          case 'int': return Number(e.v);
          case 'long': return BigInt(e.v);
          case 'double': return new D(e.v);
          case 'float': return new D(e.v, true);
          case 'char': return KCH(e.v.charCodeAt(0));
          default: return e.v;
        }
      case 'const': return e.v;
      case 'tmpl': return e.parts.map(p => (typeof p === 'string' ? p : toStr(rval(p)))).join('');
      case 'paren': return eval1(e.e);
      case 'name': {
        const r = lookupVar(e.n);
        if (r) return r.v;
        const f = frame();
        if (f && f.field && e.n === 'field') return place(e).get();
        if (e.n === 'it' && f && f.itVal !== undefined) return f.itVal;
        const self = f && f.self;
        if (self instanceof KObj && (findProp(self.cls, e.n) || self.f.has(e.n))) return getMember(self, e.n, e);
        for (let c = f && f.cls; c; c = c.outer) {
          if (c.companion && findProp(c.companion, e.n)) return getMember(objectOf(c.companion), e.n, e);
          if (c.isObject && findProp(c, e.n)) return getMember(objectOf(c), e.n, e);
        }
        if (topProps.has(e.n)) return topGet(topProps.get(e.n));
        const c = findClass(e.n);
        if (c && c.isObject) return objectOf(c);
        if (c && c.companion) return objectOf(c.companion);
        if (c && c.isEnum) return { enumClass: c };
        if (self instanceof KObj && findMethods(self.cls, e.n).length) return new KFn({ name: e.n, native: argv => invoke(virt(self, findMethods(self.cls, e.n)[0]), argv, self, null) });
        if (topFuns.has(e.n)) { const fs = topFuns.get(e.n); return new KFn({ name: e.n, native: argv => invoke(pick(fs, argv, e.n), argv, null, null) }); }
        return lib.global(e.n, e) ?? fail(`unresolved reference '${e.n}'.`);
      }
      case 'member': {
        if (e.e.k === 'name' && lib.isStaticHolder(e.e.n) && !lookupVar(e.e.n) && !findClass(e.e.n)) return lib.staticMember(e.e.n, e.n, e);
        const cls = typeRef(e.e);
        if (cls) {
          if (cls.isEnum) { const en = cls.entries.find(x => x.f.get('name') === e.n); if (en) return en; }
          if (cls.isObject) return getMember(objectOf(cls), e.n, e);
          if (cls.companion) return getMember(objectOf(cls.companion), e.n, e);
          if (cls.isEnum && e.n === 'entries') return lib.listOf(cls.entries.slice());
          fail(`unresolved reference '${e.n}'.`);
        }
        const obj = rval(e.e);
        if (obj && obj.enumClass) { const en = obj.enumClass.entries.find(x => x.f.get('name') === e.n); if (en) return en; if (e.n === 'entries') return lib.listOf(obj.enumClass.entries.slice()); fail(`unresolved reference '${e.n}'.`); }
        if (obj === null || obj === undefined) { if (e.safe) return null; nullReceiver(e.e); }
        return getMember(obj, e.n, e);
      }
      case 'index': return place(e).get();
      case 'this': { const f = frame(); const s = f && (f.self !== undefined ? f.self : null); if (s === null || s === undefined) fail("'this' is not defined in this context."); return s; }
      case 'super': fail("'super' is not an expression, it can only be used on the left-hand side of a dot ('.').");
      // falls through
      case 'un': {
        const v = rval(e.e);
        if (e.op === '!') { if (typeof v !== 'boolean') { const op = userOp(v, 'not', []); if (op !== undefined) return op; fail(`unresolved reference 'not' for operator '!' on '${ktType(v)}'.`); } return !v; }
        if (e.op === '-') { if (v instanceof KObj) { const op = userOp(v, 'unaryMinus', []); if (op !== undefined) return op; } return arith('-', 0, v, true); }
        return v;
      }
      case 'incdec': {
        const p = place(e.e), old = p.get();
        let nv;
        if (old instanceof KObj) nv = userOp(old, e.op === '++' ? 'inc' : 'dec', []);
        else if (old instanceof KC) nv = KCH((old.c + (e.op === '++' ? 1 : -1)) & 0xffff);
        else nv = arith(e.op === '++' ? '+' : '-', old, 1);
        if (p.local && !p.local.mutable) fail("'val' cannot be reassigned.");
        p.set(nv);
        return e.prefix ? nv : old;
      }
      case 'bin': return binop(e.op, e);
      case 'logic': {
        const a = rval(e.l);
        if (typeof a !== 'boolean') fail(`argument type mismatch: actual type is '${ktType(a)}', but 'kotlin.Boolean' was expected.`);
        if (e.op === '&&' ? !a : a) return a;
        const b = rval(e.r);
        if (typeof b !== 'boolean') fail(`argument type mismatch: actual type is '${ktType(b)}', but 'kotlin.Boolean' was expected.`);
        return b;
      }
      case 'elvis': { const a = rval(e.a); return a !== null ? a : rval(e.b); }
      case 'in': { const r = rval(e.r), x = rval(e.e); const has = r instanceof KObj ? userOp(r, 'contains', [x]) === true : lib.contains(r, x); return e.neg ? !has : has; }
      case 'is': { const v = rval(e.e); const ok = isInstance(v, e.type); return e.neg ? !ok : ok; }
      case 'as': {
        const v = rval(e.e);
        if (isInstance(v, e.type) || (v === null && e.type.nul)) return v;
        if (e.safe) return null;
        if (v === null) throwKt('NullPointerException', `null cannot be cast to non-null type ${typeText(e.type)}`);
        throwKt('ClassCastException', `class ${lib.javaClass(v)} cannot be cast to class ${lib.javaClassOfType(e.type)}`);
      }
      // falls through
      case 'notnull': { const v = rval(e.e); if (v === null) npe(); return v; }
      case 'infix': return infix(e);
      case 'call': return call(e);
      case 'lambda': return lambda(e);
      case 'funRef': return funRef(e);
      case 'if': {
        const c = rval(e.cond);
        if (typeof c !== 'boolean') fail(`condition type mismatch: inferred type is '${ktType(c)}' but 'kotlin.Boolean' was expected.`);
        const b = c ? e.a : e.b;
        if (!b) return UNIT;
        return valueOfBlock(b);
      }
      case 'when': return whenExpr(e);
      case 'try': return tryExpr(e);
      case 'throw': { const v = rval(e.e); if (!(v instanceof KObj) || !isExc(v.cls)) fail(`type mismatch: inferred type is '${ktType(v)}' but 'kotlin.Throwable' was expected.`); throw new Thrown(v, line); }
      case 'return': { const v = e.e ? rval(e.e) : UNIT; throw new Jump('return', e.label, v, null); }
      case 'break': throw new Jump('break', e.label);
      case 'continue': throw new Jump('continue', e.label);
      case 'objectExpr': { const c = makeClass(e.decl, frame() && frame().cls); linkSupers(c); const o = new KObj(c); o.env = capture(); initObj(c, o, [], null); return o; }
    }
    fail('cannot evaluate ' + e.k);
  }
  /** an if / when branch's value: its last expression */
  function valueOfBlock(b) {
    return scoped(() => {
      hoist(b.items);
      let v = UNIT;
      for (const s of b.items) v = exec(s, true);
      return v === undefined ? UNIT : v;
    });
  }
  /** a user operator: plus, minus, times, compareTo, contains… on an object (or an extension) */
  function userOp(v, name, argv) {
    if (v instanceof KObj) { const ms = findMethods(v.cls, name); if (ms.length) return invoke(virt(v, ms[0]), argv, v, null); }
    const ext = extFor(name, v, argv.length);
    if (ext) return invoke(ext, argv, v, null);
    return undefined;
  }

  /* ---- arithmetic: Int wraps at 32 bits, Long at 64; Int with Long is Long, with Double is Double; Char + Int is a Char ---- */
  function arith(op, a, b, unaryMinus = false) {
    const ka = kindOf(a), kb = kindOf(b);
    if (ka === 'Char' || kb === 'Char') {
      if (ka === 'Char' && kb === 'Int' && (op === '+' || op === '-')) return KCH((a.c + (op === '+' ? b : -b)) & 0xffff);
      if (ka === 'Char' && kb === 'Char' && op === '-') return a.c - b.c;
      fail(`unresolved reference. None of the following candidates is applicable because of a receiver type mismatch: operator '${op}' on '${ktType(a)}' and '${ktType(b)}'.`.replace('unresolved reference. None', 'none'));
    }
    if (!NUMS.has(ka) || !NUMS.has(kb)) fail(unaryMinus ? `unresolved reference 'unaryMinus' for '${ktType(b)}'.` : `none of the following candidates is applicable: operator '${op}' on '${ktType(a)}' and '${ktType(b)}'.`);
    if (ka === 'Double' || kb === 'Double' || ka === 'Float' || kb === 'Float') {
      const f = (ka === 'Float' || (ka !== 'Double')) && (kb === 'Float' || kb !== 'Double');
      const x = typeof a === 'bigint' ? Number(a) : typeof a === 'number' ? a : a.v, y = typeof b === 'bigint' ? Number(b) : typeof b === 'number' ? b : b.v;
      let r;
      switch (op) { case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break; case '%': r = x % y; break; }
      return new D(r, f);
    }
    if (ka === 'Long' || kb === 'Long') {
      const x = BigInt(a), y = BigInt(b);
      if ((op === '/' || op === '%') && y === 0n) throwKt('ArithmeticException', '/ by zero');
      let r;
      switch (op) { case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break; case '%': r = x % y; break; }
      return BigInt.asIntN(64, r);
    }
    if ((op === '/' || op === '%') && b === 0) throwKt('ArithmeticException', '/ by zero');
    switch (op) {
      case '+': return (a + b) | 0;
      case '-': return (a - b) | 0;
      case '*': return Math.imul(a, b);
      case '/': return (a / b) | 0;
      case '%': { const r = a % b; return Object.is(r, -0) ? 0 : r; }
    }
    fail('unknown operator ' + op);
  }
  function binop(op, e) {
    const a = rval(e.l);
    if (op === '==' || op === '!=') { const b = rval(e.r); eqCheck(a, b); const eq = equals(a, b); return op === '==' ? eq : !eq; }
    if (op === '===' || op === '!==') { const b = rval(e.r); const same = a === b || (kindOf(a) !== 'ref' && kindOf(a) === kindOf(b) && equals(a, b) && typeof a !== 'object') || (a instanceof D && b instanceof D && a.v === b.v && false); return op === '===' ? same : !same; }
    const b = rval(e.r);
    if (op === '..' || op === '..<') {
      if (a instanceof KObj) { const r = userOp(a, op === '..' ? 'rangeTo' : 'rangeUntil', [b]); if (r !== undefined) return r; }
      return lib.range(a, b, op === '..<');
    }
    if (['<', '>', '<=', '>='].includes(op)) {
      const c = compareVals(a, b, true);
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    if (op === '+' && typeof a === 'string') return a + toStr(b);
    if (op === '+' && a instanceof KC && typeof b === 'string') return String.fromCharCode(a.c) + b;
    const names = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'div', '%': 'rem' };
    if (a instanceof KObj || (kindOf(a) === 'ref' && !(a instanceof D))) {
      const r = userOp(a, names[op], [b]);
      if (r !== undefined) return r;
      const lr = lib.collOp(a, op, b);
      if (lr !== undefined) return lr;
      fail(`unresolved reference '${names[op]}' for operator '${op}'.`);
    }
    if (typeof b === 'string' && op === '+') fail(`none of the following candidates is applicable: ${ktType(a)}.plus(kotlin.String) (convert it first: ${srcOf(e.l)}.toString() + …, or use a string template "\${${srcOf(e.l)}}…")`);
    return arith(op, a, b);
  }
  /** == between an Int and a Long (or a Double) does not compile in Kotlin */
  function eqCheck(a, b) {
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb && ka !== 'ref' && kb !== 'ref' && ka !== 'null' && kb !== 'null') fail(`operator '==' cannot be applied to '${ktType(a)}' and '${ktType(b)}'.`);
  }
  /** compareTo: numbers (an Int with a Long or a Double is fine), chars, strings (by UTF-16, as Java), the program's compareTo */
  function compareVals(a, b, strict) {
    const ka = kindOf(a), kb = kindOf(b);
    if (NUMS.has(ka) && NUMS.has(kb)) {
      if ((ka === 'Long' || kb === 'Long') && !(a instanceof D) && !(b instanceof D)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
      const x = typeof a === 'object' ? a.v : Number(a), y = typeof b === 'object' ? b.v : Number(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (ka === 'Char' && kb === 'Char') return Math.sign(a.c - b.c);
    if (ka === 'String' && kb === 'String') return a < b ? -1 : a > b ? 1 : 0;
    if (ka === 'Boolean' && kb === 'Boolean') return a === b ? 0 : a ? 1 : -1;
    if (a instanceof KObj) {
      if (a.cls.isEnum && b instanceof KObj && b.cls === a.cls) return Math.sign(a.f.get('ordinal') - b.f.get('ordinal'));
      const ms = findMethods(a.cls, 'compareTo');
      if (ms.length) return Number(invoke(virt(a, ms[0]), [b], a, null));
      if (strict) fail(`unresolved reference 'compareTo' (a ${a.cls.name} cannot be compared: implement Comparable<${a.cls.name}>).`);
      throwKt('ClassCastException', `class ${a.cls.name} cannot be cast to class java.lang.Comparable`);
    }
    const r = lib.compareLib(a, b);
    if (r !== undefined) return r;
    if (a === null || b === null) npe();
    fail(`none of the following candidates is applicable: compareTo on '${ktType(a)}' and '${ktType(b)}'.`);
  }
  const compare = (a, b) => compareVals(a, b, false);
  /** equals(): numbers of one kind by value, strings, data classes and collections by content, objects by identity */
  function equals(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    if (a instanceof KObj) {
      const ms = findMethods(a.cls, 'equals').filter(m => m.params.length === 1);
      if (ms.length) return invoke(virt(a, ms[0]), [b], a, null) === true;
      if (a.cls.data) return b instanceof KObj && b.cls === a.cls && a.cls.pc.filter(p => p.prop).every(p => equals(a.f.get(p.name), b.f.get(p.name)));
      return a === b;
    }
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) return false;
    if (a instanceof D) return a.v === b.v || (Number.isNaN(a.v) && Number.isNaN(b.v));
    if (ka !== 'ref') return a === b;
    return lib.libEquals(a, b);
  }
  /** hashCode(), as the JVM computes it (HashMap's order depends on it) */
  function hashOf(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v | 0;
    if (typeof v === 'bigint') return Number(BigInt.asIntN(32, v ^ (BigInt.asUintN(64, v) >> 32n)));
    if (v instanceof D) { if (v.f) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v.v); return b.getInt32(0); } const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v.v === 0 && !Object.is(v.v, -0) ? 0 : Number.isNaN(v.v) ? NaN : v.v); return b.getInt32(0) ^ b.getInt32(4); }
    if (v instanceof KC) return v.c;
    if (typeof v === 'boolean') return v ? 1231 : 1237;
    if (typeof v === 'string') { let h = 0; for (let i = 0; i < v.length; i++) h = (Math.imul(h, 31) + v.charCodeAt(i)) | 0; return h; }
    if (v instanceof KObj) {
      const ms = findMethods(v.cls, 'hashCode').filter(m => m.params.length === 0);
      if (ms.length) return Number(invoke(virt(v, ms[0]), [], v, null)) | 0;
      if (v.cls.data) { let h = 0, first = true; for (const p of v.cls.pc.filter(x => x.prop)) { h = first ? hashOf(v.f.get(p.name)) : (Math.imul(h, 31) + hashOf(v.f.get(p.name))) | 0; first = false; } return h; }
      return identityHash(v);
    }
    return lib.libHash(v);
  }
  const identityHash = o => (0x1b6d3586 + idOf(o) * 0x2f5a1) | 0;
  /** toString(): the program's override, data classes as Point(x=1, y=2), else Name@hash */
  function toStr(v) {
    if (v === null || v === undefined) return 'null';
    if (v === UNIT) return 'kotlin.Unit';
    if (v instanceof KObj) {
      const ms = findMethods(v.cls, 'toString').filter(m => m.params.length === 0);
      if (ms.length) { const r = invoke(virt(v, ms[0]), [], v, null); return r === null ? 'null' : String(r); }
      if (v.cls.isEnum || (v.cls.base && v.cls.base.isEnum)) return v.f.get('name');
      if (v.cls.data) return v.cls.name + '(' + v.cls.pc.filter(p => p.prop).map(p => p.name + '=' + toStr(v.f.get(p.name))).join(', ') + ')';
      if (isExc(v.cls)) { const m = getMember(v, 'message'); return fullName(v.cls) + (m !== null && m !== undefined ? ': ' + toStr(m) : ''); }
      if (v.cls.kind === 'anon') return 'MainKt$main$1@' + (identityHash(v) >>> 0).toString(16);
      return fullName(v.cls) + '@' + (identityHash(v) >>> 0).toString(16);
    }
    if (v instanceof D) return javaDouble(v.v, v.f);
    if (v instanceof KC) return String.fromCharCode(v.c);
    if (v instanceof KFn) return v.ref ? 'fun ' + v.name + '(…)' : '(…) -> …';
    if (v && v.enumClass) return 'class ' + v.enumClass.name;
    return lib.toStr(v);
  }

  /* ---- infix calls: to, until, downTo, step, shl, and… and the program's own infix funs ---- */
  function infix(e) {
    const a = rval(e.l), b = rval(e.r);
    const user = a instanceof KObj ? findMethods(a.cls, e.name) : [];
    if (user.length) return invoke(virt(a, user[0]), [b], a, null);
    const ext = extFor(e.name, a, 1);
    if (ext) return invoke(ext, [b], a, null);
    return lib.infix(e.name, a, b, e);
  }

  /* ---- calls ---- */
  function pick(fs, argv, name) {
    const ok = fs.filter(f => { const n = f.params.length, req = f.params.filter(p => !p.def && !p.vararg).length; return argv.length >= req && (argv.length <= n || f.params.some(p => p.vararg)); });
    if (!ok.length) fail(fs.length === 1 && argv.length < fs[0].params.length ? `no value passed for parameter '${fs[0].params[argv.length].name}'.` : fs.length === 1 ? `too many arguments for 'fun ${name}(${fs[0].params.map(p => p.name + ': ' + typeText(p.type)).join(', ')}): ${typeText(fs[0].ret || { n: 'Unit' })}'.` : `none of the following candidates is applicable for ${name}(…) with ${argv.length} argument${argv.length === 1 ? '' : 's'}.`);
    if (ok.length === 1) return ok[0];
    const score = f => f.params.reduce((s, p, k) => (k < argv.length && p.type ? s + (isInstance(argv[k], p.type) ? 2 : -5) : s), 0) - Math.abs(f.params.length - argv.length) * 0.1;
    return ok.reduce((best, f) => (score(f) > score(best) ? f : best));
  }
  /** the arguments, named ones put in their parameter's place */
  function bindArgs(fn, args) {
    if (!args.some(a => a.name)) return args.flatMap(a => (a.spread ? lib.toArray(rval(a.e)) : [rval(a.e)]));
    const out = [];
    const ps = fn.params || [];
    let k = 0;
    for (const a of args) {
      if (a.name) { const at = ps.findIndex(p => p.name === a.name); if (at < 0) fail(`no parameter with name '${a.name}' found.`); out[at] = rval(a.e); }
      else out[k++] = rval(a.e);
    }
    for (let j = 0; j < ps.length; j++) if (out[j] === undefined) out[j] = MISSING;
    return out;
  }
  const MISSING = Symbol('missing');
  function call(e) {
    const f = e.f;
    if (f.k === 'member') {
      // kotlin.math.sqrt(…), java.util.Collections.swap(…): a qualified name
      const dotted = x => (x.k === 'name' ? x.n : x.k === 'member' ? (() => { const d = dotted(x.e); return d && d + '.' + x.n; })() : null);
      const q = dotted(f.e);
      if (q && /^(kotlin|java)(\.|$)/.test(q) && !lookupVar(q.split('.')[0])) {
        const last = q.split('.').pop();
        if (/^[A-Z]/.test(last)) return call({ ...e, f: { ...f, e: { k: 'name', n: last, line: f.line } } });
        return call({ ...e, f: { k: 'name', n: f.n, line: f.line } });
      }
      // a call on a class or object: Math.max(…), Color.valueOf(…), Companion.create(…)
      if (f.e.k === 'name' && lib.isStaticHolder(f.e.n) && !lookupVar(f.e.n) && !findClass(f.e.n)) return lib.callStatic(f.e.n, f.n, e.args.map(a => rval(a.e)), e);
      const cls = typeRef(f.e);
      if (cls) {
        if (cls.isEnum && (f.n === 'values' || f.n === 'valueOf' || f.n === 'entries')) return lib.enumStatic(cls, f.n, e.args.map(a => rval(a.e)));
        const o = cls.isObject ? objectOf(cls) : cls.companion ? objectOf(cls.companion) : null;
        if (!o) fail(`unresolved reference '${f.n}'.`);
        return callMethod(o, f.n, e, f);
      }
      if (f.e.k === 'super') {
        const self = frame().self, base = frame().cls && (frame().cls.base || (frame().cls.ifaces || [])[0]);
        const argv = e.args.map(a => rval(a.e));
        if (base && !base.builtin) { const ms = findMethods(base, f.n); if (ms.length) return invoke(ms[0], argv, self, e); for (const it of frame().cls.ifaces || []) { const im = findMethods(it, f.n); if (im.length) return invoke(im[0], argv, self, e); } }
        return lib.objectMethod(self, f.n, argv, e, true);
      }
      const obj = rval(f.e);
      if (obj && obj.enumClass) return lib.enumStatic(obj.enumClass, f.n, e.args.map(a => rval(a.e)));
      if (obj === null || obj === undefined) {
        if (f.safe) return null;
        if (['toString', 'let', 'also', 'run', 'apply', 'takeIf', 'isNullOrEmpty', 'isNullOrBlank', 'orEmpty', 'equals', 'hashCode'].includes(f.n) || extFor(f.n, null)) { /* these take a null receiver */ } else nullReceiver(f.e);
      }
      return callMethod(obj, f.n, e, f);
    }
    if (f.k === 'name') {
      const r = lookupVar(f.n);
      if (r && !r.isFn) { const fn = r.v; if (!(fn instanceof KFn) && !(fn instanceof KObj)) fail(`expression '${f.n}' of type '${ktType(fn)}' cannot be invoked as a function.`); if (fn instanceof KObj) return callMethod(fn, 'invoke', e, f); return callFn(fn, bindArgs(fn, e.args), e); }
      if (r && r.isFn) return invoke(r.v, bindArgs(r.v, e.args), r.v.selfAt, e);
      const fr = frame();
      const self = fr && fr.self;
      // a method of this class (or an outer one), or of a companion
      if (self instanceof KObj) {
        const ms = findMethods(self.cls, f.n);
        if (ms.length) { const m = pick(ms, e.args, f.n); return invoke(virt(self, m), bindArgs(m, e.args), self, e); }
        const pv = findProp(self.cls, f.n) ? getMember(self, f.n, f) : undefined;
        if (pv instanceof KFn) return callFn(pv, bindArgs(pv, e.args), e);
        if (self.cls.isObject || true) { const ext = extFor(f.n, self, e.args.length); if (ext) return invoke(ext, bindArgs(ext, e.args), self, e); }
      }
      if (self !== null && self !== undefined && !(self instanceof KObj) && !topFuns.has(f.n) && !lib.isGlobal(f.n)) return callMethod(self, f.n, e, f);   // buildString { append(…) }: the receiver's method
      for (let c = fr && fr.cls; c; c = c.outer || c.base) if (c.isEnum && ['values', 'valueOf'].includes(f.n)) return lib.enumStatic(c, f.n, e.args.map(x => rval(x.e)));
      for (let c = fr && fr.cls; c; c = c.outer) {
        if (c.companion) { const ms = findMethods(c.companion, f.n); if (ms.length) return invoke(pick(ms, e.args, f.n), bindArgs(ms[0], e.args), objectOf(c.companion), e); }
        if (c.isObject) { const ms = findMethods(c, f.n); if (ms.length) return invoke(pick(ms, e.args, f.n), bindArgs(ms[0], e.args), objectOf(c), e); }
      }
      if (topFuns.has(f.n)) { const fs = topFuns.get(f.n); const m = pick(fs, e.args, f.n); return invoke(m, bindArgs(m, e.args), null, e); }
      if (topProps.has(f.n)) { const fn = topGet(topProps.get(f.n)); return callFn(fn, bindArgs(fn, e.args), e); }
      // a class: Point(1, 2) constructs one
      const c = findClass(f.n);
      if (c) {
        if (c.isAbstract || c.isInterface) fail(c.isInterface ? `interface '${c.name}' does not have constructors.` : `cannot create an instance of an abstract class.`);
        if (c.isObject) fail(`expression '${f.n}' of type '${c.name}' cannot be invoked as a function.`);
        if (c.isEnum) fail('enum types cannot be instantiated.');
        const argv = c.builtin ? e.args.map(a => rval(a.e)) : bindArgs({ params: c.ctors.length && !c.pc.length ? c.ctors[0].params : c.pc }, e.args);
        const o = new KObj(c);
        initObj(c, o, argv, e);
        return o;
      }
      return lib.callGlobal(f.n, e.args, e, { rval, rvalArgs: () => e.args.map(a => rval(a.e)), targs: f.targs });
    }
    const fn = rval(f);
    if (fn instanceof KObj) return callMethod(fn, 'invoke', e, f);
    if (!(fn instanceof KFn)) fail(`expression '${srcOf(f)}' of type '${ktType(fn)}' cannot be invoked as a function.`);
    return callFn(fn, bindArgs(fn, e.args), e);
  }
  /** obj.name(args): the class's method, an extension, a property holding a function, or the library's */
  function callMethod(obj, name, e, f) {
    if (obj instanceof KObj) {
      const ms = findMethods(obj.cls, name);
      if (ms.length) { const m = pick(ms, e.args, name); return invoke(virt(obj, m), bindArgs(m, e.args), obj, e); }
      const p = findProp(obj.cls, name);
      if (p) { const fn = getMember(obj, name, f); if (fn instanceof KFn) return callFn(fn, bindArgs(fn, e.args), e); }
    }
    const ext = extFor(name, obj, e.args.length);
    if (ext) return invoke(ext, bindArgs(ext, e.args), obj, e);
    const argv = e.args.flatMap(a => (a.spread ? lib.toArray(rval(a.e)) : [rval(a.e)]));
    if (obj instanceof KObj) { const r = lib.objectMethod(obj, name, argv, e); if (r !== undefined) return r; }
    if (obj instanceof KFn && name === 'invoke') return callFn(obj, argv, e);
    return lib.callMethod(obj, name, argv, e, f && f.targs);
  }
  /** calls a lambda or function reference */
  function callFn(fn, argv, e) {
    if (fn === null || fn === undefined) npe();
    if (!(fn instanceof KFn)) fail(`expression of type '${ktType(fn)}' cannot be invoked as a function.`);
    if (fn.native) return fn.native(argv, e);
    return invoke(fn, argv, fn.selfAt !== undefined ? fn.selfAt : null, e);
  }
  /** Runs a function, method, lambda or accessor */
  function invoke(fn, argv, self, e) {
    if (fn.native) return fn.native(argv, e);
    if (fn.isAbstract) fail(`'${fn.name}' has no body (it is abstract).`);
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls (java.lang.StackOverflowError).');
    const ps = fn.params || [], scope = new Map();
    const lam = fn.lambda;
    if (!lam && argv.length > ps.length && !ps.some(p => p.vararg)) fail(`too many arguments for '${fn.name}'.`);
    let itVal;
    if (lam && fn.implicitIt) { itVal = argv.length ? argv[0] : UNIT; if (argv.length) scope.set('it', { v: itVal, t: null, name: 'it' }); }
    ps.forEach((p, k) => {
      if (p.names) { const parts = lib.destructure(argv[k], p.names.length, componentOf); p.names.forEach((x, j) => { if (x.name !== '_') scope.set(x.name, { v: parts[j], t: x.type, name: x.name }); }); return; }
      if (p.vararg) { const rest = argv.slice(k); scope.set(p.name, { v: lib.varargArray(rest, p.type), t: null, name: p.name }); return; }
      let v = argv[k];
      if (v === undefined || v === MISSING) {
        if (!p.def) { if (lam) v = null; else fail(`no value passed for parameter '${p.name}'.`); }
        else v = withScope(scope, fn, self, () => rval(p.def));
      }
      if (p.name !== '_') scope.set(p.name, { v: p.type ? conv(v, p.type, e && e.args && e.args[k] ? e.args[k].e : null, 'argument') : v, t: p.type, name: p.name });
    });
    const label = fn.lambda ? 'lambda' : fn.accessor ? (fn.cls ? fn.cls.name + '.' : '') + fn.name.replace(/^get-/, '').replace(/^set-/, '') : fn.ctor ? fn.cls.name : (fn.cls && !fn.cls.isObject && fn.cls.kind !== 'companion' ? fn.cls.name + '.' : fn.cls && fn.cls.isObject ? fn.cls.name + '.' : '') + fn.name;
    const fr = { name: label, scopes: [scope], env: fn.env, fn, self, cls: fn.cls || (fn.lambda ? fn.envCls : null), initOf: fn.ctor ? self : null, field: fn.field, itVal, tps: fn.tps };
    if (fn.lambda) fr.self = fn.selfAt;
    const shown = ps.filter(p => p.name && scope.has(p.name)).map(p => p.name + '=' + brief(scope.get(p.name).v));
    if (self instanceof KObj && !fn.lambda && !fn.ctor && fn.recv) shown.unshift('this=' + brief(self));
    const visible = !fn.accessor || fn.body;
    if (visible) stack.push({ name: label, args: (itVal !== undefined && itVal !== UNIT ? ['it=' + brief(itVal)] : shown).join(', ').slice(0, 70) });
    frames.push(fr);
    try {
      let v;
      if (fn.expr) { if (!fn.lambda) step(fn.expr.bodyLine || fn.expr.line || fn.line); v = rval(fn.expr); }
      else if (fn.body) {
        if (fn.lambda) v = runLambdaBody(fn.body);
        else { runBody(fn.body); v = UNIT; if (fn.ret && fn.ret.n !== 'Unit' && !fn.ctor && !fn.accessor) fail(`missing return statement in '${fn.name}' (a function with a block body must return its value: return …).`); }
      } else v = UNIT;
      return finish(fn, v, e);
    } catch (err) {
      if (err instanceof Jump && err.k === 'return') {
        // return (in a fun), return@label (in a lambda): a plain return in a lambda leaves the fun around it
        if (fn.lambda && !err.label) { if (!fn.ownerFrame || !frames.includes(fn.ownerFrame)) fail("'return' is not allowed here."); throw err; }
        if (fn.lambda && err.label && err.label !== fn.label) throw err;
        if (!fn.lambda && err.label && err.label !== fn.name) throw err;
        return finish(fn, err.v, e, true);
      }
      if (err instanceof Jump && (err.k === 'break' || err.k === 'continue') && fn.lambda) fail(`'${err.k}' is not allowed here (only in a loop, not in a lambda).`);
      throw err;
    } finally {
      if (fn.isMain) finalVars = captureVars(fr);
      frames.pop();
      if (visible) stack.pop();
    }
  }
  function finish(fn, v, e, returned) {
    if (fn.lambda || fn.ctor) return v;
    if (fn.ret && fn.ret.n !== 'Unit') { if (v === UNIT && fn.body) fail(`return type mismatch: expected '${typeText(fn.ret)}', actual 'kotlin.Unit'.`); return conv(v, fn.ret, null, 'return'); }
    if (fn.ret && fn.ret.n === 'Unit' && returned && v !== UNIT && fn.body) fail(`return type mismatch: expected 'kotlin.Unit', actual '${ktType(v)}'.`);
    return fn.ret || fn.body ? (fn.body && !fn.expr ? UNIT : v) : v;
  }
  const withScope = (scope, fn, self, f2) => { frames.push({ name: fn.name, scopes: [scope], env: fn.env, fn, self, cls: fn.cls, hidden: true }); try { return f2(); } finally { frames.pop(); } };
  /** a lambda's value: its last expression */
  function runLambdaBody(b) {
    hoist(b.items);
    let v = UNIT;
    for (const s of b.items) v = exec(s, true);
    return v === undefined ? UNIT : v;
  }
  function runBody(b) {
    hoist(b.items);
    for (const s of b.items) exec(s);
  }
  /** local funs can be called before their declaration */
  function hoist(items) {
    const scope = frame().scopes.at(-1);
    for (const s of items) if (s.k === 'localFun') {
      const m = s.fn, f = frame();
      const fn = new KFn({ ...funFn(m, f.cls), env: capture(), selfAt: f.self, localFn: true });
      fn.cls = f.cls;
      if (m.recv) { addExt(fn); continue; }
      scope.set(m.name, { v: fn, name: m.name, isFn: true, hidden: true });
    }
  }
  const capture = () => { const f = frame(); return f ? [...[...f.scopes].reverse(), ...(f.env || [])] : []; };
  function lambda(e) {
    const f = frame();
    const implicitIt = e.params === null;
    return new KFn({ name: 'lambda', params: implicitIt ? [] : e.params, body: e.body, lambda: true, implicitIt, env: capture(), selfAt: f ? f.self : null, envCls: f && f.cls,
      ownerFrame: f && !f.fn?.lambda ? f : f && f.ownerFrame ? f.ownerFrame : (f && f.fn && f.fn.ownerFrame) || f, label: e.label, line: e.line });
  }
  /** ::foo, String::length, obj::method, ::Person */
  function funRef(e) {
    if (e.recv === null) {
      if (topFuns.has(e.name)) { const fs = topFuns.get(e.name); return new KFn({ name: e.name, ref: true, native: argv => invoke(pick(fs, argv.map(() => ({})), e.name), argv, null, null) }); }
      const r = lookupVar(e.name);
      if (r && r.isFn) return new KFn({ name: e.name, ref: true, native: argv => invoke(r.v, argv, r.v.selfAt, null) });
      const c = findClass(e.name);
      if (c) return new KFn({ name: e.name, ref: true, native: argv => { const o = new KObj(c); initObj(c, o, argv, null); return o; } });
      fail(`unresolved reference '${e.name}'.`);
    }
    const cls = e.recv.k === 'name' ? findClass(e.recv.n) : null;
    if (cls || (e.recv.k === 'name' && /^[A-Z]/.test(e.recv.n) && !lookupVar(e.recv.n))) {      // Type::member: the receiver is the first argument
      return new KFn({ name: e.name, ref: true, native: ([x, ...rest]) => (x instanceof KObj && findProp(x.cls, e.name) && !rest.length ? getMember(x, e.name, e) : callMethod(x, e.name, { args: rest.map(v => ({ e: { k: 'const', v } })) }, null)) });
    }
    const obj = rval(e.recv);
    return new KFn({ name: e.name, ref: true, native: argv => callMethod(obj, e.name, { args: argv.map(v => ({ e: { k: 'const', v } })) }, null) });
  }
  /** componentN of a data class (or a Pair, a Map.Entry…), for val (a, b) = … */
  function componentOf(v, k) {
    if (v instanceof KObj) {
      const ms = findMethods(v.cls, 'component' + (k + 1));
      if (ms.length) return invoke(virt(v, ms[0]), [], v, null);
      if (v.cls.data) { const p = v.cls.pc.filter(x => x.prop)[k]; if (!p) fail(`destructuring declaration initializer of type ${v.cls.name} must have a 'component${k + 1}()' function.`); return v.f.get(p.name); }
      fail(`destructuring declaration initializer of type ${v.cls.name} must have a 'component${k + 1}()' function.`);
    }
    return lib.component(v, k);
  }

  /* ---- objects: the supertype first, then this class's property initializers and init blocks, in order ---- */
  function linkSupers(c) {
    if (!c.decl) return;
    for (const s of c.decl.supers) {
      const bc = findClass(s.type.n) || nested(c.outer, s.type.n);
      if (!bc) { if (['Comparable', 'Comparator', 'Iterable', 'Cloneable', 'Any'].includes(s.type.n)) { c.ifaces.push({ name: s.type.n, methods: new Map(), props: new Map(), ifaces: [] }); continue; } fail(`unresolved reference '${s.type.n}'.`, c.decl.line); }
      if (bc.isInterface) { c.ifaces.push(bc); continue; }
      if (!bc.open && !bc.builtin && !bc.isEnum) fail(`this type is final, so it cannot be extended.`, c.decl.line);
      c.base = bc; c.superArgs = s.args || [];
      if (s.args === null && !bc.isInterface && !c.ctors.length) fail(`this type has a constructor, so it must be initialized here.`, c.decl.line);
    }
  }
  function initObj(c, o, argv, e) {
    if (c.builtin) { o.f.set('message', argv[0] === undefined ? null : argv[0] instanceof KObj ? toStr(argv[0]) : argv[0]); o.f.set('cause', argv.find(x => x instanceof KObj && isExc(x.cls)) || null); return; }
    // a secondary constructor (when there is no primary one, or this one delegates to it)
    if (c.ctors.length && (argv.length !== c.pc.length || !c.pc.length)) {
      const ct = pick(c.ctors.map(x => ({ ...x, params: x.params })), argv, c.name);
      const scope = new Map(ct.params.map((p, k) => [p.name, { v: argv[k] === undefined && p.def ? null : conv(argv[k], p.type, null, 'argument'), t: p.type, name: p.name }]));
      const run = () => {
        frames.push({ name: c.name, scopes: [scope], fn: { name: 'constructor', cls: c }, self: o, cls: c, initOf: o, hidden: true });
        try {
          if (ct.del && ct.del.kind === 'this') { const a2 = ct.del.args.map(a => rval(a.e)); frames.at(-1).hidden = true; initPrimary(c, o, a2, e, true); }
          else if (ct.del && ct.del.kind === 'super') { const a2 = ct.del.args.map(a => rval(a.e)); if (c.base) initObj(c.base, o, a2, e); initPrimary(c, o, [], e, false); }
          else { if (c.base) initObj(c.base, o, (c.superArgs || []).map(a => rval(a.e)), e); initPrimary(c, o, [], e, false); }
        } finally { frames.pop(); }
        if (ct.body) { const fn = new KFn({ name: 'constructor', params: ct.params, body: ct.body, cls: c, ctor: true, line: ct.line }); invoke(fn, argv, o, null); }
      };
      run();
      return;
    }
    initPrimary(c, o, argv, e, true);
  }
  /** the primary constructor: its parameters, the supertype's construction, then the initializers and init blocks */
  function initPrimary(c, o, argv, e, withBase) {
    if (argv.length > c.pc.length) fail(`too many arguments for constructor of '${c.name}'.`);
    const scope = new Map();
    c.pc.forEach((p, k) => {
      let v = argv[k];
      if (v === undefined || v === MISSING) { if (!p.def) fail(`no value passed for parameter '${p.name}'.`); v = withScope(scope, { name: c.name, cls: c }, o, () => rval(p.def)); }
      if (p.vararg) v = lib.varargArray(argv.slice(k), p.type);
      v = conv(v, p.type, e && e.args && e.args[k] ? e.args[k].e : null, 'argument');
      scope.set(p.name, { v, t: p.type, name: p.name });
      if (p.prop) o.f.set(p.name, v);
    });
    frames.push({ name: c.name, scopes: [scope], fn: { name: 'init', cls: c }, self: o, cls: c, initOf: o, hidden: true, env: o.env });
    try {
      if (withBase && c.base) initObj(c.base, o, (c.superArgs || []).map(a => rval(a.e)), e);
      for (const p of c.props.values()) if (!p.fromPc && !p.delegate && !(p.get && !p.get.auto && !p.init)) o.f.set(p.name, p.mods.has('lateinit') ? UNSET : zeroOf(p.type));
      for (const it of c.order) {
        if (it.k === 'prop') { const p = it.p; if (p.init && !(p.get && !p.get.auto)) { line = p.line; o.f.set(p.name, conv(rval(p.init), p.type, p.init)); } else if (p.init && p.get) { o.f.set(p.name, conv(rval(p.init), p.type, p.init)); } }
        else { const fn = new KFn({ name: 'init', params: [], body: it.body, cls: c, ctor: true, line: it.body.line }); invoke(fn, [], o, null); }
      }
    } finally { frames.pop(); }
  }
  const zeroOf = t => (!t ? null : t.nul ? null : { Int: 0, Long: 0n, Double: new D(0), Float: new D(0, true), Boolean: false, Char: KCH(0) }[t.n] ?? null);

  /* ---- when, try ---- */
  function whenExpr(e, asStmt) {
    const subj = e.subject ? rval(e.subject) : undefined;
    return scoped(() => {
      if (e.bind) declare(e.bind, subj, null);
      for (const b of e.branches) {
        let hit;
        if (!b.conds) hit = true;
        else hit = b.conds.some(c => {
          if (c.k === 'is') { const ok = isInstance(subj, c.type); return c.neg ? !ok : ok; }
          if (c.k === 'in') { const r = rval(c.e); const has = r instanceof KObj ? userOp(r, 'contains', [subj]) === true : lib.contains(r, subj); return c.neg ? !has : has; }
          const v = rval(c.e);
          if (e.subject) { if (kindOf(v) !== kindOf(subj) && kindOf(v) !== 'ref' && kindOf(subj) !== 'ref' && kindOf(v) !== 'null' && kindOf(subj) !== 'null') fail(`incompatible types '${ktType(v)}' and '${ktType(subj)}'.`); return equals(subj, v); }
          if (typeof v !== 'boolean') fail(`condition type mismatch: inferred type is '${ktType(v)}' but 'kotlin.Boolean' was expected.`);
          return v;
        });
        if (hit) return valueOfBlock(b.body);
      }
      if (!asStmt) fail("'when' expression must be exhaustive. Add an 'else' branch.", e.line);
      return UNIT;
    });
  }
  function tryExpr(e) {
    let result, pending = null;
    try { result = valueOfBlock(e.body); }
    catch (err) {
      if (!(err instanceof Thrown)) { if (!e.fin) throw err; pending = err; }
      else {
        const c = e.catches.find(x => isInstance(err.obj, x.type) || (x.type.n === 'Throwable'));
        if (c) { try { result = scoped(() => { declare(c.name, err.obj, c.type); return valueOfBlock(c.body); }); } catch (err2) { if (!e.fin) throw err2; pending = err2; } }
        else pending = err;
      }
    }
    if (e.fin) valueOfBlock(e.fin);
    if (pending) throw pending;
    return result;
  }

  /* ---- statements ---- */
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  const loopBody = b => scoped(() => { hoist(b.items); for (const s of b.items) exec(s); });
  /** runs a statement; asValue: an expression statement gives its value (the last one is a block's value) */
  function exec(s, asValue = false) {
    switch (s.k) {
      case 'expr': {
        if (!(s.e.k === 'if' || s.e.k === 'when' || s.e.k === 'try') || true) step(s.line);
        if (s.e.k === 'when') return whenExpr(s.e, !asValue);
        if (s.e.k === 'if' && !asValue) { const c = rval(s.e.cond); if (typeof c !== 'boolean') fail(`condition type mismatch: inferred type is '${ktType(c)}' but 'kotlin.Boolean' was expected.`); const b = c ? s.e.a : s.e.b; if (b) loopBody(b); return UNIT; }
        if (s.e.k === 'lambda' && !asValue) return UNIT;
        return eval1(s.e);
      }
      case 'local': {
        step(s.line);
        const p = s.p;
        let v;
        if (p.delegate) { const r = declare(p.name, UNSET, p.type, { mutable: false, lazy: p }); r.lazyInit = true; r.v = lazyLocal(p); return UNIT; }
        if (!p.init) { if (!p.type) fail('this variable must either have an explicit type or be initialized.'); declare(p.name, UNSET, p.type, { mutable: p.mutable }); return UNIT; }
        v = rval(p.init);
        if (v === UNIT && p.init.k !== 'name') { /* val u = println() is kotlin.Unit */ }
        const t = p.type || (v === null || v === undefined ? null : { k: 't', n: kindOf(v) === 'ref' ? (v instanceof KObj ? v.cls.name : 'Any') : kindOf(v), inferred: true });
        declare(p.name, p.type ? conv(v, p.type, p.init) : v, t, { mutable: p.mutable });
        return UNIT;
      }
      case 'destructure': {
        step(s.line);
        const v = rval(s.init);
        const parts = lib.destructure(v, s.names.length, componentOf);
        s.names.forEach((n, k) => { if (n.name !== '_') declare(n.name, parts[k], n.type, { mutable: s.mutable }); });
        return UNIT;
      }
      case 'localFun': return UNIT;
      case 'class': { const c = makeClass(s, frame().cls); linkSupers(c); return UNIT; }
      case 'assign': step(s.line); assign(s); return UNIT;
      case 'while':
        for (;;) {
          step(s.line);
          const c = rval(s.cond);
          if (typeof c !== 'boolean') fail(`condition type mismatch: inferred type is '${ktType(c)}' but 'kotlin.Boolean' was expected.`);
          if (!c) return UNIT;
          const r = loopRound(s, () => loopBody(s.body));
          if (r === 'break') return UNIT;
        }
      case 'do':
        for (;;) {
          step(s.line);
          let cont = true;
          const r = loopRound(s, () => scoped(() => { hoist(s.body.items || []); for (const x of s.body.items || [s.body]) exec(x); cont = rval(s.cond); }));
          if (r === 'break') return UNIT;
          if (r === 'continue') { step(s.line); cont = rval(s.cond); }
          if (!cont) return UNIT;
        }
      case 'for': {
        step(s.line);
        const it = lib.iterChecked(rval(s.iter), s);
        for (const x of it) {
          const r = loopRound(s, () => scoped(() => {
            if (s.names) { const parts = lib.destructure(x, s.names.length, componentOf); s.names.forEach((n, k) => { if (n.name !== '_') declare(n.name, parts[k], n.type); }); }
            else declare(s.name, x, s.type || (x === null ? null : { k: 't', n: kindOf(x) === 'ref' ? 'Any' : kindOf(x) }));
            hoist(s.body.items);
            for (const y of s.body.items) exec(y);
          }));
          if (r === 'break') return UNIT;
          step(s.line);
        }
        return UNIT;
      }
    }
    fail('cannot run ' + s.k);
  }
  /** a loop round: break and continue (with this loop's label, or none) end it */
  function loopRound(s, fn) {
    try { fn(); return null; }
    catch (err) {
      if (err instanceof Jump && (err.k === 'break' || err.k === 'continue') && (!err.label || err.label === s.label)) return err.k;
      throw err;
    }
  }
  function lazyLocal(p) { const d = p.delegate; if (!(d.k === 'call' && d.f.k === 'name' && d.f.n === 'lazy')) fail('only by lazy { … } delegates are supported here.'); return callFn(rval(d.args[0].e), []); }
  function assign(s) {
    const p = place(s.l);
    if (s.op === '=') { const v = rval(s.r); p.set(p.type ? conv(v, p.type, s.r, 'assignment') : v); return; }
    const cur = p.get();
    const r = rval(s.r);
    const op = s.op[0];
    // list += x on a val list: plusAssign
    if (!(NUMS.has(kindOf(cur)) || typeof cur === 'string' || cur instanceof KC) && kindOf(cur) === 'ref') {
      if (cur instanceof KObj) { const pa = findMethods(cur.cls, { '+': 'plusAssign', '-': 'minusAssign' }[op] || ''); if (pa.length) { invoke(pa[0], [r], cur, null); return; } }
      if (lib.plusAssign(cur, op, r)) return;
    }
    if (p.local && !p.local.mutable) fail("'val' cannot be reassigned.");
    let v = binop(op, { l: { k: 'const', v: cur }, r: { k: 'const', v: r } });
    if (p.type) v = conv(v, p.type, null, 'assignment');
    else if (typeof cur === 'number' && typeof v !== 'number' && !(typeof v === 'string')) fail(`assignment type mismatch: actual type is '${ktType(v)}', but 'kotlin.Int' was expected.`);
    p.set(v);
  }

  /* ---- snapshots ---- */
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = o => { let n = ids.get(o); if (!n) { n = nextId++; ids.set(o, n); } return n; };
  const P = (k, s) => ({ t: 'p', k, s });
  function ser(v, ctx, depth) {
    if (v === UNSET) return P('undef', '?');
    switch (kindOf(v)) {
      case 'null': return P('null', 'null');
      case 'Int': case 'Long': return P('num', String(v));
      case 'Double': case 'Float': return P('num', javaDouble(v.v, v.f));
      case 'Char': return P('char', lib.charLit(v.c));
      case 'Boolean': return P('bool', String(v));
      case 'String': return P('str', JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v));
    }
    if (v === UNIT) return P('sym', 'Unit');
    if (v instanceof KFn) return { t: 'fn', s: v.name === 'lambda' ? 'lambda' : v.name };
    if (v instanceof KObj && (v.cls.isEnum || (v.cls.base && v.cls.base.isEnum))) return P('sym', (v.cls.isEnum ? v.cls.name : v.cls.base.name) + '.' + v.f.get('name'));
    if (v && v.enumClass) return P('sym', v.enumClass.name);
    const id = idOf(v);
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    if (v instanceof KArr) { const n = Math.min(v.a.length, MAX_ITEMS); return { t: 'arr', id, len: v.a.length, items: v.a.slice(0, n).map(x => ser(x, ctx, depth + 1)), more: v.a.length - n, tn: v.kind + '(' + v.a.length + ')' }; }
    if (v instanceof KObj) {
      const entries = [];
      for (const [k, x] of v.f) { if (k.startsWith('$')) continue; if (isExc(v.cls) && k === 'cause' && x === null) continue; if (v.cls.isEnum && (k === 'name' || k === 'ordinal')) continue; entries.push([k, ser(x, ctx, depth + 1)]); }
      return { t: 'obj', id, cls: v.cls.kind === 'anon' ? 'object' : v.cls.name, entries: entries.slice(0, 30), more: Math.max(0, entries.length - 30) };
    }
    return lib.ser(v, id, ctx, depth, ser);
  }
  function brief(v) {
    if (v === UNSET) return '?';
    const k = kindOf(v);
    if (k === 'String') return JSON.stringify(v.length > 14 ? v.slice(0, 14) + '…' : v);
    if (k === 'Char') return lib.charLit(v.c);
    if (k !== 'ref' && k !== 'null') return toStrSafe(v);
    if (v === null) return 'null';
    if (v instanceof KArr) return v.kind + '(' + v.a.length + ')';
    if (v instanceof KObj) return v.cls.isEnum ? v.f.get('name') : v.cls.name + '(…)';
    if (v instanceof KFn) return v.name;
    return lib.brief(v);
  }
  const toStrSafe = v => { try { return toStr(v); } catch { return '?'; } };
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set() };
    const vars = [];
    if (f && !f.hidden) {
      const shown = new Map();
      for (const sc of f.scopes) for (const [n, r] of sc) if (!r.hidden) shown.set(n, { r, scope: 'local' });
      for (const sc of f.env || []) for (const [n, r] of sc) if (!r.hidden && !shown.has(n)) shown.set(n, { r, scope: 'local' });
      if (f.self instanceof KObj && !(f.fn && f.fn.lambda) && !f.self.cls.isObject) vars.push({ name: 'this', scope: 'local', node: ser(f.self, ctx, 0) });
      for (const [n, { r, scope }] of shown) vars.push({ name: n, scope, node: ser(r.v, ctx, 0) });
    }
    for (const [n, tp] of topProps) if (tp.v !== UNSET && !tp.p.mods.has('const') && !(tp.p.get && !tp.p.get.auto)) vars.push({ name: n, scope: 'global', node: ser(tp.v, ctx, 0) });
    for (const c of new Set(classes.values())) if (c.isObject && c.instance && c.kind !== 'anon') for (const [n, x] of c.instance.f) if (!n.startsWith('$')) vars.push({ name: (c.kind === 'companion' ? c.outer.name : c.name) + '.' + n, scope: 'global', node: ser(x, ctx, 0) });
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }

  /* ---- the library ---- */
  const lib = makeLib({
    D, KC, KCH, KObj, KArr, KFn, UNIT, Thrown, fail, throwKt, npe, write, rval, toStr, equals, hashOf, compare, callFn, conv, ktType, typeText, kindOf, isInstance, idOf,
    identityHash, line: () => line, fullName, findClass, newExc, invoke, initObj, imports: () => prog.imports,
  });

  /* ---- run: the classes, the top-level properties, then main ---- */
  let error = null;
  try {
    for (const d of prog.decls) {
      line = d.line;
      if (d.k === 'class') makeClass(d, null);
      else if (d.k === 'fun') { const fn = funFn(d, null); if (d.recv) addExt(fn); else { if (!topFuns.has(d.name)) topFuns.set(d.name, []); topFuns.get(d.name).push(fn); } }
      else if (d.k === 'prop') { if (d.recv) { if (!extProps.has(d.name)) extProps.set(d.name, []); extProps.get(d.name).push(d); } else topProps.set(d.name, { p: d, v: UNSET }); }
      else if (d.k === 'typealias') { /* the alias's name just stands for the type */ }
      else if (d.k === 'destructure') fail('destructuring declarations are only allowed for local variables/values.', d.line);
    }
    for (const c of new Set(classes.values())) if (!c.builtin) { line = c.decl.line; linkSupers(c); }
    for (const c of new Set(classes.values())) {        // the enum entries
      if (!c.isEnum) continue;
      c.decl.entries.forEach((en, k) => {
        let ec = c;
        if (en.body) { ec = makeClass({ ...en.body, name: en.name }, c); ec.base = c; ec.isEnumEntry = true; }
        const o = new KObj(ec);
        o.f.set('name', en.name); o.f.set('ordinal', k);
        c.entries.push(o);
        line = en.line;
        initObj(ec === c ? c : ec, o, en.args.map(a => rval(a.e)), { args: en.args });
        if (ec !== c) { /* the entry's own body's members */ }
      });
    }
    for (const c of new Set(classes.values())) if (!c.builtin && !c.isInterface && !c.isAbstract && c.kind !== 'anon') {   // abstract members left unimplemented
      for (let b = c.base; b; b = b.base) for (const [n, ms] of b.methods || []) for (const m of ms) if (m.isAbstract && virt(new KObj(c), m) === m) fail(`class '${c.name}' is not abstract and does not implement abstract base class member '${n}'.`, c.decl.line);
      for (const it of c.ifaces) for (const [n, ms] of it.methods || []) for (const m of ms) if (m.isAbstract && virt(new KObj(c), m) === m) fail(`class '${c.name}' is not abstract and does not implement abstract member '${n}'.`, c.decl.line);
    }
    for (const [n, tp] of topProps) {                 // the top-level properties, in order
      line = tp.p.line;
      if (tp.p.init && !(tp.p.get && !tp.p.get.auto)) tp.v = conv(rval(tp.p.init), tp.p.type, tp.p.init);
      else if (!tp.p.init && !tp.p.get && !tp.p.delegate && !tp.p.mods.has('lateinit')) fail(`property must be initialized.`);
      void n;
    }
    const mains = topFuns.get('main');
    if (!mains) throw Object.assign(new Error("no main function found: write fun main() { … }"), { noMain: true });
    const main = mains.find(m => m.params.length <= 1);
    main.isMain = true;
    invoke(main, main.params.length ? [new KArr('Array<String>', [])] : [], null, null);
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof Thrown) error = { msg: `Exception in thread "main" ${toStrSafe(e.obj)} (line ${e.line || line})` };
    else if (e instanceof KtError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e instanceof Jump) error = { msg: `Error on line ${line}: '${e.k}' is not allowed here.` };
    else if (e && e.exit !== undefined) error = e.exit === 0 ? null : { msg: `The program called exitProcess(${e.exit}).`, soft: true };
    else if (e && e.noMain) throw new Error(e.message);
    else if (e instanceof RangeError) error = { msg: `Exception in thread "main" java.lang.StackOverflowError (line ${line})` };
    else throw e;
  }
  if (outBuf) logs.push({ type: 'log', s: outBuf });
  if (!error || (error.soft && !stopped)) {
    const c = finalVars || captureVars(null);
    steps.push({ line: -1, stack: [], vars: c.vars, refs: c.refs, logs: logs.length });
  }
  return { steps, logs, error };
}
