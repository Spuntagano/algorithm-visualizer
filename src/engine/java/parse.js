/**
 * The Java front end: a lexer and recursive-descent parser for the Java that algorithms use (Java 21 syntax, most of it):
 * classes, interfaces, enums, records, nested and anonymous classes, generics (parsed, then erased), lambdas, method
 * references, switch (with case … ->), enhanced for, labels, try / catch / finally, var, text blocks, instanceof
 * patterns. A file may also be "compact" (Java 21+): methods and fields outside any class, with a void main().
 * parseJava(source) returns { types: [class decl] } or throws an Error "line N: …".
 */
export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const KEYWORDS = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default',
  'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super',
  'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null']);
export const PRIMS = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'native', 'synchronized', 'transient', 'volatile',
  'strictfp', 'default', 'sealed', 'non-sealed']);
const PUNCT = ['>>>=', '<<=', '>>=', '>>>', '...', '->', '::', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>'];

/* ---- lexer ---- */
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', s: ' ', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
function unescape(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const e = body[++i];
    if (e === 'u') { let j = i; while (body[j] === 'u') j++; out += String.fromCharCode(parseInt(body.slice(j, j + 4), 16)); i = j + 3; }
    else if (/[0-7]/.test(e)) { let j = i; while (j < i + 3 && /[0-7]/.test(body[j])) j++; out += String.fromCharCode(parseInt(body.slice(i, j), 8)); i = j - 1; }
    else if (e in ESC) out += ESC[e];
    else if (e === '\n') { /* a line break escaped in a text block */ }
    else fail(line, 'unknown escape \\' + e);
  }
  return out;
}
/** Text block """…""": the lines, with their common indentation taken off */
function textBlock(raw) {
  const lines = raw.replace(/^[ \t]*\n/, '').split('\n');
  const ind = Math.min(...lines.filter((l, k) => l.trim() || k === lines.length - 1).map(l => l.match(/^[ \t]*/)[0].length));
  return lines.map(l => l.slice(ind).replace(/[ \t]+$/, '')).join('\n');
}

export function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) fail(line, 'the comment /* is never closed with */');
      for (let j = i; j < e; j++) if (src[j] === '\n') line++;
      i = e + 2; continue;
    }
    const start = i, l0 = line, tok = t => toks.push({ ...t, line: l0, pos: start, end: i });
    if (/[A-Za-z_$]/.test(c)) { while (/[A-Za-z0-9_$]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      if (c === '0' && /[xXbB]/.test(src[i + 1] || '')) { i += 2; while (/[0-9a-fA-F_]/.test(src[i] || '')) i++; }
      else {
        while (/[0-9_]/.test(src[i] || '')) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) { i++; while (/[0-9_]/.test(src[i] || '')) i++; }
        else if (src[i] === '.' && !/[A-Za-z_.]/.test(src[i + 1] || '')) i++;
        if (/[eE]/.test(src[i] || '')) { i++; if (/[+-]/.test(src[i])) i++; while (/[0-9]/.test(src[i] || '')) i++; }
      }
      if (/[lLfFdD]/.test(src[i] || '')) i++;
      tok({ t: 'num', v: src.slice(start, i) }); continue;
    }
    if (c === '"' && src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      if (e < 0) fail(line, 'the text block """ is never closed');
      const raw = src.slice(i + 3, e);
      line += (raw.match(/\n/g) || []).length;
      i = e + 3;
      tok({ t: 'str', v: unescape(textBlock(raw), l0) }); continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== c) fail(line, (c === '"' ? 'the string' : 'the character') + ' is never closed with ' + c);
      const body = unescape(src.slice(i + 1, j), line);
      i = j + 1;
      if (c === "'") { if ([...body].length !== 1) fail(line, "a char holds one character: '" + src.slice(start + 1, j) + "' (use \"…\" for a String)"); tok({ t: 'chr', v: body }); }
      else tok({ t: 'str', v: body });
      continue;
    }
    if (c === '@' && /[A-Za-z]/.test(src[i + 1] || '')) {     // an annotation: @Override, @SuppressWarnings("…")
      i++; while (/[A-Za-z0-9_.]/.test(src[i] || '')) i++;
      if (src[i] === '(') { let depth = 0; do { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; else if (src[i] === '\n') line++; i++; } while (depth && i < src.length); }
      continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~?:=@'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'unexpected character ' + JSON.stringify(c));
  }
  return toks;
}

/* ---- parser ---- */
export function parseJava(src) {
  const toks = lex(src);
  let i = 0;
  const lastLine = toks.length ? toks.at(-1).line : 1;
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || t.t === 'id') && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(lastLine, 'the program ends too early (a missing } or ;?)'); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  const show = t => (!t ? 'the end of the program' : t.t === 'str' ? 'a string' : t.t === 'chr' ? 'a char' : "'" + t.v + "'");
  const expect = (v, what) => {
    if (eat(v)) return;
    const t = peek(), prev = toks[i - 1];
    if (v === ';' && prev && (!t || t.line > prev.line)) fail(prev.line, "';' expected at the end of the line");
    fail(t ? t.line : lastLine, `'${v}' expected${what ? ' ' + what : ''} before ${show(t)}`);
  };
  const isIdent = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && !KEYWORDS.has(t.v); };
  const ident = what => { const t = peek(); if (!t || t.t !== 'id' || KEYWORDS.has(t.v)) fail(t ? t.line : lastLine, '<' + (what || 'identifier') + '> expected before ' + show(t)); i++; return t.v; };
  const textOf = (a, b) => src.slice(a.pos, b.end);
  /** The closing > of type arguments, also out of >> and >>> */
  const closeAngle = () => {
    if (eat('>')) return;
    const t = peek();
    if (t && t.t === 'p' && /^>(>|>>|=|>=|>>=)$/.test(t.v)) { toks.splice(i, 1, { ...t, v: '>' }, { ...t, v: t.v.slice(1), pos: t.pos + 1 }); i++; return; }
    fail(t ? t.line : lastLine, "'>' expected to close the type arguments before " + show(t));
  };
  /** Runs fn; if it fails, puts the position back and returns null (for the places where Java looks ahead) */
  const attempt = fn => {
    const save = i, saved = toks.slice();             // a > > split while trying is put back too
    try { const r = fn(); if (r == null) { i = save; toks.splice(0, toks.length, ...saved); } return r; }
    catch (err) { if (!/^line \d+:/.test(err.message)) throw err; i = save; toks.splice(0, toks.length, ...saved); return null; }
  };

  /* types: int, String, List<Integer>, Map.Entry<K, V>, int[][], ? extends T */
  function typeArgs() {
    expect('<');
    const out = [];
    if (is('>')) { i++; return out; }                // the diamond <>
    do {
      if (eat('?')) { if (eat('extends') || eat('super')) out.push(type()); else out.push({ name: 'Object', args: null, dims: 0 }); }
      else out.push(type());
    } while (eat(','));
    closeAngle();
    return out;
  }
  function type() {
    const l = line();
    let name;
    if (peek() && peek().t === 'id' && (PRIMS.has(peek().v) || peek().v === 'void' || peek().v === 'var')) name = next().v;
    else {
      name = ident('type');
      let args = is('<') ? typeArgs() : null;
      while (is('.') && isIdent(1)) { i++; name += '.' + ident(); if (is('<')) args = typeArgs(); }
      let dims = 0;
      while (is('[') && is(']', 1)) { i += 2; dims++; }
      return { name: shortName(name), args, dims, line: l };
    }
    let dims = 0;
    while (is('[') && is(']', 1)) { i += 2; dims++; }
    return { name, args: null, dims, line: l };
  }
  /** java.util.List → List (the packages are all imported) */
  const shortName = n => (/^java\.|^javax\./.test(n) ? n.split('.').pop() : n);
  /** At a type? (for a local variable declaration: a type, then a name) */
  const declStart = () => {
    const save = i, saved = toks.slice();
    try {
      if (!peek() || peek().t !== 'id' || (KEYWORDS.has(peek().v) && !PRIMS.has(peek().v))) return false;
      type();
      return isIdent() && (is('=', 1) || is(';', 1) || is(',', 1) || is(':', 1) || is('[', 1) || is(')', 1));
    } catch (err) { if (!/^line \d+:/.test(err.message)) throw err; return false; } finally { i = save; toks.splice(0, toks.length, ...saved); }
  };
  function modifiers() {
    const mods = new Set();
    for (;;) {
      const t = peek();
      if (t && t.t === 'id' && MODIFIERS.has(t.v) && !(t.v === 'default' && (is(':', 1) || is('->', 1)))) { mods.add(next().v); continue; }
      if (t && t.t === 'id' && t.v === 'non' && is('-', 1)) { i += 3; continue; }
      return mods;
    }
  }
  const typeParams = () => { if (!is('<')) return []; i++; const ps = []; do { ps.push(ident('type parameter')); if (eat('extends')) { type(); while (eat('&')) type(); } } while (eat(',')); closeAngle(); return ps; };

  /* ---- declarations ---- */
  function classDecl(mods, kind) {
    const l = line();
    const name = ident('class name');
    const decl = { k: 'class', kind, name, line: l, tparams: typeParams(), ext: null, impls: [], members: [], isStatic: mods.has('static'),
      isAbstract: mods.has('abstract') || kind === 'interface', enumConsts: [], comps: null };
    if (kind === 'record') { expect('('); decl.comps = []; if (!eat(')')) { do { modifiers(); const t = type(); decl.comps.push({ type: t, name: ident() }); } while (eat(',')); expect(')'); } }
    if (eat('extends')) { if (kind === 'interface') { do decl.impls.push(type()); while (eat(',')); } else decl.ext = type(); }
    if (eat('implements')) do decl.impls.push(type()); while (eat(','));
    if (eat('permits')) do type(); while (eat(','));
    decl.members = classBody(decl);
    return decl;
  }
  function classBody(decl) {
    expect('{', 'to start the body of ' + (decl ? decl.name : 'the class'));
    const members = [];
    if (decl && decl.kind === 'enum') {
      while (!is(';') && !is('}')) {
        const cl = line(), cname = ident('enum constant');
        let args = [];
        if (eat('(')) args = argList();
        const body = is('{') ? classBody(null) : null;
        decl.enumConsts.push({ name: cname, args, body, line: cl });
        if (!eat(',')) break;
      }
      eat(';');
    }
    while (!eat('}')) {
      if (eat(';')) continue;
      members.push(member(decl));
    }
    return members;
  }
  function member(decl) {
    const l = line();
    if (is('{')) return { k: 'init', isStatic: false, body: block(), line: l };
    if (is('static') && is('{', 1)) { i++; return { k: 'init', isStatic: true, body: block(), line: l }; }
    const mods = modifiers();
    const kind = ['class', 'interface', 'enum', 'record'].find(k => is(k) && isIdent(1));
    if (kind) { i++; return classDecl(mods, kind); }
    const tps = typeParams();
    if (decl && is(decl.name) && is('(', 1)) {          // a constructor
      i++;
      return { k: 'ctor', params: params(), throws: throwsClause(), body: block(), line: l, mods, tparams: tps };
    }
    if (decl && decl.kind === 'record' && is(decl.name) && is('{', 1)) { i++; return { k: 'ctor', compact: true, params: null, body: block(), line: l, mods }; }
    const t = type();
    const nl = line(), name = ident('name');
    if (is('(')) {                                     // a method
      const ps = params();
      let dims = 0;
      while (is('[') && is(']', 1)) { i += 2; dims++; }
      throwsClause();
      const isAbstract = mods.has('abstract') || (decl && decl.kind === 'interface' && !mods.has('default') && !mods.has('static') && !is('{'));
      const body = is('{') ? block() : (expect(';', 'after the method'), null);
      if (!body && !isAbstract && !mods.has('native')) fail(nl, `the method ${name}() needs a body { … }`);
      return { k: 'method', name, params: ps, ret: dims ? { ...t, dims: t.dims + dims } : t, body, isStatic: mods.has('static'), isAbstract: !body, line: nl, mods, tparams: tps };
    }
    const fields = [];                               // fields: int a = 1, b;
    let fname = name, fl = nl;
    for (;;) {
      let dims = 0;
      while (is('[') && is(']', 1)) { i += 2; dims++; }
      const init = eat('=') ? varInit() : null;
      fields.push({ k: 'field', name: fname, type: dims ? { ...t, dims: t.dims + dims } : t, init, isStatic: mods.has('static') || (decl && decl.kind === 'interface'), line: fl, mods });
      if (!eat(',')) break;
      fl = line(); fname = ident('field name');
    }
    expect(';', 'after the field');
    return fields.length === 1 ? fields[0] : { k: 'fields', list: fields, line: l };
  }
  const throwsClause = () => { if (eat('throws')) do type(); while (eat(',')); };
  function params() {
    expect('(');
    const ps = [];
    if (eat(')')) return ps;
    do {
      modifiers();
      const t = type(), varargs = eat('...');
      const pl = line(), name = ident('parameter name');
      let dims = 0;
      while (is('[') && is(']', 1)) { i += 2; dims++; }
      ps.push({ name, type: varargs ? { ...t, dims: t.dims + 1 + dims } : dims ? { ...t, dims: t.dims + dims } : t, varargs, line: pl });
    } while (eat(','));
    expect(')', 'after the parameters');
    return ps;
  }
  const varInit = () => (is('{') ? arrayInit() : expression());
  function arrayInit() {
    const l = line(); expect('{');
    const items = [];
    while (!eat('}')) { items.push(varInit()); if (!eat(',')) { expect('}', 'to close the array initializer'); break; } }
    return { k: 'arrayInit', items, line: l };
  }

  /* ---- statements ---- */
  function block() {
    const l = line(); expect('{');
    const items = [];
    while (!eat('}')) items.push(statement());
    return { k: 'block', items, line: l };
  }
  function localVar(t, l) {
    const decls = [];
    do {
      const dl = line(), name = ident('variable name');
      let dims = 0;
      while (is('[') && is(']', 1)) { i += 2; dims++; }
      decls.push({ name, dims, init: eat('=') ? varInit() : null, line: dl });
    } while (eat(','));
    return { k: 'var', type: t, decls, line: l };
  }
  function statement() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, "'}' expected at the end of the program");
    if (t.t === 'p' && t.v === '{') return block();
    if (t.t === 'p' && t.v === ';') { i++; return { k: 'empty', line: l }; }
    if (t.t === 'id') {
      if (isIdent() && is(':', 1) && !is('::', 1)) { i += 2; return { k: 'label', label: t.v, body: statement(), line: l }; }
      switch (t.v) {
        case 'if': { i++; expect('('); const c = expression(); expect(')'); const a = statement(); return { k: 'if', c, a, b: eat('else') ? statement() : null, line: l }; }
        case 'while': { i++; expect('('); const c = expression(); expect(')'); return { k: 'while', c, body: statement(), line: l }; }
        case 'do': { i++; const body = statement(); const wl = line(); expect('while', 'after the body of do'); expect('('); const c = expression(); expect(')'); expect(';'); return { k: 'do', body, c, line: l, cline: wl }; }
        case 'for': {
          i++; expect('(');
          const save = i; modifiers();
          if (declStart() || (is('var') && isIdent(1))) {
            const vt = type();
            if (isIdent() && is(':', 1)) { const name = ident(); i++; const iter = expression(); expect(')'); return { k: 'foreach', type: vt, name, iter, body: statement(), line: l }; }
            const init = localVar(vt, l); expect(';');
            return forRest(l, init);
          }
          i = save;
          let init = null;
          if (!eat(';')) { const es = [expression()]; while (eat(',')) es.push(expression()); init = { k: 'exprs', es, line: l }; expect(';'); }
          return forRest(l, init);
        }
        case 'return': { i++; const e = is(';') ? null : expression(); expect(';', 'after return'); return { k: 'return', e, line: l }; }
        case 'break': { i++; const label = isIdent() ? ident() : null; expect(';'); return { k: 'break', label, line: l }; }
        case 'continue': { i++; const label = isIdent() ? ident() : null; expect(';'); return { k: 'continue', label, line: l }; }
        case 'throw': { i++; const e = expression(); expect(';'); return { k: 'throw', e, line: l }; }
        case 'yield': if (!is('=', 1) && !is('(', 1) && !is('.', 1)) { i++; const e = expression(); expect(';'); return { k: 'yield', e, line: l }; } break;
        case 'switch': { const s = switchNode(); return { ...s, k: 'switch', line: l }; }
        case 'try': return tryStmt(l);
        case 'assert': { i++; const c = expression(); const m = eat(':') ? expression() : null; expect(';'); return { k: 'assert', c, m, line: l }; }
        case 'class': case 'interface': case 'enum': case 'record':
          if (isIdent(1)) { i++; return { k: 'localClass', decl: classDecl(new Set(), t.v), line: l }; }
          break;
        case 'final': i++; return statement();
        case 'else': fail(l, "'else' without 'if' (is a ; or } too many before it?)");
        // falls through
        case 'case': case 'default': fail(l, `'${t.v}' outside a switch`);
      }
      if (is('var') && isIdent(1)) { i++; const d = localVar({ name: 'var', args: null, dims: 0 }, l); expect(';'); return d; }
      if (declStart()) { const d = localVar(type(), l); expect(';', 'after the declaration'); return d; }
    }
    const start = peek(), e = expression();
    if (!['assign', 'pre', 'post', 'call', 'new', 'switch', 'ctorCall'].includes(e.k)) fail(l, 'not a statement: ' + textOf(start, toks[i - 1]) + ' (a statement does something: x = …, f(…), i++)');
    expect(';', 'after the statement');
    return { k: 'expr', e, line: l };
  }
  function forRest(l, init) {
    const c = is(';') ? null : expression(); expect(';');
    const step = [];
    if (!is(')')) { do step.push(expression()); while (eat(',')); }
    expect(')');
    return { k: 'for', init, c, step, body: statement(), line: l };
  }
  function tryStmt(l) {
    i++;
    const res = [];
    if (eat('(')) { while (!eat(')')) { modifiers(); const t = type(); const n = ident(); expect('='); res.push({ type: t, name: n, init: expression() }); eat(';'); } }
    const body = block(), catches = [];
    while (is('catch')) {
      const cl = line(); i++; expect('('); modifiers();
      const types = [type()];
      while (eat('|')) types.push(type());
      const name = ident('exception name'); expect(')');
      catches.push({ types, name, body: block(), line: cl });
    }
    const fin = eat('finally') ? block() : null;
    if (!catches.length && !fin && !res.length) fail(l, "'try' needs a catch or a finally");
    return { k: 'try', res, body, catches, fin, line: l };
  }
  /** switch (e) { case 1, 2: … case X -> …; default -> { … } } as a statement or an expression */
  function switchNode() {
    const l = line(); i++; expect('('); const e = expression(); expect(')'); expect('{');
    const cases = [];
    let arrow = null;
    while (!eat('}')) {
      const cl = line();
      let labels;
      if (eat('default')) labels = null;
      else { expect('case', 'in the switch'); labels = []; do { labels.push(is('null') ? (i++, { k: 'lit', v: null, line: cl }) : caseLabel()); } while (eat(',')); if (eat('default')) labels.push(null); }
      if (is('->')) {
        i++; if (arrow === false) fail(cl, 'a switch cannot mix case …: and case … ->');
        arrow = true;
        let body;
        if (is('{')) body = block();
        else if (is('throw')) { const tl = line(); i++; body = { k: 'throw', e: expression(), line: tl }; expect(';'); }
        else { const xl = line(); body = { k: 'arrowExpr', e: expression(), line: xl }; expect(';'); }
        cases.push({ labels, body: [body], line: cl });
      } else {
        expect(':', 'after the case label');
        if (arrow === true) fail(cl, 'a switch cannot mix case …: and case … ->');
        arrow = false;
        const body = [];
        while (!is('case') && !is('default') && !is('}')) body.push(statement());
        cases.push({ labels, body, line: cl });
      }
    }
    return { k: 'switch', e, cases, arrow: !!arrow, line: l };
  }
  const caseLabel = () => {                            // an enum constant's bare name, a constant, or a type pattern
    if (isIdent() && (is(',', 1) || is(':', 1) || is('->', 1))) { const l = line(); return { k: 'name', name: ident(), line: l, label: true }; }
    return conditional();
  };

  /* ---- expressions ---- */
  const node = (k, l, o) => ({ k, line: l, ...o });
  function expression() { return assignment(); }
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '^=', '|=']);
  function assignment() {
    const lam = lambda();
    if (lam) return lam;
    const l = line(), lhs = conditional(), t = peek();
    if (t && t.t === 'p' && ASSIGN.has(t.v)) {
      if (!['name', 'field', 'index'].includes(lhs.k)) fail(l, 'only a variable, a field or an array element can be assigned to');
      i++;
      return node('assign', l, { op: t.v, l: lhs, r: assignment() });
    }
    return lhs;
  }
  /** x -> …, (a, b) -> …, (int a, int b) -> …, () -> … */
  function lambda() {
    const l = line();
    if (isIdent() && is('->', 1)) { const p = ident(); i++; return node('lambda', l, { params: [p], body: lambdaBody() }); }
    if (!is('(')) return null;
    let depth = 0, k = i;                              // find the matching ) and see whether -> follows it
    for (; k < toks.length; k++) { if (toks[k].v === '(' && toks[k].t === 'p') depth++; else if (toks[k].v === ')' && toks[k].t === 'p' && --depth === 0) break; }
    if (!toks[k + 1] || toks[k + 1].v !== '->') return null;
    i++;
    const ps = [];
    if (!eat(')')) { do { modifiers(); if (!(isIdent() && (is(',', 1) || is(')', 1)))) type(); ps.push(ident('parameter name')); } while (eat(',')); expect(')'); }
    i++;                                                // ->
    return node('lambda', l, { params: ps, body: lambdaBody() });
  }
  const lambdaBody = () => (is('{') ? block() : expression());
  function conditional() {
    const c = binary(0);
    if (!is('?')) return c;
    const l = line(); i++;
    const a = lambda() || conditional(); expect(':', 'in the ?: expression');
    return node('cond', l, { c, a, b: lambda() || conditional() });
  }
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>=', 'instanceof'], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%']];
  function binary(level) {
    if (level === LEVELS.length) return unary();
    let e = binary(level + 1);
    for (;;) {
      const t = peek();
      if (!t || !LEVELS[level].includes(t.v) || (t.t !== 'p' && t.v !== 'instanceof')) return e;
      i++;
      if (t.v === 'instanceof') {
        const final = eat('final'); void final;
        const ty = type();
        const bind = isIdent() ? ident() : null;
        e = node('instanceof', t.line, { e, type: ty, bind });
        continue;
      }
      const r = binary(level + 1);
      e = node(t.v === '&&' ? 'and' : t.v === '||' ? 'or' : 'bin', t.line, { op: t.v, l: e, r });
    }
  }
  function unary() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, 'an expression is expected at the end of the program');
    if (t.t === 'p') {
      if (t.v === '++' || t.v === '--') { i++; return node('pre', l, { op: t.v, e: unary() }); }
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
        i++;
        if (t.v === '-' && peek() && peek().t === 'num' && /^(2147483648|9223372036854775808)[lL]?$/.test(peek().v.replace(/_/g, ''))) return postfix(number(next(), true));
        return node('un', l, { op: t.v, e: unary() });
      }
      if (t.v === '(') {                                // a cast? (int) x always; (Name) x when x cannot be the rest of an expression
        const c = attempt(() => {
          i++;
          const ty = type();
          while (eat('&')) type();
          expect(')');
          const n = peek();
          if (!n) return null;
          if (PRIMS.has(ty.name) && !ty.dims) return ty;
          if (n.t === 'num' || n.t === 'str' || n.t === 'chr') return ty;
          if (n.t === 'id') return n.v === 'instanceof' ? null : ty;
          return n.v === '(' || n.v === '!' || n.v === '~' ? ty : null;
        });
        if (c) return node('cast', l, { type: c, e: lambda() || unary() });
      }
    }
    return postfix(primary());
  }
  function postfix(e) {
    for (;;) {
      const l = line();
      if (is('[')) { i++; const ix = expression(); expect(']'); e = node('index', l, { a: e, i: ix }); continue; }
      if (is('.')) {
        i++;
        if (is('<')) typeArgs();                         // Collections.<Integer>emptyList()
        if (eat('new')) { const n = newExpr(l, null); n.outer = e; e = n; continue; }
        if (is('this')) { i++; e = node('this', l, { qual: e }); continue; }
        if (is('class')) { i++; e = node('classLit', l, { e }); continue; }
        const name = ident('a field or method name');
        if (is('(')) { i++; e = node('call', l, { target: e, name, args: argList() }); continue; }
        e = node('field', l, { e, name });
        continue;
      }
      if (is('::')) { i++; const name = eat('new') ? 'new' : ident('method name'); e = node('methodRef', l, { target: e, name }); continue; }
      if (is('++') || is('--')) { e = node('post', l, { op: next().v, e }); continue; }
      return e;
    }
  }
  function argList() {
    const out = [];
    if (eat(')')) return out;
    do out.push(expression()); while (eat(','));
    expect(')', 'after the arguments');
    return out;
  }
  function newExpr(l, outer) {
    const t = peek();
    const name = PRIMS.has(t.v) ? next().v : shortName((() => { let n = ident('class name'); while (is('.') && isIdent(1)) { i++; n += '.' + ident(); } return n; })());
    const args0 = is('<') ? typeArgs() : null;
    if (is('[')) {                                     // new int[n][m], new int[]{1, 2}
      const dims = [];
      let extra = 0;
      while (is('[')) {
        i++;
        if (eat(']')) { extra++; continue; }
        if (extra) fail(line(), 'array dimensions: the sizes come first, then the empty []');
        dims.push(expression()); expect(']');
      }
      const init = is('{') ? arrayInit() : null;
      if (!dims.length && !init) fail(l, 'an array needs a size: new ' + name + '[n]');
      return node('newArray', l, { type: { name, args: args0, dims: 0 }, dims, extra, init });
    }
    expect('(', 'after new ' + name);
    const args = argList();
    const body = is('{') ? classBody({ name: '', kind: 'class', enumConsts: [] }) : null;
    return node('new', l, { type: { name, args: args0, dims: 0 }, args, body, outer });
  }
  function primary() {
    const t = next(), l = t.line;
    if (t.t === 'num') return number(t, false);
    if (t.t === 'chr') return node('lit', l, { v: { c: t.v } });
    if (t.t === 'str') return node('lit', l, { v: { s: t.v } });
    if (t.t === 'p' && t.v === '(') { const e = expression(); expect(')'); return node('paren', l, { e }); }
    if (t.t === 'id') {
      switch (t.v) {
        case 'true': case 'false': return node('lit', l, { v: t.v === 'true' });
        case 'null': return node('lit', l, { v: null });
        case 'this': if (is('(')) { i++; return node('ctorCall', l, { sup: false, args: argList() }); } return node('this', l, {});
        case 'super':
          if (is('(')) { i++; return node('ctorCall', l, { sup: true, args: argList() }); }
          if (eat('.')) { const name = ident(); if (is('(')) { i++; return node('call', l, { target: node('super', l, {}), name, args: argList() }); } return node('field', l, { e: node('this', l, {}), name }); }
          if (is('::')) return node('super', l, {});
          fail(l, "'.' expected after super");
          // falls through
        case 'new': return newExpr(l, null);
        case 'switch': i--; return switchNode();
      }
      if (PRIMS.has(t.v) || t.v === 'void') {         // int.class, int[]::new
        i--;
        const ty = type();
        if (is('::')) return node('typeRef', l, { type: ty });
        if (eat('.') && eat('class')) return node('classLit', l, { e: node('typeRef', l, { type: ty }) });
        fail(l, 'an expression is expected before ' + show(t));
      }
      if (!KEYWORDS.has(t.v)) {
        if (is('(')) { i++; return node('call', l, { target: null, name: t.v, args: argList() }); }
        // a generic type or an array type before :: (ArrayList<Integer>::new, String[]::new)
        if ((is('<') || (is('[') && is(']', 1)))) {
          i--;
          const ref = attempt(() => { const ty = type(); return is('::') ? node('typeRef', l, { type: ty }) : null; });
          if (!ref) i++;
          if (ref) return ref;
        }
        return node('name', l, { name: t.v });
      }
    }
    i--;
    fail(l, 'an expression is expected before ' + show(t));
  }
  function number(t, neg) {
    const raw = t.v.replace(/_/g, ''), l = t.line;
    const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([lL]?)$/.exec(raw);
    if (m) {
      let v = /^0[xX]/.test(m[1]) ? BigInt(m[1]) : /^0[bB]/.test(m[1]) ? BigInt(m[1]) : /^0[0-7]+$/.test(m[1]) ? BigInt('0o' + m[1].slice(1)) : BigInt(m[1]);
      if (neg) v = -v;
      const long = !!m[2], dec = /^[1-9]|^0$/.test(m[1]);
      if (long) {
        if (dec && (v > 9223372036854775807n || v < -9223372036854775808n)) fail(l, 'the long number ' + raw + ' is too big');
        return node('lit', l, { v: BigInt.asIntN(64, v) });
      }
      if (dec ? v > 2147483647n || v < -2147483648n : v > 0xffffffffn) fail(l, 'integer number too large: ' + raw + (dec ? ' (an int holds up to 2147483647: write ' + raw + 'L for a long)' : ''));
      return node('lit', l, { v: Number(BigInt.asIntN(32, v)) });
    }
    const f = /^([0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]+)?)([fFdD]?)$/.exec(raw);
    if (f && /[0-9]/.test(f[1])) {
      const v = (neg ? -1 : 1) * parseFloat(f[1]);
      return node('lit', l, { v: { d: /[fF]/.test(f[2]) ? Math.fround(v) : v, f: /[fF]/.test(f[2]) } });
    }
    if (/^0[0-9]+/.test(raw)) fail(l, raw + ' starts with 0, so it is octal, and has an 8 or 9');
    fail(l, 'bad number: ' + t.v);
  }

  /* ---- the file ---- */
  const types = [], loose = [];
  while (i < toks.length) {
    if (eat(';')) continue;
    if (is('package')) { while (!eat(';')) next(); continue; }
    if (is('import')) {
      const l = line(); i++; eat('static');
      let path = ident();
      while (eat('.')) path += '.' + (eat('*') ? '*' : ident());
      expect(';');
      if (!/^java\.(util|lang|io|math|text|util\.function|util\.stream)(\.|$)/.test(path)) fail(l, 'import ' + path + ': only java.util, java.lang, java.io and java.math are here');
      continue;
    }
    const save = i, mods = modifiers();
    const kind = ['class', 'interface', 'enum', 'record'].find(k => is(k) && isIdent(1));
    if (kind) { i++; types.push(classDecl(mods, kind)); continue; }
    i = save;                                          // a compact source file: methods and fields with no class around them
    loose.push(member({ name: '\0', kind: 'class', enumConsts: [] }));
  }
  if (loose.length) {
    const members = loose.flatMap(m => (m.k === 'fields' ? m.list : [m]));
    types.unshift({ k: 'class', kind: 'class', name: 'Main', line: 1, tparams: [], ext: null, impls: [], members, implicit: true, isStatic: false, isAbstract: false, enumConsts: [] });
  }
  return { types };
}
