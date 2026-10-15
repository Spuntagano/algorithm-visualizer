/**
 * Highlighting for PHP, as a CodeMirror stream parser: keywords, $variables, numbers, strings (also heredocs),
 * comments and the <?php ?> tags; text outside the tags is left plain. (@codemirror/lang-php would bring the whole
 * HTML language with it.)
 */
const KEYWORDS = new Set(['abstract', 'and', 'as', 'break', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default',
  'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum', 'extends', 'final',
  'finally', 'fn', 'for', 'foreach', 'function', 'global', 'if', 'implements', 'include', 'include_once', 'instanceof', 'insteadof',
  'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public', 'readonly', 'require',
  'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'xor', 'yield', 'exit', 'die',
  'array', 'int', 'float', 'string', 'bool', 'void', 'mixed', 'never', 'iterable', 'callable', 'object', 'self', 'parent']);
const ATOMS = new Set(['true', 'false', 'null', 'TRUE', 'FALSE', 'NULL']);

/** The rest of a block comment or heredoc on this line (either may go on to the next ones) */
function inComment(stream, state) {
  if (stream.skipTo('*/')) { stream.next(); stream.next(); state.comment = false; } else stream.skipToEnd();
  return 'comment';
}
function inHeredoc(stream, state) {
  if (stream.sol() && stream.match(new RegExp('^\\s*' + state.heredoc + '\\b'))) { state.heredoc = null; return 'string'; }
  stream.skipToEnd();
  return 'string';
}

export const phpMode = {
  name: 'php',
  startState: () => ({ php: false, comment: false, heredoc: null }),
  token(stream, state) {
    if (!state.php) {                                // outside <?php … ?>: plain text
      if (stream.match(/^<\?(php\b|=)?/i)) { state.php = true; return 'keyword'; }
      if (!stream.skipTo('<?')) stream.skipToEnd();
      return null;
    }
    if (state.comment) return inComment(stream, state);
    if (state.heredoc) return inHeredoc(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match('?>')) { state.php = false; return 'keyword'; }
    if (stream.match('//') || (stream.peek() === '#' && !stream.match('#[', false))) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.comment = true; return inComment(stream, state); }
    const doc = stream.match(/^<<<\s*["']?(\w+)["']?/);
    if (doc) { state.heredoc = doc[1]; return 'string'; }
    const ch = stream.next();
    if (ch === '"' || ch === "'" || ch === '`') {
      let esc = false, c;
      while ((c = stream.next()) != null) { if (c === ch && !esc) break; esc = !esc && c === '\\'; }
      return 'string';
    }
    if (ch === '$' && stream.eatWhile(/\w/)) return 'variableName';
    if (/\d/.test(ch)) { stream.match(/^[\w.]*([eE][+-]?\d+)?/); return 'number'; }
    if (/[A-Za-z_\\]/.test(ch)) {
      stream.eatWhile(/[\w\\]/);
      const w = stream.current();
      return KEYWORDS.has(w.toLowerCase()) ? 'keyword' : ATOMS.has(w) ? 'atom' : 'variableName';
    }
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
};
