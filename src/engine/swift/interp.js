/**
 * The Swift interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and
 * before each round of a loop), in the format of src/model.js. The values are those of ./values.js; the standard
 * library (print, Int, String, Array, Dictionary, Set, ranges, Foundation's math…) is ./lib.js.
 *
 * What a program can see of Swift is kept: Int is 64 bits and overflow stops the program, arrays, dictionaries, sets,
 * tuples and structs are values (copied on write), classes are references, optionals print as Optional(…), literals
 * take the type their place needs (let x: Double = 1), a String counts Characters, and the runtime's fatal errors and
 * the compiler's errors have Swift's words. The compiler's errors are reported when the line runs.
 *
 * runSwiftTrace(source) returns { steps, logs, error }, or throws an Error ("line N: …") for a syntax error.
 */
import { parseSwift } from './parse.js';
import { makeLib } from './lib.js';
import { Some, SChar, CH, SNum, SArr, SDict, SSet, STuple, SVal, SObj, SEnum, SFn, SRange, SStride, SIdx, SType, SImplicit, UNSET, VOID, INT_KINDS, isVal, share, copyVal, swiftDouble } from './values.js';

const MAX_STEPS = 3000, MAX_CALLS = 400, MAX_DEPTH = 5, MAX_ITEMS = 60;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

class StopRun extends Error {}
/** what the Swift compiler would refuse, met while running */
class SwError extends Error {}
/** a fatal error of the Swift runtime */
class Trap extends Error {}
/** a Swift error in flight (throw) */
export class Thrown extends Error { constructor(v, line) { super('thrown'); this.v = v; this.line = line; } }
/** return, break, continue, fallthrough */
class Jump { constructor(k, label, v) { this.k = k; this.label = label; this.v = v; } }
/** an optional chain met nil */
const NIL_CHAIN = { nilChain: true };
/** a failable initializer's return nil */
const INIT_NIL = { initNil: true };

const MATH_CONSTS = { M_PI: Math.PI, M_E: Math.E, M_SQRT2: Math.SQRT2, M_LN2: Math.LN2, M_LN10: Math.LN10, M_PI_2: Math.PI / 2, M_PI_4: Math.PI / 4 };
const FOUNDATION = new Set(['sqrt', 'pow', 'floor', 'ceil', 'round', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'hypot', 'trunc', 'fmod', 'cbrt']);

export function runSwiftTrace(src) {
  const prog = parseSwift(src);
  const steps = [], logs = [], stack = [], frames = [];
  const rets = {}; let calls = 0;   // every call's frame gets an id; rets: what the call returned, by that id
  let line = 0, stopped = null, outBuf = '';
  const fail = (msg, l) => { if (l) line = l; throw new SwError(msg); };
  const trap = msg => { throw new Trap(msg); };
  /** a fatal error whose text is the whole message (Precondition failed: …) */
  const trapRaw = msg => { throw Object.assign(new Trap(msg), { raw: true }); };
  const write = s => {
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k) }); outBuf = outBuf.slice(k + 1); }
  };
  const imports = new Set(prog.items.filter(s => s.k === 'import').map(s => s.name));
  const hasFoundation = () => imports.has('Foundation') || imports.has('Glibc') || imports.has('Darwin') || imports.has('UIKit') || imports.has('Cocoa');

  /* ---- types ---- */
  const types = new Map(), protocols = new Map(), aliases = new Map();
  const globalFns = new Map();
  const builtinExt = new Map();            // 'Int', 'String', 'Array'… → { methods, props, statics }
  const globals = new Map();
  const topFrame = { name: 'main', scopes: [globals], top: true };

  function makeType(d, outer) {
    const T = { name: (outer ? outer.name + '.' : '') + d.name, short: d.name, kind: d.kind, decl: d, outer, base: null, protos: new Set(), stored: [], computed: new Map(), methods: new Map(),
      statics: new Map(), staticFns: new Map(), inits: [], cases: new Map(), caseList: [], rawType: null, subs: [], nested: new Map(), memberwise: true, ops: new Map() };
    for (const s of d.supers || []) {
      const n = s.n;
      if (d.kind === 'class' && !T.base && types.has(n) && types.get(n).kind === 'class') T.base = types.get(n);
      else if (d.kind === 'class' && !T.base && n && !isProtoName(n) && !types.has(n) && !['Comparable', 'Equatable', 'Hashable', 'CustomStringConvertible', 'Error', 'CaseIterable', 'Identifiable', 'Codable', 'AnyObject', 'Sendable'].includes(n)) T.pendingBase = n;
      else if (d.kind === 'enum' && !T.rawType && ['Int', 'String', 'Character', 'Double'].includes(n)) T.rawType = n;
      else T.protos.add(n);
    }
    types.set(T.name, T);
    if (outer) outer.nested.set(d.name, T);
    addMembers(T, d.members, false);
    if (d.kind === 'enum') {
      let nextRaw = 0n;
      for (const c of T.caseList) {
        if (T.rawType === 'Int') { c.rawValue = c.raw ? evalConst(c.raw) : nextRaw; nextRaw = c.rawValue + 1n; }
        else if (T.rawType === 'String') c.rawValue = c.raw ? evalConst(c.raw) : c.name;
        else if (T.rawType) c.rawValue = c.raw ? evalConst(c.raw) : fail(`enum case '${c.name}' must declare a raw value when the preceding raw value is not an integer`, c.line);
      }
    }
    return T;
  }
  const isProtoName = n => protocols.has(n) || prog.items.some(s => s.k === 'type' && s.kind === 'protocol' && s.name === n);
  function evalConst(e) { return rval(e); }
  function addMembers(T, members, fromExt) {
    for (const m of members) {
      if (m.k === 'var') {
        const isStatic = m.mods.has('static');
        if (isStatic) { T.statics.set(m.name, { p: m, v: UNSET, T }); continue; }
        if (m.acc && (m.acc.get || m.acc.req)) { T.computed.set(m.name, { ...m, T }); continue; }
        if (fromExt) fail('extensions must not contain stored properties', m.line);
        T.stored.push({ ...m, T, observed: m.acc && (m.acc.didSet || m.acc.willSet) ? m.acc : null });
      } else if (m.k === 'func') {
        const fn = funcOf(m, T);
        const map = m.mods.has('static') ? T.staticFns : T.methods;
        if (!map.has(m.name)) map.set(m.name, []);
        map.get(m.name).push(fn);
      } else if (m.k === 'init') { T.inits.push(funcOf({ ...m, name: 'init' }, T)); if (!fromExt) T.memberwise = false; }
      else if (m.k === 'case') for (const c of m.cases) { T.cases.set(c.name, c); T.caseList.push(c); }
      else if (m.k === 'type') makeType(m, T);
      else if (m.k === 'subscript') T.subs.push({ ...m, T });
      else if (m.k === 'deinit' || m.k === 'typealias') { /* deinit never runs here; typealiases name types */ }
      else if (m.k === 'multi') addMembers(T, m.items, fromExt);
      else if (m.k === 'destructure') fail('tuple patterns are not supported in type members here', m.line);
      else fail(`expected declaration in ${T.kind} '${T.name}'`, m.line);
    }
  }
  function funcOf(m, T) {
    return new SFn({ name: m.name, params: m.params, ret: m.ret, body: m.body, T, mods: m.mods || new Set(), throws: m.throws, line: m.line, endLine: m.endLine,
      isStatic: m.mods && m.mods.has('static'), mutating: m.mods && m.mods.has('mutating'), failable: m.failable, isInit: m.name === 'init', convenience: m.mods && m.mods.has('convenience'), decl: m });
  }
  function protoOf(d) {
    const P = { name: d.name, decl: d, methods: new Map(), computed: new Map(), statics: new Map(), staticFns: new Map(), reqs: new Set(), parents: (d.supers || []).map(s => s.n) };
    for (const m of d.members) {
      if (m.k === 'func' && !m.body) P.reqs.add(m.name);
      else if (m.k === 'var' && m.acc && m.acc.req) P.reqs.add(m.name);
    }
    protocols.set(d.name, P);
    return P;
  }
  const findType = n => {
    if (aliases.has(n)) { const a = aliases.get(n); return a.n ? findType(a.n) : null; }
    const f = frame();
    for (let T = f && f.T; T; T = T.outer) if (T.nested.has(n)) return T.nested.get(n);
    return types.get(n) || null;
  };
  /** every protocol a type conforms to, with the ones those inherit */
  function allProtos(T) {
    const out = new Set();
    const add = n => { if (out.has(n)) return; out.add(n); const P = protocols.get(n); if (P) P.parents.forEach(add); if (n === 'Hashable') add('Equatable'); if (n === 'Comparable') add('Equatable'); };
    for (let x = T; x; x = x.base) x.protos.forEach(add);
    return out;
  }
  const conforms = (T, n) => allProtos(T).has(n);
  function findMethods(T, name, isStatic = false) {
    const out = [];
    for (let x = T; x; x = x.base) for (const f of (isStatic ? x.staticFns : x.methods).get(name) || []) if (!out.some(o => sameSig(o, f))) out.push(f);
    for (const pn of allProtos(T)) { const P = protocols.get(pn); if (P) for (const f of (isStatic ? P.staticFns : P.methods).get(name) || []) if (!out.some(o => sameSig(o, f))) out.push(f); }
    return out;
  }
  const sameSig = (a, b) => a.params.length === b.params.length && a.params.every((p, k) => p.label === b.params[k].label);
  function findComputed(T, name) {
    for (let x = T; x; x = x.base) if (x.computed.has(name)) return x.computed.get(name);
    for (const pn of allProtos(T)) { const P = protocols.get(pn); if (P && P.computed.has(name)) return P.computed.get(name); }
    return null;
  }
  function findStored(T, name) { for (let x = T; x; x = x.base) { const p = x.stored.find(s => s.name === name); if (p) return p; } return null; }
  function findStatic(T, name) {
    for (let x = T; x; x = x.base) if (x.statics.has(name)) return x.statics.get(name);
    for (const pn of allProtos(T)) { const P = protocols.get(pn); if (P && P.statics.has(name)) return P.statics.get(name); }
    return null;
  }
  /** extensions of the library's types (extension Int { … }, extension Array where …, extension Collection …) */
  const PROTO_TYPES = { Collection: ['Array', 'String', 'Set', 'Dictionary'], Sequence: ['Array', 'String', 'Set', 'Dictionary'], RandomAccessCollection: ['Array'],
    MutableCollection: ['Array'], BidirectionalCollection: ['Array', 'String'], RangeReplaceableCollection: ['Array', 'String'], StringProtocol: ['String'],
    BinaryInteger: ['Int'], FixedWidthInteger: ['Int'], SignedInteger: ['Int'], Numeric: ['Int', 'Double'], SignedNumeric: ['Int', 'Double'], FloatingPoint: ['Double'], BinaryFloatingPoint: ['Double'],
    Comparable: ['Int', 'Double', 'String', 'Character'], Equatable: ['Int', 'Double', 'String', 'Character', 'Bool'], Hashable: ['Int', 'Double', 'String', 'Character', 'Bool'] };
  function builtinName(v) {
    if (typeof v === 'bigint') return 'Int';
    if (typeof v === 'number') return 'Double';
    if (typeof v === 'string') return 'String';
    if (typeof v === 'boolean') return 'Bool';
    if (v instanceof SChar) return 'Character';
    if (v instanceof SArr) return 'Array';
    if (v instanceof SDict) return 'Dictionary';
    if (v instanceof SSet) return 'Set';
    if (v instanceof SNum) return v.t;
    if (v instanceof SRange) return 'Range';
    return null;
  }
  const extOf = v => { const n = builtinName(v); return n ? builtinExt.get(n) : null; };

  /* ---- type names (for the compiler's messages) and conversions ---- */
  function typeText(t) {
    if (!t) return '_';
    if (t.opt) return typeText(t.opt) + (t.iuo ? '!' : '?');
    if (t.arr) return '[' + typeText(t.arr) + ']';
    if (t.dict) return '[' + typeText(t.dict[0]) + ': ' + typeText(t.dict[1]) + ']';
    if (t.set) return 'Set<' + typeText(t.set) + '>';
    if (t.tuple) return '(' + t.tuple.map(x => (x.label ? x.label + ': ' : '') + typeText(x)).join(', ') + ')';
    if (t.fn) return '(' + t.fn.map(typeText).join(', ') + ') -> ' + typeText(t.ret);
    return t.n + (t.args ? '<' + t.args.map(typeText).join(', ') + '>' : '');
  }
  function typeName(v) {
    if (v === null) return 'Optional<Any>';
    if (v instanceof Some) return typeName(v.v) + '?';
    const b = builtinName(v);
    if (v instanceof SArr) return '[' + (v.et ? typeText(v.et) : v.a.length ? typeName(v.a[0]) : 'Any') + ']';
    if (v instanceof SDict) { const e = v.m.values().next().value; return '[' + (v.kt ? typeText(v.kt) : e ? typeName(e[0]) : 'AnyHashable') + ': ' + (v.vt ? typeText(v.vt) : e ? typeName(e[1]) : 'Any') + ']'; }
    if (v instanceof SSet) return 'Set<' + (v.et ? typeText(v.et) : v.m.size ? typeName(v.m.values().next().value) : 'AnyHashable') + '>';
    if (v instanceof SRange) return (v.closed ? 'ClosedRange<' : 'Range<') + typeName(v.lo) + '>';
    if (b) return b;
    if (v instanceof STuple) return '(' + v.a.map((x, k) => (v.labels && v.labels[k] ? v.labels[k] + ': ' : '') + typeName(x)).join(', ') + ')';
    if (v instanceof SVal || v instanceof SObj || v instanceof SEnum) return v.T.name;
    if (v instanceof SFn) return '(' + (v.params || []).map(p => typeText(p.type)).join(', ') + ') -> ' + (v.ret ? typeText(v.ret) : '()');
    if (v instanceof SIdx) return 'String.Index';
    if (v instanceof SType) return typeText(v.t) + '.Type';
    if (v === VOID) return '()';
    return 'Any';
  }
  const isIntLit = e => !!e && (e.k === 'num' && !e.float || e.paren && isIntLit({ ...e, paren: false }) || e.k === 'unary' && isIntLit(e.e) || e.k === 'bin' && ['+', '-', '*', '/', '%'].includes(e.op) && isIntLit(e.l) && isIntLit(e.r));
  const isNumLit = e => !!e && (e.k === 'num' || e.k === 'unary' && isNumLit(e.e) || e.k === 'bin' && ['+', '-', '*', '/'].includes(e.op) && isNumLit(e.l) && isNumLit(e.r));
  const resolveT = t => { if (t && t.n && aliases.has(t.n)) return resolveT(aliases.get(t.n)); return t; };
  /**
   * v made to fit type t (how: 'specified', 'argument', 'return', 'assign'): an Optional is wrapped, a literal takes the
   * type, a mismatch is the compiler's error
   */
  function conv(v, t, ast, how = 'specified') {
    t = resolveT(t);
    if (!t || v === UNSET) return v;
    const bad = () => fail(how === 'specified' ? `cannot convert value of type '${typeName(v)}' to specified type '${typeText(t)}'`
      : how === 'argument' ? `cannot convert value of type '${typeName(v)}' to expected argument type '${typeText(t)}'`
      : how === 'return' ? `cannot convert return expression of type '${typeName(v)}' to return type '${typeText(t)}'`
      : `cannot assign value of type '${typeName(v)}' to type '${typeText(t)}'`);
    if (t.opt) {
      if (v === null) return null;
      if (v instanceof Some) return new Some(conv(v.v, t.opt, null, how));
      return new Some(conv(v, t.opt, ast, how));
    }
    if (v === null) fail(how === 'specified' ? `'nil' requires a contextual type` : `'nil' is not compatible with ${how === 'argument' ? 'expected argument' : how === 'return' ? 'return' : ''} type '${typeText(t)}'`.replace('  ', ' '));
    if (v instanceof Some && !(t.n === 'Any' || t.n === 'AnyObject')) fail(`value of optional type '${typeName(v)}' must be unwrapped to a value of type '${typeText(t)}'`);
    if (t.n) {
      const n = t.n;
      if (n === 'Double' || n === 'Float' || n === 'CGFloat') {
        if (typeof v === 'number') return n === 'Float' ? (ast && isNumLit(ast) ? new SNum('Float', Math.fround(v)) : bad()) : v;
        if (typeof v === 'bigint') { if (ast && isIntLit(ast)) return n === 'Float' ? new SNum('Float', Math.fround(Number(v))) : Number(v); bad(); }
        if (v instanceof SNum && v.t === n) return v;
        if (v instanceof SNum && n !== 'Float' && n === 'Double') bad();
        if (v instanceof SNum && v.t === 'Float' && n === 'Float') return v;
        if (!(typeof v === 'object' && v && !(v instanceof SNum))) bad();
        bad();
      }
      if (n === 'Int') { if (typeof v === 'bigint') return v; if (v instanceof SNum || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v instanceof SChar) bad(); return v; }
      if (INT_KINDS[n]) {
        if (v instanceof SNum && v.t === n) return v;
        if (typeof v === 'bigint' && ast && isIntLit(ast)) return lib.intKind(n, v, true);
        bad();
      }
      if (n === 'String') { if (typeof v === 'string') return v; if (v instanceof SChar || typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean' || v instanceof SArr) bad(); return v; }
      if (n === 'Character') { if (v instanceof SChar) return v; if (typeof v === 'string' && ast && (ast.k === 'str')) { if (lib.charCount(v) !== 1) fail(`cannot convert value of type 'String' to specified type 'Character'`); return CH(v); } bad(); }
      if (n === 'Bool') { if (typeof v === 'boolean') return v; bad(); }
      if (n === 'Set' && v instanceof SArr && ast && ast.k === 'arrlit') return lib.toSet(v, t.args ? t.args[0] : null);
      const T = findType(n);
      if (T && (T.kind === 'struct' || T.kind === 'enum' || T.kind === 'class')) {
        if (T.kind === 'class' ? !(v instanceof SObj && isSubclass(v.T, T)) : !((v instanceof SVal || v instanceof SEnum) && v.T === T)) bad();
      }
      return v;
    }
    if (t.arr) {
      if (v instanceof SArr) {
        if (ast && ast.k === 'arrlit') { v.a = v.a.map((x, k) => conv(x, t.arr, ast.items[k], how)); v.et = t.arr; return v; }
        if (!v.et && v.a.length === 0) v.et = t.arr;
        if (v.et && t.arr && typeText(resolveT(v.et)) !== typeText(t.arr) && !t.arr.n?.match(/^[A-Z]$/) && !['Any', 'AnyObject'].includes(t.arr.n) && !isProtoName(t.arr.n || '') && !(t.arr.opt && v.a.every(x => x === null || x instanceof Some))) {
          if (!(v.a.length && v.a.every(x => fits(x, t.arr)))) bad();
        }
        return v;
      }
      bad();
    }
    if (t.set) { if (v instanceof SSet) { if (!v.et) v.et = t.set; return v; } if (v instanceof SArr && ast && ast.k === 'arrlit') return lib.toSet(new SArr(v.a.map((x, k) => conv(x, t.set, ast.items[k], how))), t.set); bad(); }
    if (t.dict) {
      if (v instanceof SDict) {
        if (ast && ast.k === 'dictlit') { for (const [k, en] of v.m) { const [a, b] = en; v.m.set(k, [a, conv(b, t.dict[1], null, how)]); } }
        if (!v.kt) v.kt = t.dict[0]; if (!v.vt) v.vt = t.dict[1];
        return v;
      }
      bad();
    }
    if (t.tuple) {
      if (v instanceof STuple) {
        if (v.a.length !== t.tuple.length) bad();
        const labels = t.tuple.some(x => x.label) ? t.tuple.map(x => x.label || null) : v.labels;
        return new STuple(v.a.map((x, k) => conv(x, t.tuple[k], ast && ast.k === 'tuple' ? ast.items[k].e : null, how)), labels);
      }
      bad();
    }
    return v;
  }
  /** does v fit type t (for picking an overload, `is`, `as?`) */
  function fits(v, t) {
    t = resolveT(t);
    if (!t) return true;
    if (t.opt) return v === null || (v instanceof Some ? fits(v.v, t.opt) : fits(v, t.opt));
    if (v instanceof Some) return false;
    if (t.arr) return v instanceof SArr && v.a.every(x => fits(x, t.arr));
    if (t.dict) return v instanceof SDict;
    if (t.set) return v instanceof SSet;
    if (t.tuple) return v instanceof STuple && v.a.length === t.tuple.length;
    if (t.fn) return v instanceof SFn;
    const n = t.n;
    if (!n || n === 'Any' || /^[A-Z]$/.test(n) || (frame() && frame().fn && frame().fn.decl && frame().fn.decl.tps && frame().fn.decl.tps.includes(n))) return true;
    if (n === 'AnyObject') return v instanceof SObj;
    if (n === 'Int') return typeof v === 'bigint';
    if (n === 'Double') return typeof v === 'number';
    if (n === 'String') return typeof v === 'string';
    if (n === 'Bool') return typeof v === 'boolean';
    if (n === 'Character') return v instanceof SChar;
    if (INT_KINDS[n] || n === 'Float') return v instanceof SNum && v.t === n;
    if (n === 'Error') return isErrorValue(v);
    const T = findType(n);
    if (T) return (v instanceof SObj || v instanceof SVal || v instanceof SEnum) && (T.kind === 'class' ? v instanceof SObj && isSubclass(v.T, T) : v.T === T);
    if (isProtoName(n) || PROTO_TYPES[n] || ['CustomStringConvertible', 'Equatable', 'Hashable', 'Comparable', 'Error'].includes(n)) {
      if (v instanceof SObj || v instanceof SVal || v instanceof SEnum) return conforms(v.T, n);
      const b = builtinName(v);
      return !!(b && PROTO_TYPES[n] && PROTO_TYPES[n].includes(b));
    }
    return true;
  }
  const isSubclass = (A, B) => { for (let x = A; x; x = x.base) if (x === B) return true; return false; };
  const isErrorValue = v => (v instanceof SObj || v instanceof SVal || v instanceof SEnum) && conforms(v.T, 'Error');

  /* ---- variables ---- */
  const frame = () => frames[frames.length - 1];
  function lookup(name) {
    const f = frame();
    if (f) {
      for (let k = f.scopes.length - 1; k >= 0; k--) { const r = f.scopes[k].get(name); if (r) return r; }
      for (const sc of f.env || []) { const r = sc.get(name); if (r) return r; }
    }
    return globals.get(name) || null;
  }
  function declare(name, v, opts = {}) {
    const sc = frame().scopes.at(-1);
    if (name === '_') return null;
    if (sc.has(name) && !sc.get(name).isFn && !opts.shadow) fail(`invalid redeclaration of '${name}'`);
    const r = { name, v, mutable: !!opts.mutable, type: opts.type || null, hidden: !!opts.hidden, isFn: !!opts.isFn };
    sc.set(name, r);
    return r;
  }
  const readVar = (r, n) => {
    if (r.v === UNSET) fail(r.mutable ? `variable '${n}' used before being initialized` : `constant '${n}' used before being initialized`);
    if (r.lazyGlobal) { /* initialized at its line */ }
    return r.v;
  };

  /* ---- expressions ---- */
  /** an expression whose value lives in a place (so storing it elsewhere shares it) */
  const fromPlace = e => !!e && (['name', 'member', 'index', 'tidx', 'force', 'self'].includes(e.k) || e.k === 'chain' && fromPlace(e.e) || e.k === 'cond' && (fromPlace(e.a) || fromPlace(e.b)) || e.k === 'bin' && e.op === '??' && (fromPlace(e.l) || fromPlace(e.r)) || e.k === 'optq' && fromPlace(e.e));
  /** the value to store from e: shared when it came from another place */
  const stored = (v, e) => (fromPlace(e) ? share(v) : v);
  /** evaluates e for a place of type t (a literal takes it, .member finds its enum case) */
  function rvalT(e, t) {
    t = resolveT(t);
    if (!t) return rval(e);
    const inner = t.opt || t;
    if (e.k === 'nil') return null;
    if (e.k === 'imember') return implicitMember(e, inner, null);
    if (e.k === 'call' && e.f.k === 'imember') return implicitMember(e.f, inner, e);
    if (e.k === 'arrlit' && ('arr' in inner || 'set' in inner)) {
      const et = inner.arr || inner.set;
      const a = new SArr(e.items.map(x => stored(rvalT(x, et), x)), et);
      return inner.set ? lib.toSet(a, et) : a;
    }
    if (e.k === 'dictlit' && inner.dict) return dictLit(e, inner.dict[0], inner.dict[1]);
    if (e.k === 'num' && inner.n && (inner.n === 'Double' || inner.n === 'Float' || INT_KINDS[inner.n])) return conv(rval(e), inner, e);
    if (e.k === 'cond') { const c = cond(e.c); return rvalT(c ? e.a : e.b, t); }
    if (e.k === 'ifexpr' || e.k === 'switchexpr') return branchValue(e, t);
    if (e.k === 'closure' && inner.fn) return closure(e, inner);
    if (e.k === 'tuple' && inner.tuple) return new STuple(e.items.map((x, k) => stored(rvalT(x.e, inner.tuple[k]), x.e)), inner.tuple.some(x => x.label) ? inner.tuple.map(x => x.label || null) : e.items.some(x => x.label) ? e.items.map(x => x.label) : null);
    if (e.k === 'bin' && ['+', '-', '*', '/'].includes(e.op) && inner.n === 'Double' && isNumLit(e)) return Number(rval(e)) ;
    if (e.k === 'str' && inner.n === 'Character') return conv(e.v, inner, e);
    return rval(e);
  }
  function implicitMember(e, t, call) {
    const T = t && t.n ? findType(t.n) : null;
    if (T) return typeMember(T, e.name, call, e);
    if (t && t.n && ['Int', 'Double', 'String', 'Float'].includes(t.n)) return lib.staticMember(t.n, e.name, call ? argVals(call.args) : null, e);
    if (call) { const v = new SImplicit(e.name); v.args = argVals(call.args); return v; }
    return new SImplicit(e.name);
  }
  function rval(e) {
    switch (e.k) {
      case 'num': {
        if (e.float) return Number(e.v);
        const v = BigInt(e.v);
        if (v > I64_MAX || v < I64_MIN) fail(`integer literal '${e.v}' overflows when stored into 'Int'`);
        return v;
      }
      case 'str': return e.v;
      case 'interp': return e.parts.map(p => (typeof p === 'string' ? p : lib.describe(rval(p.e)))).join('');
      case 'bool': return e.v;
      case 'nil': return null;
      case 'name': return nameValue(e);
      case 'self': { const f = selfFrame(); if (!f) fail("cannot find 'self' in scope"); if (f.isStatic) return new SType({ n: f.T.name }); return f.selfRef.v; }
      case 'super': fail("'super' cannot be used here");
      case 'tuple': return new STuple(e.items.map(x => stored(rval(x.e), x.e)), e.items.some(x => x.label) ? e.items.map(x => x.label) : null);
      case 'arrlit': return arrLit(e);
      case 'dictlit': return dictLit(e, null, null);
      case 'type': return new SType(e.type);
      case 'member': return member(e);
      case 'imember': return implicitMember(e, null, null);
      case 'tidx': { const t = rval(e.e); if (!(t instanceof STuple)) fail(`value of type '${typeName(t)}' has no member '${e.n}'`); if (e.n >= t.a.length) fail(`value of tuple type '${typeName(t)}' has no member '${e.n}'`); return t.a[e.n]; }
      case 'index': return subscriptGet(rval(e.e), e);
      case 'call': return call(e, null);
      case 'force': {
        const v = rval(e.e);
        if (v === null) trap('Unexpectedly found nil while unwrapping an Optional value');
        if (v instanceof Some) return v.v;
        fail(`cannot force unwrap value of non-optional type '${typeName(v)}'`);
      }
      case 'optq': {
        const v = rval(e.e);
        if (v === null) throw NIL_CHAIN;
        if (v instanceof Some) return v.v;
        fail(`cannot use optional chaining on non-optional value of type '${typeName(v)}'`);
      }
      case 'chain': {
        try { const v = rval(e.e); return v === null || v instanceof Some ? v : v === VOID ? new Some(VOID) : new Some(v); }
        catch (err) { if (err === NIL_CHAIN) return null; throw err; }
      }
      case 'unary': return unary(e);
      case 'bin': return binop(e);
      case 'range': {
        const lo = e.lo ? rval(e.lo) : null, hi = e.hi ? rvalT(e.hi, lo !== null && typeof lo === 'number' ? { n: 'Double' } : null) : null;
        const L = lo !== null && typeof lo === 'bigint' && typeof hi === 'number' && isIntLit(e.lo) ? Number(lo) : lo;
        if (L !== null && hi !== null) {
          if (typeName(L) !== typeName(hi)) fail(`binary operator '${e.closed ? '...' : '..<'}' cannot be applied to operands of type '${typeName(L)}' and '${typeName(hi)}'`);
          if (lib.compare(L, hi) > 0) trap('Range requires lowerBound <= upperBound');
        }
        return new SRange(L, hi, e.closed);
      }
      case 'cond': { const c = cond(e.c); return c ? rval(e.a) : rval(e.b); }
      case 'closure': return closure(e, null);
      case 'try': return tryExpr(e);
      case 'is': { const v = rval(e.e); return castFits(v, e.type); }
      case 'as': return cast(e);
      case 'ifexpr': case 'switchexpr': return branchValue(e, null);
      case 'inout': fail("'&' may only be used to pass an argument to inout parameter");
      case 'opref': return new SFn({ name: e.op, native: args => { if (args.length !== 2) fail(`operator '${e.op}' takes two arguments`); return binVals(e.op, args[0].v, args[1].v, { l: {}, r: {}, op: e.op }); } });
    }
    fail('cannot evaluate ' + e.k);
  }
  /** an if or switch expression's value: the branch taken, whose one statement is an expression (or a throw) */
  function branchValue(e, t) {
    const value = items => {
      if (items.length === 1 && items[0].k === 'ifexpr') return branchValue(items[0], t);
      if (items.length === 1 && items[0].k === 'if') return branchValue({ ...items[0], k: 'ifexpr' }, t);
      if (items.length !== 1 || !(items[0].k === 'expr' || items[0].k === 'throw')) fail(`non-expression branch of '${e.k === 'ifexpr' ? 'if' : 'switch'}' expression may only end with a 'throw'`);
      if (items[0].k === 'throw') { exec(items[0]); return VOID; }
      step(items[0].line);
      return rvalT(items[0].e, t);
    };
    if (e.k === 'ifexpr') {
      if (!e.else) fail(`'if' must have an unconditional 'else' to be used as expression`);
      let v;
      const f = frame();
      const binds = new Map();
      if (evalConds(e.conds, binds)) { const sc = new Map(binds); f.scopes.push(sc); try { v = value(e.then); } finally { f.scopes.pop(); } }
      else v = value(e.else);
      return v;
    }
    const subj = rval(e.subject);
    for (const c of e.cases) {
      const m = new Map();
      if (c.pats && !c.pats.some(({ p, where }) => { m.clear(); if (!matches(p, subj, m)) return false; if (!where) return true; const sc = new Map([...m].map(([n, b]) => [n, { name: n, v: b.v }])); frame().scopes.push(sc); try { return cond(where); } finally { frame().scopes.pop(); } })) continue;
      const sc = new Map([...m].map(([n, b]) => [n, { name: n, v: share(b.v), mutable: false }]));
      frame().scopes.push(sc);
      try { return value(c.body); } finally { frame().scopes.pop(); }
    }
    fail('switch must be exhaustive');
  }
  function cond(e) {
    const c = rval(e);
    if (typeof c !== 'boolean') {
      if (c instanceof Some || c === null) fail(`optional type '${typeName(c)}' cannot be used as a boolean; test for '!= nil' instead`);
      fail(`cannot convert value of type '${typeName(c)}' to expected condition type 'Bool'`);
    }
    return c;
  }
  const isEmptyLit = x => (x.k === 'arrlit' || x.k === 'dictlit') && !x.items.length;
  /** the type of a value, as a type node (for an empty literal next to it: [[1, 2], []]) */
  function typeOfValue(v) {
    if (typeof v === 'bigint') return { n: 'Int' };
    if (typeof v === 'number') return { n: 'Double' };
    if (typeof v === 'string') return { n: 'String' };
    if (typeof v === 'boolean') return { n: 'Bool' };
    if (v instanceof SChar) return { n: 'Character' };
    if (v instanceof SNum) return { n: v.t };
    if (v instanceof Some) return { opt: typeOfValue(v.v) };
    if (v instanceof SArr) return { arr: v.et || (v.a.length ? typeOfValue(v.a[0]) : null) };
    if (v instanceof SSet) return { set: v.et || (v.m.size ? typeOfValue(v.m.values().next().value) : null) };
    if (v instanceof SDict) { const en = v.m.values().next().value; return { dict: [v.kt || (en ? typeOfValue(en[0]) : null), v.vt || (en ? typeOfValue(en[1]) : null)] }; }
    if (v instanceof SVal || v instanceof SObj || v instanceof SEnum) return { n: v.T.name };
    if (v instanceof STuple) return { tuple: v.a.map((x, k) => ({ ...(typeOfValue(x) || { n: 'Any' }), label: v.labels ? v.labels[k] : null })) };
    return null;
  }
  /** literal items' values; an empty [] or [:] among them takes its siblings' type */
  function litItems(items) {
    const vals = items.map(x => (isEmptyLit(x) ? UNSET : stored(rval(x), x)));
    if (vals.includes(UNSET)) {
      const sib = vals.find(v => v !== UNSET);
      const t = sib === undefined ? null : typeOfValue(sib);
      items.forEach((x, k) => { if (vals[k] === UNSET) { if (!t) fail('empty collection literal requires an explicit type'); vals[k] = rvalT(x, t); } });
    }
    return vals;
  }
  function arrLit(e) {
    const vals = litItems(e.items);
    // [1, 2.5]: the whole numbers are Doubles too
    if (vals.some(v => typeof v === 'number') && vals.some(v => typeof v === 'bigint')) vals.forEach((v, k) => { if (typeof v === 'bigint') { if (!isIntLit(e.items[k])) fail(`heterogeneous collection literal could only be inferred to '[Any]'; add explicit type annotation if this is intentional`); vals[k] = Number(v); } });
    const a = new SArr(vals);
    if (!vals.length) fail('empty collection literal requires an explicit type');
    if (vals.some(v => v === null)) a.a = vals.map(v => (v === null || v instanceof Some ? v : new Some(v)));
    else if (vals.length > 1) { const t0 = typeName(vals[0]); if (vals.some(v => typeName(v) !== t0 && !(v instanceof SObj) && !(v instanceof SArr))) fail(`heterogeneous collection literal could only be inferred to '[Any]'; add explicit type annotation if this is intentional`); }
    return a;
  }
  function dictLit(e, kt, vt) {
    const d = new SDict(kt, vt);
    if (!e.items.length && !kt) fail('empty collection literal requires an explicit type');
    const vs = vt ? null : litItems(e.items.map(([, ve]) => ve));
    for (const [n, [ke, ve]] of e.items.entries()) {
      const k = kt ? conv(rvalT(ke, kt), kt, ke) : rval(ke);
      const v = vt ? conv(rvalT(ve, vt), vt, ve) : vs[n];
      const key = lib.hashKey(k);
      if (d.m.has(key)) trap(`Dictionary literal contains duplicate keys`);
      d.m.set(key, [k, v]);
    }
    if (!vt && [...d.m.values()].some(([, v]) => typeof v === 'number') && [...d.m.values()].some(([, v]) => typeof v === 'bigint')) for (const en of d.m.values()) if (typeof en[1] === 'bigint') en[1] = Number(en[1]);
    return d;
  }
  /** a name's value: a variable, a member of self, a function, a type */
  function nameValue(e) {
    const n = e.n;
    const r = lookup(n);
    if (r) {
      if (r.lazyInit) { r.lazyInit = false; r.v = r.make(); }
      const v = nilOf(readVar(r, n), r.type);
      if (r.iuo && v === null) trap('Unexpectedly found nil while unwrapping an Optional value');
      return r.iuo && v instanceof Some ? v.v : v;
    }
    const sf = selfFrame();
    if (sf) {
      if (!sf.isStatic) { const self = sf.selfRef.v; const got = memberOf(self, n, e, true); if (got !== undefined) return got; }
      const T = sf.T;
      if (findStatic(T, n) || findMethods(T, n, true).length || (T.kind === 'enum' && T.cases.has(n) && sf.isStatic)) return typeMember(T, n, null, e);
    }
    if (globalFns.has(n)) { const fs = globalFns.get(n); return fs.length === 1 ? fs[0] : new SFn({ name: n, overloads: fs }); }
    const T = findType(n);
    if (T) return new SType({ n: T.name });
    if (n === 'Int' || n === 'Double' || n === 'String' || n === 'Character' || n === 'Bool' || n === 'Float' || INT_KINDS[n] || n === 'Array' || n === 'Set' || n === 'Dictionary') return new SType({ n });
    if (FOUNDATION.has(n) && !hasFoundation()) fail(`cannot find '${n}' in scope`);
    if (n in MATH_CONSTS && hasFoundation()) return MATH_CONSTS[n];
    if (lib.hasGlobal(n)) return new SFn({ name: n, native: (args, ce) => lib.callGlobal(n, args, ce) });
    fail(`cannot find '${n}' in scope`);
  }
  /** the frame whose self an implicit self.member refers to (closures see their method's self) */
  function selfFrame() {
    const f = frame();
    if (!f) return null;
    if (f.selfRef || f.isStatic) return f;
    if (f.fn && f.fn.selfFrame) return f.fn.selfFrame;
    return null;
  }
  /** v.name */
  function member(e) {
    if (e.e.k === 'super') { const sf = selfFrame(); const base = sf.T.base; if (!base) fail(`'super' members cannot be referenced in a root class`); return instanceMember(sf.selfRef.v, e.name, e, base); }
    const base = rval(e.e);
    if (base instanceof SType) return typeMember(typeOfT(base.t), e.name, null, e, base.t);
    if (base === null || base instanceof Some) fail(`value of optional type '${base === null ? optTypeOf(e.e) : typeName(base)}' must be unwrapped to refer to member '${e.name}' of wrapped base type '${base === null ? optTypeOf(e.e).replace(/\?$/, '') : typeName(base.v)}'`);
    const v = memberOf(base, e.name, e, false);
    return v;
  }
  function optTypeOf(e) { if (e.k === 'name') { const r = lookup(e.n); if (r && r.type) return typeText(r.type); } return 'Optional<Any>'; }
  const typeOfT = t => { t = resolveT(t); if (t.n) { const T = findType(t.n); if (T) return T; return t.n; } if (t.arr) return 'Array'; if (t.dict) return 'Dictionary'; if (t.set) return 'Set'; return 'Any'; };
  /** a member of a value; quiet: undefined when it has none (for implicit self) */
  function memberOf(v, name, e, quiet) {
    if (v instanceof SObj || v instanceof SVal || v instanceof SEnum) {
      const got = instanceMember(v, name, e, v.T, quiet);
      return got;
    }
    const ext = extOf(v);
    if (ext && ext.computed.has(name)) return callAccessor(ext.computed.get(name), v);
    if (ext && ext.methods.has(name)) return boundMethod(v, ext.methods.get(name), name);
    if (quiet) { try { return lib.member(v, name, e); } catch (err) { if (err instanceof SwError) return undefined; throw err; } }
    return lib.member(v, name, e);
  }
  /** the T of a frame whose self is a library value (in extension Int { … }) */
  const BUILTIN_T = { name: '', stored: [], computed: new Map(), methods: new Map(), statics: new Map(), staticFns: new Map(), protos: new Set(), nested: new Map(), cases: new Map(), caseList: [], subs: [] };
  function instanceMember(v, name, e, T, quiet) {
    if (v instanceof SEnum && name === 'rawValue' && v.T.rawType) return v.T.cases.get(v.c).rawValue;
    const st = findStored(T, name);
    if (st && v.f) {
      if (!v.f.has(name)) return quiet ? undefined : fail(`value of type '${T.name}' has no member '${name}'`);
      let x = v.f.get(name);
      if (x === UNSET && st.mods.has('lazy')) { x = conv(withSelf(v, T, () => rvalT(st.init, st.type)), st.type, st.init); v.f.set(name, x); }
      if (x === UNSET) fail(`'self' used before all stored properties are initialized`);
      nilOf(x, st.type);
      if (st.type && st.type.iuo) { if (x === null) trap('Unexpectedly found nil while unwrapping an Optional value'); if (x instanceof Some) return x.v; }
      return x;
    }
    const cp = findComputed(T, name);
    if (cp && !cp.acc.req) return callAccessor(cp, v);
    const ms = findMethods(T, name);
    if (ms.length) return boundMethod(v, ms, name);
    if (name === 'hashValue' && conforms(T, 'Hashable')) return BigInt(lib.hashKey(v).length);
    if (name === 'description' && !quiet) return lib.describe(v);
    if (quiet) return undefined;
    if (T.kind === 'enum' && T.cases.has(name)) fail(`enum case '${name}' cannot be used as an instance member`);
    fail(`value of type '${T.name}' has no member '${name}'`);
  }
  function boundMethod(self, fs, name) { return new SFn({ name, bound: true, native: (args, ce) => invokeOverload(fs, args, self, ce, name) }); }
  function callAccessor(cp, self) {
    const fn = new SFn({ name: cp.name, params: [], ret: cp.type, body: cp.acc.get, T: cp.T, accessor: true, line: cp.line, decl: cp, isStatic: cp.mods && cp.mods.has('static') });
    return invoke(fn, [], self);
  }
  function withSelf(self, T, f) {
    frames.push({ name: T.name, scopes: [new Map()], T, selfRef: { v: self, mutable: false }, hidden: true });
    try { return f(); } finally { frames.pop(); }
  }
  /** Type.name: a static property or method, an enum case, a nested type, .init */
  function typeMember(T, name, call, e, tref) {
    if (typeof T === 'string') {                      // Int.max, Double.pi, String.init…
      if (builtinExt.has(T)) { const ext = builtinExt.get(T); if (ext.staticFns.has(name)) { const fs = ext.staticFns.get(name); return call ? invokeOverload(fs, argList(call.args, fs[0].params), null, call, name) : new SFn({ name, native: (a, ce) => invokeOverload(fs, a, null, ce, name) }); } if (ext.statics.has(name)) return staticValue(ext.statics.get(name)); }
      return lib.staticMember(T, name, call ? argVals(call.args) : null, e, tref);
    }
    if (T.kind === 'enum' && T.cases.has(name)) {
      const c = T.cases.get(name);
      if (c.assoc) {
        const make = args => {
          const vals = c.assoc.map((a, k) => { const x = args[k]; if (!x) { if (a.def) return rval(a.def); fail(`missing argument for parameter #${k + 1} in call`); } if (a.label && x.label !== a.label) fail(x.label ? `incorrect argument label in call (have '${x.label}:', expected '${a.label}:')` : `missing argument label '${a.label}:' in call`); return conv(share(x.v), a.type, x.e, 'argument'); });
          if (args.length > c.assoc.length) fail('extra argument in call');
          return new SEnum(T, name, vals);
        };
        if (call) return make(call.args.map((a, k) => ({ label: a.label, v: stored(c.assoc[k] ? rvalT(a.e, c.assoc[k].type) : rval(a.e), a.e), e: a.e })));
        return new SFn({ name, native: args => make(args) });
      }
      if (call) fail(`enum case '${name}' has no associated values`);
      return new SEnum(T, name, null);
    }
    if (name === 'init') { if (call) return construct(T, call); return new SFn({ name: T.name + '.init', native: (args, ce) => constructWith(T, args, ce) }); }
    if (name === 'allCases' && T.kind === 'enum' && conforms(T, 'CaseIterable')) return new SArr(T.caseList.map(c => new SEnum(T, c.name, null)), { n: T.name });
    if (name === 'self') return new SType({ n: T.name });
    if (T.nested.has(name)) { const N = T.nested.get(name); return call ? construct(N, call) : new SType({ n: N.name }); }
    const st = findStatic(T, name);
    if (st) { const v = staticValue(st); return call ? callValue(v, call) : v; }
    const fs = findMethods(T, name, true);
    if (fs.length) {
      if (call) return invokeOverload(fs, argList(call.args, fs.length === 1 ? fs[0].params : null), new SType({ n: T.name }), call, name);
      return new SFn({ name, native: (args, ce) => invokeOverload(fs, args, new SType({ n: T.name }), ce, name) });
    }
    fail(`type '${T.name}' has no member '${name}'`);
  }
  function staticValue(st) {
    if (st.p.acc && st.p.acc.get) return invoke(new SFn({ name: st.p.name, params: [], ret: st.p.type, body: st.p.acc.get, T: st.T, accessor: true, isStatic: true, line: st.p.line }), [], new SType({ n: st.T.name }));
    if (st.v === UNSET) {                        // static stored properties start on first use
      const l = line;
      st.v = conv(withStatic(st.T, () => stored(rvalT(st.p.init, st.p.type), st.p.init)), st.p.type, st.p.init);
      line = l;
    }
    return st.v;
  }
  function withStatic(T, f) { frames.push({ name: T.name, scopes: [new Map()], T, isStatic: true, hidden: true }); try { return f(); } finally { frames.pop(); } }

  /* ---- subscripts ---- */
  function subscriptArgs(e, base) { const kt = base instanceof SDict ? keyType(base) : null; return e.args.map(a => ({ label: a.label, v: kt ? rvalT(a.e, kt) : rval(a.e), e: a.e })); }
  /** a dictionary's key type (so d["l"] finds a Character key) */
  const keyType = d => d.kt || (d.m.size ? typeOfValue(d.m.values().next().value[0]) : null);
  const valueTypeOf = d => (d.m.size ? typeOfValue(d.m.values().next().value[1]) : null);
  function subscriptGet(base, e) {
    if (base === null || base instanceof Some) fail(`value of optional type '${base === null ? optTypeOf(e.e) : typeName(base)}' must be unwrapped to a value of type '${base === null ? optTypeOf(e.e).replace(/\?$/, '') : typeName(base.v)}'`);
    if ((base instanceof SObj || base instanceof SVal) && base.T.subs.length) {
      const sub = base.T.subs[0];
      const args = subscriptArgs(e);
      return invoke(new SFn({ name: 'subscript', params: sub.params, ret: sub.ret, body: sub.acc.get, T: base.T, accessor: true, line: sub.line }), args.map(a => a.v), base);
    }
    if (base instanceof SDict && e.args.length === 2 && e.args[1].label === 'default') {
      const k = rvalT(e.args[0].e, keyType(base));
      const got = lib.dictGet(base, k);
      return got === null ? rvalT(e.args[1].e, base.vt || valueTypeOf(base)) : got.v;
    }
    if (base instanceof SDict) { const args = subscriptArgs(e, base); return nilOf(lib.subGet(base, args[0].v, args[0].label), base.vt || valueTypeOf(base)); }
    const args = subscriptArgs(e, base);
    if (args.length !== 1) fail('subscripts take one index here');
    return lib.subGet(base, args[0].v, args[0].label);
  }

  /* ---- places: what can be assigned or changed in place ---- */
  /**
   * the value at e, made unique (copied if shared) so it can be changed in place, with the root's mutability checked;
   * why says what the change is, for the compiler's message
   */
  function lvalue(e, why) {
    switch (e.k) {
      case 'name': {
        const r = lookup(e.n);
        if (!r) {
          const sf = selfFrame();
          if (sf && !sf.isStatic && (findStored(sf.T, e.n) || findComputed(sf.T, e.n))) return lvalue({ k: 'member', e: { k: 'self', line: e.line }, name: e.n, line: e.line }, why);
          if (sf && findStatic(sf.T, e.n)) { const st = findStatic(sf.T, e.n); staticValue(st); return uniqueIn(st, 'v', why, e.n, true); }
          fail(`cannot find '${e.n}' in scope`);
        }
        if (r.v === UNSET) fail(`${r.mutable ? 'variable' : 'constant'} '${e.n}' used before being initialized`);
        let v = r.v;
        if (r.iuo) { if (v === null) trap('Unexpectedly found nil while unwrapping an Optional value'); if (v instanceof Some) { if (v.sh) { v = r.v = copyVal(v); } const inner = v.v; if (isVal(inner) && inner.sh) v.v = copyVal(inner); return v.v; } }
        if (!isVal(v)) return v;
        if (!r.mutable) fail(immutableMsg(why, `'${e.n}' is a 'let' constant`));
        if (v.sh) r.v = v = copyVal(v);
        return v;
      }
      case 'self': {
        const sf = selfFrame();
        const v = sf.selfRef.v;
        if (!isVal(v)) return v;
        if (!sf.selfRef.mutable) fail(immutableMsg(why, "'self' is immutable"));
        if (v.sh) sf.selfRef.v = copyVal(v);
        return sf.selfRef.v;
      }
      case 'member': {
        if (e.e.k === 'super') return lvalue({ ...e, e: { k: 'self', line: e.line } }, why);
        const bv = rval(e.e);
        if (bv instanceof SType) { const T = typeOfT(bv.t); const st = typeof T === 'string' ? null : findStatic(T, e.name); if (!st) fail(`type '${typeText(bv.t)}' has no member '${e.name}'`); staticValue(st); return uniqueIn(st, 'v', why, e.name, st.p.mutable); }
        const base = bv instanceof SObj ? bv : isVal(bv) ? lvalue(e.e, why) : bv;
        if (base === null || base instanceof Some) fail(`value of optional type '${typeName(base)}' must be unwrapped to refer to member '${e.name}' of wrapped base type '${base === null ? 'Any' : typeName(base.v)}'`);
        if (base instanceof SObj || base instanceof SVal) {
          const st = findStored(base.T, e.name);
          if (st) {
            if (!st.mutable && !initing(base)) fail(immutableMsg(why, `'${e.name}' is a 'let' constant`));
            let v = base.f.get(e.name);
            if (v === UNSET && st.mods.has('lazy')) { v = instanceMember(base, e.name, e, base.T); }
            if (st.type && st.type.iuo && v instanceof Some) { if (v.sh) base.f.set(e.name, v = copyVal(v)); const inner = v.v; if (isVal(inner) && inner.sh) v.v = copyVal(inner); return v.v; }
            if (isVal(v) && v.sh) { v = copyVal(v); base.f.set(e.name, v); }
            return v;
          }
          const cp = findComputed(base.T, e.name);
          if (cp) {                                    // a computed property changed in place: get, change, set
            const v = callAccessor(cp, base);
            pendingSets.push({ cp, base, v });
            return isVal(v) ? copyValIfShared(v) : v;
          }
        }
        return memberOf(base, e.name, e, false);
      }
      case 'index': {
        const bv = rval(e.e);
        if ((bv instanceof SObj || bv instanceof SVal) && bv.T.subs.length) return subscriptGet(bv, e);
        const base = isVal(bv) ? lvalue(e.e, 'subscript') : bv;
        if (base === null || base instanceof Some) fail(`value of optional type '${typeName(base)}' must be unwrapped to a value of type '${base === null ? 'Any' : typeName(base.v)}'`);
        if (base instanceof SDict && e.args.length === 2 && e.args[1].label === 'default') {
          const k = rvalT(e.args[0].e, keyType(base));
          const key = lib.hashKey(k);
          if (!base.m.has(key)) base.m.set(key, [k, conv(rvalT(e.args[1].e, base.vt), base.vt, e.args[1].e)]);
          const en = base.m.get(key);
          if (isVal(en[1]) && en[1].sh) en[1] = copyVal(en[1]);
          return en[1];
        }
        const idx = base instanceof SDict ? rvalT(e.args[0].e, keyType(base)) : rval(e.args[0].e);
        if (base instanceof SDict) {
          const key = lib.hashKey(idx);
          const en = base.m.get(key);
          if (!en) return null;                          // dict[k]?.append(x) on a missing key does nothing
          if (isVal(en[1]) && en[1].sh) en[1] = copyVal(en[1]);
          return new Some(en[1]);
        }
        if (base instanceof SArr) {
          const k = lib.arrIndex(base, idx);
          let v = base.a[k];
          if (isVal(v) && v.sh) base.a[k] = v = copyVal(v);
          return v;
        }
        return lib.subGet(base, idx);
      }
      case 'tidx': {
        const base = lvalue(e.e, why);
        let v = base.a[e.n];
        if (isVal(v) && v.sh) base.a[e.n] = v = copyVal(v);
        return v;
      }
      case 'force': {
        const s = lvalue(e.e, why);
        if (s === null) trap('Unexpectedly found nil while unwrapping an Optional value');
        if (!(s instanceof Some)) fail(`cannot force unwrap value of non-optional type '${typeName(s)}'`);
        if (isVal(s.v) && s.v.sh) s.v = copyVal(s.v);
        return s.v;
      }
      case 'optq': {
        const s = lvalue(e.e, why);
        if (s === null) throw NIL_CHAIN;
        if (!(s instanceof Some)) fail(`cannot use optional chaining on non-optional value of type '${typeName(s)}'`);
        if (isVal(s.v) && s.v.sh) s.v = copyVal(s.v);
        return s.v;
      }
      case 'paren': return lvalue(e.e, why);
      case 'chain': return lvalue(e.e, why);
    }
    if (why === 'assign') fail('cannot assign to this expression');
    return rval(e);                                     // a temporary (f().append…): changing it is harmless
  }
  const copyValIfShared = v => (v.sh ? copyVal(v) : v);
  function uniqueIn(holder, key, why, name, mutable) {
    let v = holder[key];
    if (!isVal(v)) return v;
    if (!mutable) fail(immutableMsg(why, `'${name}' is a 'let' constant`));
    if (v.sh) holder[key] = v = copyVal(v);
    return v;
  }
  /** computed properties changed in place (self.top.append(x)): their setters run after the change */
  const pendingSets = [];
  function flushSets(mark) {
    while (pendingSets.length > mark) {
      const { cp, base, v } = pendingSets.pop();
      if (!cp.acc.set) fail(`cannot use mutating member on immutable value: '${cp.name}' is a get-only property`);
      callSetter(cp, base, v);
    }
  }
  function immutableMsg(why, what) {
    if (why === 'compound') return `left side of mutating operator isn't mutable: ${what}`;
    if (why === 'assign') return `cannot assign to value: ${what}`;
    if (why === 'property') return `cannot assign to property: ${what}`;
    if (why === 'subscript') return `cannot assign through subscript: ${what}`;
    if (why === 'inout') return `cannot pass immutable value as inout argument: ${what}`;
    return `cannot use mutating member on immutable value: ${what}`;
  }
  /** is obj being built by an init on the stack (where its let properties can still be set) */
  const initing = obj => frames.some(f => f.initOf === obj);
  /** assigns v to the place e */
  function assignTo(e, v, ve, why = 'assign') {
    switch (e.k) {
      case 'name': {
        if (e.n === '_') return;
        const r = lookup(e.n);
        if (!r) {
          const sf = selfFrame();
          if (sf && !sf.isStatic && (findStored(sf.T, e.n) || findComputed(sf.T, e.n))) return assignTo({ k: 'member', e: { k: 'self', line: e.line }, name: e.n, line: e.line }, v, ve, why);
          if (sf && findStatic(sf.T, e.n)) return assignTo({ k: 'member', e: { k: 'type', type: { n: sf.T.name } }, name: e.n }, v, ve, why);
          fail(`cannot find '${e.n}' in scope`);
        }
        if (r.isFn) fail(`cannot assign to value: '${e.n}' is a function`);
        if (!r.mutable && r.v !== UNSET) fail(immutableMsg(why, `'${e.n}' is a 'let' constant`));
        r.v = conv(v, r.type, ve, 'assign');
        return;
      }
      case 'self': {
        const sf = selfFrame();
        if (!sf.selfRef.mutable) fail(`cannot assign to value: 'self' is immutable`);
        sf.selfRef.v = v;
        return;
      }
      case 'member': {
        if (e.e.k === 'type' || (e.e.k === 'name' && !lookup(e.e.n) && findType(e.e.n))) {
          const T = e.e.k === 'type' ? findType(e.e.type.n) : findType(e.e.n);
          const st = findStatic(T, e.name);
          if (!st) fail(`type '${T.name}' has no member '${e.name}'`);
          if (!st.p.mutable) fail(`cannot assign to property: '${e.name}' is a 'let' constant`);
          staticValue(st);
          st.v = conv(v, st.p.type, ve, 'assign');
          return;
        }
        const bv = e.e.k === 'super' ? selfFrame().selfRef.v : rval(e.e);
        if (bv instanceof SType) return assignTo({ ...e, e: { k: 'type', type: bv.t } }, v, ve);
        const base = bv instanceof SObj ? bv : isVal(bv) ? lvalue(e.e, why === 'compound' ? why : 'property') : bv;
        if (base === null || base instanceof Some) fail(`value of optional type '${typeName(base)}' must be unwrapped to refer to member '${e.name}' of wrapped base type '${base === null ? 'Any' : typeName(base.v)}'`);
        if (base instanceof SObj || base instanceof SVal) return setProp(base, e.name, v, ve, why);
        if (base instanceof STuple) { const k = base.labels ? base.labels.indexOf(e.name) : -1; if (k < 0) fail(`value of tuple type '${typeName(base)}' has no member '${e.name}'`); base.a[k] = v; return; }
        fail(`cannot assign to property: '${e.name}' is a get-only property`);
      }
      case 'index': {
        const bv = rval(e.e);
        if ((bv instanceof SObj || bv instanceof SVal) && bv.T.subs.length) {
          const sub = bv.T.subs[0];
          if (!sub.acc.set) fail(`cannot assign through subscript: subscript is get-only`);
          const target = bv instanceof SVal ? lvalue(e.e, 'subscript') : bv;
          return void invoke(new SFn({ name: 'subscript', params: [...sub.params, { label: null, name: sub.acc.set.param || 'newValue', type: sub.ret }], ret: null, body: sub.acc.set.body, T: bv.T, accessor: true, mutating: true, line: sub.line }), [...e.args.map(a => rval(a.e)), v], target);
        }
        if (typeof bv === 'string') fail(`cannot assign through subscript: subscript is get-only`);
        const base = lvalue(e.e, 'subscript');
        if (base instanceof SDict && e.args.length === 2 && e.args[1].label === 'default') { const k = rvalT(e.args[0].e, keyType(base)); const key = lib.hashKey(k); base.m.set(key, [base.m.has(key) ? base.m.get(key)[0] : k, conv(v, base.vt, ve, 'assign')]); return; }
        const idx = base instanceof SDict ? rvalT(e.args[0].e, keyType(base)) : rval(e.args[0].e);
        lib.subSet(base, idx, v, ve, e.args[0].label);
        return;
      }
      case 'tidx': { const base = lvalue(e.e, 'assign'); base.a[e.n] = v; return; }
      case 'force': {
        const inner = e.e;
        const cur = rval(inner);
        if (cur === null) trap('Unexpectedly found nil while unwrapping an Optional value');
        return assignTo(inner, new Some(v), null);
      }
      case 'optq': {
        const cur = rval(e.e);
        if (cur === null) throw NIL_CHAIN;
        return assignTo(e.e, new Some(v), null);
      }
      case 'chain': try { return assignTo(e.e, v, ve); } catch (err) { if (err === NIL_CHAIN) return; throw err; }
      case 'tuple': {
        if (!(v instanceof STuple) || v.a.length !== e.items.length) fail(`cannot assign value of type '${typeName(v)}' to type '(${e.items.map(() => '_').join(', ')})'`);
        e.items.forEach((x, k) => assignTo(x.e, v.a[k], null));
        return;
      }
    }
    fail('cannot assign to this expression');
  }
  function setProp(obj, name, v, ve, why = 'assign') {
    const st = findStored(obj.T, name);
    if (st) {
      if (!st.mutable && !(initing(obj) && obj.f.get(name) === UNSET)) fail(initing(obj) ? `immutable value 'self.${name}' may only be initialized once` : why === 'compound' ? `left side of mutating operator isn't mutable: '${name}' is a 'let' constant` : `cannot assign to property: '${name}' is a 'let' constant`);
      const nv = conv(v, st.type, ve, 'assign');
      const obs = st.observed && !initing(obj) ? st.observed : null;
      const old = obj.f.get(name);
      if (obs && obs.willSet) runObserver(obj, st, obs.willSet, nv, old, 'newValue');
      obj.f.set(name, nv);
      if (obs && obs.didSet) runObserver(obj, st, obs.didSet, old, nv, 'oldValue');
      return;
    }
    const cp = findComputed(obj.T, name);
    if (cp) { if (!cp.acc.set) fail(`cannot assign to property: '${name}' is a get-only property`); return callSetter(cp, obj, v); }
    fail(`value of type '${obj.T.name}' has no member '${name}'`);
  }
  function runObserver(obj, st, ob, val, other, pname) {
    const fn = new SFn({ name: st.name + '.' + (pname === 'newValue' ? 'willSet' : 'didSet'), params: [{ label: null, name: ob.param || pname, type: null }], ret: null, body: ob.body, T: obj.T, accessor: true, mutating: true, line: st.line });
    invoke(fn, [val], obj);
  }
  function callSetter(cp, obj, v) {
    const fn = new SFn({ name: cp.name, params: [{ label: null, name: cp.acc.set.param || 'newValue', type: cp.type }], ret: null, body: cp.acc.set.body, T: cp.T, accessor: true, mutating: true, line: cp.line, isStatic: cp.mods && cp.mods.has('static') });
    invoke(fn, [v], obj);
  }

  /** the type of the last nil read (from a dictionary, an optional variable or property), so `?? []` knows what [] is */
  let nilType = null;
  const nilOf = (v, t) => { if (v === null) nilType = t || null; return v; };

  /* ---- operators ---- */
  function unary(e) {
    const v = rval(e.e);
    if (v instanceof Some || v === null) fail(`value of optional type '${typeName(v)}' must be unwrapped to a value of type '${v === null ? 'Any' : typeName(v.v)}'`);
    switch (e.op) {
      case '-': {
        if (typeof v === 'bigint') { if (v === I64_MIN) trap('arithmetic overflow'); return -v; }
        if (typeof v === 'number') return -v;
        if (v instanceof SNum) return lib.numNeg(v);
        return userOp('-', [v], e, true);
      }
      case '+': return v;
      case '!': if (typeof v !== 'boolean') fail(`cannot convert value of type '${typeName(v)}' to expected argument type 'Bool'`); return !v;
      case '~': if (typeof v === 'bigint') return ~v; if (v instanceof SNum) return lib.intKind(v.t, ~v.v, false); fail(`unary operator '~' cannot be applied to an operand of type '${typeName(v)}'`);
    }
    fail('unknown operator ' + e.op);
  }
  function userOp(op, vals, e, prefix) {
    const v = vals[0];
    const Ts = vals.map(x => (x instanceof SObj || x instanceof SVal || x instanceof SEnum ? x.T : null)).filter(Boolean);
    for (const T of Ts) {
      const fs = findMethods(T, op, true).filter(f => f.params.length === vals.length);
      if (fs.length) return invoke(fs[0], vals, new SType({ n: T.name }));
    }
    if (globalFns.has(op)) { const fs = globalFns.get(op).filter(f => f.params.length === vals.length && f.params.every((p, k) => fits(vals[k], p.type))); if (fs.length) return invoke(fs[0], vals, null); }
    for (const x of vals) { const ext = extOf(x); if (ext && ext.staticFns.has(op)) { const f = ext.staticFns.get(op).find(f => f.params.length === vals.length); if (f) return invoke(f, vals, null); } }
    if (prefix) fail(`unary operator '${op}' cannot be applied to an operand of type '${typeName(v)}'`);
    return undefined;
  }
  function binop(e) {
    const op = e.op;
    if (op === '&&') { if (!cond(e.l)) return false; return cond(e.r); }
    if (op === '||') { if (cond(e.l)) return true; return cond(e.r); }
    if (op === '??') {
      nilType = null;
      const a = rval(e.l);
      if (a === null) { const t = nilType; return e.r.k === 'nil' ? null : rvalT(e.r, t && t.opt ? t.opt : t); }
      if (a instanceof Some) return a.v;
      return a;     // a ?? b on a non-optional: Swift warns, and a is the value
    }
    let a, b;
    if (e.l.k === 'imember' || e.l.k === 'nil') { b = rval(e.r); a = e.l.k === 'nil' ? null : rvalT(e.l, valueType(b)); }
    else { a = rval(e.l); b = e.r.k === 'imember' ? rvalT(e.r, valueType(a)) : e.r.k === 'nil' ? null : rval(e.r); }
    return binVals(op, a, b, e);
  }
  /** the type of a value, for finding .member in it */
  const valueType = v => (v instanceof Some ? valueType(v.v) : v instanceof SEnum || v instanceof SVal || v instanceof SObj ? { n: v.T.name } : typeof v === 'bigint' ? { n: 'Int' } : typeof v === 'number' ? { n: 'Double' } : null);
  function binVals(op, a, b, e) {
    if (op === '===' || op === '!==') { const same = a === b || (a instanceof Some && b instanceof Some && a.v === b.v) || (a instanceof Some && a.v === b) || (b instanceof Some && b.v === a); return op === '===' ? same : !same; }
    if (op === '==' || op === '!=') { const r = equal(a, b, e); return op === '==' ? r : !r; }
    if (op === '~=') return lib.patternMatch(a, b);
    // the other operators need unwrapped values
    for (const v of [a, b]) if (v instanceof Some || v === null) fail(`value of optional type '${typeName(v)}' must be unwrapped to a value of type '${v === null ? 'Any' : typeName(v.v)}'`);
    // a literal takes the other side's type: d * 2, 2 * d, c - 97 (UInt8)
    if (typeof a === 'number' && typeof b === 'bigint' && isIntLit(e.r)) b = Number(b);
    else if (typeof b === 'number' && typeof a === 'bigint' && isIntLit(e.l)) a = Number(a);
    else if (a instanceof SNum && typeof b === 'bigint' && isIntLit(e.r)) b = lib.intKind(a.t, b, true);
    else if (b instanceof SNum && typeof a === 'bigint' && isIntLit(e.l)) a = lib.intKind(b.t, a, true);
    else if (a instanceof SNum && typeof b === 'number' && isNumLit(e.r) && a.t === 'Float') b = new SNum('Float', b);
    else if (b instanceof SNum && typeof a === 'number' && isNumLit(e.l) && b.t === 'Float') a = new SNum('Float', a);
    // a one-character string literal next to a Character is a Character (c >= "a")
    if (a instanceof SChar && typeof b === 'string' && e.r && e.r.k === 'str' && lib.charCount(b) === 1) b = CH(b);
    else if (b instanceof SChar && typeof a === 'string' && e.l && e.l.k === 'str' && lib.charCount(a) === 1) a = CH(a);
    if (typeof a === 'bigint' && typeof b === 'bigint') return intOp(op, a, b);
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
        case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
        case '%': fail("'%' is unavailable: For floating point numbers use truncatingRemainder instead");
      }
      fail(`binary operator '${op}' cannot be applied to two 'Double' operands`);
    }
    if (a instanceof SNum && b instanceof SNum && a.t === b.t) return lib.numOp(op, a, b);
    if (typeof a === 'string' && typeof b === 'string') {
      if (op === '+') return a + b;
      if (['<', '>', '<=', '>='].includes(op)) { const c = lib.compare(a, b); return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0; }
    }
    if (a instanceof SChar && b instanceof SChar && ['<', '>', '<=', '>='].includes(op)) { const c = lib.compare(a, b); return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0; }
    if (a instanceof SArr && b instanceof SArr && op === '+') { const r = new SArr([...lib.items(a).map(share), ...lib.items(b).map(share)], a.et || b.et); return r; }
    if (a instanceof STuple && b instanceof STuple && ['<', '>', '<=', '>='].includes(op)) { const c = lib.compare(a, b); return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0; }
    const u = userOp(op, [a, b], e);
    if (u !== undefined) return u;
    if (['<', '>', '<=', '>='].includes(op) && a instanceof SEnum && b instanceof SEnum && a.T === b.T && conforms(a.T, 'Comparable')) {
      const c = a.T.caseList.findIndex(x => x.name === a.c) - a.T.caseList.findIndex(x => x.name === b.c);
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    // a user < gives the other comparisons (Comparable)
    if (['>', '<=', '>='].includes(op) && (a instanceof SVal || a instanceof SObj || a instanceof SEnum)) {
      const lt = (x, y) => userOp('<', [x, y], e);
      if (lt(a, b) !== undefined) return op === '>' ? lt(b, a) : op === '<=' ? !lt(b, a) : !lt(a, b);
    }
    fail(typeName(a) === typeName(b) ? `binary operator '${op}' cannot be applied to two '${typeName(a)}' operands` : `binary operator '${op}' cannot be applied to operands of type '${typeName(a)}' and '${typeName(b)}'`);
  }
  function intOp(op, a, b) {
    const ck = v => { if (v > I64_MAX || v < I64_MIN) trap('arithmetic overflow'); return v; };
    switch (op) {
      case '+': return ck(a + b); case '-': return ck(a - b); case '*': return ck(a * b);
      case '/': if (b === 0n) trap('Division by zero'); if (a === I64_MIN && b === -1n) trap('Division results in an overflow'); return a / b;
      case '%': if (b === 0n) trap('Division by zero in remainder operation'); if (a === I64_MIN && b === -1n) trap('Division results in an overflow in remainder operation'); return a % b;
      case '&+': return BigInt.asIntN(64, a + b); case '&-': return BigInt.asIntN(64, a - b); case '&*': return BigInt.asIntN(64, a * b);
      case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      case '<<': return b < 0n ? (b <= -64n ? (a < 0n ? -1n : 0n) : a >> -b) : b >= 64n ? 0n : BigInt.asIntN(64, a << b);
      case '>>': return b < 0n ? (b <= -64n ? 0n : BigInt.asIntN(64, a << -b)) : b >= 64n ? (a < 0n ? -1n : 0n) : a >> b;
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
    }
    fail(`binary operator '${op}' cannot be applied to two 'Int' operands`);
  }
  /** == as Swift has it: values compare by value; a struct or class needs to be Equatable */
  function equal(a, b, e) {
    if (a === null || b === null) {
      const o = a === null ? b : a;
      if (o === null) return true;
      if (o instanceof Some) return false;
      if (e && (e.l.k === 'nil' || e.r.k === 'nil')) { if (o instanceof SObj || isVal(o) || typeof o !== 'object') { /* comparing a non-optional to nil is always false (a warning in Swift) */ } }
      return false;
    }
    if (a instanceof Some || b instanceof Some) return equal(a instanceof Some ? a.v : a, b instanceof Some ? b.v : b, null);
    if (typeof a === 'bigint' && typeof b === 'number' && e && isIntLit(e.l)) a = Number(a);
    if (typeof b === 'bigint' && typeof a === 'number' && e && isIntLit(e.r)) b = Number(b);
    if (a instanceof SNum && typeof b === 'bigint' && e && isIntLit(e.r)) b = lib.intKind(a.t, b, true);
    if (b instanceof SNum && typeof a === 'bigint' && e && isIntLit(e.l)) a = lib.intKind(b.t, a, true);
    if (typeof a === 'string' && b instanceof SChar && e && e.r.k === 'str') b = a.constructor === String ? b : b;
    if (a instanceof SChar && typeof b === 'string' && e && e.r.k === 'str' && lib.charCount(b) === 1) b = CH(b);
    if (b instanceof SChar && typeof a === 'string' && e && e.l.k === 'str' && lib.charCount(a) === 1) a = CH(a);
    const ta = typeName(a), tb = typeName(b);
    if (ta !== tb && !(a instanceof SObj && b instanceof SObj) && !(a instanceof SArr && b instanceof SArr) && !(a instanceof SDict && b instanceof SDict) && !(a instanceof SSet && b instanceof SSet) && !(a instanceof STuple && b instanceof STuple)) {
      fail(`binary operator '==' cannot be applied to operands of type '${ta}' and '${tb}'`);
    }
    return eqVals(a, b, e);
  }
  const notEquatable = a => (a instanceof SObj ? `binary operator '==' cannot be applied to two '${a.T.name}' operands` : `referencing operator function '==' on 'Equatable' requires that '${a.T.name}' conform to 'Equatable'`);
  function eqVals(a, b, e) {
    if (a === b) {
      if (a instanceof SObj || a instanceof SVal) { const u = userOp('==', [a, b], e || { l: {}, r: {} }); if (u !== undefined) return u; if (!conforms(a.T, 'Equatable')) fail(notEquatable(a)); }
      return true;
    }
    if (a === null || b === null) return a === b;
    if (a instanceof Some || b instanceof Some) return a instanceof Some && b instanceof Some ? eqVals(a.v, b.v, null) : false;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b || (typeof a === 'number' && typeof b === 'number' && a === b);
    if (a instanceof SChar || b instanceof SChar) return a === b;
    if (a instanceof SNum && b instanceof SNum) return a.t === b.t && a.v === b.v;
    if (a instanceof SArr && b instanceof SArr) { const x = lib.items(a), y = lib.items(b); return x.length === y.length && x.every((v, k) => eqVals(v, y[k], null)); }
    if (a instanceof STuple && b instanceof STuple) return a.a.length === b.a.length && a.a.every((v, k) => eqVals(v, b.a[k], null));
    if (a instanceof SDict && b instanceof SDict) { if (a.m.size !== b.m.size) return false; for (const [k, [, v]] of a.m) { const o = b.m.get(k); if (!o || !eqVals(v, o[1], null)) return false; } return true; }
    if (a instanceof SSet && b instanceof SSet) { if (a.m.size !== b.m.size) return false; for (const k of a.m.keys()) if (!b.m.has(k)) return false; return true; }
    if (a instanceof SRange && b instanceof SRange) return a.closed === b.closed && eqVals(a.lo, b.lo) && eqVals(a.hi, b.hi);
    if (a instanceof SIdx && b instanceof SIdx) return a.i === b.i;
    if ((a instanceof SVal || a instanceof SObj || a instanceof SEnum) && b.T === a.T || (a instanceof SObj && b instanceof SObj)) {
      const u = userOp('==', [a, b], e || { l: {}, r: {} });
      if (u !== undefined) return u;
      if (a instanceof SObj) fail(notEquatable(a));
      if (a instanceof SEnum && !a.T.caseList.some(c => c.assoc)) return a.c === b.c;
      if (!conforms(a.T, 'Equatable')) fail(notEquatable(a));
      if (a instanceof SEnum) return a.c === b.c && (!a.p || a.p.every((v, k) => eqVals(v, b.p[k], null)));
      for (const [k, v] of a.f) if (!eqVals(v, b.f.get(k), null)) return false;
      return true;
    }
    return false;
  }

  /* ---- casts ---- */
  function castFits(v, t) { const x = v instanceof Some ? v.v : v; return x !== null && fits(x, t); }
  function cast(e) {
    const v = rval(e.e);
    const x = v instanceof Some ? v.v : v;
    if (e.kind === 'as') {
      if (typeof x === 'bigint' && e.type.n === 'Double' && isIntLit(e.e)) return Number(x);
      if (typeof x === 'number' && e.type.n === 'Float' && isNumLit(e.e)) return new SNum('Float', Math.fround(x));
      if (typeof x === 'bigint' && INT_KINDS[e.type.n] && isIntLit(e.e)) return lib.intKind(e.type.n, x, true);
      if (typeof x === 'string' && e.type.n === 'Character' && e.e.k === 'str') return conv(x, e.type, e.e);
      if (e.type.n === 'Any' || e.type.n === 'AnyObject') return v;
      if (e.type.opt || fits(v, e.type)) return conv(v, e.type, e.e);
      fail(`cannot convert value of type '${typeName(v)}' to type '${typeText(e.type)}' in coercion`);
    }
    const ok = x !== null && fits(x, e.type);
    if (e.kind === 'as?') return ok ? new Some(x) : null;
    if (!ok) trap(`Could not cast value of type '${x === null ? 'Optional<Any>' : 'main.' + typeName(x).replace(/^main\./, '')}' to '${typeText(e.type)}'`);
    return x;
  }

  /* ---- calls ---- */
  const argVals = args => args.map(a => ({ label: a.label, v: a.e.k === 'inout' ? rval(a.e.e) : stored(rval(a.e), a.e), e: a.e, place: a.e.k === 'inout' ? a.e.e : null, trailing: !!a.trailing }));
  /** argument values for parameters ps (so literals and .member take the parameter's type) */
  function argList(args, ps) {
    if (!ps) return argVals(args);
    const order = matchArgs(ps, args.map(a => a.label), args.map(a => !!a.trailing), true);
    return args.map((a, k) => {
      const p = order ? order[k] : null;
      const t = p ? (p.variadic ? p.type : p.type && p.type.inout ? null : p.type) : null;
      if (a.e.k === 'inout') return { label: a.label, v: rval(a.e.e), e: a.e, place: a.e.e, trailing: !!a.trailing };
      return { label: a.label, v: stored(t ? rvalT(a.e, t) : rval(a.e), a.e), e: a.e, trailing: !!a.trailing };
    });
  }
  /** for each argument, the parameter it goes to; null when the labels do not fit (quiet) or the compiler's error */
  function matchArgs(ps, labels, trailing, quiet) {
    const out = [];
    let k = 0;
    for (const p of ps) {
      if (p.variadic) {
        if (k < labels.length && labels[k] === p.label) { out.push(p); k++; while (k < labels.length && labels[k] === null && !trailing[k]) { out.push(p); k++; } }
        continue;
      }
      if (k < labels.length && (labels[k] === p.label || trailing[k] && labels[k] === null)) { out.push(p); k++; continue; }
      if (p.def) continue;
      if (quiet) return null;
      if (k < labels.length && labels[k] !== p.label) {
        if (p.label === null) fail(`extraneous argument label '${labels[k]}:' in call`);
        if (labels[k] === null) fail(`missing argument label '${p.label}:' in call`);
        fail(`incorrect argument label in call (have '${labels[k]}:', expected '${p.label}:')`);
      }
      fail(`missing argument for parameter ${p.label ? `'${p.label}'` : '#' + (ps.indexOf(p) + 1)} in call`);
    }
    if (k < labels.length) { if (quiet) return null; fail(labels[k] ? `extra argument '${labels[k]}' in call` : 'extra argument in call'); }
    return out;
  }
  function pickOverload(fs, args, name) {
    const labels = args.map(a => a.label), tr = args.map(a => !!a.trailing);
    const ok = fs.filter(f => matchArgs(f.params, labels, tr, true));
    if (!ok.length) { if (fs.length === 1) matchArgs(fs[0].params, labels, tr, false); fail(`no exact matches in call to ${fs[0].T ? (fs[0].isInit ? 'initializer' : fs[0].isStatic ? 'static method' : 'instance method') : 'global function'} '${name}'`); }
    if (ok.length === 1) return ok[0];
    const typed = ok.filter(f => { const order = matchArgs(f.params, labels, tr, true); return args.every((a, k) => !order[k].type || fits(a.v, order[k].type) || a.e && isIntLit(a.e) && order[k].type.n === 'Double'); });
    return (typed.length ? typed : ok)[0];
  }
  function invokeOverload(fs, args, self, ce, name) {
    const f = pickOverload(fs, args, name);
    return invokeWith(f, args, self, ce);
  }
  /** calls fn with args ({label, v, e, place}) given by label: defaults, variadics and inout copy-back */
  function invokeWith(fn, args, self, ce) {
    if (fn.native) return fn.native(args, ce);
    if (fn.throws && !inTry) fail(`call can throw but is not marked with 'try'`);
    const order = matchArgs(fn.params, args.map(a => a.label), args.map(a => !!(a.trailing)), false);
    const vals = fn.params.map(p => (p.variadic ? [] : MISSING));
    const inouts = [];
    args.forEach((a, k) => {
      const p = order[k], j = fn.params.indexOf(p);
      let v = a.v;
      if (p.type && p.type.inout) {
        if (!a.place) fail(`passing value of type '${typeName(v)}' to an inout parameter requires explicit '&'`);
        inouts.push({ j, place: a.place });
        v = lvalueCheck(a.place);
      } else if (a.place) fail(`'&' used with non-inout argument of type '${typeName(v)}'`);
      else if (p.type && a.e && (isIntLit(a.e) || isNumLit(a.e) || a.e.k === 'arrlit' || a.e.k === 'str')) v = conv(v, p.type, a.e, 'argument');
      if (p.variadic) vals[j].push(p.type ? conv(v, p.type, a.e, 'argument') : v);
      else vals[j] = v;
    });
    fn.params.forEach((p, j) => { if (p.variadic) vals[j] = new SArr(vals[j], p.type); });
    const result = invoke(fn, vals, self, { inouts, ce });
    return result;
  }
  /** the current value of an inout argument's place, checking that it may be changed */
  function lvalueCheck(e) {
    if (e.k === 'name') {
      const r = lookup(e.n);
      if (r && !r.mutable) fail(`cannot pass immutable value as inout argument: '${e.n}' is a 'let' constant`);
    }
    const v = lvalue(e, 'inout');
    return v;
  }
  const MISSING = Symbol('missing');
  function call(e, expectT) {
    const f = e.f;
    if (f.k === 'name') {
      const n = f.n;
      const r = lookup(n);
      if (r) {
        const v = readVar(r, n);
        if (r.isFn && r.fns) return invokeOverload(r.fns, argList(e.args, r.fns.length === 1 ? r.fns[0].params : null), null, e, n);
        return callValue(v, e);
      }
      const sf = selfFrame();
      if (sf && !sf.isStatic) {
        const self = sf.selfRef.v, dynT = self instanceof SObj || self instanceof SVal || self instanceof SEnum ? self.T : sf.T;   // methods dispatch on the object's own class
        const ms = findMethods(dynT, n);
        if (ms.length) return callMethod({ k: 'self', line: e.line }, self, ms, n, e);
        if (findStored(dynT, n) || findComputed(dynT, n)) return callValue(nameValue(f), e);
        const ext = extOf(self);
        if (ext && ext.methods.has(n)) return callMethod({ k: 'self', line: e.line }, self, ext.methods.get(n), n, e);
        if (builtinName(self) && !lookup(n) && !globalFns.has(n) && !findType(n) && !lib.hasGlobal(n)) return lib.callMethod(self, n, e, { k: 'self', line: e.line });
      }
      if (sf) {
        const fs = findMethods(sf.T, n, true);
        if (fs.length && (sf.isStatic || true)) return invokeOverload(fs, argList(e.args, fs.length === 1 ? fs[0].params : null), new SType({ n: sf.T.name }), e, n);
        if (sf.T.kind === 'enum' && sf.T.cases.has(n) && sf.isStatic) return typeMember(sf.T, n, e, f);
      }
      if (globalFns.has(n)) { const fs = globalFns.get(n); return invokeOverload(fs, argList(e.args, fs.length === 1 ? fs[0].params : null), null, e, n); }
      const T = findType(n);
      if (T) return construct(T, e);
      if (aliases.has(n)) return call({ ...e, f: { k: 'type', type: aliases.get(n), line: f.line } }, expectT);
      if (FOUNDATION.has(n) && !hasFoundation()) fail(`cannot find '${n}' in scope`);
      if (lib.hasGlobal(n)) return lib.callGlobal(n, argVals(e.args), e);
      fail(`cannot find '${n}' in scope`);
    }
    if (f.k === 'member') {
      if (f.e.k === 'super') {
        const sf = selfFrame();
        const base = sf.T.base;
        if (!base) fail(`'super' members cannot be referenced in a root class`);
        if (f.name === 'init') return runInit(base, sf.selfRef.v, e, true);
        const ms = findMethods(base, f.name);
        if (!ms.length) fail(`value of type '${base.name}' has no member '${f.name}'`);
        return invokeOverload(ms, argList(e.args, ms.length === 1 ? ms[0].params : null), sf.selfRef.v, e, f.name);
      }
      if (f.e.k === 'self' && f.name === 'init') { const sf = selfFrame(); return runInit(sf.T, sf.selfRef.v, e, false, sf); }
      if (f.e.k === 'name' && !lookup(f.e.n)) {
        const T = findType(f.e.n);
        if (T && !(selfFrame() && !selfFrame().isStatic && (findStored(selfFrame().T, f.e.n) || findComputed(selfFrame().T, f.e.n)))) return typeMember(T, f.name, e, f);
        if (!T && (['Int', 'Double', 'String', 'Character', 'Float', 'Bool', 'Array', 'Set', 'Dictionary'].includes(f.e.n) || INT_KINDS[f.e.n])) return typeMember(f.e.n, f.name, e, f);
      }
      if (f.e.k === 'type') { const T = typeOfT(f.e.type); return typeMember(T, f.name, e, f, f.e.type); }
      const recv = rval(f.e);
      if (recv instanceof SType) return typeMember(typeOfT(recv.t), f.name, e, f, recv.t);
      if ((recv === null || recv instanceof Some) && (f.name === 'map' || f.name === 'flatMap')) {    // Optional's own map
        if (recv === null) return null;
        const fnv = rval(e.args[0].e);
        const r = lib.callF(fnv, recv.v);
        return f.name === 'flatMap' ? r : r === VOID ? new Some(VOID) : new Some(r);
      }
      if (recv === null || recv instanceof Some) fail(`value of optional type '${recv === null ? optTypeOf(f.e) : typeName(recv)}' must be unwrapped to refer to member '${f.name}' of wrapped base type '${recv === null ? optTypeOf(f.e).replace(/\?$/, '') : typeName(recv.v)}'`);
      if (recv instanceof SObj || recv instanceof SVal || recv instanceof SEnum) {
        const ms = findMethods(recv.T, f.name);
        if (ms.length) return callMethod(f.e, recv, ms, f.name, e);
        return callValue(instanceMember(recv, f.name, f, recv.T), e);
      }
      const ext = extOf(recv);
      if (ext && ext.methods.has(f.name)) return callMethod(f.e, recv, ext.methods.get(f.name), f.name, e);
      return lib.callMethod(recv, f.name, e, f.e);
    }
    if (f.k === 'imember') { const v = implicitMember(f, expectT, e); return v; }
    if (f.k === 'type') {
      const t = resolveT(f.type);
      if (t.n && findType(t.n)) return construct(findType(t.n), e);
      // [[Int]](repeating: [], count: n): the element takes the array's element type
      const args = e.args.map(a => (a.label === 'repeating' && t.arr ? { label: a.label, v: stored(rvalT(a.e, t.arr), a.e), e: a.e } : argVals([a])[0]));
      return lib.construct(t, args, e);
    }
    if (f.k === 'optq' || f.k === 'chain') {
      const v = rval(f);
      return callValue(v, e);
    }
    return callValue(rval(f), e);
  }
  function callValue(v, e) {
    if (v instanceof SFn) {
      if (v.overloads) return invokeOverload(v.overloads, argList(e.args, null), null, e, v.name);
      if (v.native) return v.native(argVals(e.args), e);
      const args = argList(e.args, v.closure ? null : v.params);
      if (v.closure) {                                // closures take no labels
        const bad = e.args.find(a => a.label && !a.trailing);
        if (bad) fail(`extraneous argument label '${bad.label}:' in call`);
        return invoke(v, args.map(a => a.v), v.self, { args: e.args });
      }
      return invokeWith(v, args, v.self, e);
    }
    if (v instanceof SType) {
      const T = typeOfT(v.t);
      if (typeof T !== 'string') return construct(T, e);
      return lib.construct(v.t, argVals(e.args), e);
    }
    if (v === null || v instanceof Some) fail(`value of optional type '${typeName(v)}' must be unwrapped to a value of type '${v === null ? 'Any' : typeName(v.v)}'`);
    fail(`cannot call value of non-function type '${typeName(v)}'`);
  }
  /** recv.name(args): a mutating method gets the receiver's place, so it changes in place */
  function callMethod(recvE, recv, ms, name, e) {
    const args = argList(e.args, ms.length === 1 ? ms[0].params : null);
    const f = pickOverload(ms, args, name);
    if (f.mutating && (recv instanceof SVal || recv instanceof SEnum)) {
      const mark = pendingSets.length;
      const target = recv instanceof SEnum ? recv : lvalue(recvE, 'mutating');
      if (recv instanceof SEnum) checkMutable(recvE);
      const ref = { v: target, mutable: true };
      const out = invokeWith(new SFn({ ...f, selfRefGiven: ref }), args, target, e);
      if (ref.v !== target || recv instanceof SEnum) assignTo(recvE, ref.v, null);
      flushSets(mark);
      return out;
    }
    return invokeWith(f, args, recv, e);
  }
  function checkMutable(recvE) {
    if (recvE.k === 'name') { const r = lookup(recvE.n); if (r && !r.mutable) fail(`cannot use mutating member on immutable value: '${recvE.n}' is a 'let' constant`); }
    if (recvE.k === 'self') { const sf = selfFrame(); if (!sf.selfRef.mutable) fail(`cannot use mutating member on immutable value: 'self' is immutable`); }
  }
  /** runs a function: its parameters bound, its body run, its result converted */
  function invoke(fn, vals, self, opts = {}) {
    if (fn.native) return fn.native(vals.map(v => ({ label: null, v })), opts.ce);
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls (the stack would overflow).');
    const scope = new Map();
    const ps = fn.params || [];
    const isClosure = !!fn.closure;
    if (isClosure && fn.dollar !== undefined) {
      if (vals.length < fn.dollar + 1 && vals.length !== 1) fail(`contextual closure type expects ${vals.length} argument${vals.length === 1 ? '' : 's'}, but ${fn.dollar + 1} ${fn.dollar ? 'were' : 'was'} used in closure body`);
      const xs = vals.length === 1 && fn.dollar > 0 && vals[0] instanceof STuple ? vals[0].a : vals;
      xs.forEach((v, k) => scope.set('$' + k, { name: '$' + k, v, mutable: !!(fn.inoutFirst && k === 0), hidden: true }));
    } else if (isClosure && ps.length) {
      const xs = ps.length > 1 && vals.length === 1 && vals[0] instanceof STuple ? vals[0].a : vals;
      if (xs.length !== ps.length && !(ps.length === 1 && xs.length > 1)) fail(`contextual closure type expects ${vals.length} argument${vals.length === 1 ? '' : 's'}, but ${ps.length} ${ps.length === 1 ? 'was' : 'were'} used in closure body`);
      ps.forEach((p, k) => { if (p.name !== '_') scope.set(p.name, { name: p.name, v: ps.length === 1 && xs.length > 1 ? new STuple(xs) : p.type && !p.type.inout ? conv(xs[k], p.type, null, 'argument') : xs[k], mutable: !!(fn.inoutFirst && k === 0), type: p.type && !p.type.inout ? p.type : null }); });
    } else {
      ps.forEach((p, k) => {
        let v = vals[k];
        if (v === MISSING || v === undefined) {
          if (!p.def) fail(`missing argument for parameter '${p.name}' in call`);
          v = fn.T ? withSelf(self, fn.T, () => rvalT(p.def, p.type)) : rvalT(p.def, p.type);
        }
        const t = p.type && p.type.inout ? { ...p.type, inout: false } : p.type;
        if (p.variadic) { scope.set(p.name, { name: p.name, v, mutable: false, type: { arr: t } }); return; }
        if (p.name !== '_') scope.set(p.name, { name: p.name, v: t ? conv(v, t, null, 'argument') : v, mutable: !!(p.type && p.type.inout), type: t, param: true });
      });
    }
    const label = fn.closure ? 'closure' : fn.isInit ? fn.T.name + '.init' : fn.accessor ? (fn.T ? fn.T.name + '.' : '') + fn.name : fn.T && !fn.ext ? fn.T.name + '.' + fn.name : fn.name;
    // self: a struct's is mutable in a mutating method or an init; a class's is a reference (its properties can change, self cannot)
    const selfRef = isClosure || self === null || self === undefined || self instanceof SType ? null
      : fn.selfRefGiven || { v: self, mutable: !(self instanceof SObj) && !!(fn.mutating || fn.isInit) };
    const fr = { name: label, scopes: [scope], env: fn.env, fn, T: fn.T || (selfRef && selfRef.v && selfRef.v.T) || (fn.selfFrame && fn.selfFrame.T) || BUILTIN_T, selfRef, isStatic: !isClosure && self instanceof SType, initOf: fn.isInit ? self : null };
    const shown = ps.filter(p => p.name && scope.has(p.name)).map(p => p.name + '=' + brief(scope.get(p.name).v));
    if (isClosure && fn.dollar !== undefined) for (let k = 0; k <= fn.dollar; k++) if (scope.has('$' + k)) shown.push('$' + k + '=' + brief(scope.get('$' + k).v));
    const visible = !fn.accessor || fn.body;
    const id = visible ? ++calls : 0;
    if (visible) stack.push({ name: label, args: shown.join(', ').slice(0, 70), id });
    frames.push(fr);
    const outerTry = inTry;
    inTry = 0;
    try {
      let v = VOID;
      const body = fn.body || [];
      const single = body.length === 1 && body[0].k === 'expr' && (isClosure || fn.accessor || (fn.ret && fn.ret.n !== 'Void'));
      if (single) { step(body[0].line); v = stored(rvalT(body[0].e, fn.ret), body[0].e); }
      else {
        runBlock(body, false);
        if (fn.ret && !(fn.ret.n === 'Void' || fn.ret.tuple && !fn.ret.tuple.length) && !fn.isInit) {
          line = fn.endLine || line;
          fail(`missing return in ${fn.closure ? 'closure' : fn.T ? (fn.accessor ? 'getter' : fn.isStatic ? 'static method' : 'instance method') : fn.local ? 'local function' : 'global function'} expected to return '${typeText(fn.ret)}'`);
        }
      }
      return noted(id, finish(fn, v));
    } catch (err) {
      if (err instanceof Jump && err.k === 'return') return noted(id, finish(fn, err.v, err));
      if (err instanceof Jump) fail(err.k === 'fallthrough' ? "'fallthrough' is only allowed inside a switch" : `'${err.k}' is only allowed inside a loop, if, do, or switch`);
      if (err instanceof Thrown && fn.T === undefined && !fn.throws && !fn.closure && fn.decl) { /* a non-throwing function cannot throw: the compiler checks that at the throw */ }
      throw err;
    } finally {
      inTry = outerTry;
      frames.pop();
      if (visible) stack.pop();
      if (opts.inouts) for (const { j, place } of opts.inouts) { const p = fn.params[j]; const r = scope.get(p.name); if (r) assignTo(place, r.v, null); }
      if (fn.selfRefGiven && fr.selfRef) fn.selfRefGiven.v = fr.selfRef.v;
      if (fn.inoutFirst) { const r = scope.get(fn.dollar !== undefined ? '$0' : ps[0] && ps[0].name); if (r) fn.inoutFirst.v = r.v; }
    }
  }
  /** notes what call `id` returned, for the call tree */
  function noted(id, v) { if (id && v !== VOID && v !== undefined) rets[id] = brief(v); return v; }
  function finish(fn, v, jump) {
    if (fn.isInit) return VOID;
    const ret = fn.ret;
    if (!ret || ret.n === 'Void') {
      if (jump && jump.v !== VOID && jump.v !== undefined && !fn.closure) fail(`unexpected non-void return value in void function`);
      return fn.closure && !ret ? (v === undefined ? VOID : v) : VOID;
    }
    if (v === VOID && jump) fail(`non-void function should return a value`);
    return conv(v, ret, jump && jump.e, 'return');
  }
  function closure(e, ft) {
    let dollar;
    if (e.params === null) {
      let max = -1;
      const scan = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(scan); return; } if (x.k === 'closure' && x !== e) return; if (x.k === 'name' && /^\$\d+$/.test(x.n)) max = Math.max(max, +x.n.slice(1)); for (const k in x) if (k !== 'line') scan(x[k]); };
      scan(e.body);
      if (max >= 0) dollar = max;
    }
    const ps = (e.params || []).map((p, k) => ({ ...p, type: p.type || (ft && ft.fn && ft.fn[k] ? ft.fn[k] : null) }));
    return new SFn({ name: 'closure', closure: true, params: ps, body: e.body, ret: e.ret || (ft ? ft.ret : null), env: capture(), dollar, selfFrame: selfFrame(), line: e.line });
  }
  const capture = () => { const f = frame(); return f ? [...[...f.scopes].reverse(), ...(f.env || [])] : []; };
  /** inside a try expression (calls to throwing functions need one) */
  let inTry = 0;
  function tryExpr(e) {
    inTry++;
    try { if (e.kind === 'try') return rval(e.e); } finally { inTry--; }
    inTry++;
    try {
      const v = rval(e.e);
      return e.kind === 'try?' ? (v === null || v instanceof Some ? v : new Some(v)) : v;
    } catch (err) {
      if (!(err instanceof Thrown)) throw err;
      if (e.kind === 'try?') return null;
      trap(`'try!' expression unexpectedly raised an error: ${lib.debugDescribe(err.v)}`);
    } finally { inTry--; }
  }

  /* ---- types: building values ---- */
  function construct(T, e) {
    if (T.kind === 'protocol') fail(`type '${T.name}' cannot be instantiated`);
    if (T.kind === 'enum') {
      if (e.args.length === 1 && e.args[0].label === 'rawValue' && T.rawType) {
        const raw = rvalT(e.args[0].e, { n: T.rawType });
        const c = T.caseList.find(x => eqVals(x.rawValue, raw, null));
        return c ? new Some(new SEnum(T, c.name, null)) : null;
      }
      if (!T.inits.length) fail(`'${T.name}' cannot be constructed because it has no accessible initializers`);
    }
    const inits = T.inits.length ? T.inits : null;
    const args = argList(e.args, inits && inits.length === 1 ? inits[0].params : T.kind === 'struct' && !inits ? memberwiseParams(T) : null);
    return constructWith(T, args, e);
  }
  function memberwiseParams(T) {
    return T.stored.filter(s => !(s.init && !s.mutable) && !s.mods.has('lazy')).map(s => ({ label: s.name, name: s.name, type: s.type, def: s.init || (s.type && s.type.opt && s.mutable ? { k: 'nil' } : null) }));
  }
  function constructWith(T, args, e) {
    if (T.kind === 'struct') {
      const o = new SVal(T);
      initStored(T, o);
      if (!T.inits.length || (T.memberwise && !T.inits.some(f => matchArgs(f.params, args.map(a => a.label), args.map(() => false), true)))) {
        if (!T.memberwise) fail(`no exact matches in call to initializer`);
        const ps = memberwiseParams(T);
        if (!ps.length && args.length) fail(`argument passed to call that takes no arguments`);
        const fn = new SFn({ name: 'init', params: ps, T, isInit: true, native: null });
        const order = matchArgs(ps, args.map(a => a.label), args.map(a => !!(a.trailing)), false);
        ps.forEach(p => { const k = order.indexOf(p); o.f.set(p.name, k >= 0 ? conv(args[k].v, p.type, args[k].e, 'argument') : p.def.k === 'nil' ? null : conv(rvalT(p.def, p.type), p.type, p.def)); });
        void fn;
        return o;
      }
      const f = pickOverload(T.inits, args, 'init');
      try { invokeWith(f, args, o, e); } catch (err) { if (err === INIT_NIL) return null; throw err; }
      checkInitialized(T, o, f);
      return f.failable ? new Some(o) : o;
    }
    // a class
    const o = new SObj(T);
    const r = runInitWith(T, o, args, e);
    return r === INIT_NIL ? null : r ? new Some(o) : o;
  }
  /** stored properties with their default values (an optional var starts as nil) */
  function initStored(T, o) {
    for (const s of T.stored) {
      if (s.mods.has('lazy')) { o.f.set(s.name, UNSET); continue; }
      if (s.init) { const l = line; o.f.set(s.name, conv(withSelfInit(T, () => stored(rvalT(s.init, s.type), s.init)), s.type, s.init)); line = l; }
      else o.f.set(s.name, s.type && s.type.opt && s.mutable ? null : UNSET);
    }
  }
  function withSelfInit(T, f) { frames.push({ name: T.name, scopes: [new Map()], T, isStatic: false, hidden: true }); try { return f(); } finally { frames.pop(); } }
  function checkInitialized(T, o, f) {
    for (const s of T.stored) if (o.f.get(s.name) === UNSET && !s.mods.has('lazy')) { line = f.endLine || line; fail(`return from initializer without initializing all stored properties`); }
  }
  /** a class's init: its own properties' defaults, then the init's body (which calls super.init); returns failable-ness */
  function runInitWith(T, o, args, e) {
    let inits = T.inits;
    let owner = T;
    if (!inits.length) {
      // no init: the inherited ones (when every new property has a default), or init()
      if (T.stored.some(s => !s.init && !(s.type && s.type.opt && s.mutable) && !s.mods.has('lazy'))) fail(`class '${T.name}' has no initializers`);
      if (T.base) { initStored(T, o); return runInitWith(T.base, o, args, e); }
      if (args.length) fail(`argument passed to call that takes no arguments`);
      initStored(T, o);
      return false;
    }
    const f = pickOverload(inits, args, 'init');
    if (!f.convenience) initStored(owner, o);
    try { invokeWith(f, args, o, e); } catch (err) { if (err === INIT_NIL) return INIT_NIL; throw err; }
    if (!f.convenience && T.base && !o.superDone?.has(T)) {
      // no super.init call: the base's init() runs at the end
      const bi = T.base.inits;
      if (bi.length && !bi.some(x => !x.params.length)) fail(`'super.init' isn't called on all paths before returning from initializer`);
      o.superDone = o.superDone || new Set(); o.superDone.add(T);
      runInitWith(T.base, o, [], e);
    }
    for (let x = T; x; x = x.base) for (const s of x.stored) if (o.f.get(s.name) === UNSET && !s.mods.has('lazy')) fail(`return from initializer without initializing all stored properties`);
    return !!f.failable;
  }
  /** super.init(…) / self.init(…) inside an init */
  function runInit(T, o, e, isSuper, sf) {
    if (o instanceof SObj) {
      if (isSuper) {
        const own = selfFrame().T;
        for (const s of own.stored) if (o.f.get(s.name) === UNSET && !s.mods.has('lazy')) fail(`property 'self.${s.name}' not initialized at super.init call`);
        o.superDone = o.superDone || new Set(); o.superDone.add(own);
      }
      const args = argList(e.args, T.inits.length === 1 ? T.inits[0].params : null);
      const r = runInitWith(T, o, args, e);
      if (r === INIT_NIL) throw INIT_NIL;
      return VOID;
    }
    // a struct's self.init(…)
    const args = argList(e.args, T.inits.length === 1 ? T.inits[0].params : null);
    const fresh = constructWith(T, args, e);
    const v = fresh instanceof Some ? fresh.v : fresh;
    if (v === null) throw INIT_NIL;
    for (const [k, x] of v.f) o.f.set(k, x);
    void sf;
    return VOID;
  }

  /* ---- patterns ---- */
  /** does v match pattern p; binds what it names into binds (a Map) */
  function matches(p, v, binds, mutable = false) {
    switch (p.k) {
      case 'any': return true;
      case 'bind': binds.set(p.name, { v, mutable }); return true;
      case 'popt': { if (v === null) return false; return matches(p.p, v instanceof Some ? v.v : v, binds, mutable); }
      case 'pas': { const x = v instanceof Some ? v.v : v; if (x === null || !fits(x, p.type)) return false; return matches(p.p, x, binds, mutable); }
      case 'isType': { const x = v instanceof Some ? v.v : v; return x !== null && fits(x, p.type); }
      case 'ptuple': {
        if (!(v instanceof STuple)) fail(`tuple pattern cannot match values of the non-tuple type '${typeName(v)}'`);
        if (v.a.length !== p.items.length) fail(`tuple pattern has the wrong length for tuple type '${typeName(v)}'`);
        return p.items.every((q, k) => matches(q, v.a[k], binds, mutable));
      }
      case 'pcase': {
        let x = v;
        if (p.name === 'some' || p.name === 'none') { if (p.name === 'none') return v === null; if (v === null) return false; x = v instanceof Some ? v.v : v; return !p.sub || matches(p.sub[0], x, binds, mutable); }
        if (x instanceof Some) x = x.v;
        if (x === null) return false;
        if (!(x instanceof SEnum)) fail(`enum case '${p.name}' not found in type '${typeName(v)}'`);
        if (!x.T.cases.has(p.name)) fail(`type '${x.T.name}' has no member '${p.name}'`);
        if (x.c !== p.name) return false;
        if (!p.sub) return true;
        const pay = x.p || [];
        if (p.sub.length === 1 && pay.length > 1) return matches(p.sub[0], new STuple(pay, x.T.cases.get(x.c).assoc.map(a => a.label)), binds, mutable);
        if (p.sub.length !== pay.length) fail(`tuple pattern has the wrong length for tuple type '(${pay.map(typeName).join(', ')})'`);
        return p.sub.every((q, k) => matches(q, pay[k], binds, mutable));
      }
      case 'pexpr': {
        const e = p.e;
        if (e.k === 'name' && e.n === '_') return true;
        const pv = e.k === 'imember' || e.k === 'call' && e.f.k === 'imember' ? rvalT(e, valueType(v)) : e.k === 'nil' ? null : rvalT(e, typeof v === 'number' ? { n: 'Double' } : null);
        if (pv instanceof SRange) return lib.rangeContains(pv, v instanceof Some ? v.v : v);
        if (pv === null) return v === null;
        if (v instanceof Some && !(pv instanceof Some)) return equal(v.v, pv, null);
        if (typeof v === 'bigint' && typeof pv === 'number' && isIntLit(e)) return Number(v) === pv;
        if (v instanceof SChar && typeof pv === 'string' && e.k === 'str') return lib.charCount(pv) === 1 && v === CH(pv);
        return equal(v, pv, { l: { k: 'x' }, r: e });
      }
    }
    fail('cannot match pattern ' + p.k);
  }

  /* ---- statements ---- */
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  /** runs statements in a new scope (or the current one), with their defers at the end */
  function runBlock(items, newScope = true, pre) {
    const f = frame();
    const sc = newScope ? new Map() : f.scopes.at(-1);
    if (newScope) f.scopes.push(sc);
    if (pre) pre(sc);
    const myDefers = [];
    const prevDefers = sc.defers;
    sc.defers = myDefers;
    hoist(items, sc);
    try { for (const s of items) exec(s); }
    finally {
      sc.defers = prevDefers;
      for (let k = myDefers.length - 1; k >= 0; k--) runBlock(myDefers[k], true);
      if (newScope) f.scopes.pop();
    }
  }
  /** local functions and types can be used anywhere in their block */
  function hoist(items, sc) {
    for (const s of items) {
      if (s.k === 'func') {
        const fn = funcOf(s, null);
        fn.env = null; fn.local = true;
        const r = sc.get(s.name);
        if (r && r.fns) { r.fns.push(fn); continue; }
        const rr = { name: s.name, v: fn, mutable: false, hidden: true, isFn: true, fns: [fn] };
        sc.set(s.name, rr);
        fn.env = null;
        fn.capture = true;
      }
    }
    // their environment: this block and what is around it
    const env = capture();
    for (const s of items) if (s.k === 'func') { const r = sc.get(s.name); for (const fn of r.fns) { if (!fn.env) { fn.env = env; fn.selfFrame = selfFrame(); } } }
  }
  function exec(s) {
    switch (s.k) {
      case 'import': case 'typealias': case 'func': return;
      case 'type': { const f = frame(); if (!f.top) { if (s.kind === 'protocol') protoOf(s); else { const T = makeType(s, null); linkType(T); } } return; }
      case 'ext': return;
      case 'multi': for (const x of s.items) exec(x); return;
      case 'expr': {
        step(s.line);
        const v = rval(s.e);
        if (v instanceof SFn && s.e.k === 'closure') fail('closure expression is unused');
        return;
      }
      case 'var': {
        step(s.line);
        declVar(s);
        return;
      }
      case 'destructure': {
        step(s.line);
        const v = s.type ? conv(rvalT(s.init, s.type), s.type, s.init) : stored(rval(s.init), s.init);
        const binds = new Map();
        if (!matches(s.p, v, binds, s.mutable)) fail('pattern does not match');
        for (const [n, b] of binds) declare(n, share(b.v), { mutable: s.mutable });
        return;
      }
      case 'assign': step(s.line); assign(s); return;
      case 'if': {
        step(s.line);
        const ok = runConds(s.conds, sc => runBlock(s.then, true, pre => { for (const [n, r] of sc) pre.set(n, r); }));
        if (!ok && s.else) { if (s.else.length === 1 && s.else[0].k === 'if') exec(s.else[0]); else runBlock(s.else); }
        return;
      }
      case 'guard': {
        step(s.line);
        const binds = new Map();
        const ok = evalConds(s.conds, binds);
        if (!ok) {
          runBlock(s.else);
          fail(`'guard' body must not fall through, consider using a 'return' or 'throw' to exit the scope`);
        }
        const sc = frame().scopes.at(-1);
        for (const [n, r] of binds) { if (sc.has(n) && !sc.get(n).isFn) { /* guard let x = x shadows */ } sc.set(n, r); }
        return;
      }
      case 'while':
        for (;;) {
          step(s.line);
          let r = null;
          const ok = runConds(s.conds, sc => { r = loopRound(s, () => runBlock(s.body, true, pre => { for (const [n, x] of sc) pre.set(n, x); })); });
          if (!ok || r === 'break') return;
        }
      case 'repeat':
        for (;;) {
          const r = loopRound(s, () => runBlock(s.body));
          if (r === 'break') return;
          step(s.endLine || s.line);
          if (!cond(s.cond)) return;
        }
      case 'for': return forIn(s);
      case 'switch': return switchStmt(s);
      case 'return': {
        step(s.line);
        const f = frame();
        if (f.top) fail(`return invalid outside of a func`);
        const fn = f.fn;
        if (fn && fn.isInit) {
          if (s.e && s.e.k === 'nil') { if (!fn.failable) fail(`'nil' is the only return value permitted in an initializer`); throw INIT_NIL; }
          if (s.e) fail(`'nil' is the only return value permitted in an initializer`);
          throw new Jump('return', null, VOID);
        }
        const v = s.e ? stored(rvalT(s.e, fn ? fn.ret : null), s.e && !(s.e.k === 'name' && f.scopes.some(sc => sc.has(s.e.n)))) : VOID;
        const j = new Jump('return', null, v);
        j.e = s.e;
        throw j;
      }
      case 'break': step(s.line); throw new Jump('break', s.label, null);
      case 'continue': step(s.line); throw new Jump('continue', s.label, null);
      case 'fallthrough': throw new Jump('fallthrough', null, null);
      case 'throw': {
        step(s.line);
        const v = rval(s.e);
        if (!isErrorValue(v)) fail(`thrown expression type '${typeName(v)}' does not conform to 'Error'`);
        throw new Thrown(v, s.line);
      }
      case 'defer': frame().scopes.at(-1).defers.push(s.body); return;
      case 'do': return doStmt(s);
      case 'deinit': case 'init': case 'subscript': fail(`initializers may only be declared within a type`, s.line);
      case 'case': fail(`enum 'case' is not allowed outside of an enum`, s.line);
    }
    fail('cannot run ' + s.k);
  }
  function declVar(s) {
    if (s.mods && s.mods.has('lazy') && frame().top) { /* lazy at top level: just a var */ }
    if (s.acc && s.acc.get) {                        // a computed local variable
      const r = declare(s.name, UNSET, { mutable: false, type: s.type, hidden: true });
      r.v = VOID;
      const fn = new SFn({ name: s.name, params: [], ret: s.type, body: s.acc.get, closure: false, accessor: true, env: capture(), line: s.line, selfFrame: selfFrame() });
      Object.defineProperty(r, 'v', { get: () => invoke(fn, [], null), set: () => fail(`cannot assign to value: '${s.name}' is a get-only property`) });
      return;
    }
    let v = UNSET;
    if (s.init) {
      v = s.type ? conv(rvalT(s.init, s.type), s.type, s.init) : stored(rval(s.init), s.init);
      if (v === VOID && !s.type) { /* let x = f() of a Void function: x is () */ }
      if (v instanceof SImplicit) fail(`cannot infer contextual base in reference to member '${v.name}'`);
      if (s.init.k === 'nil' && !s.type) fail(`'nil' requires a contextual type`);
      v = share(v) === v && fromPlace(s.init) ? v : v;
    } else if (!s.type) fail(`type annotation missing in pattern`);
    else if (s.type.opt && s.mutable) v = null;
    const r = declare(s.name, v, { mutable: s.mutable, type: s.type });
    if (r && s.type && s.type.iuo) r.iuo = true;
    if (r && s.acc && (s.acc.didSet || s.acc.willSet)) r.observed = s.acc;
  }
  /** evaluates if / while conditions into binds; false at the first that fails */
  function evalConds(conds, binds) {
    const f = frame();
    const sc = new Map();
    f.scopes.push(sc);
    try {
      for (const c of conds) {
        if (c.k === 'expr') { if (!cond(c.e)) return false; continue; }
        if (c.k === 'bind') {
          const v = c.type ? rvalT(c.e, { opt: c.type }) : rval(c.e);
          if (v === null) return false;
          if (!(v instanceof Some)) fail(`initializer for conditional binding must have Optional type, not '${typeName(v)}'`);
          const r = { name: c.name, v: share(v.v), mutable: c.mutable, type: c.type };
          sc.set(c.name, r); binds.set(c.name, r);
          continue;
        }
        const m = new Map();
        if (!matches(c.p, rval(c.e), m)) return false;
        for (const [n, b] of m) { const r = { name: n, v: share(b.v), mutable: b.mutable }; sc.set(n, r); binds.set(n, r); }
      }
      return true;
    } finally { f.scopes.pop(); }
  }
  function runConds(conds, then) {
    const binds = new Map();
    if (!evalConds(conds, binds)) return false;
    then(binds);
    return true;
  }
  /** a loop round: break and continue (with this loop's label, or none) end it */
  function loopRound(s, fn) {
    try { fn(); return null; }
    catch (err) {
      if (err instanceof Jump && (err.k === 'break' || err.k === 'continue') && (!err.label || err.label === s.label)) return err.k;
      throw err;
    }
  }
  function forIn(s) {
    step(s.line);
    const seq = rval(s.seq);
    const items = lib.iterate(seq, s.seq);
    for (const x of items) {
      const binds = new Map();
      if (!matches(s.pat, x, binds, false)) { if (s.pat.k === 'pcase' || s.pat.k === 'popt' || s.pat.k === 'pexpr') { continue; } fail('pattern does not match'); }
      const r = loopRound(s, () => runBlock(s.body, true, sc => {
        for (const [n, b] of binds) sc.set(n, { name: n, v: share(b.v), mutable: b.mutable });
        if (s.where) {
          frame().scopes.push(sc);
          let ok;
          try { ok = cond(s.where); } finally { frame().scopes.pop(); }
          if (!ok) throw SKIP_ROUND;
        }
      }));
      if (r === 'break') return;
      step(s.line);
    }
  }
  const SKIP_ROUND = new Jump('continue', null, null);
  function switchStmt(s) {
    step(s.line);
    const v = rval(s.subject);
    let k = 0, binds = null;
    for (; k < s.cases.length; k++) {
      const c = s.cases[k];
      if (!c.pats) break;
      let hit = false;
      for (const { p, where } of c.pats) {
        const m = new Map();
        if (!matches(p, v, m)) continue;
        if (where) {
          const sc = new Map();
          for (const [n, b] of m) sc.set(n, { name: n, v: b.v, mutable: b.mutable });
          frame().scopes.push(sc);
          let ok;
          try { ok = cond(where); } finally { frame().scopes.pop(); }
          if (!ok) continue;
        }
        hit = true; binds = m; break;
      }
      if (hit) break;
    }
    if (k >= s.cases.length) fail(`switch must be exhaustive`, s.line);
    for (; k < s.cases.length; k++) {
      const c = s.cases[k];
      try {
        runBlock(c.body, true, sc => { if (binds) for (const [n, b] of binds) sc.set(n, { name: n, v: share(b.v), mutable: b.mutable }); });
        return;
      } catch (err) {
        if (err instanceof Jump && err.k === 'fallthrough') { binds = null; continue; }
        if (err instanceof Jump && err.k === 'break' && (!err.label || err.label === s.label)) return;
        throw err;
      }
    }
  }
  function doStmt(s) {
    try {
      runBlock(s.body);
    } catch (err) {
      if (err instanceof Jump && err.k === 'break' && err.label && err.label === s.label) return;
      if (!(err instanceof Thrown)) throw err;
      for (const c of s.catches) {
        const m = new Map();
        if (c.p && !matches(c.p, err.v, m)) continue;
        if (!c.p) m.set('error', { v: err.v, mutable: false });
        if (c.where) { const sc = new Map(); for (const [n, b] of m) sc.set(n, { name: n, v: b.v }); frame().scopes.push(sc); let ok; try { ok = cond(c.where); } finally { frame().scopes.pop(); } if (!ok) continue; }
        step(c.line);
        runBlock(c.body, true, sc => { for (const [n, b] of m) sc.set(n, { name: n, v: b.v, mutable: false }); });
        return;
      }
      throw err;
    }
  }
  function assign(s) {
    const mark = pendingSets.length;
    try {
      if (s.op === '=') {
        const t = placeType(s.l);
        const v = t ? rvalT(s.r, t) : s.r.k === 'nil' ? null : rval(s.r);
        assignTo(s.l, stored(v, s.r), s.r);
        flushSets(mark);
        return;
      }
      const op = s.op.slice(0, -1);
      // a += b on an array / string in place
      const cur = s.l.k === 'chain' ? (() => { try { return rval(s.l.e); } catch (err) { if (err === NIL_CHAIN) return NIL_CHAIN; throw err; } })() : rval(s.l);
      if (cur === NIL_CHAIN) return;
      const r = typeof cur === 'number' && s.r.k !== 'imember' ? rvalT(s.r, { n: 'Double' }) : cur instanceof SNum ? rvalT(s.r, { n: cur.t }) : rval(s.r);
      if (cur instanceof SArr && op === '+') {
        if (!(r instanceof SArr) && !(r instanceof SSet) && !(typeof r === 'string')) fail(`binary operator '+=' cannot be applied to operands of type '${typeName(cur)}' and '${typeName(r)}'`);
        const target = lvalue(s.l, 'mutating');
        for (const x of lib.items(r)) target.a.push(share(x));
        flushSets(mark);
        return;
      }
      if (cur instanceof Some || cur === null) fail(`value of optional type '${typeName(cur)}' must be unwrapped to a value of type '${cur === null ? 'Int' : typeName(cur.v)}'`);
      const v = binVals(op, cur, r, { l: s.l, r: s.r, op });
      if (s.l.k === 'chain') { try { assignTo(s.l.e, v, null, 'compound'); } catch (err) { if (err !== NIL_CHAIN) throw err; } }
      else assignTo(s.l, v, null, 'compound');
      flushSets(mark);
    } catch (err) { if (err === NIL_CHAIN) return; throw err; }
  }
  /** the declared type of a place, so literals assigned to it take it */
  function placeType(e) {
    if (e.k === 'self') { const sf = selfFrame(); return sf && sf.T && sf.T.name ? { n: sf.T.name } : null; }
    if (e.k === 'name') { const r = lookup(e.n); if (r) return r.type; const sf = selfFrame(); if (sf && !sf.isStatic) { const st = findStored(sf.T, e.n) || findComputed(sf.T, e.n); if (st) return st.type; } if (sf) { const ss = findStatic(sf.T, e.n); if (ss) return ss.p.type; } return null; }
    if (e.k === 'member') {
      let base;
      try { base = e.e.k === 'self' || e.e.k === 'name' || e.e.k === 'member' ? rval(e.e) : null; } catch (err) { if (err === NIL_CHAIN) return null; if (err instanceof SwError || err instanceof Trap) return null; throw err; }
      if (base instanceof Some) base = base.v;
      if (base instanceof SObj || base instanceof SVal) { const st = findStored(base.T, e.name); if (st) return st.type; const cp = findComputed(base.T, e.name); return cp ? cp.type : null; }
      if (base instanceof SType) { const T = typeOfT(base.t); if (typeof T !== 'string') { const st = findStatic(T, e.name); return st ? st.p.type : null; } }
      return null;
    }
    if (e.k === 'index') {
      try {
        const b = rval(e.e);
        if (b instanceof SArr) return b.et || (b.a.length && typeof b.a[0] === 'number' ? { n: 'Double' } : b.a.length && b.a[0] instanceof Some ? { opt: valueType(b.a[0].v) } : null);
        if (b instanceof SDict) return b.vt ? { opt: b.vt } : null;
      } catch (err) { if (err === NIL_CHAIN || err instanceof SwError) return null; throw err; }
    }
    if (e.k === 'chain') return placeType(e.e);
    return null;
  }

  /* ---- snapshots ---- */
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = o => { let n = ids.get(o); if (!n) { n = nextId++; ids.set(o, n); } return n; };
  const P = (k, s) => ({ t: 'p', k, s });
  const aliases2 = new WeakMap();
  /** the id of the k-th extra place a shared value is shown in (the same from step to step) */
  const aliasId = (v, k) => { let a = aliases2.get(v); if (!a) { a = []; aliases2.set(v, a); } while (a.length < k) a.push(nextId++); return a[k - 1]; };
  function ser(v, ctx, depth) {
    if (v === UNSET) return P('undef', '?');
    if (v === null) return P('null', 'nil');
    if (v instanceof Some) return ser(v.v, ctx, depth);
    if (typeof v === 'bigint') return P('num', String(v));
    if (typeof v === 'number') return P('num', swiftDouble(v));
    if (typeof v === 'boolean') return P('bool', String(v));
    if (typeof v === 'string') return P('str', JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v));
    if (v instanceof SChar) return P('char', JSON.stringify(v.c));
    if (v instanceof SNum) return P('num', v.t === 'Float' ? swiftDouble(v.v, true) : String(v.v));
    if (v === VOID) return P('sym', '()');
    if (v instanceof SFn) return { t: 'fn', s: v.closure ? 'closure' : v.name };
    if (v instanceof SEnum && !v.p) return P('sym', '.' + v.c);
    if (v instanceof SRange || v instanceof SStride || v instanceof SIdx || v instanceof SType || v instanceof SImplicit) return P('sym', lib.describe(v));
    let id = idOf(v);
    if (ctx.seen.has(id)) {
      // a value (array, struct…) held in two places is two values in Swift (they only share storage until one changes): two boxes
      if (!isVal(v)) { ctx.refs.add(id); return { t: 'ref', id }; }
      const k = (ctx.occ.get(v) || 0) + 1;
      ctx.occ.set(v, k);
      id = aliasId(v, k);
    }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    const kids = xs => { const n = Math.min(xs.length, MAX_ITEMS); return { items: xs.slice(0, n).map(x => ser(x, ctx, depth + 1)), more: xs.length - n }; };
    if (v instanceof SArr) { const xs = lib.items(v); return { t: 'arr', id, len: xs.length, ...kids(xs), tn: typeName(v) }; }
    if (v instanceof SSet) { const xs = [...v.m.values()]; return { t: 'set', id, ...kids(xs), cls: typeName(v) }; }
    if (v instanceof SDict) { const es = [...v.m.values()], n = Math.min(es.length, 30); return { t: 'map', id, entries: es.slice(0, n).map(([k, x]) => [ser(k, ctx, depth + 1), ser(x, ctx, depth + 1)]), more: es.length - n, cls: typeName(v) }; }
    if (v instanceof STuple) {
      if (v.labels && v.labels.every(Boolean)) return { t: 'obj', id, cls: '', entries: v.a.map((x, k) => [v.labels[k], ser(x, ctx, depth + 1)]), more: 0 };
      return { t: 'arr', id, len: v.a.length, ...kids(v.a), tn: 'tuple' };
    }
    if (v instanceof SVal || v instanceof SObj) {
      const entries = [];
      for (const [k, x] of v.f) entries.push([k, ser(x, ctx, depth + 1)]);
      return { t: 'obj', id, cls: v.T.name, entries: entries.slice(0, 30), more: Math.max(0, entries.length - 30) };
    }
    if (v instanceof SEnum) {
      const c = v.T.cases.get(v.c);
      return { t: 'obj', id, cls: v.T.name + '.' + v.c, entries: v.p.map((x, k) => [(c.assoc[k] && c.assoc[k].label) || String(k), ser(x, ctx, depth + 1)]), more: 0 };
    }
    return P('sym', lib.describe(v));
  }
  function brief(v) {
    if (v === UNSET) return '?';
    if (v === null) return 'nil';
    if (v instanceof Some) return brief(v.v);
    if (typeof v === 'string') return JSON.stringify(v.length > 14 ? v.slice(0, 14) + '…' : v);
    if (v instanceof SChar) return JSON.stringify(v.c);
    if (v instanceof SArr) return typeName(v).slice(0, 20) + '(' + lib.items(v).length + ')';
    if (v instanceof SDict || v instanceof SSet) return typeName(v).slice(0, 24) + '(' + v.m.size + ')';
    if (v instanceof SObj || v instanceof SVal) return v.T.name + '(…)';
    if (v instanceof SEnum) return '.' + v.c + (v.p ? '(…)' : '');
    if (v instanceof STuple) return '(…)';
    if (v instanceof SFn) return v.closure ? 'closure' : v.name;
    try { return lib.describe(v).slice(0, 20); } catch { return '?'; }
  }
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set(), occ: new Map() };
    const vars = [];
    const add = (n, r, scope) => { if (r.hidden || r.isFn) return; let v; try { v = r.v; } catch { return; } vars.push({ name: n, scope, node: ser(v, ctx, 0) }); };
    if (f && !f.hidden && !f.top) {
      const shown = new Map();
      for (const sc of f.scopes) for (const [n, r] of sc) shown.set(n, r);
      for (const sc of f.env || []) for (const [n, r] of sc) if (!shown.has(n) && sc !== globals) shown.set(n, r);
      if (f.selfRef && !(f.fn && f.fn.closure)) vars.push({ name: 'self', scope: 'local', node: ser(f.selfRef.v, ctx, 0) });
      for (const [n, r] of shown) add(n, r, 'local');
    }
    if (f && f.top) for (const sc of f.scopes.slice(1)) for (const [n, r] of sc) add(n, r, 'local');
    for (const [n, r] of globals) if (!(f && !f.top && f.scopes.some(sc => sc.has(n)))) add(n, r, 'global');
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }

  /* ---- the library ---- */
  const lib = makeLib({
    fail, trap, write, rval, rvalT, conv, fits, typeName, typeText, equal, eqVals, invoke, invokeWith, callValue, Thrown, line: () => line, findType, conforms,
    instanceMember, findComputed, allProtos, isErrorValue, hasFoundation, construct, constructWith, idOf, assignTo, lvalue, lookup, stored, frame, share, checkMutable,
    less: (a, b) => binVals('<', a, b, { l: {}, r: {} }), trapRaw, keyType, typeOfValue, setNilType: t => { nilType = t; },
  });

  /* ---- extensions and declarations ---- */
  function linkType(T) {
    if (T.pendingBase) { const B = types.get(T.pendingBase); if (!B) fail(`cannot find type '${T.pendingBase}' in scope`, T.decl.line); T.base = B; }
    for (const N of T.nested.values()) linkType(N);
  }
  function addExtension(d) {
    const tn = d.type.n || (d.type.arr ? 'Array' : d.type.dict ? 'Dictionary' : d.type.set ? 'Set' : null);
    const T = findType(tn);
    if (T) { for (const s of d.supers) T.protos.add(s.n); addMembers(T, d.members, true); return; }
    if (protocols.has(tn)) {
      const P = protocols.get(tn);
      for (const m of d.members) {
        if (m.k === 'func') { const fn = funcOf(m, null); fn.protoExt = P; const map = m.mods.has('static') ? P.staticFns : P.methods; if (!map.has(m.name)) map.set(m.name, []); map.get(m.name).push(fn); }
        else if (m.k === 'var' && m.acc && m.acc.get) P.computed.set(m.name, { ...m, T: null });
      }
      if (!PROTO_TYPES[tn]) return;
    }
    const targets = PROTO_TYPES[tn] || [tn];
    for (const b of targets) {
      if (!builtinExt.has(b)) builtinExt.set(b, { methods: new Map(), computed: new Map(), staticFns: new Map(), statics: new Map() });
      const ext = builtinExt.get(b);
      for (const m of d.members) {
        if (m.k === 'func') { const fn = funcOf(m, null); fn.ext = b; fn.T = null; fn.extOf = b; const map = m.mods.has('static') ? ext.staticFns : ext.methods; if (!map.has(m.name)) map.set(m.name, []); map.get(m.name).push(fn); }
        else if (m.k === 'var' && m.acc && m.acc.get) { if (m.mods.has('static')) ext.statics.set(m.name, { p: m, v: UNSET, T: { name: b, stored: [], computed: new Map(), methods: new Map(), statics: new Map(), staticFns: new Map(), protos: new Set(), nested: new Map() } }); else ext.computed.set(m.name, { ...m, T: null }); }
        else if (m.k === 'var' && m.mods.has('static')) ext.statics.set(m.name, { p: m, v: UNSET, T: { name: b, stored: [], computed: new Map(), methods: new Map(), statics: new Map(), staticFns: new Map(), protos: new Set(), nested: new Map() } });
        else if (m.k === 'init') fail('initializers in extensions of library types are not supported here', m.line);
        else if (m.k === 'var') fail('extensions must not contain stored properties', m.line);
      }
    }
  }

  /* ---- before running: a function that can end without returning its value (the compiler's check) ---- */
  const exits = s => {
    switch (s.k) {
      case 'return': case 'throw': return true;
      case 'expr': return s.e.k === 'call' && s.e.f.k === 'name' && ['fatalError', 'preconditionFailure', 'exit'].includes(s.e.f.n);
      case 'if': return !!s.else && allExit(s.then) && allExit(s.else);
      case 'switch': return s.cases.every(c => allExit(c.body) || c.body.some(x => x.k === 'fallthrough'));
      case 'do': return allExit(s.body) && s.catches.every(c => allExit(c.body)) && s.catches.some(c => !c.p);
      case 'while': return s.conds.length === 1 && s.conds[0].k === 'expr' && s.conds[0].e.k === 'bool' && s.conds[0].e.v && !breaks(s.body, s.label);
      case 'repeat': return s.cond.k === 'bool' && s.cond.v && !breaks(s.body, s.label);
    }
    return false;
  };
  const allExit = items => items.some(exits);
  /** does a break leave this loop (an unlabelled one not inside an inner loop or switch, or one with its label) */
  function breaks(items, label, inner = false) {
    for (const s of items) {
      if (s.k === 'break' && (s.label ? s.label === label : !inner)) return true;
      const kids = [s.then, s.else, s.body, ...(s.cases || []).map(c => c.body), ...(s.catches || []).map(c => c.body)].filter(Array.isArray);
      const deeper = inner || ['while', 'repeat', 'for', 'switch'].includes(s.k);
      if (kids.some(k => breaks(k, label, deeper))) return true;
    }
    return false;
  }
  function checkReturns(items, T, local) {
    for (const s of items) {
      if (s.k === 'func' && s.body) {
        const single = s.body.length === 1 && s.body[0].k === 'expr';
        if (s.ret && !(s.ret.n === 'Void' || s.ret.tuple && !s.ret.tuple.length) && !single && !allExit(s.body)) {
          fail(`missing return in ${T ? (s.mods.has('static') ? 'static method' : 'instance method') : local ? 'local function' : 'global function'} expected to return '${typeText(s.ret)}'`, s.endLine);
        }
        checkReturns(s.body, null, true);
      } else if (s.k === 'type' || s.k === 'ext') checkReturns(s.members, s, false);
      else if (s.k === 'var' && s.acc && Array.isArray(s.acc.get) && s.type && !(s.acc.get.length === 1 && s.acc.get[0].k === 'expr') && !allExit(s.acc.get)) fail(`missing return in getter expected to return '${typeText(s.type)}'`, s.line);
      else for (const k of [s.then, s.else, s.body]) if (Array.isArray(k) && s.k !== 'func') checkReturns(k, null, true);
    }
  }

  /* ---- run: the declarations, then the top-level code in order ---- */
  let error = null;
  frames.push(topFrame);
  stack.push({ name: 'main', args: '', id: ++calls });   // the top-level code (main.swift)
  try {
    for (const d of prog.items) if (d.k === 'type' && d.kind === 'protocol') { line = d.line; protoOf(d); }
    for (const d of prog.items) if (d.k === 'typealias') aliases.set(d.name, d.type);
    for (const d of prog.items) if (d.k === 'type' && d.kind !== 'protocol') { line = d.line; makeType(d, null); }
    for (const T of [...types.values()]) if (!T.outer) { line = T.decl.line; linkType(T); }
    for (const d of prog.items) if (d.k === 'ext') { line = d.line; addExtension(d); }
    for (const d of prog.items) if (d.k === 'func') { line = d.line; const fn = funcOf(d, null); if (!globalFns.has(d.name)) globalFns.set(d.name, []); globalFns.get(d.name).push(fn); }
    // a class or struct that says it conforms to a protocol must have what it asks for
    for (const T of types.values()) for (const pn of allProtos(T)) {
      const Pr = protocols.get(pn);
      if (!Pr) continue;
      for (const req of Pr.reqs) if (!findMethods(T, req).length && !findStored(T, req) && !findComputed(T, req) && !(Pr.methods.has(req)) && !(Pr.computed.has(req))) fail(`type '${T.name}' does not conform to protocol '${pn}'`, T.decl.line);
    }
    checkReturns(prog.items, null, false);
    const top = prog.items.filter(s => !['type', 'ext', 'func', 'import', 'typealias'].includes(s.k));
    globals.defers = [];
    try { for (const s of top) exec(s); }
    finally { for (let k = globals.defers.length - 1; k >= 0; k--) runBlock(globals.defers[k]); }
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof Thrown) error = { msg: `Fatal error: Error raised at top level: ${lib.debugDescribe(e.v)} (line ${e.line || line})` };
    else if (e instanceof Trap) error = { msg: `${e.raw ? '' : 'Fatal error: '}${e.message} (line ${line})` };
    else if (e instanceof SwError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e instanceof Jump) error = { msg: `Error on line ${line}: ` + (e.k === 'return' ? 'return invalid outside of a func' : e.k === 'fallthrough' ? "'fallthrough' is only allowed inside a switch" : `'${e.k}' is only allowed inside a loop, if, do, or switch`) };
    else if (e === NIL_CHAIN) error = { msg: `Error on line ${line}: optional chaining is not allowed here` };
    else if (e === INIT_NIL) error = { msg: `Error on line ${line}: 'nil' is the only return value permitted in an initializer` };
    else if (e && e.exit !== undefined) error = e.exit === 0 ? null : { msg: `The program called exit(${e.exit}).`, soft: true };
    else if (e instanceof RangeError) error = { msg: `The program's recursion is too deep: the stack overflowed (line ${line})` };
    else throw e;
  }
  if (outBuf) logs.push({ type: 'log', s: outBuf });
  if (!error || (error.soft && !stopped)) {
    frames.length = 0;
    const c = captureVars(null);
    steps.push({ line: -1, stack: [], vars: c.vars, refs: c.refs, logs: logs.length });
  }
  return { steps, logs, error, rets };
}

export { Some, SChar, CH, SNum, SArr, SDict, SSet, STuple, SVal, SObj, SEnum, SFn, SRange, SStride, SIdx, SType, SImplicit, VOID };
