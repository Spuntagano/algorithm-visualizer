/**
 * The Go interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and
 * before each test of a loop), in the format of src/model.js. The library (fmt, strings, sort…) is ./lib.js.
 *
 * Values: integers are JavaScript numbers (BigInts past 2^53, as int is 64 bits), floats are F, strings and bools are
 * themselves, nil is null; a struct is a GStruct and an array a GArr, both copied when assigned (Go's value
 * semantics); a slice is a GSlice, a view of a backing array that append shares until it has to grow, so the aliasing
 * Go programs run into is there; a map is a GMap; a pointer is a GPtr to a variable, a field or an element.
 *
 * runGoTrace(source) returns { steps, logs, error }, or throws an Error ("line N: …") for a syntax error.
 */
import { parseGo } from './parse.js';
import { makeLib, fmtFloat } from './lib.js';

const MAX_STEPS = 3000, MAX_CALLS = 300, MAX_DEPTH = 5, MAX_ITEMS = 60;

export class F { constructor(v, f32 = false) { this.v = f32 ? Math.fround(v) : v; this.f32 = f32; } }
export class GStruct { constructor(t, f) { this.t = t; this.f = f; } }
export class GArr { constructor(t, a) { this.t = t; this.a = a; } }
export class GSlice { constructor(t, arr, off, len, cap) { this.t = t; this.arr = arr; this.off = off; this.len = len; this.cap = cap; } }
export class GMap { constructor(t) { this.t = t; this.m = new Map(); } }
export class GPtr { constructor(t, get, set, key, name) { this.t = t; this.get = get; this.set = set; this.key = key; this.name = name; } }
export class GFn { constructor(o) { Object.assign(this, o); } }
class StopRun extends Error {}
class ExitRun extends Error {}
/** A panic in flight (value: what was passed to panic, or a runtime error) */
class Panic extends Error { constructor(value, runtime) { super('panic'); this.value = value; this.runtime = runtime; } }
/** What the Go compiler would refuse, met while running */
class GoError extends Error {}
const BREAK = 'break', CONTINUE = 'continue';

/* ---- types ---- */
const prim = name => ({ k: 'basic', name });
const INTS = ['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'byte', 'rune'];
const BASIC = Object.fromEntries([...INTS, 'float64', 'float32', 'string', 'bool'].map(n => [n, prim(n)]));
BASIC.any = { k: 'iface', methods: [], name: 'any' };
BASIC.error = { k: 'iface', methods: [{ name: 'Error' }], name: 'error' };
const isInt = t => t && t.k === 'basic' && INTS.includes(t.name);
const isFloat = t => t && t.k === 'basic' && (t.name === 'float64' || t.name === 'float32');

export function runGoTrace(src) {
  const prog = parseGo(src);
  const steps = [], logs = [], stack = [], frames = [];
  const rets = {}; let calls = 0;   // every call's frame gets an id; rets: what the call returned, by that id
  let line = 0, stopped = null, outBuf = '', errBuf = '', finalVars = null;
  const fail = msg => { throw new GoError(msg); };
  // a runtime panic; a few of Go's have no "runtime error: " in front
  const panic = msg => { throw new Panic(msg, /^(assignment to entry in nil map|interface conversion)/.test(msg) ? 'plain' : true); };
  const write = (s, err) => {
    if (err) { errBuf += s; let k; while ((k = errBuf.indexOf('\n')) >= 0) { logs.push({ type: 'error', s: errBuf.slice(0, k) }); errBuf = errBuf.slice(k + 1); } return; }
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k) }); outBuf = outBuf.slice(k + 1); }
  };

  /* ---- named types, methods ---- */
  const named = new Map();                          // name → { k: 'named', name, under, methods: Map }
  const globals = new Map();                        // package-level variables and constants: name → { v, t }
  const funcs = new Map();
  /** The type an AST type stands for */
  function typeOf(n, tparams) {
    if (!n) return null;
    switch (n.k) {
      case 'name': {
        const tps = tparams || (frame() && frame().fn && frame().fn.tps);
        if (tps && tps.includes(n.name)) return BASIC.any;   // generics are erased
        if (BASIC[n.name]) return n.name === 'byte' ? BASIC.uint8 : n.name === 'rune' ? BASIC.int32 : BASIC[n.name];
        const nt = named.get(n.name);
        if (nt) return nt;
        if (n.name.includes('.')) return libType(n.name);
        if (n.name === 'comparable') return BASIC.any;
        line = n.line || line;
        fail(`undefined: ${n.name}`);
      }
      // falls through
      case 'ptr': return { k: 'ptr', elem: typeOf(n.elem, tparams) };
      case 'slice': return { k: 'slice', elem: typeOf(n.elem, tparams) };
      case 'array': return { k: 'array', len: n.len ? Number(intOf(rval(n.len))) : null, elem: typeOf(n.elem, tparams) };
      case 'map': return { k: 'map', key: typeOf(n.key, tparams), val: typeOf(n.val, tparams) };
      case 'func': return { k: 'func', params: n.params.map(p => typeOf(p.type, tparams)), results: n.results.map(p => typeOf(p.type, tparams)) };
      case 'struct': return { k: 'struct', fields: n.fields.map(f => ({ name: f.name, type: typeOf(f.type, tparams), embedded: f.embedded })) };
      case 'iface': return { k: 'iface', methods: n.methods };
    }
    fail('unknown type');
  }
  const libType = name => lib.type(name) || fail(`undefined: ${name}`);
  /** The type under a named one */
  const under = t => (t && t.k === 'named' ? under(t.under) : t);
  const typeName = t => {
    if (!t) return 'nil';
    switch (t.k) {
      case 'basic': return t.name === 'uint8' ? 'uint8' : t.name === 'int32' ? 'int32' : t.name;
      case 'named': return t.lib ? t.name : 'main.' + t.name;
      case 'ptr': return '*' + typeName(t.elem);
      case 'slice': return '[]' + typeName(t.elem);
      case 'array': return '[' + t.len + ']' + typeName(t.elem);
      case 'map': return 'map[' + typeName(t.key) + ']' + typeName(t.val);
      case 'func': return 'func(' + t.params.map(typeName).join(', ') + ')' + (t.results.length === 1 ? ' ' + typeName(t.results[0]) : t.results.length ? ' (' + t.results.map(typeName).join(', ') + ')' : '');
      case 'struct': return 'struct {…}';
      case 'iface': return t.name === 'any' ? 'interface {}' : t.name || 'interface {…}';
    }
    return '?';
  };
  /** How a type is shown in the views (without main.) */
  const shortType = t => typeName(t).replace(/main\./g, '');

  /* ---- values ---- */
  /** The zero value of a type */
  function zero(t) {
    const u = under(t);
    if (!u) return null;
    switch (u.k) {
      case 'basic': return isInt(u) ? 0 : isFloat(u) ? new F(0, u.name === 'float32') : u.name === 'string' ? '' : u.name === 'bool' ? false : null;
      case 'struct': return new GStruct(t, new Map(u.fields.map(f => [f.name, zero(f.type)])));
      case 'array': return new GArr(t, Array.from({ length: u.len }, () => zero(u.elem)));
      case 'slice': return Object.assign(new GSlice(t, { a: [] }, 0, 0, 0), { nil: true });   // a nil slice, which knows its type
      case 'map': return Object.assign(new GMap(t), { nil: true });
      default: return null;                          // pointers, funcs, interfaces: nil
    }
  }
  /** A copy, as an assignment makes one: structs and arrays are values; slices, maps and pointers are shared */
  function copy(v) {
    if (v instanceof GStruct) return new GStruct(v.t, new Map([...v.f].map(([k, x]) => [k, copy(x)])));
    if (v instanceof GArr) return new GArr(v.t, v.a.map(copy));
    if (v instanceof GSlice) return Object.assign(new GSlice(v.t, v.arr, v.off, v.len, v.cap), v.nil ? { nil: true } : {});
    if (v instanceof F && v.lit) return new F(v.v, v.f32);   // an untyped constant, stored, is a float64
    return v;
  }
  const intOf = v => { if (typeof v === 'number' || typeof v === 'bigint') return v; if (v instanceof F && Number.isInteger(v.v)) return v.v; fail(`cannot use ${show(v)} (${dynType(v)}) as int value`); };
  const num = v => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v instanceof F ? v.v : fail(`${show(v)} is not a number`));
  /** An int of a sized type (wraps like Go) */
  function wrapInt(v, name) {
    const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    const bits = { int8: 8, int16: 16, int32: 32, rune: 32, uint8: 8, byte: 8, uint16: 16, uint32: 32, int: 64, int64: 64, uint: 64, uint64: 64, uintptr: 64 }[name] || 64;
    const signed = !name.startsWith('u') && name !== 'byte';
    const r = signed ? BigInt.asIntN(bits, big) : BigInt.asUintN(bits, big);
    return r >= -9007199254740991n && r <= 9007199254740991n ? Number(r) : r;
  }
  /** Assigning a value to a place of type t: copies, checks what Go would refuse, wraps ints */
  function conv(v, t, what, ast) {
    const u = under(t);
    if (!u) return copy(v);
    if (v === null && (u.k === 'slice' || u.k === 'map')) return zero(t);
    if (ast && isFloat(u) && isNum(v) && !isConstExpr(ast)) fail(`cannot use ${desc(v, ast)} as ${typeName(t)} value in ${what || 'assignment'}`);
    if (u.k === 'basic') {
      if (isInt(u)) {
        if (typeof v === 'number' || typeof v === 'bigint') return wrapInt(v, u.name);
        if (v instanceof F && Number.isInteger(v.v) && v.lit) return wrapInt(v.v, u.name);
        fail(`cannot use ${desc(v, ast)} as ${typeName(t)} value in ${what || 'assignment'}`);
      }
      if (isFloat(u)) { if (v instanceof F) return u.name === 'float32' ? new F(v.v, true) : v.f32 || v.lit ? new F(v.v) : v; if (typeof v === 'number' || typeof v === 'bigint') return new F(Number(v), u.name === 'float32'); fail(`cannot use ${desc(v, ast)} as ${typeName(t)} value in ${what || 'assignment'}`); }
      if (u.name === 'string' && typeof v !== 'string') fail(`cannot use ${desc(v, ast)} as string value in ${what || 'assignment'}`);
      if (u.name === 'bool' && typeof v !== 'boolean') fail(`cannot use ${desc(v, ast)} as bool value in ${what || 'assignment'}`);
      return v;
    }
    if (u.k === 'slice' && v instanceof GSlice) return new GSlice(t.k === 'named' ? t : v.t, v.arr, v.off, v.len, v.cap);
    if (u.k === 'map' && v instanceof GMap && t.k === 'named') { v.t = t; return v; }
    if (u.k === 'iface' && u.methods && u.methods.length && v !== null && !implementsIface(v, u)) fail(`cannot use ${desc(v, ast)} as ${typeName(t)} value in ${what || 'assignment'}: ${dynType(v)} does not implement ${typeName(t)} (missing method ${u.methods.find(m => !methodOf(v, m.name)).name})`);
    return copy(v);
  }
  /** The dynamic type of a value, as %T writes it */
  function dynType(v) {
    if (v === null) return 'nil';
    if (typeof v === 'number' || typeof v === 'bigint') return v.t || 'int';
    if (v instanceof F) return v.f32 ? 'float32' : 'float64';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'boolean') return 'bool';
    if (v instanceof GStruct || v instanceof GArr || v instanceof GSlice || v instanceof GMap) return typeName(v.t);
    if (v instanceof GPtr) return '*' + typeName(v.t);
    if (v instanceof GFn) return v.t ? typeName(v.t) : 'func';
    return lib.typeOf(v);
  }
  const show = v => (typeof v === 'string' ? JSON.stringify(v) : lib.sprint(v));
  const kindOf = v => (typeof v === 'string' ? 'string' : isNum(v) ? (v.rune ? 'rune' : 'int') : v instanceof F ? 'float' : typeof v === 'boolean' ? 'bool' : dynType(v));
  /** an operand as Go's errors describe it: "s" (untyped string constant), x (variable of type int) */
  const desc = (v, ast) => (!ast ? `${show(v)} (value of type ${dynType(v)})` : isConstExpr(ast) && ast.k !== 'const' ? `${srcOf(ast)} (untyped ${kindOf(v)} constant)` : ast.k === 'name' ? `${ast.name} (variable of type ${typeName(staticOfExpr(ast)) === 'nil' ? dynType(v) : typeName(staticOfExpr(ast))})` : `${srcOf(ast)} (value of type ${dynType(v)})`);
  const typeWord = (v, ast) => (ast && isConstExpr(ast) && ast.k !== 'const' ? 'untyped ' + kindOf(v) : dynType(v));

  /* ---- methods and interfaces ---- */
  /** The method name of v's type (or of the type its pointer points to), or null */
  function methodOf(v, name, staticT) {
    let t = v instanceof GPtr ? v.t : v && v.t ? v.t : staticT && staticT.k === 'ptr' ? staticT.elem : staticT;
    if (v instanceof GPtr && t && t.k !== 'named' && v.get() && v.get().t) t = v.get().t;
    if (t && t.k === 'named' && t.methods.has(name)) return t.methods.get(name);
    const target = v instanceof GPtr ? v.get() : v;
    const ut = target && target.t ? under(target.t) : null;
    if (ut && ut.k === 'struct') for (const f of ut.fields) if (f.embedded) {   // a method promoted from an embedded field
      const inner = target.f.get(f.name);
      const m = inner && methodOf(inner, name);
      if (m) return { ...m, via: f.name };
    }
    return null;
  }
  const implementsIface = (v, u) => u.methods.every(m => methodOf(v, m.name) || lib.hasMethod(v, m.name));

  /* ---- frames and names ---- */
  const frame = () => frames[frames.length - 1];
  function lookup(name) {
    const f = frame();
    if (f) {
      for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].get(name); if (r) return r; }
      for (const sc of f.env || []) { const r = sc.get(name); if (r) return r; }
    }
    return globals.get(name) || null;
  }
  const declare = (name, v, t) => { const f = frame(); const r = { v, t, name }; if (name !== '_') (f ? f.scopes.at(-1) : globals).set(name, r); return r; };

  /* ---- places: get(), set(v), type ---- */
  function place(e) {
    switch (e.k) {
      case 'name': {
        if (e.name === '_') return { get: () => fail('cannot use _ as value'), set: () => {}, type: null, blank: true };
        const r = lookup(e.name);
        if (!r) fail(`undefined: ${e.name}`);
        if (r.isConst) fail(`cannot assign to ${e.name} (neither addressable nor a map index expression)`);
        return { get: () => r.v, set: v => { r.v = v; }, type: r.t, cell: r, d: e.name };
      }
      case 'index': {
        const c = rval(e.e);
        if (c instanceof GMap || (c === null && e.e && mapTyped(e.e))) {
          const m = c;
          const k = rval(e.i);
          return { get: () => lib.mapGet(m, k)[0], set: v => { if (m === null) panic('assignment to entry in nil map'); lib.mapSet(m, k, v); }, type: m ? under(m.t).val : null, d: srcOf(e) };
        }
        const k = Number(intOf(rval(e.i)));
        if (c instanceof GSlice) {
          const check = () => { if (k < 0 || k >= c.len) panic(`index out of range [${k}] with length ${c.len}`); };
          return { get: () => { check(); return c.arr.a[c.off + k]; }, set: v => { check(); c.arr.a[c.off + k] = v; }, type: under(c.t).elem, elemOf: c, at: c.off + k, d: srcOf(e) };
        }
        if (c instanceof GArr) {
          const check = () => { if (k < 0 || k >= c.a.length) panic(`index out of range [${k}] with length ${c.a.length}`); };
          return { get: () => { check(); return c.a[k]; }, set: v => { check(); c.a[k] = v; }, type: under(c.t).elem, d: srcOf(e) };
        }
        if (c instanceof GPtr && c.get() instanceof GArr) { const a = c.get(); return { get: () => a.a[k], set: v => { a.a[k] = v; }, type: under(a.t).elem }; }
        if (c === null) panic(`index out of range [${k}] with length 0`);
        if (typeof c === 'string') fail(`cannot assign to ${srcOf(e)} (neither addressable nor a map index expression): strings cannot be changed (convert to []byte or []rune first)`);
        fail(`invalid operation: cannot index ${srcOf(e.e)} (${dynType(c)})`);
      }
      // falls through
      case 'sel': {
        const pkgv = pkgOf(e);
        if (pkgv) fail(`cannot assign to ${srcOf(e)}`);
        const { obj, d } = structOf(e.e, e.name);
        return { get: () => obj.f.get(e.name), set: v => obj.f.set(e.name, v), type: fieldType(obj, e.name), d };
      }
      case 'deref': {
        const p = rval(e.e);
        if (p === null) panic('invalid memory address or nil pointer dereference');
        if (!(p instanceof GPtr)) fail(`invalid operation: cannot indirect ${srcOf(e.e)} (${dynType(p)})`);
        return { get: () => p.get(), set: v => p.set(v), type: p.t, d: '*' + srcOf(e.e) };
      }
      case 'paren': return place(e.e);
    }
    fail(`cannot assign to ${srcOf(e)} (neither addressable nor a map index expression)`);
  }
  const mapTyped = e => { const r = e.k === 'name' && lookup(e.name); return r && r.t && under(r.t).k === 'map'; };
  const fieldType = (obj, name) => { const u = under(obj.t); const f = u && u.fields && u.fields.find(x => x.name === name); return f ? f.type : null; };
  /** The struct a selector x.f goes into (through pointers, and into embedded fields) */
  function structOf(xe, name) {
    let v = rval(xe);
    const d = srcOf(xe) + '.' + name;
    for (let hops = 0; hops < 8; hops++) {
      if (v instanceof GPtr) { const t = v.get(); if (t === null || t === undefined) panic('invalid memory address or nil pointer dereference'); v = t; continue; }
      if (v === null) panic('invalid memory address or nil pointer dereference');
      if (!(v instanceof GStruct)) fail(`${d} undefined (type ${dynType(v)} has no field or method ${name})`);
      if (v.f.has(name)) return { obj: v, d };
      const u = under(v.t), emb = u.fields.find(f => f.embedded && (() => { const inner = v.f.get(f.name); const iv = inner instanceof GPtr ? inner.get() : inner; return iv instanceof GStruct && hasField(iv, name); })());
      if (!emb) fail(`${d} undefined (type ${dynType(v)} has no field or method ${name})`);
      v = v.f.get(emb.name);
    }
    fail(`${d}: too deep`);
  }
  const hasField = (s, name) => s.f.has(name) || under(s.t).fields.some(f => f.embedded && s.f.get(f.name) instanceof GStruct && hasField(s.f.get(f.name), name));
  /** pkg.Name: a package's member (fmt.Println, math.MaxInt), or null */
  const pkgOf = e => (e.k === 'sel' && e.e.k === 'name' && !lookup(e.e.name) && imports.has(e.e.name) ? imports.get(e.e.name) : null);

  /* ---- expressions ---- */
  const srcOf = e => {
    switch (e.k) {
      case 'name': return e.name;
      case 'sel': return srcOf(e.e) + '.' + e.name;
      case 'index': return srcOf(e.e) + '[' + srcOf(e.i) + ']';
      case 'call': return srcOf(e.f) + '(…)';
      case 'lit': return e.kind === 'string' ? JSON.stringify(e.v) : String(e.v);
      case 'deref': return '*' + srcOf(e.e);
      case 'paren': return '(' + srcOf(e.e) + ')';
      default: return 'value';
    }
  };
  /** One value (a call with several results is an error here) */
  function rval(e) {
    const v = eval1(e);
    if (Array.isArray(v)) { if (v.length === 0) fail(`${srcOf(e)} (no value) used as value`); fail(`multiple-value ${srcOf(e)} (value of type (${v.map(dynType).join(', ')})) in single-value context`); }
    return v;
  }
  function eval1(e) {
    switch (e.k) {
      case 'lit':
        if (e.kind === 'int') return e.v >= -9007199254740991n && e.v <= 9007199254740991n ? Number(e.v) : e.v;
        if (e.kind === 'float') { const f = new F(e.v); f.lit = true; return f; }
        if (e.kind === 'rune') { const r = Number(e.v); return r; }
        return e.v;
      case 'paren': return eval1(e.e);
      case 'const': return e.v;
      case 'name': {
        if (e.name === 'nil') return null;
        if (e.name === 'true' || e.name === 'false') { const r = lookup(e.name); return r ? r.v : e.name === 'true'; }
        if (e.name === 'iota') { const f = frame(); return f && f.iota != null ? f.iota : iotaNow; }
        const r = lookup(e.name);
        if (r) return r.v;
        if (funcs.has(e.name)) return funcs.get(e.name);
        if (BUILTINS.has(e.name)) fail(`${e.name} (built-in function) must be called`);
        if (named.has(e.name) || BASIC[e.name]) fail(`${e.name} (type) is not an expression`);
        fail(`undefined: ${e.name}`);
      }
      // falls through
      case 'sel': {
        const pkg = pkgOf(e);
        if (pkg) return lib.member(pkg, e.name, e);
        const x = rval(e.e);
        const m = methodOf(x, e.name, x === null || isNum(x) || typeof x === 'string' || x instanceof F || typeof x === 'boolean' ? staticType(e.e) : null);
        if (m && !(x instanceof GStruct && x.f.has(e.name)) && !(x instanceof GPtr && x.get() instanceof GStruct && x.get().f.has(e.name))) return boundMethod(x, m, e.e);   // p.Move: a method value
        return place(e).get();
      }
      case 'index': {
        const c = rval(e.e);
        if (typeof c === 'string') { const bytes = lib.utf8(c), k = Number(intOf(rval(e.i))); if (k < 0 || k >= bytes.length) panic(`index out of range [${k}] with length ${bytes.length}`); return bytes[k]; }
        if (c instanceof GMap || c === null && mapTyped(e.e)) { const r = lib.mapGet(c, rval(e.i)); return r[0]; }
        if (c instanceof GFn && c.generic) return c;    // f[int]: a generic function, its types erased
        return place(e).get();
      }
      case 'slice': return sliceExpr(e);
      case 'deref': return place(e).get();
      case 'addr': return addrOf(e.e);
      case 'un': {
        const v = rval(e.e);
        if (e.op === '!') { if (typeof v !== 'boolean') fail(`invalid operation: operator ! not defined on ${srcOf(e.e)} (${dynType(v)})`); return !v; }
        if (e.op === '-') return v instanceof F ? new F(-v.v, v.f32) : typeof v === 'bigint' ? BigInt.asIntN(64, -v) : v === -9223372036854775808 ? v : -v;
        if (e.op === '+') return v;
        if (e.op === '^') return wrapInt(~BigInt(v), 'int64');
        break;
      }
      case 'bin': return binop(e.op, rval(e.l), rval(e.r), e);
      case 'and': { const a = rval(e.l); if (typeof a !== 'boolean') fail(`invalid operation: operator && not defined on ${srcOf(e.l)}`); return a && rval(e.r); }
      case 'or': { const a = rval(e.l); if (typeof a !== 'boolean') fail(`invalid operation: operator || not defined on ${srcOf(e.l)}`); return a || rval(e.r); }
      case 'call': return call(e);
      case 'composite': return composite(e.type ? typeOf(e.type) : null, e);
      case 'funcLit': return closure(e);
      case 'typeAssert': {
        const v = rval(e.e), t = typeOf(e.type);
        const ok = typeMatches(v, t);
        if (e.commaOk) return [ok ? v : zero(t), ok];
        if (!ok) panic(`interface conversion: interface {} is ${v === null ? 'nil' : dynType(v)}, not ${typeName(t)}`);
        return v;
      }
      case 'typeExpr': fail(`${typeName(typeOf(e.type))} (type) is not an expression`);
      // falls through
      case 'inst': return rval(e.e);
    }
    fail('cannot evaluate ' + e.k);
  }
  /** Is e a constant (untyped in Go, so 2 can be a float64 but an int variable cannot)? */
  function isConstExpr(e) {
    if (!e) return true;
    switch (e.k) {
      case 'lit': case 'const': return true;
      case 'paren': case 'un': return isConstExpr(e.e);
      case 'bin': return isConstExpr(e.l) && isConstExpr(e.r);
      case 'name': { const r = lookup(e.name); return e.name === 'iota' || !!(r && r.isConst); }
      case 'sel': { const pkg = pkgOf(e); return !!pkg && lib.isConst(pkg, e.name); }
      case 'call': return e.f.k === 'name' && e.f.name === 'len' && false;
    }
    return false;
  }
  /** The static type of an expression where it is easy to know: a variable's, a conversion's */
  function staticOfExpr(e) {
    if (e.k === 'name') { const r = lookup(e.name); return r ? r.t : null; }
    if (e.k === 'call' && e.f.k === 'name' && !lookup(e.f.name) && named.has(e.f.name)) return named.get(e.f.name);
    if (e.k === 'call' && e.f.k === 'name' && !lookup(e.f.name) && BASIC[e.f.name] && e.f.name !== 'any') return typeOf({ k: 'name', name: e.f.name });
    if (e.k === 'lit' && e.kind === 'rune') return BASIC.int32;
    if (e.k === 'paren') return staticOfExpr(e.e);
    if (e.k === 'bin' && !['==', '!=', '<', '>', '<=', '>='].includes(e.op)) { const l = staticOfExpr(e.l), r = staticOfExpr(e.r); return l && l.k === 'named' ? l : r && r.k === 'named' ? r : null; }   // Red + 1 is a Color
    return null;
  }
  /** The declared type of a name, for a method on a named non-struct type (type Celsius float64) */
  const staticType = e => {
    if (e.k === 'name') return lookup(e.name) ? lookup(e.name).t : null;
    if (e.k === 'sel' && !pkgOf(e)) { try { const { obj } = structOf(e.e, e.name); return fieldType(obj, e.name); } catch (err) { if (err instanceof Panic) return null; throw err; } }   // t.Left, which may be nil
    return null;
  };
  function boundMethod(x, m, xe) {
    return new GFn({ native: args => invokeMethod(x, m, args, xe), name: m.name, t: null });
  }
  function addrOf(e) {
    if (e.k === 'composite') { const v = rval(e); const cell = { v }; return new GPtr(v.t || null, () => cell.v, w => { cell.v = w; }, cell, null); }
    if (e.k === 'paren') return addrOf(e.e);
    const p = place(e);
    if (p.blank) fail('cannot take the address of _');
    const t = p.type || (p.get() && p.get().t) || null;
    return new GPtr(t, p.get, p.set, p.cell || (p.elemOf ? { at: p.at, of: p.elemOf.arr.a, arr: p.elemOf.arr } : { of: p }), p.d);
  }
  function sliceExpr(e) {
    const c = rval(e.e);
    const lo = e.lo ? Number(intOf(rval(e.lo))) : 0;
    if (typeof c === 'string') {
      const bytes = lib.utf8(c), hi = e.hi ? Number(intOf(rval(e.hi))) : bytes.length;
      if (lo < 0 || hi > bytes.length || lo > hi) panic(`slice bounds out of range [${lo}:${hi}] with length ${bytes.length}`);
      return lib.fromUtf8(bytes.slice(lo, hi));
    }
    let s = c;
    if (c instanceof GArr) s = new GSlice({ k: 'slice', elem: under(c.t).elem }, { a: c.a }, 0, c.a.length, c.a.length);
    if (c instanceof GPtr && c.get() instanceof GArr) { const a = c.get(); s = new GSlice({ k: 'slice', elem: under(a.t).elem }, { a: a.a }, 0, a.a.length, a.a.length); }
    if (s === null) { if (lo || (e.hi && Number(intOf(rval(e.hi))))) panic('slice bounds out of range'); return null; }
    if (!(s instanceof GSlice)) fail(`cannot slice ${srcOf(e.e)} (${dynType(c)})`);
    const hi = e.hi ? Number(intOf(rval(e.hi))) : s.len;
    const max = e.max ? Number(intOf(rval(e.max))) : s.cap;
    if (hi > s.cap) panic(`slice bounds out of range [:${hi}] with capacity ${s.cap}`);
    if (lo > hi) panic(`slice bounds out of range [${lo}:${hi}]`);
    if (max > s.cap || max < hi) panic(`slice bounds out of range [::${max}] with capacity ${s.cap}`);
    return new GSlice(s.t, s.arr, s.off + lo, hi - lo, max - lo);
  }
  /** T{…}: structs (by field name or in order), arrays, slices, maps; an element's type may be left out */
  function composite(t, e) {
    const u = under(t);
    if (!u) fail('missing type in composite literal');
    const elem = (et, x) => (x.k === 'composite' && !x.type ? composite(et, x) : x.k === 'addr' && x.e.k === 'composite' && !x.e.type ? addrOf({ ...x.e, type: null, _t: et }) : conv(rval(x), et, 'composite literal'));
    const elemOf = (et, x) => (x.k === 'composite' && !x.type ? (under(et).k === 'ptr' ? (() => { const v = composite(under(et).elem, x); const cell = { v }; return new GPtr(under(et).elem, () => cell.v, w => { cell.v = w; }, cell); })() : composite(et, x)) : elem(et, x));
    switch (u.k) {
      case 'struct': {
        const s = zero(t);
        if (e.elems.length && e.elems[0].key) {
          for (const { key, val } of e.elems) {
            if (key.k !== 'name' || !s.f.has(key.name)) fail(`unknown field ${key.k === 'name' ? key.name : '?'} in struct literal of type ${shortType(t)}`);
            s.f.set(key.name, elemOf(u.fields.find(f => f.name === key.name).type, val));
          }
        } else {
          if (e.elems.length && e.elems.length !== u.fields.length) fail(`too ${e.elems.length < u.fields.length ? 'few' : 'many'} values in struct literal of type ${shortType(t)}`);
          e.elems.forEach(({ val }, k) => s.f.set(u.fields[k].name, elemOf(u.fields[k].type, val)));
        }
        return s;
      }
      case 'array': case 'slice': {
        const items = [];
        let k = 0;
        for (const { key, val } of e.elems) { if (key) k = Number(intOf(rval(key))); items[k++] = elemOf(u.elem, val); }
        const n = u.k === 'array' && u.len != null ? u.len : items.length;
        const a = Array.from({ length: n }, (_, j) => (items[j] === undefined ? zero(u.elem) : items[j]));
        if (u.k === 'array') return new GArr(u.len == null ? { ...u, len: n } : t, a);
        return new GSlice(t, { a }, 0, n, n);
      }
      case 'map': {
        const m = new GMap(t);
        for (const { key, val } of e.elems) { if (!key) fail('missing key in map literal'); lib.mapSet(m, elemOf(u.key, key), elemOf(u.val, val)); }
        return m;
      }
      case 'ptr': { const v = composite(u.elem, e); const cell = { v }; return new GPtr(u.elem, () => cell.v, w => { cell.v = w; }, cell); }
    }
    fail(`invalid composite literal type ${typeName(t)}`);
  }
  function typeMatches(v, t) {
    const u = under(t);
    if (u.k === 'iface') return v !== null && (u.name === 'any' || !u.methods.length || implementsIface(v, u));
    if (v === null) return false;
    if (t.k === 'named') return (v.t === t) || (v instanceof GPtr ? false : false);
    if (t.k === 'ptr') return v instanceof GPtr && (v.t === t.elem || (v.get() && v.get().t === t.elem));
    if (u.k === 'basic') {
      if (isInt(u)) return (typeof v === 'number' || typeof v === 'bigint') && (u.name === 'int' ? !v.t : true);
      if (isFloat(u)) return v instanceof F && (u.name === 'float32') === v.f32;
      return typeof v === (u.name === 'string' ? 'string' : 'boolean');
    }
    if (u.k === 'slice') return v instanceof GSlice && typeName(v.t) === typeName(t);
    if (u.k === 'map') return v instanceof GMap && typeName(v.t) === typeName(t);
    return false;
  }

  /* ---- arithmetic ---- */
  const isNum = v => typeof v === 'number' || typeof v === 'bigint';
  function binop(op, a, b, e) {
    if (op === '==' || op === '!=') { const eq = equal(a, b, e); return op === '==' ? eq : !eq; }
    if (typeof a === 'string' && typeof b === 'string') {
      switch (op) { case '+': return a + b; case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; }
      fail(`invalid operation: operator ${op} not defined on ${srcOf(e.l)} (variable of type string)`);
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') fail(`invalid operation: operator ${op} not defined on ${srcOf(e.l)} (variable of type bool)`);
    if (typeof a === 'string' || typeof b === 'string') fail(`invalid operation: ${srcOf(e.l)} ${op} ${srcOf(e.r)} (mismatched types ${typeWord(a, e.l)} and ${typeWord(b, e.r)})`);
    if (a instanceof F || b instanceof F) {
      if (isNum(a) || isNum(b)) {                    // int and float mix only when one is a constant
        const intAst = isNum(a) ? e && e.l : e && e.r, fv = isNum(a) ? b : a;
        if (!isConstExpr(intAst)) {
          if (fv.lit && Number.isInteger(fv.v)) return binop(op, isNum(a) ? a : a.v, isNum(b) ? b : b.v, e);
          if (fv.lit) fail(`${fmtFloat(fv.v)} (untyped float constant) truncated to int`);
          fail(`invalid operation: ${srcOf(e.l)} ${op} ${srcOf(e.r)} (mismatched types ${isNum(a) ? 'int' : dynType(a)} and ${isNum(b) ? 'int' : dynType(b)})`);
        }
      }
      const x = num(a), y = num(b), f32 = (a instanceof F && a.f32) || (b instanceof F && b.f32);
      if ((a.lit || isNum(a)) && (b.lit || isNum(b)) && '+-*/'.includes(op)) {   // constants: exact, as Go's compiler does (0.1 + 0.2 is 0.3)
        const p = ratOf(a), q = ratOf(b);
        if (op === '/' && q[0] === 0n) fail('invalid operation: division by zero');
        const r = op === '+' ? [p[0] * q[1] + q[0] * p[1], p[1] * q[1]] : op === '-' ? [p[0] * q[1] - q[0] * p[1], p[1] * q[1]] : op === '*' ? [p[0] * q[0], p[1] * q[1]] : [p[0] * q[1], p[1] * q[0]];
        if (r[1] < 0n) { r[0] = -r[0]; r[1] = -r[1]; }
        const out = new F(ratNum(r), f32);
        out.lit = true; out.rat = r;
        return out;
      }
      let r;
      switch (op) {
        case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break;
        case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
        default: fail(`invalid operation: operator ${op} not defined on ${srcOf(e.l)} (variable of type float64)`);
      }
      const out = new F(r, f32);
      if ((a.lit || isNum(a)) && (b.lit || isNum(b))) out.lit = true;
      return out;
    }
    if (!isNum(a) || !isNum(b)) fail(`invalid operation: operator ${op} not defined on ${srcOf(e.l)} (${dynType(a)})`);
    if ((op === '/' || op === '%') && (b === 0 || b === 0n)) panic('integer divide by zero');
    if (typeof a === 'number' && typeof b === 'number') {
      let r;
      switch (op) {
        case '+': r = a + b; break; case '-': r = a - b; break; case '*': r = a * b; break;
        case '/': r = Math.trunc(a / b); break; case '%': r = a % b; break;
        case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
        case '&': case '|': case '^': case '&^': case '<<': case '>>': r = null; break;
      }
      if (r !== null && Number.isSafeInteger(r)) return r;
    }
    const x = BigInt(a), y = BigInt(b);
    let r;
    switch (op) {
      case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break; case '%': r = x % y; break;
      case '&': r = x & y; break; case '|': r = x | y; break; case '^': r = x ^ y; break; case '&^': r = x & ~y; break;
      case '<<': if (y < 0n) panic('negative shift amount'); r = y >= 64n ? 0n : x << y; break;
      case '>>': if (y < 0n) panic('negative shift amount'); r = x >> (y > 63n ? 63n : y); break;
      case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
      default: fail('invalid operation ' + op);
    }
    return wrapInt(r, 'int64');
  }
  /** A constant as a fraction of BigInts */
  function ratOf(v) {
    if (isNum(v)) return [BigInt(v), 1n];
    if (v.rat) return v.rat;
    const [m, ex] = v.v.toExponential().split('e'), digits = m.replace('.', ''), scale = Number(ex) - (digits.length - 1 - (m[0] === '-' ? 1 : 0));
    return scale >= 0 ? [BigInt(digits) * 10n ** BigInt(scale), 1n] : [BigInt(digits), 10n ** BigInt(-scale)];
  }
  function ratNum([n, d]) {
    const neg = n < 0n, a = neg ? -n : n;
    if (a === 0n) return 0;
    const k = Math.max(0, 25 - (a.toString().length - d.toString().length));
    const q = a * 10n ** BigInt(k) / d;
    return (neg ? -1 : 1) * Number(q.toString() + 'e-' + k);
  }
  /** == in Go: numbers and strings by value, structs and arrays field by field, pointers and maps by identity */
  function equal(a, b, e) {
    if (a === null || b === null) { const x = a === null ? b : a; return x === null || ((x instanceof GSlice || x instanceof GMap) && !!x.nil); }
    if (isNum(a) && isNum(b)) return BigInt(a) === BigInt(b);
    if (a instanceof F || b instanceof F) return num(a) === num(b);
    if (a instanceof GStruct && b instanceof GStruct) return a.t === b.t && [...a.f].every(([k, x]) => equal(x, b.f.get(k), e));
    if (a instanceof GArr && b instanceof GArr) return a.a.length === b.a.length && a.a.every((x, k) => equal(x, b.a[k], e));
    if (a instanceof GPtr && b instanceof GPtr) return a.key === b.key || (a.key && b.key && a.key.of === b.key.of && a.key.at === b.key.at && a.key.of !== undefined);
    if (a instanceof GSlice || b instanceof GSlice) fail(`invalid operation: ${e ? srcOf(e.l) : 'slice'} == ${e ? srcOf(e.r) : '…'} (slice can only be compared to nil)`);
    if (a instanceof GMap || b instanceof GMap) fail('invalid operation: map can only be compared to nil');
    return a === b;
  }

  /* ---- calls ---- */
  const BUILTINS = new Set(['len', 'cap', 'append', 'make', 'new', 'copy', 'delete', 'panic', 'recover', 'print', 'println', 'min', 'max', 'clear']);
  function call(e) {
    const f = e.f;
    if (f.k === 'name' && !lookup(f.name)) {
      if (BUILTINS.has(f.name)) return builtin(f.name, e);
      const bt = BASIC[f.name] || named.get(f.name);
      if (bt) return convert(bt, e);                 // int(x), float64(x), string(r), MyType(x)
    }
    if (f.k === 'paren' && f.e.k === 'deref') return convert({ k: 'ptr', elem: typeOf({ k: 'name', name: f.e.e.name }) }, e);
    if (f.k === 'typeExpr') return convert(typeOf(f.type), e);
    if (f.k === 'sel') {
      const pkg = pkgOf(f);
      if (pkg) return lib.call(pkg, f.name, e.args, e, { rval, eval1, staticOf: staticOfExpr });
      const x = rval(f.e);
      if (!(x instanceof GStruct && x.f.has(f.name) && x.f.get(f.name) instanceof GFn) && !(x instanceof GPtr && x.get() instanceof GStruct && x.get().f.has(f.name))) {
        const m = methodOf(x, f.name, x === null || isNum(x) || typeof x === 'string' || x instanceof F || typeof x === 'boolean' ? staticType(f.e) : null);
        if (m) return invokeMethod(x, m, args(e), f.e);
        if (lib.hasMethod(x, f.name)) return lib.method(x, f.name, args(e), e);
        if (x === null) panic('invalid memory address or nil pointer dereference');
        if (!(x instanceof GStruct || x instanceof GPtr)) fail(`${srcOf(f)} undefined (type ${dynType(x)} has no field or method ${f.name})`);
      }
    }
    const fn = rval(f);
    if (fn === null) panic('invalid memory address or nil pointer dereference');
    if (!(fn instanceof GFn)) fail(`invalid operation: cannot call non-function ${srcOf(f)} (variable of type ${dynType(fn)})`);
    return callFn(fn, args(e), e);
  }
  /** The arguments: a call with several results spread into them, xs... spread as a variadic */
  function args(e) {
    if (e.args.length === 1 && e.args[0].k === 'call') { const v = eval1(e.args[0]); if (Array.isArray(v)) return v; return [v]; }
    const out = e.args.map(a => rval(a));
    if (e.spread) out.spread = true;
    return out;
  }
  function invokeMethod(x, m, argv, xe) {
    let recv = x;
    if (m.via) { const inner = (x instanceof GPtr ? x.get() : x).f.get(m.via); return invokeMethod(inner, methodOf(inner, m.name), argv, xe); }
    const ptrRecv = m.recv && m.recv.type.k === 'ptr';
    if (ptrRecv && x === null) recv = null;           // a nil pointer is a fine receiver (if t == nil { … })
    else if (ptrRecv && !(x instanceof GPtr)) {       // v.M() with a pointer receiver: &v
      if (xe && ['name', 'sel', 'index', 'deref', 'paren'].includes(xe.k)) recv = addrOf(xe);
      else { const cell = { v: x }; recv = new GPtr(x && x.t, () => cell.v, w => { cell.v = w; }, cell); }
    } else if (!ptrRecv && x instanceof GPtr) { const v = x.get(); if (v === null || v === undefined) panic('invalid memory address or nil pointer dereference'); recv = copy(v); }
    else if (!ptrRecv) recv = copy(x);
    return callFn(m, argv, null, recv);
  }
  /** Runs a function (or a method, with recv): the parameters bound, defers run at the end, results returned */
  function callFn(fn, argv, e, recv) {
    if (fn.native) return fn.native(argv, e);
    const at = line;
    const r = runFn(fn, argv, e, recv);
    line = at;                                       // (a panic leaves line where it happened)
    return r;
  }
  function runFn(fn, argv, e, recv) {
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls (goroutine stack exceeds the limit).');
    const ps = fn.params, scope = new Map();
    const variadic = ps.length && ps.at(-1).variadic;
    if (!variadic && argv.length !== ps.length) fail(`${argv.length < ps.length ? 'not enough' : 'too many'} arguments in call to ${fn.name}\n\thave (${argv.map(dynType).join(', ')})\n\twant (${ps.map(p => typeName(p.t)).join(', ')})`);
    if (variadic && argv.length < ps.length - 1) fail(`not enough arguments in call to ${fn.name}`);
    if (fn.recv && fn.recv.name) scope.set(fn.recv.name, { v: recv, t: fn.recvT, name: fn.recv.name });
    ps.forEach((p, k) => {
      let v;
      if (p.variadic) v = argv.spread ? argv[k] : (() => { const a = argv.slice(k).map(x => conv(x, p.t.elem, 'argument')); return a.length ? new GSlice(p.t, { a }, 0, a.length, a.length) : null; })();
      else v = conv(argv[k], p.t, `argument to ${fn.name}`, e && e.args && e.args.length === argv.length && !argv.spread ? e.args[k] : null);
      if (p.name && p.name !== '_') scope.set(p.name, { v, t: p.t, name: p.name });
    });
    const results = fn.results.map(r => ({ name: r.name, t: r.t }));
    for (const r of results) if (r.name) scope.set(r.name, { v: zero(r.t), t: r.t, name: r.name });
    const label = fn.recv ? (fn.recvT && fn.recv.type.k === 'ptr' ? `(*${shortType(fn.recvT.elem || fn.recvT)}).` : shortType(fn.recvT) + '.') + fn.name : fn.name;
    const fr = { name: label, scopes: [scope], env: fn.env, defers: [], fn, results };
    const id = ++calls;
    stack.push({ id, name: label, args: [...(fn.recv && fn.recv.name ? [fn.recv.name + '=' + brief(recv)] : []), ...ps.filter(p => p.name).map(p => p.name + '=' + brief(scope.get(p.name).v))].join(', ').slice(0, 70) });
    frames.push(fr);
    let ret, panicking = null, recovered = false;
    try {
      const r = execBlockIn(fn.body, fr);
      ret = r && r.k === 'return' ? r.vals : null;
    } catch (err) {
      if (!(err instanceof Panic)) throw err;
      panicking = err;
    }
    try {
      while (fr.defers.length) {                    // last deferred first, even while panicking
        const d = fr.defers.pop();
        fr.panic = panicking;
        line = d.line;
        try { callFn(d.fn, d.args, null, d.recv); } catch (err) { if (!(err instanceof Panic)) throw err; panicking = err; }
        if (fr.recovered) { panicking = null; fr.recovered = false; recovered = true; }
      }
    } finally {
      if (frames.length === 1 && fn.name === 'main') finalVars = captureVars(fr);
      frames.pop(); stack.pop();
    }
    if (panicking) throw panicking;
    if (!results.length) return undefined;
    const vals = results.some(r => r.name) ? results.map(r => (r.name ? scope.get(r.name).v : zero(r.t))) : ret || results.map(r => zero(r.t));   // named results: what the defers left in them
    if (!ret && !recovered && results.some(r => !r.name) && fn.body.items.length) fail(`missing return at the end of ${fn.name}`);
    const out = vals.map((v, k) => conv(v, results[k].t, 'return statement'));
    rets[id] = out.map(brief).join(', ');
    return out.length === 1 ? out[0] : out;
  }
  function closure(e) {
    const f = frame();
    return new GFn({ name: 'func literal', tps: f && f.fn && f.fn.tps, params: e.params.map(p => ({ ...p, t: typeOf(p.type) })), results: e.results.map(r => ({ ...r, t: typeOf(r.type) })), body: e.body,
      env: f ? [...[...f.scopes].reverse(), ...(f.env || [])] : [], t: { k: 'func', params: e.params.map(p => typeOf(p.type)), results: e.results.map(p => typeOf(p.type)) } });
  }
  /** int(x), float64(x), string(65), []byte(s), MyType(x) */
  function convert(t, e) {
    if (e.args.length !== 1) fail(`conversion to ${typeName(t)} needs one value`);
    const v = rval(e.args[0]), u = under(t);
    if (u.k === 'basic') {
      if (isInt(u)) { if (v instanceof F) return wrapInt(Math.trunc(v.v), u.name); if (isNum(v)) { const r = wrapInt(v, u.name); return r; } fail(`cannot convert ${show(v)} (${dynType(v)}) to type ${typeName(t)}`); }
      if (isFloat(u)) { if (isNum(v)) return new F(Number(v), u.name === 'float32'); if (v instanceof F) return new F(v.v, u.name === 'float32'); fail(`cannot convert ${show(v)} (${dynType(v)}) to type ${typeName(t)}`); }
      if (u.name === 'string') {
        if (typeof v === 'string') return v;
        if (isNum(v)) return String.fromCodePoint(Number(v));
        if (v instanceof GSlice) return under(v.t).elem.name === 'int32' ? v.arr.a.slice(v.off, v.off + v.len).map(c => String.fromCodePoint(c)).join('') : lib.fromUtf8(v.arr.a.slice(v.off, v.off + v.len));
        if (v === null) return '';
        fail(`cannot convert ${show(v)} (${dynType(v)}) to type string`);
      }
      if (u.name === 'bool') { if (typeof v === 'boolean') return v; fail(`cannot convert ${show(v)} to type bool`); }
    }
    if (u.k === 'slice' && typeof v === 'string') {
      const items = u.elem.name === 'int32' ? [...v].map(c => c.codePointAt(0)) : lib.utf8(v);
      return new GSlice(t, { a: items }, 0, items.length, items.length);
    }
    if (u.k === 'slice' && v instanceof GSlice) return new GSlice(t, v.arr, v.off, v.len, v.cap);
    if (u.k === 'map' && v instanceof GMap) { v.t = t; return v; }
    if (u.k === 'struct' && v instanceof GStruct) return new GStruct(t, copy(v).f);
    if (t.k === 'named' && isNum(v)) { const r = conv(v, t); return r; }
    if (t.k === 'named' && v instanceof GFn) return v;
    return conv(v, t);
  }
  function builtin(name, e) {
    const a = e.args;
    const need = n => { if (a.length !== n) fail(`${a.length < n ? 'not enough' : 'too many'} arguments for ${name}(…)`); };
    switch (name) {
      case 'len': case 'cap': {
        need(1);
        const v = rval(a[0]);
        if (v === null) return 0;
        if (typeof v === 'string') { if (name === 'cap') fail('invalid argument: cap(string)'); return lib.utf8(v).length; }
        if (v instanceof GSlice) return name === 'len' ? v.len : v.cap;
        if (v instanceof GArr) return v.a.length;
        if (v instanceof GMap) { if (name === 'cap') fail('invalid argument: cap(map)'); return v.m.size; }
        if (v instanceof GPtr && v.get() instanceof GArr) return v.get().a.length;
        fail(`invalid argument: ${srcOf(a[0])} (${dynType(v)}) for built-in ${name}`);
      }
      // falls through
      case 'append': {
        if (!a.length) fail('not enough arguments for append()');
        const s = rval(a[0]);
        if (s !== null && !(s instanceof GSlice)) fail(`invalid argument: ${srcOf(a[0])} (${dynType(s)}) is not a slice`);
        let items;
        if (e.spread) { const x = rval(a[1]); items = x === null ? [] : typeof x === 'string' ? lib.utf8(x) : x.arr.a.slice(x.off, x.off + x.len); }
        else items = a.slice(1).map(x => rval(x));
        const t = s ? s.t : staticOf(a[0]) || { k: 'slice', elem: null };
        const et = under(t).elem;
        items = items.map(x => conv(x, et, 'argument to append'));
        return appendTo(s, t, items);
      }
      case 'make': {
        const t = typeOf(a[0].k === 'typeExpr' ? a[0].type : a[0].k === 'name' ? { k: 'name', name: a[0].name } : a[0].k === 'composite' ? a[0].type : a[0].type || a[0]);
        const u = under(t);
        if (u.k === 'slice') {
          const n = a[1] ? Number(intOf(rval(a[1]))) : fail('missing len argument to make(' + typeName(t) + ')');
          const c = a[2] ? Number(intOf(rval(a[2]))) : n;
          if (n < 0) panic('makeslice: len out of range');
          if (c < n) panic('makeslice: cap out of range');
          if (c > 1e6) fail('make: ' + c + ' elements is more than this page can show');
          return new GSlice(t, { a: Array.from({ length: c }, () => zero(u.elem)) }, 0, n, c);
        }
        if (u.k === 'map') return new GMap(t);
        fail(`invalid argument: cannot make ${typeName(t)}; type must be slice, map, or channel`);
      }
      // falls through
      case 'new': { const t = typeOf(a[0].k === 'typeExpr' ? a[0].type : { k: 'name', name: a[0].name }); const cell = { v: zero(t) }; return new GPtr(t, () => cell.v, w => { cell.v = w; }, cell); }
      case 'copy': {
        need(2);
        const d = rval(a[0]), s = rval(a[1]);
        if (d === null) return 0;
        const src = typeof s === 'string' ? lib.utf8(s) : s === null ? [] : s.arr.a.slice(s.off, s.off + s.len);
        const n = Math.min(d.len, src.length);
        for (let k = 0; k < n; k++) d.arr.a[d.off + k] = copy(src[k]);
        return n;
      }
      case 'delete': { need(2); const m = rval(a[0]); if (m !== null) lib.mapDelete(m, rval(a[1])); return undefined; }
      case 'clear': { need(1); const v = rval(a[0]); if (v instanceof GMap) v.m.clear(); else if (v instanceof GSlice) for (let k = 0; k < v.len; k++) v.arr.a[v.off + k] = zero(under(v.t).elem); return undefined; }
      case 'panic': { need(1); const v = rval(a[0]); throw new Panic(v, false); }
      case 'recover': {
        const f = frames.at(-2);
        if (!f || !f.panic || f.recovered) return null;
        f.recovered = true;
        const p = f.panic;
        return p.runtime ? lib.runtimeError(p.value, p.runtime === 'plain') : p.value;
      }
      case 'print': case 'println': { const vs = a.map(x => rval(x)); write(vs.map(v => lib.sprint(v)).join(name === 'println' ? ' ' : '') + (name === 'println' ? '\n' : ''), true); return undefined; }
      case 'min': case 'max': {
        if (!a.length) fail(`not enough arguments for ${name}()`);
        const vs = a.map(x => rval(x));
        return vs.reduce((best, v) => (binop(name === 'min' ? '<' : '>', v, best, { l: { k: 'const' }, r: { k: 'const' } }) ? v : best));
      }
    }
    fail('unknown built-in ' + name);
  }
  const staticOf = e => (e.k === 'name' && lookup(e.name) ? lookup(e.name).t : null);
  /** append: into the same backing array while it has room (shared with other slices of it!), else a new one twice as big */
  function appendTo(s, t, items) {
    if (!items.length) return s;
    const len = s ? s.len : 0, cap = s ? s.cap : 0;
    if (s && len + items.length <= cap) {
      items.forEach((x, k) => { s.arr.a[s.off + len + k] = x; });
      return new GSlice(s.t, s.arr, s.off, len + items.length, cap);
    }
    let nc = Math.max(cap, 1);                       // Go's growth: double up to 256, then about 1.25x
    while (nc < len + items.length) nc = nc < 256 ? nc * 2 : nc + Math.floor((nc + 3 * 256) / 4);
    if (!cap && items.length > 1) nc = items.length;
    const a = Array(nc);
    for (let k = 0; k < len; k++) a[k] = s.arr.a[s.off + k];
    items.forEach((x, k) => { a[len + k] = x; });
    const et = under(t).elem;
    for (let k = len + items.length; k < nc; k++) a[k] = zero(et);
    return new GSlice(t, { a }, 0, len + items.length, nc);
  }

  /* ---- statements ---- */
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  const scoped = fn => { const f = frame(); f.scopes.push(new Map()); try { return fn(); } finally { f.scopes.pop(); } };
  const execBlock = b => scoped(() => { for (const s of b.items) { const r = exec(s); if (r) return r; } return undefined; });
  /** A function's body runs in the scope that holds its parameters */
  function execBlockIn(b, fr) { void fr; for (const s of b.items) { const r = exec(s); if (r) return r; } return undefined; }
  const caught = (r, label) => r && (r.k === BREAK || r.k === CONTINUE) && (!r.label || r.label === label);
  let iotaNow = 0;
  function exec(s, quiet = false, label = null) {
    const at = l => { if (!quiet) step(l); else line = l; };
    switch (s.k) {
      case 'block': return execBlock(s);
      case 'empty': return undefined;
      case 'expr': at(s.line); { const v = eval1(s.e); void v; if (!['call', 'paren'].includes(s.e.k)) fail(`${srcOf(s.e)} (value) is not used`); } return undefined;
      case 'define': at(s.line); define(s); return undefined;
      case 'assign': at(s.line); assign(s); return undefined;
      case 'incdec': {
        at(s.line);
        const p = place(s.e), v = p.get();
        if (!isNum(v) && !(v instanceof F)) fail(`invalid operation: ${srcOf(s.e)}${s.op} (non-numeric type ${dynType(v)})`);
        p.set(p.type ? conv(binop(s.op === '++' ? '+' : '-', v, 1, { l: s.e, r: { k: 'lit' } }), p.type) : binop(s.op === '++' ? '+' : '-', v, 1, { l: s.e, r: { k: 'lit' } }));
        return undefined;
      }
      case 'var': case 'const': at(s.line); varDecl(s, false); return undefined;
      case 'type': for (const sp of s.specs) defineType(sp); return undefined;
      case 'if':
        at(s.line);
        return scoped(() => {
          if (s.init) execSimple(s.init);
          const c = rval(s.cond);
          if (typeof c !== 'boolean') fail(`non-boolean condition in if statement`);
          if (c) return execBlock(s.a);
          return s.b ? exec(s.b, s.b.line === s.line) : undefined;
        });
      case 'for':
        return scoped(() => {
          at(s.line);
          if (s.init) execSimple(s.init);
          for (;;) {
            if (s.cond) { const c = rval(s.cond); if (typeof c !== 'boolean') fail('non-boolean condition in for statement'); if (!c) return undefined; }
            // Go 1.22: each round has its own copy of the loop variables (closures keep that round's value)
            const own = new Map([...frame().scopes.at(-1)].map(([k, r]) => [k, { ...r }]));
            const outer = frame().scopes.at(-1);
            frame().scopes.push(own);
            let r;
            try { r = execBlock(s.body); } finally { frame().scopes.pop(); for (const [k, rr] of own) if (outer.has(k)) outer.get(k).v = rr.v; }
            if (caught(r, label)) { if (r.k === BREAK) return undefined; } else if (r) return r;
            if (s.post) execSimple(s.post);
            at(s.line);
          }
        });
      case 'forrange': return forRange(s, label, at);
      case 'switch': at(s.line); return switchStmt(s, label);
      case 'label': { const r = exec(s.body, quiet, s.label); if (r && r.k === BREAK && r.label === s.label) return undefined; return r; }
      case 'return': {
        at(s.line);
        const fr = frame();
        let vals = s.es.length === 1 && s.es[0].k === 'call' ? (() => { const v = eval1(s.es[0]); return Array.isArray(v) ? v : [v]; })() : s.es.map(x => rval(x));
        if (!s.es.length && fr.results.length && fr.results.some(r => !r.name)) fail('not enough return values\n\thave ()\n\twant (' + fr.results.map(r => typeName(r.t)).join(', ') + ')');
        if (!s.es.length) vals = fr.results.map(r => (r.name ? fr.scopes[0].get(r.name).v : zero(r.t)));
        else if (vals.length !== fr.results.length) fail(`${vals.length > fr.results.length ? 'too many' : 'not enough'} return values\n\thave (${vals.map(dynType).join(', ')})\n\twant (${fr.results.map(r => typeName(r.t)).join(', ')})`);
        fr.results.forEach((r, k) => { if (r.name) fr.scopes[0].get(r.name).v = vals[k]; });   // a deferred func sees the named results
        return { k: 'return', vals };
      }
      case 'break': at(s.line); return { k: BREAK, label: s.label };
      case 'continue': at(s.line); return { k: CONTINUE, label: s.label };
      case 'fallthrough': return { k: 'fallthrough' };
      case 'defer': {
        at(s.line);
        const c = s.e;
        let fn, argv = c.args.map(x => rval(x)), recv;
        if (c.f.k === 'name' && BUILTINS.has(c.f.name) && !lookup(c.f.name)) fn = new GFn({ native: () => builtin(c.f.name, { ...c, args: argv.map(v => ({ k: 'const', v })) }) });
        else if (c.f.k === 'sel' && pkgOf(c.f)) { const pkg = pkgOf(c.f); fn = new GFn({ native: () => lib.call(pkg, c.f.name, argv.map(v => ({ k: 'const', v })), c, { rval, eval1, staticOf: staticOfExpr }) }); }
        else if (c.f.k === 'sel' && methodOf(rval(c.f.e), c.f.name)) { const x = rval(c.f.e), m = methodOf(x, c.f.name); fn = new GFn({ native: a => invokeMethod(x, m, a, c.f.e) }); }
        else fn = rval(c.f);
        frame().defers.push({ fn, args: argv, recv, line: s.line });
        return undefined;
      }
      default: fail('cannot run ' + s.k);
    }
  }
  /** a simple statement used as an init or post (no step of its own) */
  const execSimple = s => { if (s.k === 'define') define(s); else if (s.k === 'assign') assign(s); else if (s.k === 'incdec') exec(s, true); else if (s.k === 'expr') eval1(s.e); else fail('cannot use ' + s.k + ' here'); };
  function define(s) {
    const vals = s.rhs.length === 1 && s.names.length > 1 ? multi(s.rhs[0], s.names.length) : s.rhs.map(x => (x.k === 'composite' && !x.type ? fail('invalid composite literal type') : one(x, s.names.length)));
    if (vals.length !== s.names.length) fail(`assignment mismatch: ${s.names.length} variable${s.names.length > 1 ? 's' : ''} but ${vals.length} value${vals.length > 1 ? 's' : ''}`);
    const scope = frame().scopes.at(-1);
    if (!s.names.some(n => n !== '_' && !scope.has(n))) fail('no new variables on left side of :=');
    s.names.forEach((n, k) => {
      if (n === '_') return;
      const v = vals[k];
      if (scope.has(n)) { const r = scope.get(n); r.v = r.t ? conv(v, r.t) : copy(v); return; }
      declare(n, copy(v), (s.rhs.length === s.names.length && staticOfExpr(s.rhs[k])) || typeOfValue(v));
    });
  }
  /** one value for one variable: x := f() with f returning two is Go's "assignment mismatch" */
  function one(x, n) {
    if (x.k !== 'call') return rval(x);
    const v = eval1(x);
    if (Array.isArray(v)) fail(`assignment mismatch: ${n} variable${n > 1 ? 's' : ''} but ${srcOf(x.f)} returns ${v.length} value${v.length === 1 ? '' : 's'}`);
    if (v === undefined) fail(`${srcOf(x)} (no value) used as value`);
    return v;
  }
  /** v, ok := m[k] / x.(T) / <-ch; and a, b := f() */
  function multi(e, n) {
    if (e.k === 'index' && n === 2) { const c = rval(e.e); if (c instanceof GMap || c === null) return lib.mapGet(c, rval(e.i)); }
    if (e.k === 'typeAssert' && n === 2) return eval1({ ...e, commaOk: true });
    const v = eval1(e);
    if (!Array.isArray(v)) fail(`assignment mismatch: ${n} variables but ${srcOf(e)} returns 1 value`);
    return v;
  }
  /** The static type a := gives a variable: its value's (an untyped constant is int, float64, string, rune…) */
  function typeOfValue(v) {
    if (isNum(v)) return BASIC.int;
    if (v instanceof F) return v.f32 ? BASIC.float32 : BASIC.float64;
    if (typeof v === 'string') return BASIC.string;
    if (typeof v === 'boolean') return BASIC.bool;
    if (v && v.t && !(v instanceof GPtr) && !(v instanceof GFn)) return v.t;
    if (v instanceof GPtr) return { k: 'ptr', elem: v.t };
    return null;
  }
  function assign(s) {
    if (s.op !== '=') {
      const p = place(s.lhs[0]);
      const r = binop(s.op.slice(0, -1), p.get(), rval(s.rhs[0]), { l: s.lhs[0], r: s.rhs[0] });
      p.set(p.type ? conv(r, p.type) : r);
      return;
    }
    const vals = s.rhs.length === 1 && s.lhs.length > 1 ? multi(s.rhs[0], s.lhs.length) : s.rhs.map(x => one(x, s.lhs.length));
    if (vals.length !== s.lhs.length) fail(`assignment mismatch: ${s.lhs.length} variables but ${vals.length} values`);
    const places = s.lhs.map(place);                 // a, b = b, a: every place first, then every value
    places.forEach((p, k) => { if (!p.blank) p.set(p.type ? conv(vals[k], p.type, 'assignment', s.rhs.length === s.lhs.length ? s.rhs[k] : null) : copy(vals[k])); });
  }
  function varDecl(s, global) {
    for (const sp of s.specs) {
      const f = frame();
      if (s.k === 'const') { if (f) f.iota = sp.iota; iotaNow = sp.iota; }
      const t = sp.type ? typeOf(sp.type) : null;
      let vals;
      if (sp.vals) vals = sp.vals.length === 1 && sp.names.length > 1 ? multi(sp.vals[0], sp.names.length) : sp.vals.map(x => (x.k === 'composite' && !x.type && t ? composite(t, x) : rval(x)));
      if (vals && vals.length !== sp.names.length) fail(`assignment mismatch: ${sp.names.length} variables but ${vals.length} values`);
      if (f) f.iota = null;
      sp.names.forEach((n, k) => {
        const v = vals ? (t ? conv(vals[k], t, 'variable declaration', sp.vals.length === sp.names.length ? sp.vals[k] : null) : s.k === 'const' ? vals[k] : copy(vals[k])) : zero(t);
        const r = { v, t: t || typeOfValue(v), name: n, isConst: s.k === 'const' };
        if (n !== '_') (global ? globals : frame().scopes.at(-1)).set(n, r);
      });
    }
  }
  function defineType(sp) {
    if (sp.alias) { const t = typeOf(sp.type, sp.tparams); named.set(sp.name, t); return; }
    const nt = named.get(sp.name) || { k: 'named', name: sp.name, under: null, methods: new Map() };
    named.set(sp.name, nt);
    nt.under = typeOf(sp.type, sp.tparams);
  }
  function forRange(s, label, at) {
    return scoped(() => {
      at(s.line);
      const r = s.r, v = rval(r.e);
      let items;
      if (v === null) items = [];
      else if (isNum(v)) items = Array.from({ length: Number(v) }, (_, k) => [k]);
      else if (v instanceof GSlice) items = Array.from({ length: v.len }, (_, k) => [k, () => v.arr.a[v.off + k]]);
      else if (v instanceof GArr) { const a = v.a.slice(); items = a.map((x, k) => [k, () => x]); }
      else if (v instanceof GPtr && v.get() instanceof GArr) { const a = v.get().a; items = a.map((x, k) => [k, () => a[k]]); }
      else if (typeof v === 'string') { items = []; let off = 0; for (const ch of v) { items.push([off, () => ch.codePointAt(0)]); off += lib.utf8(ch).length; } }
      else if (v instanceof GMap) items = [...v.m.values()].map(en => [en.k, () => en.v, en]);   // insertion order (real Go varies it on purpose)
      else if (v instanceof GFn) fail('range over function iterators is not supported here');
      else fail(`cannot range over ${srcOf(r.e)} (variable of type ${dynType(v)})`);
      if (r.lhs.length > 2) fail('range clause permits at most two iteration variables');
      for (const [k, get, en] of items) {
        if (v instanceof GMap && !v.m.has(lib.mapKey(en.k))) continue;   // deleted during the loop
        const res = scoped(() => {
          const vals = [k, get ? copy(get()) : undefined];
          if (r.define) r.lhs.forEach((x, j) => { if (x.name !== '_') declare(x.name, vals[j], j === 1 && typeof v === 'string' ? BASIC.int32 : j === 1 && v && v.t && under(v.t) ? (under(v.t).elem || under(v.t).val || typeOfValue(vals[j])) : j === 0 && v instanceof GMap ? under(v.t).key : typeOfValue(vals[j])); });
          else r.lhs.forEach((x, j) => { const p = place(x); if (!p.blank) p.set(vals[j]); });
          return execBlock(s.body);
        });
        if (caught(res, label)) { if (res.k === BREAK) return undefined; } else if (res) return res;
        at(s.line);
      }
      return undefined;
    });
  }
  function switchStmt(s, label) {
    return scoped(() => {
      if (s.init) execSimple(s.init);
      let pick = -1;
      if (s.typeSw) {
        const v = rval(s.typeSw.e);
        pick = s.cases.findIndex(c => c.exprs && c.exprs.some(t => (t.k === 'name' && t.name === 'nil' ? v === null : typeMatches(v, typeOf(t)))));
        if (pick < 0) pick = s.cases.findIndex(c => !c.exprs);
        if (pick < 0) return undefined;
        const c = s.cases[pick];
        return scoped(() => {
          if (s.typeSw.bind) declare(s.typeSw.bind, v, c.exprs && c.exprs.length === 1 && !(c.exprs[0].k === 'name' && c.exprs[0].name === 'nil') ? typeOf(c.exprs[0]) : null);
          return runCase(c);
        });
      }
      const tag = s.tag ? rval(s.tag) : true;
      pick = s.cases.findIndex(c => c.exprs && c.exprs.some(x => equal(tag, rval(x), { l: s.tag || x, r: x })));
      if (pick < 0) pick = s.cases.findIndex(c => !c.exprs);
      for (let k = pick; k >= 0 && k < s.cases.length; k++) {
        const r = scoped(() => runCase(s.cases[k]));
        if (r && r.k === 'fallthrough') continue;
        if (r && r.k === BREAK && (!r.label || r.label === label)) return undefined;
        return r;
      }
      return undefined;
    });
  }
  function runCase(c) {
    for (const st of c.body) { const r = exec(st); if (r) return r; }
    return undefined;
  }

  /* ---- snapshots ---- */
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = o => { let n = ids.get(o); if (!n) { n = nextId++; ids.set(o, n); } return n; };
  const P = (k, s) => ({ t: 'p', k, s });
  /** the id of a slice: one per backing array and offset */
  const sliceIds = new WeakMap();
  const sliceId = (arr, off) => { let m = sliceIds.get(arr); if (!m) sliceIds.set(arr, m = new Map()); let n = m.get(off); if (!n) { n = nextId++; m.set(off, n); } return n; };
  const isRune = t => { const u = under(t); return !!u && u.k === 'basic' && u.name === 'int32'; };
  /** a value as the views show it; t is its static type when known (a rune shows as 'a') */
  function ser(v, ctx, depth, t) {
    if (v === null || v === undefined) return P('null', 'nil');
    if (typeof v === 'number' && isRune(t) && v >= 32 && v <= 0x10ffff && v !== 127) return P('char', lib.quoteRune(v));
    if (isNum(v)) return P('num', String(v));
    if (v instanceof F) return P('num', fmtFloat(v.v, v.f32));
    if (typeof v === 'string') return P('str', JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v));
    if (typeof v === 'boolean') return P('bool', String(v));
    if (v instanceof GFn) return { t: 'fn', s: v.name || 'func' };
    if (v instanceof GPtr) {
      const target = v.get();
      if (target instanceof GStruct || target instanceof GArr || target instanceof GSlice || target instanceof GMap) return ser(target, ctx, depth, v.t);   // a pointer is an arrow to what it points at
      if (v.key && v.key.arr) return { ...P('ptr', '&' + (v.name || shortType(v.t))), to: sliceId(v.key.arr, 0), at: v.key.at };   // &a[i]: a tag on that cell
      return P('ptr', '&' + (v.name || shortType(v.t)));
    }
    if ((v instanceof GSlice || v instanceof GMap) && v.nil) return P('null', 'nil');
    if (v instanceof GStruct && v.t.lib) return P('str', JSON.stringify(v.f.get('buf')));   // a strings.Builder: what it holds
    if (!(v instanceof GSlice || v instanceof GArr || v instanceof GMap || v instanceof GStruct)) return lib.ser(v);
    const id = v instanceof GSlice ? sliceId(v.arr, v.off) : idOf(v);
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    const et = under(v.t) && under(v.t).elem;
    const kids = xs => { const n = Math.min(xs.length, MAX_ITEMS); return { items: xs.slice(0, n).map(x => ser(x, ctx, depth + 1, et)), more: xs.length - n }; };
    if (v instanceof GSlice) return { t: 'arr', id, len: v.len, ...kids(v.arr.a.slice(v.off, v.off + v.len)), tn: shortType(v.t) + ' len ' + v.len + ' cap ' + v.cap };
    if (v instanceof GArr) return { t: 'arr', id, len: v.a.length, ...kids(v.a), tn: shortType(v.t) };
    if (v instanceof GMap) { const es = [...v.m.values()], n = Math.min(es.length, 30); return { t: 'map', id, entries: es.slice(0, n).map(en => [ser(en.k, ctx, depth + 1, under(v.t).key), ser(en.v, ctx, depth + 1, under(v.t).val)]), more: es.length - n, cls: shortType(v.t) }; }
    if (v instanceof GStruct) return { t: 'obj', id, cls: shortType(v.t), entries: [...v.f].map(([k, x]) => [k, ser(x, ctx, depth + 1, fieldType(v, k))]), more: 0 };
    return lib.ser(v);
  }
  const brief = v => { try { return v instanceof GStruct ? shortType(v.t) + '{…}' : v instanceof GSlice ? shortType(v.t) + '(' + v.len + ')' : v instanceof GMap ? shortType(v.t) + '(' + v.m.size + ')' : v instanceof GPtr ? '&' + (v.get() instanceof GStruct ? shortType(v.get().t) + '{…}' : v.name || '…') : typeof v === 'string' ? JSON.stringify(v.length > 14 ? v.slice(0, 14) + '…' : v) : lib.sprint(v); } catch { return '?'; } };
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set() };
    const shown = new Map();
    if (f) {
      for (const sc of [...(f.env || [])].reverse()) for (const [n, r] of sc) shown.set(n, r);
      for (const sc of f.scopes) for (const [n, r] of sc) { shown.delete(n); shown.set(n, r); }
    }
    const vars = [...shown].map(([n, r]) => ({ name: n, scope: 'local', node: ser(r.v, ctx, 0, r.t) }));
    for (const [n, r] of globals) if (!shown.has(n) && !r.isConst) vars.push({ name: n, scope: 'global', node: ser(r.v, ctx, 0, r.t) });
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }

  /* ---- the library ---- */
  const imports = new Map();
  const lib = makeLib({
    F, GStruct, GArr, GSlice, GMap, GPtr, GFn, Panic, fail, panic, write, rval, eval1, conv, zero, copy, equal, under, typeName, shortType, dynType,
    methodOf, invokeMethod, callFn, typeOfAst: typeOf, binop, intOf, num, appendTo, exit: code => { finalVars = captureVars(frame()); throw new ExitRun(String(code)); },
    idOf, isConstExpr, typeMatches, steps: () => steps.length, line: () => line,
  });

  /* ---- run: types, functions, globals, init(), main() ---- */
  let error = null;
  try {
    for (const im of prog.imports) {
      const name = im.alias || im.path.split('/').pop();
      if (!lib.knows(im.path)) { line = im.line; fail(`package ${im.path} is not in std (or not available here)`); }
      imports.set(name, im.path);
    }
    const types = prog.decls.filter(d => d.k === 'type').flatMap(d => d.specs);
    for (const sp of types) if (!sp.alias) named.set(sp.name, { k: 'named', name: sp.name, under: null, methods: new Map() });
    for (const sp of types) { line = sp.line; defineType(sp); }
    for (const d of prog.decls) {
      if (d.k !== 'func') continue;
      line = d.line;
      const tps = d.tparams || [];
      const recvTp = d.recv && d.recv.type.k === 'ptr' ? d.recv.type.elem : d.recv && d.recv.type;
      const recvTparams = recvTp && recvTp.args ? recvTp.args.map(a => a.name) : [];
      const fn = new GFn({ name: d.name, params: d.params.map(p => ({ ...p, t: typeOf(p.type, [...tps, ...recvTparams]) })), results: d.results.map(r => ({ ...r, t: typeOf(r.type, [...tps, ...recvTparams]) })),
        body: d.body, recv: d.recv, generic: tps.length > 0, tps: [...tps, ...recvTparams], line: d.line });
      if (d.recv) {
        const base = recvTp && named.get(recvTp.name);
        if (!base) fail(`cannot define new methods on non-local type ${recvTp ? recvTp.name : '?'}`);
        fn.recvT = d.recv.type.k === 'ptr' ? { k: 'ptr', elem: base } : base;
        if (base.methods.has(d.name)) fail(`method ${base.name}.${d.name} already declared`);
        base.methods.set(d.name, fn);
      } else {
        if (funcs.has(d.name) && d.name !== 'init') fail(`${d.name} redeclared in this block`);
        if (d.name !== 'init') funcs.set(d.name, fn);
      }
    }
    for (const d of prog.decls) if (d.k === 'var' || d.k === 'const') { line = d.line; varDecl(d, true); }
    for (const d of prog.decls) if (d.k === 'func' && d.name === 'init' && !d.recv) callFn(new GFn({ name: 'init', params: [], results: [], body: d.body }), []);
    const main = funcs.get('main');
    if (!main) throw Object.assign(new Error('function main is undeclared in the main package'), { noMain: true });
    callFn(main, []);
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof ExitRun) error = e.message === '0' ? null : { msg: `The program called os.Exit(${e.message}).`, soft: true };
    else if (e instanceof Panic) error = { msg: 'panic: ' + (e.runtime === 'plain' ? e.value : e.runtime ? 'runtime error: ' + e.value : lib.panicText(e.value)) + ` (line ${line})` };
    else if (e instanceof GoError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e && e.noMain) throw new Error(e.message);
    else if (e instanceof RangeError) error = { msg: `Error on line ${line}: goroutine stack exceeds the limit` };
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
