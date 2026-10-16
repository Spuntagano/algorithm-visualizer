/**
 * The Go front end: a lexer (with Go's automatic semicolons) and a recursive-descent parser for the Go that
 * algorithms use: package main, imports, funcs with receivers and several results, structs (with embedding),
 * interfaces, named types, generics (parsed, then erased), closures, defer, switch and type switches, for and range,
 * labels, composite literals, slices and maps. parseGo(source) returns { imports, decls } or throws "line N: …".
 * Go's own compile errors that matter to beginners are checked here too: unused variables and unused imports.
 */
export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const KEYWORDS = new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto',
  'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']);
const PUNCT = ['<<=', '>>=', '&^=', '...', '&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
  '^=', '<<', '>>', '&^'];

/* ---- lexer ---- */
const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
function unescape(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const e = body[++i];
    if (e === 'x') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; }
    else if (e === 'u' || e === 'U') { const n = e === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(body.slice(i + 1, i + 1 + n), 16)); i += n; }
    else if (/[0-7]/.test(e)) { out += String.fromCharCode(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else if (e in ESC) out += ESC[e];
    else fail(line, 'unknown escape sequence \\' + e);
  }
  return out;
}
export function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  /** Go puts a ; at the end of a line after a name, a literal, break, continue, fallthrough, return, ++, --, ), ] or } */
  const semi = () => {
    const t = toks.at(-1);
    if (t && (t.t === 'id' && (!KEYWORDS.has(t.v) || ['break', 'continue', 'fallthrough', 'return'].includes(t.v)) || t.t === 'num' || t.t === 'str' || t.t === 'chr' || (t.t === 'p' && ['++', '--', ')', ']', '}'].includes(t.v))))
      toks.push({ t: 'p', v: ';', line, auto: true, pos: i, end: i });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { semi(); line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) fail(line, 'comment not terminated');
      const nl = (src.slice(i, e).match(/\n/g) || []).length;
      if (nl) semi();
      line += nl; i = e + 2; continue;
    }
    const start = i, l0 = line, tok = t => toks.push({ ...t, line: l0, pos: start, end: i });
    if (/[A-Za-z_À-￿]/.test(c)) { while (/[A-Za-z0-9_À-￿]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) { i += 2; while (/[0-9a-fA-F_]/.test(src[i] || '')) i++; }
      else {
        while (/[0-9_]/.test(src[i] || '')) i++;
        if (src[i] === '.') { i++; while (/[0-9_]/.test(src[i] || '')) i++; }
        if (/[eE]/.test(src[i] || '')) { i++; if (/[+-]/.test(src[i])) i++; while (/[0-9]/.test(src[i] || '')) i++; }
      }
      tok({ t: 'num', v: src.slice(start, i) }); continue;
    }
    if (c === '`') { const e = src.indexOf('`', i + 1); if (e < 0) fail(line, 'raw string literal not terminated'); const raw = src.slice(i + 1, e); line += (raw.match(/\n/g) || []).length; i = e + 1; tok({ t: 'str', v: raw.replace(/\r/g, '') }); continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== c) fail(line, (c === '"' ? 'string' : 'rune') + ' literal not terminated');
      const body = unescape(src.slice(i + 1, j), line);
      i = j + 1;
      if (c === "'") { if ([...body].length !== 1) fail(line, 'more than one character in rune literal'); tok({ t: 'chr', v: body.codePointAt(0) }); }
      else tok({ t: 'str', v: body });
      continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~:=?'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'invalid character ' + JSON.stringify(c));
  }
  semi();
  return toks;
}

/* ---- parser ---- */
export function parseGo(src) {
  const toks = lex(src);
  let i = 0, noLit = 0;                              // noLit: in an if / for / switch header, T{ is not a composite literal
  const lastLine = toks.length ? toks.at(-1).line : 1, eofLine = src.replace(/\n$/, '').split('\n').length + (src.endsWith('\n') ? 1 : 0);
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || t.t === 'id') && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(eofLine, 'syntax error: unexpected EOF'); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  /** a token as Go's errors name it: newline, EOF, name x, keyword for, literal 5, ) */
  const show = t => (!t ? 'EOF' : t.auto ? 'newline' : t.t === 'str' ? 'literal ' + JSON.stringify(t.v.slice(0, 10)) : t.t === 'num' ? 'literal ' + t.v : t.t === 'chr' ? 'literal ' + "'" + String.fromCodePoint(t.v) + "'" : t.t === 'id' ? (KEYWORDS.has(t.v) ? 'keyword ' : 'name ') + t.v : t.v);
  const expect = (v, what) => { if (eat(v)) return; const t = peek(); fail(t ? t.line : eofLine, `syntax error: unexpected ${show(t)}, expected ${v}${what ? ' ' + what : ''}`); };
  const isIdent = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && !KEYWORDS.has(t.v); };
  const ident = what => { const t = peek(); if (!isIdent()) fail(t ? t.line : lastLine, `syntax error: unexpected ${show(t)}, expected ${what || 'name'}`); i++; return t.v; };
  const node = (k, l, o) => ({ k, line: l, ...o });
  const skipSemis = () => { while (is(';')) i++; };

  /* types */
  function type() {
    const l = line(), t = peek();
    if (!t) fail(lastLine, 'unexpected end of the program, expected a type');
    if (eat('*')) return { k: 'ptr', elem: type(), line: l };
    if (eat('(')) { const ty = type(); expect(')'); return ty; }
    if (is('[')) {
      i++;
      if (eat(']')) return { k: 'slice', elem: type(), line: l };
      if (eat('...')) { expect(']'); return { k: 'array', len: null, elem: type(), line: l }; }
      const n = expression(); expect(']');
      return { k: 'array', len: n, elem: type(), line: l };
    }
    if (eat('map')) { expect('['); const key = type(); expect(']'); return { k: 'map', key, val: type(), line: l }; }
    if (eat('chan')) fail(l, 'channels (and goroutines) are not supported here');
    if (eat('func')) { const sig = signature(); return { k: 'func', ...sig, line: l }; }
    if (eat('struct')) return structType(l);
    if (eat('interface')) return ifaceType(l);
    if (isIdent()) {
      let name = ident();
      if (is('.') && isIdent(1)) { i++; name += '.' + ident(); }
      let args = null;
      if (is('[') && !is(']', 1)) {                     // a generic type: Stack[int]
        const save = i;
        try { i++; args = [type()]; while (eat(',')) args.push(type()); expect(']'); }
        catch (err) { if (!/^line/.test(err.message)) throw err; i = save; args = null; }
      }
      return { k: 'name', name, args, line: l };
    }
    fail(l, `syntax error: unexpected ${show(t)}, expected a type`);
  }
  function structType(l) {
    expect('{');
    const fields = [];
    while (!eat('}')) {
      skipSemis();
      if (eat('}')) break;
      const fl = line();
      if (is('*') || (isIdent() && (is(';', 1) || is('}', 1) || is('.', 1)))) {   // an embedded field: Base, *Base
        const ptr = eat('*'); const t = type(); const name = t.name.split('.').pop();
        fields.push({ name, type: ptr ? { k: 'ptr', elem: t } : t, embedded: true, line: fl });
      } else {
        const names = [ident('field name')];
        while (eat(',')) names.push(ident('field name'));
        const t = type();
        if (peek() && peek().t === 'str') i++;          // a field tag
        for (const n of names) fields.push({ name: n, type: t, line: fl });
      }
      if (!is('}')) expect(';', 'after a field');
    }
    return { k: 'struct', fields, line: l };
  }
  function ifaceType(l) {
    expect('{');
    const methods = [];
    while (!eat('}')) {
      skipSemis();
      if (eat('}')) break;
      if (isIdent() && is('(', 1)) { const name = ident(); methods.push({ name, ...signature() }); }
      else { do { eat('~'); type(); } while (eat('|')); }   // an embedded interface or a type set (constraints)
      if (!is('}')) expect(';');
    }
    return { k: 'iface', methods, line: l };
  }
  /** (a, b int, c string) (int, error): each entry is "name Type" or "Type"; with names, a bare name takes the next type */
  function params() {
    expect('(');
    const items = [];
    const typeNext = o => { const t = peek(o); return !!t && ((t.t === 'id' && (!KEYWORDS.has(t.v) || ['map', 'func', 'chan', 'struct', 'interface'].includes(t.v))) || (t.t === 'p' && ['*', '[', '...', '('].includes(t.v))); };
    while (!eat(')')) {
      skipSemis();
      if (eat(')')) break;
      const l = line();
      if (isIdent() && !is('.', 1) && typeNext(1)) { const name = ident(); const variadic = eat('...'); items.push({ name, type: type(), variadic, l }); }
      else { const variadic = eat('...'); items.push({ name: null, type: type(), variadic, l }); }
      if (!eat(',')) { skipSemis(); expect(')', 'after the parameters'); break; }
    }
    if (!items.some(x => x.name)) return items.map(x => ({ name: null, type: x.type, variadic: x.variadic }));
    const out = [];
    let pending = [];
    for (const x of items) {
      if (x.name) { for (const n of pending) out.push({ name: n, type: x.type, variadic: false }); pending = []; out.push({ name: x.name, type: x.type, variadic: x.variadic }); }
      else if (x.type.k === 'name' && !x.type.args && !x.type.name.includes('.')) pending.push(x.type.name);
      else fail(x.l, 'syntax error: mixed named and unnamed parameters');
    }
    if (pending.length) fail(items[0].l, 'syntax error: mixed named and unnamed parameters');
    return out;
  }
  function signature() {
    const ps = params();
    let results = [];
    if (is('(')) results = params();
    else if (!is('{') && !is(';') && !is(')') && !is(',') && !is(']') && !is('}') && !is('=') && peek() && !(peek().t === 'str')) results = [{ name: null, type: type() }];
    return { params: ps, results };
  }
  const typeParams = () => {
    if (!is('[')) return [];
    i++;
    const names = [];
    do { names.push(ident('type parameter')); while (!is(',') && !is(']')) { if (eat('|') || eat('~')) continue; type(); } } while (eat(','));
    expect(']');
    return names;
  };

  /* statements */
  function block() {
    const l = line(); expect('{');
    const items = [];
    for (;;) {
      skipSemis();
      if (i >= toks.length) fail(eofLine, 'syntax error: unexpected EOF, expected }');
      if (eat('}')) break;
      items.push(statement());
      if (!is('}') && !eat(';')) fail(line(), `syntax error: unexpected ${show(peek())} at end of statement`);
    }
    return { k: 'block', items, line: l };
  }
  function simpleStmt() {
    const l = line();
    const lhs = [expression()];
    while (eat(',')) lhs.push(expression());
    const t = peek();
    if (t && t.t === 'p') {
      if (t.v === ':=' || t.v === '=') {
        i++;
        if (eat('range')) return node('range', l, { lhs, define: t.v === ':=', e: expression() });
        const rhs = [expression()];
        while (eat(',')) rhs.push(expression());
        if (t.v === ':=') { for (const x of lhs) if (x.k !== 'name') fail(l, `non-name ${srcOf(x)} on left side of :=`); return node('define', l, { names: lhs.map(x => x.name), rhs }); }
        return node('assign', l, { lhs, rhs, op: '=' });
      }
      if (/^([+\-*/%&|^]|<<|>>|&\^)=$/.test(t.v)) { i++; return node('assign', l, { lhs, rhs: [expression()], op: t.v }); }
      if (t.v === '++' || t.v === '--') { i++; return node('incdec', l, { e: lhs[0], op: t.v }); }
      if (t.v === '<-') fail(l, 'channels (and goroutines) are not supported here');
    }
    if (lhs.length > 1) fail(l, 'syntax error: unexpected ' + show(t) + ', expected := or = or comma');
    return node('expr', l, { e: lhs[0] });
  }
  const srcOf = x => (x.k === 'name' ? x.name : 'expression');
  function varDecl(isConst, l) {
    const specs = [];
    const one = (prev) => {
      const sl = line(), names = [ident()];
      while (eat(',')) names.push(ident());
      let t = null, vals = null;
      if (!is('=') && !is(';') && !is(')')) t = type();
      if (eat('=')) { vals = [expression()]; while (eat(',')) vals.push(expression()); }
      if (isConst && !vals) { if (!prev) fail(sl, 'missing init expr for const declaration'); t = prev.t; vals = prev.vals; }
      return { names, type: t, vals, line: sl, t, iota: 0 };
    };
    if (eat('(')) {
      let prev = null, iota = 0;
      for (;;) { skipSemis(); if (eat(')')) break; const s = one(prev); s.iota = iota++; specs.push(s); prev = s; if (!is(')')) expect(';'); }
    } else specs.push(one(null));
    return { k: isConst ? 'const' : 'var', specs, line: l };
  }
  function typeDecl(l) {
    const one = () => {
      const tl = line(), name = ident('type name');
      const tps = is('[') && isIdent(1) && !is(']', 2) ? typeParams() : [];
      const alias = eat('=');
      return { name, type: type(), tparams: tps, alias, line: tl };
    };
    const specs = [];
    if (eat('(')) { for (;;) { skipSemis(); if (eat(')')) break; specs.push(one()); if (!is(')')) expect(';'); } }
    else specs.push(one());
    return { k: 'type', specs, line: l };
  }
  function statement() {
    const t = peek(), l = line();
    if (t.t === 'p' && t.v === '{') return block();
    if (t.t === 'id') {
      if (isIdent() && is(':', 1) && !is(':=', 1)) { i += 2; skipSemis(); return node('label', l, { label: t.v, body: is('}') ? node('empty', l, {}) : statement() }); }
      switch (t.v) {
        case 'var': i++; return varDecl(false, l);
        case 'const': i++; return varDecl(true, l);
        case 'type': i++; return typeDecl(l);
        case 'return': { i++; const es = []; if (!is(';') && !is('}')) { es.push(expression()); while (eat(',')) es.push(expression()); } return node('return', l, { es }); }
        case 'break': case 'continue': { i++; const label = isIdent() ? ident() : null; return node(t.v, l, { label }); }
        case 'fallthrough': i++; return node('fallthrough', l, {});
        case 'goto': fail(l, 'goto is not supported here');
        // falls through
        case 'go': fail(l, 'goroutines (go f()) are not supported here');
        // falls through
        case 'select': fail(l, 'select (and channels) are not supported here');
        // falls through
        case 'defer': { i++; const e = expression(); if (e.k !== 'call') fail(l, 'expression in defer must be function call'); return node('defer', l, { e }); }
        case 'if': return ifStmt();
        case 'for': return forStmt();
        case 'switch': return switchStmt();
      }
    }
    if (t.t === 'p' && t.v === ';') return node('empty', l, {});
    return simpleStmt();
  }
  function ifStmt() {
    const l = line(); i++;
    noLit++;
    let init = null, cond;
    const s = simpleStmt();
    if (eat(';')) { init = s; cond = expression(); } else { if (s.k !== 'expr') fail(l, 'cannot use ' + s.k + ' as value'); cond = s.e; }
    noLit--;
    const a = block();
    let b = null;
    if (eat('else')) b = is('if') ? ifStmt() : block();
    return node('if', l, { init, cond, a, b });
  }
  function forStmt() {
    const l = line(); i++;
    if (is('{')) return node('for', l, { init: null, cond: null, post: null, body: block() });
    noLit++;
    let init = null, cond = null, post = null, r = null;
    if (is('range')) { i++; r = node('range', l, { lhs: [], define: false, e: expression() }); }
    else if (!is(';')) {
      const s = simpleStmt();
      if (s.k === 'range') r = s;
      else if (is('{')) { if (s.k !== 'expr') fail(l, 'expected for loop condition'); cond = s.e; }
      else init = s;
    }
    if (!r && !cond && is(';')) {
      expect(';');
      if (!is(';')) cond = expression();
      expect(';');
      if (!is('{')) post = simpleStmt();
    }
    noLit--;
    const body = block();
    if (r) return node('forrange', l, { r, body });
    return node('for', l, { init, cond, post, body });
  }
  function switchStmt() {
    const l = line(); i++;
    noLit++;
    let init = null, tag = null, typeSw = null;
    if (!is('{')) {
      const s1 = is(';') ? null : simpleStmt();
      if (eat(';')) { init = s1; if (!is('{')) tag = simpleStmt(); } else tag = s1;
    }
    noLit--;
    if (tag) {                                         // switch v := x.(type)
      const e = tag.k === 'define' ? tag.rhs[0] : tag.k === 'expr' ? tag.e : null;
      if (e && e.k === 'typeAssert' && e.type === 'type') typeSw = { bind: tag.k === 'define' ? tag.names[0] : null, e: e.e };
      else if (tag.k !== 'expr') fail(l, 'switch expression must be an expression');
    }
    expect('{');
    const cases = [];
    for (;;) {
      skipSemis();
      if (eat('}')) break;
      const cl = line();
      let exprs = null;
      if (eat('default')) exprs = null;
      else { expect('case'); exprs = []; do exprs.push(typeSw ? (is('nil') ? (i++, { k: 'name', name: 'nil' }) : type()) : expression()); while (eat(',')); }
      expect(':');
      const body = [];
      for (;;) { skipSemis(); if (is('case') || is('default') || is('}')) break; body.push(statement()); if (!is('}') && !is('case') && !is('default')) expect(';'); }
      cases.push({ exprs, body, line: cl });
    }
    return node('switch', l, { init, tag: typeSw ? null : tag && tag.e, typeSw, cases });
  }

  /* expressions */
  const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3, '+': 4, '-': 4, '|': 4, '^': 4, '*': 5, '/': 5, '%': 5, '<<': 5, '>>': 5, '&': 5, '&^': 5 };
  function expression(prec = 1) {
    let e = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'p' || !PREC[t.v] || PREC[t.v] < prec) return e;
      i++;
      const r = expression(PREC[t.v] + 1);
      e = node(t.v === '&&' ? 'and' : t.v === '||' ? 'or' : 'bin', t.line, { op: t.v, l: e, r });
    }
  }
  function unary() {
    const t = peek(), l = line();
    if (t && t.t === 'p') {
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '^') { i++; return node('un', l, { op: t.v, e: unary() }); }
      if (t.v === '*') { i++; return node('deref', l, { e: unary() }); }
      if (t.v === '&') { i++; return node('addr', l, { e: unary() }); }
      if (t.v === '<-') fail(l, 'channels (and goroutines) are not supported here');
    }
    return primary();
  }
  function operand() {
    const t = next(), l = t.line;
    if (t.t === 'num') return number(t);
    if (t.t === 'str') return node('lit', l, { v: t.v, kind: 'string' });
    if (t.t === 'chr') return node('lit', l, { v: t.v, kind: 'rune' });
    if (t.t === 'p' && t.v === '(') { noLit++; const save = noLit; noLit = 0; const e = expression(); noLit = save; noLit--; expect(')'); return node('paren', l, { e }); }
    if (t.t === 'id' && t.v === 'func') {
      const sig = signature();
      if (!is('{')) return node('typeExpr', l, { type: { k: 'func', ...sig } });
      const save = noLit; noLit = 0;
      const body = block();
      noLit = save;
      return node('funcLit', l, { ...sig, body });
    }
    if (t.t === 'p' && t.v === '[' || (t.t === 'id' && ['map', 'struct', 'interface', 'chan'].includes(t.v))) {
      i--;
      const ty = type();
      if (is('{')) return compositeLit(ty, l);
      return node('typeExpr', l, { type: ty });
    }
    if (t.t === 'id' && !KEYWORDS.has(t.v)) return node('name', l, { name: t.v });
    fail(l, `syntax error: unexpected ${show(t)}, expected expression`);
  }
  function compositeLit(ty, l) {
    expect('{');
    const elems = [];
    for (;;) {
      skipSemis();
      if (eat('}')) break;
      const el = elem();
      if (eat(':')) elems.push({ key: el, val: elem() }); else elems.push({ key: null, val: el });
      if (!eat(',')) { if (eat('}')) break; fail(line(), `syntax error: unexpected ${show(peek())} in composite literal; possibly missing comma or }`); }
    }
    return node('composite', l, { type: ty, elems });
  }
  /** an element of a composite literal: a value, or {…} with its type left out */
  const elem = () => (is('{') ? compositeLit(null, line()) : (() => { const save = noLit; noLit = 0; const e = expression(); noLit = save; return e; })());
  function primary() {
    let e = operand();
    for (;;) {
      const l = line();
      if (is('.')) {
        i++;
        if (eat('(')) { if (eat('type')) { expect(')'); e = node('typeAssert', l, { e, type: 'type' }); continue; } const ty = type(); expect(')'); e = node('typeAssert', l, { e, type: ty }); continue; }
        e = node('sel', l, { e, name: ident('field or method name') });
        continue;
      }
      if (is('(')) {
        i++;
        const args = [];
        let spread = false;
        const save = noLit; noLit = 0;
        while (!eat(')')) {
          args.push(expression());
          if (eat('...')) spread = true;
          if (!eat(',')) { skipSemis(); expect(')', 'after the arguments'); break; }
          skipSemis();
        }
        noLit = save;
        e = node('call', l, { f: e, args, spread });
        continue;
      }
      if (is('[')) {
        i++;
        const save = noLit; noLit = 0;
        let lo = null, hi = null, max = null, slice = false;
        if (!is(':')) lo = expression();
        if (eat(':')) { slice = true; if (!is(']') && !is(':')) hi = expression(); if (eat(':')) max = expression(); }
        else if (is(',')) {                            // f[int, string]: a generic instantiation
          const tys = [lo]; while (eat(',')) tys.push(expression());
          expect(']'); noLit = save;
          e = node('inst', l, { e, args: tys });
          continue;
        }
        noLit = save;
        expect(']');
        e = slice ? node('slice', l, { e, lo, hi, max }) : node('index', l, { e, i: lo });
        continue;
      }
      if (is('{') && !noLit && litType(e)) { e = compositeLit(typeFromExpr(e), l); continue; }
      return e;
    }
  }
  /** Can this expression name a type, for T{…}? (a name, pkg.Name, Name[T]) */
  const litType = e => e.k === 'name' || (e.k === 'sel' && e.e.k === 'name') || ((e.k === 'inst' || e.k === 'index') && e.e.k === 'name' && /^[A-Z]|^[a-z]/.test(e.e.name));
  const typeFromExpr = e => (e.k === 'name' ? { k: 'name', name: e.name, line: e.line } : e.k === 'sel' ? { k: 'name', name: e.e.name + '.' + e.name, line: e.line } : { k: 'name', name: e.e.name, args: [], line: e.line });
  function number(t) {
    const raw = t.v.replace(/_/g, ''), l = t.line;
    if (/^0[xX][0-9a-fA-F]+$|^0[bB][01]+$|^0[oO][0-7]+$|^[0-9]+$/.test(raw) && !/^0[0-9]*[89]/.test(raw)) {
      const big = /^0[oO]/.test(raw) ? BigInt('0o' + raw.slice(2)) : /^0[0-7]+$/.test(raw) ? BigInt('0o' + raw.slice(1)) : BigInt(raw);
      return node('lit', l, { v: big, kind: 'int' });
    }
    const f = parseFloat(raw);
    if (Number.isNaN(f)) fail(l, 'invalid number ' + t.v);
    return node('lit', l, { v: f, kind: 'float' });
  }

  /* the file */
  skipSemis();
  if (!is('package')) fail(line(), 'expected \'package\', found ' + show(peek()) + ' (a Go file starts with package main)');
  i++;
  const pkg = ident('package name');
  if (pkg !== 'main') fail(line(), 'package ' + pkg + ': the program must be package main');
  expect(';');
  const imports = [];
  skipSemis();
  while (is('import')) {
    const l = line(); i++;
    const one = () => { const alias = isIdent() ? ident() : (eat('.') ? '.' : eat('_') ? '_' : null); const t = next(); if (t.t !== 'str') fail(l, 'missing import path'); imports.push({ path: t.v, alias, line: t.line }); };
    if (eat('(')) { for (;;) { skipSemis(); if (eat(')')) break; one(); if (!is(')')) expect(';'); } } else one();
    expect(';'); skipSemis();
  }
  const decls = [];
  while (i < toks.length) {
    skipSemis();
    if (i >= toks.length) break;
    const l = line();
    if (eat('func')) {
      let recv = null;
      if (is('(')) { const ps = params(); if (ps.length !== 1) fail(l, 'method has multiple receivers'); recv = ps[0]; }
      const name = ident('function name');
      const tps = typeParams();
      const sig = signature();
      if (!is('{')) fail(l, 'missing function body');
      decls.push({ k: 'func', name, recv, tparams: tps, ...sig, body: block(), line: l });
    } else if (eat('var')) decls.push(varDecl(false, l));
    else if (eat('const')) decls.push(varDecl(true, l));
    else if (eat('type')) decls.push(typeDecl(l));
    else if (is('import')) fail(l, 'syntax error: imports must appear before other declarations');
    else fail(l, `syntax error: non-declaration statement outside function body`);
    if (i < toks.length) expect(';', 'after top level declaration');
  }
  unusedCheck(imports, decls);
  return { imports, decls };
}

/* ---- Go's compile errors for unused variables and imports ---- */
function unusedCheck(imports, decls) {
  const used = new Set();                             // package names used anywhere
  const walk = (n, fn) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, fn)); return; }
    fn(n);
    for (const [k, v] of Object.entries(n)) if (k !== 'line' && v && typeof v === 'object') walk(v, fn);
  };
  walk(decls, n => { if (n.k === 'sel' && n.e.k === 'name') used.add(n.e.name); if (n.k === 'name' && n.name && n.name.includes('.')) used.add(n.name.split('.')[0]); });
  for (const im of imports) {
    const name = im.alias || im.path.split('/').pop();
    if (im.alias === '_' || im.alias === '.') continue;
    if (!used.has(name)) fail(im.line, `"${im.path}" imported and not used`);
  }
  // a local variable declared (:= or var) and never read is an error in Go
  for (const d of decls) {
    if (d.k !== 'func') continue;
    const scopeCheck = body => {
      const declared = [];
      walk(body, n => {
        if (n.k === 'define') n.names.forEach(nm => nm !== '_' && declared.push({ name: nm, line: n.line, node: n }));
        if (n.k === 'var') n.specs.forEach(sp => sp.names.forEach(nm => nm !== '_' && declared.push({ name: nm, line: sp.line })));
        if (n.k === 'range' && n.define) n.lhs.forEach(x => x.k === 'name' && x.name !== '_' && declared.push({ name: x.name, line: n.line }));
        if (n.k === 'switch' && n.typeSw && n.typeSw.bind) declared.push({ name: n.typeSw.bind, line: n.line, typeSw: n });
      });
      const reads = new Set();
      walk(body, n => {
        if (n.k === 'name') reads.add(n.name);
        if (n.k === 'assign') { /* the left side of = is not a use, but x.f = and x[i] = are */ }
      });
      // names only ever assigned to (x = …) do not count as used
      const onlyAssigned = new Map();
      walk(body, n => {
        if (n.k === 'assign' && n.op === '=') n.lhs.forEach(x => { if (x.k === 'name') onlyAssigned.set(x.name, (onlyAssigned.get(x.name) || 0) + 1); });
      });
      const readCount = new Map();
      walk(body, n => { if (n.k === 'name') readCount.set(n.name, (readCount.get(n.name) || 0) + 1); });
      for (const v of declared) {
        if (v.typeSw) continue;
        const rc = (readCount.get(v.name) || 0) - (onlyAssigned.get(v.name) || 0);
        if (rc <= 0) fail(v.line, `declared and not used: ${v.name}`);
      }
      void reads;
    };
    scopeCheck(d.body);
  }
}
