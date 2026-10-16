/**
 * The C# front end: a lexer and recursive-descent parser for the C# that algorithms use (C# 12, most of it): top-level
 * statements or a class with Main, classes, structs, records, interfaces, enums, generics (parsed, then erased),
 * properties, constructors (and primary ones), operators, lambdas, local functions, tuples and deconstruction,
 * switch statements and expressions with patterns, is / as, string interpolation, collection expressions, ranges.
 * parseCs(source) returns { types, top } or throws an Error "line N: …".
 */
export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue',
  'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object',
  'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof',
  'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe',
  'ushort', 'using', 'virtual', 'void', 'volatile', 'while']);
export const PREDEF = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
  'object', 'string', 'void', 'nint', 'nuint', 'dynamic']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'abstract', 'virtual', 'override',
  'sealed', 'new', 'extern', 'unsafe', 'volatile', 'partial', 'async', 'required', 'file']);
const PUNCT = ['>>>=', '<<=', '??=', '>>>', '=>', '?.', '??', '::', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '..'];

/* ---- lexer ---- */
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', e: '\x1b', 0: '\0', '\\': '\\', "'": "'", '"': '"' };
function unescape(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const e = body[++i];
    if (e === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
    else if (e === 'U') { out += String.fromCodePoint(parseInt(body.slice(i + 1, i + 9), 16)); i += 8; }
    else if (e === 'x') { let j = i + 1; while (j < i + 5 && /[0-9a-fA-F]/.test(body[j] || '')) j++; out += String.fromCharCode(parseInt(body.slice(i + 1, j), 16)); i = j - 1; }
    else if (e in ESC) out += ESC[e];
    else fail(line, 'CS1009: Unrecognized escape sequence \\' + e);
  }
  return out;
}

export function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  /** a string literal starting at i ("…", @"…", $"…", $@"…", """…"""): its text, or for $ its parts */
  function stringLit(l0) {
    let interp = false, verb = false;
    while (src[i] === '$' || src[i] === '@') { if (src[i] === '$') interp = true; else verb = true; i++; }
    if (src.startsWith('"""', i)) {                    // a raw string: """…""", its indentation taken off
      let q = 0; while (src[i + q] === '"') q++;
      const close = '"'.repeat(q), e = src.indexOf(close, i + q);
      if (e < 0) fail(line, 'CS8997: Unterminated raw string literal');
      let raw = src.slice(i + q, e);
      line += (raw.match(/\n/g) || []).length;
      i = e + q;
      if (raw.includes('\n')) {
        const lines = raw.split('\n'), ind = lines.at(-1).match(/^[ \t]*/)[0].length;
        raw = lines.slice(1, -1).map(s => s.slice(ind)).join('\n');
      }
      return interp ? { parts: [raw] } : { s: raw };
    }
    i++;                                                // the opening "
    const parts = [];
    let cur = '';
    for (;;) {
      if (i >= src.length) fail(l0, 'CS1010: Newline in constant (the string is never closed with ")');
      const c = src[i];
      if (c === '\n' && !verb) fail(l0, 'CS1010: Newline in constant (the string is never closed with ")');
      if (c === '"') { if (verb && src[i + 1] === '"') { cur += '"'; i += 2; continue; } i++; break; }
      if (c === '\\' && !verb) { const e = src[i + 1]; const n = e === 'u' ? 6 : e === 'U' ? 10 : e === 'x' ? (() => { let j = i + 2; while (j < i + 6 && /[0-9a-fA-F]/.test(src[j] || '')) j++; return j - i; })() : 2; cur += unescape(src.slice(i, i + n), line); i += n; continue; }
      if (interp && c === '{') {
        if (src[i + 1] === '{') { cur += '{'; i += 2; continue; }
        parts.push(cur); cur = '';
        let j = i + 1, depth = 0, inStr = null;
        const startLine = line;
        for (; j < src.length; j++) {                   // the hole: up to its } (strings and nested braces skipped)
          const d = src[j];
          if (d === '\n') line++;
          if (inStr) { if (d === '\\' && inStr === '"') j++; else if (d === inStr) inStr = null; continue; }
          if (d === '"' || d === "'") { inStr = d; continue; }
          if (d === '(' || d === '[' || d === '{') depth++;
          else if (d === ')' || d === ']') depth--;
          else if (d === '}') { if (depth === 0) break; depth--; }
        }
        if (j >= src.length) fail(startLine, 'CS8076: Missing close delimiter } for an interpolated expression');
        let hole = src.slice(i + 1, j), fmt = null, align = null;
        // {x,5:F2}: the alignment and the format, outside any brackets or ?: (a : at depth 0 after the expression)
        let dd = 0, cut = -1, q = null;
        for (let k = 0; k < hole.length; k++) {
          const d = hole[k];
          if (q) { if (d === '\\') k++; else if (d === q) q = null; continue; }
          if (d === '"' || d === "'") q = d;
          else if ('([{'.includes(d)) dd++;
          else if (')]}'.includes(d)) dd--;
          else if (d === '?' && dd === 0) dd += 100;      // a ?: inside: its : is not a format
          else if (d === ':' && dd >= 100) dd -= 100;
          else if (d === ':' && dd === 0) { cut = k; break; }
        }
        if (cut >= 0) { fmt = hole.slice(cut + 1); hole = hole.slice(0, cut); }
        const comma = topComma(hole);
        if (comma >= 0) { align = hole.slice(comma + 1).trim(); hole = hole.slice(0, comma); }
        parts.push({ src: hole, line: startLine, fmt, align });
        i = j + 1;
        continue;
      }
      if (interp && c === '}') { if (src[i + 1] === '}') { cur += '}'; i += 2; continue; } fail(line, 'CS8086: A } character must be escaped (by doubling) in an interpolated string'); }
      if (c === '\n') line++;
      cur += c; i++;
    }
    parts.push(cur);
    return interp ? { parts } : { s: parts.join('') };
  }
  const topComma = s => { let d = 0, q = null; for (let k = 0; k < s.length; k++) { const c = s[k]; if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; } if (c === '"' || c === "'") q = c; else if ('([{<'.includes(c)) d++; else if (')]}>'.includes(c)) d--; else if (c === ',' && d === 0) return k; } return -1; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) fail(line, 'CS1035: End-of-file found, \'*/\' expected');
      for (let j = i; j < e; j++) if (src[j] === '\n') line++;
      i = e + 2; continue;
    }
    if (c === '#' && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i))) { while (i < src.length && src[i] !== '\n') i++; continue; }   // #region, #nullable…
    const start = i, l0 = line, tok = t => toks.push({ ...t, line: l0, pos: start, end: i });
    if (c === '"' || ((c === '$' || c === '@') && /^[$@]{1,2}"/.test(src.slice(i, i + 3)))) { const r = stringLit(l0); tok(r.parts ? { t: 'interp', v: r.parts } : { t: 'str', v: r.s }); continue; }
    if (/[A-Za-z_]/.test(c) || (c === '@' && /[A-Za-z_]/.test(src[i + 1] || ''))) {
      const at = c === '@';
      if (at) i++;
      const s0 = i;
      while (/[A-Za-z0-9_]/.test(src[i] || '')) i++;
      tok({ t: 'id', v: src.slice(s0, i), verbatim: at });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      if (c === '0' && /[xXbB]/.test(src[i + 1] || '')) { i += 2; while (/[0-9a-fA-F_]/.test(src[i] || '')) i++; }
      else {
        while (/[0-9_]/.test(src[i] || '')) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) { i++; while (/[0-9_]/.test(src[i] || '')) i++; }
        if (/[eE]/.test(src[i] || '') && /[0-9+-]/.test(src[i + 1] || '')) { i++; if (/[+-]/.test(src[i])) i++; while (/[0-9]/.test(src[i] || '')) i++; }
      }
      while (/[lLuUfFdDmM]/.test(src[i] || '')) i++;
      tok({ t: 'num', v: src.slice(start, i) }); continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== "'") fail(line, 'CS1012: Too many characters in character literal (or it is never closed with \')');
      const body = unescape(src.slice(i + 1, j), line);
      i = j + 1;
      if (body.length !== 1) fail(line, body.length ? 'CS1012: Too many characters in character literal (use "…" for a string)' : 'CS1011: Empty character literal');
      tok({ t: 'chr', v: body }); continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~?:=@'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'CS1056: Unexpected character ' + JSON.stringify(c));
  }
  return toks;
}

/* ---- parser ---- */
export function parseCs(src, startLine = 1) {
  const toks = lex(src);
  if (startLine !== 1) for (const t of toks) t.line += startLine - 1;
  let i = 0;
  const lastLine = toks.length ? toks.at(-1).line : startLine;
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || (t.t === 'id' && !t.verbatim)) && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(lastLine, 'CS1513: } expected (the program ends too early)'); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  const show = t => (!t ? 'the end of the program' : t.t === 'str' || t.t === 'interp' ? 'a string' : t.t === 'chr' ? 'a char' : "'" + t.v + "'");
  const expect = (v, what) => {
    if (eat(v)) return;
    const t = peek(), prev = toks[i - 1];
    const code = { ';': 'CS1002', ')': 'CS1026', '}': 'CS1513', '{': 'CS1514', ']': 'CS1003', '(': 'CS1003', '>': 'CS1003' }[v] || 'CS1003';
    if (v === ';' && prev && (!t || t.line > prev.line)) fail(prev.line, `${code}: ; expected (at the end of the line)`);
    fail(t ? t.line : lastLine, `${code}: ${v} expected${what ? ' ' + what : ''}, not ${show(t)}`);
  };
  const isIdent = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && (t.verbatim || !KEYWORDS.has(t.v)); };
  const ident = what => { const t = peek(); if (!isIdent()) fail(t ? t.line : lastLine, `CS1001: Identifier expected${what ? ' (' + what + ')' : ''}, not ${show(t)}`); i++; return t.v; };
  const node = (k, l, o) => ({ k, line: l, ...o });
  /** The closing > of type arguments, also out of >> and >= */
  const closeAngle = () => {
    if (eat('>')) return true;
    const t = peek();
    if (t && t.t === 'p' && /^>(>|=|>=|>>|>>=)$/.test(t.v)) { toks.splice(i, 1, { ...t, v: '>' }, { ...t, v: t.v.slice(1), pos: t.pos + 1 }); i++; return true; }
    return false;
  };
  /** Runs fn; if it fails or returns null, puts the position back and returns null (where C# looks ahead) */
  const attempt = fn => {
    const save = i, saved = toks.slice();
    try { const r = fn(); if (r == null) { i = save; toks.splice(0, toks.length, ...saved); } return r; }
    catch (err) { if (!/^line \d+:/.test(err.message)) throw err; i = save; toks.splice(0, toks.length, ...saved); return null; }
  };

  /* ---- types: int, string, List<int>, Dictionary<string, List<int>>, int[], int[,], int?, (int, string), (int a, int b) ---- */
  function type() {
    const l = line();
    let t;
    if (is('(')) {                                     // a tuple type
      i++;
      const items = [];
      do { const tt = type(); const name = isIdent() ? ident() : null; items.push({ t: tt, name }); } while (eat(','));
      expect(')');
      if (items.length < 2) fail(l, 'CS8124: Tuple must contain at least two elements');
      t = { k: 't', n: 'tuple', items, line: l };
    } else {
      const tk = peek();
      if (!tk || tk.t !== 'id' || (KEYWORDS.has(tk.v) && !PREDEF.has(tk.v) && !tk.verbatim)) fail(tk ? tk.line : lastLine, `CS1031: Type expected, not ${show(tk)}`);
      i++;
      let n = tk.v;
      let args = typeArgsOpt();
      while (is('.') && isIdent(1)) { i++; n += '.' + ident(); const a = typeArgsOpt(); if (a) args = a; }   // System.Collections.Generic.List<int>
      const q = n.startsWith('System.');
      if (q) n = n.replace(/^(System\.)(Collections\.Generic\.|Text\.|Linq\.)?/, '');
      t = { k: 't', n, args: args || [], line: l, q };
    }
    for (;;) {
      if (is('?') && !isNullableEnd()) { i++; t = { ...t, nul: true }; continue; }
      if (is('[') && (is(']', 1) || is(',', 1))) {
        i++; let rank = 1; while (eat(',')) rank++; expect(']');
        t = { k: 't', n: 'array', of: t, rank, line: l };
        continue;
      }
      return t;
    }
  }
  /** int? x versus a ?: — a ? after a type is nullable unless what follows reads as an expression */
  const isNullableEnd = () => false;
  function typeArgsOpt() {
    if (!is('<')) return null;
    return attempt(() => {
      i++;
      const args = [];
      if (is('>')) { i++; return []; }               // typeof(List<>)
      do args.push(type()); while (eat(','));
      if (!closeAngle()) return null;
      return args;
    });
  }
  /** Name<T>(… or Name<T>. : type arguments that C# reads as such (the token after > decides) */
  function genericArgsAhead() {
    return attempt(() => {
      const a = typeArgsOpt();
      if (!a) return null;
      const t = peek();
      if (!t) return a;
      if (t.t === 'p' && ['(', ')', ']', '}', ':', ';', ',', '.', '?', '==', '!=', '|', '^', '&&', '||', '&', '[', '?.', '=>'].includes(t.v)) return a;
      return null;
    });
  }

  /* ---- declarations ---- */
  function modifiers() {
    const mods = new Set();
    for (;;) {
      if (is('[') && !is(']', 1)) { skipAttribute(); continue; }
      const t = peek();
      if (t && t.t === 'id' && MODIFIERS.has(t.v) && !(t.v === 'new' && (is('(', 1) || is('[', 1) || is('{', 1)))) {
        if (['partial', 'async', 'required', 'file'].includes(t.v) && !(isIdent(1) || is('class', 1) || is('struct', 1) || is('record', 1) || is('interface', 1) || PREDEF.has((peek(1) || {}).v) || is('static', 1) || is('void', 1))) return mods;
        if (t.v === 'async') fail(t.line, 'async methods (and await) are not supported here');
        mods.add(t.v); i++; continue;
      }
      return mods;
    }
  }
  /** [Attribute(…)] is skipped */
  function skipAttribute() { let depth = 0; do { if (is('[')) depth++; else if (is(']')) depth--; i++; } while (depth && i < toks.length); }
  const isTypeDeclStart = () => is('class') || is('struct') || is('interface') || is('enum') || (is('record') && (isIdent(1) || is('struct', 1) || is('class', 1)));
  function typeDecl(mods) {
    const l = line();
    let kind = next().v, rstruct = false;
    if (kind === 'record') { if (eat('struct')) rstruct = true; else eat('class'); }
    const name = ident('type name');
    const tps = typeParams();
    let pc = null;
    if (is('(') && (kind === 'record' || kind === 'class' || kind === 'struct')) pc = params();   // record Point(int X, int Y); class C(int x)
    const bases = [];
    let baseArgs = null;
    if (eat(':')) {
      do {
        bases.push(type());
        if (bases.length === 1 && is('(')) baseArgs = args();   // record B(int X) : A(X)
      } while (eat(','));
    }
    while (is('where')) { while (!is('{') && !is(';') && i < toks.length) i++; }
    const d = { k: kind === 'record' ? (rstruct ? 'struct' : 'class') : kind, record: kind === 'record', name, tps, pc, bases, baseArgs, members: [], mods, line: l };
    if (kind === 'enum') {
      expect('{');
      let at = 0;
      while (!eat('}')) {
        const ml = line(), n = ident('enum member');
        let val = null;
        if (eat('=')) val = expression();
        d.members.push({ k: 'enumMember', name: n, val, at: at++, line: ml });
        if (!eat(',')) { expect('}'); break; }
      }
      return d;
    }
    if (eat(';')) return d;                            // record Point(int X, int Y);
    expect('{');
    while (!eat('}')) { if (i >= toks.length) fail(lastLine, 'CS1513: } expected'); d.members.push(member(d)); }
    eat(';');
    return d;
  }
  function typeParams() {
    if (!eat('<')) return [];
    const tps = [];
    do { eat('in'); eat('out'); tps.push(ident('type parameter')); } while (eat(','));
    if (!closeAngle()) expect('>');
    return tps;
  }
  function member(decl) {
    const l = line();
    const mods = modifiers();
    if (isTypeDeclStart()) return typeDecl(mods);
    if (is('~')) fail(l, 'finalizers (~Name) are not supported here');
    if (decl.k === 'interface' && !mods.has('static')) mods.add('abstract-ish');
    // a constructor: Name(…)
    if (isIdent() && peek().v === decl.name && is('(', 1)) {
      i++;
      const ps = params();
      let init = null;
      if (eat(':')) { const kind = next().v; if (kind !== 'base' && kind !== 'this') fail(l, 'CS1018: Keyword \'this\' or \'base\' expected'); init = { kind, args: args() }; }
      const body = is('=>') ? (i++, (() => { const e = expression(); expect(';'); return { k: 'block', items: [node('expr', l, { e })], line: l }; })()) : block();
      return { k: 'ctor', mods, params: ps, init, body, line: l };
    }
    if (is('static') && is(decl.name, 1)) fail(l, 'static constructors are not supported here');
    if (eat('const')) {
      const t = type(), vars = [];
      do { const vl = line(); const n = ident(); expect('='); vars.push({ name: n, init: expression(), line: vl }); } while (eat(','));
      expect(';');
      mods.add('const'); mods.add('static');
      return { k: 'field', mods, type: t, vars, line: l };
    }
    if (is('implicit') || is('explicit')) fail(l, 'conversion operators are not supported here');
    if (is('event') || is('delegate')) fail(l, (peek().v) + ' declarations are not supported here (use Func<…> or Action<…>)');
    const t = is('void') ? (i++, { k: 't', n: 'void', args: [], line: l }) : type();
    if (eat('operator')) {
      const op = next().v;
      const ps = params();
      const body = methodBody();
      return { k: 'op', mods, ret: t, op: op === '+' && ps.length === 1 ? 'u+' : op === '-' && ps.length === 1 ? 'u-' : op, params: ps, ...body, line: l };
    }
    if (is('this') && is('[', 1)) {                    // an indexer: T this[int i] { get … set … }
      i++;
      const ps = params('[', ']');
      const acc = is('=>') ? (i++, (() => { const e = expression(); expect(';'); return { get: { expr: e, line: l }, set: null }; })()) : accessors(l);
      return { k: 'indexer', mods, type: t, params: ps, ...acc, line: l };
    }
    // Interface.Method explicit implementations: skip the interface name
    let name = ident('member name');
    while (is('.') && isIdent(1)) { i++; name = ident(); }
    if (is('<') || is('(')) {                          // a method
      const tps = typeParams();
      const ps = params();
      while (is('where')) { while (!is('{') && !is('=>') && !is(';')) i++; }
      const body = methodBody();
      return { k: 'method', mods, ret: t, name, tps, params: ps, ...body, line: l };
    }
    if (is('{')) {                                     // a property: { get; set; } = init;
      const acc = accessors(l);
      let init = null;
      if (eat('=')) { init = expression(); expect(';'); }
      return { k: 'prop', mods, type: t, name, ...acc, init, line: l };
    }
    if (is('=>')) { i++; const e = expression(); expect(';'); return { k: 'prop', mods, type: t, name, get: { expr: e }, set: null, line: l }; }
    // a field: T a = 1, b;
    const vars = [];
    let n = name, vl = l;
    for (;;) {
      let init = null;
      if (eat('=')) init = is('{') && t.n === 'array' ? arrayInit() : expression();
      vars.push({ name: n, init, line: vl });
      if (!eat(',')) break;
      vl = line(); n = ident();
    }
    expect(';');
    return { k: 'field', mods, type: t, vars, line: l };
  }
  /** { get; set; }, { get; private set; }, { get; init; }, { get => x; set { … } } */
  function accessors(l) {
    expect('{');
    const out = { get: null, set: null };
    while (!eat('}')) {
      const am = modifiers();
      const al = line(), kind = ident('get or set');
      if (!['get', 'set', 'init'].includes(kind)) fail(al, 'CS1014: A get or set accessor expected');
      let acc;
      if (eat(';')) acc = { auto: true };
      else if (eat('=>')) { acc = { expr: expression() }; expect(';'); }
      else acc = { body: block() };
      acc.mods = am; acc.line = al;
      if (kind === 'get') out.get = acc; else out.set = { ...acc, init: kind === 'init' };
    }
    if (!out.get && !out.set) fail(l, 'CS0548: a property or indexer must have at least one accessor');
    return out;
  }
  function methodBody() {
    if (eat(';')) return { body: null };              // abstract, or in an interface
    if (eat('=>')) { const l = line(); const e = expression(); expect(';'); return { body: null, expr: e, exprLine: l }; }
    return { body: block() };
  }
  function params(open = '(', close = ')') {
    expect(open);
    const ps = [];
    if (eat(close)) return ps;
    do {
      if (is('[')) skipAttribute();
      const l = line();
      let mod = null;
      if (is('ref') || is('out') || is('in') || is('params') || is('this')) mod = next().v;
      if (is('scoped')) i++;
      const t = type();
      const name = ident('parameter name');
      let def = null;
      if (eat('=')) def = expression();
      ps.push({ name, type: t, mod, def, line: l });
    } while (eat(','));
    expect(close);
    return ps;
  }
  /** (a, ref b, out var c, name: d) */
  function args(open = '(', close = ')') {
    expect(open);
    const out = [];
    if (eat(close)) return out;
    do {
      const l = line();
      let name = null, mod = null;
      if (isIdent() && is(':', 1) && !is('::', 1)) { name = ident(); i++; }
      if (is('ref') || is('out') || is('in')) mod = next().v;
      let e;
      if (mod === 'out' && (is('var') || (isIdent() && (isIdent(1) || is('<', 1) || is('[', 1) && is(']', 2))) || PREDEF.has((peek() || {}).v)) && !is(',', 1) && !is(close, 1)) {
        const t = is('var') ? (i++, null) : type();
        e = node('outVar', l, { type: t, name: is('_') && !isIdent(1) ? (i++, '_') : ident() });
      } else e = expression();
      out.push({ e, mod, name, line: l });
    } while (eat(','));
    expect(close);
    return out;
  }
  function arrayInit() {
    const l = line();
    expect('{');
    const items = [];
    while (!eat('}')) { items.push(is('{') ? arrayInit() : expression()); if (!eat(',')) { expect('}'); break; } }
    return node('arrInit', l, { items });
  }

  /* ---- statements ---- */
  function block() {
    const l = line();
    expect('{');
    const items = [];
    while (!eat('}')) { if (i >= toks.length) fail(lastLine, 'CS1513: } expected'); items.push(statement()); }
    return { k: 'block', items, line: l };
  }
  /** Is this the start of a local declaration (T x …)? Tries the type, then a name and one of = ; , */
  function localDeclAhead() {
    if (is('var') && (isIdent(1) || is('(', 1))) return true;
    const save = i;
    const r = !!attempt(() => {
      if (is('(')) return null;
      type();
      if (!isIdent()) return null;
      const t = peek(1);
      return t && t.t === 'p' && ['=', ';', ',', '['].includes(t.v) ? true : null;
    }) || !!attempt(() => {                            // (int a, string b) = …: a tuple type then a name
      if (!is('(')) return null;
      type();
      return isIdent() && (is('=', 1) || is(';', 1)) ? true : null;
    });
    i = save;
    return r;
  }
  function localDecl(l, isConst) {
    let t = null;
    if (is('var') && !is('=', 1) && !is(';', 1)) { i++; if (is('(')) return deconstructDecl(l, null); }
    else t = type();
    const vars = [];
    do {
      const vl = line(), name = ident('variable name');
      let init = null;
      if (eat('=')) init = is('{') && t && t.n === 'array' ? arrayInit() : expression();
      vars.push({ name, init, line: vl });
    } while (eat(','));
    return node('local', l, { type: t, vars, isConst });
  }
  /** var (a, b) = …; */
  function deconstructDecl(l) {
    const names = deconstructNames();
    expect('=');
    return node('deconstruct', l, { targets: names, decl: true, rhs: expression() });
  }
  function deconstructNames() {
    expect('(');
    const names = [];
    do {
      if (is('(')) names.push({ nested: deconstructNames() });
      else {
        let typed = false;
        if (is('var') || ((isIdent() || PREDEF.has((peek() || {}).v)) && (isIdent(1) || is('<', 1) || is('[', 1) || is('?', 1)))) { typed = true; if (!is('var')) type(); else i++; }
        names.push({ name: is('_') ? (i++, '_') : ident(), typed });
      }
    } while (eat(','));
    expect(')');
    return names;
  }
  function statement() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, 'CS1513: } expected');
    if (is('{')) return block();
    if (is(';')) { i++; return node('empty', l, {}); }
    if (t.t === 'id' && !t.verbatim) {
      switch (t.v) {
        case 'if': {
          i++; expect('('); const cond = expression(); expect(')');
          const a = embedded(); let b = null;
          if (eat('else')) b = embedded();
          return node('if', l, { cond, a, b });
        }
        case 'while': { i++; expect('('); const cond = expression(); expect(')'); return node('while', l, { cond, body: embedded() }); }
        case 'do': { i++; const body = embedded(); expect('while'); expect('('); const cond = expression(); expect(')'); expect(';'); return node('do', l, { cond, body }); }
        case 'for': {
          i++; expect('(');
          const init = [];
          if (!is(';')) { if (localDeclAhead()) init.push(localDecl(l, false)); else do init.push(node('expr', l, { e: expression() })); while (eat(',')); }
          expect(';');
          const cond = is(';') ? null : expression();
          expect(';');
          const step = [];
          if (!is(')')) do step.push(expression()); while (eat(','));
          expect(')');
          return node('for', l, { init, cond, step, body: embedded() });
        }
        case 'foreach': {
          i++; expect('(');
          let t2 = null, names = null, name = null;
          if (is('var') && is('(', 1)) { i++; names = deconstructNames(); }
          else if (is('(')) names = deconstructNames();
          else { if (is('var')) i++; else t2 = type(); name = ident('loop variable'); }
          expect('in', 'in a foreach');
          const e = expression(); expect(')');
          return node('foreach', l, { type: t2, name, names, e, body: embedded() });
        }
        case 'switch': return switchStmt();
        case 'break': i++; expect(';'); return node('break', l, {});
        case 'continue': i++; expect(';'); return node('continue', l, {});
        case 'return': { i++; const e = is(';') ? null : expression(); expect(';'); return node('return', l, { e }); }
        case 'throw': { i++; const e = is(';') ? null : expression(); expect(';'); return node('throw', l, { e }); }
        case 'try': return tryStmt();
        case 'goto': fail(l, 'goto is not supported here');
        // falls through
        case 'yield': if (is('return', 1) || is('break', 1)) fail(l, 'iterators (yield return) are not supported here (build a List and return it)');
          break;
        case 'using': if (is('(', 1) || is('var', 1)) fail(l, 'using statements are not supported here'); break;
        case 'lock': case 'unsafe': case 'fixed': fail(l, t.v + ' is not supported here');
        // falls through
        case 'checked': case 'unchecked': if (is('{', 1)) { i++; const b = block(); return node('checked', l, { on: t.v === 'checked', body: b }); } break;
        case 'const': { i++; const d = localDecl(l, true); expect(';'); return d; }
      }
      if (isIdent() && is(':', 1) && !is('::', 1)) fail(l, 'labels (and goto) are not supported here');
    }
    // a local function: [static] T Name(…) { … }
    const lf = attempt(() => {
      const mods = new Set();
      while (is('static') || is('async') || is('unsafe')) { if (is('async')) fail(l, 'async methods (and await) are not supported here'); mods.add(next().v); }
      const rt = is('void') ? (i++, { k: 't', n: 'void', args: [] }) : type();
      if (!isIdent() || !(is('(', 1) || is('<', 1))) return null;
      const name = ident();
      const tps = typeParams();
      if (!is('(')) return null;
      const ps = params();
      if (!is('{') && !is('=>')) return null;
      while (is('where')) { while (!is('{') && !is('=>')) i++; }
      const body = methodBody();
      return node('localFn', l, { fn: { k: 'method', mods, ret: rt, name, tps, params: ps, ...body, line: l } });
    });
    if (lf) return lf;
    if (is('(')) {                                     // (int a, int b) = …: a deconstructing declaration
      const d = attempt(() => {
        const names = deconstructNames();
        const all = ns => ns.every(n => (n.nested ? all(n.nested) : n.typed || n.name === '_'));
        if (!is('=') || !all(names)) return null;
        i++;
        const rhs = expression();
        expect(';');
        return node('deconstruct', l, { targets: names, decl: true, rhs });
      });
      if (d) return d;
    }
    if (localDeclAhead()) { const d = localDecl(l, false); expect(';'); return d; }
    const e = expression();
    if (!['assign', 'call', 'incdec', 'new', 'deconstructAssign', 'throwExpr'].includes(e.k)) fail(l, 'CS0201: Only assignment, call, increment, decrement, and new object expressions can be used as a statement');
    expect(';');
    return node('expr', l, { e });
  }
  /** the body of an if, a loop…: a declaration alone there is an error in C# */
  function embedded() {
    const s = statement();
    if (s.k === 'local' || s.k === 'localFn') fail(s.line, 'CS1023: Embedded statement cannot be a declaration or labeled statement (put it in { … })');
    return s;
  }
  function tryStmt() {
    const l = line(); i++;
    const body = block();
    const catches = [];
    let fin = null;
    while (is('catch')) {
      const cl = line(); i++;
      let t = null, name = null, when = null;
      if (eat('(')) { t = type(); if (isIdent()) name = ident(); expect(')'); }
      if (is('when')) { i++; expect('('); when = expression(); expect(')'); }
      catches.push({ type: t, name, when, body: block(), line: cl });
    }
    if (eat('finally')) fin = block();
    if (!catches.length && !fin) fail(l, 'CS1524: Expected catch or finally');
    return node('try', l, { body, catches, fin });
  }
  function switchStmt() {
    const l = line(); i++;
    expect('('); const e = expression(); expect(')');
    expect('{');
    const sections = [];
    while (!eat('}')) {
      const labels = [];
      while (is('case') || is('default')) {
        const ll = line();
        if (eat('default')) { expect(':'); labels.push({ pat: null, line: ll }); continue; }
        i++;
        const pat = pattern();
        let when = null;
        if (is('when')) { i++; when = expression(); }
        expect(':');
        labels.push({ pat, when, line: ll });
      }
      if (!labels.length) fail(line(), 'CS1513: case or default expected in the switch');
      const body = [];
      while (!is('case') && !is('default') && !is('}')) body.push(statement());
      sections.push({ labels, body, line: labels[0].line });
    }
    return node('switch', l, { e, sections });
  }

  /* ---- patterns: 5, null, int n, Circle c, var x, _, > 5, not null, A or B, (0, _), { X: 1 } ---- */
  function pattern() {
    let p = patAnd();
    while (is('or')) { i++; p = { k: 'or', a: p, b: patAnd() }; }
    return p;
  }
  function patAnd() {
    let p = patNot();
    while (is('and')) { i++; p = { k: 'and', a: p, b: patNot() }; }
    return p;
  }
  function patNot() {
    if (is('not')) { i++; return { k: 'not', p: patNot() }; }
    return patPrimary();
  }
  function patPrimary() {
    const l = line();
    if (is('(')) {                                     // a positional pattern (or a parenthesized one)
      const p = attempt(() => {
        i++;
        const items = [];
        if (!is(')')) do items.push(pattern()); while (eat(','));
        expect(')');
        if (items.length === 1 && !isIdent()) return { k: 'paren', p: items[0] };
        const name = isIdent() && !is('when') && !is('and') && !is('or') ? ident() : null;
        return { k: 'pos', items, name, line: l };
      });
      if (p) return p.k === 'paren' ? p.p : p;
    }
    if (is('{')) return propPattern(null, l);
    if (['<', '>', '<=', '>='].some(op => is(op))) { const op = next().v; return { k: 'rel', op, e: shift(), line: l }; }
    if (is('_') && !isIdent(1)) { i++; return { k: 'discard' }; }
    if (is('var')) { i++; if (is('(')) { const items = deconstructNames(); return { k: 'varTuple', items }; } return { k: 'var', name: ident(), line: l }; }
    if (is('null')) { i++; return { k: 'const', e: node('lit', l, { v: null, kind: 'null' }), line: l }; }
    // a type (with a designation, or followed by { or ( for a property / positional pattern), or a constant
    const tp = attempt(() => {
      const t = type();
      if (isIdent() && !is('when') && !is('and') && !is('or')) return { k: 'type', type: t, name: ident(), line: l };
      if (is('{')) return propPattern(t, l);
      if (is('(') && /^[A-Z]/.test(t.n)) { const pp = patPrimary(); return { ...pp, type: t }; }
      const n = peek();
      if (PREDEF.has(t.n) || t.args.length || t.n === 'array' || t.nul || t.n === 'tuple') return { k: 'type', type: t, name: null, line: l };
      if (!n || (n.t === 'p' && [':', ')', ',', '=>', '}', ']'].includes(n.v)) || is('when') || is('and') || is('or')) return { k: 'typeOrConst', type: t, e: null, line: l };
      return null;
    });
    if (tp) { if (tp.k === 'typeOrConst') { const tt = tp.type; tp.e = tt.n.split('.').reduce((acc, part) => (acc ? node('member', l, { e: acc, n: part }) : node('name', l, { n: part })), null); } return tp; }
    return { k: 'const', e: shift(), line: l };
  }
  function propPattern(t, l) {
    expect('{');
    const props = [];
    while (!eat('}')) {
      let name = ident('property name');
      while (eat('.')) name += '.' + ident();
      expect(':');
      props.push({ name, pat: pattern() });
      if (!eat(',')) { expect('}'); break; }
    }
    const name = isIdent() && !is('when') && !is('and') && !is('or') ? ident() : null;
    return { k: 'prop', type: t, props, name, line: l };
  }

  /* ---- expressions ---- */
  function expression() { return assignment(); }
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);
  function assignment() {
    const l = line();
    const lam = lambdaAhead();
    if (lam) return lam;
    if (is('throw')) { i++; return node('throwExpr', l, { e: expression() }); }
    // (a, b) = (b, a): a deconstructing assignment
    const left = conditional();
    const t = peek();
    if (t && t.t === 'p' && t.v === '>' && is('>=', 1)) { /* >>= split by type args: rare */ }
    if (t && t.t === 'p' && ASSIGN.has(t.v)) {
      i++;
      const right = t.v === '=' && is('ref') ? (i++, assignment()) : assignment();
      if (t.v === '=' && left.k === 'tuple') return node('deconstructAssign', l, { targets: left.items.map(x => x.e), rhs: right });
      if (!['name', 'member', 'index', 'this', 'tuple'].includes(left.k) && !(left.k === 'paren')) fail(l, 'CS0131: The left-hand side of an assignment must be a variable, property or indexer');
      return node('assign', l, { op: t.v, l: left, r: right });
    }
    return left;
  }
  /** x => …, (a, b) => …, (int a, int b) => …, () => …, static x => … */
  function lambdaAhead() {
    const l = line();
    if (is('static') && (isIdent(1) || is('(', 1))) { const save = i; i++; const r = lambdaAhead(); if (r) return r; i = save; }
    if (isIdent() && is('=>', 1)) { const n = ident(); i++; return node('lambda', l, { params: [{ name: n, type: null }], body: lambdaBody() }); }
    if (!is('(')) return null;
    return attempt(() => {
      i++;
      const ps = [];
      if (!is(')')) do {
        let mod = null;
        if (is('ref') || is('out') || is('in')) mod = next().v;
        if (isIdent() && (is(',', 1) || is(')', 1))) ps.push({ name: ident(), type: null, mod });
        else { const t = type(); ps.push({ name: ident(), type: t, mod }); }
      } while (eat(','));
      if (!eat(')') || !eat('=>')) return null;
      return node('lambda', l, { params: ps, body: lambdaBody() });
    });
  }
  const lambdaBody = () => (is('{') ? block() : expression());
  function conditional() {
    const l = line();
    const c = coalesce();
    if (is('?') && !is('.', 1) && !is('[', 1)) {
      i++;
      const a = assignmentNoLambda();
      expect(':', 'in ?:');
      const b = assignmentNoLambda();
      return node('cond', l, { c, a, b });
    }
    return c;
  }
  const assignmentNoLambda = () => { const lam = lambdaAhead(); if (lam) return lam; if (is('throw')) { const l = line(); i++; return node('throwExpr', l, { e: expression() }); } return conditional(); };
  function coalesce() {
    const l = line();
    const a = binary(0);
    if (eat('??')) { const b = is('throw') ? (i++, node('throwExpr', l, { e: expression() })) : coalesce(); return node('coalesce', l, { a, b }); }
    return a;
  }
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>=', 'is', 'as'], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%']];
  const SHIFT_LEVEL = 7;
  function binary(level) {
    if (level === LEVELS.length) return switchExpr();
    let e = binary(level + 1);
    for (;;) {
      const l = line();
      const t = peek();
      if (!t) return e;
      // > > as a shift (the lexer keeps them apart for type arguments)
      if (level === SHIFT_LEVEL && t.t === 'p' && t.v === '>' && is('>', 1) && toks[i + 1].pos === t.end) { i += 2; e = node('bin', l, { op: '>>', l: e, r: binary(level + 1) }); continue; }
      if (level === SHIFT_LEVEL - 1 && t.t === 'p' && t.v === '>' && is('>', 1) && toks[i + 1].pos === t.end) return e;
      const op = LEVELS[level].find(o => is(o));
      if (!op) return e;
      if ((op === 'is' || op === 'as') && t.t !== 'id') return e;
      i++;
      if (op === 'is') { e = node('is', l, { e, pat: pattern() }); continue; }
      if (op === 'as') { e = node('as', l, { e, type: type() }); continue; }
      e = node(op === '&&' || op === '||' ? 'logic' : 'bin', l, { op, l: e, r: binary(level + 1) });
    }
  }
  const shift = () => binary(SHIFT_LEVEL);
  /** x switch { pattern => value, … } */
  function switchExpr() {
    let e = rangeExpr();
    while (is('switch') && is('{', 1)) {
      const l = line(); i += 2;
      const arms = [];
      while (!eat('}')) {
        const al = line();
        const pat = pattern();
        let when = null;
        if (is('when')) { i++; when = expression(); }
        expect('=>');
        const v = is('throw') ? (i++, node('throwExpr', al, { e: expression() })) : expression();
        arms.push({ pat, when, e: v, line: al });
        if (!eat(',')) { expect('}'); break; }
      }
      e = node('switchExpr', l, { e, arms });
    }
    return e;
  }
  /** a..b, ..b, a.., .. */
  function rangeExpr() {
    const l = line();
    if (is('..')) { i++; const b = rangeEndAhead() ? unary() : null; return node('range', l, { a: null, b }); }
    const a = unary();
    if (is('..')) { i++; const b = rangeEndAhead() ? unary() : null; return node('range', l, { a, b }); }
    return a;
  }
  const rangeEndAhead = () => { const t = peek(); return !!t && !(t.t === 'p' && [']', ')', ',', ';', '}'].includes(t.v)); };
  function unary() {
    const t = peek(), l = line();
    if (t && t.t === 'p') {
      if (['-', '+', '!', '~'].includes(t.v)) {
        i++;
        if (t.v === '-' && peek() && peek().t === 'num') { const n = number(next(), true); return postfix(n); }
        return node('un', l, { op: t.v, e: unary() });
      }
      if (t.v === '^') { i++; return node('fromEnd', l, { e: unary() }); }
      if (t.v === '++' || t.v === '--') { i++; return node('incdec', l, { op: t.v, prefix: true, e: unary() }); }
      if (t.v === '&' || t.v === '*') fail(l, 'pointers (unsafe code) are not supported here');
      if (t.v === '(') {                               // a cast: (int)x, (List<int>)o, (double)(a + b)
        const c = attempt(() => {
          i++;
          const ty = type();
          if (!eat(')')) return null;
          const n = peek();
          if (!n) return null;
          const predef = PREDEF.has(ty.n) || ty.n === 'array' || ty.nul || ty.args.length;
          const startsOperand = n.t === 'num' || n.t === 'str' || n.t === 'chr' || n.t === 'interp' || (n.t === 'id' && (!KEYWORDS.has(n.v) || ['this', 'base', 'new', 'true', 'false', 'null', 'default', 'typeof', 'checked', 'sizeof'].includes(n.v) || PREDEF.has(n.v))) || (n.t === 'p' && (n.v === '(' || n.v === '!' || n.v === '~'));
          if (!startsOperand && !(predef && n.t === 'p' && ['-', '+', '++', '--'].includes(n.v))) return null;
          if (!predef && n.t === 'p' && n.v !== '(' && n.v !== '!' && n.v !== '~') return null;
          return node('cast', l, { type: ty, e: unary() });
        });
        if (c) return c;
      }
    }
    if (is('await')) fail(l, 'await (and async) is not supported here');
    return postfix(primary());
  }
  function postfix(e) {
    for (;;) {
      const l = line();
      if (is('.') && !is('.', 1)) {
        i++;
        const n = ident('member name');
        const targs = is('<') ? genericArgsAhead() : null;
        e = node('member', l, { e, n, targs });
        continue;
      }
      if (is('?.')) { i++; if (is('[')) { e = node('index', l, { e, args: args('[', ']'), cond: true }); continue; } const n = ident('member name'); e = node('member', l, { e, n, cond: true }); continue; }
      if (is('(')) { e = node('call', l, { f: e, args: args() }); continue; }
      if (is('[')) { e = node('index', l, { e, args: args('[', ']') }); continue; }
      if (is('++') || is('--')) { e = node('incdec', l, { op: next().v, prefix: false, e }); continue; }
      if (is('!') && !is('=', 1) && (() => { const n = peek(1); return !n || (n.t === 'p' && ['.', ')', ';', ',', ']', '?.', '['].includes(n.v)); })()) { i++; continue; }   // x!: null-forgiving
      if (is('with') && is('{', 1)) { i++; const inits = objInit(); e = node('with', l, { e, inits: inits.items }); continue; }
      return e;
    }
  }
  /** { X = 1, Y = 2 }, { 1, 2 }, { ["a"] = 1 }, { { "a", 1 } } after new T(…) */
  function objInit() {
    const l = line();
    expect('{');
    const items = [];
    let kind = null;
    while (!eat('}')) {
      const il = line();
      if (isIdent() && is('=', 1)) { kind = 'obj'; const n = ident(); i++; items.push({ name: n, e: is('{') ? objInit() : expression(), line: il }); }
      else if (is('[')) { kind = 'obj'; const key = args('[', ']'); expect('='); items.push({ index: key.map(a => a.e), e: expression(), line: il }); }
      else if (is('{')) { kind = kind || 'coll'; i++; const parts = []; while (!eat('}')) { parts.push(expression()); if (!eat(',')) { expect('}'); break; } } items.push({ add: parts, line: il }); }
      else { kind = kind || 'coll'; items.push({ add: [expression()], line: il }); }
      if (!eat(',')) { expect('}'); break; }
    }
    return node('init', l, { kind: kind || 'obj', items });
  }
  function primary() {
    const t = next(), l = t.line;
    if (t.t === 'num') return number(t);
    if (t.t === 'str') return node('lit', l, { v: t.v, kind: 'string' });
    if (t.t === 'chr') return node('lit', l, { v: t.v, kind: 'char' });
    if (t.t === 'interp') return node('interp', l, { parts: t.v.map(p => (typeof p === 'string' ? p : { e: subExpr(p.src, p.line), fmt: p.fmt, align: p.align ? subExpr(p.align, p.line) : null })) });
    if (t.t === 'p' && t.v === '(') {
      // a tuple (1, "a"), (a: 1, b: 2), or a parenthesized expression
      const items = [];
      do {
        const il = line();
        let name = null;
        if (isIdent() && is(':', 1)) { name = ident(); i++; }
        items.push({ e: expression(), name, line: il });
      } while (eat(','));
      expect(')');
      if (items.length === 1 && !items[0].name) return node('paren', l, { e: items[0].e });
      return node('tuple', l, { items });
    }
    if (t.t === 'p' && t.v === '[') {                  // a collection expression: [1, 2, ..rest]
      const items = [];
      while (!eat(']')) {
        if (eat('..')) items.push({ spread: expression() }); else items.push({ e: expression() });
        if (!eat(',')) { expect(']'); break; }
      }
      return node('collExpr', l, { items });
    }
    if (t.t === 'id' && !t.verbatim) {
      switch (t.v) {
        case 'true': case 'false': return node('lit', l, { v: t.v === 'true', kind: 'bool' });
        case 'null': return node('lit', l, { v: null, kind: 'null' });
        case 'this': return node('this', l, {});
        case 'base': return node('base', l, {});
        case 'new': return newExpr(l);
        case 'typeof': { expect('('); const ty = type(); expect(')'); return node('typeof', l, { type: ty }); }
        case 'default': if (eat('(')) { const ty = type(); expect(')'); return node('default', l, { type: ty }); } return node('default', l, { type: null });
        case 'checked': case 'unchecked': { expect('('); const e = expression(); expect(')'); return node('checkedExpr', l, { on: t.v === 'checked', e }); }
        case 'sizeof': fail(l, 'sizeof is not supported here');
        // falls through
        case 'delegate': fail(l, 'anonymous delegates are not supported here (use a lambda: x => …)');
      }
      if (t.v === 'nameof' && is('(')) { expect('('); const e = expression(); expect(')'); return node('nameof', l, { e }); }
      if (PREDEF.has(t.v)) {                           // int.Parse, string.Join, int.MaxValue, (or a type where a value is wanted)
        if (is('.')) return node('typeName', l, { n: t.v });
        if (is('?') || is('[')) { i--; const ty = type(); return node('typeName', l, { n: ty.n, type: ty }); }
        return node('typeName', l, { n: t.v });
      }
      if (KEYWORDS.has(t.v)) fail(l, `CS1525: Invalid expression term '${t.v}'`);
    }
    if (t.t === 'id') {
      const targs = is('<') ? genericArgsAhead() : null;
      return node('name', l, { n: t.v, targs });
    }
    fail(l, `CS1525: Invalid expression term ${show(t)}`);
  }
  /** an interpolation hole's expression, parsed on its own */
  function subExpr(text, l) {
    const sub = parseCs.expr(text, l);
    return sub;
  }
  function newExpr(l) {
    if (is('(')) { const a = args(); const init = is('{') ? objInit() : null; return node('new', l, { type: null, args: a, init }); }   // target-typed new()
    if (is('[')) {                                     // new[] { 1, 2 }
      i++; let rank = 1; while (eat(',')) rank++; expect(']');
      const init = arrayInit();
      return node('newArr', l, { type: null, dims: null, rank, init });
    }
    if (is('{')) fail(l, 'anonymous types (new { … }) are not supported here (use a tuple or a record)');
    // the element type, without array ranks: new int[5], new int[2, 3], new int[] {…}, new List<int>[3]
    const tk = peek();
    let t;
    if (tk && tk.t === 'p' && tk.v === '(') t = type();
    else {
      i++;
      let n = tk.v;
      let a = typeArgsOpt();
      while (is('.') && isIdent(1)) { i++; n += '.' + ident(); const a2 = typeArgsOpt(); if (a2) a = a2; }
      const q = n.startsWith('System.');
      if (q) n = n.replace(/^(System\.)(Collections\.Generic\.|Text\.|Linq\.)?/, '');
      t = { k: 't', n, args: a || [], line: l, q };
      if (is('?')) { i++; t.nul = true; }
    }
    if (is('[')) {
      i++;
      const dims = [];
      if (is(']') || is(',')) { let rank = 1; while (eat(',')) rank++; expect(']'); while (is('[') && (is(']', 1) || is(',', 1))) { i++; let r2 = 1; while (eat(',')) r2++; expect(']'); t = { k: 't', n: 'array', of: t, rank: r2, line: l }; } return node('newArr', l, { type: t, dims: null, rank, init: arrayInit() }); }
      do dims.push(expression()); while (eat(','));
      expect(']');
      // new int[3][]: the rest are ranks of the element type
      while (is('[') && (is(']', 1) || is(',', 1))) { i++; let r2 = 1; while (eat(',')) r2++; expect(']'); t = { k: 't', n: 'array', of: t, rank: r2, line: l }; }
      const init = is('{') ? arrayInit() : null;
      return node('newArr', l, { type: t, dims, rank: dims.length, init });
    }
    const a = is('(') ? args() : [];
    const init = is('{') ? objInit() : null;
    if (!a.length && !init && !toks[i - 1].v.match(/[)]/)) { /* new T with neither () nor {} */ }
    return node('new', l, { type: t, args: a, init });
  }
  function number(t, neg = false) {
    let raw = t.v.replace(/_/g, ''), l = t.line;
    const suf = (raw.match(/^0[xXbB]/) ? raw.match(/[lLuU]+$/) || [''] : raw.match(/[lLuUfFdDmM]+$/) || [''])[0].toLowerCase();
    raw = raw.slice(0, raw.length - suf.length);
    if (suf.includes('m')) fail(l, 'decimal is not supported here (use double)');
    if (/^0[xXbB]/.test(raw) || (/^[0-9]+$/.test(raw) && !suf.includes('f') && !suf.includes('d'))) {
      let v = BigInt(raw.toLowerCase().startsWith('0b') ? raw : raw);
      if (neg) v = -v;
      let kind = suf.includes('l') ? (suf.includes('u') ? 'ulong' : 'long') : suf.includes('u') ? 'uint' : 'int';
      if (kind === 'int' && (v > 2147483647n || v < -2147483648n)) kind = v > 4294967295n || v < 0n ? 'long' : 'uint';
      if (kind === 'uint' && v > 4294967295n) kind = 'ulong';
      return node('lit', l, { v, kind });
    }
    const f = parseFloat(raw);
    if (Number.isNaN(f)) fail(l, 'CS1021: Invalid number ' + t.v);
    return node('lit', l, { v: neg ? -f : f, kind: suf.includes('f') ? 'float' : 'double' });
  }

  /* ---- the file: usings, namespaces, types, top-level statements ---- */
  if (parseCs.exprMode) {
    const e = expression();
    if (i < toks.length) fail(toks[i].line, `CS1525: Invalid expression term ${show(toks[i])}`);
    return e;
  }
  const usings = [], types = [], top = [];
  let topLine = null, ns = null;
  const decls = endBrace => {
    while (i < toks.length && !(endBrace && is('}'))) {
      const l = line();
      if (is('using') && !is('(', 1) && !is('var', 1)) {
        i++;
        const stat = eat('static');
        let alias = null;
        if (isIdent() && is('=', 1)) { alias = ident(); i++; }
        let n = ident(); while (eat('.')) n += '.' + ident();
        if (is('<')) typeArgsOpt();
        expect(';');
        usings.push({ n, stat, alias, line: l });
        continue;
      }
      if (is('namespace')) {
        i++; let n = ident(); while (eat('.')) n += '.' + ident();
        const outer = ns;
        ns = outer ? outer + '.' + n : n;
        if (eat(';')) continue;                        // file-scoped namespace
        expect('{'); decls(true); expect('}');
        ns = outer;
        continue;
      }
      const save = i;
      const mods = modifiers();
      if (isTypeDeclStart()) { types.push({ ...typeDecl(mods), ns }); continue; }
      if (is('delegate')) fail(l, 'delegate declarations are not supported here (use Func<…> or Action<…>)');
      i = save;
      if (endBrace) fail(l, 'CS0116: A namespace cannot directly contain members such as fields, methods or statements');
      if (types.length && !top.length) { /* statements after types: C# allows types only after the statements */ }
      if (topLine == null) topLine = l;
      const s = statement();
      if (types.length) fail(s.line, 'CS8803: Top-level statements must precede namespace and type declarations.');
      top.push(s);
    }
  };
  decls(false);
  return { usings, types, top, topLine };
}
/** an expression on its own (an interpolation hole) */
parseCs.expr = (text, line) => {
  parseCs.exprMode = true;
  try { return parseCs(text, line); } finally { parseCs.exprMode = false; }
};
