/**
 * The C and C++ front end: preprocessor (#include of the standard headers, #define with arguments, #ifdef…), lexer and
 * a recursive-descent parser for C99 (most of it: no goto, no K&R definitions, no bit fields) and, with { cpp: true },
 * the C++ that algorithms use: classes with methods, constructors and operators, references, new / delete, auto,
 * range-for, structured bindings, lambdas, brace lists, the standard library's templates (vector<int>…), casts,
 * try / catch / throw. Not templates of one's own, inheritance or namespaces other than std.
 * The result is a tree of plain objects for ./interp.js; every statement and expression has the `line` it starts on.
 * parseC(source, { cpp }) throws an Error "line N: …" for a syntax error.
 */
import { AUTO, FILE_T, STD_TYPEDEFS, STL, T, arr, fnType, layout, ptr, ref, stlType } from './types.js';

export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const PUNCT = ['...', '<<=', '>>=', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
  '&=', '^=', '|=', '##'];
const C_KEYWORDS = ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static',
  'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool'];
const CPP_KEYWORDS = ['bool', 'class', 'public', 'private', 'protected', 'new', 'delete', 'this', 'nullptr', 'true', 'false', 'namespace',
  'using', 'template', 'typename', 'operator', 'virtual', 'override', 'friend', 'explicit', 'constexpr', 'mutable', 'try', 'catch',
  'throw', 'noexcept', 'static_cast', 'const_cast', 'reinterpret_cast', 'dynamic_cast', 'final'];

/* ---- lexer ---- */
const ESC = { n: 10, t: 9, r: 13, '0': 0, a: 7, b: 8, f: 12, v: 11, e: 27, '\\': 92, "'": 39, '"': 34, '?': 63 };
/** The character codes of a literal's body, with escapes decoded: \n, \0, \x41, \101 */
function unescape(body, line) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    let c = body.charCodeAt(i);
    if (body[i] === '\\') {
      const e = body[++i];
      if (/[0-7]/.test(e)) { let j = i; while (j < i + 3 && /[0-7]/.test(body[j])) j++; c = parseInt(body.slice(i, j), 8); i = j - 1; }
      else if (e === 'x') { let j = i + 1; while (/[0-9a-fA-F]/.test(body[j] || '')) j++; c = parseInt(body.slice(i + 1, j), 16) & 255; i = j - 1; }
      else if (e in ESC) c = ESC[e];
      else fail(line, 'unknown escape \\' + e);
    } else if (c > 127) {                            // UTF-8, as a C compiler would store it
      const bytes = new TextEncoder().encode(String.fromCodePoint(body.codePointAt(i)));
      if (body.codePointAt(i) > 0xffff) i++;
      out.push(...bytes); continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Tokens of one piece of source: { t: 'id'|'num'|'str'|'chr'|'p'|'dir', v, line, pos, end, bol } (bol: first on its line).
 * `dirs`: a # that starts a line begins a directive (not in a macro's body, where #x makes a string).
 */
function lex(src, line0 = 1, pos0 = 0, dirs = true, cpp = false) {
  const toks = [];
  let i = 0, line = line0, bol = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; bol = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) fail(line, 'the comment /* is never closed with */');
      for (let j = i; j < e; j++) if (src[j] === '\n') line++;
      i = e + 2; continue;
    }
    const start = i, tok = t => { toks.push({ ...t, line, pos: pos0 + start, end: pos0 + i, bol }); bol = false; };
    if (c === '#' && bol && dirs) {                          // a directive: the whole (continued) line
      let j = i;
      while (j < src.length && src[j] !== '\n') { if (src[j] === '\\' && src[j + 1] === '\n') j++; j++; }
      const text = src.slice(i + 1, j);
      toks.push({ t: 'dir', v: text, line, pos: pos0 + i, end: pos0 + j, bol: true });
      line += (text.match(/\n/g) || []).length;
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) { while (/[A-Za-z0-9_]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      while (/[0-9A-Za-z_.]/.test(src[i] || '') || (/[eEpP]/.test(src[i - 1]) && /[+-]/.test(src[i]) && !/^0[xX][0-9a-fA-F]*$/.test(src.slice(start, i - 1)))) i++;
      tok({ t: 'num', v: src.slice(start, i) }); continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== c) fail(line, (c === '"' ? 'the string' : 'the character') + ' is never closed with ' + c);
      i = j + 1;
      const codes = unescape(src.slice(start + 1, j), line);
      if (c === "'") { if (codes.length !== 1) fail(line, "a character constant holds one character: '" + src.slice(start + 1, j) + "'"); tok({ t: 'chr', v: codes[0] }); }
      else tok({ t: 'str', v: codes });
      continue;
    }
    if (cpp && c === ':' && src[i + 1] === ':') { i += 2; tok({ t: 'p', v: '::' }); continue; }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~?:=#'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'unexpected character ' + JSON.stringify(c));
  }
  return toks;
}

/* ---- preprocessor ---- */
const STD_HEADERS = new Set(['stdio.h', 'stdlib.h', 'string.h', 'stdbool.h', 'math.h', 'limits.h', 'ctype.h', 'assert.h', 'stddef.h',
  'stdint.h', 'inttypes.h', 'time.h', 'float.h', 'stdarg.h', 'errno.h', 'iso646.h', 'strings.h', 'unistd.h']);
/** Parts of the C++ library that are not here, and what to use instead */
const NOT_HERE = { array: 'a plain array or a vector', list: 'a vector or a deque', forward_list: 'a vector', tuple: 'a pair, or a struct',
  bitset: 'a vector<bool>', optional: 'a pointer, or a bool next to the value', variant: 'a struct', string_view: 'a string (or const string&)',
  unordered_multimap: 'a map<K, vector<V>>', unordered_multiset: 'a map<T, int> of counts', valarray: 'a vector', span: 'a vector' };
const CPP_HEADERS = new Set(['iostream', 'vector', 'string', 'map', 'set', 'unordered_map', 'unordered_set', 'queue', 'stack', 'deque',
  'algorithm', 'numeric', 'utility', 'functional', 'climits', 'cstdio', 'cstdlib', 'cstring', 'cmath', 'cassert', 'cctype', 'cstdint',
  'iomanip', 'limits', 'bits/stdc++.h', 'cfloat', 'ctime', 'iterator', 'stdexcept', 'exception', 'tuple', 'array', 'list', 'sstream']);
const PREDEFINED = {
  NULL: '((void*)0)', true: '1', false: '0', bool: '_Bool', EOF: '(-1)', EXIT_SUCCESS: '0', EXIT_FAILURE: '1',
  INT_MAX: '2147483647', INT_MIN: '(-2147483647-1)', UINT_MAX: '4294967295U', LONG_MAX: '9223372036854775807L',
  LONG_MIN: '(-9223372036854775807L-1)', ULONG_MAX: '18446744073709551615UL', LLONG_MAX: '9223372036854775807LL',
  LLONG_MIN: '(-9223372036854775807LL-1)', ULLONG_MAX: '18446744073709551615ULL', SIZE_MAX: '18446744073709551615UL',
  CHAR_MAX: '127', CHAR_MIN: '(-128)', SCHAR_MAX: '127', SCHAR_MIN: '(-128)', UCHAR_MAX: '255', SHRT_MAX: '32767',
  SHRT_MIN: '(-32768)', USHRT_MAX: '65535', CHAR_BIT: '8', RAND_MAX: '2147483647', INT32_MAX: '2147483647',
  INT32_MIN: '(-2147483647-1)', INT64_MAX: '9223372036854775807L', INT64_MIN: '(-9223372036854775807L-1)', UINT32_MAX: '4294967295U',
  INFINITY: '(1e999f)', NAN: '(0.0f/0.0f)', HUGE_VAL: '(1e999)', M_PI: '3.14159265358979323846', M_E: '2.7182818284590452354',
  DBL_MAX: '1.7976931348623157e308', DBL_MIN: '2.2250738585072014e-308', FLT_MAX: '3.40282347e38f', FLT_MIN: '1.17549435e-38f',
  DBL_EPSILON: '2.2204460492503131e-16', FLT_EPSILON: '1.19209290e-7f',
};

function preprocess(src, cpp) {
  const macros = new Map();
  for (const [k, v] of Object.entries(PREDEFINED)) if (!cpp || !['true', 'false', 'bool'].includes(k)) macros.set(k, { body: lex(v), params: null });
  const out = [], conds = [];                      // conds: { on, done } for each open #if
  const live = () => conds.every(c => c.on);
  const toks = lex(src, 1, 0, true, cpp);
  /** #if's expression: defined(X), numbers, macros, ! && || == != < > <= >= + - * / % and parentheses */
  const ifValue = (body, line) => {
    const ts = lex(body, line);
    const t2 = [];
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].v === 'defined') {
        const par = ts[i + 1] && ts[i + 1].v === '(';
        const nm = ts[i + (par ? 2 : 1)];
        t2.push({ t: 'num', v: macros.has(nm && nm.v) ? '1' : '0' }); i += par ? 3 : 1;
      } else t2.push(ts[i]);
    }
    const ex = expand(t2, new Set()).map(t => (t.t === 'id' ? { t: 'num', v: '0' } : t));
    let k = 0;
    const peek = () => ex[k] && ex[k].v, next = () => ex[k++];
    const prim = () => {
      const t = next();
      if (!t) fail(line, '#if needs an expression');
      if (t.v === '(') { const v = or(); next(); return v; }
      if (t.v === '!') return prim() ? 0 : 1;
      if (t.v === '-') return -prim();
      if (t.t === 'num') return parseInt(t.v, /^0x/i.test(t.v) ? 16 : 10) || 0;
      if (t.t === 'chr') return t.v;
      fail(line, 'cannot work out #if ' + body.trim());
    };
    const bin = (sub, ops) => () => {
      let v = sub();
      while (ops[peek()]) { const f = ops[next().v]; v = f(v, sub()); }
      return v;
    };
    const mul = bin(prim, { '*': (a, b) => a * b, '/': (a, b) => Math.trunc(a / b), '%': (a, b) => a % b });
    const add = bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
    const rel = bin(add, { '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b) });
    const eq = bin(rel, { '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
    const and = bin(eq, { '&&': (a, b) => +(a && b) });
    const or = bin(and, { '||': (a, b) => +(a || b) });
    return or();
  };

  /** Expands macros in a token list; `off` holds the macros being expanded (no recursion). Tokens keep the invocation's place. */
  function expand(ts, off) {
    const res = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], m = t.t === 'id' && !off.has(t.v) && macros.get(t.v);
      if (!m) { res.push(t); continue; }
      const at = b => ({ ...b, line: t.line, pos: t.pos, end: t.end, bol: false });
      if (!m.params) { res.push(...expand(m.body.map(at), new Set([...off, t.v]))); continue; }
      if (!ts[i + 1] || ts[i + 1].v !== '(') { res.push(t); continue; }   // a function-like macro's name without ( is just a name
      const args = [[]]; let depth = 0, j = i + 2;
      for (; j < ts.length; j++) {
        const v = ts[j].t === 'p' ? ts[j].v : null;
        if (v === '(' || v === '[' || v === '{') depth++;
        else if ((v === ')' || v === ']' || v === '}') && depth) depth--;
        else if (v === ')') break;
        else if (v === ',' && !depth) { args.push([]); continue; }
        args[args.length - 1].push(ts[j]);
      }
      if (j >= ts.length) fail(t.line, 'the macro ' + t.v + '( is never closed with )');
      if (args.length === 1 && !args[0].length && !m.params.length) args.pop();
      if (args.length !== m.params.length && !m.variadic) fail(t.line, `the macro ${t.v} takes ${m.params.length} arguments, not ${args.length}`);
      const last = { ...t, end: ts[j].end };
      const body = [];
      for (let b = 0; b < m.body.length; b++) {
        const bt = m.body[b], pi = bt.t === 'id' ? m.params.indexOf(bt.v) : -1;
        if (bt.v === '#' && bt.t === 'p' && m.body[b + 1] && m.params.includes(m.body[b + 1].v)) {   // #x: the argument as a string
          const a = args[m.params.indexOf(m.body[++b].v)] || [];
          body.push({ t: 'str', v: [...new TextEncoder().encode(a.map(x => x.text || srcOf(x)).join(' '))] });
        } else if (pi >= 0) body.push(...(m.body[b + 1] && m.body[b + 1].v === '##' || (body.length && body[body.length - 1].paste) ? args[pi] : expand(args[pi] || [], off)));
        else if (bt.v === '__VA_ARGS__') args.slice(m.params.length).forEach((a, ai) => { if (ai) body.push({ t: 'p', v: ',' }); body.push(...expand(a, off)); });
        else if (bt.v === '##' && bt.t === 'p') {
          const left = body.pop(), right = m.body[++b], ri = right.t === 'id' ? m.params.indexOf(right.v) : -1;
          const rt = ri >= 0 ? (args[ri] || []) : [right];
          const glued = lex(String(left ? srcOf(left) : '') + (rt[0] ? srcOf(rt[0]) : ''), t.line);
          body.push(...glued, ...rt.slice(1));
        } else body.push(bt);
      }
      res.push(...expand(body.map(at), new Set([...off, t.v])).map((x, xi, all) => (xi === all.length - 1 ? { ...x, end: last.end } : x)));
      i = j;
    }
    return res;
  }
  const srcOf = t => (t.t === 'num' || t.t === 'id' || t.t === 'p' ? t.v : t.t === 'chr' ? "'" + String.fromCharCode(t.v) + "'"
    : '"' + new TextDecoder().decode(new Uint8Array(t.v)) + '"');

  let pending = [];
  const flush = () => { if (pending.length) { out.push(...expand(pending, new Set())); pending = []; } };
  for (const t of toks) {
    if (t.t !== 'dir') { if (live()) pending.push(t); continue; }
    const m = /^\s*(\w*)\s*([\s\S]*)$/.exec(t.v), d = m[1], rest = m[2].replace(/\\\n/g, ' ').replace(/\/\/.*$|\/\*[\s\S]*?\*\//g, ' ').trim();
    if (d === 'ifdef' || d === 'ifndef') { conds.push({ on: macros.has(rest.split(/\s/)[0]) === (d === 'ifdef'), done: false }); conds.at(-1).done = conds.at(-1).on; continue; }
    if (d === 'if') { const on = live() && !!ifValue(rest, t.line); conds.push({ on, done: on }); continue; }
    if (d === 'elif') { const c = conds.at(-1); if (!c) fail(t.line, '#elif without #if'); c.on = !c.done && !!ifValue(rest, t.line); c.done = c.done || c.on; continue; }
    if (d === 'else') { const c = conds.at(-1); if (!c) fail(t.line, '#else without #if'); c.on = !c.done; c.done = true; continue; }
    if (d === 'endif') { if (!conds.pop()) fail(t.line, '#endif without #if'); continue; }
    if (!live()) continue;
    flush();
    if (d === 'include') {
      const h = /^<([^>]+)>$/.exec(rest);
      if (!h) fail(t.line, '#include ' + rest + ': only the standard headers (' + (cpp ? '<iostream>, <vector>, <map>…' : '<stdio.h>, <stdlib.h>, <string.h>…') + ') are available here');
      if (!STD_HEADERS.has(h[1]) && !(cpp && CPP_HEADERS.has(h[1]))) fail(t.line, '#include <' + h[1] + '> is not available here');
    } else if (d === 'define') {
      const dm = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*([\s\S]*)$/.exec(rest);
      if (!dm) fail(t.line, '#define needs a name');
      const params = dm[2] ? dm[3].split(',').map(s => s.trim()).filter(Boolean) : null;
      const variadic = !!params && params.at(-1) === '...';
      if (variadic) params.pop();
      macros.set(dm[1], { params, variadic, body: lex(dm[4], t.line, 0, false, cpp) });
    } else if (d === 'undef') macros.delete(rest);
    else if (d === 'error') fail(t.line, '#error ' + rest);
    else if (d !== 'pragma' && d !== 'line' && d !== '') fail(t.line, 'unknown directive #' + d);
  }
  if (conds.length) fail(toks.length ? toks.at(-1).line : 1, '#if without #endif');
  flush();
  return cpp ? qualify(out) : out;
}

/**
 * C++ names: std::x is x (as after using namespace std), and A::b (a member defined outside its class, a static, an enum
 * class's constant) becomes one name token.
 */
function qualify(ts) {
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.t === 'p' && t.v === '::' && ts[i + 1] && ts[i + 1].t === 'id' && (!out.length || out.at(-1).t !== 'id' || out.at(-1).v === 'std')) {
      if (out.length && out.at(-1).v === 'std' && out.at(-1).t === 'id') out.pop();
      continue;                                    // std::x and ::x
    }
    if (t.t === 'p' && t.v === '::' && out.length && out.at(-1).t === 'id' && ts[i + 1]) {
      const prev = out.pop(), n = ts[i + 1], tilde = n.t === 'p' && n.v === '~' && ts[i + 2] && ts[i + 2].t === 'id';
      const name = tilde ? '~' + ts[i + 2].v : n.v;
      out.push({ ...prev, v: prev.v + '::' + name, end: (tilde ? ts[i + 2] : n).end });
      i += tilde ? 2 : 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/* ---- parser ---- */
/**
 * @returns {{ items: any[], structs: Map, cpp: boolean }} items: { k: 'func', name, type, params, body, line, owner?, kind? }
 *   (owner: the class of a method; kind: 'ctor' | 'dtor' | 'method') and { k: 'decl', list: [{ name, type, init, storage, line }] }
 */
export function parseC(src, { cpp = false } = {}) {
  const toks = preprocess(src, cpp);
  const KEYWORDS = new Set(cpp ? [...C_KEYWORDS, ...CPP_KEYWORDS] : C_KEYWORDS);
  let i = 0;
  const lastLine = toks.length ? toks.at(-1).line : 1;
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || t.t === 'id') && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(lastLine, 'the program ends too early (a missing } or ;?)'); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  const show = t => (!t ? 'the end of the program' : t.t === 'str' ? 'a string' : t.t === 'chr' ? 'a character' : "'" + t.v + "'");
  const expect = (v, what) => {
    if (eat(v)) return;
    const t = peek(), prev = toks[i - 1];
    if (v === ';' && prev && (!t || t.line > prev.line)) fail(prev.line, "expected ';' at the end of the line");
    fail(t ? t.line : lastLine, `expected '${v}'${what ? ' ' + what : ''} before ${show(t)}`);
  };
  const ident = what => { const t = peek(); if (!t || t.t !== 'id' || KEYWORDS.has(t.v)) fail(t ? t.line : lastLine, 'expected ' + (what || 'a name') + ' before ' + show(t)); i++; return t.v; };
  const textOf = (a, b) => src.slice(a.pos, b.end);
  /** The closing > of a template's arguments, also out of >> (vector<vector<int>>) */
  const closeAngle = () => {
    if (eat('>')) return;
    const t = peek();
    if (t && t.t === 'p' && (t.v === '>>' || t.v === '>=' || t.v === '>>=')) { toks[i] = { ...t, v: t.v.slice(1) }; return; }
    fail(t ? t.line : lastLine, "expected '>' to close the template's arguments before " + show(t));
  };

  const typedefs = new Map(Object.entries(STD_TYPEDEFS));
  const structs = new Map([['FILE', FILE_T]]), enums = new Map(), enumConsts = new Map();
  const scopes = [new Set()];                      // names declared as variables, which hide a typedef of the same name
  const items = [];
  const isTypedef = n => typedefs.has(n) && !scopes.some(s => s.has(n));
  const TYPE_WORDS = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'struct', 'union',
    'enum', 'const', 'volatile', 'restrict', 'static', 'extern', 'typedef', 'register', 'auto', 'inline', ...(cpp ? ['bool', 'class', 'constexpr', 'mutable', 'typename'] : [])]);
  const isStl = n => cpp && Object.prototype.hasOwnProperty.call(STL, n) && !scopes.some(s => s.has(n));
  const isTypeStart = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && (TYPE_WORDS.has(t.v) || isTypedef(t.v) || isStl(t.v)); };

  /** Integer constant expressions (array sizes, case labels, enum values, bit widths) */
  const constValue = (e, what) => {
    const v = constFold(e);
    if (v == null) fail(e.line, what + ' must be a constant');
    return v;
  };

  /** vector<int>, map<string, vector<int>>, string, pair<int, int>, greater<int>, function<int(int)> */
  function stlSpec(name) {
    const [min, max] = STL[name];
    const args = [];
    if (is('<')) {
      i++;
      if (!is('>')) do args.push(typeName()); while (eat(','));   // function<int(int, int)>: its argument is a function type
      closeAngle();
    } else if (min > 0) fail(line(), name + ' needs its type in < >: ' + name + (name.includes('map') ? '<string, int>' : '<int>'));
    if (args.length < min || args.length > max) fail(line(), `${name} takes ${min === max ? min : min + ' to ' + max} type${max === 1 ? '' : 's'} in < >`);
    return stlType(name, name === 'priority_queue' ? args.slice(0, 1).concat(args[2] ? [args[2]] : []) : args);
  }

  function declSpecs() {
    let storage = null, base = null, sign = null, size = null, longs = 0, sawInt = false;
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'id') break;
      const v = t.v;
      if (v === 'const' || v === 'volatile' || v === 'restrict' || v === 'inline' || v === 'register' || (v === 'auto' && !cpp)) { i++; continue; }
      if (cpp && (v === 'constexpr' || v === 'mutable' || v === 'typename' || v === 'explicit' || v === 'virtual')) { i++; continue; }
      if (v === 'static' || v === 'extern' || v === 'typedef') { i++; storage = v; continue; }
      if (v === 'signed' || v === 'unsigned') { i++; sign = v; continue; }
      if (v === 'short') { i++; size = 'short'; continue; }
      if (v === 'long') { i++; longs++; continue; }
      if (v === 'int') { i++; sawInt = true; continue; }
      if (v === 'char' || v === 'void' || v === 'float' || v === 'double' || v === '_Bool' || (cpp && v === 'bool')) { if (base) fail(t.line, 'two types: ' + base + ' and ' + v); i++; base = v === 'bool' ? '_Bool' : v; continue; }
      if (cpp && v === 'auto') { if (base) fail(t.line, 'two types in one declaration'); i++; base = AUTO; continue; }
      if (v === 'struct' || v === 'union' || (cpp && v === 'class')) { if (base) fail(t.line, 'two types in one declaration'); i++; base = structSpec(v === 'union', v === 'class'); continue; }
      if (v === 'enum') { if (base) fail(t.line, 'two types in one declaration'); i++; base = enumSpec(); continue; }
      if (!base && !sign && !size && !longs && !sawInt && isStl(v)) { i++; base = stlSpec(v); continue; }
      if (cpp && !base && Object.prototype.hasOwnProperty.call(NOT_HERE, v) && (is('<', 1) || v === 'string_view')) fail(t.line, `std::${v} is not supported here (use ${NOT_HERE[v]})`);
      if (!base && !sign && !size && !longs && !sawInt && isTypedef(v)) { i++; base = typedefs.get(v); continue; }
      break;
    }
    let t;
    if (base && typeof base === 'object') t = base;
    else if (base === 'void') t = T.void;
    else if (base === '_Bool') t = T.bool;
    else if (base === 'float') t = T.float;
    else if (base === 'double') t = longs ? T.ldouble : T.double;
    else if (base === 'char') t = sign === 'unsigned' ? T.uchar : sign === 'signed' ? T.schar : T.char;
    else if (size === 'short') t = sign === 'unsigned' ? T.ushort : T.short;
    else if (longs >= 2) t = sign === 'unsigned' ? T.ullong : T.llong;
    else if (longs === 1) t = sign === 'unsigned' ? T.ulong : T.long;
    else if (sign || sawInt) t = sign === 'unsigned' ? T.uint : T.int;
    else return null;
    return { type: t, storage };
  }

  function structSpec(union, isClass) {
    const l = line();
    let tag = null;
    if (peek() && peek().t === 'id' && !is('{') && !is(':')) tag = ident('a struct name');
    const key = cpp ? (union ? 'union ' : 'struct ') + (tag || '#' + i) : (union ? 'union ' : 'struct ') + (tag || '#' + i);
    let s = tag && structs.get(key);
    if (!s) {
      s = { k: 'struct', tag, union, fields: [], size: 0, align: 1, done: false };
      if (cpp) Object.assign(s, { cls: true, methods: new Map(), ctors: [], dtor: null, statics: new Map(), inits: new Map() });
      if (tag) { structs.set(key, s); if (cpp) typedefs.set(tag, s); }
    }
    if (cpp && is(':') && !is('::')) fail(l, 'inheritance (' + (isClass ? 'class' : 'struct') + ' ' + tag + ' : …) is not supported yet');
    if (eat('{')) {
      if (s.done) fail(l, (union ? 'union ' : 'struct ') + tag + ' is defined twice');
      const fields = [];
      if (cpp) classBody(s, fields, isClass);
      else while (!eat('}')) {
        const sp = declSpecs();
        if (!sp) fail(line(), 'expected a field type before ' + show(peek()));
        do field(sp, null, fields); while (eat(','));
        expect(';', 'after the field');
      }
      s.fields = fields;
      layout(s);
    }
    return s;
  }
  function field(sp, s, fields) {
    const d = declarator(false);
    let ft = d.apply(sp.type);
    if (eat(':')) fail(d.line, 'bit fields are not supported');
    if (ft.k === 'arr' && ft.n != null && typeof ft.n !== 'number') ft = arr(ft.of, constValue(ft.n, 'a field\'s array size'));
    if (ft.k === 'fn') fail(d.line, 'a struct cannot hold a function (a function pointer can: (*' + d.name + ')(…))');
    if (ft.k === 'struct' && !ft.done && ft !== s) fail(d.line, 'the field ' + d.name + ' has an incomplete type (use a pointer: ' + typeLabel(ft) + ' *' + d.name + ')');
    if (ft === s && s) fail(d.line, 'a ' + (s.tag || 'struct') + ' cannot contain a ' + (s.tag || 'struct') + ' (a pointer to one, ' + s.tag + ' *' + d.name + ', is fine)');
    if (ft.k === 'auto') fail(d.line, 'a field cannot be auto');
    if (!d.name) { if (ft.k === 'struct') { fields.push(...ft.fields.map(f => ({ ...f, anon: ft }))); return; } fail(d.line, 'a field needs a name'); }
    if (fields.some(f => f.name === d.name)) fail(d.line, 'two fields named ' + d.name);
    if (s && sp.storage === 'static') {            // a static member: one variable for the whole class
      s.statics.set(d.name, { name: s.tag + '::' + d.name, type: ft, init: eat('=') ? initializer() : null, line: d.line });
      return;
    }
    fields.push({ name: d.name, type: ft, off: 0 });
    if (s && (is('=') || is('{'))) s.inits.set(d.name, eat('=') ? initializer() : initializer());   // int count = 0; vector<int> v{1, 2};
  }
  /** The members of a C++ class: fields, methods, constructors, a destructor, static members, access labels */
  function classBody(s, fields, isClass) {
    void isClass;
    while (!eat('}')) {
      const l = line();
      if ((is('public') || is('private') || is('protected')) && is(':', 1)) { i += 2; continue; }
      if (eat(';')) continue;
      if (is('template')) fail(l, 'templates (other than the standard library\'s: vector, map…) are not supported');
      if (is('using') || is('typedef')) { aliasDecl(); continue; }
      if (eat('friend')) { topLevel(); continue; }   // a friend function: an ordinary function
      while (is('explicit') || is('virtual') || is('inline') || is('constexpr')) i++;
      if ((is(s.tag) && is('(', 1)) || (is('~') && is(s.tag, 1) && is('(', 2))) { const dtor = eat('~'); i++; ctorOrDtor(s, dtor, l); continue; }
      const sp = declSpecs();
      if (!sp) fail(l, 'expected a member (a field or a method) of ' + s.tag + ' before ' + show(peek()));
      const save = i, d = declarator(false), type = d.apply(sp.type);
      if (type.k === 'fn') { method(s, d, type, sp, l); continue; }
      i = save;
      do field(sp, s, fields); while (eat(','));
      expect(';', 'after the field');
    }
  }
  /** const, override, noexcept after a method's parameters; = 0 is an abstract method (not supported) */
  function methodSuffix() {
    let isConst = false;
    for (;;) {
      if (eat('const')) { isConst = true; continue; }
      if (eat('override') || eat('final')) continue;
      if (eat('noexcept')) { if (is('(')) { i++; expression(); expect(')'); } continue; }
      if (is('->')) { i++; typeName(); continue; }   // a trailing return type
      return isConst;
    }
  }
  function method(s, d, type, sp, l) {
    methodSuffix();
    const def = { k: 'func', name: d.name, type, params: params(d, type), line: d.line, owner: s, kind: 'method', isStatic: sp.storage === 'static', body: null };
    if (eat('=')) {
      if (eat('0')) fail(l, 'abstract (= 0) methods need inheritance, which is not supported yet');
      if (eat('default') || eat('delete')) { expect(';'); return; }
    }
    if (eat(';')) { addMethod(s, def); return; }   // defined later: int Stack::size() const { … }
    def.body = withParams(def.params, () => block());
    addMethod(s, def);
  }
  const addMethod = (s, def) => {
    if (def.kind === 'ctor') { s.ctors.push(def); return; }
    if (def.kind === 'dtor') { s.dtor = def; return; }
    const list = s.methods.get(def.name) || [];
    const prev = list.find(x => !x.body && sameParams(x, def));
    if (prev) Object.assign(prev, { ...def, line: prev.line }); else list.push(def);
    s.methods.set(def.name, list);
  };
  const sameParams = (a, b) => a.params.length === b.params.length;
  /** X(int a, int b) : a(a), b{b} { … } and ~X() { … }, inside the class or as X::X(…) outside it (its name already read) */
  function ctorOrDtor(s, dtor, l) {
    expect('(');
    const ps = paramList();
    const type = fnType(T.void, ps.list.map(p => p.type), ps.variadic);
    methodSuffix();
    const def = { k: 'func', name: (dtor ? '~' : '') + s.tag, type, params: ps.list.map((p, k) => ({ name: p.name || 'p' + k, type: p.type, def: p.def })), line: l, owner: s, kind: dtor ? 'dtor' : 'ctor', inits: [], body: null };
    if (eat('=')) { if (!eat('default') && !eat('delete')) fail(l, 'expected default or delete after ='); expect(';'); def.body = { k: 'block', items: [], line: l }; addCtor(s, def); return; }
    if (eat(':')) {                                // the member initializer list
      do {
        const fl = line(), fname = ident('a member to initialize');
        let args;
        if (eat('(')) { args = []; if (!eat(')')) { do args.push(assignment()); while (eat(',')); expect(')'); } }
        else if (is('{')) args = [initializer()];
        else fail(fl, `expected ( or { after ${fname} in the initializer list`);
        def.inits.push({ name: fname, args, line: fl });
      } while (eat(','));
    }
    if (eat(';')) { addCtor(s, def); return; }
    def.body = withParams(def.params, () => block());
    addCtor(s, def);
  }
  const addCtor = (s, def) => {
    if (def.kind === 'dtor') { s.dtor = def; return; }
    const prev = s.ctors.find(x => !x.body && sameParams(x, def));
    if (prev) Object.assign(prev, { ...def, line: prev.line }); else s.ctors.push(def);
  };
  const withParams = (ps, fn) => { scopes.push(new Set(ps.map(p => p.name))); try { return fn(); } finally { scopes.pop(); } };
  const params = (d, type) => (d.params || []).map((p, k) => ({ name: p.name || 'p' + k, type: type.params[k], def: p.def }));
  const typeLabel = s => (s.union ? 'union ' : 'struct ') + (s.tag || '');
  /** using X = type; typedef type X; using namespace std; */
  function aliasDecl() {
    const l = line();
    if (eat('using')) {
      if (eat('namespace')) { const n = ident('a namespace'); if (n !== 'std') fail(l, 'only the namespace std is known'); expect(';'); return; }
      const name = ident('a name'); expect('=', 'in using … = …');
      typedefs.set(name, typeName()); expect(';'); return;
    }
    i++;
    const sp = declSpecs();
    if (!sp) fail(l, 'expected a type after typedef');
    do { const d = declarator(false); typedefs.set(d.name, d.apply(sp.type)); } while (eat(','));
    expect(';');
  }

  function enumSpec() {
    const scoped = cpp && (eat('class') || eat('struct'));   // enum class Color { Red }: its constants are Color::Red
    let tag = null;
    if (peek() && peek().t === 'id' && !is('{') && !is(':')) tag = ident('an enum name');
    if (cpp && eat(':')) typeName();               // enum Color : int
    const t = { ...T.int, en: tag || '(anonymous)', consts: new Map() };
    if (tag && enums.has(tag) && !is('{')) return enums.get(tag);
    if (tag) { enums.set(tag, t); if (cpp) typedefs.set(tag, t); }
    if (eat('{')) {
      let v = 0;
      while (!eat('}')) {
        const name = ident('an enum constant');
        if (eat('=')) v = constValue(assignment(), 'an enum value');
        enumConsts.set(scoped ? tag + '::' + name : name, v); if (!scoped && cpp && tag) enumConsts.set(tag + '::' + name, v);
        t.consts.set(v, t.consts.get(v) || (scoped ? tag + '::' + name : name));
        v++;
        if (!eat(',')) { expect('}', 'after the enum constants'); break; }
      }
    }
    return t;
  }

  const OPERATORS = ['()', '[]', '<=', '>=', '==', '!=', '<<', '>>', '+=', '-=', '*=', '/=', '++', '--', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '=', '&', '|', '^', '~'];
  /** operator< operator() operator[] … after the word operator */
  function operatorName(prefix) {
    const t = peek();
    if (is('(') && is(')', 1)) { i += 2; return prefix + '()'; }
    if (is('[') && is(']', 1)) { i += 2; return prefix + '[]'; }
    if (t && t.t === 'p' && OPERATORS.includes(t.v)) { i++; return prefix + t.v; }
    fail(line(), 'expected an operator after operator');
  }

  /**
   * A declarator: the name and how it changes the base type. `int *a[3]`: a, array of 3 pointers to int.
   * Returns { name, line, apply(base) → type, params (of the function it declares, for a definition) }.
   * In C++, `name(` followed by something that is not a type is a constructor's arguments, not parameters: it stops there.
   */
  function declarator(abstract) {
    const mods = [];
    for (;;) {
      if (eat('*')) { mods.push('*'); while (is('const') || is('volatile') || is('restrict')) i++; continue; }
      if (cpp && (eat('&') || eat('&&'))) { mods.push('&'); continue; }
      break;
    }
    let name = null, inner = null, l = line(), params = null;
    if (cpp && peek() && peek().t === 'id' && (peek().v === 'operator' || peek().v.endsWith('::operator'))) { name = operatorName(next().v); }
    else if (peek() && peek().t === 'id' && !KEYWORDS.has(peek().v) && !isTypeStart()) name = ident();
    else if (is('(') && (is('*', 1) || is('(', 1) || is('[', 1) || (cpp && is('&', 1)) || (peek(1) && peek(1).t === 'id' && !isTypeStart(1) && !abstract && !cpp))) {
      i++; inner = declarator(abstract); expect(')'); name = inner.name; l = inner.line;
    }
    if (!name && !abstract && !is(')') && !is(',')) {
      if (!(is(';') || is('=') || is('['))) fail(line(), 'expected a name before ' + show(peek()));
    }
    const suffixes = [];
    for (;;) {
      if (eat('[')) {
        while (is('static') || is('const')) i++;
        if (eat(']')) { suffixes.push({ arr: true, n: null }); continue; }
        const e = assignment();
        expect(']', 'after the array size');
        const c = constFold(e);
        suffixes.push({ arr: true, n: c != null ? c : e });
      } else if (is('(') && !(cpp && !abstract && name && !suffixes.length && !is(')', 1) && !isTypeStart(1) && !is('...', 1))) {
        i++;
        const ps = paramList();
        suffixes.push({ fn: true, ...ps });
        if (!params && !inner) params = ps.list;
      } else break;
    }
    if (inner && inner.params && !params) params = null;
    const apply = base => {
      let t = base;
      for (const m of mods) t = m === '*' ? ptr(t) : ref(t);
      for (let k = suffixes.length - 1; k >= 0; k--) {
        const sfx = suffixes[k];
        if (sfx.arr) {
          if (t.k === 'fn') fail(l, 'an array of functions is not allowed (use function pointers)');
          if (t.k === 'ref') fail(l, 'an array of references is not allowed');
          if (typeof sfx.n === 'number' && sfx.n < 0) fail(l, 'an array size cannot be negative');
          t = arr(t, sfx.n);
        } else {
          if (t.k === 'arr' || t.k === 'fn') fail(l, 'a function cannot return ' + (t.k === 'arr' ? 'an array' : 'a function'));
          t = fnType(t, sfx.list.map(p => p.type), sfx.variadic, sfx.proto);
        }
      }
      return inner ? inner.apply(t) : t;
    };
    return { name, line: l, apply, params: inner ? inner.params : params, isFn: !inner && suffixes.length && suffixes[0].fn };
  }

  function paramList() {
    const list = [];
    if (eat(')')) return { list, variadic: false, proto: !!cpp };
    if (is('void') && is(')', 1)) { i += 2; return { list, variadic: false, proto: true }; }
    let variadic = false;
    do {
      if (eat('...')) { variadic = true; break; }
      const sp = declSpecs();
      if (!sp) fail(line(), 'expected a parameter type before ' + show(peek()));
      const d = declarator(true);
      let pt = d.apply(sp.type);
      if (pt.k === 'arr') pt = ptr(pt.of);         // int a[] and int a[10] are int *a
      else if (pt.k === 'fn') pt = ptr(pt);
      const p = { name: d.name, type: pt, line: d.line };
      if (cpp && eat('=')) p.def = assignment();   // a default argument
      list.push(p);
    } while (eat(','));
    expect(')', 'after the parameters');
    return { list, variadic, proto: true };
  }

  function typeName() {
    const sp = declSpecs();
    if (!sp) fail(line(), 'expected a type before ' + show(peek()));
    return declarator(true).apply(sp.type);
  }

  /* initializers: an expression, or { a, b, [2] = c, .f = d } */
  function initializer() {
    if (!is('{')) return assignment();
    const l = line(); i++;
    const items = [];
    while (!eat('}')) {
      const desig = [];
      for (;;) {
        if (eat('.')) desig.push({ field: ident('a field name') });
        else if (is('[') && !cpp) { i++; desig.push({ index: constValue(conditional(), 'an index in an initializer') }); expect(']'); }
        else break;
      }
      if (desig.length) expect('=', 'after the designator');
      items.push({ desig, val: initializer() });
      if (!eat(',')) { expect('}', 'to close the initializer'); break; }
    }
    return { k: 'init', items, line: l };
  }

  /* ---- expressions ---- */
  const node = (k, l, o) => ({ k, line: l, ...o });
  function expression() {
    let e = assignment();
    while (is(',')) { const l = line(); i++; e = node('comma', l, { l: e, r: assignment() }); }
    return e;
  }
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);
  function assignment() {
    if (cpp && is('throw')) { const l = line(); i++; return node('throw', l, { e: is(';') || is(')') ? null : assignment() }); }
    const start = peek(), l = line(), lhs = conditional();
    const t = peek();
    if (t && t.t === 'p' && ASSIGN.has(t.v)) { i++; return node('assign', l, { op: t.v, l: lhs, r: cpp && is('{') ? initializer() : assignment(), text: textOf(start, toks[i - 1]) }); }
    return lhs;
  }
  function conditional() {
    const c = binary(0);
    if (!is('?')) return c;
    const l = line(); i++;
    const a = expression(); expect(':', 'in the ?: expression');
    return node('cond', l, { c, a, b: conditional() });
  }
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function binary(level) {
    if (level === LEVELS.length) return cast();
    let e = binary(level + 1);
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'p' || !LEVELS[level].includes(t.v)) return e;
      i++;
      const r = binary(level + 1);
      e = node(t.v === '&&' ? 'and' : t.v === '||' ? 'or' : 'bin', t.line, { op: t.v, l: e, r });
    }
  }
  function cast() {
    if (is('(') && isTypeStart(1) && !(cpp && (is('(', 2) || is('{', 2)))) {   // (int)x, not (string("a") < s)
      const l = line(); i++;
      const t = typeName(); expect(')', 'after the type');
      if (is('{')) return postfix(node('clit', l, { t, init: initializer() }));
      return node('cast', l, { t, e: cast() });
    }
    return unary();
  }
  function unary() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, 'expected an expression at the end of the program');
    if (t.t === 'p') {
      if (t.v === '++' || t.v === '--') { i++; return node('pre', l, { op: t.v, e: unary() }); }
      if (t.v === '&') { i++; return node('addr', l, { e: cast() }); }
      if (t.v === '*') { i++; return node('deref', l, { e: cast() }); }
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') { i++; return node('un', l, { op: t.v, e: cast() }); }
    }
    if (t.t === 'id' && t.v === 'sizeof') {
      i++;
      if (is('(') && isTypeStart(1)) { i++; const ty = typeName(); expect(')'); return node('sizeofT', l, { t: ty }); }
      return node('sizeofE', l, { e: unary() });
    }
    if (cpp && t.t === 'id' && t.v === 'delete') {
      i++;
      const isArr = is('[') && is(']', 1);
      if (isArr) i += 2;
      return node('delete', l, { e: cast(), arr: isArr });
    }
    if (cpp && t.t === 'id' && t.v === 'new') return postfix(newExpr());
    return postfix(primary());
  }
  /** new T, new T(args), new T{…}, new T[n] */
  function newExpr() {
    const l = line(); i++;
    const sp = declSpecs();
    if (!sp) fail(l, 'expected a type after new');
    let t = sp.type;
    while (eat('*')) t = ptr(t);
    if (eat('[')) { const n = expression(); expect(']'); return node('new', l, { t, n }); }
    if (eat('(')) { const args = []; if (!eat(')')) { do args.push(assignment()); while (eat(',')); expect(')'); } return node('new', l, { t, args }); }
    if (is('{')) return node('new', l, { t, init: initializer() });
    return node('new', l, { t, args: null });
  }
  function args() {
    const out = [];
    if (!eat(')')) { do out.push(cpp && is('{') ? initializer() : assignment()); while (eat(',')); expect(')', 'after the arguments'); }
    return out;
  }
  function postfix(e) {
    for (;;) {
      const l = line();
      if (eat('[')) { const ix = expression(); expect(']', 'after the index'); e = node('index', l, { a: e, i: ix }); }
      else if (is('(')) {
        const start = toks[i]; i++;
        const a = args();
        e = node('call', e.line, { f: e, args: a, text: textOf(start, toks[i - 1]) });
      }
      else if (eat('.')) e = node('member', l, { e, name: memberName(), arrow: false });
      else if (eat('->')) e = node('member', l, { e, name: memberName(), arrow: true });
      else if (is('++') || is('--')) e = node('post', l, { op: next().v, e });
      else return e;
    }
  }
  const memberName = () => (cpp && is('operator') ? operatorName(next().v) : cpp && eat('~') ? '~' + ident('a destructor name') : ident('a field name'));
  /** [&](int a, int b) { return a < b; } */
  function lambda() {
    const l = line(); i++;                         // [
    const caps = [];
    while (!eat(']')) {
      if (eat('&')) caps.push(peek() && peek().t === 'id' && !is(',', 0) && !is(']', 0) ? { name: ident(), ref: true } : { all: true, ref: true });
      else if (eat('=')) caps.push({ all: true, ref: false });
      else if (eat('this')) caps.push({ name: 'this', ref: true });
      else caps.push({ name: ident('a captured name'), ref: false });
      if (!eat(',')) { expect(']', 'after the captures'); break; }
    }
    let ps = { list: [], variadic: false };
    if (eat('(')) ps = paramList();
    while (eat('mutable') || eat('constexpr')) { /* nothing to do */ }
    let ret = AUTO;
    if (eat('->')) ret = typeName();
    const plist = ps.list.map((p, k) => ({ name: p.name || 'p' + k, type: p.type, def: p.def }));
    const body = withParams(plist, () => block());
    return node('lambda', l, { caps, params: plist, ret, body });
  }
  /** numeric_limits<int>::max() and the others: a constant */
  function limits(l) {
    i++;                                           // <
    const ty = typeName(); closeAngle();
    const what = ident('max, min or lowest');
    expect('('); expect(')');
    if (ty.k === 'int') {
      const bits = BigInt(ty.size * 8), max = ty.bool ? 1n : ty.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n, min = ty.signed && !ty.bool ? -(1n << (bits - 1n)) : 0n;
      const v = { max, min, lowest: min }[what];
      if (v === undefined) fail(l, `numeric_limits<${ty.name}>::${what}() is not known here (max, min and lowest are)`);
      return node('num', l, { v: ty.size === 8 ? v : Number(v), t: ty, name: `numeric_limits<${ty.name}>::${what}()` });
    }
    if (ty.k === 'flt') {
      const f = ty.size === 4, max = f ? 3.4028234663852886e38 : Number.MAX_VALUE;
      const v = { max, min: f ? 1.1754943508222875e-38 : 2.2250738585072014e-308, lowest: -max, infinity: Infinity, epsilon: f ? 1.1920928955078125e-7 : Number.EPSILON }[what];
      if (v === undefined) fail(l, `numeric_limits<${ty.name}>::${what}() is not known here (max, min, lowest, infinity and epsilon are)`);
      return node('num', l, { v, t: ty, name: `numeric_limits<${ty.name}>::${what}()` });
    }
    fail(l, 'numeric_limits works for number types here');
  }
  function primary() {
    const t = next(), l = t.line;
    if (t.t === 'num') return number(t);
    if (t.t === 'chr') return node('num', l, { v: t.v > 127 ? t.v - 256 : t.v, t: cpp ? T.char : T.int, chr: true });
    if (t.t === 'str') {
      let codes = t.v;
      while (peek() && peek().t === 'str') codes = codes.concat(next().v);
      return node('str', l, { codes });
    }
    if (t.t === 'p' && t.v === '(') { const e = expression(); expect(')'); return e; }
    if (cpp) {
      if (t.t === 'p' && t.v === '[') { i--; return lambda(); }
      if (t.t === 'p' && t.v === '{') { i--; return initializer(); }
      if (t.t === 'id') {
        if (t.v === 'true' || t.v === 'false') return node('num', l, { v: t.v === 'true' ? 1 : 0, t: T.bool, name: t.v });
        if (t.v === 'numeric_limits' && is('<')) return limits(l);
        if (Object.prototype.hasOwnProperty.call(NOT_HERE, t.v) && is('<')) fail(l, `std::${t.v} is not supported here (use ${NOT_HERE[t.v]})`);
        if (t.v === 'nullptr') return node('nullptr', l, {});
        if (t.v === 'this') return node('this', l, {});
        if (/^(static|const|reinterpret|dynamic)_cast$/.test(t.v)) {
          expect('<'); const ty = typeName(); closeAngle(); expect('('); const e = expression(); expect(')');
          return node('cast', l, { t: ty, e });
        }
        if (isTypeStart(-1) && t.v !== 'struct' && t.v !== 'class' && !scopes.some(s => s.has(t.v))) {   // int(x), Point(1, 2), vector<int>(n), string(3, 'a')
          i--;
          const ty = declSpecs().type;             // just the type: what follows is its arguments
          if (eat('(')) return node('construct', l, { t: ty, args: args() });
          if (is('{')) return node('construct', l, { t: ty, init: initializer() });
          fail(l, 'expected ( or { after the type ' + t.v + ' (to make a value of it)');
        }
      }
    }
    if (t.t === 'id' && !KEYWORDS.has(t.v)) {
      if (enumConsts.has(t.v) && !scopes.some(s => s.has(t.v))) return node('num', l, { v: enumConsts.get(t.v), t: T.int, name: t.v });
      return node('id', l, { name: t.v });
    }
    i--;
    fail(l, 'expected an expression before ' + show(t));
  }
  function number(t) {
    const s = t.v, l = t.line;
    let m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)([uUlL]*)$/.exec(s);
    if (m) {
      const body = m[1], suf = m[2].toLowerCase();
      if (!/^(u?l{0,2}|l{1,2}u)$/.test(suf)) fail(l, 'bad number suffix: ' + s);
      if (/^0[0-9]+$/.test(body) && /[89]/.test(body)) fail(l, s + ' starts with 0, so it is octal, and has an 8 or 9');
      const big = /^0[bB]/.test(body) ? BigInt('0b' + body.slice(2)) : /^0[0-7]+$/.test(body) ? BigInt('0o' + body.slice(1)) : BigInt(body);
      const u = suf.includes('u'), ls = (suf.match(/l/g) || []).length;
      const fits = (bits, uns) => big < (1n << BigInt(uns ? bits : bits - 1));
      const octHex = !/^[1-9]|^0$/.test(body);
      let ty = null;
      if (!ls && !u && fits(32, false)) ty = T.int;
      else if (!ls && (u || octHex) && fits(32, true)) ty = T.uint;
      else if (ls <= 1 && !u && fits(64, false)) ty = T.long;
      else if (ls <= 1 && fits(64, true)) ty = T.ulong;
      else if (!u && fits(64, false)) ty = T.llong;
      else if (fits(64, true)) ty = T.ullong;
      else fail(l, s + ' is too big for any integer type');
      if (ls === 2 && ty.rank < 5) ty = ty.signed && !u ? T.llong : T.ullong;
      return node('num', l, { v: ty.size === 8 ? big : Number(big), t: ty });
    }
    m = /^((?:[0-9]*\.[0-9]*|[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX][0-9a-fA-F.]+[pP][+-]?[0-9]+)([fFlL]?)$/.exec(s);
    if (m && /[.eEpP]/.test(m[1]) && m[1] !== '.') {
      const v = /^0[xX]/.test(m[1]) ? hexFloat(m[1]) : parseFloat(m[1]);
      const f = m[2].toLowerCase();
      return node('num', l, { v: f === 'f' ? Math.fround(v) : v, t: f === 'f' ? T.float : f === 'l' ? T.ldouble : T.double });
    }
    fail(l, 'bad number: ' + s);
  }
  const hexFloat = s => { const [mant, exp] = s.slice(2).split(/[pP]/); const [a, b = ''] = mant.split('.'); return (parseInt(a || '0', 16) + (b ? parseInt(b, 16) / 16 ** b.length : 0)) * 2 ** +exp; };

  /** Folds a constant integer expression, or returns null (it needs the running program). */
  function constFold(e) {
    switch (e.k) {
      case 'num': return e.t.k === 'int' ? Number(e.v) : null;
      case 'un': { const v = constFold(e.e); return v == null ? null : e.op === '-' ? -v : e.op === '+' ? v : e.op === '!' ? +!v : ~v; }
      case 'bin': {
        const a = constFold(e.l), b = constFold(e.r);
        if (a == null || b == null) return null;
        switch (e.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b ? Math.trunc(a / b) : null; case '%': return b ? a % b : null;
          case '<<': return a << b; case '>>': return a >> b; case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
          case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
          case '==': return +(a === b); case '!=': return +(a !== b);
        }
        return null;
      }
      case 'and': { const a = constFold(e.l), b = constFold(e.r); return a == null || b == null ? null : +(a && b); }
      case 'or': { const a = constFold(e.l), b = constFold(e.r); return a == null || b == null ? null : +(a || b); }
      case 'cond': { const c = constFold(e.c); return c == null ? null : constFold(c ? e.a : e.b); }
      case 'cast': return e.t.k === 'int' ? constFold(e.e) : null;
      case 'sizeofT': return e.t.k === 'arr' && typeof e.t.n !== 'number' ? null : e.t.size;
      default: return null;
    }
  }

  /* ---- statements ---- */
  function declaration(specs) {
    const sp = specs || declSpecs();
    const l = line(), list = [];
    if (eat(';')) return { k: 'decl', list, line: l };        // struct Point { … }; enum { … };
    do {
      if (cpp && (is('[') || ((is('&') || is('&&')) && is('[', 1)))) {   // auto [a, b] = pair;
        const isRef = eat('&') || eat('&&'), bl = line();
        expect('[');
        const names = [];
        do names.push(ident('a name')); while (eat(','));
        expect(']');
        names.forEach(n => scopes.at(-1).add(n));
        if (!eat('=') && !is('{') && !is('(')) fail(bl, 'a structured binding needs a value: auto [' + names.join(', ') + '] = …;');
        list.push({ bind: names, ref: isRef, type: sp.type, line: bl, init: is('(') ? (i++, (() => { const e = expression(); expect(')'); return e; })()) : initializer() });
        continue;
      }
      const d = declarator(false);
      const type = d.apply(sp.type);
      if (!d.name) fail(d.line, 'expected a name in the declaration');
      if (sp.storage === 'typedef') {
        typedefs.set(d.name, type);
        if (type.k === 'struct' && !type.alias && !type.cls) type.alias = d.name;
        scopes.at(-1).delete(d.name);
        continue;
      }
      scopes.at(-1).add(d.name);
      const item = { name: d.name, type, storage: sp.storage, line: d.line, init: null };
      if (eat('=')) {
        if (type.k === 'fn') fail(d.line, 'a function cannot be given a value with =');
        item.init = initializer();
      } else if (cpp && type.k !== 'fn' && is('(')) { i++; item.ctor = args(); }      // vector<int> v(n, 0);
      else if (cpp && type.k !== 'fn' && is('{')) item.init = initializer();         // vector<int> v{1, 2, 3};
      list.push(item);
    } while (eat(','));
    expect(';', 'after the declaration');
    return { k: 'decl', list, line: l };
  }

  function block() {
    const l = line();
    expect('{');
    scopes.push(new Set());
    const its = [];
    while (!eat('}')) its.push(statement());
    scopes.pop();
    return { k: 'block', items: its, line: l };
  }

  /** for (auto& x : v) / for (const auto& [k, v] : m) after the declaration's type */
  function rangeFor(l) {
    const save = i, sp = declSpecs();
    if (!sp) { i = save; return null; }
    const isRef = is('&') || is('&&');
    if (is('[') || (isRef && is('[', 1))) {
      if (isRef) i++;
      i++;
      const names = [];
      do names.push(ident('a name')); while (eat(','));
      expect(']');
      if (!eat(':')) fail(l, 'expected : in for (auto [' + names.join(', ') + '] : …)');
      names.forEach(n => scopes.at(-1).add(n));
      return { bind: names, ref: isRef, type: sp.type };
    }
    const d = declarator(false);
    if (!is(':')) { i = save; return null; }
    i++;
    scopes.at(-1).add(d.name);
    const type = d.apply(sp.type);
    return { name: d.name, type, ref: type.k === 'ref' };
  }

  function statement() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, "expected '}' at the end of the program");
    if (t.t === 'p' && t.v === '{') return block();
    if (t.t === 'p' && t.v === ';') { i++; return { k: 'empty', line: l }; }
    if (t.t === 'id') {
      switch (t.v) {
        case 'if': {
          i++; expect('(', 'after if'); const c = expression(); expect(')', 'after the condition');
          const a = statement();
          return { k: 'if', c, a, b: eat('else') ? statement() : null, line: l };
        }
        case 'while': { i++; expect('(', 'after while'); const c = expression(); expect(')', 'after the condition'); return { k: 'while', c, body: statement(), line: l }; }
        case 'do': {
          i++; const body = statement();
          const wl = line(); expect('while', 'after the body of do'); expect('('); const c = expression(); expect(')'); expect(';', 'after do … while (…)');
          return { k: 'do', body, c, line: l, cline: wl };
        }
        case 'for': {
          i++; expect('(', 'after for');
          scopes.push(new Set());
          if (cpp && isTypeStart()) {
            const r = rangeFor(l);
            if (r) {
              const e = expression(); expect(')', 'after the for loop header');
              const body = statement();
              scopes.pop();
              return { k: 'rangefor', decl: r, e, body, line: l };
            }
          }
          let init = null;
          if (isTypeStart()) init = declaration();
          else if (!eat(';')) { init = { k: 'expr', e: expression(), line: l }; expect(';', 'in the for loop'); }
          const c = is(';') ? null : expression(); expect(';', 'in the for loop');
          const step = is(')') ? null : expression(); expect(')', 'after the for loop header');
          const body = statement();
          scopes.pop();
          return { k: 'for', init, c, step, body, line: l };
        }
        case 'return': { i++; const e = is(';') ? null : cpp && is('{') ? initializer() : expression(); expect(';', 'after return'); return { k: 'return', e, line: l }; }
        case 'break': i++; expect(';', 'after break'); return { k: 'break', line: l };
        case 'continue': i++; expect(';', 'after continue'); return { k: 'continue', line: l };
        case 'switch': { i++; expect('(', 'after switch'); const e = expression(); expect(')'); return { k: 'switch', e, body: statement(), line: l }; }
        case 'case': {
          i++; const v = constValue(conditional(), 'a case label');
          if (eat('...')) fail(l, 'case ranges are not supported');
          expect(':', 'after the case label');
          return { k: 'case', v, line: l };
        }
        case 'default': i++; expect(':', 'after default'); return { k: 'default', line: l };
        case 'goto': fail(l, 'goto is not supported');
      }
      if (cpp) {
        if (t.v === 'using' || (t.v === 'typedef')) { aliasDecl(); return { k: 'empty', line: l, quiet: true }; }
        if (t.v === 'template') fail(l, 'templates (other than the standard library\'s: vector, map…) are not supported');
        if (t.v === 'try') {
          i++;
          const body = block(), catches = [];
          while (is('catch')) {
            const cl = line(); i++; expect('(');
            let type = null, name = null;
            if (!eat('...')) { const sp = declSpecs(); if (!sp) fail(cl, 'expected a type in catch (…)'); const d = declarator(true); type = d.apply(sp.type); name = d.name; }
            expect(')');
            scopes.push(new Set(name ? [name] : []));
            catches.push({ type, name, body: block(), line: cl });
            scopes.pop();
          }
          if (!catches.length) fail(l, 'try needs at least one catch (…) { … }');
          return { k: 'try', body, catches, line: l };
        }
      }
      if (isTypeStart() && !(cpp && isStl(t.v) && is('(', 1) && t.v !== 'string')) return declaration();
      if (peek(1) && peek(1).v === ':' && peek(1).t === 'p' && !KEYWORDS.has(t.v)) fail(l, 'labels (and goto) are not supported');
    }
    const start = peek(), e = expression();
    expect(';', 'after the statement');
    return { k: 'expr', e, line: l, text: textOf(start, toks[i - 1]) };
  }

  /* ---- the whole program ---- */
  /** One declaration or definition at the top of the program (or a friend function inside a class) */
  function topLevel() {
    if (eat(';')) return;
    const l = line();
    if (cpp) {
      if (is('using') || is('typedef')) { aliasDecl(); return; }
      if (is('template')) fail(l, 'templates (other than the standard library\'s: vector, map…) are not supported');
      if (is('namespace')) fail(l, 'namespaces of your own are not supported');
      const t = peek();
      // X::X(…) and X::~X(): a constructor or destructor defined outside its class
      const m = t && t.t === 'id' && /^(\w+)::(~?)(\w+)$/.exec(t.v);
      if (m && m[1] === m[3] && typedefs.get(m[1]) && typedefs.get(m[1]).cls && is('(', 1)) { i++; ctorOrDtor(typedefs.get(m[1]), !!m[2], l); return; }
    }
    const sp = declSpecs();
    if (!sp) {
      const t = peek();
      if (t.t === 'id' && is('(', 1)) fail(l, 'expected a return type before ' + t.v + '(…) (int ' + t.v + '(…)? void ' + t.v + '(…)?)');
      fail(l, 'expected a declaration (a type) before ' + show(t) + (t.t === 'id' ? ': statements go inside a function such as int main(' + (cpp ? '' : 'void') + ') { … }' : ''));
    }
    if (is(';')) { i++; return; }
    const save = i;
    const d = declarator(false);
    const type = d.apply(sp.type);
    if (type.k === 'fn' && sp.storage !== 'typedef' && (is('{') || (cpp && (is('const') || is('override') || is('noexcept') || is('->'))))) {
      const isConst = cpp ? methodSuffix() : false;
      void isConst;
      if (!d.params && type.params.length) fail(d.line, 'a function definition needs parameter names');
      const ps = (d.params || []).map((p, k) => { if (!p.name && !cpp) fail(p.line, 'parameter ' + (k + 1) + ' of ' + d.name + ' needs a name'); return { name: p.name || '(unnamed ' + (k + 1) + ')', type: type.params[k], def: p.def }; });
      const mm = cpp && /^(\w+)::(.+)$/.exec(d.name);
      if (mm) {                                    // int Stack::size() const { … }: a method defined outside its class
        const s = typedefs.get(mm[1]);
        if (!s || !s.cls) fail(d.line, mm[1] + ' is not a class, so ' + d.name + ' cannot be defined');
        const decl = (s.methods.get(mm[2]) || []).find(x => x.params.length === ps.length);
        const def = { k: 'func', name: mm[2], type, params: ps, line: d.line, owner: s, kind: 'method', isStatic: decl ? decl.isStatic : false, body: null };
        def.body = withParams(ps, () => block());
        addMethod(s, def);
        return;
      }
      const body = withParams(ps, () => block());
      items.push({ k: 'func', name: d.name, type, params: ps, body, line: d.line, static: sp.storage === 'static' });
      return;
    }
    if (cpp && /^\w+::\w+$/.test(d.name || '') && type.k !== 'fn') {   // int Counter::count = 0;
      const [cls, name] = d.name.split('::'), s = typedefs.get(cls);
      if (s && s.cls && s.statics.has(name)) {
        const st = s.statics.get(name);
        if (eat('=')) st.init = initializer(); else if (is('{')) st.init = initializer();
        expect(';');
        return;
      }
    }
    i = save;
    items.push(declaration(sp));
  }

  while (i < toks.length) topLevel();
  return { items, structs, cpp };
}
