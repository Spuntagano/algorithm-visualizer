/**
 * The C front end: preprocessor (#include of the standard headers, #define with arguments, #ifdef…), lexer and a
 * recursive-descent parser for C99 (most of it: no goto, no K&R definitions, no bit fields). The result is a tree of
 * plain objects for ./interp.js; every statement and expression has the `line` it starts on.
 * parseC(source) throws an Error "line N: …" for a syntax error.
 */
import { FILE_T, STD_TYPEDEFS, T, arr, fnType, layout, ptr } from './types.js';

export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const PUNCT = ['...', '<<=', '>>=', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
  '&=', '^=', '|=', '##'];
const KEYWORDS = new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static',
  'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool']);

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
function lex(src, line0 = 1, pos0 = 0, dirs = true) {
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

function preprocess(src) {
  const macros = new Map();
  for (const [k, v] of Object.entries(PREDEFINED)) macros.set(k, { body: lex(v), params: null });
  const out = [], conds = [];                      // conds: { on, done } for each open #if
  const live = () => conds.every(c => c.on);
  const toks = lex(src);
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
      if (!h) fail(t.line, '#include ' + rest + ': only the standard headers (<stdio.h>, <stdlib.h>, <string.h>…) are available here');
      if (!STD_HEADERS.has(h[1])) fail(t.line, '#include <' + h[1] + '> is not available here');
    } else if (d === 'define') {
      const dm = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*([\s\S]*)$/.exec(rest);
      if (!dm) fail(t.line, '#define needs a name');
      const params = dm[2] ? dm[3].split(',').map(s => s.trim()).filter(Boolean) : null;
      const variadic = !!params && params.at(-1) === '...';
      if (variadic) params.pop();
      macros.set(dm[1], { params, variadic, body: lex(dm[4], t.line, 0, false) });
    } else if (d === 'undef') macros.delete(rest);
    else if (d === 'error') fail(t.line, '#error ' + rest);
    else if (d !== 'pragma' && d !== 'line' && d !== '') fail(t.line, 'unknown directive #' + d);
  }
  if (conds.length) fail(toks.length ? toks.at(-1).line : 1, '#if without #endif');
  flush();
  return out;
}

/* ---- parser ---- */
/**
 * @returns {{ items: any[], structs: Map, src: string }} items: { k: 'func', name, type, params, body, line } and
 *   { k: 'decl', list: [{ name, type, init, storage, line }] }
 */
export function parseC(src) {
  const toks = preprocess(src);
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

  const typedefs = new Map(Object.entries(STD_TYPEDEFS));
  const structs = new Map([['FILE', FILE_T]]), enums = new Map(), enumConsts = new Map();
  const scopes = [new Set()];                      // names declared as variables, which hide a typedef of the same name
  const isTypedef = n => typedefs.has(n) && !scopes.some(s => s.has(n));
  const TYPE_WORDS = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'struct', 'union',
    'enum', 'const', 'volatile', 'restrict', 'static', 'extern', 'typedef', 'register', 'auto', 'inline']);
  const isTypeStart = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && (TYPE_WORDS.has(t.v) || isTypedef(t.v)); };

  /** Integer constant expressions (array sizes, case labels, enum values, bit widths) */
  const constValue = (e, what) => {
    const v = constFold(e);
    if (v == null) fail(e.line, what + ' must be a constant');
    return v;
  };

  function declSpecs() {
    let storage = null, base = null, sign = null, size = null, longs = 0, sawInt = false;
    const words = [];
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'id') break;
      const v = t.v;
      if (v === 'const' || v === 'volatile' || v === 'restrict' || v === 'inline' || v === 'register' || v === 'auto') { i++; continue; }
      if (v === 'static' || v === 'extern' || v === 'typedef') { i++; storage = v; continue; }
      if (v === 'signed' || v === 'unsigned') { i++; sign = v; continue; }
      if (v === 'short') { i++; size = 'short'; continue; }
      if (v === 'long') { i++; longs++; continue; }
      if (v === 'int') { i++; sawInt = true; continue; }
      if (v === 'char' || v === 'void' || v === 'float' || v === 'double' || v === '_Bool') { if (base) fail(t.line, 'two types: ' + base + ' and ' + v); i++; base = v; words.push(v); continue; }
      if (v === 'struct' || v === 'union') { if (base) fail(t.line, 'two types in one declaration'); i++; base = structSpec(v === 'union'); continue; }
      if (v === 'enum') { if (base) fail(t.line, 'two types in one declaration'); i++; base = enumSpec(); continue; }
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

  function structSpec(union) {
    const l = line();
    let tag = null;
    if (peek() && peek().t === 'id' && !is('{')) tag = ident('a struct name');
    const key = (union ? 'union ' : 'struct ') + (tag || '#' + i);
    let s = tag && structs.get(key);
    if (!s) { s = { k: 'struct', tag, union, fields: [], size: 0, align: 1, done: false }; if (tag) structs.set(key, s); }
    if (eat('{')) {
      if (s.done) fail(l, (union ? 'union ' : 'struct ') + tag + ' is defined twice');
      const fields = [];
      while (!eat('}')) {
        const sp = declSpecs();
        if (!sp) fail(line(), 'expected a field type before ' + show(peek()));
        do {
          const d = declarator(false);
          let ft = d.apply(sp.type);
          if (eat(':')) fail(d.line, 'bit fields are not supported');
          if (ft.k === 'arr' && ft.n != null && typeof ft.n !== 'number') ft = arr(ft.of, constValue(ft.n, 'a field\'s array size'));
          if (ft.k === 'fn') fail(d.line, 'a struct cannot hold a function (a function pointer can: (*' + d.name + ')(…))');
          if (ft.k === 'struct' && !ft.done) fail(d.line, 'the field ' + d.name + ' has an incomplete type (use a pointer: ' + typeLabel(ft) + ' *' + d.name + ')');
          if (!d.name) { if (ft.k === 'struct') { fields.push(...ft.fields.map(f => ({ ...f, anon: ft }))); continue; } fail(d.line, 'a field needs a name'); }
          if (fields.some(f => f.name === d.name)) fail(d.line, 'two fields named ' + d.name);
          fields.push({ name: d.name, type: ft, off: 0 });
        } while (eat(','));
        expect(';', 'after the field');
      }
      s.fields = fields;
      layout(s);
    }
    return s;
  }
  const typeLabel = s => (s.union ? 'union ' : 'struct ') + (s.tag || '');

  function enumSpec() {
    let tag = null;
    if (peek() && peek().t === 'id' && !is('{')) tag = ident('an enum name');
    const t = { ...T.int, en: tag || '(anonymous)', consts: new Map() };
    if (tag && enums.has(tag) && !is('{')) return enums.get(tag);
    if (tag) enums.set(tag, t);
    if (eat('{')) {
      let v = 0;
      while (!eat('}')) {
        const name = ident('an enum constant');
        if (eat('=')) v = constValue(assignment(), 'an enum value');
        enumConsts.set(name, v); t.consts.set(v, t.consts.get(v) || name);
        v++;
        if (!eat(',')) { expect('}', 'after the enum constants'); break; }
      }
    }
    return t;
  }

  /**
   * A declarator: the name and how it changes the base type. `int *a[3]`: a, array of 3 pointers to int.
   * Returns { name, line, apply(base) → type, params (of the function it declares, for a definition) }.
   */
  function declarator(abstract) {
    let stars = 0;
    while (eat('*')) { stars++; while (is('const') || is('volatile') || is('restrict')) i++; }
    let name = null, inner = null, l = line(), params = null;
    if (peek() && peek().t === 'id' && !KEYWORDS.has(peek().v) && !isTypeStart()) name = ident();
    else if (is('(') && (is('*', 1) || is('(', 1) || is('[', 1) || (peek(1) && peek(1).t === 'id' && !isTypeStart(1) && !abstract))) {
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
      } else if (is('(')) {
        i++;
        const ps = paramList();
        suffixes.push({ fn: true, ...ps });
        if (!params && !inner) params = ps.list;
      } else break;
    }
    if (inner && inner.params && !params) params = null;
    const apply = base => {
      let t = base;
      for (let s = 0; s < stars; s++) t = ptr(t);
      for (let k = suffixes.length - 1; k >= 0; k--) {
        const sfx = suffixes[k];
        if (sfx.arr) {
          if (t.k === 'fn') fail(l, 'an array of functions is not allowed (use function pointers)');
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
    if (eat(')')) return { list, variadic: false, proto: false };
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
      list.push({ name: d.name, type: pt, line: d.line });
    } while (eat(','));
    expect(')', 'after the parameters');
    return { list, variadic, proto: true };
  }

  function typeName() {
    const sp = declSpecs();
    if (!sp) fail(line(), 'expected a type');
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
        else if (is('[')) { i++; desig.push({ index: constValue(conditional(), 'an index in an initializer') }); expect(']'); }
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
    const start = peek(), l = line(), lhs = conditional();
    const t = peek();
    if (t && t.t === 'p' && ASSIGN.has(t.v)) { i++; return node('assign', l, { op: t.v, l: lhs, r: assignment(), text: textOf(start, toks[i - 1]) }); }
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
    if (is('(') && isTypeStart(1)) {
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
    return postfix(primary());
  }
  function postfix(e) {
    for (;;) {
      const l = line();
      if (eat('[')) { const ix = expression(); expect(']', 'after the index'); e = node('index', l, { a: e, i: ix }); }
      else if (is('(')) {
        const start = toks[i]; i++;
        const args = [];
        if (!eat(')')) { do args.push(assignment()); while (eat(',')); expect(')', 'after the arguments'); }
        e = node('call', e.line, { f: e, args, text: textOf(start, toks[i - 1]) });
      }
      else if (eat('.')) e = node('member', l, { e, name: ident('a field name'), arrow: false });
      else if (eat('->')) e = node('member', l, { e, name: ident('a field name'), arrow: true });
      else if (is('++') || is('--')) e = node('post', l, { op: next().v, e });
      else return e;
    }
  }
  function primary() {
    const t = next(), l = t.line;
    if (t.t === 'num') return number(t);
    if (t.t === 'chr') return node('num', l, { v: t.v > 127 ? t.v - 256 : t.v, t: T.int, chr: true });
    if (t.t === 'str') {
      let codes = t.v;
      while (peek() && peek().t === 'str') codes = codes.concat(next().v);
      return node('str', l, { codes });
    }
    if (t.t === 'p' && t.v === '(') { const e = expression(); expect(')'); return e; }
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
      const d = declarator(false);
      const type = d.apply(sp.type);
      if (!d.name) fail(d.line, 'expected a name in the declaration');
      if (sp.storage === 'typedef') {
        typedefs.set(d.name, type);
        if (type.k === 'struct' && !type.alias) type.alias = d.name;
        scopes.at(-1).delete(d.name);
        continue;
      }
      scopes.at(-1).add(d.name);
      const item = { name: d.name, type, storage: sp.storage, line: d.line, init: null };
      if (eat('=')) {
        if (type.k === 'fn') fail(d.line, 'a function cannot be given a value with =');
        item.init = initializer();
      }
      list.push(item);
    } while (eat(','));
    expect(';', 'after the declaration');
    return { k: 'decl', list, line: l };
  }

  function block() {
    const l = line();
    expect('{');
    scopes.push(new Set());
    const items = [];
    while (!eat('}')) items.push(statement());
    scopes.pop();
    return { k: 'block', items, line: l };
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
          let init = null;
          if (isTypeStart()) init = declaration();
          else if (!eat(';')) { init = { k: 'expr', e: expression(), line: l }; expect(';', 'in the for loop'); }
          const c = is(';') ? null : expression(); expect(';', 'in the for loop');
          const step = is(')') ? null : expression(); expect(')', 'after the for loop header');
          const body = statement();
          scopes.pop();
          return { k: 'for', init, c, step, body, line: l };
        }
        case 'return': { i++; const e = is(';') ? null : expression(); expect(';', 'after return'); return { k: 'return', e, line: l }; }
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
      if (isTypeStart()) return declaration();
      if (peek(1) && peek(1).v === ':' && peek(1).t === 'p' && !KEYWORDS.has(t.v)) fail(l, 'labels (and goto) are not supported');
    }
    const start = peek(), e = expression();
    expect(';', 'after the statement');
    return { k: 'expr', e, line: l, text: textOf(start, toks[i - 1]) };
  }

  /* ---- the whole program ---- */
  const items = [];
  while (i < toks.length) {
    if (eat(';')) continue;
    const l = line();
    const sp = declSpecs();
    if (!sp) {
      const t = peek();
      if (t.t === 'id' && is('(', 1)) fail(l, 'expected a return type before ' + t.v + '(…) (int ' + t.v + '(…)? void ' + t.v + '(…)?)');
      fail(l, 'expected a declaration (a type) before ' + show(t) + (t.t === 'id' ? ': statements go inside a function such as int main(void) { … }' : ''));
    }
    if (is(';')) { i++; continue; }
    const save = i;
    const d = declarator(false);
    const type = d.apply(sp.type);
    if (type.k === 'fn' && is('{') && sp.storage !== 'typedef') {
      if (!d.params && type.params.length) fail(d.line, 'a function definition needs parameter names');
      const params = (d.params || []).map((p, k) => { if (!p.name) fail(p.line, 'parameter ' + (k + 1) + ' of ' + d.name + ' needs a name'); return { name: p.name, type: type.params[k] }; });
      scopes.push(new Set(params.map(p => p.name)));
      const body = block();
      scopes.pop();
      items.push({ k: 'func', name: d.name, type, params, body, line: d.line, static: sp.storage === 'static' });
      continue;
    }
    i = save;
    items.push(declaration(sp));
  }
  return { items, structs };
}
