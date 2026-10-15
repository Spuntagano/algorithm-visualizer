/**
 * Highlighting for C and C++, as a CodeMirror stream parser: keywords and types (in the keyword colour), numbers, strings and
 * characters, comments and preprocessor lines. (The legacy "clike" mode does the same, but brings every C-like
 * language with it: about 22 KB.)
 */
const KEYWORDS = new Set(['break', 'case', 'continue', 'default', 'do', 'else', 'for', 'goto', 'if', 'return', 'sizeof', 'switch', 'while',
  'typedef', 'static', 'extern', 'const', 'volatile', 'register', 'inline', 'restrict', 'auto', 'struct', 'union', 'enum']);
const TYPES = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'bool', 'size_t', 'FILE',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t', 'ptrdiff_t', 'ssize_t']);
const ATOMS = new Set(['NULL', 'true', 'false', 'EOF', 'stdin', 'stdout', 'stderr']);
const CPP_WORDS = ['class', 'public', 'private', 'protected', 'new', 'delete', 'this', 'namespace', 'using', 'template', 'typename', 'operator',
  'virtual', 'override', 'friend', 'explicit', 'constexpr', 'mutable', 'try', 'catch', 'throw', 'noexcept', 'static_cast', 'const_cast',
  'reinterpret_cast', 'dynamic_cast', 'auto', 'bool'];
const CPP_ATOMS = ['nullptr', 'true', 'false', 'cout', 'cin', 'cerr', 'endl'];

/** The rest of a block comment on this line (it may go on to the next ones). */
function inComment(stream, state) {
  if (stream.skipTo('*/')) { stream.next(); stream.next(); state.comment = false; } else stream.skipToEnd();
  return 'comment';
}

/** A C or C++ mode: the same tokens, C++ adds its keywords */
function makeMode(name, keywords, atoms) {
  return {
  name,
  startState: () => ({ comment: false }),
  token(stream, state) {
    if (state.comment) return inComment(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.sol() && stream.peek() === '#') { stream.skipToEnd(); return 'keyword'; }   // #include, #define…
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.comment = true; return inComment(stream, state); }
    const ch = stream.next();
    if (ch === '"' || ch === "'") {
      let esc = false, c;
      while ((c = stream.next()) != null) { if (c === ch && !esc) break; esc = !esc && c === '\\'; }
      return 'string';
    }
    if (/\d/.test(ch) || (ch === '.' && stream.match(/^\d/, false))) { stream.match(/^[\w.]*([eEpP][+-]?\d+)?[\w]*/); return 'number'; }
    if (/[A-Za-z_]/.test(ch)) {
      stream.eatWhile(/\w/);
      const w = stream.current();
      return keywords.has(w) || TYPES.has(w) ? 'keyword' : atoms.has(w) ? 'atom' : stream.match(/^\s*\(/, false) ? 'variableName.function' : 'variableName';
    }
    if (/[+\-*/%=<>!&|^~?:]/.test(ch)) { stream.eatWhile(/[+\-*/%=<>!&|^~?:]/); return 'operator'; }
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
  };
}
export const cMode = makeMode('c', KEYWORDS, ATOMS);
export const cppMode = makeMode('cpp', new Set([...KEYWORDS, ...CPP_WORDS]), new Set([...ATOMS, ...CPP_ATOMS]));
