<?php
/*
 * The PHP tracer. PHP has no hook that can see a function's local variables (ticks run in their own scope, and Xdebug
 * is not part of the WebAssembly build), so the program is rewritten first, like the JavaScript tracer does: a call
 * __at_t(line, get_defined_vars(), $this) goes in before every statement, on the statement's own line, so line numbers
 * and error messages stay those of the code as written. Then the rewritten program runs with eval() at the top level,
 * and every call records a snapshot in the format of src/model.js. The worker (src/engine/worker.js) puts the program
 * in place of __AT_CODE__ (base64) and reads the JSON after the \x01 marker in the output.
 * The WebAssembly PHP never runs shutdown functions and exit() ends everything at once, so the limits throw __AT_Stop,
 * and the program's own exit / die is rewritten to throw __AT_Exit.
 */

/** Ends a run that went over a limit. An Error (not an Exception), so catch (Exception $e) cannot swallow it. */
final class __AT_Stop extends Error {}
/** The program called exit() or die(). */
final class __AT_Exit extends Error { public $status; }

final class __AT
{
    const MAX_STEPS = 3000;  // stop runaway loops
    const MAX_CALLS = 300;   // stop runaway recursion
    const MAX_DEPTH = 5;     // how deeply nested values are expanded
    const MAX_ITEMS = 60;    // list / set elements kept per container
    const MAX_KEYS = 30;     // array / object entries kept per container
    const SUPER = ['GLOBALS', '_GET', '_POST', '_COOKIE', '_FILES', '_SERVER', '_ENV', '_REQUEST', '_SESSION', 'argv', 'argc', 'http_response_header'];

    static array $steps = [];
    static array $logs = [];
    static string $line = '';          // printed text not yet ended by a newline
    static ?string $stopped = null;    // why the run was cut short (step / call limit)
    static ?array $error = null;
    static bool $done = false;
    static array $ids = [];
    static array $fnInfo = [];
    static int $busy = 0;

    /* ---- the rewrite ---- */
    private array $t;
    private int $i = 0;
    private string $o = '';

    /** The program with a step before each statement, or ['syntax' => message] */
    static function rewrite(string $src)
    {
        if (!preg_match('/<\?(php\b|=)/i', $src)) $src = '<?php ' . $src;   // the opening tag is optional here
        try { $toks = token_get_all($src, TOKEN_PARSE); }
        catch (ParseError $e) { return ['syntax' => 'line ' . $e->getLine() . ': ' . $e->getMessage()]; }
        $w = new __AT();
        $w->t = array_map(fn($x) => is_array($x) ? $x : [$x, $x, 0], $toks);
        $line = 1;
        foreach ($w->t as &$x) { if ($x[2]) $line = $x[2]; else $x[2] = $line; $line += substr_count($x[1], "\n"); }
        unset($x);
        // eval() starts in PHP mode: drop the opening tag (keeping its line break), so declare(strict_types=1) stays first
        $prefix = '?>';
        if ($w->t[0][0] === T_OPEN_TAG) { $w->o = str_repeat("\n", substr_count($w->t[0][1], "\n")) . ' '; $w->i = 1; $prefix = ''; }
        $w->statements(null);
        return $prefix . $w->o;
    }

    private function id(int $k = 0) { return $this->t[$this->i + $k][0] ?? null; }
    private function take(): void { $this->o .= $this->t[$this->i++][1]; }
    private function space(): void
    {
        while (in_array($this->id(), [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) $this->take();
    }
    /** The id of the next token that is not space or a comment */
    private function ahead(): mixed
    {
        for ($k = $this->i; isset($this->t[$k]); $k++) if (!in_array($this->t[$k][0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) return $this->t[$k][0];
        return null;
    }
    /** Copies a balanced ( … ) group (or [ … ]), rewriting the closures inside it */
    private function group(): void
    {
        $this->space();
        $depth = 0;
        do {
            $id = $this->id();
            if ($id === null) return;
            if ($id === '(' || $id === '[' || $id === '{' || $id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES || $id === T_ATTRIBUTE) $depth++;
            elseif ($id === ')' || $id === ']' || $id === '}') $depth--;
            if ($id === T_FUNCTION) { $this->closure(); continue; }
            if ($id === T_EXIT) { $this->exitCall(); continue; }
            $this->take();
        } while ($depth > 0);
    }
    /** function (…) use (…): type { body } inside an expression */
    private function closure(): void
    {
        while ($this->id() !== null && $this->id() !== '{') {
            if ($this->id() === '(') $this->group(); else $this->take();
        }
        $this->block();
    }
    /** exit / exit(…) / die(…) → __at_exit(…) */
    private function exitCall(): void
    {
        $this->i++;
        $this->o .= '__at_exit';
        if ($this->ahead() === '(') $this->group(); else $this->o .= '()';
    }
    private function trace(int $line = 0): void
    {
        $this->o .= '__at_t(' . ($line ?: $this->t[$this->i][2]) . ', get_defined_vars(), isset($this) ? $this : null);';
    }
    /** Statements up to the closing } (or one of the words that ends an alternative-syntax block) */
    private function statements(?array $end): void
    {
        for (;;) {
            $this->space();
            $id = $this->id();
            if ($id === null || $id === '}' || ($end && in_array($id, $end, true))) return;
            $this->statement();
        }
    }
    private function block(int $loop = 0): void
    {
        $this->space();
        if ($this->id() !== '{') return;
        $this->take();
        $this->statements(null);
        if ($loop) $this->trace($loop);
        if ($this->id() === '}') $this->take();
    }
    /**
     * The body of if / while / for…: a block, an alternative-syntax block, or one statement (given braces).
     * A loop's body ends with a step on the loop's own line ($loop), before the next test: so an empty loop is stopped too.
     */
    private function body(array $end, int $loop = 0): bool
    {
        $this->space();
        if ($this->id() === '{') { $this->block($loop); return false; }
        if ($this->id() === ':') { $this->take(); $this->statements($end); if ($loop) $this->trace($loop); return true; }
        $this->o .= '{';
        $this->statement();
        if ($loop) $this->trace($loop);
        $this->o .= '}';
        return false;
    }
    private function untilSemicolon(): void
    {
        $depth = 0; $prev = null;
        while (($id = $this->id()) !== null) {
            if ($depth === 0 && ($id === ';' || $id === T_CLOSE_TAG)) { $this->take(); return; }
            if ($id === T_FUNCTION) { $this->closure(); $prev = '}'; continue; }
            if ($id === T_EXIT) { $this->exitCall(); $prev = ')'; continue; }
            if ($id === T_CLASS && $prev === T_NEW) { $this->classDecl(); $prev = '}'; continue; }   // new class (…) { … }
            if ($id === '(' || $id === '[' || $id === '{' || $id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES || $id === T_ATTRIBUTE) $depth++;
            elseif ($id === ')' || $id === ']' || $id === '}') { if ($depth === 0) return; $depth--; }
            if (!in_array($id, [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) $prev = $id;
            $this->take();
        }
    }
    private function classDecl(): void
    {
        while ($this->id() !== null && $this->id() !== '{') { if ($this->id() === '(') $this->group(); else $this->take(); }
        if ($this->id() !== '{') return;
        $this->take();
        for (;;) {
            $this->space();
            $id = $this->id();
            if ($id === null) return;
            if ($id === '}') { $this->take(); return; }
            if ($id === T_FUNCTION) {                 // a method: its body gets steps
                while ($this->id() !== null && $this->id() !== '{' && $this->id() !== ';') { if ($this->id() === '(') $this->group(); else $this->take(); }
                if ($this->id() === ';') $this->take(); else $this->block();
                continue;
            }
            if ($id === T_ATTRIBUTE) { $this->group(); continue; }
            // a property, constant, enum case or trait use (modifiers may come before a method)
            $k = $this->i; $method = false;
            for (; isset($this->t[$k]) && !in_array($this->t[$k][0], [';', '{', '='], true); $k++) if ($this->t[$k][0] === T_FUNCTION) { $method = true; break; }
            if ($method) { while ($this->id() !== T_FUNCTION) $this->take(); continue; }
            $this->untilSemicolon();
        }
    }

    private function statement(): void
    {
        $this->space();
        $id = $this->id();
        switch ($id) {
            case null: return;
            case T_OPEN_TAG: case T_CLOSE_TAG: case T_INLINE_HTML: case ';': $this->take(); return;
            case T_OPEN_TAG_WITH_ECHO: $this->take(); $this->untilSemicolon(); return;
            case T_DECLARE: case T_NAMESPACE: case T_USE: $this->take(); $this->untilSemicolon(); return;
            case T_ATTRIBUTE: $this->group(); return;
            case T_FUNCTION:
                if (in_array($this->ahead2(), [T_STRING, '&'], true)) {   // a function declaration (not a closure)
                    while ($this->id() !== null && $this->id() !== '{') { if ($this->id() === '(') $this->group(); else $this->take(); }
                    $this->block();
                    return;
                }
                break;
            case T_ABSTRACT: case T_FINAL: case T_READONLY: case T_CLASS: case T_INTERFACE: case T_TRAIT: case T_ENUM:
                if ($id !== T_ENUM || $this->ahead2() === T_STRING) { $this->classDecl(); return; }
                break;
            case '{': $this->block(); return;
        }
        $this->trace();
        switch ($id) {
            case T_IF:
                $this->take(); $this->group();
                $alt = $this->body([T_ELSEIF, T_ELSE, T_ENDIF]);
                for (;;) {
                    $n = $this->ahead();
                    if ($n === T_ELSEIF) { $this->space(); $this->take(); $this->group(); $alt = $this->body([T_ELSEIF, T_ELSE, T_ENDIF]); continue; }
                    if ($n === T_ELSE) { $this->space(); $this->take(); $alt = $this->body([T_ENDIF]); continue; }
                    break;
                }
                if ($alt) { $this->space(); $this->take(); $this->untilSemicolon(); }
                return;
            case T_WHILE: case T_FOR: case T_FOREACH: case T_SWITCH:
                $line = $this->t[$this->i][2];
                $this->take(); $this->group();
                if ($id === T_SWITCH) { $this->switchBody(); return; }
                if ($this->body([[T_WHILE => T_ENDWHILE, T_FOR => T_ENDFOR, T_FOREACH => T_ENDFOREACH][$id]], $line)) { $this->space(); $this->take(); $this->untilSemicolon(); }
                return;
            case T_DO:
                $this->take();
                $k = $this->i; $depth = 0;                 // the line of its while (…), where the test is
                for (; isset($this->t[$k]); $k++) {
                    $x = $this->t[$k][0];
                    if ($x === '{') $depth++; elseif ($x === '}') $depth--;
                    elseif ($x === T_WHILE && $depth === 0) break;
                }
                $this->body([], $this->t[$k][2] ?? 0);
                $this->space(); $this->take(); $this->group(); $this->space();
                if ($this->id() === ';') $this->take();
                return;
            case T_TRY:
                $this->take(); $this->block();
                while (in_array($this->ahead(), [T_CATCH, T_FINALLY], true)) {
                    $this->space();
                    if ($this->id() === T_CATCH) { $this->take(); $this->group(); } else $this->take();
                    $this->block();
                }
                return;
        }
        $this->untilSemicolon();
    }
    private function ahead2(): mixed
    {
        $save = $this->i; $this->i++;
        $n = $this->ahead();
        if ($n === '&') { for ($k = $this->i; isset($this->t[$k]); $k++) if ($this->t[$k][0] === '&') { $this->i = $k + 1; break; } $n = $this->ahead() === T_STRING ? T_STRING : $n; }
        $this->i = $save;
        return $n;
    }
    private function switchBody(): void
    {
        $this->space();
        $alt = $this->id() === ':';
        $this->take();
        for (;;) {
            $this->space();
            $id = $this->id();
            if ($id === null) return;
            if ($id === '}' || $id === T_ENDSWITCH) { $this->take(); if ($alt) $this->untilSemicolon(); return; }
            if ($id === T_CASE || $id === T_DEFAULT) {          // the label, up to its : (or ;)
                $depth = 0;
                while (($x = $this->id()) !== null) {
                    if ($depth === 0 && ($x === ':' || $x === ';')) { $this->take(); break; }
                    if ($x === '(' || $x === '[') $depth++; elseif ($x === ')' || $x === ']') $depth--;
                    $this->take();
                }
                continue;
            }
            $this->statement();
        }
    }

    /* ---- running ---- */
    static function out(string $s): string
    {
        // a fatal error (Cannot redeclare…) is printed, then PHP stops at once: hand over the steps so far right here
        if (!self::$done && preg_match('/^\s*(?:PHP )?Fatal error: (.*) on line (\d+)\s*$/s', $s, $m)) {
            $msg = self::tidy($m[1]);
            self::$error = ['msg' => 'Fatal error: ' . $msg . (str_contains($msg, ' on line ') && !str_contains($msg, '(') ? '' : ' on line ' . $m[2])];
            self::$done = true;
            return "\x01" . self::result();
        }
        self::$line .= $s;
        while (($k = strpos(self::$line, "\n")) !== false) {
            self::$logs[] = ['type' => 'log', 's' => substr(self::$line, 0, $k)];
            self::$line = substr(self::$line, $k + 1);
        }
        return '';
    }
    /** A PHP message without the eval()'d code's file name: "… (previously declared in <file>:3) in <file>" → "… (previously declared on line 3)" */
    static function tidy(string $msg): string
    {
        $file = "[^\n]*?eval\\(\\)'d code";
        return trim(preg_replace(["/ in $file:(\\d+)/", "/ in $file\$/", "/,? called in $file on line (\\d+)/"], [' on line $1', '', ', called on line $1'], trim($msg)));
    }
    /** The first $n characters (this PHP has no mbstring) */
    static function clip(string $s, int $n): string
    {
        if (strlen($s) <= $n) return $s;
        return preg_match('/^.{' . $n . '}/su', $s, $m) ? (strlen($m[0]) < strlen($s) ? $m[0] . '…' : $s) : substr($s, 0, $n) . '…';
    }

    static function step(int $line, array $vars, $self): void
    {
        if (self::$busy) return;
        if (self::$stopped) throw new __AT_Stop(self::$stopped);   // keep stopping, even if the program caught it
        self::$busy++;
        try {
            if (count(self::$steps) >= self::MAX_STEPS) self::stop('Trace stopped after ' . self::MAX_STEPS . ' steps (possible infinite loop).');
            $stack = self::stack();
            if (count($stack) > self::MAX_CALLS) self::stop('Trace stopped: more than ' . self::MAX_CALLS . ' nested calls.');
            $inFn = count($stack) > 0;
            $named = [];
            foreach ($vars as $k => $v) if (self::shown($k, $v)) $named[] = ['$' . $k, $v, $inFn ? 'local' : 'global'];
            if ($self !== null) $named[] = ['$this', $self, 'local'];
            if ($inFn) foreach ($GLOBALS as $k => $v) if (self::shown($k, $v) && !array_key_exists($k, $vars)) $named[] = ['$' . $k, $v, 'global'];
            [$vs, $refs] = self::capture($named);
            self::$steps[] = ['line' => $line, 'stack' => $stack, 'vars' => $vs, 'refs' => $refs, 'logs' => count(self::$logs)];
        } finally { self::$busy--; }
    }
    static function stop(string $why): never
    {
        self::$stopped = $why;
        throw new __AT_Stop($why);
    }
    static function shown($k, $v): bool
    {
        return is_string($k) && !str_starts_with($k, '__at_') && !in_array($k, self::SUPER, true) && !($v instanceof Closure);
    }

    /** The program's own function calls, outermost first: name and arguments */
    static function stack(): array
    {
        $out = [];
        foreach (array_reverse(debug_backtrace(DEBUG_BACKTRACE_PROVIDE_OBJECT)) as $f) {
            $fn = $f['function'] ?? '';
            if ($fn === '__at_t' || str_starts_with($fn, '__at') || !isset($f['function']) || in_array($fn, ['eval', 'include', 'require', 'include_once', 'require_once'], true)) continue;
            $name = isset($f['class']) ? $f['class'] . ($f['type'] ?? '::') . $fn : $fn;
            if (str_starts_with($f['class'] ?? '', '__AT')) continue;
            $params = self::params($f);
            if ($params === null) continue;           // a function of PHP itself (array_map calling a closure…)
            $args = [];
            foreach (array_values($f['args'] ?? []) as $k => $a) $args[] = (isset($params[$k]) ? '$' . $params[$k] . '=' : '') . self::brief($a);
            $s = implode(', ', $args);
            $out[] = ['name' => str_contains($fn, '{closure') ? '{closure}' : $name, 'args' => self::clip($s, 70)];
        }
        return $out;
    }
    /** The parameter names of a user function, or null for PHP's own */
    static function params(array $f): ?array
    {
        $key = ($f['class'] ?? '') . '::' . $f['function'];
        if (array_key_exists($key, self::$fnInfo) && !str_contains($f['function'], '{closure')) return self::$fnInfo[$key];
        try {
            $r = isset($f['class']) ? new ReflectionMethod($f['class'], $f['function']) : (str_contains($f['function'], '{closure') ? null : new ReflectionFunction($f['function']));
            if ($r === null) return [];
            $p = $r->isInternal() ? null : array_map(fn($x) => $x->getName(), $r->getParameters());
        } catch (Throwable $e) { $p = []; }
        return self::$fnInfo[$key] = $p;
    }
    static function brief($v, int $d = 0): string
    {
        if (is_string($v)) return json_encode(self::clip($v, 14), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if (is_array($v)) {
            if ($d) return '[…]';
            $list = array_is_list($v);
            $parts = [];
            foreach (array_slice($v, 0, 4, true) as $k => $x) $parts[] = ($list ? '' : self::brief($k, 1) . ' => ') . self::brief($x, 1);
            return '[' . implode(', ', $parts) . (count($v) > 4 ? ', …' : '') . ']';
        }
        if (is_object($v)) return $v instanceof UnitEnum ? get_class($v) . '::' . $v->name : get_class($v) . '{…}';
        return self::scalar($v);
    }
    static function scalar($v): string
    {
        if ($v === null) return 'null';
        if (is_bool($v)) return $v ? 'true' : 'false';
        if (is_float($v)) return is_nan($v) ? 'NAN' : (is_infinite($v) ? ($v > 0 ? 'INF' : '-INF') : var_export($v, true));
        return (string)$v;
    }

    /* ---- values → snapshot nodes ---- */
    static function idOf(string $key): int { return self::$ids[$key] ??= count(self::$ids) + 1; }
    static function prim(string $k, string $s): array { return ['t' => 'p', 'k' => $k, 's' => $s]; }

    static function capture(array $named): array
    {
        $ctx = ['seen' => [], 'refs' => []];
        $vars = [];
        foreach ($named as [$n, $v, $scope]) $vars[] = ['name' => $n, 'scope' => $scope, 'node' => self::ser($v, $ctx, 0, $scope . ':' . $n)];
        $refs = array_keys($ctx['refs']);
        sort($refs);
        return [$vars, $refs];
    }
    /** $path names where an array sits (PHP arrays are values: they have no identity, so their id comes from their place) */
    static function ser($v, array &$ctx, int $depth, string $path): array
    {
        if ($v === null) return self::prim('null', 'null');
        if (is_bool($v)) return self::prim('bool', $v ? 'true' : 'false');
        if (is_int($v) || is_float($v)) return self::prim('num', self::scalar($v));
        if (is_string($v)) return self::prim('str', json_encode(self::clip($v, 80), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
        if (is_resource($v)) return self::prim('str', json_encode('resource'));
        if ($v instanceof Closure) return ['t' => 'fn', 's' => '{closure}'];
        if ($v instanceof UnitEnum) return self::prim('sym', get_class($v) . '::' . $v->name);
        $id = is_array($v) ? self::idOf('a:' . $path) : self::idOf('o:' . spl_object_id($v));
        if (isset($ctx['seen'][$id])) { $ctx['refs'][$id] = true; return ['t' => 'ref', 'id' => $id]; }
        $ctx['seen'][$id] = true;
        if ($depth >= self::MAX_DEPTH) return ['t' => 'trunc', 'id' => $id];
        $kid = function ($x, $k) use (&$ctx, $depth, $path) { return self::ser($x, $ctx, $depth + 1, $path . '/' . $k); };
        $list = function (array $items, string $cls) use ($id, $kid) {
            $n = min(count($items), self::MAX_ITEMS);
            $out = [];
            foreach (array_slice(array_values($items), 0, $n) as $k => $x) $out[] = $kid($x, $k);
            return ['t' => 'arr', 'id' => $id, 'len' => count($items), 'items' => $out, 'more' => count($items) - $n, 'cls' => $cls];
        };
        $keyed = function (array $a, string $cls, string $tn) use ($id, $kid, &$ctx, $depth, $path) {
            $pairs = array_slice($a, 0, self::MAX_KEYS, true);
            $more = count($a) - count($pairs);
            foreach (array_keys($a) as $k) if (!is_string($k)) {   // a number key: a map, like a JavaScript Map
                $e = [];
                foreach ($pairs as $k2 => $x) $e[] = [self::ser($k2, $ctx, $depth + 1, $path), $kid($x, $k2)];
                return ['t' => 'map', 'id' => $id, 'entries' => $e, 'more' => $more, 'cls' => $cls];
            }
            $e = [];
            foreach ($pairs as $k2 => $x) $e[] = [(string)$k2, $kid($x, $k2)];
            return ['t' => 'obj', 'id' => $id, 'cls' => '', 'tn' => $tn, 'entries' => $e, 'more' => $more];
        };
        if (is_array($v)) return array_is_list($v) ? $list($v, 'array') : $keyed($v, 'array', 'array');
        $cls = get_class($v);
        if ($v instanceof SplDoublyLinkedList) return $list($v->__serialize()[1], $cls);   // bottom to top, as pushed
        if ($v instanceof SplFixedArray) return $list($v->toArray(), $cls);
        if ($v instanceof SplHeap || $v instanceof SplPriorityQueue) { $c = clone $v; $items = []; foreach ($c as $x) $items[] = $x; return $list($items, $cls); }
        if ($v instanceof SplObjectStorage) {
            $items = []; foreach ($v as $x) $items[] = $x;
            $n = min(count($items), self::MAX_ITEMS);
            return ['t' => 'set', 'id' => $id, 'items' => array_map(fn($x) => $kid($x, 'k'), array_slice($items, 0, $n)), 'more' => count($items) - $n, 'cls' => $cls];
        }
        if ($v instanceof ArrayObject || $v instanceof ArrayIterator) { $a = $v->getArrayCopy(); return array_is_list($a) ? $list($a, $cls) : $keyed($a, $cls, $cls); }
        if ($v instanceof Throwable) return ['t' => 'obj', 'id' => $id, 'cls' => $cls, 'more' => 0,   // not its trace and the eval()'d file name
            'entries' => [['message', $kid($v->getMessage(), 'm')], ['code', $kid($v->getCode(), 'c')], ['line', $kid($v->getLine(), 'l')]]];
        $props = [];
        foreach ((array)$v as $k => $x) $props[preg_replace('/^\0.+\0/', '', (string)$k)] = $x;   // private and protected names come with a prefix
        $pairs = array_slice($props, 0, self::MAX_KEYS, true);
        $e = [];
        foreach ($pairs as $k => $x) $e[] = [(string)$k, $kid($x, $k)];
        return ['t' => 'obj', 'id' => $id, 'cls' => $cls, 'entries' => $e, 'more' => count($props) - count($pairs)];
    }

    /* ---- the end ---- */
    static function warn(int $no, string $msg, string $file, int $line): bool
    {
        if (!str_contains($file, 'eval()')) return false;
        $kind = in_array($no, [E_WARNING, E_USER_WARNING], true) ? 'Warning' : (in_array($no, [E_NOTICE, E_USER_NOTICE], true) ? 'Notice' : (in_array($no, [E_DEPRECATED, E_USER_DEPRECATED], true) ? 'Deprecated' : 'Error'));
        self::$logs[] = ['type' => 'warn', 's' => "$kind: $msg on line $line"];
        return true;
    }
    static function uncaught(Throwable $e): void
    {
        $line = $e->getLine();
        foreach ($e->getTrace() as $f) if (str_contains($f['file'] ?? '', 'eval()')) { $line = $f['line']; break; }
        if (str_contains($e->getFile(), 'eval()')) $line = $e->getLine();
        $msg = self::tidy($e->getMessage());
        self::$error = ['msg' => get_class($e) . ': ' . $msg . (str_contains($msg, ' on line ') ? '' : ' on line ' . $line)];
    }
    static function done(): void
    {
        if (self::$done) return;
        self::$done = true;
        while (ob_get_level()) ob_end_clean();
        if (self::$line !== '') { self::$logs[] = ['type' => 'log', 's' => self::$line]; self::$line = ''; }
        echo "\x01", self::result();
    }
    /** The recording as JSON, ending with a step for the end of the program (unless it failed) */
    static function result(): string
    {
        if (self::$stopped) self::$error = ['msg' => self::$stopped, 'soft' => true];
        if (!self::$error || !empty(self::$error['soft']) && !self::$stopped) {
            $named = [];
            foreach ($GLOBALS as $k => $v) if (self::shown($k, $v)) $named[] = ['$' . $k, $v, 'global'];
            [$vs, $refs] = self::capture($named);
            self::$steps[] = ['line' => -1, 'stack' => [], 'vars' => $vs, 'refs' => $refs, 'logs' => count(self::$logs)];
        }
        return json_encode(['steps' => self::$steps, 'logs' => self::$logs, 'error' => self::$error], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    }
}
function __at_t(int $line, array $vars, $self): void { __AT::step($line, $vars, $self); }
function __at_exit($status = 0): never
{
    if (is_string($status)) echo $status;
    $e = new __AT_Exit('exit');
    $e->status = is_int($status) ? $status : 0;
    throw $e;
}

$__at_src = __AT::rewrite(base64_decode('__AT_CODE__'));
if (is_array($__at_src)) {
    echo "\x01", json_encode($__at_src, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} else {
    ini_set('display_errors', '1');           // a fatal error is printed (and caught in __AT::out) before PHP stops
    ini_set('html_errors', '0');
    error_reporting(E_ALL);
    set_error_handler([__AT::class, 'warn']);
    ob_start([__AT::class, 'out'], 1);
    try { eval($__at_src); }
    catch (__AT_Stop $__at_e) { /* the limit's message is in __AT::$stopped */ }
    catch (__AT_Exit $__at_e) { if ($__at_e->status) __AT::$error = ['msg' => 'The program called exit(' . $__at_e->status . ').', 'soft' => true]; }
    catch (Throwable $__at_e) { __AT::uncaught($__at_e); }
    __AT::done();
}
