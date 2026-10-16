/**
 * The Kotlin front end: a lexer (newlines kept, as Kotlin ends statements with them) and a recursive-descent parser for
 * the Kotlin that algorithms use: fun main and top-level functions and properties, classes (data, open, abstract,
 * sealed, enum, inner), objects and companions, interfaces, properties with getters and setters, extension functions,
 * operators and infix functions, lambdas (with it, trailing), when, if / try as expressions, ranges, string templates,
 * destructuring, labels. parseKotlin(source) returns { imports, decls } or throws an Error "line N: …".
 */
export const fail = (line, msg) => { throw new Error('line ' + line + ': ' + msg); };

const HARD = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object',
  'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);
const MODIFIERS = new Set(['abstract', 'open', 'override', 'private', 'protected', 'public', 'internal', 'data', 'sealed', 'enum', 'inner', 'companion',
  'lateinit', 'const', 'inline', 'infix', 'operator', 'tailrec', 'suspend', 'external', 'final', 'annotation', 'value', 'noinline', 'crossinline', 'reified', 'vararg', 'actual', 'expect']);
const PUNCT = ['===', '!==', '..<', '?.', '?:', '!!', '::', '..', '->', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%='];

/* ---- lexer ---- */
const ESC = { t: '\t', b: '\b', n: '\n', r: '\r', "'": "'", '"': '"', '\\': '\\', $: '$' };
export function lex(src) {
  const toks = [];
  let i = 0, line = 1, nl = false;
  const at = () => line;
  /** a string's parts: text, and { src, line } for ${…} and $name */
  function template(raw, l0) {
    const parts = [];
    let cur = '';
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (c === '\\' && !raw.raw) {
        const e = raw[j + 1];
        if (e === 'u') { cur += String.fromCharCode(parseInt(raw.slice(j + 2, j + 6), 16)); j += 5; continue; }
        if (!(e in ESC)) fail(l0, `illegal escape: '\\${e}'.`);
        cur += ESC[e]; j++; continue;
      }
      if (c === '$' && raw[j + 1] === '{') {
        let depth = 0, k = j + 1;
        for (; k < raw.length; k++) { if (raw[k] === '{') depth++; else if (raw[k] === '}') { depth--; if (!depth) break; } }
        if (k >= raw.length) fail(l0, 'expecting \'}\' (the ${…} in the string is never closed).');
        parts.push(cur); cur = '';
        parts.push({ src: raw.slice(j + 2, k), line: l0 + (raw.slice(0, j).match(/\n/g) || []).length });
        j = k; continue;
      }
      if (c === '$' && /[A-Za-z_]/.test(raw[j + 1] || '')) {
        let k = j + 1;
        while (/[A-Za-z0-9_]/.test(raw[k] || '')) k++;
        parts.push(cur); cur = '';
        parts.push({ src: raw.slice(j + 1, k), line: l0, simple: true });
        j = k - 1; continue;
      }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; nl = true; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {                // Kotlin's block comments nest
      let depth = 0, j = i;
      do { if (src.startsWith('/*', j)) { depth++; j += 2; } else if (src.startsWith('*/', j)) { depth--; j += 2; } else { if (src[j] === '\n') line++; j++; } } while (depth && j < src.length);
      if (depth) fail(line, 'unclosed comment.');
      i = j; continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const start = i, l0 = at(), tok = t => { toks.push({ ...t, line: l0, pos: start, end: i, nl }); nl = false; };
    if (src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      if (e < 0) fail(line, 'expecting \'"""\'.');
      let k = e; while (src[k + 3] === '"') k++;      // """a"""" ends with the last three quotes
      const raw = Object.assign(new String(src.slice(i + 3, k)), { raw: true });
      line += (raw.match(/\n/g) || []).length;
      i = k + 3;
      tok({ t: 'str', v: template(raw, l0) }); continue;
    }
    if (c === '"') {
      let j = i + 1, depth = 0;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\n' && !depth) fail(line, 'expecting \'"\' (the string is never closed).');
        if (d === '\\') { j++; continue; }
        if (d === '$' && src[j + 1] === '{') { depth++; j++; continue; }
        if (depth && d === '{') { depth++; continue; }
        if (depth && d === '}') { depth--; continue; }
        if (depth && d === '"') { j++; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; } continue; }
        if (d === '"' && !depth) break;
      }
      if (src[j] !== '"') fail(line, 'expecting \'"\' (the string is never closed).');
      const raw = src.slice(i + 1, j);
      i = j + 1;
      tok({ t: 'str', v: template(raw, l0) }); continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== "'") fail(line, 'incorrect character literal.');
      const body = src.slice(i + 1, j);
      let v;
      if (body[0] === '\\') { const e = body[1]; v = e === 'u' ? String.fromCharCode(parseInt(body.slice(2, 6), 16)) : ESC[e]; if (v === undefined) fail(line, `illegal escape: '${body}'.`); }
      else { if (body.length !== 1) fail(line, body.length ? 'too many characters in a character literal \'' + body + '\'.' : 'empty character literal.'); v = body; }
      i = j + 1;
      tok({ t: 'chr', v }); continue;
    }
    if (c === '`') { const e = src.indexOf('`', i + 1); if (e < 0) fail(line, 'expecting \'`\'.'); i = e + 1; tok({ t: 'id', v: src.slice(start + 1, e), quoted: true }); continue; }
    if (/[A-Za-z_]/.test(c)) { while (/[A-Za-z0-9_]/.test(src[i] || '')) i++; tok({ t: 'id', v: src.slice(start, i) }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !(toks.length && toks.at(-1).t === 'p' && toks.at(-1).v === '..'))) {
      if (c === '0' && /[xXbB]/.test(src[i + 1] || '')) { i += 2; while (/[0-9a-fA-F_]/.test(src[i] || '')) i++; }
      else {
        while (/[0-9_]/.test(src[i] || '')) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) { i++; while (/[0-9_]/.test(src[i] || '')) i++; }
        if (/[eE]/.test(src[i] || '') && /[0-9+-]/.test(src[i + 1] || '')) { i++; if (/[+-]/.test(src[i])) i++; while (/[0-9]/.test(src[i] || '')) i++; }
      }
      if (/[fFL]/.test(src[i] || '')) i++;
      else if (/[uU]/.test(src[i] || '')) fail(line, 'unsigned numbers are not supported here.');
      tok({ t: 'num', v: src.slice(start, i) }); continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (p) { i += p.length; tok({ t: 'p', v: p }); continue; }
    if ('{}[]();,.<>+-*/%&|^!~?:=@'.includes(c)) { i++; tok({ t: 'p', v: c }); continue; }
    fail(line, 'expecting an element (unexpected character ' + JSON.stringify(c) + ').');
  }
  return toks;
}

/* ---- parser ---- */
export function parseKotlin(src, startLine = 1, exprOnly = false) {
  const toks = lex(src);
  if (startLine !== 1) for (const t of toks) t.line += startLine - 1;
  let i = 0, nlOff = 0;                               // nlOff > 0: inside ( ) or [ ], where newlines do not end anything
  const lastLine = toks.length ? toks.at(-1).line : startLine;
  const peek = (o = 0) => toks[i + o];
  const is = (v, o = 0) => { const t = toks[i + o]; return !!t && (t.t === 'p' || (t.t === 'id' && !t.quoted)) && t.v === v; };
  const line = () => (toks[i] || toks[i - 1] || { line: lastLine }).line;
  const next = () => { if (i >= toks.length) fail(lastLine, "expecting '}' (the program ends too early)."); return toks[i++]; };
  const eat = v => (is(v) ? (i++, true) : false);
  /** is the next token on a new line (and newlines count here)? */
  const atNl = () => { const t = peek(); return !!t && t.nl && nlOff === 0; };
  const show = t => (!t ? 'end of file' : t.t === 'str' ? 'a string' : t.t === 'chr' ? 'a character' : "'" + t.v + "'");
  const expect = (v, what) => { if (eat(v)) return; const t = peek(); fail(t ? t.line : lastLine, `expecting '${v}'${what ? ' ' + what : ''}, not ${show(t)}.`); };
  const isIdent = (o = 0) => { const t = peek(o); return !!t && t.t === 'id' && (t.quoted || !HARD.has(t.v)); };
  const ident = what => { const t = peek(); if (!isIdent()) fail(t ? t.line : lastLine, `expecting ${what || 'a name'}, not ${show(t)}.`); i++; return t.v; };
  const node = (k, l, o) => ({ k, line: l, ...o });
  const attempt = fn => {
    const save = i, saveNl = nlOff, saved = toks.slice();
    try { const r = fn(); if (r == null) { i = save; nlOff = saveNl; toks.splice(0, toks.length, ...saved); } return r; }
    catch (err) { if (!/^line \d+:/.test(err.message)) throw err; i = save; nlOff = saveNl; toks.splice(0, toks.length, ...saved); return null; }
  };
  const inParens = fn => { nlOff++; try { return fn(); } finally { nlOff--; } };
  const inBlock = fn => { const s = nlOff; nlOff = 0; try { return fn(); } finally { nlOff = s; } };
  /** the closing > of type arguments, also out of >> and >= */
  const closeAngle = () => {
    if (eat('>')) return true;
    const t = peek();
    if (t && t.t === 'p' && /^>(=|>|>=)$/.test(t.v)) { toks.splice(i, 1, { ...t, v: '>' }, { ...t, v: t.v.slice(1), pos: t.pos + 1, nl: false }); i++; return true; }
    return false;
  };
  const skipAnnotations = () => { while (is('@') && isIdent(1) && !(toks[i + 1].nl)) { i += 2; while (is('.') && isIdent(1)) i += 2; if (is('(') && !peek().nl) skipParens(); } };
  const skipParens = () => { let d = 0; do { if (is('(')) d++; else if (is(')')) d--; i++; } while (d && i < toks.length); };

  /* ---- types: Int, String?, List<Int>, MutableMap<String, MutableList<Int>>, (Int, Int) -> Int, Array<IntArray> ---- */
  function type() {
    const l = line();
    skipAnnotations();
    if (is('(')) {                                     // a function type, or a parenthesized one
      const ft = attempt(() => {
        i++;
        const ps = [];
        if (!is(')')) do { if (isIdent() && is(':', 1)) i += 2; ps.push(type()); } while (eat(','));
        expect(')');
        if (!eat('->')) return null;
        return { k: 't', n: 'fn', params: ps, ret: type(), args: [], line: l };
      });
      if (ft) return ft;
      i++; const t = type(); expect(')');
      return eat('?') ? { ...t, nul: true } : t;
    }
    if (is('*')) { i++; return { k: 't', n: '*', args: [], line: l }; }
    let n = ident('a type');
    while (is('.') && isIdent(1) && /^[A-Z]/.test(peek(1).v)) { i++; n += '.' + ident(); }
    n = n.replace(/^(kotlin\.(collections\.)?|java\.util\.|java\.lang\.)/, '');
    let args = [];
    if (is('<')) {
      i++;
      do { if (is('out') || is('in')) { if (isIdent(1) || is('*', 1)) i++; } args.push(type()); } while (eat(','));
      if (!closeAngle()) expect('>');
    }
    let t = { k: 't', n, args, line: l };
    if (is('?') && !peek().nl) { i++; t = { ...t, nul: true }; }
    if (is('->') && false) return t;
    return t;
  }
  const typeArgsOpt = () => attempt(() => {
    if (!eat('<')) return null;
    const a = [];
    do a.push(type()); while (eat(','));
    if (!closeAngle()) return null;
    const t = peek();
    return t && t.t === 'p' && (t.v === '(' || t.v === '::' || t.v === '.' || t.v === '{') && !t.nl ? a : null;
  });

  /* ---- declarations ---- */
  function modifiers() {
    const mods = new Set();
    for (;;) {
      skipAnnotations();
      const t = peek();
      if (t && t.t === 'id' && MODIFIERS.has(t.v) && !t.quoted) {
        // a soft modifier is a name when what follows cannot be a declaration (val data = 1, data.x)
        const n = peek(1);
        if (!n || n.nl && !['fun', 'val', 'var', 'class', 'object', 'interface', 'constructor', 'init'].includes(n.v)) return mods;
        if (n.t === 'p' && !['@'].includes(n.v)) return mods;
        if (t.v === 'suspend') fail(t.line, 'coroutines (suspend) are not supported here.');
        mods.add(t.v); i++; continue;
      }
      return mods;
    }
  }
  const isDeclStart = () => is('fun') || is('val') || is('var') || is('class') || is('interface') || is('object') || is('typealias') || (is('constructor') && is('(', 1)) || (is('init') && is('{', 1));
  /** a statement separator: ; or a newline (or the end of the block) */
  function endOfStatement(closer = '}') {
    if (eat(';')) { while (eat(';')); return; }
    const t = peek();
    if (!t || t.nl || is(closer)) return;
    fail(t.line, `unexpected tokens (use ';' to separate expressions on the same line): ${show(t)}.`);
  }
  function decl(mods, l, inClass) {
    if (is('fun')) return funDecl(mods, l);
    if (is('val') || is('var')) return propDecl(mods, l, inClass);
    if (is('class') || is('interface') || (is('object') && !is('(', 1))) return classDecl(mods, l);
    if (is('typealias')) { i++; const name = ident(); expect('='); return { k: 'typealias', name, type: type(), line: l }; }
    if (is('constructor')) {
      i++;
      const ps = params();
      let del = null;
      if (eat(':')) { const kind = ident(); if (kind !== 'this' && kind !== 'super') fail(l, "expecting 'this' or 'super'."); del = { kind, args: callArgs() }; }
      const body = is('{') ? block() : null;
      return { k: 'ctor', mods, params: ps, del, body, line: l };
    }
    if (is('init')) { i++; return { k: 'init', body: block(), line: l }; }
    fail(l, `expecting a top level declaration, not ${show(peek())}.`);
  }
  function funDecl(mods, l) {
    i++;
    const tps = typeParams();
    // an extension: fun Int.isEven(), fun <T> List<T>.second(), fun String?.orEmpty2()
    let recv = null, name;
    const ext = attempt(() => { const t = type(); if (!eat('.')) return null; return t; });
    if (ext) recv = ext;
    name = ident('a function name');
    if (!tps.length && is('<')) tps.push(...typeParams());
    const ps = params();
    let ret = null;
    if (eat(':')) ret = type();
    while (is('where')) { while (!is('{') && !is('=')) i++; }
    let body = null, expr = null;
    if (is('{')) body = block();
    else if (eat('=')) { const el = line(); expr = expression(); expr.bodyLine = el; }
    return { k: 'fun', mods, name, recv, tps, params: ps, ret, body, expr, line: l };
  }
  function typeParams() {
    if (!is('<')) return [];
    i++;
    const tps = [];
    do { modifiers(); tps.push(ident('a type parameter')); if (eat(':')) type(); } while (eat(','));
    if (!closeAngle()) expect('>');
    return tps;
  }
  function params() {
    expect('(');
    return inParens(() => {
      const ps = [];
      while (!eat(')')) {
        const pl = line();
        const pm = modifiers();
        let prop = null;
        if (is('val') || is('var')) prop = next().v;
        const name = ident('a parameter name');
        let t = null;
        if (eat(':')) t = type();
        let def = null;
        if (eat('=')) def = expression();
        ps.push({ name, type: t, def, prop, vararg: pm.has('vararg'), mods: pm, line: pl });
        if (!eat(',')) { expect(')'); break; }
      }
      return ps;
    });
  }
  function propDecl(mods, l, inClass) {
    const mutable = next().v === 'var';
    const tps = typeParams();
    void tps;
    if (is('(')) {                                     // val (a, b) = pair
      const names = destructNames();
      expect('=');
      return { k: 'destructure', names, init: expression(), mutable, line: l };
    }
    let recv = null;
    const ext = attempt(() => { const t = type(); if (!eat('.')) return null; return t; });
    if (ext) recv = ext;
    const name = ident('a property name');
    let t = null, init = null, delegate = null;
    if (eat(':')) t = type();
    if (eat('=')) init = expression();
    else if (is('by')) { i++; delegate = expression(); }
    const p = { k: 'prop', mods, mutable, name, type: t, init, delegate, recv, get: null, set: null, line: l };
    // get() = … and set(value) { … } on the next lines
    for (;;) {
      const save = i;
      const am = modifiers();
      if (is('get') && (is('(', 1) || is('=', 1) || !peek(1) || peek(1).nl)) {
        i++;
        if (eat('(')) expect(')');
        if (eat(':')) type();
        p.get = is('{') ? { body: block() } : eat('=') ? { expr: expression() } : { auto: true };
        p.get.mods = am;
        continue;
      }
      if (is('set') && (is('(', 1) || !peek(1) || peek(1).nl || is('}', 1))) {
        i++;
        let pn = 'value';
        if (eat('(')) { pn = ident(); if (eat(':')) type(); expect(')'); }
        p.set = is('{') ? { body: block(), param: pn } : eat('=') ? { expr: expression(), param: pn } : { auto: true };
        p.set.mods = am;
        continue;
      }
      i = save;
      break;
    }
    void inClass;
    return p;
  }
  function destructNames() {
    expect('(');
    return inParens(() => {
      const names = [];
      do { const n = is('_') ? (i++, '_') : ident(); let t = null; if (eat(':')) t = type(); names.push({ name: n, type: t }); } while (eat(','));
      expect(')');
      return names;
    });
  }
  function classDecl(mods, l) {
    const kw = next().v;
    let kind = kw === 'interface' ? 'interface' : kw === 'object' ? 'object' : mods.has('enum') ? 'enum' : 'class';
    if (kw === 'interface' && mods.has('fun')) kind = 'interface';
    let name = null;
    if (kind === 'object' && mods.has('companion')) { name = isIdent() ? ident() : 'Companion'; kind = 'companion'; }
    else name = ident('a class name');
    const tps = typeParams();
    let pc = null;
    modifiers();
    if (eat('constructor')) { /* class A private constructor(…) */ }
    if (is('(')) pc = params();
    const supers = [];
    if (eat(':')) {
      do {
        const st = type();
        let args = null;
        if (is('(')) args = callArgs();
        if (is('by')) { i++; expression(); }
        supers.push({ type: st, args });
      } while (eat(','));
    }
    while (is('where')) { while (!is('{') && i < toks.length && !peek().nl) i++; }
    const d = { k: 'class', kind, name, mods, tps, pc, supers, members: [], entries: [], line: l };
    if (is('{') && !(peek().nl && kind === 'class' && false)) {
      i++;
      inBlock(() => {
        if (kind === 'enum') {                         // RED, GREEN(2), BLUE { override … };
          while (!is(';') && !is('}')) {
            skipAnnotations();
            const el = line(), en = ident('an enum entry');
            const args = is('(') ? callArgs() : [];
            let body = null;
            if (is('{')) { const sub = { k: 'class', kind: 'class', name: en, mods: new Set(), tps: [], pc: null, supers: [], members: [], entries: [], line: el }; i++; while (!eat('}')) { const ml = line(); sub.members.push(memberDecl(ml)); } body = sub; }
            d.entries.push({ name: en, args, body, line: el });
            if (!eat(',')) break;
          }
          eat(';');
        }
        while (!eat('}')) {
          if (i >= toks.length) fail(lastLine, "expecting '}'.");
          if (eat(';')) continue;
          d.members.push(memberDecl(line()));
        }
      });
    }
    return d;
  }
  function memberDecl(l) {
    const mods = modifiers();
    const m = decl(mods, l, true);
    endOfStatement();
    return m;
  }

  /* ---- statements ---- */
  function block() {
    const l = line();
    expect('{');
    return inBlock(() => {
      const items = [];
      for (;;) {
        while (eat(';'));
        if (eat('}')) break;
        if (i >= toks.length) fail(lastLine, "expecting '}'.");
        items.push(statement());
        endOfStatement();
      }
      return { k: 'block', items, line: l };
    });
  }
  function statement() {
    const l = line();
    skipAnnotations();
    // a label: loop@ for (…)
    if (isIdent() && is('@', 1) && !toks[i + 1].nl && toks[i + 1].pos === toks[i].end) {
      const label = ident(); i++;
      const s = statement();
      s.label = label;
      return s;
    }
    const save = i;
    const mods = modifiers();
    if (isDeclStart() && !(is('object') && is(':', 1))) {
      if (is('class') || is('interface') || is('object')) return classDecl(mods, l);
      if (is('fun') && !is('(', 1)) return node('localFun', l, { fn: funDecl(mods, l) });
      if (is('val') || is('var')) { const p = propDecl(mods, l, false); return p.k === 'destructure' ? p : node('local', l, { p }); }
    }
    i = save;
    if (is('for')) return forStmt(l);
    if (is('while')) { i++; expect('('); const cond = inParens(expression); expect(')'); return node('while', l, { cond, body: loopBody() }); }
    if (is('do')) {
      i++;
      const body = is('{') ? block() : statement();
      if (!eat('while')) fail(line(), "expecting 'while'.");
      expect('('); const cond = inParens(expression); expect(')');
      return node('do', l, { cond, body });
    }
    const e = expression();
    const t = peek();
    if (t && t.t === 'p' && ['=', '+=', '-=', '*=', '/=', '%='].includes(t.v) && !(t.nl && nlOff === 0)) {
      i++;
      if (!['name', 'member', 'index', 'this'].includes(e.k)) fail(l, 'variable expected.');
      return node('assign', l, { op: t.v, l: e, r: expression() });
    }
    return node('expr', l, { e });
  }
  const loopBody = () => (is('{') ? block() : (atNl() ? fail(line(), 'expecting a statement.') : { k: 'block', items: [statement()], line: line() }));
  function forStmt(l) {
    i++;
    expect('(');
    const head = inParens(() => {
      let names = null, name = null, t = null;
      if (is('(')) names = destructNames();
      else { name = ident('a loop variable'); if (eat(':')) t = type(); }
      expect('in');
      const iter = expression();
      return { names, name, type: t, iter };
    });
    expect(')');
    return node('for', l, { ...head, body: loopBody() });
  }

  /* ---- expressions ---- */
  function expression() { return disjunction(); }
  const binLoop = (sub, ops, kind = 'bin', crossNl = false) => () => {
    let e = sub();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'p' || !ops.includes(t.v)) return e;
      if (t.nl && nlOff === 0 && !crossNl) return e;
      i++;
      e = node(kind, t.line, { op: t.v, l: e, r: sub() });
    }
  };
  function disjunction() { return binLoop(conjunction, ['||'], 'logic', true)(); }
  function conjunction() { return binLoop(equality, ['&&'], 'logic', true)(); }
  function equality() { return binLoop(comparison, ['==', '!=', '===', '!=='])(); }
  function comparison() {
    let e = namedCheck();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'p' || !['<', '>', '<=', '>='].includes(t.v) || (t.nl && nlOff === 0)) return e;
      i++;
      e = node('bin', t.line, { op: t.v, l: e, r: namedCheck() });
    }
  }
  /** in, !in, is, !is */
  function namedCheck() {
    let e = elvis();
    for (;;) {
      const t = peek(), l = line();
      if (!t || (t.nl && nlOff === 0)) return e;
      if (is('in')) { i++; e = node('in', l, { e, r: elvis(), neg: false }); continue; }
      if (is('!') && is('in', 1) && toks[i + 1].pos === t.end) { i += 2; e = node('in', l, { e, r: elvis(), neg: true }); continue; }
      if (is('is')) { i++; e = node('is', l, { e, type: type(), neg: false }); continue; }
      if (is('!') && is('is', 1) && toks[i + 1].pos === t.end) { i += 2; e = node('is', l, { e, type: type(), neg: true }); continue; }
      return e;
    }
  }
  function elvis() {
    let e = infixCall();
    while (is('?:')) { const l = line(); i++; e = node('elvis', l, { a: e, b: infixCall() }); }
    return e;
  }
  /** a infix b: to, until, downTo, step, shl, and, or… and the program's own infix functions */
  function infixCall() {
    let e = range();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'id' || HARD.has(t.v) || (t.nl && nlOff === 0) || t.quoted) return e;
      if (['else', 'get', 'set', 'by', 'where', 'catch', 'finally'].includes(t.v)) return e;
      const n = peek(1);
      if (!n || (n.nl && nlOff === 0) || (n.t === 'p' && [')', ']', '}', ',', ';', '=', '->', '.', ':'].includes(n.v))) return e;
      i++;
      e = node('infix', t.line, { name: t.v, l: e, r: range() });
    }
  }
  function range() { return binLoop(additive, ['..', '..<'])(); }
  function additive() { return binLoop(multiplicative, ['+', '-'])(); }
  function multiplicative() { return binLoop(asExpr, ['*', '/', '%'])(); }
  function asExpr() {
    let e = prefix();
    for (;;) {
      if (is('as') && !(peek().nl && nlOff === 0)) {
        const l = line(); i++;
        const safe = eat('?');
        e = node('as', l, { e, type: type(), safe });
        continue;
      }
      return e;
    }
  }
  function prefix() {
    const t = peek(), l = line();
    if (t && t.t === 'p') {
      if (['-', '+', '!'].includes(t.v)) { i++; if (t.v === '-' && peek() && peek().t === 'num' && peek().pos === t.end) return postfix(number(next(), true)); return node('un', l, { op: t.v, e: prefix() }); }
      if (t.v === '++' || t.v === '--') { i++; return node('incdec', l, { op: t.v, prefix: true, e: prefix() }); }
    }
    if (isIdent() && is('@', 1) && toks[i + 1].pos === t.end && (is('{', 2) || is('for', 2) || is('while', 2) || is('do', 2))) {   // a labeled lambda or loop
      const label = ident(); i++;
      const e = prefix();
      e.label = label;
      return e;
    }
    return postfix(primary());
  }
  function postfix(e) {
    for (;;) {
      const t = peek(), l = line();
      if (!t) return e;
      const sameLine = !(t.nl && nlOff === 0);
      if (is('.') || is('?.')) {                      // may start the next line
        const safe = next().v === '?.';
        if (is('(') || is('{')) fail(l, 'expecting a name after the dot.');
        const n = ident('a member name');
        const targs = is('<') ? typeArgsOpt() : null;
        e = node('member', l, { e, n, safe, targs });
        continue;
      }
      if (!sameLine) return e;
      if (is('(')) { const args = callArgs(); e = node('call', l, { f: e, args }); if (is('{') && !peek().nl) e.args.push({ e: lambdaLit(), trailing: true }); continue; }
      if (isIdent() && is('@', 1) && is('{', 2) && toks[i + 1].pos === toks[i].end && (e.k === 'name' || e.k === 'member' || e.k === 'call')) {   // xs.forEach label@{ … }
        const label = ident(); i++;
        const lam = lambdaLit(); lam.label = label;
        e = e.k === 'call' ? (e.args.push({ e: lam, trailing: true }), e) : node('call', l, { f: e, args: [{ e: lam, trailing: true }] });
        continue;
      }
      if (is('{') && (e.k === 'name' || e.k === 'member' || e.k === 'call')) { e = e.k === 'call' ? (e.args.push({ e: lambdaLit(), trailing: true }), e) : node('call', l, { f: e, args: [{ e: lambdaLit(), trailing: true }] }); continue; }
      if (is('[')) { i++; const args = inParens(() => { const a = []; do a.push(expression()); while (eat(',')); return a; }); expect(']'); e = node('index', l, { e, args }); continue; }
      if (is('!!')) { i++; e = node('notnull', l, { e }); continue; }
      if (is('++') || is('--')) { e = node('incdec', l, { op: next().v, prefix: false, e }); continue; }
      if (is('::')) { i++; const n = is('class') ? (i++, 'class') : ident(); e = node('funRef', l, { recv: e, name: n }); continue; }
      return e;
    }
  }
  /** (a, b = 1, *xs) */
  function callArgs() {
    expect('(');
    return inParens(() => {
      const args = [];
      while (!eat(')')) {
        const l = line();
        let name = null, spread = false;
        if (isIdent() && is('=', 1) && !is('==', 1)) { name = ident(); i++; }
        if (eat('*')) spread = true;
        args.push({ e: expression(), name, spread, line: l });
        if (!eat(',')) { expect(')'); break; }
      }
      return args;
    });
  }
  /** { a, b -> … }, { (k, v) -> … }, { … } (it) */
  function lambdaLit() {
    const l = line();
    expect('{');
    return inBlock(() => {
      const ps = attempt(() => {
        const out = [];
        if (is('->')) { i++; return out; }
        do {
          if (is('(')) { out.push({ names: destructNames() }); continue; }
          const n = is('_') ? (i++, '_') : ident();
          let t = null;
          if (eat(':')) t = type();
          out.push({ name: n, type: t });
        } while (eat(','));
        if (!eat('->')) return null;
        return out;
      });
      const items = [];
      for (;;) {
        while (eat(';'));
        if (eat('}')) break;
        if (i >= toks.length) fail(lastLine, "expecting '}'.");
        items.push(statement());
        endOfStatement();
      }
      return node('lambda', l, { params: ps, body: { k: 'block', items, line: l } });
    });
  }
  function primary() {
    const t = peek(), l = line();
    if (!t) fail(lastLine, 'expecting an expression.');
    if (t.t === 'num') return number(next());
    if (t.t === 'str') { i++; return t.v.length === 1 ? node('lit', l, { v: t.v[0], kind: 'string' }) : node('tmpl', l, { parts: t.v.map(p => (typeof p === 'string' ? p : parseKotlin(p.src, p.line, true))) }); }
    if (t.t === 'chr') { i++; return node('lit', l, { v: t.v, kind: 'char' }); }
    if (is('(')) { i++; const e = inParens(expression); expect(')'); return node('paren', l, { e }); }
    if (is('{')) return lambdaLit();
    if (is('::')) { i++; const n = ident(); return node('funRef', l, { recv: null, name: n }); }
    if (is('[')) fail(l, 'collection literals ([1, 2]) are only allowed in annotations: use listOf(1, 2).');
    if (t.t === 'id' && !t.quoted) {
      switch (t.v) {
        case 'true': case 'false': i++; return node('lit', l, { v: t.v === 'true', kind: 'bool' });
        case 'null': i++; return node('lit', l, { v: null, kind: 'null' });
        case 'this': i++; if (is('@') && !peek().nl) { i++; ident(); } return node('this', l, {});
        case 'super': i++; if (is('<')) { i++; type(); closeAngle(); } return node('super', l, {});
        case 'if': return ifExpr();
        case 'when': return whenExpr();
        case 'try': return tryExpr();
        case 'throw': i++; return node('throw', l, { e: expression() });
        case 'return': {
          i++;
          let label = null;
          if (is('@') && !peek().nl) { i++; label = ident(); }
          const n = peek();
          const e = !n || (n.nl && nlOff === 0) || is('}') || is(')') || is(';') ? null : expression();
          return node('return', l, { e, label });
        }
        case 'break': case 'continue': { i++; let label = null; if (is('@') && !peek().nl) { i++; label = ident(); } return node(t.v, l, { label }); }
        case 'object': {                               // object : Comparator<Int> { … }
          i++;
          const supers = [];
          if (eat(':')) do { const st = type(); let args = null; if (is('(')) args = callArgs(); supers.push({ type: st, args }); } while (eat(','));
          const d = { k: 'class', kind: 'anon', name: 'object', mods: new Set(), tps: [], pc: null, supers, members: [], entries: [], line: l };
          expect('{');
          inBlock(() => { while (!eat('}')) { if (eat(';')) continue; d.members.push(memberDecl(line())); } });
          return node('objectExpr', l, { decl: d });
        }
      }
      if (HARD.has(t.v)) fail(l, `expecting an expression, not '${t.v}'.`);
    }
    if (t.t === 'id') {
      i++;
      const targs = is('<') ? typeArgsOpt() : null;
      return node('name', l, { n: t.v, targs });
    }
    fail(l, `expecting an expression, not ${show(t)}.`);
  }
  /** a branch of if / when: a block, or one expression */
  const branch = () => (is('{') ? block() : (() => { const l = line(); const s = statement(); return { k: 'block', items: [s], line: l, single: true }; })());
  function ifExpr() {
    const l = line(); i++;
    expect('(');
    const cond = inParens(expression);
    expect(')');
    const a = is('else') ? { k: 'block', items: [], line: l } : branch();
    let b = null;
    const save = i;
    while (eat(';'));
    if (is('else')) { i++; b = branch(); } else i = save;
    return node('if', l, { cond, a, b });
  }
  function whenExpr() {
    const l = line(); i++;
    let subject = null, bind = null;
    if (is('(')) {
      i++;
      inParens(() => {
        if (is('val')) { i++; bind = ident(); if (eat(':')) type(); expect('='); }
        subject = expression();
      });
      expect(')');
    }
    expect('{');
    const branches = inBlock(() => {
      const out = [];
      while (!eat('}')) {
        if (eat(';')) continue;
        const bl = line();
        let conds = null;
        if (eat('else')) conds = null;
        else {
          conds = [];
          do {
            const cl = line();
            if (is('in')) { i++; conds.push({ k: 'in', e: expression(), neg: false, line: cl }); }
            else if (is('!') && is('in', 1)) { i += 2; conds.push({ k: 'in', e: expression(), neg: true, line: cl }); }
            else if (is('is')) { i++; conds.push({ k: 'is', type: type(), neg: false, line: cl }); }
            else if (is('!') && is('is', 1)) { i += 2; conds.push({ k: 'is', type: type(), neg: true, line: cl }); }
            else conds.push({ k: 'expr', e: expression(), line: cl });
          } while (eat(','));
        }
        expect('->', 'in when');
        const body = branch();
        out.push({ conds, body, line: bl });
        endOfStatement();
      }
      return out;
    });
    return node('when', l, { subject, bind, branches });
  }
  function tryExpr() {
    const l = line(); i++;
    const body = block();
    const catches = [];
    let fin = null;
    for (;;) {
      if (is('catch')) {
        const cl = line(); i++;
        expect('(');
        const name = ident(); expect(':'); const t = type();
        expect(')');
        catches.push({ name, type: t, body: block(), line: cl });
        continue;
      }
      if (is('finally')) { i++; fin = block(); continue; }
      break;
    }
    if (!catches.length && !fin) fail(l, "expecting 'catch' or 'finally'.");
    return node('try', l, { body, catches, fin });
  }
  function number(t, neg = false) {
    let raw = t.v.replace(/_/g, '');
    const l = t.line;
    if (/^0[xXbB]/.test(raw)) {
      const long = /[lL]$/.test(raw);
      if (long) raw = raw.slice(0, -1);
      let v = BigInt(raw);
      if (neg) v = -v;
      return node('lit', l, { v, kind: long || v > 2147483647n || v < -2147483648n ? 'long' : 'int' });
    }
    if (/[lL]$/.test(raw)) { let v = BigInt(raw.slice(0, -1)); if (neg) v = -v; return node('lit', l, { v, kind: 'long' }); }
    if (/[fF]$/.test(raw)) return node('lit', l, { v: (neg ? -1 : 1) * parseFloat(raw.slice(0, -1)), kind: 'float' });
    if (/[.eE]/.test(raw)) return node('lit', l, { v: (neg ? -1 : 1) * parseFloat(raw), kind: 'double' });
    let v = BigInt(raw);
    if (neg) v = -v;
    if (v > 9223372036854775807n || v < -9223372036854775808n) fail(l, 'the value is out of range.');
    return node('lit', l, { v, kind: v > 2147483647n || v < -2147483648n ? 'long' : 'int' });
  }

  /* ---- the file ---- */
  if (exprOnly) {
    const e = expression();
    if (i < toks.length) fail(toks[i].line, `expecting '}' after the template expression, not ${show(toks[i])}.`);
    return e;
  }
  const imports = [], decls = [];
  while (eat(';'));
  if (is('package')) { i++; ident(); while (eat('.')) ident(); endOfStatement(''); }
  while (is('import')) {
    const l = line(); i++;
    let n = ident();
    while (eat('.')) { if (eat('*')) { n += '.*'; break; } n += '.' + ident(); }
    if (is('as')) { i++; ident(); }
    imports.push({ n, line: l });
    endOfStatement('');
  }
  while (i < toks.length) {
    while (eat(';'));
    if (i >= toks.length) break;
    const l = line();
    const mods = modifiers();
    if (!isDeclStart()) fail(l, `expecting a top level declaration (statements go in fun main), not ${show(peek())}.`);
    decls.push(decl(mods, l, false));
    endOfStatement('');
  }
  return { imports, decls };
}
