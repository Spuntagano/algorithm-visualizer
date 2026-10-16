/**
 * Highlighting for C, C++, Java, Kotlin, C# and Go, as a CodeMirror stream parser: keywords and types (in the keyword colour), numbers, strings and
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

/** The rest of a Go raw string (`…`, which may span lines) on this line. */
function inRaw(stream, state) {
  const end = state.rawEnd || '`';
  if (stream.skipTo(end)) { stream.match(end); state.raw = false; state.rawEnd = null; } else stream.skipToEnd();
  return 'string';
}

/** A C-like mode: the same tokens, each language its own keywords (Go: `raw strings` too) */
function makeMode(name, keywords, atoms, types = TYPES) {
  return {
  name,
  startState: () => ({ comment: false, raw: false }),
  token(stream, state) {
    if (state.comment) return inComment(stream, state);
    if (state.raw) return inRaw(stream, state);
    if (name === 'go' && stream.eat('`')) { state.raw = true; return inRaw(stream, state); }
    if (name === 'kotlin' && stream.match('"""')) { state.raw = true; state.rawEnd = '"""'; return inRaw(stream, state); }
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
      return keywords.has(w) || types.has(w) ? 'keyword' : atoms.has(w) ? 'atom' : stream.match(/^\s*\(/, false) ? 'variableName.function' : 'variableName';
    }
    if (/[+\-*/%=<>!&|^~?:]/.test(ch)) { stream.eatWhile(/[+\-*/%=<>!&|^~?:]/); return 'operator'; }
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
  };
}
export const cMode = makeMode('c', KEYWORDS, ATOMS);
export const cppMode = makeMode('cpp', new Set([...KEYWORDS, ...CPP_WORDS]), new Set([...ATOMS, ...CPP_ATOMS]));
/** Java: the same kind of tokens; its keywords and types (String and the like stay plain names) */
const JAVA_WORDS = ['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'try',
  'void', 'volatile', 'while', 'var', 'record', 'yield', 'sealed', 'permits'];
export const javaMode = makeMode('java', new Set(JAVA_WORDS), new Set(['true', 'false', 'null']));
/** Go: its keywords and built-in types; true, false, nil and iota are atoms */
const GO_WORDS = ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if',
  'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'];
const GO_TYPES = new Set(['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'float32', 'float64',
  'complex64', 'complex128', 'byte', 'rune', 'string', 'bool', 'error', 'any']);
export const goMode = makeMode('go', new Set(GO_WORDS), new Set(['true', 'false', 'nil', 'iota']), GO_TYPES);
/** C#: its keywords (string, int… among them); true, false and null are atoms */
const CS_WORDS = ['abstract', 'as', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue', 'default', 'delegate', 'do', 'else',
  'enum', 'event', 'explicit', 'extern', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'interface', 'internal', 'is', 'lock',
  'namespace', 'new', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sealed', 'sizeof',
  'stackalloc', 'static', 'struct', 'switch', 'this', 'throw', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual', 'volatile', 'while',
  'var', 'record', 'get', 'set', 'init', 'when', 'and', 'or', 'not', 'with', 'yield', 'nameof', 'async', 'await'];
const CS_TYPES = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'object',
  'string', 'void', 'dynamic', 'nint', 'nuint']);
export const csMode = makeMode('csharp', new Set(CS_WORDS), new Set(['true', 'false', 'null']), CS_TYPES);
/** Kotlin: its keywords (val, fun, when…) and basic types; true, false and null are atoms; """raw strings""" go on over lines */
const KT_WORDS = ['as', 'break', 'class', 'continue', 'do', 'else', 'for', 'fun', 'if', 'in', 'interface', 'is', 'object', 'package', 'return', 'super',
  'this', 'throw', 'try', 'typealias', 'val', 'var', 'when', 'while', 'by', 'catch', 'constructor', 'finally', 'get', 'import', 'init', 'set', 'where',
  'abstract', 'companion', 'const', 'data', 'enum', 'infix', 'inline', 'inner', 'internal', 'lateinit', 'open', 'operator', 'override', 'private',
  'protected', 'public', 'sealed', 'vararg'];
const KT_TYPES = new Set(['Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'String', 'Unit', 'Any', 'Short', 'Byte', 'Nothing']);
export const ktMode = makeMode('kotlin', new Set(KT_WORDS), new Set(['true', 'false', 'null']), KT_TYPES);
