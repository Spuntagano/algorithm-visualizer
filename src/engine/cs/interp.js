/**
 * The C# interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and
 * before each test of a loop), in the format of src/model.js. The library (Console, string, List, Dictionary, LINQ…)
 * is ./lib.js.
 *
 * Values: int (and short, byte…) is a JavaScript number, long a BigInt, double and float a D, char a Ch (one per
 * code, so == works), bool, string and null are themselves; an object (of a class, a struct or a record) is a CObj,
 * an array a CArr, a tuple a Tup, an enum value an EnumV, a lambda or method group a CFn. Structs and tuples are
 * copied when assigned, as in C#.
 *
 * runCsTrace(source) returns { steps, logs, error }, or throws an Error ("line N: …") for a syntax error.
 */
import { parseCs } from './parse.js';
import { makeLib, csDouble } from './lib.js';

const MAX_STEPS = 3000, MAX_CALLS = 300, MAX_DEPTH = 5, MAX_ITEMS = 60;

export class D { constructor(v, f = false) { this.v = f ? Math.fround(v) : v; this.f = f; } }
export class Ch { constructor(c) { this.c = c; } }
const CHARS = new Map();
export const CH = c => { let x = CHARS.get(c); if (!x) { x = new Ch(c); CHARS.set(c, x); } return x; };
export class CObj { constructor(cls) { this.cls = cls; this.f = new Map(); } }
export class CArr { constructor(et, a, dims = null) { this.et = et; this.a = a; this.dims = dims; } }
export class Tup { constructor(a, names = null) { this.a = a; this.names = names; } }
export class EnumV { constructor(e, v) { this.e = e; this.v = v; } }
export class CFn { constructor(o) { Object.assign(this, o); } }
export class TypeObj { constructor(name, full) { this.name = name; this.full = full; } }
class StopRun extends Error {}
/** an argument like new() or [1, 2] that takes its type from the parameter it is passed to */
class Deferred { constructor(e) { this.e = e; } }
/** An exception in flight: obj is the exception object */
export class Thrown extends Error { constructor(obj, line) { super('thrown'); this.obj = obj; this.line = line; } }
/** What the C# compiler would refuse, met while running */
class CsError extends Error {}
const UNSET = Symbol('unset');
const BREAK = { k: 'break' }, CONTINUE = { k: 'continue' };

const INTS = { sbyte: [8, true], byte: [8, false], short: [16, true], ushort: [16, false], int: [32, true], uint: [32, false], long: [64, true], ulong: [64, false], char: [16, false], nint: [64, true], nuint: [64, false] };
const NET = { int: 'Int32', long: 'Int64', short: 'Int16', byte: 'Byte', sbyte: 'SByte', uint: 'UInt32', ulong: 'UInt64', ushort: 'UInt16', double: 'Double', float: 'Single', char: 'Char', bool: 'Boolean', string: 'String', object: 'Object', decimal: 'Decimal' };

export function runCsTrace(src) {
  const prog = parseCs(src);
  const steps = [], logs = [], stack = [], frames = [];
  const rets = {}; let calls = 0;   // every call's frame gets an id; rets: what the call returned, by that id
  let line = 0, stopped = null, outBuf = '', finalVars = null, checkedOn = false;
  const fail = (msg, l) => { if (l) line = l; throw new CsError(msg); };
  const write = (s, err) => {
    if (err) { logs.push(...s.replace(/\n$/, '').split('\n').map(x => ({ type: 'error', s: x }))); return; }
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k).replace(/\r$/, '') }); outBuf = outBuf.slice(k + 1); }
  };

  /* ---- classes: the program's, and the built-in exceptions ---- */
  const classes = new Map();                        // name → class record
  const enums = new Map();
  /** A class record from its declaration */
  function makeClass(d, outer) {
    const c = { name: d.name, full: (outer ? outer.full + '+' : d.ns ? d.ns + '.' : '') + d.name, decl: d, kind: d.k, record: d.record, isStruct: d.k === 'struct',
      isInterface: d.k === 'interface', isAbstract: d.mods.has('abstract'), isStatic: d.mods.has('static'), base: null, ifaces: [], fields: [], props: new Map(),
      methods: new Map(), ctors: [], statics: new Map(), ops: new Map(), indexer: null, nested: new Map(), outer, tps: d.tps || [], pc: d.pc };
    for (const m of d.members) {
      if (m.k === 'class' || m.k === 'struct' || m.k === 'interface' || m.k === 'enum') {
        if (m.k === 'enum') { const e = makeEnum(m, c); c.nested.set(m.name, e); } else { const n = makeClass(m, c); c.nested.set(m.name, n); }
        continue;
      }
      if (m.k === 'field') { for (const v of m.vars) { const f = { name: v.name, type: m.type, init: v.init, mods: m.mods, line: v.line }; if (m.mods.has('static')) c.statics.set(v.name, { ...f, v: UNSET }); else c.fields.push(f); } }
      else if (m.k === 'prop') {
        const auto = (m.get && m.get.auto) || (m.set && m.set.auto) || (!m.get && !m.set);
        const p = { ...m, auto: !!auto && !(m.get && (m.get.body || m.get.expr)), cls: c };
        c.props.set(m.name, p);
        if (m.mods.has('static')) c.statics.set(m.name, { name: m.name, type: m.type, init: m.init, mods: m.mods, line: m.line, v: UNSET, prop: p });
        else if (p.auto) c.fields.push({ name: m.name, type: m.type, init: m.init, mods: m.mods, line: m.line, prop: p });
      } else if (m.k === 'method') { const fn = methodFn(m, c); checkReturns(fn, c.name + '.' + m.name); if (!c.methods.has(m.name)) c.methods.set(m.name, []); c.methods.get(m.name).push(fn); }
      else if (m.k === 'ctor') c.ctors.push({ ...m, cls: c });
      else if (m.k === 'op') { const fn = methodFn({ ...m, name: 'operator ' + m.op }, c); if (!c.ops.has(m.op)) c.ops.set(m.op, []); c.ops.get(m.op).push(fn); }
      else if (m.k === 'indexer') c.indexer = { ...m, cls: c };
    }
    if (c.pc) {                                        // the primary constructor's parameters: properties of a record, captured in a class
      const pf = [];
      for (const p of c.pc) {
        if (c.record) { if (!c.props.has(p.name)) { const prop = { k: 'prop', mods: new Set(['public']), type: p.type, name: p.name, get: { auto: true }, set: { auto: true, init: !c.isStruct }, auto: true, cls: c, line: p.line }; c.props.set(p.name, prop); pf.push({ name: p.name, type: p.type, init: { k: 'pcParam', name: p.name }, mods: prop.mods, prop }); } }
        else pf.push({ name: p.name, type: p.type, init: { k: 'pcParam', name: p.name }, mods: new Set(['private']), pcHidden: true });
      }
      c.fields.unshift(...pf);
    }
    classes.set(c.name, c);
    if (outer) classes.set(outer.name + '.' + c.name, c);
    return c;
  }
  function makeEnum(d, outer) {
    const e = { name: d.name, full: (outer ? outer.full + '+' : d.ns ? d.ns + '.' : '') + d.name, members: [], byVal: new Map(), vals: new Map(), isEnum: true };
    let next = 0;
    for (const m of d.members) {
      const v = m.val ? Number(intOf(rval(m.val))) : next;
      const ev = new EnumV(e, v);
      e.members.push({ name: m.name, v });
      e.vals.set(m.name, ev);
      if (!e.byVal.has(v)) e.byVal.set(v, m.name);
      next = v + 1;
    }
    enums.set(d.name, e);
    if (outer) enums.set(outer.name + '.' + d.name, e);
    return e;
  }
  const enumVal = (e, v) => { for (const ev of e.vals.values()) if (ev.v === v) return ev; const x = new EnumV(e, v); e.vals.set('#' + v, x); return x; };
  function methodFn(m, c) {
    return new CFn({ name: m.name, params: m.params, ret: m.ret, body: m.body, expr: m.expr, cls: c, isStatic: m.mods.has('static') || (c && c.isStatic),
      isAbstract: !m.body && !m.expr, mods: m.mods, tps: m.tps || [], line: m.line, ext: m.params[0] && m.params[0].mod === 'this' });
  }
  // the built-in exceptions: classes with Message (and ParamName), so a program's own can extend them
  const EXC = {};
  const builtinExc = (name, base, ns = 'System') => {
    const c = { name, full: ns + '.' + name, builtin: true, base: base ? EXC[base] : null, fields: [], props: new Map(), methods: new Map(), ctors: [], statics: new Map(), ops: new Map(), nested: new Map(), ifaces: [], isException: true };
    EXC[name] = c;
    classes.set(name, c);
    return c;
  };
  builtinExc('Exception', null);
  for (const [n, b] of [['SystemException', 'Exception'], ['ArgumentException', 'SystemException'], ['ArgumentNullException', 'ArgumentException'],
    ['ArgumentOutOfRangeException', 'ArgumentException'], ['InvalidOperationException', 'SystemException'], ['NotImplementedException', 'SystemException'],
    ['NotSupportedException', 'SystemException'], ['IndexOutOfRangeException', 'SystemException'], ['NullReferenceException', 'SystemException'],
    ['ArithmeticException', 'SystemException'], ['DivideByZeroException', 'ArithmeticException'], ['OverflowException', 'ArithmeticException'],
    ['FormatException', 'SystemException'], ['InvalidCastException', 'SystemException'], ['ApplicationException', 'Exception'], ['TimeoutException', 'SystemException']]) builtinExc(n, b);
  builtinExc('KeyNotFoundException', 'SystemException', 'System.Collections.Generic');
  builtinExc('SwitchExpressionException', 'InvalidOperationException', 'System.Runtime.CompilerServices');
  const DEFAULT_MSG = { Exception: "Exception of type 'System.Exception' was thrown.", ArgumentNullException: 'Value cannot be null.', ArgumentOutOfRangeException: 'Specified argument was out of the range of valid values.',
    InvalidOperationException: 'Operation is not valid due to the current state of the object.', NotImplementedException: 'The method or operation is not implemented.',
    NotSupportedException: 'Specified method is not supported.', IndexOutOfRangeException: 'Index was outside the bounds of the array.', NullReferenceException: 'Object reference not set to an instance of an object.',
    DivideByZeroException: 'Attempted to divide by zero.', OverflowException: 'Arithmetic operation resulted in an overflow.', ArgumentException: 'Value does not fall within the expected range.',
    FormatException: 'One of the identified items was in an invalid format.', ArithmeticException: 'Overflow or underflow in the arithmetic operation.', InvalidCastException: 'Specified cast is not valid.' };
  const isExc = c => { for (let x = c; x; x = x.base) if (x === EXC.Exception) return true; return false; };
  /** A new exception object of a built-in (or the program's) exception class */
  function newExc(cls, msg, param) {
    const o = new CObj(cls);
    let m = msg;
    if (m == null) { for (let x = cls; x && m == null; x = x.base) m = x.builtin ? DEFAULT_MSG[x.name] : null; if (m == null) m = `Exception of type '${cls.full}' was thrown.`; }
    if (param != null) m += ` (Parameter '${param}')`;
    o.f.set('Message', m);
    if (param != null) o.f.set('ParamName', param);
    return o;
  }
  /** throws a C# exception: throwCs('IndexOutOfRangeException') */
  const throwCs = (name, msg, param) => { throw new Thrown(newExc(EXC[name], msg, param), line); };
  const nre = () => throwCs('NullReferenceException');

  /* ---- types ---- */
  /** The class, enum or built-in a type names ('int', a class record, 'List'…) */
  const findClass = n => classes.get(n) || (frame() && frame().fn && frame().fn.cls ? nestedIn(frame().fn.cls, n) : null) || null;
  const nestedIn = (c, n) => { for (let x = c; x; x = x.outer || x.base) { if (x.nested && x.nested.has(n)) return x.nested.get(n); } return null; };
  const findEnum = n => enums.get(n) || (frame() && frame().fn && frame().fn.cls ? (() => { const r = nestedIn(frame().fn.cls, n); return r && r.isEnum ? r : null; })() : null);
  /** C#'s name for a type as its errors write it: int, List<int>, int[], (int, string) */
  const typeText = t => (!t ? 'var' : t.n === 'array' ? typeText(t.of) + '[' + ','.repeat(t.rank - 1) + ']' : t.n === 'tuple' ? '(' + t.items.map(x => typeText(x.t) + (x.name ? ' ' + x.name : '')).join(', ') + ')'
    : t.n + (t.args && t.args.length ? '<' + t.args.map(typeText).join(', ') + '>' : '') + (t.nul ? '?' : ''));
  /** The kind of a value, as C# names its type */
  function kindOf(v) {
    if (typeof v === 'number') return 'int';
    if (typeof v === 'bigint') return 'long';
    if (v instanceof D) return v.f ? 'float' : 'double';
    if (v instanceof Ch) return 'char';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'string') return 'string';
    if (v === null || v === undefined) return 'null';
    return 'ref';
  }
  /** a value's type name in C# terms (for messages): int, string, Point, List<int>, int[] */
  function csType(v) {
    const k = kindOf(v);
    if (k !== 'ref') return k;
    if (v instanceof CObj) return v.cls.name;
    if (v instanceof CArr) return (v.et ? typeText(v.et) : 'object') + '[' + (v.dims ? ','.repeat(v.dims.length - 1) : '') + ']';
    if (v instanceof EnumV) return v.e.name;
    if (v instanceof Tup) return '(' + v.a.map(csType).join(', ') + ')';
    if (v instanceof CFn) return 'method group';
    return lib.csType(v);
  }
  /** .NET's full name: System.Int32, System.Collections.Generic.List`1[System.Int32], Point */
  function netType(v) {
    const k = kindOf(v);
    if (k !== 'ref') return 'System.' + NET[k];
    if (v instanceof CObj) return v.cls.full;
    if (v instanceof CArr) return (v.et ? netOfType(v.et) : 'System.Object') + '[' + (v.dims ? ','.repeat(v.dims.length - 1) : '') + ']';
    if (v instanceof EnumV) return v.e.full;
    if (v instanceof Tup) return 'System.ValueTuple`' + v.a.length + '[' + v.a.map(netType).join(',') + ']';
    if (v instanceof CFn) return v.delegateType || 'System.Func`1[System.Object]';
    return lib.netType(v);
  }
  /** the .NET name of a static type */
  function netOfType(t) {
    if (!t) return 'System.Object';
    if (NET[t.n]) return 'System.' + NET[t.n] + (t.nul ? '' : '');
    if (t.n === 'array') return netOfType(t.of) + '[' + ','.repeat(t.rank - 1) + ']';
    if (t.n === 'tuple') return 'System.ValueTuple`' + t.items.length + '[' + t.items.map(x => netOfType(x.t)).join(',') + ']';
    const c = findClass(t.n);
    if (c) return c.full;
    const e = findEnum(t.n);
    if (e) return e.full;
    return lib.netOfType(t, netOfType);
  }
  const isNumKind = k => k === 'int' || k === 'long' || k === 'double' || k === 'float' || k === 'char';
  /** the zero value of a type: 0, 0L, 0.0, '\0', false, null, a default struct */
  function zero(t) {
    if (!t) return null;
    if (t.nul) return null;
    switch (t.n) {
      case 'int': case 'short': case 'byte': case 'sbyte': case 'uint': case 'ushort': return 0;
      case 'long': case 'ulong': case 'nint': case 'nuint': return 0n;
      case 'double': return new D(0);
      case 'float': return new D(0, true);
      case 'char': return CH(0);
      case 'bool': return false;
      case 'tuple': return new Tup(t.items.map(x => zero(x.t)), t.items.some(x => x.name) ? t.items.map(x => x.name) : null);
    }
    if (t.n === 'KeyValuePair') return lib.kv(zero(t.args[0]), zero(t.args[1]));
    const c = findClass(t.n);
    if (c && c.isStruct) return construct(c, [], null, true);
    const e = findEnum(t.n);
    if (e) return enumVal(e, 0);
    return null;
  }
  /** A copy, as assigning one makes: structs and tuples are values */
  function copy(v) {
    if (v instanceof CObj && v.cls.isStruct) { const o = new CObj(v.cls); for (const [k, x] of v.f) o.f.set(k, copy(x)); return o; }
    if (v instanceof Tup) return new Tup(v.a.map(copy), v.names);
    return v;
  }
  const intOf = v => (typeof v === 'number' || typeof v === 'bigint' ? v : v instanceof Ch ? v.c : v instanceof EnumV ? v.v : fail(`CS0029: Cannot implicitly convert type '${csType(v)}' to 'int'`));
  const numOf = v => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v instanceof D ? v.v : v instanceof Ch ? v.c : v instanceof EnumV ? v.v : fail(`a number is needed, not ${csType(v)}`));
  /** an integer wrapped to a size: (byte)300 is 44 */
  function wrap(v, name) {
    const [bits, signed] = INTS[name] || [32, true];
    const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    const r = signed ? BigInt.asIntN(bits, big) : BigInt.asUintN(bits, big);
    return bits === 64 ? r : Number(r);
  }
  const fits = (v, name) => { const w = wrap(v, name); return typeof v === 'bigint' || typeof w === 'bigint' ? BigInt(w) === BigInt(v) : w === v; };
  /** Is e a constant (a literal, or arithmetic on literals, or a const)? Then int converts to byte, long… if it fits */
  function isConst(e) {
    if (!e) return false;
    switch (e.k) {
      case 'lit': return true;
      case 'paren': case 'un': return isConst(e.e);
      case 'bin': return isConst(e.l) && isConst(e.r);
      case 'name': { const r = lookupVar(e.n); return !!(r && r.isConst); }
      case 'member': return e.e.k === 'typeName' && ['MaxValue', 'MinValue'].includes(e.n);
    }
    return false;
  }
  /** Assigning v to a place of static type t: C#'s implicit conversions, and its errors (CS0266, CS0029) */
  function conv(v, t, ast, how = 'assign') {
    if (v instanceof Deferred) v = rvalT(v.e, t);
    if (!t || t.n === 'var' || t.n === 'object' || t.n === 'dynamic') return copy(v);
    if (v === UNSET) return v;
    const k = kindOf(v), n = t.n;
    const cant = (code = 'CS0029', extra = '') => fail(`${code}: Cannot implicitly convert type '${k === 'null' ? '<null>' : csType(v)}' to '${typeText(t)}'${extra}`);
    const explicit = () => cant('CS0266', '. An explicit conversion exists (are you missing a cast?)');
    if (k === 'null') {
      if (t.nul || !(INTS[n] || n === 'double' || n === 'float' || n === 'bool' || n === 'tuple' || (findClass(n) && findClass(n).isStruct) || findEnum(n))) return null;
      fail(`CS0037: Cannot convert null to '${typeText(t)}' because it is a non-nullable value type`);
    }
    if (INTS[n]) {
      if (k === 'int' || k === 'long') {
        if (n === 'char') { if (ast && isConst(ast) && how !== 'compound' && fits(v, n)) return explicit(); if (how === 'compound') return CH(wrap(v, 'char')); explicit(); }
        if (n === 'long' || n === 'ulong' || n === 'nint') return how === 'cast' ? wrap(v, n) : k === 'long' ? (n === 'ulong' ? wrap(v, n) : v) : BigInt(v);
        if (k === 'long' && how !== 'compound' && !(ast && isConst(ast) && fits(v, n))) explicit();
        if (n === 'int') return k === 'int' ? v : how === 'compound' ? wrap(v, n) : Number(v);
        if (how === 'compound' || (ast && isConst(ast) && fits(v, n))) return wrap(v, n);
        if (ast && isConst(ast)) fail(`CS0031: Constant value '${v}' cannot be converted to a '${n}'`);
        explicit();
      }
      if (k === 'char') return n === 'char' ? v : n === 'long' || n === 'ulong' ? BigInt(v.c) : n === 'byte' || n === 'sbyte' || n === 'short' ? (how === 'compound' ? wrap(v.c, n) : explicit()) : v.c;
      if (k === 'double' || k === 'float') { if (how === 'compound') return wrap(Math.trunc(v.v), n); explicit(); }
      if (v instanceof EnumV && how === 'compound') return v;
      cant();
    }
    if (n === 'double' || n === 'float') {
      if (k === 'int' || k === 'long') return new D(Number(v), n === 'float');
      if (k === 'char') return new D(v.c, n === 'float');
      if (k === 'double' || k === 'float') { if (n === 'float' && k === 'double' && how !== 'compound') explicit(); return v.f === (n === 'float') ? v : new D(v.v, n === 'float'); }
      cant();
    }
    if (n === 'bool') { if (k !== 'bool') cant(); return v; }
    if (n === 'string') { if (k !== 'string') cant(); return v; }
    if (n === 'tuple') { if (!(v instanceof Tup)) cant(); return new Tup(v.a.map((x, j) => conv(x, t.items[j] && t.items[j].t, null, how)), t.items.some(x => x.name) ? t.items.map(x => x.name) : v.names); }
    if (isNumKind(k) || k === 'bool' || k === 'string') {
      const e = findEnum(n);
      if (e) { if (k === 'int' && v === 0 && ast && isConst(ast)) return enumVal(e, 0); cant(); }
      if (findClass(n) || lib.isCollType(n) || n === 'array') cant();
      return v;                                        // a generic T, an interface like IComparable
    }
    return copy(v);
  }
  /** (T)v: C#'s explicit conversions */
  function cast(v, t, fromObject) {
    const k = kindOf(v), n = t.n;
    const bad = () => throwCs('InvalidCastException', `Unable to cast object of type '${netType(v)}' to type '${netOfType(t)}'.`);
    if (k === 'null') { if (t.nul || !(INTS[n] || n === 'double' || n === 'float' || n === 'bool')) return null; nre(); }
    if (t.nul) return cast(v, { ...t, nul: false }, fromObject);
    if (INTS[n]) {
      if (fromObject && k !== (n === 'char' ? 'char' : n) && !(k === 'int' && ['short', 'byte', 'sbyte', 'uint', 'ushort'].includes(n) && false)) { if (!(v instanceof EnumV)) bad(); }
      if (k === 'double' || k === 'float') {
        const x = v.v;
        if (checkedOn && (!Number.isFinite(x) || !fits(Math.trunc(x), n === 'char' ? 'char' : n))) throwCs('OverflowException');
        if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 63) return n === 'long' || n === 'ulong' ? -9223372036854775808n : n === 'int' ? -2147483648 : wrap(0, n);
        if ((n === 'int') && (x >= 2 ** 31 || x < -(2 ** 31))) return -2147483648;
        const r = wrap(Math.trunc(x), n === 'char' ? 'char' : n);
        return n === 'char' ? CH(r) : r;
      }
      const iv = k === 'char' ? v.c : v instanceof EnumV ? v.v : k === 'int' || k === 'long' ? v : k === 'bool' ? fail(`CS0030: Cannot convert type 'bool' to '${n}'`) : bad();
      if (checkedOn && !fits(iv, n)) throwCs('OverflowException');
      const r = wrap(iv, n);
      return n === 'char' ? CH(r) : r;
    }
    if (n === 'double' || n === 'float') {
      if (fromObject && k !== n) bad();
      if (isNumKind(k)) return new D(k === 'char' ? v.c : numOf(v), n === 'float');
      if (v instanceof EnumV) return new D(v.v, n === 'float');
      if (k === 'bool') fail(`CS0030: Cannot convert type 'bool' to '${n}'`);
      bad();
    }
    const e = findEnum(n);
    if (e) { if (v instanceof EnumV) return enumVal(e, v.v); if (k === 'int' || k === 'long' || k === 'char') return enumVal(e, Number(intOf(v))); bad(); }
    if (n === 'string') { if (k !== 'string') { if (isNumKind(k) && !fromObject) fail(`CS0030: Cannot convert type '${k}' to 'string'`); bad(); } return v; }
    if (n === 'bool') { if (k !== 'bool') { if (isNumKind(k) && !fromObject) fail(`CS0030: Cannot convert type '${k}' to 'bool'`); bad(); } return v; }
    if (!isInstance(v, t)) bad();
    return copy(v);
  }
  /** v is T (for is, as, casts, catch) */
  function isInstance(v, t) {
    if (v === null || v === undefined) return false;
    const n = t.n, k = kindOf(v);
    if (n === 'object' || n === 'dynamic') return true;
    if (k !== 'ref') return n === k || (k === 'string' && ['IEnumerable', 'IComparable', 'IEquatable'].includes(n)) || (isNumKind(k) && ['IComparable', 'IEquatable', 'IFormattable'].includes(n)) || (t.nul && n === k);
    if (n === 'array') return v instanceof CArr;
    if (n === 'tuple') return v instanceof Tup && v.a.length === t.items.length && v.a.every((x, j) => isInstance(x, t.items[j].t) || x === null);
    if (v instanceof EnumV) return v.e.name === n || n === 'Enum';
    if (v instanceof CObj) {
      for (let c = v.cls; c; c = c.base) {
        if (c.name === n || c.full === n) return true;
        if (c.ifaces.some(x => x.n === n || (classes.get(x.n) && ifaceExtends(classes.get(x.n), n)))) return true;
      }
      if (n === 'IComparable' && findMethod(v.cls, 'CompareTo')) return true;
      return false;
    }
    if (v instanceof CFn) return /^(Func|Action|Predicate|Comparison|Delegate)$/.test(n);
    return lib.isInstance(v, n);
  }
  const ifaceExtends = (c, n) => c.ifaces.some(x => x.n === n || (classes.get(x.n) && ifaceExtends(classes.get(x.n), n)));

  /* ---- frames, scopes, names ---- */
  const frame = () => frames[frames.length - 1];
  function lookupVar(name) {
    const f = frame();
    if (!f) return null;
    for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].get(name); if (r) return r; }
    for (const sc of f.env || []) { const r = sc.get(name); if (r) return r; }
    return null;
  }
  /** a new local: C# refuses a name used by an enclosing local (CS0136) or twice in one scope (CS0128) */
  function declare(name, v, t, opts = {}) {
    const f = frame();
    if (name === '_') return null;
    const scope = f.scopes.at(-1);
    if (scope.has(name)) fail(`CS0128: A local variable or function named '${name}' is already defined in this scope`);
    for (let s = f.scopes.length - 2; s >= 0; s--) if (f.scopes[s].has(name)) fail(`CS0136: A local or parameter named '${name}' cannot be declared in this scope because that name is used in an enclosing local scope to define a local or parameter`);
    const r = { v, t, name, ...opts };
    scope.set(name, r);
    return r;
  }
  const scoped = fn => { const f = frame(); f.scopes.push(new Map()); try { return fn(); } finally { f.scopes.pop(); } };

  /* ---- members: fields, properties, methods, through the class chain ---- */
  function findMethod(c, name) { for (let x = c; x; x = x.base) if (x.methods && x.methods.has(name)) return x.methods.get(name); return null; }
  /** every overload named name, the most derived first (an override replaces its base's) */
  function overloads(c, name) {
    const out = [];
    for (let x = c; x; x = x.base) for (const m of (x.methods && x.methods.get(name)) || []) if (!out.some(o => o.params.length === m.params.length && o.params.every((p, j) => typeText(p.type) === typeText(m.params[j].type)))) out.push(m);
    for (let x = c; x; x = x.base) for (const it of x.ifaces || []) { const ic = classes.get(it.n); if (ic) for (const m of ic.methods.get(name) || []) if (m.body || m.expr) out.push(m); }
    return out;
  }
  function findProp(c, name) { for (let x = c; x; x = x.base) if (x.props && x.props.has(name)) return x.props.get(name); return null; }
  function findStatic(c, name) { for (let x = c; x; x = x.base) if (x.statics && x.statics.has(name)) return { cls: x, s: x.statics.get(name) }; return null; }
  /** the static field or property, initialized on first use */
  function staticGet(cls, s) {
    if (s.prop && !s.prop.auto) return callAccessor(s.prop, null, 'get');
    if (s.v === UNSET) { s.v = zero(s.type); if (s.init) { s.v = conv(evalIn(cls, () => rvalT(s.init, s.type)), s.type, s.init); } }
    return s.v;
  }
  /** run fn as if inside cls (for static initializers) */
  function evalIn(cls, fn) {
    frames.push({ name: cls.name, scopes: [new Map()], fn: { cls, isStatic: true, name: '<init>' }, self: null, hidden: true });
    try { return fn(); } finally { frames.pop(); }
  }
  /** the classes whose statics an unqualified name can mean: the current one, its outers and bases, using static */
  function staticScopes() {
    const out = [];
    const f = frame();
    for (let c = f && f.fn && f.fn.cls; c; c = c.outer) for (let x = c; x; x = x.base) out.push(x);
    return out;
  }

  /* ---- places: get(), set(v), type ---- */
  function place(e) {
    switch (e.k) {
      case 'name': {
        if (e.n === '_' ) return { get: () => fail("CS0103: The name '_' does not exist in the current context"), set: () => {}, type: null, blank: true };
        const r = lookupVar(e.n);
        if (r) {
          if (r.isConst) fail(`CS0131: The left-hand side of an assignment must be a variable, property or indexer (${e.n} is a const)`);
          return { get: () => { if (r.v === UNSET) fail(`CS0165: Use of unassigned local variable '${e.n}'`); return r.ref ? r.ref.get() : r.v; }, set: v => { if (r.ref) r.ref.set(v); else r.v = v; r.assigned = true; }, type: r.t, cell: r, d: e.n, local: r };
        }
        const self = frame() && frame().self;
        if (self && memberOfObj(self, e.n)) return memberPlace(self, e.n, e, true);
        for (const c of staticScopes()) {
          const s = c.statics && c.statics.get(e.n);
          if (s) return staticPlace(c, s, e.n);
        }
        if (self === null && frame() && frame().fn && frame().fn.cls) {
          const c = frame().fn.cls;
          if (c.fields.some(f => f.name === e.n) || (findProp(c, e.n) && !findProp(c, e.n).mods.has('static'))) fail(`CS0120: An object reference is required for the non-static field, method, or property '${c.name}.${e.n}'`);
        }
        fail(`CS0103: The name '${e.n}' does not exist in the current context`);
      }
      // falls through
      case 'member': {
        if (e.e.k === 'name' || e.e.k === 'member') {
          const c = typeRef(e.e);
          if (c && !(c.isEnum) && !(e.e.k === 'name' && lookupVar(e.e.n))) {
            const s = findStatic(c, e.n);
            if (s) return staticPlace(s.cls, s.s, e.n);
          }
        }
        const obj = rval(e.e);
        if (obj === null) { if (e.cond) return { get: () => null, set: () => {}, type: null }; nre(); }
        if (obj instanceof CObj) return memberPlace(obj, e.n, e, false);
        return { get: () => lib.getProp(obj, e.n, e), set: v => lib.setProp(obj, e.n, v, e), type: null, d: srcOf(e) };
      }
      case 'index': {
        const c = rval(e.e);
        if (c === null) { if (e.cond) return { get: () => null, set: () => {}, type: null }; nre(); }
        const ks = e.args.map(a => a.e);
        if (c instanceof CArr) {
          if (c.dims) {
            const ix = ks.map(x => Number(intOf(rval(x))));
            if (ix.length !== c.dims.length) fail(`CS0022: Wrong number of indices inside []; expected ${c.dims.length}`);
            if (ix.some((x, j) => x < 0 || x >= c.dims[j])) throwCs('IndexOutOfRangeException');
            const at = ix.reduce((acc, x, j) => acc * c.dims[j] + x, 0);
            return { get: () => c.a[at], set: v => { c.a[at] = v; }, type: c.et, d: srcOf(e), arr: c, at };
          }
          if (ks.length !== 1) fail(`CS0022: Wrong number of indices inside []; expected 1`);
          const kv = rval(ks[0]);
          if (kv && kv.range) return { get: () => lib.slice(c, kv), set: () => fail('CS0131: a range of an array cannot be assigned to'), type: null };
          const k = kv && kv.fromEnd ? c.a.length - kv.n : Number(intOf(kv));
          const check = () => { if (k < 0 || k >= c.a.length) throwCs('IndexOutOfRangeException'); };
          return { get: () => { check(); return c.a[k]; }, set: v => { check(); c.a[k] = v; }, type: c.et, d: srcOf(e), arr: c, at: k };
        }
        if (typeof c === 'string') {
          const kv = rval(ks[0]);
          if (kv && kv.range) return { get: () => lib.slice(c, kv), set: () => {}, type: null };
          const k = kv && kv.fromEnd ? c.length - kv.n : Number(intOf(kv));
          return { get: () => { if (k < 0 || k >= c.length) throwCs('IndexOutOfRangeException'); return CH(c.charCodeAt(k)); }, set: () => fail(`CS0200: Property or indexer 'string.this[int]' cannot be assigned to -- it is read only`), type: { k: 't', n: 'char' } };
        }
        if (c instanceof CObj) {
          const ix = findIndexer(c.cls);
          if (!ix) fail(`CS0021: Cannot apply indexing with [] to an expression of type '${c.cls.name}'`);
          const argv = ks.map(x => rval(x));
          return { get: () => callAccessor(ix, c, 'get', argv), set: v => callAccessor(ix, c, 'set', argv, v), type: ix.type };
        }
        const argv = ks.map(x => rval(x));
        return { get: () => lib.getIndex(c, argv, e), set: v => lib.setIndex(c, argv, v, e), type: lib.elemType(c), d: srcOf(e), coll: c, key: argv[0] };
      }
      case 'paren': return place(e.e);
      case 'this': return { get: () => frame().self, set: v => { const s = frame().self; if (!(s && s.cls.isStruct)) fail('CS1604: Cannot assign to \'this\' because it is read-only'); for (const [k, x] of v.f) s.f.set(k, x); }, type: null };
    }
    fail('CS0131: The left-hand side of an assignment must be a variable, property or indexer');
  }
  function findIndexer(c) { for (let x = c; x; x = x.base) if (x.indexer) return x.indexer; return null; }
  function staticPlace(cls, s, name) {
    return { get: () => staticGet(cls, s), set: v => { if (s.prop && !s.prop.auto) { callAccessor(s.prop, null, 'set', [], v); return; } if (s.mods.has('const')) fail(`CS0131: The left-hand side of an assignment must be a variable, property or indexer (${name} is a const)`); s.v = v; }, type: s.type, d: name, isStatic: true };
  }
  /** Does the object have a field, property or method of that name? */
  const memberOfObj = (o, n) => o instanceof CObj && (o.f.has(n) || !!findProp(o.cls, n) || !!findMethod(o.cls, n));
  function memberPlace(obj, n, e, implicitThis) {
    const p = findProp(obj.cls, n);
    if (p && !p.auto) return { get: () => callAccessor(p, obj, 'get'), set: v => callAccessor(p, obj, 'set', [], v), type: p.type, d: n };
    if (obj.f.has(n)) {
      const fdecl = fieldDecl(obj.cls, n);
      return {
        get: () => obj.f.get(n),
        set: v => {
          if (fdecl && fdecl.mods && fdecl.mods.has('readonly') && !inCtorOf(obj)) fail(`CS0191: A readonly field cannot be assigned to (except in a constructor or init-only setter of the type in which the field is defined or a variable initializer)`);
          if (p && p.set && p.set.init && !inCtorOf(obj) && !initing.has(obj)) fail(`CS8852: Init-only property or indexer '${obj.cls.name}.${n}' can only be assigned in an object initializer, or on 'this' or 'base' in an instance constructor or an 'init' accessor.`);
          if (p && !p.set && !inCtorOf(obj)) fail(`CS0200: Property or indexer '${obj.cls.name}.${n}' cannot be assigned to -- it is read only`);
          obj.f.set(n, v);
        },
        type: fdecl ? fdecl.type : p ? p.type : null, d: (implicitThis ? '' : srcOf(e.e) + '.') + n, obj, field: n,
      };
    }
    if (findMethod(obj.cls, n)) return { get: () => methodGroup(obj, obj.cls, n), set: () => fail(`CS1656: Cannot assign to '${n}' because it is a 'method group'`), type: null };
    if (obj.cls.isException || isExc(obj.cls)) {
      if (n === 'Message' || n === 'ParamName' || n === 'InnerException') return { get: () => obj.f.get(n) ?? null, set: () => fail(`CS0200: Property or indexer 'Exception.${n}' cannot be assigned to -- it is read only`), type: null };
      if (n === 'StackTrace') return { get: () => '   at ' + (stack.at(-1) || { name: 'Main' }).name + '()', set: () => {}, type: null };
    }
    return { get: () => lib.objProp(obj, n, e) ?? fail(`CS1061: '${obj.cls.name}' does not contain a definition for '${n}'`), set: () => fail(`CS1061: '${obj.cls.name}' does not contain a definition for '${n}'`), type: null };
  }
  const fieldDecl = (c, n) => { for (let x = c; x; x = x.base) { const f = (x.fields || []).find(ff => ff.name === n); if (f) return f; } return null; };
  const initing = new Set();                        // objects inside their object initializer (init-only properties may be set)
  const inCtorOf = o => frames.some(f => f.ctorOf === o);
  /** a method used as a value: obj.Method or Class.Method (a delegate) */
  function methodGroup(obj, cls, n) {
    const ms = overloads(cls, n);
    return new CFn({ name: n, group: ms, self: obj, native: (argv, e) => invoke(pick(ms, argv, n, cls), argv, obj, e) });
  }
  /** calls a property's get (or set, with value) */
  function callAccessor(p, obj, which, argv = [], value) {
    const acc = p[which];
    if (!acc) fail(which === 'get' ? `CS0154: The property or indexer '${p.name}' cannot be used in this context because it lacks the get accessor` : `CS0200: Property or indexer '${p.cls.name}.${p.name || 'this[]'}' cannot be assigned to -- it is read only`);
    const params = p.params || [];
    const fn = new CFn({ name: (which === 'get' ? 'get_' : 'set_') + (p.name || 'Item'), params: which === 'set' ? [...params, { name: 'value', type: p.type }] : params,
      ret: which === 'get' ? p.type : { k: 't', n: 'void', args: [] }, body: acc.body, expr: acc.expr, cls: p.cls, isStatic: p.mods.has('static'), tps: [], line: acc.line || p.line, accessor: true });
    return invoke(fn, which === 'set' ? [...argv, value] : argv, obj, null);
  }

  /* ---- expressions ---- */
  const srcOf = e => {
    switch (e.k) {
      case 'name': return e.n;
      case 'member': return srcOf(e.e) + '.' + e.n;
      case 'index': return srcOf(e.e) + '[' + e.args.map(a => srcOf(a.e)).join(', ') + ']';
      case 'call': return srcOf(e.f) + '(…)';
      case 'lit': return e.kind === 'string' ? JSON.stringify(e.v) : e.kind === 'char' ? "'" + e.v + "'" : String(e.v);
      case 'this': return 'this';
      case 'typeName': return e.n;
      case 'paren': return '(' + srcOf(e.e) + ')';
      default: return 'expression';
    }
  };
  /** A type that a name or a.b names (a class, an enum, a library type), or null */
  function typeRef(e) {
    if (e.k === 'typeName') return { lib: e.n };
    const dotted = x => (x.k === 'name' ? x.n : x.k === 'member' ? (() => { const a = dotted(x.e); return a && a + '.' + x.n; })() : null);
    if (e.k === 'member') {                           // System.Console, System.Collections.Generic.List
      const d = dotted(e);
      if (d && /^System\./.test(d) && !lookupVar('System')) { const rest = d.replace(/^System\.(Collections\.Generic\.|Text\.|Linq\.|IO\.)?/, ''); if (!rest.includes('.')) return typeRef({ k: 'name', n: rest }); }
    }
    const n = e.k === 'name' ? e.n : e.k === 'member' && (e.e.k === 'name' || e.e.k === 'member') ? (() => { const outer = typeRef(e.e); if (outer && outer.nested && outer.nested.has(e.n)) return { found: outer.nested.get(e.n) }; return null; })() : null;
    if (n && n.found) return n.found;
    if (typeof n !== 'string') return null;
    if (lookupVar(n)) return null;
    const self = frame() && frame().self;
    if (self && self instanceof CObj && memberOfObj(self, n)) return null;
    for (const c of staticScopes()) if (c.statics && c.statics.has(n)) return null;
    return findClass(n) || findEnum(n) || (lib.knowsType(n) ? { lib: n } : null);
  }
  /** a value for a place of type t: new(), [1, 2] and { 1, 2 } take their type from it */
  function rvalT(e, t) {
    if (e.k === 'new' && !e.type) { if (!t) fail('CS8754: There is no target type for new() here (write the type: new T(…))'); return newObj({ ...e, type: t }); }
    if (e.k === 'collExpr') return collExpr(e, t);
    if (e.k === 'arrInit') { if (!t || t.n !== 'array') fail('CS0622: Can only use array initializer expressions to assign to array types (write new[] { … })'); return arrayFromInit(t, e); }
    return rval(e);
  }
  function rval(e) {
    const v = eval1(e);
    if (v === UNSET) fail(`CS0165: Use of unassigned local variable '${srcOf(e)}'`);
    if (v === VOID) fail(`CS0029: Cannot implicitly convert type 'void' to a value (${srcOf(e)} returns nothing)`);
    return v;
  }
  const VOID = Symbol('void');
  function eval1(e) {
    switch (e.k) {
      case 'lit':
        switch (e.kind) {
          case 'int': case 'uint': return Number(e.v);
          case 'long': case 'ulong': return BigInt(e.v);
          case 'double': return new D(e.v);
          case 'float': return new D(e.v, true);
          case 'char': return CH(e.v.charCodeAt(0));
          default: return e.v;
        }
      case 'const': return e.v;
      case 'pcParam': return frame().pcArgs.get(e.name);
      case 'interp': return e.parts.map(p => (typeof p === 'string' ? p : lib.formatHole(rval(p.e), p.fmt, p.align ? Number(intOf(rval(p.align))) : 0))).join('');
      case 'paren': return eval1(e.e);
      case 'name': {
        const r = lookupVar(e.n);
        if (r) return r.ref ? r.ref.get() : r.v;
        const self = frame() && frame().self;
        if (self instanceof CObj && memberOfObj(self, e.n)) return memberPlace(self, e.n, e, true).get();
        for (const c of staticScopes()) {
          const s = c.statics && c.statics.get(e.n);
          if (s) return staticGet(c, s);
          if (c.methods && c.methods.has(e.n)) return methodGroup(null, c, e.n);
        }
        const lf = localFn(e.n);
        if (lf) return lf;
        const t = typeRef(e);
        if (t) fail(`CS0119: '${e.n}' is a type, which is not valid in the given context`);
        return place(e).get();
      }
      case 'typeName': fail(`CS0119: '${e.n}' is a type, which is not valid in the given context`);
      // falls through
      case 'member': {
        if (e.e.k === 'name' || e.e.k === 'member' || e.e.k === 'typeName') {
          const t = typeRef(e.e);
          if (t) {
            if (t.isEnum) { const v = t.vals.get(e.n); if (!v || e.n.startsWith('#')) fail(`CS0117: '${t.name}' does not contain a definition for '${e.n}'`); return v; }
            if (t.lib) return lib.staticMember(t.lib, e.n, e);
            const s = findStatic(t, e.n);
            if (s) return staticGet(s.cls, s.s);
            if (findMethod(t, e.n)) return methodGroup(null, t, e.n);
            if (t.nested && t.nested.has(e.n)) fail(`CS0119: '${e.n}' is a type, which is not valid in the given context`);
            fail(`CS0117: '${t.name}' does not contain a definition for '${e.n}'`);
          }
        }
        const obj = rval(e.e);
        const nullable = staticNullable(e.e);
        if (nullable && (e.n === 'HasValue' || e.n === 'Value')) {        // int? x: x.HasValue, x.Value
          if (e.n === 'HasValue') return obj !== null;
          if (obj === null) throwCs('InvalidOperationException', 'Nullable object must have a value.');
          return obj;
        }
        if (obj === null) { if (e.cond) return null; nre(); }
        if (obj instanceof CObj) return memberPlace(obj, e.n, e, false).get();
        if (obj instanceof Tup) return tupItem(obj, e.n);
        if (obj instanceof CFn && e.n === 'Invoke') return obj;
        return lib.getProp(obj, e.n, e);
      }
      case 'index': return place(e).get();
      case 'fromEnd': return { fromEnd: true, n: Number(intOf(rval(e.e))) };
      case 'range': return { range: true, a: e.a ? rval(e.a) : null, b: e.b ? rval(e.b) : null };
      case 'this': { const s = frame().self; if (s === undefined || s === null) fail("CS0026: Keyword 'this' is not valid in a static property, static method, or static field initializer"); return s; }
      case 'base': fail("CS0175: Use of keyword 'base' is not valid in this context");
      // falls through
      case 'un': {
        const v = rval(e.e);
        switch (e.op) {
          case '!': if (typeof v !== 'boolean') fail(`CS0023: Operator '!' cannot be applied to operand of type '${csType(v)}'`); return !v;
          case '-': return arith('-', 0, v, { l: { k: 'lit' }, r: e.e }, true);
          case '+': if (v instanceof Ch) return v.c; return v;
          case '~': if (typeof v === 'number') return ~v; if (typeof v === 'bigint') return BigInt.asIntN(64, ~v); if (v instanceof Ch) return ~v.c; fail(`CS0023: Operator '~' cannot be applied to operand of type '${csType(v)}'`);
        }
        break;
      }
      case 'bin': return binop(e.op, rval(e.l), rval(e.r), e);
      case 'logic': {
        const a = rval(e.l);
        if (typeof a !== 'boolean') fail(`CS0019: Operator '${e.op}' cannot be applied to operands of type '${csType(a)}'`);
        if (e.op === '&&' ? !a : a) return a;
        const b = rval(e.r);
        if (typeof b !== 'boolean') fail(`CS0019: Operator '${e.op}' cannot be applied to operands of type 'bool' and '${csType(b)}'`);
        return b;
      }
      case 'coalesce': { const a = eval1(e.a); return a !== null && a !== undefined ? a : rval(e.b); }
      case 'cond': {
        const c = rval(e.c);
        if (typeof c !== 'boolean') fail(`CS0029: Cannot implicitly convert type '${csType(c)}' to 'bool'`);
        const a = c ? rval(e.a) : rval(e.b);
        return a;
      }
      case 'assign': return assign(e);
      case 'incdec': {
        const p = place(e.e), old = p.get();
        if (!isNumKind(kindOf(old)) && !(old instanceof EnumV)) fail(`CS0023: Operator '${e.op}' cannot be applied to operand of type '${csType(old)}'`);
        let nv;
        if (old instanceof EnumV) nv = enumVal(old.e, old.v + (e.op === '++' ? 1 : -1));
        else if (old instanceof Ch) nv = CH((old.c + (e.op === '++' ? 1 : -1)) & 0xffff);
        else nv = arith(e.op === '++' ? '+' : '-', old, 1, { l: e.e, r: { k: 'lit' } });
        if (p.type && INTS[p.type.n] && typeof nv === 'number') nv = wrap(nv, p.type.n);
        p.set(nv);
        return e.prefix ? nv : old;
      }
      case 'call': return call(e);
      case 'new': return newObj(e);
      case 'newArr': return newArr(e);
      case 'collExpr': return collExpr(e, null);
      case 'tuple': {                                  // (a: 1, b), and (x, p.Y) names its items x and Y, as C# infers them
        const names = e.items.map(x => x.name || (x.e.k === 'name' ? x.e.n : x.e.k === 'member' ? x.e.n : null));
        return new Tup(e.items.map(x => copy(rval(x.e))), names.some(Boolean) ? names : null);
      }
      case 'lambda': return lambda(e);
      case 'cast': {
        const fromObj = e.e.k === 'name' && lookupVar(e.e.n) && lookupVar(e.e.n).t && ['object', 'dynamic'].includes(lookupVar(e.e.n).t.n);
        const v = rval(e.e);
        if (v instanceof D && INTS[e.type.n] && e.e.k === 'lit' && !checkedOn) { /* a constant that does not fit is CS0221 in C# */ const r = Math.trunc(v.v); if (!fits(r, e.type.n === 'char' ? 'char' : e.type.n)) fail(`CS0221: Constant value '${csDouble(v.v)}' cannot be converted to a '${e.type.n}' (use 'unchecked' syntax to override)`); }
        if (INTS[e.type.n] && (typeof v === 'number' || typeof v === 'bigint') && isConst(e.e) && !fits(v, e.type.n)) fail(`CS0221: Constant value '${v}' cannot be converted to a '${e.type.n}' (use 'unchecked' syntax to override)`);
        return cast(v, e.type, fromObj);
      }
      case 'is': return matches(rval(e.e), e.pat, true);
      case 'as': { const v = rval(e.e); return isInstance(v, e.type) ? v : null; }
      case 'switchExpr': {
        const v = rval(e.e);
        for (const arm of e.arms) {
          const r = scoped(() => (matches(v, arm.pat, true) && (!arm.when || rval(arm.when) === true) ? { v: rval(arm.e) } : null));
          if (r) return r.v;
        }
        throwCs('SwitchExpressionException', `Non-exhaustive switch expression failed to match its input.\nUnmatched value was ${lib.toStr(v)}.`);
      }
      // falls through
      case 'throwExpr': throwValue(rval(e.e));
      // falls through
      case 'typeof': return new TypeObj(typeText(e.type), netOfType(e.type));
      case 'default': return e.type ? zero(e.type) : null;
      case 'nameof': return e.e.k === 'member' ? e.e.n : srcOf(e.e);
      case 'checkedExpr': { const was = checkedOn; checkedOn = e.on; try { return rval(e.e); } finally { checkedOn = was; } }
      case 'with': {
        const v = rval(e.e);
        if (!(v instanceof CObj) || !(v.cls.record || v.cls.isStruct)) fail(`CS8858: The receiver type '${csType(v)}' is not a valid record type and is not a struct type.`);
        const o = new CObj(v.cls);
        for (const [k, x] of v.f) o.f.set(k, copy(x));
        initing.add(o);
        try { for (const it of e.inits) memberPlace(o, it.name, it, false).set(conv(rval(it.e), (fieldDecl(o.cls, it.name) || {}).type, it.e)); } finally { initing.delete(o); }
        return o;
      }
      case 'outVar': fail('CS8185: A declaration is not allowed in this context');
      // falls through
      case 'deconstructAssign': return deconstructAssign(e);
      case 'arrInit': fail('CS0623: Array initializers can only be used in a variable or field initializer (write new[] { … })');
      // falls through
      case 'init': fail('CS1525: an initializer { … } needs new T');
    }
    fail('cannot evaluate ' + e.k);
  }
  /** Was this expression declared nullable (int? x)? */
  const staticNullable = e => { if (e.k === 'name') { const r = lookupVar(e.n); return !!(r && r.t && r.t.nul && ['int', 'long', 'double', 'float', 'char', 'bool', 'short', 'byte', 'uint', 'ulong'].includes(r.t.n)); } return false; };
  function tupItem(t, n) {
    const m = /^Item(\d+)$/.exec(n);
    if (m && +m[1] >= 1 && +m[1] <= t.a.length) return t.a[+m[1] - 1];
    if (t.names) { const k = t.names.indexOf(n); if (k >= 0) return t.a[k]; }
    fail(`CS1061: '${csType(t)}' does not contain a definition for '${n}'`);
  }
  function localFn(n) {
    const f = frame();
    if (!f) return null;
    for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].get('fn ' + n); if (r) return r.v; }
    for (const sc of f.env || []) { const r = sc.get('fn ' + n); if (r) return r.v; }
    return null;
  }

  /* ---- arithmetic: C#'s numeric promotion (char → int, int → long → float → double), int wraps at 32 bits ---- */
  function arith(op, a, b, e, unaryMinus = false) {
    if (a instanceof EnumV || b instanceof EnumV) {
      if (op === '+' && a instanceof EnumV && !(b instanceof EnumV)) return enumVal(a.e, a.v + Number(intOf(b)));
      if (op === '-' && a instanceof EnumV && !(b instanceof EnumV)) return enumVal(a.e, a.v - Number(intOf(b)));
      if (op === '-' && a instanceof EnumV && b instanceof EnumV) return a.v - b.v;
      if (op === '+' && b instanceof EnumV && !(a instanceof EnumV)) return enumVal(b.e, b.v + Number(intOf(a)));
      if ('&|^'.includes(op) && a instanceof EnumV && b instanceof EnumV) return enumVal(a.e, op === '&' ? a.v & b.v : op === '|' ? a.v | b.v : a.v ^ b.v);
    }
    const ka = kindOf(a), kb = kindOf(b);
    if (!isNumKind(ka) || !isNumKind(kb)) fail(unaryMinus ? `CS0023: Operator '-' cannot be applied to operand of type '${csType(b)}'` : `CS0019: Operator '${op}' cannot be applied to operands of type '${csType(a)}' and '${csType(b)}'`);
    if (ka === 'double' || kb === 'double' || ka === 'float' || kb === 'float') {
      const f = (ka === 'float' || ka !== 'double') && (kb === 'float' || kb !== 'double');
      const x = numOf(a), y = numOf(b);
      let r;
      switch (op) { case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break; case '%': r = x % y; break;
        default: fail(`CS0019: Operator '${op}' cannot be applied to operands of type '${csType(a)}' and '${csType(b)}'`); }
      return new D(r, f);
    }
    if (ka === 'long' || kb === 'long') {
      const x = BigInt(intOf(a)), y = BigInt(intOf(b));
      if ((op === '/' || op === '%') && y === 0n) throwCs('DivideByZeroException');
      let r;
      switch (op) { case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break; case '%': r = x % y; break;
        case '&': r = x & y; break; case '|': r = x | y; break; case '^': r = x ^ y; break; }
      if (r === undefined) fail(`CS0019: Operator '${op}' cannot be applied to operands of type 'long'`);
      const w = BigInt.asIntN(64, r);
      if (checkedOn && w !== r) throwCs('OverflowException');
      return w;
    }
    const x = Number(intOf(a)), y = Number(intOf(b));
    if ((op === '/' || op === '%') && y === 0) throwCs('DivideByZeroException');
    let r;
    switch (op) {
      case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; if (!Number.isSafeInteger(r)) r = Number(BigInt.asIntN(32, BigInt(x) * BigInt(y))) + (checkedOn ? Infinity : 0); break;
      case '/': if (x === -2147483648 && y === -1) { if (checkedOn) throwCs('OverflowException'); return x; } r = Math.trunc(x / y); break;
      case '%': r = x % y; if (Object.is(r, -0)) r = 0; break;
      case '&': return x & y; case '|': return x | y; case '^': return x ^ y;
    }
    const w = r | 0;
    if (checkedOn && w !== r) throwCs('OverflowException');
    return w;
  }
  function binop(op, a, b, e) {
    if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return toStr(a) + toStr(b);
    if (op === '==' || op === '!=') { const eq = opEqual(a, b, e); return op === '==' ? eq : !eq; }
    // the program's own operators: operator +(Vec a, Vec b)
    const user = (a instanceof CObj && a.cls.ops && a.cls.ops.get(op)) || (b instanceof CObj && b.cls.ops && b.cls.ops.get(op));
    if (user) return invoke(pick(user, [a, b], 'operator ' + op), [a, b], null, e);
    if (['<', '>', '<=', '>='].includes(op)) {
      if (a instanceof EnumV && b instanceof EnumV) { const x = a.v, y = b.v; return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y; }
      const ka = kindOf(a), kb = kindOf(b);
      if (a === null || b === null) return false;   // a null int? compares false
      if (!isNumKind(ka) || !isNumKind(kb)) fail(`CS0019: Operator '${op}' cannot be applied to operands of type '${csType(a)}' and '${csType(b)}'`);
      if (ka === 'long' || kb === 'long') { if (!(ka === 'double' || kb === 'double' || ka === 'float' || kb === 'float')) { const x = BigInt(intOf(a)), y = BigInt(intOf(b)); return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y; } }
      const x = numOf(a), y = numOf(b);
      return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
    }
    if ((op === '&' || op === '|' || op === '^') && typeof a === 'boolean' && typeof b === 'boolean') return op === '&' ? a && b : op === '|' ? a || b : a !== b;
    if (op === '<<' || op === '>>' || op === '>>>') {
      const n = Number(intOf(b));
      if (typeof a === 'bigint') { const s = BigInt(n & 63); return op === '<<' ? BigInt.asIntN(64, a << s) : op === '>>' ? a >> s : BigInt.asIntN(64, BigInt.asUintN(64, a) >> s); }
      const x = Number(intOf(a)), s = n & 31;
      return op === '<<' ? x << s : op === '>>' ? x >> s : (x >>> s) | 0;
    }
    if (a === null || b === null) { if (isNumKind(kindOf(a)) || isNumKind(kindOf(b))) return null; nre(); }
    return arith(op, a, b, e);
  }
  /** == in C#: numbers by value, strings by value, records and tuples field by field, objects by reference */
  function opEqual(a, b, e) {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    const ka = kindOf(a), kb = kindOf(b);
    if (isNumKind(ka) && isNumKind(kb)) { if ((ka === 'long' || kb === 'long') && ka !== 'double' && kb !== 'double' && ka !== 'float' && kb !== 'float') return BigInt(intOf(a)) === BigInt(intOf(b)); return numOf(a) === numOf(b); }
    if (ka !== kb && ka !== 'ref' && kb !== 'ref') fail(`CS0019: Operator '==' cannot be applied to operands of type '${csType(a)}' and '${csType(b)}'`);
    if (a instanceof EnumV && b instanceof EnumV) return a.v === b.v;
    if (a instanceof Tup && b instanceof Tup) return a.a.length === b.a.length && a.a.every((x, j) => opEqual(x, b.a[j], e));
    if (a instanceof CObj) {
      const user = a.cls.ops && a.cls.ops.get('==');
      if (user) return invoke(pick(user, [a, b], 'operator =='), [a, b], null, e) === true;
      if (a.cls.record) return equals(a, b);
      if (a.cls.isStruct) fail(`CS0019: Operator '==' cannot be applied to operands of type '${a.cls.name}' and '${csType(b)}'`);
    }
    return a === b;
  }
  /** Equals: the program's override, else by value for records, structs and tuples, by reference for objects */
  function equals(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    if (a instanceof CObj) {
      const m = findUserMethod(a.cls, 'Equals', 1);
      if (m) return invoke(m, [b], a, null) === true;
      if (a.cls.record || a.cls.isStruct) return b instanceof CObj && b.cls === a.cls && [...a.f].every(([k, x]) => equals(x, b.f.get(k)));
      return a === b;
    }
    if (a instanceof Tup) return b instanceof Tup && a.a.length === b.a.length && a.a.every((x, j) => equals(x, b.a[j]));
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) return false;
    if (a instanceof D) return a.v === b.v || (Number.isNaN(a.v) && Number.isNaN(b.v));
    if (a instanceof EnumV) return b instanceof EnumV && a.e === b.e && a.v === b.v;
    return lib.libEquals(a, b);
  }
  /** a key for a hash table: equal values give equal keys (the program's GetHashCode and Equals are used if it has them) */
  function hashKey(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return 'i' + v;
    if (typeof v === 'bigint') return 'i' + v;
    if (v instanceof D) return 'd' + (v.v === 0 ? 0 : v.v);
    if (v instanceof Ch) return 'c' + v.c;
    if (typeof v === 'string') return 's' + v;
    if (typeof v === 'boolean') return 'b' + v;
    if (v instanceof EnumV) return 'e' + v.e.name + v.v;
    if (v instanceof Tup) return 't(' + v.a.map(hashKey).join(',') + ')';
    if (v instanceof CObj) {
      const h = findUserMethod(v.cls, 'GetHashCode', 0);
      if (h) return { userHash: String(invoke(h, [], v, null)), obj: v };
      if (v.cls.record || v.cls.isStruct) return 'r' + v.cls.full + '{' + [...v.f.values()].map(hashKey).join(',') + '}';
      return 'o' + idOf(v);
    }
    return lib.hashKey(v) || 'o' + idOf(v);
  }
  const findUserMethod = (c, name, n) => { for (let x = c; x; x = x.base) for (const m of (x.methods && x.methods.get(name)) || []) if (m.params.length === n && (m.body || m.expr)) return m; return null; };
  /** Comparer<T>.Default: numbers, strings (culture-aware, as .NET compares them), chars, the program's CompareTo */
  function compare(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    if (a instanceof CObj) {
      const m = findUserMethod(a.cls, 'CompareTo', 1);
      if (!m) throwCs('InvalidOperationException', 'Failed to compare two elements in the array.');
      return Number(intOf(invoke(m, [b], a, null)));
    }
    if (a instanceof Tup && b instanceof Tup) { for (let j = 0; j < a.a.length; j++) { const c = compare(a.a[j], b.a[j]); if (c) return c; } return 0; }
    return lib.compareDefault(a, b);
  }
  /** ToString(): the program's override, records and exceptions as .NET writes them, else the type's name */
  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof CObj) {
      const m = findUserMethod(v.cls, 'ToString', 0);
      if (m) { const r = invoke(m, [], v, null); return r === null ? '' : String(r); }
      if (v.cls.record) {                              // Person { Name = Ada, Age = 36, IsAdult = True }: every public field and property
        const parts = [];
        const walk = c => {
          if (c.base && c.base.record) walk(c.base);
          for (const f of c.fields) if (f.mods && f.mods.has('public') && !f.mods.has('static')) parts.push(f.name);
          for (const [n, p] of c.props) if (!p.auto && p.mods.has('public') && !p.mods.has('static') && p.get) parts.push(n);
        };
        walk(v.cls);
        const body = parts.map(n => n + ' = ' + toStr(v.f.has(n) ? v.f.get(n) : memberPlace(v, n, {}, false).get())).join(', ');
        return v.cls.name + (body ? ' { ' + body + ' }' : ' { }');
      }
      if (isExc(v.cls)) return v.cls.full + ': ' + v.f.get('Message');
      return v.cls.full;
    }
    if (v instanceof EnumV) return v.e.byVal.has(v.v) ? v.e.byVal.get(v.v) : String(v.v);
    if (v instanceof Tup) return '(' + v.a.map(toStr).join(', ') + ')';
    if (v instanceof CArr) return netType(v);
    if (v instanceof TypeObj) return v.full;
    if (v instanceof CFn) return netType(v);
    return lib.toStr(v);
  }

  /* ---- calls ---- */
  /** picks the overload that fits the arguments best (C#'s rules, simplified: count, then exact types, then conversions) */
  function pick(ms, argv, name, cls, named) {
    const ok = ms.filter(m => { const n = m.params.length, req = m.params.filter(p => !p.def && p.mod !== 'params').length; return argv.length >= req && (argv.length <= n || (m.params.at(-1) && m.params.at(-1).mod === 'params')); });
    if (!ok.length) {
      if (!ms.length) fail(`CS0103: The name '${name}' does not exist in the current context`);
      fail(ms.length === 1 ? `CS7036: There is no argument given that corresponds to the required parameter (${name} takes ${ms[0].params.length} argument${ms[0].params.length === 1 ? '' : 's'}, not ${argv.length})` : `CS1501: No overload for method '${name}' takes ${argv.length} arguments`);
    }
    if (ok.length === 1) return ok[0];
    const score = m => m.params.reduce((s, p, j) => {
      if (j >= argv.length || !p.type) return s;
      const v = argv[j], k = kindOf(v), n = p.type.n;
      if (n === k || (v instanceof CObj && isInstance(v, p.type))) return s + 3;
      if (isNumKind(k) && (n === 'double' || n === 'long' || n === 'float') && k !== 'double') return s + 2;
      if (n === 'object' || /^[A-Z]$/.test(n) || (m.tps || []).includes(n)) return s + 1;
      if (v === null && !INTS[n] && n !== 'double' && n !== 'bool') return s + 1;
      return s - 10;
    }, 0);
    return ok.reduce((best, m) => (score(m) > score(best) ? m : best));
  }
  const deferOrEval = x => ((x.k === 'new' && !x.type) || x.k === 'collExpr' ? new Deferred(x) : rval(x));
  /** argument values (out and ref arguments become places) */
  function argVals(args) {
    const vals = [], refs = [];
    for (const a of args) {
      if (a.mod === 'out' || a.mod === 'ref') {
        if (a.e.k === 'outVar') {
          const r = a.e.name === '_' ? { v: null } : declare(a.e.name, UNSET, a.e.type, { assigned: false });
          refs.push({ get: () => r.v, set: v => { r.v = v; }, type: a.e.type, cell: r, outVar: r });
          vals.push(UNSET);
        } else { const p = place(a.e); refs.push(p); vals.push(a.mod === 'ref' ? p.get() : UNSET); }
      } else { refs.push(null); vals.push(deferOrEval(a.e)); }
    }
    return { vals, refs };
  }
  function call(e) {
    const f = e.f;
    // a method of the library or of a class: Math.Max(…), Console.WriteLine(…), list.Add(…), obj.Method(…)
    if (f.k === 'member') {
      const t = (f.e.k === 'name' || f.e.k === 'member' || f.e.k === 'typeName') ? typeRef(f.e) : null;
      if (t && t.lib) { const { vals, refs } = argVals(e.args); return lib.callStatic(t.lib, f.n, vals, refs, e, f.targs); }
      if (t && t.isEnum) { const { vals } = argVals(e.args); return lib.enumStatic(t, f.n, vals, e); }
      if (t) {
        const ms = overloads(t, f.n);
        if (!ms.length) { if (isExc(t) && false) return null; fail(`CS0117: '${t.name}' does not contain a definition for '${f.n}'`); }
        const { vals, refs } = argVals(e.args);
        const m = pick(ms, vals, f.n, t);
        if (!m.isStatic) fail(`CS0120: An object reference is required for the non-static field, method, or property '${t.name}.${f.n}'`);
        return invoke(m, vals, null, e, refs);
      }
      if (f.e.k === 'base') {
        const self = frame().self, cls = frame().fn.cls.base;
        const { vals, refs } = argVals(e.args);
        if (!cls || cls.builtin) return lib.objectMethod(self, f.n, vals, e, toStr, equals, hashKey, true);
        const ms = overloads(cls, f.n);
        if (!ms.length) return lib.objectMethod(self, f.n, vals, e, toStr, equals, hashKey, true);
        return invoke(pick(ms, vals, f.n, cls), vals, self, e, refs);
      }
      const obj = rval(f.e);
      if (obj === null && staticNullable(f.e) && f.n === 'GetValueOrDefault') { const { vals } = argVals(e.args); return vals.length ? vals[0] : zero({ ...lookupVar(f.e.n).t, nul: false }); }
      if (obj === null || obj === undefined) { if (f.cond) return null; nre(); }
      if (obj instanceof CObj) {
        const fieldFn = obj.f.has(f.n) ? obj.f.get(f.n) : findProp(obj.cls, f.n) ? memberPlace(obj, f.n, f, false).get() : undefined;
        if (fieldFn !== undefined) { if (!(fieldFn instanceof CFn)) fail(`CS1955: Non-invocable member '${obj.cls.name}.${f.n}' cannot be used like a method.`); const { vals, refs } = argVals(e.args); return callFn(fieldFn, vals, e, refs); }
        const ms = overloads(obj.cls, f.n);
        const { vals, refs } = argVals(e.args);
        if (ms.length) { const m = pick(ms, vals, f.n, obj.cls); return invoke(virt(obj, m), vals, m.isStatic ? null : obj, e, refs); }
        const ext = extension(f.n, obj);
        if (ext) return invoke(ext, [obj, ...vals], null, e, [null, ...refs]);
        return lib.objectMethod(obj, f.n, vals, e, toStr, equals, hashKey) ?? fail(`CS1061: '${obj.cls.name}' does not contain a definition for '${f.n}'`);
      }
      const { vals, refs } = argVals(e.args);
      if (obj instanceof CFn && f.n === 'Invoke') return callFn(obj, vals, e, refs);
      const ext = extension(f.n, obj);
      if (!ext) return lib.callMethod(obj, f.n, vals, refs, e, f.targs);
      try { return lib.callMethod(obj, f.n, vals, refs, e, f.targs); }      // the library's own method, else the program's extension method
      catch (err) { if (err instanceof CsError && /^CS1061/.test(err.message)) return invoke(ext, [obj, ...vals], null, e, [null, ...refs]); throw err; }
    }
    if (f.k === 'name') {
      const r = lookupVar(f.n);
      if (r) { const fn = r.ref ? r.ref.get() : r.v; if (fn === UNSET) fail(`CS0165: Use of unassigned local variable '${f.n}'`); if (!(fn instanceof CFn)) fail(`CS0149: Method name expected (${f.n} is a ${csType(fn)})`); const { vals, refs } = argVals(e.args); return callFn(fn, vals, e, refs); }
      const lf = localFn(f.n);
      if (lf) { const { vals, refs } = argVals(e.args); return callFn(lf, vals, e, refs); }
      const self = frame() && frame().self;
      const cls = frame() && frame().fn && frame().fn.cls;
      for (let c = cls; c; c = c.outer) {
        const ms = overloads(c, f.n);
        if (ms.length) {
          const { vals, refs } = argVals(e.args);
          const m = pick(ms, vals, f.n, c);
          if (!m.isStatic && !(self instanceof CObj)) fail(`CS0120: An object reference is required for the non-static field, method, or property '${c.name}.${f.n}'`);
          return invoke(m.isStatic ? m : virt(self, m), vals, m.isStatic ? null : self, e, refs);
        }
        if (self instanceof CObj && (self.f.has(f.n) || findProp(c, f.n))) { const fn = memberPlace(self, f.n, f, true).get(); const { vals, refs } = argVals(e.args); return callFn(fn, vals, e, refs); }
      }
      for (const c of staticScopes()) { const s = c.statics && c.statics.get(f.n); if (s) { const fn = staticGet(c, s); const { vals, refs } = argVals(e.args); return callFn(fn, vals, e, refs); } }
      if (self instanceof CObj && ['ToString', 'GetType', 'Equals', 'GetHashCode', 'MemberwiseClone'].includes(f.n)) { const { vals } = argVals(e.args); return lib.objectMethod(self, f.n, vals, e, toStr, equals, hashKey); }
      const us = lib.usingStatic(f.n);
      if (us) { const { vals, refs } = argVals(e.args); return lib.callStatic(us, f.n, vals, refs, e); }
      fail(`CS0103: The name '${f.n}' does not exist in the current context`);
    }
    const fn = rval(f);
    if (!(fn instanceof CFn)) fail(`CS0149: Method name expected`);
    const { vals, refs } = argVals(e.args);
    return callFn(fn, vals, e, refs);
  }
  /** the override of m in obj's class (virtual dispatch) */
  function virt(obj, m) {
    if (!(obj instanceof CObj) || m.isStatic) return m;
    for (let c = obj.cls; c; c = c.base) for (const x of (c.methods && c.methods.get(m.name)) || []) if (x.params.length === m.params.length && x.params.every((p, j) => typeText(p.type) === typeText(m.params[j].type)) && (x.body || x.expr)) return x;
    return m;
  }
  /** an extension method: static T M(this X x, …) in a static class */
  function extension(name, obj) {
    for (const c of new Set(classes.values())) if (c.isStatic && c.methods && c.methods.has(name)) { const m = c.methods.get(name).find(x => x.ext); if (m && (!m.params[0].type || isInstance(obj, m.params[0].type) || /^[A-Z]$/.test(m.params[0].type.n) || lib.isCollType(m.params[0].type.n) || m.params[0].type.n === 'IEnumerable')) return m; }
    return null;
  }
  /** calls a delegate (a lambda, a method group, a library function) */
  function callFn(fn, argv, e, refs) {
    if (fn === null || fn === undefined) nre();
    if (!(fn instanceof CFn)) fail(`CS0149: Method name expected`);
    if (fn.native) return fn.native(argv, e, refs);
    return invoke(fn, argv, fn.self || null, e, refs);
  }
  /** Runs a method, lambda or accessor: binds the parameters (out/ref ones to the caller's places), runs the body */
  function invoke(fn, argv, self, e, refs = []) {
    if (fn.native) return fn.native(argv, e, refs);
    if (fn.isAbstract) fail(`CS0120: '${fn.name}' has no body`);
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls (the stack would overflow: Stack overflow.).');
    const ps = fn.params, scope = new Map();
    const variadic = ps.length && ps.at(-1).mod === 'params';
    if (!variadic && argv.length > ps.length) fail(`CS1501: No overload for method '${fn.name}' takes ${argv.length} arguments`);
    ps.forEach((p, k) => {
      if (p.mod === 'params') {
        const rest = argv.slice(k);
        const v = rest.length === 1 && rest[0] instanceof CArr ? rest[0] : new CArr(p.type.of, rest.map(x => conv(x, p.type.of)));
        scope.set(p.name, { v, t: p.type, name: p.name });
        return;
      }
      if (k >= argv.length) {
        if (!p.def) fail(`CS7036: There is no argument given that corresponds to the required parameter '${p.name}' of '${fn.name}'`);
        scope.set(p.name, { v: conv(rval(p.def), p.type, p.def), t: p.type, name: p.name });
        return;
      }
      if (p.mod === 'out' || p.mod === 'ref' || p.mod === 'in') {
        const ref = refs[k];
        if (!ref && p.mod !== 'in') fail(`CS1620: Argument ${k + 1} must be passed with the '${p.mod}' keyword`);
        if (ref) { scope.set(p.name, { v: p.mod === 'out' ? UNSET : ref.get(), t: p.type, name: p.name, ref: p.mod === 'out' ? outRef(ref) : ref, out: p.mod === 'out' }); return; }
      } else if (refs[k]) fail(`CS1615: Argument ${k + 1} may not be passed with the '${refs[k].outVar ? 'out' : 'ref'}' keyword`);
      const ast = e && e.args && e.args[k] ? e.args[k].e : null;
      let v;
      try { v = conv(argv[k], p.type, ast); }
      catch (err) { if (err instanceof CsError && /^CS0(029|266)/.test(err.message)) fail(`CS1503: Argument ${k + 1}: cannot convert from '${csType(argv[k])}' to '${typeText(p.type)}'`); throw err; }
      scope.set(p.name, { v, t: p.type || (v !== null && v !== undefined ? { k: 't', n: kindOf(v) === 'ref' ? 'object' : kindOf(v) } : null), name: p.name });
    });
    const label = fn.lambda ? 'lambda' : fn.localFn ? fn.name : fn.accessor ? (fn.cls ? fn.cls.name + '.' : '') + fn.name : fn.ctor ? 'new ' + fn.cls.name : (fn.cls && !fn.cls.topLevel ? fn.cls.name + '.' : '') + fn.name;
    const fr = { name: label, scopes: [scope], env: fn.env, fn, self: fn.lambda || fn.localFn ? (fn.selfAt !== undefined ? fn.selfAt : self) : self, ctorOf: fn.ctor ? self : null, pcArgs: fn.pcArgs };
    const shown = ps.filter(p => scope.has(p.name) && !(fn.isMain && p.name === 'args')).map(p => p.name + '=' + brief(scope.get(p.name).ref && !scope.get(p.name).out ? scope.get(p.name).ref.get() : scope.get(p.name).v)).join(', ');
    const id = !fn.accessor || fn.body ? ++calls : 0;
    if (id) stack.push({ name: label, args: shown.slice(0, 70), id });
    else fr.noStack = true;
    frames.push(fr);
    try {
      let r;
      if (fn.expr) { if (fn.exprStep !== false) step(fn.exprLine || fn.expr.line || fn.line); r = { k: 'return', v: fn.ret && fn.ret.n === 'void' ? (eval1(fn.expr), undefined) : rval(fn.expr) }; }
      else if (fn.body) r = runBody(fn.body);
      for (const [n, rr] of scope) if (rr.out && !rr.assigned) fail(`CS0177: The out parameter '${n}' must be assigned to before control leaves the current method`);
      if (fn.ret && fn.ret.n !== 'void' && !fn.lambda && !(r && r.k === 'return')) fail(`CS0161: '${label}': not all code paths return a value`);
      if (r && r.k === 'return') {
        if (fn.ret && fn.ret.n === 'void' && r.v !== undefined && !fn.lambda) fail(`CS0127: Since '${label}' returns void, a return keyword must not be followed by an object expression`);
        if (fn.ret && fn.ret.n !== 'void' && r.v === undefined && !fn.lambda) fail(`CS0126: An object of a type convertible to '${typeText(fn.ret)}' is required`);
        const out = fn.ret && !fn.lambda ? (fn.ret.n === 'void' ? undefined : conv(r.v, fn.ret, r.ast, 'return')) : r.v;
        if (id && out !== undefined) rets[id] = brief(out);
        return out;
      }
      return undefined;
    } finally {
      if (fn.isMain) finalVars = captureVars(fr);
      frames.pop();
      if (!fr.noStack) stack.pop();
    }
  }
  /** an out parameter writes to the caller's place */
  const outRef = ref => ({ get: () => ref.get(), set: v => { ref.set(v); ref.assigned = true; if (ref.outVar) ref.outVar.assigned = true; } });
  function runBody(b) {
    hoist(b.items);
    for (const s of b.items) { const r = exec(s); if (r) return r; }
    return undefined;
  }
  /** local functions can be called before their declaration */
  function hoist(items) {
    const scope = frame().scopes.at(-1);
    for (const s of items) if (s.k === 'localFn') {
      const m = s.fn, f = frame();
      const fn = new CFn({ name: m.name, params: m.params, ret: m.ret, body: m.body, expr: m.expr, exprLine: m.exprLine, cls: f.fn && f.fn.cls, localFn: true, isStatic: true,
        env: [...[...f.scopes].reverse(), ...(f.env || [])], selfAt: m.mods.has('static') ? null : f.self, line: m.line, tps: m.tps });
      checkReturns(fn, m.name);
      scope.set('fn ' + m.name, { v: fn, name: m.name, hidden: true });
    }
  }
  function lambda(e) {
    const f = frame();
    return new CFn({ name: 'lambda', params: e.params.map(p => ({ ...p, type: p.type })), body: e.body.k === 'block' ? e.body : null, expr: e.body.k === 'block' ? null : e.body,
      exprLine: e.body.line, exprStep: false, lambda: true, cls: f && f.fn && f.fn.cls, env: f ? [...[...f.scopes].reverse(), ...(f.env || [])] : [], selfAt: f ? f.self : null, ret: null });
  }
  /** new T(…) { … } */
  function newObj(e) {
    const t = e.type;
    if (!t) fail('CS8754: There is no target type for new() here (write the type: new T(…))');
    const c = findClass(t.n);
    const { vals, refs } = argVals(e.args);
    let o;
    if (c) {
      if (c.isAbstract) fail(`CS0144: Cannot create an instance of the abstract type or interface '${c.name}'`);
      if (c.isInterface) fail(`CS0144: Cannot create an instance of the abstract type or interface '${c.name}'`);
      if (c.isStatic) fail(`CS0712: Cannot create an instance of the static class '${c.name}'`);
      o = construct(c, vals, e, false, refs);
    } else if (findEnum(t.n)) o = enumVal(findEnum(t.n), 0);
    else if (t.n === 'tuple') o = zero(t);
    else o = lib.construct(t, vals, e);
    if (e.init) applyInit(o, e.init, t);
    return o;
  }
  function applyInit(o, init, t) {
    if (init.kind === 'obj' && o instanceof CObj) {
      initing.add(o);
      try {
        for (const it of init.items) {
          if (it.index) { const ix = findIndexer(o.cls); if (!ix) fail(`CS0021: Cannot apply indexing with [] to an expression of type '${o.cls.name}'`); callAccessor(ix, o, 'set', it.index.map(rval), rval(it.e)); continue; }
          const p = memberPlace(o, it.name, it, false);
          if (it.e.k === 'init') { applyInit(p.get(), it.e, p.type); continue; }
          p.set(conv(rvalT(it.e, p.type), p.type, it.e));
        }
      } finally { initing.delete(o); }
      return;
    }
    for (const it of init.items) {
      line = it.line || line;
      if (it.index) lib.setIndex(o, it.index.map(rval), rvalT(it.e, lib.elemType(o)), it);
      else if (it.add) lib.callMethod(o, 'Add', it.add.map(deferOrEval), [], it);
      else if (it.name) lib.setProp(o, it.name, rval(it.e), it);
    }
    void t;
  }
  /** Creates an object of a class: field initializers, then the base constructor, then the body (C#'s order) */
  function construct(c, argv, e, quiet = false, refs = []) {
    const o = new CObj(c);
    initObj(c, o, argv, e, refs, quiet);
    return o;
  }
  function initObj(c, o, argv, e, refs, quiet) {
    if (c.builtin) {                                   // Exception(message), ArgumentException(message, paramName)…
      const m = argv[0] !== undefined ? argv[0] : null;
      const def = newExc(c, typeof m === 'string' ? m : null, c.name.startsWith('Argument') && argv.length > 1 && typeof argv[1] === 'string' ? (c.name === 'ArgumentException' ? argv[1] : argv[0]) : null);
      if (c.name === 'ArgumentNullException' || c.name === 'ArgumentOutOfRangeException') { if (argv.length === 1) { o.f.set('Message', newExc(c, null, argv[0]).f.get('Message')); o.f.set('ParamName', argv[0]); } else if (argv.length >= 2) { o.f.set('Message', newExc(c, argv[1], argv[0]).f.get('Message')); o.f.set('ParamName', argv[0]); } else o.f.set('Message', def.f.get('Message')); }
      else for (const [k, v] of def.f) o.f.set(k, v);
      if (argv[1] instanceof CObj && isExc(argv[1].cls)) o.f.set('InnerException', argv[1]);
      return;
    }
    let ctor = null;
    if (c.isStruct && !argv.length && !c.ctors.some(x => !x.params.length)) { for (const f of c.fields) o.f.set(f.name, zero(f.type)); return; }   // default(S): every field zero
    if (c.ctors.length) ctor = pick(c.ctors.map(x => ({ ...x, params: x.params })), argv, c.name, c);
    else if (c.pc) { if (argv.length !== c.pc.length) fail(`CS7036: There is no argument given that corresponds to the required parameter '${(c.pc[argv.length] || c.pc[0]).name}' of '${c.name}(${c.pc.map(p => typeText(p.type) + ' ' + p.name).join(', ')})'`); }
    else if (argv.length && !c.isStruct) fail(`CS1729: '${c.name}' does not contain a constructor that takes ${argv.length} arguments`);
    else if (argv.length) fail(`CS1729: '${c.name}' does not contain a constructor that takes ${argv.length} arguments`);
    if (ctor && ctor.init && ctor.init.kind === 'this') {
      const { vals } = withSelf(o, ctor, argv, () => argVals(ctor.init.args));
      initObj(c, o, vals, e, [], quiet);
      runCtorBody(c, o, ctor, argv, refs, quiet);
      return;
    }
    // the fields: zero, then their initializers (with the primary constructor's parameters in scope)
    const pcArgs = new Map((c.pc || []).map((p, k) => [p.name, conv(argv[k], p.type)]));
    for (const f of c.fields) o.f.set(f.name, zero(f.type));
    for (const f of c.fields) if (f.init) { o.f.set(f.name, withSelf(o, { cls: c, params: [], pcArgs }, [], () => conv(rvalT(f.init, f.type), f.type, f.init))); }
    if (c.base) {
      let bargs = [];
      if (ctor && ctor.init && ctor.init.kind === 'base') bargs = withSelf(o, ctor, argv, () => argVals(ctor.init.args).vals);
      else if (c.decl && c.decl.baseArgs) bargs = withSelf(o, { cls: c, params: [], pcArgs }, [], () => argVals(c.decl.baseArgs).vals);
      initObj(c.base, o, bargs, e, [], quiet);
    }
    if (ctor) runCtorBody(c, o, ctor, argv, refs, quiet);
  }
  /** evaluates fn with this = o and the constructor's parameters in scope (for : base(…) and : this(…) arguments) */
  function withSelf(o, ctor, argv, fn) {
    const scope = new Map((ctor.params || []).map((p, k) => [p.name, { v: argv[k], t: p.type, name: p.name }]));
    frames.push({ name: 'new ' + (ctor.cls ? ctor.cls.name : ''), scopes: [scope], fn: { cls: ctor.cls, name: 'ctor' }, self: o, ctorOf: o, hidden: true, pcArgs: ctor.pcArgs });
    try { return fn(); } finally { frames.pop(); }
  }
  function runCtorBody(c, o, ctor, argv, refs) {
    const fn = new CFn({ name: '.ctor', params: ctor.params, ret: null, body: ctor.body, cls: c, ctor: true, line: ctor.line });
    invoke(fn, argv, o, null, refs);
  }
  /** new int[5], new int[2, 3], new int[] { … }, new[] { … }, new int[3][] */
  function newArr(e) {
    if (!e.dims) {
      const items = e.init.items;
      if (e.rank > 1) return arrayFromInit({ k: 't', n: 'array', of: e.type, rank: e.rank }, e.init);
      if (!e.type) { const vals = items.map(x => rval(x)); return new CArr(bestType(vals), vals.map(copy)); }
      return arrayFromInit({ k: 't', n: 'array', of: e.type, rank: 1 }, e.init);
    }
    const dims = e.dims.map(d => { const n = Number(intOf(rval(d))); if (n < 0) throwCs('OverflowException', 'Arithmetic operation resulted in an overflow.'); return n; });
    if (dims.reduce((a, b) => a * b, 1) > 1e6) fail('the array is too big for this page');
    if (dims.length > 1) {
      const a = new CArr(e.type, Array.from({ length: dims.reduce((x, y) => x * y, 1) }, () => zero(e.type)), dims);
      if (e.init) fillMulti(a, e.init);
      return a;
    }
    const a = new CArr(e.type, Array.from({ length: dims[0] }, () => zero(e.type)));
    if (e.init) { const items = e.init.items.map(x => conv(rval(x), e.type, x)); if (items.length !== dims[0]) fail(`CS0847: An array initializer of length '${dims[0]}' is expected`); a.a = items; }
    return a;
  }
  const bestType = vals => { const ks = new Set(vals.map(kindOf)); if (ks.size === 1) { const k = [...ks][0]; return k === 'ref' ? null : { k: 't', n: k }; } if ([...ks].every(isNumKind)) return { k: 't', n: ks.has('double') ? 'double' : ks.has('long') ? 'long' : 'int' }; return null; };
  /** { 1, 2, 3 } for an array of type t (rectangular for int[,]) */
  function arrayFromInit(t, init) {
    if (t.rank > 1) {
      const rows = init.items, dims = [rows.length, rows[0] ? rows[0].items.length : 0];
      const a = new CArr(t.of, [], dims);
      for (const r of rows) { if (r.k !== 'arrInit' || r.items.length !== dims[1]) fail('CS0847: An array initializer of length \'' + dims[1] + '\' is expected'); for (const x of r.items) a.a.push(conv(rval(x), t.of, x)); }
      return a;
    }
    return new CArr(t.of, init.items.map(x => (x.k === 'arrInit' ? arrayFromInit(t.of, x) : conv(rval(x), t.of, x))));
  }
  function fillMulti(a, init) { const flat = []; const walk = n => n.items.forEach(x => (x.k === 'arrInit' ? walk(x) : flat.push(conv(rval(x), a.et, x)))); walk(init); a.a = flat; }
  /** [1, 2, ..xs]: an array, a List… whatever the target type is */
  function collExpr(e, t) {
    const items = [];
    for (const it of e.items) { if (it.spread) items.push(...lib.iter(rval(it.spread))); else items.push(rval(it.e)); }
    if (!t) fail('CS9176: There is no target type for the collection expression (declare the variable\'s type: int[] a = [1, 2])');
    if (t.n === 'array') return new CArr(t.of, items.map(x => conv(x, t.of)));
    return lib.fromItems(t, items, conv);
  }
  function assign(e) {
    if (e.op === '=') {
      if (e.l.k === 'tuple') return deconstructAssign({ targets: e.l.items.map(x => x.e), rhs: e.r });
      if (e.l.k === 'index' && e.l.e.k === 'index') { /* a[i][j] = … */ }
      if (e.l.k === 'member' && e.l.e.k === 'index') {    // list[0].X = 1 on a struct: the list gives back a copy
        const c = rval(e.l.e.e);
        if (!(c instanceof CArr) && !(c instanceof CObj) && c !== null) { const v = place(e.l.e).get(); if (v instanceof CObj && v.cls.isStruct) fail(`CS1612: Cannot modify the return value of '${csType(c)}.this[int]' because it is not a variable`); }
      }
      const p = place(e.l);
      const v = rvalT(e.r, p.type);
      p.set(p.type ? conv(v, p.type, e.r) : copy(v));
      if (p.local) p.local.assigned = true;
      return v;
    }
    const p = place(e.l);
    if (e.op === '??=') { const cur = p.get(); if (cur !== null && cur !== undefined) return cur; const v = rval(e.r); p.set(p.type ? conv(v, p.type, e.r) : v); return v; }
    const cur = p.get();
    if (cur === UNSET) fail(`CS0165: Use of unassigned local variable '${srcOf(e.l)}'`);
    const r = rval(e.r);
    const op = e.op.slice(0, -1);
    let v = binop(op, cur, r, { l: e.l, r: e.r });
    if (cur instanceof Ch && typeof v === 'number') v = CH(v & 0xffff);
    if (p.type) v = conv(v, p.type, null, 'compound');
    else if (typeof cur === 'number' && typeof v !== 'number' && !(v instanceof D) && typeof v !== 'string') v = Number(v);
    p.set(v);
    return v;
  }
  /** (a, b) = (b, a) and var (x, y) = point */
  function deconstructAssign(e) {
    const v = rval(e.rhs);
    const parts = deconstruct(v, e.targets.length);
    const places = e.targets.map(t => (t.k === 'name' && t.n === '_' ? null : place(t)));
    places.forEach((p, k) => { if (p) p.set(p.type ? conv(parts[k], p.type) : copy(parts[k])); });
    return v;
  }
  function deconstruct(v, n) {
    if (v instanceof Tup) { if (v.a.length !== n) fail(`CS8132: Cannot deconstruct a tuple of '${v.a.length}' elements into '${n}' variables.`); return v.a; }
    if (v instanceof CObj) {
      const m = findUserMethod(v.cls, 'Deconstruct', n);
      if (m) { const cells = Array.from({ length: n }, () => ({ v: null })); invoke(m, cells.map(() => UNSET), v, null, cells.map(c => ({ get: () => c.v, set: x => { c.v = x; }, assigned: false }))); return cells.map(c => c.v); }
      if (v.cls.pc) return v.cls.pc.map(p => v.f.get(p.name));
    }
    const r = lib.deconstruct(v, n);
    if (r) return r;
    fail(`CS8129: No suitable 'Deconstruct' instance or extension method was found for type '${csType(v)}', with ${n} out parameters`);
  }

  /* ---- patterns ---- */
  /** does v match the pattern? (declares its variables in the current scope) */
  function matches(v, p, declareVars) {
    switch (p.k) {
      case 'discard': return true;
      case 'var': if (declareVars) declare(p.name, copy(v), v === null ? null : { k: 't', n: kindOf(v) === 'ref' ? 'object' : kindOf(v) }); return true;
      case 'varTuple': { const parts = deconstruct(v, p.items.length); p.items.forEach((x, k) => x.name && declare(x.name, parts[k], null)); return true; }
      case 'const': { const c = rval(p.e); return v !== null && c !== null ? (isNumKind(kindOf(v)) && isNumKind(kindOf(c)) ? numOf(v) === numOf(c) : equals(v, c)) : v === c; }
      case 'typeOrConst': {
        const t = typeRef(p.e) || (p.type.n.includes('.') ? null : findClass(p.type.n));
        if (t && !t.isEnum) return isInstance(v, p.type);
        if (PREDEF.has(p.type.n)) return isInstance(v, p.type);
        const c = rval(p.e);
        return equals(v, c) || (isNumKind(kindOf(v)) && isNumKind(kindOf(c)) && numOf(v) === numOf(c));
      }
      case 'type': { if (!isInstance(v, p.type)) return false; if (p.name && declareVars) declare(p.name, copy(v), p.type); return true; }
      case 'rel': { if (v === null) return false; const c = rval(p.e); return binop(p.op, v, c, { l: { k: 'lit' }, r: p.e }); }
      case 'not': return !matches(v, p.p, false);
      case 'and': return matches(v, p.a, declareVars) && matches(v, p.b, declareVars);
      case 'or': return matches(v, p.a, false) || matches(v, p.b, false);
      case 'pos': {
        if (p.type && !isInstance(v, p.type)) return false;
        if (v === null) return false;
        const parts = deconstruct(v, p.items.length);
        if (!p.items.every((x, k) => matches(parts[k], x, declareVars))) return false;
        if (p.name && declareVars) declare(p.name, v, p.type || null);
        return true;
      }
      case 'prop': {
        if (v === null || v === undefined) return false;
        if (p.type && !isInstance(v, p.type)) return false;
        for (const pp of p.props) {
          let x = v;
          for (const part of pp.name.split('.')) x = x instanceof CObj ? memberPlace(x, part, pp, false).get() : x instanceof Tup ? tupItem(x, part) : lib.getProp(x, part, pp);
          if (!matches(x, pp.pat, declareVars)) return false;
        }
        if (p.name && declareVars) declare(p.name, v, p.type || null);
        return true;
      }
    }
    fail('unknown pattern ' + p.k);
  }
  const PREDEF = new Set(['int', 'long', 'double', 'float', 'char', 'bool', 'string', 'object', 'short', 'byte', 'uint', 'ulong']);
  function throwValue(v) {
    if (v === null) nre();
    if (!(v instanceof CObj) || !isExc(v.cls)) fail(`CS0029: Cannot implicitly convert type '${csType(v)}' to 'System.Exception'`);
    throw new Thrown(v, line);
  }

  /* ---- statements ---- */
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  const execBlock = b => scoped(() => runBody(b));
  const loopBody = s => (s.k === 'block' ? execBlock(s) : scoped(() => exec(s)));
  function exec(s) {
    switch (s.k) {
      case 'block': return execBlock(s);
      case 'empty': return undefined;
      case 'expr': step(s.line); eval1(s.e); return undefined;
      case 'local': step(s.line); localDecl(s); return undefined;
      case 'deconstruct': {
        step(s.line);
        const v = rval(s.rhs);
        const bind = (names, val) => { const parts = deconstruct(val, names.length); names.forEach((n, k) => { if (n.nested) bind(n.nested, parts[k]); else if (n.name !== '_') declare(n.name, copy(parts[k]), null); }); };
        bind(s.targets, v);
        return undefined;
      }
      case 'localFn': return undefined;
      case 'if': {
        step(s.line);
        const c = rval(s.cond);
        if (typeof c !== 'boolean') fail(`CS0029: Cannot implicitly convert type '${csType(c)}' to 'bool'`);
        if (c) return loopBody(s.a);
        return s.b ? (s.b.k === 'if' ? exec(s.b) : loopBody(s.b)) : undefined;
      }
      case 'while':
        for (;;) {
          step(s.line);
          const r = scoped(() => {
            const c = rval(s.cond);
            if (typeof c !== 'boolean') fail(`CS0029: Cannot implicitly convert type '${csType(c)}' to 'bool'`);
            if (!c) return BREAK;
            return loopBody(s.body);
          });
          if (r === BREAK) return undefined;
          if (r && r !== CONTINUE) return r;
        }
      case 'do':
        for (;;) {
          step(s.line);
          const r = loopBody(s.body);
          if (r === BREAK) return undefined;
          if (r && r !== CONTINUE) return r;
          step(s.cond.line || s.line);
          const c = rval(s.cond);
          if (!c) return undefined;
        }
      case 'for':
        return scoped(() => {
          step(s.line);
          for (const x of s.init) { if (x.k === 'local') localDecl(x); else eval1(x.e); }
          for (let first = true; ; first = false) {
            if (!first) step(s.line);
            if (s.cond) { const c = rval(s.cond); if (typeof c !== 'boolean') fail(`CS0029: Cannot implicitly convert type '${csType(c)}' to 'bool'`); if (!c) return undefined; }
            const r = loopBody(s.body);
            if (r === BREAK) return undefined;
            if (r && r !== CONTINUE) return r;
            for (const x of s.step) eval1(x);
          }
        });
      case 'foreach': {
        step(s.line);
        const coll = rval(s.e);
        if (coll === null) nre();
        const it = lib.iterChecked(coll, s);
        for (const x of it) {
          const r = scoped(() => {
            if (s.names) { const bind = (names, val) => { const parts = deconstruct(val, names.length); names.forEach((n, k) => { if (n.nested) bind(n.nested, parts[k]); else if (n.name !== '_') declare(n.name, copy(parts[k]), null, { loopVar: true }); }); }; bind(s.names, x); }
            else declare(s.name, s.type ? conv(x, s.type, null, 'cast') : copy(x), s.type || (x === null ? null : { k: 't', n: kindOf(x) === 'ref' ? 'object' : kindOf(x) }), { loopVar: true });
            return loopBody(s.body);
          });
          if (r === BREAK) return undefined;
          if (r && r !== CONTINUE) return r;
          step(s.line);
        }
        return undefined;
      }
      case 'switch': return switchStmt(s);
      case 'break': step(s.line); return BREAK;
      case 'continue': step(s.line); return CONTINUE;
      case 'return': {
        step(s.line);
        const fr = frame();
        const want = fr.fn && fr.fn.ret;
        let v;
        if (s.e && s.e.k === 'collExpr') v = collExpr(s.e, want);
        else if (s.e && s.e.k === 'new' && !s.e.type) v = newObj({ ...s.e, type: want });
        else v = s.e ? rval(s.e) : undefined;
        return { k: 'return', v, ast: s.e };
      }
      case 'throw': {
        step(s.line);
        if (!s.e) { const c = frame().catching; if (!c) fail('CS0156: A throw statement with no arguments is not allowed outside of a catch clause'); throw new Thrown(c, line); }
        throwValue(rval(s.e));
      }
      // falls through
      case 'try': return tryStmt(s);
      case 'checked': { const was = checkedOn; checkedOn = s.on; try { return execBlock(s.body); } finally { checkedOn = was; } }
    }
    fail('cannot run ' + s.k);
  }
  function localDecl(s) {
    for (const v of s.vars) {
      line = v.line;
      let val;
      if (!v.init) { if (!s.type) fail("CS0818: Implicitly-typed variables must be initialized"); if (s.isConst) fail('CS0145: A const field requires a value to be provided'); declare(v.name, UNSET, s.type, { assigned: false }); continue; }
      if (v.init.k === 'arrInit') { if (!s.type || s.type.n !== 'array') fail('CS0820: Cannot initialize an implicitly-typed variable with an array initializer'); val = arrayFromInit(s.type, v.init); }
      else if (v.init.k === 'collExpr') val = collExpr(v.init, s.type);
      else if (v.init.k === 'new' && !v.init.type) { if (!s.type) fail('CS8754: There is no target type for \'new()\''); val = newObj({ ...v.init, type: s.type }); }
      else if (v.init.k === 'lambda' && !s.type) fail('CS8917: The delegate type could not be inferred (declare it: Func<int, int> f = x => …)');
      else {
        val = rval(v.init);
        if (val === null && !s.type) fail("CS0815: Cannot assign <null> to an implicitly-typed variable");
        if (val === undefined) fail(`CS0815: Cannot assign void to an implicitly-typed variable`);
      }
      if (s.isConst && !isConst(v.init)) fail(`CS0133: The expression being assigned to '${v.name}' must be constant`);
      const t = s.type || (val === null ? null : { k: 't', n: kindOf(val) === 'ref' ? (val instanceof CObj ? val.cls.name : 'object') : kindOf(val), inferred: true });
      if (val instanceof CFn && s.type) val.delegateType = netOfType(s.type);
      declare(v.name, s.type ? conv(val, s.type, v.init) : copy(val), t, { isConst: s.isConst });
    }
  }
  function switchStmt(s) {
    step(s.line);
    const v = rval(s.e);
    return scoped(() => {
      let start = -1;
      for (let k = 0; k < s.sections.length && start < 0; k++) {
        for (const lab of s.sections[k].labels) {
          if (!lab.pat) continue;
          if (matches(v, lab.pat, true) && (!lab.when || rval(lab.when) === true)) { start = k; break; }
        }
      }
      if (start < 0) start = s.sections.findIndex(sec => sec.labels.some(lb => !lb.pat));
      if (start < 0) return undefined;
      const sec = s.sections[start];
      for (const st of sec.body) {
        const r = exec(st);
        if (r === BREAK) return undefined;
        if (r) return r;
      }
      if (sec.body.length) { const lab = sec.labels.at(-1); const txt = lab.pat ? 'case ' + patText(lab.pat) + ':' : 'default:'; fail(start === s.sections.length - 1 ? `CS8070: Control cannot fall out of switch from final case label ('${txt}')` : `CS0163: Control cannot fall through from one case label ('${txt}') to another`, sec.line); }
      return undefined;
    });
  }
  const patText = p => (p.k === 'const' ? srcOf(p.e) : p.k === 'typeOrConst' ? srcOf(p.e) : p.k === 'type' ? typeText(p.type) + (p.name ? ' ' + p.name : '') : p.k === 'discard' ? '_' : '…');
  /** Can the end of this statement be reached? (C#'s "not all code paths return a value", CS0161) */
  function completes(s, sec = false) {
    if (!s) return true;
    switch (s.k) {
      case 'return': case 'throw': return false;
      case 'break': case 'continue': return !sec;
      case 'block': return s.items.every(x => completes(x, sec));
      case 'if': return !s.b || completes(s.a, sec) || completes(s.b, sec);
      case 'while': case 'for': { const forever = s.k === 'while' ? s.cond.k === 'lit' && s.cond.v === true : !s.cond; return !forever || breaks(s.body); }
      case 'do': return !(s.cond.k === 'lit' && s.cond.v === true) || breaks(s.body);
      case 'switch': return !s.sections.some(sec => sec.labels.some(l => !l.pat)) || s.sections.some(sec => sec.body.some(breaks) || !sec.body.length || completes({ k: 'block', items: sec.body }));
      case 'try': return (completes(s.body, sec) || s.catches.some(c => completes(c.body, sec))) && (!s.fin || completes(s.fin, sec));
      case 'checked': return completes(s.body, sec);
    }
    return true;
  }
  /** a break that leaves this loop (not one of an inner loop or switch) */
  function breaks(s) {
    if (!s) return false;
    switch (s.k) {
      case 'break': return true;
      case 'block': return s.items.some(breaks);
      case 'if': return breaks(s.a) || breaks(s.b);
      case 'try': return breaks(s.body) || s.catches.some(c => breaks(c.body)) || breaks(s.fin);
    }
    return false;
  }
  /** a switch section that runs on into the next one (CS0163), anywhere in this code */
  function checkSwitches(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(checkSwitches); return; }
    if (n.k === 'switch') n.sections.forEach((sec, k) => {
      if (sec.body.length && completes({ k: 'block', items: sec.body }, true)) {
        const lab = sec.labels.at(-1), txt = lab.pat ? 'case ' + patText(lab.pat) + ':' : 'default:';
        fail(k === n.sections.length - 1 ? `CS8070: Control cannot fall out of switch from final case label ('${txt}')` : `CS0163: Control cannot fall through from one case label ('${txt}') to another`, sec.line);
      }
    });
    if (n.k === 'lambda' || n.k === 'localFn') return;
    for (const [key, v] of Object.entries(n)) if (key !== 'line' && v && typeof v === 'object') checkSwitches(v);
  }
  function checkReturns(fn, label) {
    checkSwitches(fn.body);
    if (!fn.body || !fn.ret || fn.ret.n === 'void') return;
    if (completes(fn.body)) fail(`CS0161: '${label}(${fn.params.map(p => typeText(p.type)).join(', ')})': not all code paths return a value`, fn.line);
  }
  function tryStmt(s) {
    let result, pending = null;
    try { result = execBlock(s.body); }
    catch (err) {
      if (!(err instanceof Thrown)) { if (err instanceof RangeError) throw err; if (!s.fin) throw err; pending = err; }
      else {
        let handled = false;
        for (const c of s.catches) {
          const ok = scoped(() => {
            if (c.type && !isInstance(err.obj, c.type)) return null;
            if (c.name) declare(c.name, err.obj, c.type);
            if (c.when) { const w = rval(c.when); if (w !== true) return null; }
            const fr = frame(), was = fr.catching;
            fr.catching = err.obj;
            try { return { r: execBlock(c.body) }; } finally { fr.catching = was; }
          });
          if (ok) { handled = true; result = ok.r; break; }
        }
        if (!handled) pending = err;
      }
    }
    if (s.fin) {
      try { const r = execBlock(s.fin); if (r) { if (r.k === 'return') fail('CS0157: Control cannot leave the body of a finally clause'); } }
      catch (err2) { throw err2; }
    }
    if (pending) throw pending;
    return result;
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
      case 'int': case 'long': return P('num', String(v));
      case 'double': case 'float': return P('num', csDouble(v.v, v.f));
      case 'char': return P('char', lib.charLit(v.c));
      case 'bool': return P('bool', String(v));
      case 'string': return P('str', JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v));
    }
    if (v instanceof EnumV) return P('sym', toStr(v) === String(v.v) ? String(v.v) : v.e.name + '.' + toStr(v));
    if (v instanceof CFn) return { t: 'fn', s: v.name === 'lambda' ? 'lambda' : v.name };
    if (v instanceof TypeObj) return P('sym', v.full);
    if (v instanceof Tup && !v.names) {                // (1, 2): an array of its items, so pairs read as edges
      const id = idOf(v);
      return { t: 'arr', id, len: v.a.length, items: v.a.map(x => ser(x, ctx, depth + 1)), more: 0, tn: '(' + v.a.map(csType).join(', ') + ')' };
    }
    const id = idOf(v);
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    if (v instanceof Tup) return { t: 'obj', id, cls: csType(v), entries: v.a.map((x, j) => [v.names[j] || 'Item' + (j + 1), ser(x, ctx, depth + 1)]), more: 0 };
    if (v instanceof CArr) {
      if (v.dims && v.dims.length === 2) {          // int[2,3]: its rows
        const [r, c] = v.dims;
        const rows = Array.from({ length: Math.min(r, MAX_ITEMS) }, (_, k) => ({ t: 'arr', id: id * 1000 + k + 1, len: c, items: v.a.slice(k * c, k * c + Math.min(c, MAX_ITEMS)).map(x => ser(x, ctx, depth + 2)), more: Math.max(0, c - MAX_ITEMS), tn: 'row ' + k }));
        return { t: 'arr', id, len: r, items: rows, more: Math.max(0, r - MAX_ITEMS), tn: (v.et ? typeText(v.et) : 'object') + '[' + r + ',' + c + ']' };
      }
      const n = Math.min(v.a.length, MAX_ITEMS);
      return { t: 'arr', id, len: v.a.length, items: v.a.slice(0, n).map(x => ser(x, ctx, depth + 1)), more: v.a.length - n, tn: (v.et ? typeText(v.et) : 'object') + '[' + v.a.length + ']' };
    }
    if (v instanceof CObj) {
      const entries = [];
      for (const [k, x] of v.f) { const fd = fieldDecl(v.cls, k); if (fd && fd.pcHidden) { entries.push([k, ser(x, ctx, depth + 1)]); continue; } if (isExc(v.cls) && k !== 'Message' && x === null) continue; entries.push([k, ser(x, ctx, depth + 1)]); }
      return { t: 'obj', id, cls: v.cls.name, entries: entries.slice(0, 30), more: Math.max(0, entries.length - 30) };
    }
    return lib.ser(v, id, ctx, depth, ser);
  }
  /** one-line value for the call stack */
  function brief(v) {
    if (v === UNSET) return '?';
    const k = kindOf(v);
    if (k === 'string') return JSON.stringify(v.length > 14 ? v.slice(0, 14) + '…' : v);
    if (k === 'char') return lib.charLit(v.c);
    if (k === 'bool') return String(v);
    if (k !== 'ref' && k !== 'null') return toStrSafe(v);
    if (v === null) return 'null';
    if (v instanceof CArr) return csType(v).replace(/\[\]$/, '[' + v.a.length + ']');
    if (v instanceof CObj) return v.cls.name + '{…}';
    if (v instanceof EnumV) return toStrSafe(v);
    if (v instanceof CFn) return v.name;
    if (v instanceof Tup) return toStrSafe(v);
    return lib.brief(v);
  }
  const toStrSafe = v => { try { return toStr(v); } catch { return '?'; } };
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set() };
    const vars = [];
    if (f && !f.hidden) {
      const shown = new Map();
      const isTopFrame = f.fn && f.fn.isMain;
      for (const sc of f.scopes) for (const [n, r] of sc) if (!r.hidden && !(isTopFrame && n === 'args' && f.fn.mainArgs)) shown.set(n, { r, scope: 'local' });
      for (const sc of f.env || []) for (const [n, r] of sc) if (!r.hidden && !shown.has(n)) shown.set(n, { r, scope: f.fn && (f.fn.localFn || f.fn.lambda) && isTopEnv(sc) ? 'global' : 'local' });   // what a local function or lambda closes over
      if (f.self instanceof CObj && !(f.fn && f.fn.lambda)) vars.push({ name: 'this', scope: 'local', node: ser(f.self, ctx, 0) });
      for (const [n, { r, scope }] of shown) vars.push({ name: n, scope, node: ser(r.ref ? safeGet(r.ref) : r.v, ctx, 0) });
    }
    for (const c of new Set(classes.values())) {
      if (c.builtin) continue;
      for (const [n, s] of c.statics) if (!s.mods.has('const') && s.v !== UNSET && !(s.prop && !s.prop.auto)) vars.push({ name: n, scope: 'global', node: ser(s.v, ctx, 0) });
    }
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }
  const safeGet = ref => { try { return ref.get(); } catch { return UNSET; } };
  let topScope = null;
  const isTopEnv = sc => sc === topScope;

  /* ---- the library ---- */
  const lib = makeLib({
    D, Ch, CH, CObj, CArr, Tup, EnumV, CFn, TypeObj, Thrown, UNSET, fail, throwCs, nre, write, rval, conv, copy, zero, kindOf, csType, netType, netOfType, typeText,
    toStr, equals, hashKey, compare, callFn, intOf, numOf, isInstance, idOf, cast, deconstruct, line: () => line, enumVal,
    usings: () => prog.usings, findClass, invoke, findUserMethod,
  });

  /* ---- run: the classes, the static fields, then Main or the top-level statements ---- */
  let error = null;
  try {
    const declared = new Set();
    for (const d of prog.types) {
      if (declared.has(d.name)) fail(`CS0101: The namespace '<global namespace>' already contains a definition for '${d.name}'`, d.line);
      declared.add(d.name);
      if (d.k === 'enum') makeEnum(d, null); else makeClass(d, null);
    }
    for (const c of new Set(classes.values())) {        // base classes and interfaces
      if (c.builtin || !c.decl) continue;
      for (const b of c.decl.bases) {
        const bc = classes.get(b.n) || (c.outer ? nestedIn(c.outer, b.n) : null);
        if (bc && !bc.isInterface) { if (c.isStruct) fail(`CS0527: Type '${b.n}' in interface list is not an interface`, c.decl.line); if (c.base) fail(`CS1721: Class '${c.name}' cannot have multiple base classes: '${c.base.name}' and '${b.n}'`, c.decl.line); c.base = bc; }
        else c.ifaces.push(b);
      }
    }
    for (const c of new Set(classes.values())) {        // a class that does not implement its base's abstract methods
      if (c.builtin || c.isAbstract || c.isInterface || !c.base) continue;
      for (let b = c.base; b; b = b.base) for (const [n, ms] of b.methods || []) for (const m of ms) if (m.isAbstract && b.isAbstract) { const impl = virt(new CObj(c), m); if (impl === m) fail(`CS0534: '${c.name}' does not implement inherited abstract member '${b.name}.${n}(${m.params.map(p => typeText(p.type)).join(', ')})'`, c.decl.line); }
    }
    for (const u of prog.usings) if (!lib.knowsNamespace(u.n) && !u.stat) { /* an unknown namespace: like a missing assembly */ fail(`CS0246: The type or namespace name '${u.n.split('.')[0]}' could not be found (are you missing a using directive or an assembly reference?)`, u.line); }
    for (const c of new Set(classes.values())) if (!c.builtin) for (const st of c.statics.values()) if (!(st.prop && !st.prop.auto)) { line = st.line || line; staticGet(c, st); }   // the static fields, in order
    let main = null;
    if (prog.top.length) {
      const prg = { name: 'Program', full: 'Program', topLevel: true, fields: [], props: new Map(), methods: new Map(), ctors: [], statics: new Map(), ops: new Map(), nested: new Map(), ifaces: [], isStatic: true };
      main = new CFn({ name: 'Main', params: [], ret: null, body: { k: 'block', items: prog.top, line: prog.topLine }, cls: prg, isStatic: true, isMain: true, line: prog.topLine });
      for (const c of new Set(classes.values())) if (!c.builtin && c.methods.has('Main') && c.methods.get('Main')[0].isStatic) fail(`CS7022: The entry point of the program is global code; ignoring '${c.name}.Main(string[])' entry point.`.replace('CS7022', 'warning CS7022'), c.decl.line);
    } else {
      for (const c of new Set(classes.values())) if (!c.builtin && c.methods.has('Main')) { const m = c.methods.get('Main').find(x => x.isStatic); if (m) { if (main) fail(`CS0017: Program has more than one entry point defined.`, m.line); main = m; } }
      if (!main) throw Object.assign(new Error("CS5001: Program does not contain a static 'Main' method suitable for an entry point"), { noMain: true });
      main.isMain = true;
      main.mainArgs = true;
    }
    if (main.params.length) { const fn = main; const native = new CFn({ ...fn, isMain: true }); main = native; }
    const args = main.params.length ? [new CArr({ k: 't', n: 'string' }, [])] : [];
    if (prog.top.length) {
      // top-level code: its variables are what local functions (and lambdas) see
      frames.length = 0;
      const ret = invokeTop(main);
      void ret;
    } else invoke(main, args, null, null);
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof Thrown) error = { msg: `Unhandled exception. ${toStrSafe(e.obj)} (line ${e.line || line})` };
    else if (e instanceof CsError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e && e.exit !== undefined) error = e.exit === 0 ? null : { msg: `The program called Environment.Exit(${e.exit}).`, soft: true };
    else if (e && e.noMain) throw new Error(e.message);
    else if (e instanceof RangeError) error = { msg: `Error on line ${line}: Stack overflow (the program went too deep)` };
    else throw e;
  }
  if (outBuf) logs.push({ type: 'log', s: outBuf });
  if (!error || (error.soft && !stopped)) {
    const c = finalVars || captureVars(null);
    steps.push({ line: -1, stack: [], vars: c.vars, refs: c.refs, logs: logs.length });
  }
  return { steps, logs, error, rets };

  /** the top-level statements, run as Main (their scope is the one local functions close over) */
  function invokeTop(main) {
    stack.push({ name: 'Main', args: '', id: ++calls });
    const fr = { name: 'Main', scopes: [new Map()], fn: main, self: null };
    topScope = fr.scopes[0];
    frames.push(fr);
    checkSwitches(main.body.items.filter(x => x.k !== 'localFn'));
    try { runBody(main.body); }
    finally { finalVars = captureVars(fr); frames.pop(); stack.pop(); }
  }
}
