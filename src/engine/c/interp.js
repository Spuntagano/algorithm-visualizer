/**
 * The C interpreter and tracer: runs the tree from ./parse.js and records a snapshot before every statement (and before
 * each test of a loop), in the format of src/model.js.
 *
 * Memory is a set of blocks (a variable, a malloc'd block, a string literal), each a map from byte offset to the value
 * stored there with its type; a pointer is { block, offset }. So every access can be checked the way a sanitizer would:
 * out of bounds, NULL, use after free, a local that no longer exists, a value read before it was set. Ints up to 32 bits
 * are JavaScript numbers, 64-bit ones BigInts, so arithmetic wraps around like on the real machine.
 *
 * In the snapshots, a pointer to a struct (or to the start of an array or of a malloc'd block) is shown as that memory
 * itself, so linked structures become arrows and graphs; a pointer into the middle of an array is a { k: 'ptr' }
 * primitive that names its target (&a[2]) and tags that cell.
 */
import { parseC } from './parse.js';
import { format } from './printf.js';
import { T, arr, common, isAggregate, isArith, isCharT, isScalar, isWide, promote, ptr, sameType, structName, typeName } from './types.js';

const MAX_STEPS = 3000;   // stop runaway loops
const MAX_CALLS = 300;    // stop runaway recursion
const MAX_DEPTH = 5;      // how deeply nested values are expanded
const MAX_ITEMS = 60;     // array elements kept per array
const MAX_HEAP = 64 << 20;

class StopRun extends Error {}
class ExitRun extends Error {}
/** An error in the running program: reported as "Error on line N: …" */
class CError extends Error {}
const UNINIT = Symbol('uninitialized');

class Block {
  constructor(kind, size, type, name, addr) {
    Object.assign(this, { kind, size, type, name, addr, cells: new Map(), freed: false, dead: false, ro: false });
  }
}
class Ptr { constructor(b, o) { this.b = b; this.o = o; } }
class FnRef { constructor(name, def, builtin) { this.name = name; this.def = def; this.builtin = builtin; } }

const BREAK = { brk: true }, CONT = { cont: true };
const cellKind = t => (t.k === 'ptr' ? 'ptr' : t.k === 'flt' ? 'flt' : 'int');

/** Wraps an integer to the range of an integer type: 300 as unsigned char is 44. */
export function wrapInt(x, t) {
  if (t.bool) return (typeof x === 'bigint' ? x !== 0n : x !== 0) ? 1 : 0;
  if (t.size === 8) {
    const b = typeof x === 'bigint' ? x : BigInt(Number.isFinite(x) ? Math.trunc(x) : 0);
    return t.signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b);
  }
  const n = typeof x === 'bigint' ? Number(BigInt.asIntN(32, x)) : x;
  switch (t.size) {
    case 4: return t.signed ? n | 0 : n >>> 0;
    case 2: return t.signed ? (n << 16) >> 16 : n & 0xffff;
    default: return t.signed ? (n << 24) >> 24 : n & 0xff;
  }
}

const charLit = c => {
  const named = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 39: "\\'", 92: '\\\\' };
  if (named[c] != null) return "'" + named[c] + "'";
  return c >= 32 && c < 127 ? "'" + String.fromCharCode(c) + "'" : null;
};
/** How a double is shown in the views: 3.0, 0.1, 1e+20, inf, nan */
export function fmtFloat(v, t) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (t && t.size === 4) v = parseFloat(v.toPrecision(7));
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? v.toFixed(1) : String(v);
}

export function runCTrace(src) {
  const prog = parseC(src);
  const steps = [], logs = [], stack = [], frames = [];
  const globals = new Map(), funcs = new Map(), protos = new Map();
  let line = 0, stopped = null, outBuf = '', errBuf = '';
  let nextBlock = 1, heapUsed = 0, finalVars = null;
  const addrs = { global: 0x404000, heap: 0x5602a000, stack: 0x7ffd5000, literal: 0x402000 };
  const fail = msg => { throw new CError(msg); };

  /* ---- output ---- */
  const write = (s, err) => {
    if (err) { errBuf += s; let k; while ((k = errBuf.indexOf('\n')) >= 0) { logs.push({ type: 'error', s: errBuf.slice(0, k) }); errBuf = errBuf.slice(k + 1); } return; }
    outBuf += s;
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { logs.push({ type: 'log', s: outBuf.slice(0, k) }); outBuf = outBuf.slice(k + 1); }
  };

  /* ---- memory ---- */
  const alloc = (kind, size, type, name) => {
    const k = kind === 'temp' ? 'stack' : kind;
    let addr;
    if (k === 'stack') { addrs.stack -= Math.max(16, Math.ceil(size / 16) * 16); addr = addrs.stack; }
    else { addr = addrs[k]; addrs[k] += Math.max(16, Math.ceil(size / 16) * 16 + 16); }
    const b = new Block(kind, size, type, name, addr);
    b.id = nextBlock++;
    return b;
  };
  const elemCount = (b, t) => Math.floor(b.size / (t.size || 1));
  /** "arr has 5 elements (0 to 4)": what a block holds, for an out-of-bounds message */
  const holds = (b, t) => {
    if (b.type && b.type.k === 'arr') return `${b.name} has ${b.type.n} element${b.type.n === 1 ? '' : 's'}` + (b.type.n ? ` (indexes 0 to ${b.type.n - 1})` : '');
    if (b.kind === 'heap') { const n = elemCount(b, t); return `the block malloc gave on line ${b.line} holds ${b.size} bytes` + (t.size > 1 ? ` (${n} ${typeName(t)}${n === 1 ? '' : 's'}, indexes 0 to ${n - 1})` : ''); }
    return `${b.name} is ${b.size} bytes`;
  };
  function check(b, o, t, d, writing) {
    if (b.freed) fail(`${d} is in memory that was freed on line ${b.freedLine} (use after free)`);
    if (b.dead) fail(`${d} is in ${b.name}, a local variable of ${b.fn}() that no longer exists (that call has returned)`);
    if (o < 0 || o + t.size > b.size) fail(`${d} is out of bounds: ${holds(b, t)}`);
    if (writing && b.ro) fail(`${d} is inside a string literal, which cannot be changed (char s[] = "…" makes a copy that can)`);
  }
  /** The bytes of a stored value (for reading memory as another type, as memset and unions do). */
  const toBytes = c => {
    if (c.kind === 'byte') return [c.v];
    if (c.kind === 'ptr') return null;
    const dv = new DataView(new ArrayBuffer(8));
    if (c.kind === 'flt') { if (c.size === 4) dv.setFloat32(0, c.v, true); else dv.setFloat64(0, c.v, true); }
    else dv.setBigUint64(0, BigInt.asUintN(64, BigInt(c.v)), true);
    return [...new Uint8Array(dv.buffer, 0, c.size)];
  };
  /** The byte at offset o: a number, UNINIT, or null when it is part of a pointer */
  const byteAt = (b, o) => {
    for (let k = o; k > o - 16 && k >= 0; k--) {
      const c = b.cells.get(k);
      if (c && k + c.size > o) { const bytes = toBytes(c); return bytes ? bytes[o - k] : null; }
    }
    return UNINIT;
  };
  function load(b, o, t, d) {
    const c = b.cells.get(o);
    const kind = cellKind(t);
    if (c && c.size === t.size && c.kind === kind) return kind === 'int' && c.t !== t ? wrapInt(c.v, t) : c.v;
    if (c && c.kind === 'ptr') fail(`${d} holds a pointer, which cannot be read as ${typeName(t)}`);
    if (kind === 'ptr') {
      const bytes = []; for (let k = 0; k < 8; k++) bytes.push(byteAt(b, o + k));
      if (bytes.every(x => x === 0)) return null;
      if (bytes.some(x => x === UNINIT)) return UNINIT;
      fail(`${d} is read as a pointer, but bytes were stored there`);
    }
    const bytes = [];
    for (let k = 0; k < t.size; k++) { const x = byteAt(b, o + k); if (x === UNINIT) return UNINIT; if (x === null) fail(`${d} is part of a pointer, which cannot be read as ${typeName(t)}`); bytes.push(x); }
    const dv = new DataView(new Uint8Array(bytes.concat(Array(8 - bytes.length).fill(0))).buffer);
    if (kind === 'flt') return t.size === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
    return wrapInt(dv.getBigUint64(0, true), t);
  }
  /** Removes what was stored in [o, o + size); a value only partly inside it keeps its other bytes. */
  function clear(b, o, size) {
    for (let k = o - 15; k < o + size; k++) {
      const c = b.cells.get(k);
      if (!c || k + c.size <= o) continue;
      b.cells.delete(k);
      if (k < o || k + c.size > o + size) {
        const bytes = toBytes(c);
        if (bytes) bytes.forEach((x, j) => { const at = k + j; if (at < o || at >= o + size) b.cells.set(at, { kind: 'byte', size: 1, v: x }); });
      }
    }
  }
  function store(b, o, t, v, d) {
    check(b, o, t, d, true);
    clear(b, o, t.size);
    b.cells.set(o, { kind: cellKind(t), size: t.size, v, t });
  }
  const read = (lv) => {
    if (!lv.b) fail(`${lv.d} goes through a NULL pointer (a crash in C: segmentation fault)`);
    check(lv.b, lv.o, lv.t, lv.d, false);
    const v = load(lv.b, lv.o, lv.t, lv.d);
    if (v === UNINIT) fail(`${lv.d} is used before it is given a value` + (lv.b.kind === 'heap' ? ' (malloc does not clear memory: calloc does)' : ''));
    return v;
  };
  function copyMem(db, dof, sb, so, size, d) {
    if (size <= 0) return;
    check(sb, so, { size }, d, false); check(db, dof, { size }, d, true);
    const moved = [];
    for (let k = so - 15; k < so + size; k++) {
      const c = sb.cells.get(k);
      if (!c || k + c.size <= so) continue;
      if (k < so || k + c.size > so + size) { const bytes = toBytes(c); if (bytes) bytes.forEach((x, j) => { const at = k + j; if (at >= so && at < so + size) moved.push([at - so, { kind: 'byte', size: 1, v: x }]); }); }
      else moved.push([k - so, c]);
    }
    clear(db, dof, size);
    for (const [k, c] of moved) db.cells.set(dof + k, c);
  }
  const zeroOf = t => (t.k === 'ptr' ? null : t.k === 'flt' ? 0 : isWide(t) ? 0n : 0);
  function zeroFill(b, o, t) {
    if (t.k === 'arr') { for (let k = 0; k < t.n; k++) zeroFill(b, o + k * t.of.size, t.of); return; }
    if (t.k === 'struct') { if (t.union) { if (t.fields[0]) zeroFill(b, o, t.fields[0].type); } else t.fields.forEach(f => zeroFill(b, o + f.off, f.type)); return; }
    clear(b, o, t.size);
    b.cells.set(o, { kind: cellKind(t), size: t.size, v: zeroOf(t), t });
  }

  /* ---- values: { t, v } ---- */
  const val = (t, v) => ({ t, v });
  const addrOf = p => (p === null ? 0 : p instanceof FnRef ? 0x401000 : p.b.addr + p.o);
  function convert(x, t, d) {
    const f = x.t;
    if (t.k === 'void') return undefined;
    if (f.k === 'void') fail(`${d || 'this'} has no value: it comes from a function that returns void`);
    if (t.k === 'int') {
      if (f.k === 'flt') return t.bool ? +(x.v !== 0) : wrapInt(Number.isFinite(x.v) ? Math.trunc(x.v) : 0, t);
      if (f.k === 'ptr') return t.bool ? +(x.v !== null) : wrapInt(addrOf(x.v), t);
      if (f.k === 'struct') fail(`${d || 'a struct'} cannot be turned into ${typeName(t)}`);
      return wrapInt(x.v, t);
    }
    if (t.k === 'flt') {
      if (f.k === 'ptr' || f.k === 'struct') fail(`${d || 'this value'} is ${art(f)}, not a number`);
      const n = Number(x.v);
      return t.size === 4 ? Math.fround(n) : n;
    }
    if (t.k === 'ptr') {
      if (f.k === 'ptr') return x.v;
      if (f.k === 'int') { if (x.v == 0) return null; fail(`turning the number ${x.v} into a pointer is not supported (${d || 'here'})`); } // eslint-disable-line eqeqeq
      if (f.k === 'fn') return x.v;
      fail(`${d || 'this value'} is ${art(f)}, not a pointer`);
    }
    if (t.k === 'struct') {
      if (f !== t) fail(`${d || 'this value'} is ${art(f)}, not ${art(t)}`);
      return x.v;
    }
    fail('cannot convert to ' + typeName(t));
  }
  const art = t => { const n = typeName(t); return (/^[aeiou]/.test(n) ? 'an ' : 'a ') + n; };
  const truthy = x => {
    if (x.t.k === 'ptr' || x.t.k === 'fn') return x.v !== null;
    if (x.t.k === 'struct' || x.t.k === 'void') fail('a ' + (x.t.k === 'void' ? 'void value' : 'struct') + ' cannot be used as a condition');
    return typeof x.v === 'bigint' ? x.v !== 0n : x.v !== 0;
  };
  const ONE = val(T.int, 1);

  function arith(op, a, b, d) {
    if (a.t.k === 'ptr' || b.t.k === 'ptr') return ptrArith(op, a, b, d);
    if (!isArith(a.t) || !isArith(b.t)) fail(`${d}: ${op} needs numbers, not ${art(isArith(a.t) ? b.t : a.t)}`);
    if (op === '<<' || op === '>>') {
      const lt = promote(a.t);
      if (lt.k !== 'int' || b.t.k !== 'int') fail(`${d}: ${op} needs integers`);
      const x = convert(a, lt), n = Number(b.v);
      const bits = lt.size * 8;
      if (n < 0 || n >= bits) fail(`${d}: shifting a ${bits}-bit value by ${n} is undefined in C`);
      if (isWide(lt)) return val(lt, wrapInt(op === '<<' ? x << BigInt(n) : x >> BigInt(n), lt));
      return val(lt, op === '<<' ? wrapInt(x << n, lt) : lt.signed ? x >> n : x >>> n);
    }
    const ct = common(a.t, b.t);
    const x = convert(a, ct), y = convert(b, ct);
    const cmp = { '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y, '==': x == y, '!=': x != y }; // eslint-disable-line eqeqeq
    if (op in cmp) return val(T.int, cmp[op] ? 1 : 0);
    if (ct.k === 'flt') {
      let r;
      switch (op) {
        case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break;
        default: fail(`${d}: ${op} needs integers, not doubles` + (op === '%' ? ' (fmod() works for doubles)' : ''));
      }
      return val(ct, ct.size === 4 ? Math.fround(r) : r);
    }
    if ((op === '/' || op === '%') && (y === 0 || y === 0n)) fail(`${d}: division by zero`);
    if (isWide(ct)) {
      let r;
      switch (op) {
        case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = x * y; break; case '/': r = x / y; break;
        case '%': r = x % y; break; case '&': r = x & y; break; case '|': r = x | y; break; case '^': r = x ^ y; break;
      }
      return val(ct, wrapInt(r, ct));
    }
    let r;
    switch (op) {
      case '+': r = x + y; break; case '-': r = x - y; break; case '*': r = Math.imul(x, y); break;
      case '/': r = Math.trunc(x / y); break; case '%': r = x % y; break;
      case '&': r = x & y; break; case '|': r = x | y; break; case '^': r = x ^ y; break;
    }
    return val(ct, wrapInt(r, ct));
  }
  const pointeeSize = (t, d) => {
    if (t.to.k === 'void') return 1;
    if (t.to.k === 'fn') fail(`${d}: arithmetic on a function pointer`);
    if (t.to.k === 'struct' && !t.to.done) fail(`${d}: ${typeName(t.to)} is not defined, so its size is unknown`);
    return t.to.size;
  };
  function ptrAdd(p, n, d) {
    if (p.v === null) fail(`${d}: arithmetic on a NULL pointer`);
    return val(p.t, new Ptr(p.v.b, p.v.o + Number(n) * pointeeSize(p.t, d)));
  }
  function ptrArith(op, a, b, d) {
    const ap = a.t.k === 'ptr', bp = b.t.k === 'ptr';
    if (op === '+' && ap && b.t.k === 'int') return ptrAdd(a, b.v, d);
    if (op === '+' && bp && a.t.k === 'int') return ptrAdd(b, a.v, d);
    if (op === '-' && ap && b.t.k === 'int') return ptrAdd(a, typeof b.v === 'bigint' ? -b.v : -b.v, d);
    if (op === '-' && ap && bp) {
      if (a.v === null || b.v === null || a.v.b !== b.v.b) fail(`${d}: subtracting pointers into different blocks of memory`);
      return val(T.long, BigInt(Math.trunc((a.v.o - b.v.o) / pointeeSize(a.t, d))));
    }
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      const x = ap ? a.v : convert(a, ptr(T.void), d), y = bp ? b.v : convert(b, ptr(T.void), d);
      let r;
      if (op === '==' || op === '!=') { const same = x === y || (x instanceof Ptr && y instanceof Ptr && x.b === y.b && x.o === y.o); r = op === '==' ? same : !same; }
      else { const p = addrOf(x), q = addrOf(y); r = op === '<' ? p < q : op === '>' ? p > q : op === '<=' ? p <= q : p >= q; }
      return val(T.int, r ? 1 : 0);
    }
    fail(`${d}: ${op} cannot be used on a pointer`);
  }

  /* ---- names ---- */
  const frame = () => frames[frames.length - 1];
  function lookup(name) {
    const f = frame();
    if (f) for (let s = f.scopes.length - 1; s >= 0; s--) { const r = f.scopes[s].vars.get(name); if (r) return r; }
    return globals.get(name) || null;
  }

  /* ---- expressions ---- */
  /** C-like text of an expression, for messages: arr[i], p->next, *q */
  function text(e) {
    switch (e.k) {
      case 'id': return e.name;
      case 'num': return e.name || (e.chr ? charLit(e.v) || String(e.v) : String(e.v));
      case 'str': return clipStr('"' + new TextDecoder().decode(new Uint8Array(e.codes)).replace(/\n/g, '\\n') + '"');
      case 'index': return text(e.a) + '[' + text(e.i) + ']';
      case 'member': return text(e.e) + (e.arrow ? '->' : '.') + e.name;
      case 'deref': return '*' + text(e.e);
      case 'addr': return '&' + text(e.e);
      case 'call': return text(e.f) + '(…)';
      case 'post': return text(e.e) + e.op;
      case 'pre': return e.op + text(e.e);
      case 'cast': return '(' + typeName(e.t) + ')' + text(e.e);
      case 'un': return e.op + text(e.e);
      case 'bin': case 'and': case 'or': return text(e.l) + ' ' + e.op + ' ' + text(e.r);
      default: return 'the expression';
    }
  }
  const clipStr = s => (s.length > 24 ? s.slice(0, 22) + '…"' : s);

  /** The static type of an expression, without running it (for sizeof). */
  function typeOf(e) {
    switch (e.k) {
      case 'num': return e.t;
      case 'str': return arr(T.char, e.codes.length + 1);
      case 'id': { const r = lookup(e.name); if (r) return r.t; if (funcs.has(e.name) || protos.has(e.name)) return (funcs.get(e.name) || protos.get(e.name)).type; if (LIB[e.name]) return ptr(T.void); fail(`${e.name} is not declared`); }
      // falls through
      case 'index': { const a = decay(typeOf(e.a)), b = decay(typeOf(e.i)); const p = a.k === 'ptr' ? a : b; if (p.k !== 'ptr') fail(`${text(e)}: only arrays and pointers can be indexed`); return p.to; }
      case 'member': { let s = typeOf(e.e); if (e.arrow) s = decay(s).to; return field(s, e.name, e).type; }
      case 'deref': { const p = decay(typeOf(e.e)); if (p.k !== 'ptr') fail(`${text(e)}: only a pointer can be dereferenced with *`); return p.to; }
      case 'addr': return ptr(typeOf(e.e));
      case 'call': { const f = e.f.k === 'id' && !lookup(e.f.name) && (funcs.get(e.f.name) || protos.get(e.f.name)); if (f) return f.type.ret; if (e.f.k === 'id' && LIB[e.f.name]) return LIB[e.f.name].ret || T.int; const ft = decay(typeOf(e.f)); return (ft.to || ft).ret; }
      case 'cast': return e.t;
      case 'clit': return e.t;
      case 'sizeofT': case 'sizeofE': return T.ulong;
      case 'un': return e.op === '!' ? T.int : promote(typeOf(e.e));
      case 'and': case 'or': return T.int;
      case 'bin': {
        if (['<', '>', '<=', '>=', '==', '!='].includes(e.op)) return T.int;
        const a = decay(typeOf(e.l)), b = decay(typeOf(e.r));
        if (e.op === '-' && a.k === 'ptr' && b.k === 'ptr') return T.long;
        if (a.k === 'ptr') return a;
        if (b.k === 'ptr') return b;
        if (e.op === '<<' || e.op === '>>') return promote(a);
        return common(a, b);
      }
      case 'assign': case 'pre': case 'post': return typeOf(e.l || e.e);
      case 'cond': { const a = decay(typeOf(e.a)), b = decay(typeOf(e.b)); return isArith(a) && isArith(b) ? common(a, b) : a; }
      case 'comma': return typeOf(e.r);
      default: fail('cannot work out the type of ' + text(e));
    }
  }
  const decay = t => (t.k === 'arr' ? ptr(t.of) : t.k === 'fn' ? ptr(t) : t);
  function field(s, name, e) {
    if (s.k !== 'struct') fail(`${text(e)}: ${text(e.e)} is ${art(s)}, not a struct` + (s.k === 'ptr' && !e.arrow ? ` (use ${text(e.e)}->${name})` : ''));
    if (!s.done) fail(`${text(e)}: ${typeName(s)} is not defined`);
    const f = s.fields.find(x => x.name === name);
    if (!f) fail(`${typeName(s)} has no field named ${name}`);
    return f;
  }

  /** The place an expression names: { t, b, o, d } */
  function lval(e) {
    switch (e.k) {
      case 'id': {
        const r = lookup(e.name);
        if (r) return { t: r.t, b: r.b, o: 0, d: e.name };
        if (funcs.has(e.name) || protos.has(e.name) || LIB[e.name]) fail(`${e.name} is a function, not a variable`);
        fail(`${e.name} is not declared`);
      }
      // falls through
      case 'deref': {
        const p = rval(e.e);
        if (p.t.k !== 'ptr') fail(`${text(e)}: only a pointer can be dereferenced with *, and ${text(e.e)} is ${art(p.t)}`);
        if (p.v === null) fail(`${text(e)}: ${text(e.e)} is NULL (a crash in C: segmentation fault)`);
        if (p.v === UNINIT) fail(`${text(e.e)} is used before it is given a value`);
        return { t: p.t.to, b: p.v.b, o: p.v.o, d: text(e) };
      }
      case 'index': {
        let a = rval(e.a), i = rval(e.i);
        if (a.t.k !== 'ptr' && i.t.k === 'ptr') [a, i] = [i, a];
        if (a.t.k !== 'ptr') fail(`${text(e)}: ${text(e.a)} is ${art(a.t)}, which cannot be indexed`);
        if (i.t.k !== 'int') fail(`${text(e)}: an index must be an integer, not ${art(i.t)}`);
        if (a.v === null) fail(`${text(e)}: ${text(e.a)} is NULL (a crash in C: segmentation fault)`);
        const p = ptrAdd(a, i.v, text(e));
        const shown = e.i.k === 'num' ? text(e) : text(e.a) + '[' + text(e.i) + '] with ' + text(e.i) + ' = ' + i.v;
        return { t: a.t.to, b: p.v.b, o: p.v.o, d: e.i.k === 'num' ? shown : text(e.a) + '[' + i.v + ']', long: shown };
      }
      case 'member': {
        let base;
        if (e.arrow) {
          const p = rval(e.e);
          if (p.t.k !== 'ptr') fail(`${text(e)}: ${text(e.e)} is ${art(p.t)}, not a pointer` + (p.t.k === 'struct' ? ` (use ${text(e.e)}.${e.name})` : ''));
          if (p.v === null) fail(`${text(e)}: ${text(e.e)} is NULL (a crash in C: segmentation fault)`);
          base = { t: p.t.to, b: p.v.b, o: p.v.o };
        } else {
          const x = e.e.k === 'call' ? rval(e.e) : null;
          base = x ? { t: x.t, b: x.v.b, o: x.v.o } : lval(e.e);
        }
        const f = field(base.t, e.name, e);
        return { t: f.type, b: base.b, o: base.o + f.off, d: text(e) };
      }
      case 'str': { const b = literal(e); return { t: b.type, b, o: 0, d: text(e) }; }
      case 'clit': {
        const t = concrete(e.t, e.init);
        const b = alloc('stack', t.size, t, '(' + typeName(t) + '){…}');
        (scope().blocks).push(b);
        initialize(b, 0, t, e.init, '(' + typeName(t) + ')');
        return { t, b, o: 0, d: b.name };
      }
      case 'call': { const x = rval(e); if (x.t.k === 'struct') return { t: x.t, b: x.v.b, o: x.v.o, d: text(e) }; }
      // falls through
      default: fail(`${text(e)} is not a variable or a place in memory, so it cannot be assigned to or have its address taken`);
    }
  }
  /** The value at a place: an array becomes a pointer to its first element, a struct stays where it is. */
  function loadLv(lv) {
    if (lv.t.k === 'arr') return val(ptr(lv.t.of), new Ptr(lv.b, lv.o));
    if (lv.t.k === 'struct') { if (!lv.b) fail(`${lv.d} goes through a NULL pointer`); check(lv.b, lv.o, lv.t, lv.d, false); return val(lv.t, new Ptr(lv.b, lv.o)); }
    if (lv.t.k === 'fn') return val(ptr(lv.t), lv.fn);
    return val(lv.t, read(lv.long ? { ...lv, d: lv.long } : lv));
  }
  function literal(e) {
    if (!e.block) {
      const t = arr(T.char, e.codes.length + 1);
      const b = alloc('literal', t.size, t, text(e));
      e.codes.concat(0).forEach((c, k) => b.cells.set(k, { kind: 'int', size: 1, v: c > 127 ? c - 256 : c, t: T.char }));
      b.ro = true;
      e.block = b;
    }
    return e.block;
  }
  function assignTo(lv, x, d) {
    if (lv.t.k === 'arr') fail(`${d}: an array cannot be assigned to (copy it element by element, or with memcpy)`);
    if (lv.t.k === 'struct') {
      if (x.t !== lv.t) fail(`${d}: ${art(x.t)} cannot be stored in ${art(lv.t)}`);
      if (!lv.b) fail(`${lv.d} goes through a NULL pointer`);
      copyMem(lv.b, lv.o, x.v.b, x.v.o, lv.t.size, lv.d);
      return val(lv.t, new Ptr(lv.b, lv.o));
    }
    if (lv.t.k === 'ptr' && x.t.k !== 'ptr' && !(x.t.k === 'int' && x.v == 0) && x.t.k !== 'fn') fail(`${d}: ${art(x.t)} cannot be stored in the pointer ${lv.d}`); // eslint-disable-line eqeqeq
    if (lv.t.k !== 'ptr' && x.t.k === 'ptr' && !lv.t.bool) fail(`${d}: the pointer cannot be stored in ${lv.d}, which is ${art(lv.t)}`);
    const v = convert(x, lv.t, d);
    if (!lv.b) fail(`${lv.d} goes through a NULL pointer`);
    store(lv.b, lv.o, lv.t, v, lv.d);
    return val(lv.t, v);
  }

  function rval(e) {
    switch (e.k) {
      case 'num': return val(e.t, e.v);
      case 'str': return val(ptr(T.char), new Ptr(literal(e), 0));
      case 'id': {
        const r = lookup(e.name);
        if (r) return loadLv({ t: r.t, b: r.b, o: 0, d: e.name });
        const f = funcs.get(e.name) || protos.get(e.name);
        if (f) return val(ptr(f.type), new FnRef(e.name, funcs.get(e.name), null));
        if (LIB[e.name]) return val(ptr(T.void), new FnRef(e.name, null, LIB[e.name]));
        fail(`${e.name} is not declared`);
      }
      // falls through
      case 'index': case 'member': return loadLv(lval(e));
      case 'deref': {
        const p = rval(e.e);
        if (p.t.k === 'ptr' && p.t.to.k === 'fn') return p;       // (*f)(x) calls the function f points to
        if (p.t.k !== 'ptr') fail(`${text(e)}: only a pointer can be dereferenced with *, and ${text(e.e)} is ${art(p.t)}`);
        if (p.v === null) fail(`${text(e)}: ${text(e.e)} is NULL (a crash in C: segmentation fault)`);
        if (p.t.to.k === 'void') fail(`${text(e)}: a void * cannot be dereferenced (cast it first: *(int *)${text(e.e)})`);
        return loadLv({ t: p.t.to, b: p.v.b, o: p.v.o, d: text(e) });
      }
      case 'addr': {
        if (e.e.k === 'id' && !lookup(e.e.name) && (funcs.has(e.e.name) || protos.has(e.e.name))) return rval(e.e);
        if (e.e.k === 'deref') { const p = rval(e.e.e); return val(p.t, p.v); }
        const lv = lval(e.e);
        return val(ptr(lv.t), lv.b ? new Ptr(lv.b, lv.o) : null);
      }
      case 'assign': {
        const lv = lval(e.l);
        if (e.op === '=') return assignTo(lv, rval(e.r), e.text || text(e.l) + ' = …');
        const cur = loadLv(lv), r = rval(e.r);
        return assignTo(lv, arith(e.op.slice(0, -1), cur, r, e.text || text(e.l)), e.text || text(e.l));
      }
      case 'pre': case 'post': {
        const lv = lval(e.e), cur = loadLv(lv);
        if (!isScalar(cur.t)) fail(`${text(e)}: ${e.op} needs a number or a pointer`);
        const nv = assignTo(lv, arith(e.op === '++' ? '+' : '-', cur, ONE, text(e)), text(e));
        return e.k === 'pre' ? nv : cur;
      }
      case 'un': {
        const x = rval(e.e);
        if (e.op === '!') return val(T.int, truthy(x) ? 0 : 1);
        if (!isArith(x.t)) fail(`${text(e)}: ${e.op} needs a number, not ${art(x.t)}`);
        const t = promote(x.t), v = convert(x, t);
        if (e.op === '+') return val(t, v);
        if (e.op === '-') return val(t, t.k === 'flt' ? -v : wrapInt(-v, t));
        if (t.k !== 'int') fail(`${text(e)}: ~ needs an integer`);
        return val(t, wrapInt(~v, t));
      }
      case 'bin': return arith(e.op, rval(e.l), rval(e.r), text(e));
      case 'and': return val(T.int, truthy(rval(e.l)) && truthy(rval(e.r)) ? 1 : 0);
      case 'or': return val(T.int, truthy(rval(e.l)) || truthy(rval(e.r)) ? 1 : 0);
      case 'cond': {
        const pick = truthy(rval(e.c)) ? e.a : e.b, x = rval(pick);
        const at = decay(typeOf(e.a)), bt = decay(typeOf(e.b));
        if (isArith(at) && isArith(bt)) { const t = common(at, bt); return val(t, convert(x, t)); }
        return x;
      }
      case 'comma': rval(e.l); return rval(e.r);
      case 'cast': {
        const x = rval(e.e);
        if (e.t.k === 'void') return val(T.void, undefined);
        if (e.t.k === 'struct' || e.t.k === 'arr') fail(`${text(e)}: a value cannot be cast to ${art(e.t)}`);
        if (e.t.k === 'ptr' && x.t.k === 'int' && x.v != 0) fail(`${text(e)}: turning the number ${x.v} into a pointer is not supported`); // eslint-disable-line eqeqeq
        return val(e.t, convert(x, e.t, text(e.e)));
      }
      case 'sizeofT': return val(T.ulong, BigInt(concrete(e.t).size));
      case 'sizeofE': {
        const t = typeOf(e.e);
        if (t.k === 'fn') fail('sizeof cannot be used on a function');
        return val(T.ulong, BigInt(t.size));
      }
      case 'call': return call(e);
      case 'clit': return loadLv(lval(e));
      case 'init': fail('{ … } can only give a variable its first value, in its declaration');
      // falls through
      default: fail('cannot run ' + e.k);
    }
  }

  /* ---- calls ---- */
  function call(e) {
    if (e.f.k === 'id' && !lookup(e.f.name) && !funcs.has(e.f.name) && !protos.has(e.f.name)) {
      const lib = LIB[e.f.name];
      if (!lib) fail(`${e.f.name}() is not defined` + (SUGGEST[e.f.name] ? ' ' + SUGGEST[e.f.name] : ''));
      if (lib.raw) return lib.raw(e);
      return lib.fn(e.args.map(a => ({ ...rval(a), text: text(a) })), e);
    }
    const f = rval(e.f);
    if (f.v === null) fail(`${text(e.f)} is NULL, so it cannot be called`);
    if (!(f.v instanceof FnRef)) fail(`${text(e.f)} is ${art(f.t)}, not a function`);
    if (f.v.builtin) return f.v.builtin.fn(e.args.map(a => ({ ...rval(a), text: text(a) })), e);
    const def = f.v.def || funcs.get(f.v.name);
    if (!def) fail(`${f.v.name}() is declared but never defined`);
    const ps = def.params, ft = def.type;
    if (ft.proto && (e.args.length < ps.length || (e.args.length > ps.length && !ft.variadic)))
      fail(`${def.name}() takes ${ps.length} argument${ps.length === 1 ? '' : 's'}, but is given ${e.args.length}`);
    const args = e.args.map((a, k) => {
      const x = rval(a);
      return k < ps.length ? { x, t: ps[k].type, d: `argument ${k + 1} of ${def.name}()` } : { x, t: promoteArg(x.t) };
    });
    return invoke(def, args);
  }
  const promoteArg = t => (t.k === 'flt' ? T.double : t.k === 'int' ? promote(t) : t);

  function invoke(def, args) {
    if (stack.length >= MAX_CALLS) throw new StopRun(stopped = 'Trace stopped: more than ' + MAX_CALLS + ' nested calls.');
    const fr = { def, name: def.name, scopes: [{ vars: new Map(), blocks: [] }] };
    const params = def.params.map((p, k) => {
      const b = alloc('stack', p.type.size, p.type, p.name);
      b.fn = def.name;
      fr.scopes[0].blocks.push(b);
      fr.scopes[0].vars.set(p.name, { b, t: p.type });
      const a = args[k];
      if (p.type.k === 'struct') assignTo({ t: p.type, b, o: 0, d: p.name }, a.x, a.d);
      else store(b, 0, p.type, convertArg(a.x, p.type, a.d, p.name), p.name);
      return p.name + '=' + brief(b, p.type);
    });
    stack.push({ name: def.name, args: params.join(', ').slice(0, 70) });
    frames.push(fr);
    let r;
    try {
      r = withScope(() => {                        // the body's own scope, so main's variables can be kept for the last step
        let res;
        for (const it of def.body.items) { res = exec(it); if (res) break; }
        if (frames.length === 1) finalVars = captureVars(fr);
        return res;
      });
    } finally {
      frames.pop(); stack.pop();
      fr.scopes.forEach(s => s.blocks.forEach(b => { b.dead = true; }));
    }
    const ret = def.type.ret;
    if (ret.k === 'void') return val(T.void, undefined);
    if (!r || !r.ret) {
      if (def.name === 'main') return val(T.int, 0);
      fail(`${def.name}() ended without returning a value (it returns ${typeName(ret)})`);
    }
    return r.ret;
  }
  function convertArg(x, t, d, name) {
    if (t.k === 'ptr' && x.t.k !== 'ptr' && !(x.t.k === 'int' && x.v == 0) && x.t.k !== 'fn') fail(`${d} (${name}) must be a pointer, but it is given ${art(x.t)}`); // eslint-disable-line eqeqeq
    if (t.k !== 'ptr' && x.t.k === 'ptr' && !t.bool) fail(`${d} (${name}) is ${art(t)}, but it is given a pointer`);
    return convert(x, t, d);
  }

  /* ---- statements ---- */
  const scope = () => { const f = frame(); return f ? f.scopes[f.scopes.length - 1] : globalScope; };
  const globalScope = { vars: globals, blocks: [] };
  function step(l) {
    line = l;
    if (steps.length >= MAX_STEPS) throw new StopRun(stopped = 'Trace stopped after ' + MAX_STEPS + ' steps (possible infinite loop).');
    const c = captureVars(frame());
    steps.push({ line: l, stack: stack.map(s => ({ ...s })), vars: c.vars, refs: c.refs, logs: logs.length });
  }
  const withScope = (fn) => {
    const f = frame(), s = { vars: new Map(), blocks: [] };
    f.scopes.push(s);
    try { return fn(); } finally { f.scopes.pop(); s.blocks.forEach(b => { b.dead = true; }); }
  };
  /** A statement on the same line as the if / loop it belongs to (if (x) break;) takes no step of its own. */
  const sub = (s, parent) => exec(s, s.line === parent.line && s.k !== 'block');
  function exec(s, quiet = false) {
    const at = l => { if (!quiet) step(l); else line = l; };
    switch (s.k) {
      case 'block': return withScope(() => { for (const it of s.items) { const r = exec(it); if (r) return r; } return undefined; });
      case 'decl': if (s.list.length) { at(s.line); s.list.forEach(d => declare(d, false)); } return undefined;
      case 'expr': at(s.line); rval(s.e); return undefined;
      case 'empty': at(s.line); return undefined;
      case 'if': at(s.line); if (truthy(rval(s.c))) return sub(s.a, s); return s.b ? sub(s.b, s) : undefined;
      case 'while':
        for (;;) {
          at(s.line);
          if (!truthy(rval(s.c))) return undefined;
          const r = sub(s.body, s);
          if (r === BREAK) return undefined;
          if (r && r !== CONT) return r;
        }
      // falls through
      case 'do':
        at(s.line);
        for (;;) {
          const r = sub(s.body, s);
          if (r === BREAK) return undefined;
          if (r && r !== CONT) return r;
          step(s.cline);
          if (!truthy(rval(s.c))) return undefined;
        }
      // falls through
      case 'for':
        return withScope(() => {
          at(s.line);
          if (s.init) { if (s.init.k === 'decl') s.init.list.forEach(d => declare(d, false)); else rval(s.init.e); }
          for (;;) {
            if (s.c && !truthy(rval(s.c))) return undefined;
            const r = sub(s.body, s);
            if (r === BREAK) return undefined;
            if (r && r !== CONT) return r;
            if (s.step) rval(s.step);
            at(s.line);
          }
        });
      case 'return': {
        at(s.line);
        const ret = frame().def.type.ret;
        if (!s.e) { if (ret.k !== 'void' && frame().def.name !== 'main') fail(`${frame().def.name}() must return ${art(ret)}`); return { ret: val(T.void, undefined) }; }
        const x = rval(s.e);
        if (ret.k === 'void') { if (x.t.k !== 'void') fail(`${frame().def.name}() returns void, so it cannot return a value`); return { ret: x }; }
        if (ret.k === 'struct') {
          const b = alloc('temp', ret.size, ret, 'returned value');
          assignTo({ t: ret, b, o: 0, d: 'the returned value' }, x, 'return');
          return { ret: val(ret, new Ptr(b, 0)) };
        }
        return { ret: val(ret, convertArg(x, ret, 'the returned value', frame().def.name + '()')) };
      }
      case 'break': at(s.line); return BREAK;
      case 'continue': at(s.line); return CONT;
      case 'switch': {
        at(s.line);
        const x = rval(s.e);
        if (x.t.k !== 'int') fail('switch needs an integer, not ' + art(x.t));
        const v = Number(x.v);
        const items = s.body.k === 'block' ? s.body.items : [s.body];
        let from = items.findIndex(it => it.k === 'case' && it.v === v);
        if (from < 0) from = items.findIndex(it => it.k === 'default');
        if (from < 0) return undefined;
        return withScope(() => {
          for (let k = from; k < items.length; k++) {
            const r = exec(items[k]);
            if (r === BREAK) return undefined;
            if (r) return r;
          }
          return undefined;
        });
      }
      case 'case': case 'default': return undefined;
      default: fail('cannot run ' + s.k);
    }
  }

  /** A declared type with its sizes known: int a[n] (n is run now), int a[] = {1, 2, 3} */
  function concrete(t, init) {
    if (t.k !== 'arr') return t;
    let n = t.n;
    if (n && typeof n === 'object') {
      const x = rval(n);
      if (x.t.k !== 'int') fail('an array size must be an integer');
      n = Number(x.v);
      if (n <= 0) fail(`an array size must be more than 0, but it is ${n}`);
    }
    const of = concrete(t.of);
    if (n == null) {
      if (!init) fail('an array declared with [] needs a size, or values: int a[] = {1, 2, 3}');
      if (init.k === 'str' && isCharT(of)) n = init.codes.length + 1;
      else if (init.k === 'init') n = countItems(of, init.items);
      else fail('an array needs { … } to be given its values');
    }
    return n === t.n && of === t.of ? t : arr(of, n);
  }
  const scalarsIn = t => (t.k === 'arr' ? t.n * scalarsIn(t.of) : t.k === 'struct' ? (t.union ? 1 : t.fields.reduce((a, f) => a + scalarsIn(f.type), 0)) : 1);
  function countItems(of, items) {
    let idx = 0, most = 0, k = 0;
    while (k < items.length) {
      const it = items[k];
      if (it.desig.length) idx = it.desig[0].index;
      if (it.val.k === 'init' || !isAggregate(of) || it.val.k === 'str') k++;
      else k += scalarsIn(of);
      idx++; most = Math.max(most, idx);
    }
    return most;
  }

  function declare(d, isGlobal) {
    if (d.type.k === 'fn') { if (!funcs.has(d.name)) protos.set(d.name, { name: d.name, type: d.type, params: d.type.params.map((t, k) => ({ name: 'p' + k, type: t })) }); return; }
    if (d.storage === 'extern') return;
    const st = d.storage === 'static' && !isGlobal;
    if (st && d.block) { scope().vars.set(d.name, { b: d.block, t: d.block.type }); return; }
    const t = concrete(d.type, d.init);
    if (t.k === 'void') fail(`${d.name} cannot be void (void * is a pointer to anything)`);
    if (t.k === 'struct' && !t.done) fail(`${d.name}: ${typeName(t)} is not defined (only a pointer to it can be declared)`);
    const b = alloc(isGlobal || st ? 'global' : 'stack', t.size, t, d.name);
    b.fn = frame() ? frame().def.name : null;
    if (!isGlobal && !st) scope().blocks.push(b);
    if (st) d.block = b;
    if (isGlobal || st) zeroFill(b, 0, t);
    if (d.init) initialize(b, 0, t, d.init, d.name);
    scope().vars.set(d.name, { b, t });
  }

  /** Gives memory its first value: an expression, a string for a char array, or { … } with designators. */
  function initialize(b, o, t, init, d) {
    if (init.k === 'init') {
      if (!isAggregate(t)) {
        if (!init.items.length) { zeroFill(b, o, t); return; }
        return initialize(b, o, t, init.items[0].val, d);
      }
      zeroFill(b, o, t);
      const pos = fill(b, o, t, init.items, 0, true, d);
      if (pos < init.items.length) fail(`${d}: too many values in { … } (${typeName(t)})`);
      return;
    }
    if (t.k === 'arr') {
      if (init.k === 'str' && isCharT(t.of)) return copyString(b, o, t, init, d);
      fail(`${d}: an array needs { … } to be given its values`);
    }
    const x = rval(init);
    if (t.k === 'struct') { assignTo({ t, b, o, d }, x, d); return; }
    if (t.k === 'ptr' && x.t.k !== 'ptr' && !(x.t.k === 'int' && x.v == 0) && x.t.k !== 'fn') fail(`${d} is a pointer, but it is given ${art(x.t)}`); // eslint-disable-line eqeqeq
    if (t.k !== 'ptr' && x.t.k === 'ptr' && !t.bool) fail(`${d} is ${art(t)}, but it is given a pointer`);
    store(b, o, t, convert(x, t, d), d);
  }
  function copyString(b, o, t, init, d) {
    const codes = init.codes;
    if (codes.length > t.n) fail(`${d}: the string "${new TextDecoder().decode(new Uint8Array(codes))}" needs ${codes.length + 1} chars, but ${typeName(t)} has room for ${t.n}`);
    for (let k = 0; k < t.n; k++) store(b, o + k, t.of, wrapInt(k < codes.length ? codes[k] : 0, t.of), d);
  }
  /** Fills an array or struct from items[pos…]; braced: the list is its own { … } (else brace elision: take what fits). */
  function fill(b, o, t, items, pos, braced, d) {
    if (t.k === 'arr') {
      let idx = 0;
      while (pos < items.length && (braced || idx < t.n)) {
        const it = items[pos];
        if (it.desig.length) {
          if (!braced) break;
          const ds = it.desig[0];
          if (ds.index == null) fail(`${d}: .${ds.field} = names a field, but ${typeName(t)} is an array`);
          if (it.desig.length > 1) fail(`${d}: nested designators are not supported`);
          idx = ds.index;
        }
        if (idx >= t.n) fail(`${d}: too many values for ${typeName(t)}`);
        pos = elem(b, o + idx * t.of.size, t.of, items, pos, `${d}[${idx}]`);
        idx++;
      }
      return pos;
    }
    let fi = 0;
    const fields = t.union ? t.fields.slice(0, 1) : t.fields;
    while (pos < items.length && (braced || fi < fields.length)) {
      const it = items[pos];
      let f;
      if (it.desig.length) {
        if (!braced) break;
        const ds = it.desig[0];
        if (ds.field == null) fail(`${d}: [${ds.index}] = names an index, but ${typeName(t)} is a struct`);
        if (it.desig.length > 1) fail(`${d}: nested designators are not supported`);
        fi = t.fields.findIndex(x => x.name === ds.field);
        if (fi < 0) fail(`${typeName(t)} has no field named ${ds.field}`);
        f = t.fields[fi];
      } else f = fields[fi];
      if (!f) fail(`${d}: too many values for ${typeName(t)}`);
      pos = elem(b, o + f.off, f.type, items, pos, `${d}.${f.name}`);
      fi++;
    }
    return pos;
  }
  function elem(b, o, t, items, pos, d) {
    const v = items[pos].val;
    if (v.k === 'init') { initialize(b, o, t, v, d); return pos + 1; }
    if (isAggregate(t)) {
      if (t.k === 'arr' && v.k === 'str' && isCharT(t.of)) { copyString(b, o, t, v, d); return pos + 1; }
      if (t.k === 'struct' && typeOf(v) === t) { initialize(b, o, t, v, d); return pos + 1; }
      const plain = { ...items[pos], desig: [] };
      return fill(b, o, t, [plain, ...items.slice(pos + 1)], 0, false, d) + pos;
    }
    initialize(b, o, t, v, d);
    return pos + 1;
  }

  /* ---- snapshots ---- */
  const ids = new Map();
  const idOf = key => { let n = ids.get(key); if (!n) { n = ids.size + 1; ids.set(key, n); } return n; };
  const keyOf = (b, o, t) => b.id + ':' + o + ':' + typeName(t);
  const peek = (b, o, t) => { try { return b.freed || b.dead ? UNINIT : load(b, o, t, ''); } catch { return UNINIT; } };
  const prim = (k, s) => ({ t: 'p', k, s });

  function primOf(t, v) {
    if (v === UNINIT) return prim('undef', '?');
    if (t.k === 'flt') return prim('num', fmtFloat(v, t));
    if (t.bool) return prim('bool', v ? 'true' : 'false');
    if (t.en && t.consts.has(v)) return prim('sym', t.consts.get(v));
    if (isCharT(t)) { const c = charLit(v < 0 ? v + 256 : v); if (c) return prim('char', c); }
    return prim('num', String(v));
  }
  /** Where a pointer points, in C: &arr[2], &p.y, &x, &#3[1] (#3: the memory malloc gave, as numbered in the views) */
  function target(p, to) {
    const b = p.b;
    if (!b.type) {                                  // malloc'd memory has no type of its own: it is seen through the pointer
      const n = elemCount(b, to.size ? to : T.char), arrT = arr(to, n);
      const id = idOf(keyOf(b, 0, arrT));
      if (to.size && p.o % to.size === 0) return { text: '&#' + id + '[' + p.o / to.size + ']', to: id, at: p.o / to.size };
      return { text: '#' + id + ' + ' + p.o };
    }
    let path = '', t = b.type, base = 0, hit = null;
    for (;;) {
      if (p.o === base && sameType(t, to) && path) break;
      if (t.k === 'arr') {
        const es = t.of.size, idx = Math.floor((p.o - base) / es);
        if (idx < 0 || idx > t.n) return { text: b.name + (p.o >= base ? ' + ' : ' - ') + Math.abs(p.o - base) + ' bytes' };
        path += '[' + idx + ']';
        if (sameType(t.of, to) && (p.o - base) % es === 0) { hit = { to: idOf(keyOf(b, base, t)), at: idx }; break; }
        base += idx * es; t = t.of;
        if (idx === t.n) break;
      } else if (t.k === 'struct') {
        const f = t.fields.find(x => p.o >= base + x.off && p.o < base + x.off + x.type.size);
        if (!f) break;
        path += '.' + f.name; base += f.off; t = f.type;
      } else break;
    }
    return { text: '&' + b.name + path, ...(hit || {}) };
  }

  function ser(b, o, t, ctx, depth) {
    if (t.k === 'arr' || t.k === 'struct') {
      const id = idOf(keyOf(b, o, t));
      if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
      ctx.seen.add(id);
      if (depth >= MAX_DEPTH) return { t: 'trunc', id };
      if (t.k === 'arr') {
        const n = Math.min(t.n, MAX_ITEMS);
        const items = [];
        for (let k = 0; k < n; k++) items.push(ser(b, o + k * t.of.size, t.of, ctx, depth + 1));
        return { t: 'arr', id, len: t.n, items, more: t.n - n, tn: typeName(t) };
      }
      return { t: 'obj', id, cls: structName(t), entries: t.fields.map(f => [f.name, ser(b, o + f.off, f.type, ctx, depth + 1)]), more: 0 };
    }
    const v = peek(b, o, t);
    if (t.k !== 'ptr') return primOf(t, v);
    return serPtr(v, t, ctx, depth);
  }
  function serPtr(v, t, ctx, depth) {
    if (v === UNINIT) return prim('undef', '?');
    if (v === null) return prim('null', 'NULL');
    if (v instanceof FnRef) return { t: 'fn', s: v.name };
    const b = v.b, to = t.to;
    if (b.freed || b.dead) return prim('undef', 'dangling');
    if (b.kind === 'literal' && (isCharT(to) || to.k === 'void')) return prim('str', JSON.stringify(literalText(v)));   // it never changes: just the text
    // the memory pointed to is shown in place of the pointer (at the pointer's own depth: a pointer is not a level of nesting)
    if (to.k === 'struct' && to.done) {
      if (v.o >= 0 && v.o + to.size <= b.size) {
        if (!b.type && v.o === 0 && b.size >= 2 * to.size) return ser(b, 0, arr(to, elemCount(b, to)), ctx, depth);
        return ser(b, v.o, to, ctx, depth);
      }
    } else if (to.k !== 'void' && to.k !== 'fn' && v.o === 0) {
      if (b.type && sameType(b.type, to) && isAggregate(to)) return ser(b, 0, b.type, ctx, depth);
      if (b.type && b.type.k === 'arr' && sameType(b.type.of, to)) return ser(b, 0, b.type, ctx, depth);
      if (!b.type && to.size && b.size >= to.size) return ser(b, 0, arr(to, elemCount(b, to)), ctx, depth);
    }
    const tg = target(v, to.k === 'void' || to.k === 'fn' ? T.char : to);
    return { t: 'p', k: 'ptr', s: tg.text, ...(tg.to ? { to: tg.to, at: tg.at } : {}) };
  }
  const literalText = p => { const bytes = []; for (let o = p.o; o < p.b.size - 1; o++) bytes.push(p.b.cells.get(o).v & 255); return new TextDecoder().decode(new Uint8Array(bytes)); };
  /** One-line value for the call stack: 5, 'a', nums, &nums[2], NULL, "text", {…} */
  function brief(b, t) {
    if (t.k === 'struct') return '{…}';
    const v = peek(b, 0, t);
    if (t.k !== 'ptr') return primOf(t, v).s;
    if (v === null || v === UNINIT) return v === null ? 'NULL' : '?';
    if (v instanceof FnRef) return v.name;
    if (v.b.freed || v.b.dead) return 'dangling';
    if (v.b.kind === 'literal') { const s = literalText(v); return JSON.stringify(s.length > 14 ? s.slice(0, 14) + '…' : s); }
    if (v.o === 0 && v.b.type) return v.b.name;
    return target(v, t.to.k === 'void' || t.to.k === 'fn' ? T.char : t.to).text.replace(/^&#(\d+)\[0\]$/, '#$1');
  }
  function captureVars(f) {
    const ctx = { seen: new Set(), refs: new Set() };
    const named = new Map();
    if (f) for (const s of f.scopes) for (const [n, r] of s.vars) { named.delete(n); named.set(n, r); }
    const vars = [];
    for (const [n, r] of named) vars.push({ name: n, scope: 'local', node: ser(r.b, 0, r.t, ctx, 0) });
    for (const [n, r] of globals) if (!named.has(n) && !r.hidden) vars.push({ name: n, scope: 'global', node: ser(r.b, 0, r.t, ctx, 0) });
    return { vars, refs: [...ctx.refs].sort((a, b) => a - b) };
  }

  /* ---- the standard library ---- */
  const lib = {};
  const S = (ret, fn) => ({ ret, fn });
  const intOf = (x, name, what) => { if (x.t.k !== 'int') fail(`${name}(): ${what || 'the argument'} must be an integer, not ${art(x.t)}`); return Number(x.v); };
  const dbl = (x, name) => { if (!isArith(x.t)) fail(`${name}() needs a number, not ${art(x.t)}`); return Number(x.v); };
  const ptrArg = (x, name, k = 1) => {
    if (x.t.k !== 'ptr') fail(`${name}(): argument ${k} must be a pointer, not ${art(x.t)}`);
    return x.v;
  };
  const nonNull = (x, name, k = 1) => { const p = ptrArg(x, name, k); if (p === null) fail(`${name}(): argument ${k} (${x.text}) is NULL`); return p; };
  /** The bytes of a C string, up to (not including) its '\0' */
  function cstr(p, name, max = Infinity) {
    const out = [];
    for (let o = p.o; out.length < max; o++) {
      if (o >= p.b.size || p.b.freed || p.b.dead) {
        if (p.b.freed || p.b.dead) check(p.b, o, T.char, name, false);
        fail(`${name}: the string has no '\\0' before the end of its memory (${holds(p.b, T.char)})`);
      }
      const c = load(p.b, o, T.char, name);
      if (c === UNINIT) fail(`${name}: the string runs into memory that was never given a value (is its '\\0' missing?)`);
      if (c === 0) break;
      out.push(c & 255);
    }
    return out;
  }
  const decode = bytes => new TextDecoder().decode(new Uint8Array(bytes));
  const putBytes = (p, bytes, name) => bytes.forEach((c, k) => store(p.b, p.o + k, T.char, wrapInt(c, T.char), name));
  const fmtArgs = (args, name) => {
    const f = nonNull(args[0], name);
    return format(decode(cstr(f, name + '()\'s format')), args.slice(1).map(a => ({ ...a, t: a.t.k === 'flt' ? T.double : a.t })), {
      str: (p, max) => decode(cstr(p, name + '()\'s %s', max)), addr: addrOf, fail: m => fail(name + '(): ' + m),
    });
  };
  const sizeArg = (x, name, what) => { const n = intOf(x, name, what); if (n < 0) fail(`${name}(): ${what} is negative (${n})`); return n; };

  lib.printf = S(T.int, args => { if (!args.length) fail('printf() needs a format string'); const s = fmtArgs(args, 'printf'); write(s); return val(T.int, new TextEncoder().encode(s).length); });
  lib.fprintf = S(T.int, args => { const s = fmtArgs(args.slice(1), 'fprintf'); write(s, args[0].v && args[0].v.b && args[0].v.b.name === 'stderr'); return val(T.int, s.length); });
  lib.sprintf = S(T.int, args => { const dst = nonNull(args[0], 'sprintf'); const s = fmtArgs(args.slice(1), 'sprintf'); const bytes = [...new TextEncoder().encode(s), 0]; putBytes(dst, bytes, 'sprintf()\'s destination ' + args[0].text); return val(T.int, bytes.length - 1); });
  lib.snprintf = S(T.int, args => {
    const n = sizeArg(args[1], 'snprintf', 'the size'); const s = fmtArgs(args.slice(2), 'snprintf'); const bytes = [...new TextEncoder().encode(s)];
    if (n > 0) putBytes(nonNull(args[0], 'snprintf'), bytes.slice(0, n - 1).concat(0), 'snprintf()\'s destination ' + args[0].text);
    return val(T.int, bytes.length);
  });
  lib.puts = S(T.int, args => { write(decode(cstr(nonNull(args[0], 'puts'), 'puts(' + args[0].text + ')')) + '\n'); return val(T.int, 1); });
  lib.putchar = S(T.int, args => { const c = intOf(args[0], 'putchar') & 255; write(decode([c])); return val(T.int, c); });
  lib.scanf = { ret: T.int, fn: () => fail('scanf(): this page has no keyboard input: give the values in the code instead') };
  lib.getchar = { ret: T.int, fn: () => val(T.int, -1) };
  lib.fflush = S(T.int, () => val(T.int, 0));

  lib.malloc = S(ptr(T.void), (args, e) => heap(sizeArg(args[0], 'malloc', 'the size'), e, false));
  lib.calloc = S(ptr(T.void), (args, e) => heap(sizeArg(args[0], 'calloc', 'the count') * sizeArg(args[1], 'calloc', 'the size'), e, true));
  function heap(size, e, zero) {
    if (heapUsed + size > MAX_HEAP) return val(ptr(T.void), null);
    heapUsed += size;
    const b = alloc('heap', size, null, 'heap');
    b.line = e.line;
    if (zero) for (let k = 0; k < size; k++) b.cells.set(k, { kind: 'byte', size: 1, v: 0 });
    return val(ptr(T.void), new Ptr(b, 0));
  }
  const heapBlock = (x, name) => {
    const p = ptrArg(x, name);
    if (p === null) return null;
    if (p.b.kind !== 'heap') fail(`${name}(${x.text}): ${x.text} points to ${p.b.kind === 'literal' ? 'a string literal' : p.b.name}, not to memory from malloc`);
    if (p.o !== 0) fail(`${name}(${x.text}): ${x.text} points inside a block from malloc, not to its start`);
    if (p.b.freed) fail(`${name}(${x.text}): this memory was already freed on line ${p.b.freedLine} (double free)`);
    return p.b;
  };
  lib.free = S(T.void, (args, e) => { const b = heapBlock(args[0], 'free'); if (b) { b.freed = true; b.freedLine = e.line; heapUsed -= b.size; } return val(T.void, undefined); });
  lib.realloc = S(ptr(T.void), (args, e) => {
    const old = heapBlock(args[0], 'realloc'), size = sizeArg(args[1], 'realloc', 'the size');
    const r = heap(size, e, false);
    if (old && r.v) { copyMem(r.v.b, 0, old, 0, Math.min(size, old.size), 'realloc'); old.freed = true; old.freedLine = e.line; heapUsed -= old.size; }
    return r;
  });
  lib.exit = S(T.void, args => { const code = String(intOf(args[0], 'exit')); finalVars = captureVars(frame()); throw new ExitRun(code); });
  lib.abort = S(T.void, () => fail('abort() was called'));
  lib.abs = S(T.int, args => val(T.int, wrapInt(Math.abs(intOf(args[0], 'abs')), T.int)));
  lib.labs = S(T.long, args => { const v = BigInt(args[0].v); return val(T.long, v < 0n ? -v : v); });
  lib.llabs = lib.labs;
  lib.atoi = S(T.int, args => val(T.int, wrapInt(parseInt(decode(cstr(nonNull(args[0], 'atoi'), 'atoi')), 10) || 0, T.int)));
  lib.atol = S(T.long, args => val(T.long, BigInt(parseInt(decode(cstr(nonNull(args[0], 'atol'), 'atol')), 10) || 0)));
  lib.atof = S(T.double, args => val(T.double, parseFloat(decode(cstr(nonNull(args[0], 'atof'), 'atof'))) || 0));
  let seed = 1;
  lib.rand = S(T.int, () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return val(T.int, (seed >>> 1) & 0x7fffffff); });
  lib.srand = S(T.void, args => { seed = intOf(args[0], 'srand') >>> 0; return val(T.void, undefined); });
  lib.time = S(T.long, () => val(T.long, 1700000000n));
  lib.clock = S(T.long, () => val(T.long, BigInt(steps.length * 10)));
  lib.qsort = S(T.void, args => {
    const base = nonNull(args[0], 'qsort'), n = sizeArg(args[1], 'qsort', 'the count'), size = sizeArg(args[2], 'qsort', 'the size');
    const cmp = args[3].v;
    if (!(cmp instanceof FnRef)) fail('qsort(): the 4th argument must be a comparison function');
    if (n * size > 0) check(base.b, base.o, { size: n * size }, 'qsort()\'s array', true);
    const items = [];
    for (let k = 0; k < n; k++) { const t = alloc('temp', size, null, 'qsort item'); t.kind = 'heap'; copyMem(t, 0, base.b, base.o + k * size, size, 'qsort'); items.push(t); }
    const vp = ptr(T.void);
    items.sort((a, b) => {
      const r = cmp.def ? invoke(cmp.def, [{ x: val(vp, new Ptr(a, 0)), t: cmp.def.params[0].type, d: 'a' }, { x: val(vp, new Ptr(b, 0)), t: cmp.def.params[1].type, d: 'b' }])
        : cmp.builtin.fn([val(vp, new Ptr(a, 0)), val(vp, new Ptr(b, 0))]);
      return Number(r.v);
    });
    items.forEach((t, k) => copyMem(base.b, base.o + k * size, t, 0, size, 'qsort'));
    return val(T.void, undefined);
  });

  lib.strlen = S(T.ulong, args => val(T.ulong, BigInt(cstr(nonNull(args[0], 'strlen'), 'strlen(' + args[0].text + ')').length)));
  lib.strcpy = S(ptr(T.char), args => { const d = nonNull(args[0], 'strcpy'); putBytes(d, [...cstr(nonNull(args[1], 'strcpy', 2), 'strcpy()\'s source ' + args[1].text), 0], 'strcpy()\'s destination ' + args[0].text); return val(ptr(T.char), d); });
  lib.strncpy = S(ptr(T.char), args => {
    const d = nonNull(args[0], 'strncpy'), n = sizeArg(args[2], 'strncpy', 'the count'), s = cstr(nonNull(args[1], 'strncpy', 2), 'strncpy', n);
    putBytes(d, s.concat(Array(n - s.length).fill(0)), 'strncpy()\'s destination ' + args[0].text); return val(ptr(T.char), d);
  });
  lib.strcat = S(ptr(T.char), args => { const d = nonNull(args[0], 'strcat'), have = cstr(d, 'strcat()\'s destination ' + args[0].text).length; putBytes(new Ptr(d.b, d.o + have), [...cstr(nonNull(args[1], 'strcat', 2), 'strcat'), 0], 'strcat()\'s destination ' + args[0].text); return val(ptr(T.char), d); });
  lib.strncat = S(ptr(T.char), args => { const d = nonNull(args[0], 'strncat'), have = cstr(d, 'strncat').length; putBytes(new Ptr(d.b, d.o + have), [...cstr(nonNull(args[1], 'strncat', 2), 'strncat', sizeArg(args[2], 'strncat', 'the count')), 0], 'strncat()\'s destination ' + args[0].text); return val(ptr(T.char), d); });
  const cmpBytes = (a, b) => { for (let k = 0; ; k++) { if (k >= a.length || k >= b.length) return a.length === b.length ? 0 : k >= a.length ? -1 : 1; if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1; } };
  lib.strcmp = S(T.int, args => val(T.int, cmpBytes(cstr(nonNull(args[0], 'strcmp'), 'strcmp'), cstr(nonNull(args[1], 'strcmp', 2), 'strcmp'))));
  lib.strncmp = S(T.int, args => { const n = sizeArg(args[2], 'strncmp', 'the count'); return val(T.int, cmpBytes(cstr(nonNull(args[0], 'strncmp'), 'strncmp', n), cstr(nonNull(args[1], 'strncmp', 2), 'strncmp', n))); });
  const find = (args, name, last) => {
    const p = nonNull(args[0], name), s = cstr(p, name), c = intOf(args[1], name) & 255;
    const k = c === 0 ? s.length : last ? s.lastIndexOf(c) : s.indexOf(c);
    return val(ptr(T.char), k < 0 ? null : new Ptr(p.b, p.o + k));
  };
  lib.strchr = S(ptr(T.char), args => find(args, 'strchr', false));
  lib.strrchr = S(ptr(T.char), args => find(args, 'strrchr', true));
  lib.strstr = S(ptr(T.char), args => {
    const p = nonNull(args[0], 'strstr'), h = decode(cstr(p, 'strstr')), n = decode(cstr(nonNull(args[1], 'strstr', 2), 'strstr'));
    const k = new TextEncoder().encode(h.slice(0, Math.max(0, h.indexOf(n)))).length;
    return val(ptr(T.char), h.indexOf(n) < 0 ? null : new Ptr(p.b, p.o + k));
  });
  lib.strdup = S(ptr(T.char), (args, e) => { const s = cstr(nonNull(args[0], 'strdup'), 'strdup'); const r = heap(s.length + 1, e, false); putBytes(r.v, [...s, 0], 'strdup'); return val(ptr(T.char), r.v); });
  lib.memset = S(ptr(T.void), args => {
    const d = nonNull(args[0], 'memset'), c = intOf(args[1], 'memset') & 255, n = sizeArg(args[2], 'memset', 'the count');
    if (n) { check(d.b, d.o, { size: n }, 'memset(' + args[0].text + ', …)', true); clear(d.b, d.o, n); for (let k = 0; k < n; k++) d.b.cells.set(d.o + k, { kind: 'byte', size: 1, v: c }); }
    return val(ptr(T.void), d);
  });
  lib.memcpy = S(ptr(T.void), args => { const d = nonNull(args[0], 'memcpy'), s = nonNull(args[1], 'memcpy', 2), n = sizeArg(args[2], 'memcpy', 'the count'); copyMem(d.b, d.o, s.b, s.o, n, 'memcpy(' + args[0].text + ', ' + args[1].text + ', …)'); return val(ptr(T.void), d); });
  lib.memmove = lib.memcpy;
  lib.memcmp = S(T.int, args => {
    const a = nonNull(args[0], 'memcmp'), b = nonNull(args[1], 'memcmp', 2), n = sizeArg(args[2], 'memcmp', 'the count');
    for (let k = 0; k < n; k++) { const x = byteAt(a.b, a.o + k), y = byteAt(b.b, b.o + k); if (x !== y) return val(T.int, x < y ? -1 : 1); }
    return val(T.int, 0);
  });

  const ctype = (name, f) => { lib[name] = S(T.int, args => val(T.int, f(intOf(args[0], name)))); };
  const ch = c => String.fromCharCode(c & 255);
  ctype('isdigit', c => +/[0-9]/.test(ch(c))); ctype('isalpha', c => +/[A-Za-z]/.test(ch(c))); ctype('isalnum', c => +/[A-Za-z0-9]/.test(ch(c)));
  ctype('isspace', c => +/[ \t\n\v\f\r]/.test(ch(c))); ctype('isupper', c => +/[A-Z]/.test(ch(c))); ctype('islower', c => +/[a-z]/.test(ch(c)));
  ctype('ispunct', c => +(c > 32 && c < 127 && !/[A-Za-z0-9]/.test(ch(c)))); ctype('isxdigit', c => +/[0-9A-Fa-f]/.test(ch(c)));
  ctype('isprint', c => +(c >= 32 && c < 127));
  ctype('toupper', c => (c >= 97 && c <= 122 ? c - 32 : c)); ctype('tolower', c => (c >= 65 && c <= 90 ? c + 32 : c));

  const math1 = (name, f) => { lib[name] = S(T.double, args => val(T.double, f(dbl(args[0], name)))); lib[name + 'f'] = S(T.float, args => val(T.float, Math.fround(f(dbl(args[0], name))))); };
  const math2 = (name, f) => { lib[name] = S(T.double, args => val(T.double, f(dbl(args[0], name), dbl(args[1], name)))); };
  math1('sqrt', Math.sqrt); math1('fabs', Math.abs); math1('floor', Math.floor); math1('ceil', Math.ceil); math1('exp', Math.exp);
  math1('log', Math.log); math1('log2', Math.log2); math1('log10', Math.log10); math1('sin', Math.sin); math1('cos', Math.cos);
  math1('tan', Math.tan); math1('atan', Math.atan); math1('asin', Math.asin); math1('acos', Math.acos); math1('trunc', Math.trunc);
  math1('round', x => Math.sign(x) * Math.round(Math.abs(x))); math1('cbrt', Math.cbrt);
  math2('pow', Math.pow); math2('fmin', Math.min); math2('fmax', Math.max); math2('atan2', Math.atan2); math2('hypot', Math.hypot);
  math2('fmod', (a, b) => a % b);
  lib.assert = { ret: T.void, raw: e => {
    if (e.args.length !== 1) fail('assert() takes one condition');
    if (!truthy(rval(e.args[0]))) fail(`Assertion failed: ${e.text.slice(1, -1)}`);
    return val(T.void, undefined);
  } };
  const LIB = lib;

  /* ---- run: globals first, then main() ---- */
  let error = null;
  const fileT = ptr(prog.structs.get('FILE'));
  for (const n of ['stdout', 'stderr']) {          // fprintf(stderr, …) prints in the Output panel's error colour
    const b = alloc('global', 0, null, n);
    b.kind = 'file';
    globals.set(n, { b: Object.assign(alloc('global', 8, fileT, n), { ro: true }), t: fileT, hidden: true });
    globals.get(n).b.cells.set(0, { kind: 'ptr', size: 8, v: new Ptr(b, 0), t: fileT });
  }
  try {
    for (const it of prog.items) {
      if (it.k === 'func') {
        if (funcs.has(it.name)) fail(`${it.name}() is defined twice (line ${funcs.get(it.name).line} and line ${it.line})`);
        funcs.set(it.name, it);
        protos.delete(it.name);
      }
    }
    for (const it of prog.items) {
      if (it.k !== 'decl') continue;
      line = it.line;
      for (const d of it.list) {
        if (globals.has(d.name) && d.type.k !== 'fn') {
          if (d.storage === 'extern' || !d.init) continue;
        }
        declare(d, true);
      }
    }
    const main = funcs.get('main');
    if (!main) throw Object.assign(new Error('there is no main() function: a C program starts in int main(void) { … }'), { noMain: true });
    const mainArgs = main.params.length ? (() => {
      const argv = alloc('global', 16, arr(ptr(T.char), 2), 'argv');
      store(argv, 0, ptr(T.char), new Ptr(literal({ codes: [...new TextEncoder().encode('program')] }), 0), 'argv');
      store(argv, 8, ptr(T.char), null, 'argv');
      return [{ x: val(T.int, 1), t: main.params[0].type }, { x: val(ptr(ptr(T.char)), new Ptr(argv, 0)), t: (main.params[1] || {}).type || ptr(ptr(T.char)) }].slice(0, main.params.length);
    })() : [];
    invoke(main, mainArgs);
  } catch (e) {
    if (e instanceof StopRun) error = { msg: e.message, soft: true };
    else if (e instanceof ExitRun) error = e.message === '0' ? null : { msg: `The program called exit(${e.message}).`, soft: true };
    else if (e instanceof CError) error = { msg: `Error on line ${line}: ${e.message}` };
    else if (e && e.noMain) throw new Error(e.message);
    else if (e instanceof RangeError) error = { msg: `Error on line ${line}: the program ran out of memory or stack (${e.message})` };
    else throw e;
  }
  if (outBuf) logs.push({ type: 'log', s: outBuf });
  if (errBuf) logs.push({ type: 'error', s: errBuf });
  if (!error || (error.soft && !stopped)) {
    const c = finalVars || captureVars(null);
    steps.push({ line: -1, stack: [], vars: c.vars, refs: c.refs, logs: logs.length });
  }
  return { steps, logs, error };
}

/** Functions people often reach for that C does not have (or that need a header the page does not offer). */
const SUGGEST = {
  print: '(C prints with printf("…\\n", …))', println: '(C prints with printf("…\\n", …))', len: '(use strlen() for a string, or sizeof a / sizeof a[0] for an array)',
  max: '(write your own, or use a ? b : a)', min: '(write your own, or use a < b ? a : b)', swap: '(write it with pointers: void swap(int *a, int *b))',
};
