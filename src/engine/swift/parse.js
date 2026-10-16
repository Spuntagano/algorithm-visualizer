/**
 * The Swift front end: a lexer (it keeps, for each token, whether a space or a newline comes before it: Swift tells
 * `x!` from `x != y`, `a?.b` from `a ? b : c` and a new statement from a continued one that way) and a recursive-descent
 * parser for the Swift that algorithms use: top-level code, functions (labels, defaults, inout, variadics, throws),
 * structs, classes (inheritance, init, deinit), enums (raw and associated values, indirect), protocols, extensions,
 * properties (stored, computed, lazy, observed), subscripts, closures (with $0 and trailing ones), optionals and
 * optional chaining, if / guard / while let, switch with patterns, for-in with where, labels, defer, do / catch.
 * parseSwift(source) returns { items } or throws an Error "line N: …".
 */
export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const KEYWORDS = new Set(['let', 'var', 'func', 'class', 'struct', 'enum', 'protocol', 'extension', 'if', 'else', 'guard', 'while', 'repeat',
  'for', 'in', 'switch', 'case', 'default', 'return', 'break', 'continue', 'throw', 'throws', 'rethrows', 'defer', 'do', 'catch', 'try',
  'nil', 'true', 'false', 'self', 'Self', 'super', 'init', 'deinit', 'subscript', 'import', 'typealias', 'is', 'as', 'where', 'fallthrough',
  'inout', 'static', 'operator', 'associatedtype']);
const MODIFIERS = new Set(['private', 'fileprivate', 'public', 'internal', 'open', 'final', 'static', 'override', 'mutating', 'nonmutating',
  'lazy', 'weak', 'unowned', 'convenience', 'required', 'indirect', 'dynamic', 'optional', 'nonisolated', 'package', 'consuming', 'borrowing']);
const PUNCT = ['...', '..<', '===', '!==', '<<=', '>>=', '&+=', '&-=', '&*=', '->', '==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>', '&+', '&-', '&*', '~='];

/* ---- lexer ---- */
const ESC = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
export function lex(src) {
  const toks = [];
  let i = 0, line = 1, nl = false, sp = true;
  /** a string literal's parts: text, and { src, line } for each \( … ) */
  function strParts(raw, l0, multi) {
    const parts = [];
    let cur = '', ln = l0;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (c === '\n') ln++;
      if (c !== '\\') { cur += c; continue; }
      const e = raw[j + 1];
      if (e === '(') {
        let depth = 0, k = j + 1, inStr = false;
        for (; k < raw.length; k++) {
          const d = raw[k];
          if (inStr) { if (d === '\\') k++; else if (d === '"') inStr = false; continue; }
          if (d === '"') inStr = true; else if (d === '(') depth++; else if (d === ')') { depth--; if (!depth) break; }
        }
        if (k >= raw.length) fail(l0, "cannot find ')' to match opening '(' in string interpolation");
        parts.push(cur); cur = '';
        parts.push({ src: raw.slice(j + 2, k), line: ln });
        j = k; continue;
      }
      if (e === 'u' && raw[j + 2] === '{') { const k = raw.indexOf('}', j); cur += String.fromCodePoint(parseInt(raw.slice(j + 3, k), 16)); j = k; continue; }
      if (multi && e === '\n') { j++; ln++; continue; }        // a backslash at the end of a line joins it to the next
      if (!(e in ESC)) fail(ln, `invalid escape sequence in literal`);
      cur += ESC[e]; j++;
    }
    parts.push(cur);
    return parts;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; nl = true; sp = true; continue; }
    if (/\s/.test(c)) { i++; sp = true; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {                // Swift's block comments nest
      let depth = 0, j = i;
      do { if (src.startsWith('/*', j)) { depth++; j += 2; } else if (src.startsWith('*/', j)) { depth--; j += 2; } else { if (src[j] === '\n') line++; j++; } } while (depth && j < src.length);
      if (depth) fail(line, "unterminated '/*' comment");
      i = j; sp = true; continue;
    }
    const start = i, l0 = line, tok = t => { toks.push({ ...t, line: l0, nl, sp, pos: start }); nl = false; sp = false; };
    if (src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      if (e < 0) fail(line, 'unterminated string literal');
      let body = src.slice(i + 3, e);
      const nls = (body.match(/\n/g) || []).length;
      if (!body.startsWith('\n')) fail(line, 'multi-line string literal content must begin on a new line');
      const lastNl = body.lastIndexOf('\n'), indent = body.slice(lastNl + 1);
      if (/\S/.test(indent)) fail(line + nls, 'multi-line string literal closing delimiter must begin on a new line');
      body = body.slice(1, lastNl).split('\n').map(x => (x.startsWith(indent) ? x.slice(indent.length) : x.trim() === '' ? '' : fail(l0, 'insufficient indentation of line in multi-line string literal'))).join('\n');
      line += nls; i = e + 3;
      tok({ t: 'str', v: strParts(body, l0 + 1, true) }); continue;
    }
    if (c === '"') {
      let j = i + 1, depth = 0;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\n') fail(line, 'unterminated string literal');
        if (d === '\\' && src[j + 1] === '(') { depth++; j++; continue; }
        if (d === '\\') { j++; continue; }
        if (depth && d === '(') { depth++; continue; }
        if (depth && d === ')') { depth--; continue; }
        if (depth && d === '"') { j++; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; } continue; }
        if (d === '"' && !depth) break;
      }
      if (src[j] !== '"') fail(line, 'unterminated string literal');
      const raw = src.slice(i + 1, j);
      i = j + 1;
      tok({ t: 'str', v: strParts(raw, l0, false) }); continue;
    }
    if (c === "'") fail(line, "single-quoted string literal found, use '\"'");
    if (c === '#' && /[A-Za-z]/.test(src[i + 1] || '')) fail(line, 'compiler directives (' + src.slice(i, i + 8).split(/\s/)[0] + ') are not supported here');
    if (c === '`') { const e = src.indexOf('`', i + 1); if (e < 0) fail(line, "expected '`'"); i = e + 1; tok({ t: 'id', v: src.slice(start + 1, e), quoted: true }); continue; }
    if (c === '$' && /[0-9]/.test(src[i + 1] || '')) { i++; while (/[0-9]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[A-Za-z_]/.test(c)) { while (/[A-Za-z0-9_]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[0-9]/.test(c)) {
      const afterDot = toks.length && toks.at(-1).t === 'p' && toks.at(-1).v === '.' && !sp;   // t.0.1: two tuple indexes
      let float = false;
      if (c === '0' && /[xbo]/.test(src[i + 1] || '')) { i += 2; while (/[0-9a-fA-F_]/.test(src[i] || '')) i++; }
      else {
        while (/[0-9_]/.test(src[i] || '')) i++;
        if (!afterDot && src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) { float = true; i++; while (/[0-9_]/.test(src[i] || '')) i++; }
        if (!afterDot && /[eE]/.test(src[i] || '') && /[0-9+-]/.test(src[i + 1] || '')) { float = true; i++; if (/[+-]/.test(src[i])) i++; while (/[0-9]/.test(src[i] || '')) i++; }
      }
      if (/[A-Za-z_]/.test(src[i] || '')) { let k = i; while (/[A-Za-z0-9_]/.test(src[k] || '')) k++; fail(line, `'${src[i]}' is not a valid digit in integer literal`); }
      tok({ t: 'num', v: src.slice(start, i).replace(/_/g, ''), float }); continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~?:=@\\'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'invalid character in source file: ' + JSON.stringify(c));
  }
  return toks;
}

/* ---- parser ---- */
const BIN = {
  '||': 2, '&&': 3,
  '==': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, '===': 4, '!==': 4, '~=': 4,
  '??': 5, '...': 7, '..<': 7,
  '+': 8, '-': 8, '&+': 8, '&-': 8, '|': 8, '^': 8,
  '*': 9, '/': 9, '%': 9, '&': 9, '&*': 9,
  '<<': 10, '>>': 10,
};
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '&+=', '&-=', '&*=']);

export function parseSwift(src, startLine = 1, exprOnly = false) {
  const toks = lex(src);
  if (startLine !== 1) for (const t of toks) t.line += startLine - 1;
  let i = 0, noTrail = 0;                          // noTrail > 0: in an if / while / guard / for / switch head, where { opens the body
  const lastLine = toks.length ? toks.at(-1).line : startLine;
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || (t.t === 'id' && !t.quoted)) && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(lastLine, "expected '}' in the program (it ends too early)"); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  const show = t => (!t ? 'end of file' : t.t === 'str' ? 'a string' : "'" + t.v + "'");
  const expect = (v, what) => { if (eat(v)) return; const t = peek(); fail(t ? t.line : lastLine, `expected '${v}'${what ? ' ' + what : ''}${t ? '' : ' (the program ends too early)'}`); };
  const isIdent = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && (t.quoted || !KEYWORDS.has(t.v) || t.v === 'init' && false); };
  const ident = what => {
    const t = peek();
    if (t && t.t === 'id' && (t.quoted || !KEYWORDS.has(t.v) || ['Self', 'init'].includes(t.v) && what === 'member')) { i++; return t.v; }
    fail(t ? t.line : lastLine, `expected ${what || 'identifier'}${t ? ', not ' + show(t) : ''}`);
  };
  /** any word, keywords too (argument labels, member names after a dot) */
  const word = what => { const t = peek(); if (t && t.t === 'id') { i++; return t.v; } fail(t ? t.line : lastLine, `expected ${what}`); };
  const endOfStmt = () => { const t = peek(); return !t || t.nl || is(';') || is('}'); };

  /* ---- types ---- */
  function parseType() {
    let t;
    const l = line();
    if (eat('inout')) return { ...parseType(), inout: true };
    while (is('@')) { i++; word('an attribute'); }
    if (is('some') || is('any')) { if (isIdent(1)) i++; }
    if (eat('[')) {
      const a = parseType();
      if (eat(':')) { const b = parseType(); expect(']', 'in a dictionary type'); t = { dict: [a, b] }; }
      else { expect(']', 'in an array type'); t = { arr: a }; }
    } else if (eat('(')) {
      const items = [];
      while (!is(')')) {
        let label = null;
        if (peek() && peek().t === 'id' && is(':', 1)) { label = next().v; i++; }
        else if (peek() && peek().t === 'id' && peek(1) && peek(1).t === 'id' && is(':', 2)) { i++; label = next().v; i++; }
        items.push({ ...parseType(), label });
        if (eat('...')) items.at(-1).variadic = true;
        if (!eat(',')) break;
      }
      expect(')', 'in a tuple type');
      eat('throws'); eat('async');
      if (eat('->')) t = { fn: items, ret: parseType() };
      else t = items.length === 1 && !items[0].label ? items[0] : items.length === 0 ? { n: 'Void' } : { tuple: items };
    } else {
      let n = word('a type');
      if (n === 'Self') n = 'Self';
      const args = genericArgs();
      t = { n, args };
      while (is('.') && peek(1) && peek(1).t === 'id' && /^[A-Z]/.test(peek(1).v)) { i++; t = { n: t.n + '.' + next().v, args: genericArgs() }; }
      if (n === 'Array' && args && args.length === 1) t = { arr: args[0] };
      else if (n === 'Dictionary' && args && args.length === 2) t = { dict: args };
      else if (n === 'Set' && args && args.length === 1) t = { set: args[0] };
      else if (n === 'Optional' && args && args.length === 1) t = { opt: args[0] };
    }
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'p' && tk.v === '?' && !tk.sp) { i++; t = { opt: t }; continue; }
      if (tk && tk.t === 'p' && tk.v === '!' && !tk.sp) { i++; t = { opt: t, iuo: true }; continue; }
      if (tk && tk.t === 'p' && tk.v === '&' && peek(1) && peek(1).t === 'id') { i++; parseType(); continue; }   // P & Q
      break;
    }
    if (is('->') && !t.fn) { i++; t = { fn: [t], ret: parseType() }; }
    t.line = l;
    return t;
  }
  function genericArgs() {
    const t = peek();
    if (!(t && t.v === '<' && t.t === 'p' && !t.sp)) return null;
    i++;
    const args = [];
    for (;;) {
      args.push(parseType());
      if (!eat(',')) break;
    }
    closeAngle();
    return args;
  }
  /** a > closing generic arguments; >> and >= are split */
  function closeAngle() {
    const t = peek();
    if (t && t.t === 'p' && t.v[0] === '>') {
      if (t.v === '>') { i++; return; }
      toks[i] = { ...t, v: t.v.slice(1), sp: false }; return;
    }
    fail(t ? t.line : lastLine, "expected '>' to complete generic argument list");
  }
  /** tries generic arguments in an expression (Array<Int>(), Set<String>()): only when ( or . follows */
  function tryGenericArgs() {
    const save = i;
    try { const a = genericArgs(); if (a && (is('(') || is('.'))) return a; } catch { /* not generic arguments */ }
    i = save; return null;
  }
  function genericParams() {
    const t = peek();
    if (!(t && t.v === '<')) return [];
    i++;
    const ps = [];
    while (!is('>')) { ps.push(ident('a generic parameter')); if (eat(':')) parseType(); if (!eat(',')) break; }
    closeAngle();
    return ps;
  }
  function skipWhere() { if (eat('where')) { while (peek() && !is('{')) i++; } }

  /* ---- expressions ---- */
  function expr() { return ternary(); }
  function ternary() {
    const c = binary(0);
    const t = peek();
    if (t && t.t === 'p' && t.v === '?' && t.sp) {
      i++;
      const a = expr();
      expect(':', "after the ternary's first value");
      const b = expr();
      return { k: 'cond', c, a, b, line: c.line };
    }
    return c;
  }
  function binary(minPrec) {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'p' && !(t.t === 'id' && (t.v === 'is' || t.v === 'as'))) break;
      if (t.t === 'id') {                              // casts: is, as, as?, as!
        if (minPrec > 6) break;
        i++;
        if (t.v === 'is') { l = { k: 'is', e: l, type: parseType(), line: t.line }; continue; }
        let kind = 'as';
        const q = peek();
        if (q && q.t === 'p' && (q.v === '?' || q.v === '!') && !q.sp) { i++; kind = 'as' + q.v; }
        l = { k: 'as', kind, e: l, type: parseType(), line: t.line };
        continue;
      }
      const prec = BIN[t.v];
      if (prec === undefined || prec < minPrec) break;
      if (t.nl && (t.v === '<' || t.v === '>' || t.v === '&')) break;
      // a prefix operator on the next line (x\n-y) starts a new statement; a spaced one continues
      if (t.nl && peek(1) && !peek(1).sp && t.v === '-') break;
      i++;
      const r = t.v === '??' ? binary(prec) : binary(prec + 1);   // ?? is right-associative
      if (t.v === '...' || t.v === '..<') { l = { k: 'range', lo: l, hi: r, closed: t.v === '...', line: t.line }; continue; }
      l = { k: 'bin', op: t.v, l, r, line: t.line };
    }
    return l;
  }
  function unary() {
    const t = peek();
    const l = line();
    if (!t) fail(lastLine, 'expected expression (the program ends too early)');
    if (t.t === 'id' && t.v === 'try') {
      i++;
      let kind = 'try';
      const q = peek();
      if (q && q.t === 'p' && (q.v === '?' || q.v === '!') && !q.sp) { i++; kind = 'try' + q.v; }
      return { k: 'try', kind, e: binary(5), line: l };
    }
    if (t.t === 'p') {
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
        i++;
        const e = unary();
        if (t.v === '-' && e.k === 'num') return { ...e, v: '-' + e.v };
        return { k: 'unary', op: t.v, e, line: l };
      }
      if (t.v === '&') { i++; return { k: 'inout', e: postfix(primary()), line: l }; }
      if (t.v === '...' || t.v === '..<') { i++; return { k: 'range', lo: null, hi: unary(), closed: t.v === '...', line: l }; }
    }
    const e = postfix(primary());
    const q = peek();
    if (q && q.t === 'p' && q.v === '...' && (!peek(1) || is(')', 1) || is(']', 1) || is(',', 1) || peek(1).nl)) { i++; return { k: 'range', lo: e, hi: null, closed: true, line: l }; }   // a[2...]
    return e;
  }
  function args(close) {
    const out = [];
    while (!is(close)) {
      let label = null;
      const t = peek();
      if (t && t.t === 'id' && is(':', 1) && !(peek(1) && peek(1).v === '::')) { label = t.v; i += 2; }
      const save = noTrail; noTrail = 0;
      const o = peek();
      if (o && o.t === 'p' && (BIN[o.v] !== undefined && o.v !== '...' && o.v !== '..<') && (is(',', 1) || is(close, 1))) { i++; out.push({ label, e: { k: 'opref', op: o.v, line: o.line } }); }   // reduce(0, +)
      else out.push({ label, e: expr() });
      noTrail = save;
      if (!eat(',')) break;
    }
    expect(close, close === ')' ? 'in the argument list' : 'in the subscript');
    return out;
  }
  function trailing(call) {
    while (!noTrail && is('{') && !peek().nl) {
      call.args.push({ label: null, e: closure(), trailing: true });
      // more trailing closures: } label: { … }
      while (peek() && peek().t === 'id' && is(':', 1) && is('{', 2) && !peek().nl) { const label = next().v; i++; call.args.push({ label, e: closure(), trailing: true }); }
    }
    return call;
  }
  function postfix(e) {
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === 'p' && t.v === '.') {
        i++;
        const m = peek();
        if (m && m.t === 'num') { i++; e = { k: 'tidx', e, n: +m.v, line: m.line }; continue; }
        const name = word('a member name');
        if (name === 'self') continue;
        e = { k: 'member', e, name, line: t.line };
        continue;
      }
      if (t.nl) break;
      if (t.t === 'p' && t.v === '(' ) { i++; e = trailing({ k: 'call', f: e, args: args(')'), line: e.line }); continue; }
      if (t.t === 'p' && t.v === '[' ) { i++; e = { k: 'index', e, args: args(']'), line: t.line }; continue; }
      if (t.t === 'p' && t.v === '!' && !t.sp) { i++; e = { k: 'force', e, line: t.line }; continue; }
      if (t.t === 'p' && t.v === '?' && !t.sp) { i++; e = { k: 'optq', e, line: t.line }; e.chain = true; continue; }
      if (t.t === 'p' && t.v === '{' && !noTrail && (e.k === 'name' || e.k === 'member' || e.k === 'call' || e.k === 'imember')) {
        e = trailing({ k: 'call', f: e, args: [], line: e.line }); continue;
      }
      break;
    }
    return hasChain(e) ? { k: 'chain', e, line: e.line } : e;
  }
  const hasChain = e => { for (let x = e; x; x = x.e || x.f) { if (x.k === 'optq') return true; if (x.k === 'chain') return false; if (!['member', 'call', 'index', 'force', 'tidx', 'optq'].includes(x.k)) return false; } return false; };
  function strLit(t) {
    const parts = t.v.map(p => (typeof p === 'string' ? p : { e: parseSwift(p.src, p.line, true), line: p.line }));
    if (parts.length === 1) return { k: 'str', v: parts[0], line: t.line };
    return { k: 'interp', parts, line: t.line };
  }
  function primary() {
    const t = next();
    const l = t.line;
    if (t.t === 'num') return { k: 'num', v: t.v, float: t.float, line: l };
    if (t.t === 'str') return strLit(t);
    if (t.t === 'p') {
      if (t.v === '(') {
        const items = [];
        while (!is(')')) {
          let label = null;
          if (peek() && peek().t === 'id' && is(':', 1)) { label = next().v; i++; }
          const save = noTrail; noTrail = 0;
          items.push({ label, e: expr() });
          noTrail = save;
          if (!eat(',')) break;
        }
        expect(')', 'in the parenthesized expression');
        if (items.length === 1 && !items[0].label) return { ...items[0].e, paren: true };
        return { k: 'tuple', items, line: l };
      }
      if (t.v === '[') {
        // a type used as a value: [Int](), [[Int]](repeating: …), [String: Int]()
        const save = i;
        try { i--; const ty = parseType(); if (is('(') && !peek().sp) return { k: 'type', type: ty, line: l }; } catch { /* a literal */ }
        i = save;
        const save2 = noTrail; noTrail = 0;
        try {
          if (eat(':')) { expect(']', 'in an empty dictionary literal'); return { k: 'dictlit', items: [], line: l }; }
          const items = [];
          let dict = null;
          while (!is(']')) {
            const a = expr();
            if (dict === null) dict = is(':');
            if (dict) { expect(':', 'in a dictionary literal'); items.push([a, expr()]); } else items.push(a);
            if (!eat(',')) break;
          }
          expect(']', dict ? 'in the dictionary literal' : 'in the array literal');
          return dict ? { k: 'dictlit', items, line: l } : { k: 'arrlit', items, line: l };
        } finally { noTrail = save2; }
      }
      if (t.v === '{') { i--; return closure(); }
      if (t.v === '.') { const name = word('a member name'); return { k: 'imember', name, line: l }; }
      if (t.v === '\\') fail(l, 'key paths are not supported here');
      fail(l, `expected expression, not ${show(t)}`);
    }
    // words
    switch (t.v) {
      case 'true': case 'false': return { k: 'bool', v: t.v === 'true', line: l };
      case 'nil': return { k: 'nil', line: l };
      case 'self': return { k: 'self', line: l };
      case 'super': return { k: 'super', line: l };
      case 'Self': return { k: 'name', n: 'Self', line: l };
      case 'init': return { k: 'name', n: 'init', line: l };
    }
    if ((t.v === 'if' || t.v === 'switch') && !t.quoted) {      // if and switch expressions (Swift 5.9): each branch gives its value
      i--;
      const st = t.v === 'if' ? ifStmt() : switchStmt();
      return { ...st, k: st.k + 'expr' };
    }
    if (KEYWORDS.has(t.v) && !t.quoted) fail(l, `expected expression, not keyword '${t.v}'`);
    const ga = /^[A-Z]/.test(t.v) ? tryGenericArgs() : null;
    if (ga) {
      const n = t.v;
      const type = n === 'Array' ? { arr: ga[0] } : n === 'Dictionary' ? { dict: ga } : n === 'Set' ? { set: ga[0] } : { n, args: ga };
      return { k: 'type', type, line: l };
    }
    return { k: 'name', n: t.v, line: l };
  }
  function closure() {
    const l = line();
    expect('{');
    let params = null, ret = null;
    const save = i;
    if (is('[')) { let d = 0; do { if (is('[')) d++; else if (is(']')) d--; i++; } while (d && i < toks.length); }
    const afterCap = i;
    try {
      if (is('(')) {
        i++;
        const ps = [];
        while (!is(')')) {
          const n = word('a parameter');
          let type = null;
          if (peek() && peek().t === 'id' && !is(':')) word();              // an external label
          if (eat(':')) type = parseType();
          ps.push({ name: n, type });
          if (!eat(',')) break;
        }
        expect(')');
        eat('throws');
        if (eat('->')) ret = parseType();
        if (eat('in')) params = ps; else throw 0;
      } else {
        const ps = [];
        while (peek() && peek().t === 'id' && !KEYWORDS.has(peek().v) || is('_')) { ps.push({ name: next().v, type: null }); if (!eat(',')) break; }
        if (eat('->')) ret = parseType();
        if (ps.length && eat('in')) params = ps; else if (afterCap !== save && eat('in')) params = []; else throw 0;
      }
    } catch (err) { if (err !== 0 && !(err instanceof Error)) throw err; i = afterCap; params = null; ret = null; if (afterCap !== save && is('in')) { i++; params = []; } }
    const body = stmts('}');
    expect('}', 'at the end of the closure');
    return { k: 'closure', params, ret, body, line: l };
  }

  /* ---- patterns (case, if case, for case, catch) ---- */
  function pattern(bind = false) {
    const l = line();
    if (eat('let') || eat('var')) return pattern(true);
    if (is('_') ) { i++; return { k: 'any', line: l }; }
    if (is('is')) { i++; return { k: 'isType', type: parseType(), line: l }; }
    if (is('(')) {
      i++;
      const items = [];
      while (!is(')')) { if (peek() && peek().t === 'id' && is(':', 1)) i += 2; items.push(pattern(bind)); if (!eat(',')) break; }
      expect(')');
      let p = items.length === 1 ? items[0] : { k: 'ptuple', items, line: l };
      if (is('?') && !peek().sp) { i++; p = { k: 'popt', p, line: l }; }
      return p;
    }
    if (is('.') && peek(1) && peek(1).t === 'id') {
      i++;
      const name = next().v;
      let sub = null;
      if (is('(') && !peek().sp) { i++; sub = []; while (!is(')')) { if (peek() && peek().t === 'id' && is(':', 1)) i += 2; sub.push(pattern(bind)); if (!eat(',')) break; } expect(')'); }
      let p = { k: 'pcase', name, sub, line: l };
      if (is('?') && !peek().sp) { i++; p = { k: 'popt', p, line: l }; }
      return p;
    }
    if (bind && isIdent() && !(is('.', 1))) {
      const name = next().v;
      let p = { k: 'bind', name, line: l };
      if (is('?') && !peek().sp) { i++; p = { k: 'popt', p, line: l }; }
      if (is('as')) { i++; p = { k: 'pas', p, type: parseType(), line: l }; }
      return p;
    }
    // Type.case(let x) or an expression pattern
    if (peek() && peek().t === 'id' && /^[A-Z]/.test(peek().v) && is('.', 1) && peek(2) && peek(2).t === 'id' && is('(', 3)) {
      const tn = next().v; i++; const name = next().v; i++;
      const sub = [];
      while (!is(')')) { if (peek() && peek().t === 'id' && is(':', 1)) i += 2; sub.push(pattern(bind)); if (!eat(',')) break; }
      expect(')');
      return { k: 'pcase', name, sub, tn, line: l };
    }
    const e = binary(4);
    return { k: 'pexpr', e, line: l };
  }

  /* ---- statements ---- */
  function conditions() {
    const cs = [];
    noTrail++;
    try {
      do {
        const l = line();
        if (is('let') || is('var')) {
          const mutable = next().v === 'var';
          const name = ident('a name');
          let type = null;
          if (eat(':')) type = parseType();
          let e;
          if (eat('=')) e = expr(); else e = { k: 'name', n: name, line: l };   // if let x
          cs.push({ k: 'bind', name, type, e, mutable, line: l });
        } else if (is('case')) {
          i++;
          const p = pattern();
          expect('=', 'in the case condition');
          cs.push({ k: 'case', p, e: expr(), line: l });
        } else cs.push({ k: 'expr', e: expr(), line: l });
      } while (eat(','));
    } finally { noTrail--; }
    return cs;
  }
  function block(what) {
    if (!is('{')) fail(line(), `expected '{' ${what || 'to start the body'}`);
    i++;
    const items = stmts('}');
    if (!eat('}')) fail(peek() ? peek().line : lastLine, "expected '}' at end of brace statement");
    return items;
  }
  function stmts(end) {
    const out = [];
    while (peek() && !is(end)) {
      if (eat(';')) continue;
      const s = statement();
      if (s) out.push(s);
      if (peek() && !is(end) && !is(';') && !peek().nl) {
        fail(peek().line, "consecutive statements on a line must be separated by ';'");
      }
    }
    return out;
  }
  function mods() {
    const m = new Set();
    for (;;) {
      if (is('@')) { i++; word('an attribute'); if (is('(') && !peek().sp) { let d = 0; do { if (is('(')) d++; else if (is(')')) d--; i++; } while (d); } continue; }
      const t = peek();
      if (t && t.t === 'id' && MODIFIERS.has(t.v) && peek(1) && (peek(1).t === 'id' || is('(', 1) || is('@', 1))) {
        i++;
        if (is('(') && (t.v === 'private' || t.v === 'fileprivate' || t.v === 'public' || t.v === 'internal')) { i++; word(); expect(')'); continue; }   // private(set)
        if (t.v === 'unowned' && is('(')) { i++; word(); expect(')'); }
        m.add(t.v);
        continue;
      }
      if (t && t.v === 'class' && t.t === 'id' && peek(1) && ['func', 'var', 'let', 'subscript'].includes(peek(1).v)) { i++; m.add('static'); continue; }
      break;
    }
    return m;
  }
  function statement() {
    const l = line();
    const m = mods();
    const t = peek();
    if (!t) fail(lastLine, 'expected a declaration');
    if (t.t === 'id' && !t.quoted) {
      switch (t.v) {
        case 'import': i++; { let n = word('a module name'); while (eat('.')) n += '.' + word(); return { k: 'import', name: n, line: l }; }
        case 'let': case 'var': return varDecl(m);
        case 'func': return funcDecl(m);
        case 'class': case 'struct': case 'enum': case 'protocol': if (!(is('.', 1))) return typeDecl(m); break;
        case 'extension': return extDecl(m);
        case 'typealias': { i++; const name = ident(); genericParams(); expect('='); return { k: 'typealias', name, type: parseType(), line: l }; }
        case 'init': if (is('(', 1) || is('?', 1) || is('!', 1) || is('<', 1)) return initDecl(m); break;
        case 'deinit': i++; return { k: 'deinit', body: block('after deinit'), line: l };
        case 'subscript': return subscriptDecl(m);
        case 'case': return enumCase(m);
        case 'if': return ifStmt();
        case 'guard': { i++; const conds = conditions(); expect('else', "in the guard statement (guard … else { … })"); return { k: 'guard', conds, else: block('after else'), line: l }; }
        case 'while': { i++; const conds = conditions(); return { k: 'while', conds, body: block('after the while condition'), line: l }; }
        case 'repeat': { i++; const body = block('after repeat'); expect('while', "after the repeat body (repeat { … } while …)"); noTrail++; const c = expr(); noTrail--; return { k: 'repeat', body, cond: c, line: l, endLine: c.line }; }
        case 'for': return forStmt();
        case 'switch': return switchStmt();
        case 'return': { i++; return { k: 'return', e: endOfStmt() ? null : expr(), line: l }; }
        case 'break': { i++; return { k: 'break', label: !endOfStmt() && isIdent() ? next().v : null, line: l }; }
        case 'continue': { i++; return { k: 'continue', label: !endOfStmt() && isIdent() ? next().v : null, line: l }; }
        case 'fallthrough': i++; return { k: 'fallthrough', line: l };
        case 'throw': { i++; return { k: 'throw', e: expr(), line: l }; }
        case 'defer': i++; return { k: 'defer', body: block('after defer'), line: l };
        case 'do': return doStmt();
        case 'associatedtype': i++; ident(); if (eat(':')) parseType(); return null;
        case 'operator': fail(l, 'custom operators are not supported here');
      }
      // a label: name: for / while / repeat / switch / if / do
      if (isIdent() && is(':', 1) && peek(2) && ['for', 'while', 'repeat', 'switch', 'if', 'do'].includes(peek(2).v)) {
        const label = next().v; i++;
        const s = statement();
        s.label = label;
        return s;
      }
    }
    if (m.size) fail(l, `expected declaration after '${[...m][0]}'`);
    const e = expr();
    const a = peek();
    if (a && a.t === 'p' && ASSIGN.has(a.v)) {
      i++;
      const r = expr();
      return { k: 'assign', op: a.v, l: e, r, line: l };
    }
    return { k: 'expr', e, line: l };
  }
  function ifStmt() {
    const l = line();
    expect('if');
    const conds = conditions();
    const then = block('after the if condition');
    let els = null;
    if (eat('else')) {
      if (is('if')) els = [ifStmt()];
      else els = block('after else');
    }
    return { k: 'if', conds, then, else: els, line: l };
  }
  function forStmt() {
    const l = line();
    expect('for');
    let pat;
    if (eat('case')) pat = pattern(); else pat = pattern(true);
    expect('in', 'in the for-in loop');
    noTrail++;
    const seq = expr();
    let where = null;
    if (eat('where')) where = expr();
    noTrail--;
    return { k: 'for', pat, seq, where, body: block('after the for-in sequence'), line: l };
  }
  function switchStmt() {
    const l = line();
    expect('switch');
    noTrail++; const subject = expr(); noTrail--;
    expect('{', 'after the switch subject');
    const cases = [];
    while (!is('}')) {
      const cl = line();
      if (is('@')) { i++; word(); continue; }
      if (eat('default')) {
        expect(':', "after 'default'");
        cases.push({ pats: null, body: caseBody(), line: cl });
        continue;
      }
      if (!eat('case')) fail(line(), "all statements inside a switch must be covered by a 'case' or 'default'");
      const pats = [];
      do {
        const p = pattern();
        let where = null;
        if (eat('where')) where = expr();
        pats.push({ p, where });
      } while (eat(','));
      expect(':', 'after the case pattern');
      const body = caseBody();
      if (!body.length) fail(cl, "'case' label in a 'switch' must have at least one executable statement");
      cases.push({ pats, body, line: cl });
    }
    expect('}', 'to end the switch');
    return { k: 'switch', subject, cases, line: l };
  }
  function caseBody() {
    const out = [];
    while (peek() && !is('case') && !is('default') && !is('}') && !(is('@') && is('unknown', 1))) {
      if (eat(';')) continue;
      out.push(statement());
    }
    return out;
  }
  function doStmt() {
    const l = line();
    expect('do');
    const body = block('after do');
    const catches = [];
    while (is('catch')) {
      const cl = line(); i++;
      let p = null, where = null;
      if (!is('{')) { p = pattern(); if (eat('where')) where = expr(); }
      catches.push({ p, where, body: block('after catch'), line: cl });
    }
    return { k: 'do', body, catches, line: l };
  }
  function varDecl(m) {
    const l = line();
    const mutable = next().v === 'var';
    const out = [];
    do {
      const dl = line();
      if (is('(')) {
        const p = pattern(true);
        let type = null;
        if (eat(':')) type = parseType();
        expect('=', 'in the tuple declaration');
        out.push({ k: 'destructure', p, type, init: expr(), mutable, line: dl, mods: m });
        continue;
      }
      const name = ident('a variable name');
      let type = null, init = null, acc = null;
      if (eat(':')) type = parseType();
      if (eat('=')) init = expr();
      if (is('{') ) acc = accessors(mutable);
      out.push({ k: 'var', name, type, init, mutable, acc, mods: m, line: dl });
    } while (eat(','));
    return out.length === 1 ? out[0] : { k: 'multi', items: out, line: l };
  }
  /** { get … set … } / { willSet … didSet … } / { expr } after a property */
  function accessors(mutable) {
    const l = line();
    expect('{');
    const acc = {};
    const isAcc = () => ['get', 'set', 'willSet', 'didSet'].includes(peek() && peek().v) && (is('{', 1) || is('(', 1) || is('}', 1) || (peek(1) && ['get', 'set'].includes(peek(1).v)) || (peek(1) && peek(1).nl));
    if (!isAcc()) { acc.get = stmts('}'); expect('}'); acc.line = l; return acc; }
    while (!is('}')) {
      mods();
      const w = next().v;
      if (!['get', 'set', 'willSet', 'didSet'].includes(w)) fail(line(), `expected 'get', 'set', 'willSet' or 'didSet' accessor`);
      let param = null;
      if (eat('(')) { param = ident(); expect(')'); }
      if (is('{')) acc[w] = { param, body: block('of the ' + w) };
      else acc[w] = { param, body: null };          // protocol requirement: { get set }
    }
    expect('}');
    if (acc.get && !acc.get.body) return { req: true, get: true, set: !!acc.set };
    if (!mutable && (acc.set || acc.didSet || acc.willSet)) fail(l, "'let' declarations cannot be computed properties");
    acc.line = l;
    if (acc.get) acc.get = acc.get.body;
    return acc;
  }
  function params() {
    expect('(', 'to start the parameter list');
    const ps = [];
    while (!is(')')) {
      const l = line();
      if (!(peek() && peek().t === 'id')) fail(line(), "expected parameter name followed by ':'");
      const a = word('a parameter name');
      let label = a, name = a;
      if (peek() && peek().t === 'id' && !is(':')) name = next().v;
      if (label === '_' && name === '_') label = null;
      else if (label === '_') label = null;
      expect(':', `after the parameter name '${name}'`);
      const type = parseType();
      let variadic = false, def = null;
      if (eat('...')) variadic = true;
      if (eat('=')) def = expr();
      ps.push({ label, name, type, variadic, def, inout: !!type.inout, line: l });
      if (!eat(',')) break;
    }
    expect(')', 'to end the parameter list');
    return ps;
  }
  function funcDecl(m) {
    const l = line();
    expect('func');
    let name;
    const t = peek();
    if (t && t.t === 'p' && t.v !== '(') name = next().v;        // static func == (…)
    else name = word('a function name');
    const tps = name === '<' ? [] : genericParams();
    const ps = params();
    let throws = false;
    if (eat('async')) { fail(l, 'async functions are not supported here'); }
    if (eat('throws') || eat('rethrows')) throws = true;
    let ret = null;
    if (eat('->')) ret = parseType();
    skipWhere();
    const body = is('{') ? block('of the function') : null;
    return { k: 'func', name, params: ps, ret, throws, body, mods: m, tps, line: l, endLine: body ? toks[i - 1].line : l };
  }
  function initDecl(m) {
    const l = line();
    expect('init');
    let failable = false;
    if (is('?') || is('!')) { i++; failable = true; }
    genericParams();
    const ps = params();
    let throws = false;
    if (eat('throws')) throws = true;
    skipWhere();
    const body = is('{') ? block('of the initializer') : null;
    return { k: 'init', params: ps, body, failable, throws, mods: m, line: l, endLine: body ? toks[i - 1].line : l };
  }
  function subscriptDecl(m) {
    const l = line();
    expect('subscript');
    const ps = params();
    expect('->', 'in the subscript');
    const ret = parseType();
    const acc = accessors(true);
    return { k: 'subscript', params: ps, ret, acc, mods: m, line: l };
  }
  function enumCase(m) {
    const l = line();
    expect('case');
    const out = [];
    do {
      const cl = line();
      const name = ident('an enum case name');
      let assoc = null, raw = null;
      if (is('(')) {
        i++; assoc = [];
        while (!is(')')) {
          let label = null;
          if (peek() && peek().t === 'id' && is(':', 1)) { label = next().v; i++; }
          const type = parseType();
          let def = null;
          if (eat('=')) def = expr();
          assoc.push({ label, type, def });
          if (!eat(',')) break;
        }
        expect(')');
      }
      if (eat('=')) raw = unary();
      out.push({ name, assoc, raw, line: cl, indirect: m.has('indirect') });
    } while (eat(','));
    return { k: 'case', cases: out, line: l };
  }
  function inheritance() {
    const out = [];
    if (eat(':')) do { out.push(parseType()); } while (eat(','));
    return out;
  }
  function typeDecl(m) {
    const l = line();
    const kind = next().v;
    const name = ident('a type name');
    const tps = genericParams();
    const supers = inheritance();
    skipWhere();
    expect('{', `to start the ${kind}`);
    const members = [];
    while (!is('}')) {
      if (eat(';')) continue;
      const s = statement();
      if (!s) continue;
      if (s.k === 'multi') members.push(...s.items); else members.push(s);
    }
    expect('}', `to end the ${kind}`);
    return { k: 'type', kind, name, tps, supers, members, mods: m, line: l };
  }
  function extDecl(m) {
    const l = line();
    expect('extension');
    const t = parseType();
    const supers = inheritance();
    skipWhere();
    expect('{', 'to start the extension');
    const members = [];
    while (!is('}')) {
      if (eat(';')) continue;
      const s = statement();
      if (!s) continue;
      if (s.k === 'multi') members.push(...s.items); else members.push(s);
    }
    expect('}', 'to end the extension');
    return { k: 'ext', type: t, supers, members, mods: m, line: l };
  }

  if (exprOnly) {
    const e = expr();
    if (i < toks.length) fail(toks[i].line, 'expected \')\' in string interpolation');
    return e;
  }
  const items = stmts(null);
  if (i < toks.length) fail(toks[i].line, `unexpected ${show(toks[i])}: extraneous '}' at top level`);
  return { items };
}
