/**
 * C types, laid out as on a 64-bit Linux machine (LP64: int 4 bytes, long and pointers 8).
 *   { k: 'void' }                                   void
 *   { k: 'int', size, signed, rank, name }          every integer type; `bool` for _Bool, `en` for an enum
 *   { k: 'flt', size, name }                        float, double
 *   { k: 'ptr', to }                                pointer
 *   { k: 'arr', of, n }                             array (n: element count, null while unknown, or an expression for a VLA)
 *   { k: 'struct', tag, union, fields: [{ name, type, off }], size, align, done, alias }
 *   { k: 'fn', ret, params: [type], variadic, proto }
 * C++ adds:
 *   { k: 'ref', to }                                a reference (T&)
 *   { k: 'stl', name, args }                        a standard-library class: vector<int>, string, map<K, V>… (see stl.js)
 *   { k: 'auto' }, { k: 'lambda' }                  a type still to be deduced, a lambda's closure
 *   a struct with `cls` (a C++ class or struct) also has methods: Map(name → [def]), ctors: [def], dtor, statics, inits
 */
const int = (name, size, signed, rank) => ({ k: 'int', name, size, signed, rank });
export const T = {
  void: { k: 'void', name: 'void', size: 1 },
  bool: { ...int('bool', 1, false, 0), bool: true },
  char: int('char', 1, true, 1), schar: int('signed char', 1, true, 1), uchar: int('unsigned char', 1, false, 1),
  short: int('short', 2, true, 2), ushort: int('unsigned short', 2, false, 2),
  int: int('int', 4, true, 3), uint: int('unsigned int', 4, false, 3),
  long: int('long', 8, true, 4), ulong: int('unsigned long', 8, false, 4),
  llong: int('long long', 8, true, 5), ullong: int('unsigned long long', 8, false, 5),
  float: { k: 'flt', name: 'float', size: 4 }, double: { k: 'flt', name: 'double', size: 8 }, ldouble: { k: 'flt', name: 'long double', size: 16 },
};
/** The typedefs of the standard headers. */
export const STD_TYPEDEFS = {
  size_t: T.ulong, ssize_t: T.long, ptrdiff_t: T.long, intptr_t: T.long, uintptr_t: T.ulong, time_t: T.long, clock_t: T.long,
  int8_t: T.schar, uint8_t: T.uchar, int16_t: T.short, uint16_t: T.ushort, int32_t: T.int, uint32_t: T.uint, int64_t: T.long, uint64_t: T.ulong,
};
export const FILE_T = { k: 'struct', tag: 'FILE', union: false, fields: [], size: 0, align: 1, done: false };
STD_TYPEDEFS.FILE = FILE_T;

const ptrs = new Map();
export const ptr = to => { let p = ptrs.get(to); if (!p) { p = { k: 'ptr', to, size: 8 }; ptrs.set(to, p); } return p; };
export const arr = (of, n) => ({ k: 'arr', of, n, get size() { return typeof this.n === 'number' ? this.n * this.of.size : 0; } });
export const fnType = (ret, params, variadic, proto = true) => ({ k: 'fn', ret, params, variadic, proto, size: 1 });

const refs = new Map();
export const ref = to => { let r = refs.get(to); if (!r) { r = { k: 'ref', to, size: 8 }; refs.set(to, r); } return r; };
export const AUTO = { k: 'auto', name: 'auto', size: 0 };
export const LAMBDA = { k: 'lambda', name: 'lambda', size: 8 };

/* ---- the C++ standard library's types ---- */
/** How many type arguments each template takes (min, max), and sizeof (as in libstdc++ on 64-bit Linux) */
export const STL = {
  string: [0, 0, 32], vector: [1, 1, 24], map: [2, 2, 48], unordered_map: [2, 2, 56], multimap: [2, 2, 48], set: [1, 1, 48],
  unordered_set: [1, 1, 56], multiset: [1, 1, 48], pair: [2, 2, 0], queue: [1, 1, 80], stack: [1, 1, 80], deque: [1, 1, 80],
  priority_queue: [1, 3, 32], greater: [0, 1, 1], less: [0, 1, 1], function: [1, 1, 32], ostream: [0, 0, 272], istream: [0, 0, 280],
  exception: [0, 0, 16], runtime_error: [0, 0, 16], logic_error: [0, 0, 16], out_of_range: [0, 0, 16], invalid_argument: [0, 0, 16],
  length_error: [0, 0, 16], overflow_error: [0, 0, 16], domain_error: [0, 0, 16], range_error: [0, 0, 16], underflow_error: [0, 0, 16], bad_function_call: [0, 0, 16],
};
/** The standard exceptions, each with the one it derives from (catch (const exception& e) catches them all) */
export const EXCEPTION_BASE = { runtime_error: 'exception', logic_error: 'exception', out_of_range: 'logic_error', invalid_argument: 'logic_error',
  length_error: 'logic_error', domain_error: 'logic_error', overflow_error: 'runtime_error', range_error: 'runtime_error', underflow_error: 'runtime_error' };
const stls = new Map();
let typeIds = 0;
const typeIdOf = new WeakMap();
/** A name for a type that tells apart two structs that happen to have the same name (in two programs) */
const cacheKey = t => {
  if (t.k === 'ptr' || t.k === 'ref') return t.k + '(' + cacheKey(t.to) + ')';
  if (t.k === 'arr') return 'arr(' + cacheKey(t.of) + ',' + t.n + ')';
  if (t.k === 'struct' || t.k === 'fn' || t.en) { if (!typeIdOf.has(t)) typeIdOf.set(t, ++typeIds); return '#' + typeIdOf.get(t); }
  return t.k === 'stl' ? t.ckey : typeName(t);
};
/** vector<int>, map<string, int>, string… made once each, so the same type is the same object. pair<A, B> is a struct. */
export function stlType(name, args = []) {
  const key = name + (args.length ? '<' + args.map(typeName).join(', ') + '>' : '');
  const ckey = name + '<' + args.map(cacheKey).join(',') + '>';
  let t = stls.get(ckey);
  if (t) return t;
  if (name === 'pair') {
    t = { k: 'struct', tag: null, alias: key, union: false, cls: true, pair: true, args,
      fields: [{ name: 'first', type: args[0], off: 0 }, { name: 'second', type: args[1], off: 0 }], methods: new Map(), ctors: [], statics: new Map(), inits: new Map() };
    layout(t);
  } else t = { k: 'stl', name, args, size: STL[name][2], key, ckey };
  stls.set(ckey, t);
  return t;
}
export const STRING = () => stlType('string');

export const isInt = t => t.k === 'int';
export const isArith = t => t.k === 'int' || t.k === 'flt';
export const isScalar = t => t.k === 'int' || t.k === 'flt' || t.k === 'ptr';
export const isAggregate = t => t.k === 'arr' || t.k === 'struct';
export const isCharT = t => t.k === 'int' && t.size === 1 && !t.bool && !t.en;
export const isWide = t => t.k === 'int' && t.size === 8;           // held as a BigInt

export function alignOf(t) {
  if (t.k === 'arr') return alignOf(t.of);
  if (t.k === 'struct') return t.align || 1;
  return Math.min(t.size || 1, 16);
}
/** Lays out a struct or union once all its fields are known. */
export function layout(s) {
  let off = 0, align = 1, size = 0;
  for (const f of s.fields) {
    const a = alignOf(f.type);
    align = Math.max(align, a);
    if (s.union) { f.off = 0; size = Math.max(size, f.type.size); }
    else { off = Math.ceil(off / a) * a; f.off = off; off += f.type.size; size = off; }
  }
  s.align = align;
  s.size = Math.ceil(size / align) * align;
  s.done = true;
}

/** How the type is written in C: int, char *, struct Node *, int[5], int (*)(int) */
export function typeName(t) {
  const inner = (t, s) => {
    if (t.k === 'ptr') return inner(t.to, t.to.k === 'arr' || t.to.k === 'fn' ? '(*' + s + ')' : '*' + s);
    if (t.k === 'arr') return inner(t.of, s + '[' + (typeof t.n === 'number' ? t.n : '') + ']');
    if (t.k === 'fn') return inner(t.ret, s + '(' + t.params.map(typeName).join(', ') + (t.variadic ? ', ...' : '') + ')');
    if (t.k === 'ref') return inner(t.to, '&' + s);
    const base = t.k === 'struct' ? structName(t) : t.k === 'stl' ? t.key : t.en ? 'enum ' + t.en : t.name;
    return s ? base + (s.startsWith('*') || s.startsWith('&') ? ' ' : '') + s : base;
  };
  return inner(t, '');
}
export const structName = s => s.alias || (s.cls && s.tag ? s.tag : (s.union ? 'union ' : 'struct ') + (s.tag || '(anonymous)'));

/** Two types are the same type (for showing memory through a pointer as what it was declared as). */
export function sameType(a, b) {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  if (a.k === 'ptr' || a.k === 'ref') return sameType(a.to, b.to);
  if (a.k === 'arr') return a.n === b.n && sameType(a.of, b.of);
  if (a.k === 'int' || a.k === 'flt') return a.size === b.size && a.signed === b.signed && !!a.bool === !!b.bool;
  return a.k === 'void';
}

/* ---- the usual arithmetic conversions ---- */
export const promote = t => (t.k === 'int' && t.rank < 3 ? T.int : t.k === 'int' && t.en ? T.int : t);
const UNSIGNED = { 3: T.uint, 4: T.ulong, 5: T.ullong };
export function common(a, b) {
  if (a.k === 'flt' || b.k === 'flt') {             // the widest floating type of the two (int + float is float)
    const w = Math.max(a.k === 'flt' ? a.size : 0, b.k === 'flt' ? b.size : 0);
    return w === 16 ? T.ldouble : w === 8 ? T.double : T.float;
  }
  a = promote(a); b = promote(b);
  if (a === b) return a;
  if (a.signed === b.signed) return a.rank >= b.rank ? a : b;
  const [u, s] = a.signed ? [b, a] : [a, b];
  if (u.rank >= s.rank) return u;
  if (s.size > u.size) return s;
  return UNSIGNED[s.rank];
}
