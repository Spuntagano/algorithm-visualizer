"""
The Python tracer: runs the user's program once under sys.settrace and records a snapshot before every
line, in the same format as the JavaScript tracer (see src/model.js), so every view works unchanged.
Runs inside Pyodide (src/engine/worker.js); trace_json(source) returns the recording as JSON text.
"""
import builtins
import collections
import json
import sys
import types

MAX_STEPS = 3000   # stop runaway loops
MAX_CALLS = 300    # stop runaway recursion
MAX_DEPTH = 5      # how deeply nested values are expanded
MAX_ITEMS = 60     # list / tuple / set elements kept per container
MAX_KEYS = 30      # dict / object entries kept per container
FILE = '<code>'


class StopRun(BaseException):
    """Ends a run early (step or call limit) without it counting as a program error. A BaseException, so the
    program's own `except Exception:` cannot swallow it."""


def _prim(k, s):
    return {'t': 'p', 'k': k, 's': s}


def _clip(s, n):
    return s if len(s) <= n else s[:n] + '…'


def brief(v, d=0):
    """Short one-line preview, for call-stack arguments."""
    if isinstance(v, str):
        return json.dumps(_clip(v, 14), ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        if d:
            return '[…]'
        inner = ', '.join(brief(x, 1) for x in list(v)[:6])
        return '[' + inner + (', …' if len(v) > 6 else '') + ']'
    if isinstance(v, dict):
        if d:
            return '{…}'
        items = list(v.items())[:3]
        return '{' + ', '.join(f'{brief(k, 1)}: {brief(x, 1)}' for k, x in items) + (', …' if len(v) > 3 else '') + '}'
    if callable(v):
        return 'ƒ'
    return _clip(repr(v), 20)


class Serializer:
    """Turns live values into snapshot nodes. Object ids are stable for the whole run (#3 is always the same object)."""

    def __init__(self):
        self.ids = {}
        self.keep = []          # keeps every numbered object alive, so Python never reuses its id()

    def id_of(self, v):
        k = id(v)
        if k not in self.ids:
            self.ids[k] = len(self.ids) + 1
            self.keep.append(v)
        return self.ids[k]

    def ser(self, v, ctx, depth):
        if v is None:
            return _prim('null', 'None')
        if isinstance(v, bool):
            return _prim('bool', 'True' if v else 'False')
        if isinstance(v, (int, float)):
            return _prim('num', repr(v))
        if isinstance(v, complex):
            return _prim('num', repr(v))
        if isinstance(v, str):
            return _prim('str', json.dumps(_clip(v, 80), ensure_ascii=False))
        if isinstance(v, (bytes, bytearray)):
            return _prim('str', json.dumps(_clip(repr(v), 80), ensure_ascii=False))
        if isinstance(v, (types.FunctionType, types.BuiltinFunctionType, types.MethodType, type, types.ModuleType)):
            return {'t': 'fn', 's': getattr(v, '__name__', 'function')}
        i = self.id_of(v)
        if i in ctx['seen']:
            ctx['refs'].add(i)
            return {'t': 'ref', 'id': i}
        ctx['seen'].add(i)
        if depth >= MAX_DEPTH:
            return {'t': 'trunc', 'id': i}
        kid = lambda x: self.ser(x, ctx, depth + 1)
        try:
            if isinstance(v, (list, tuple, collections.deque, range)):
                items = list(v)
                n = min(len(items), MAX_ITEMS)
                return {'t': 'arr', 'id': i, 'len': len(items), 'items': [kid(x) for x in items[:n]],
                        'more': len(items) - n, 'cls': type(v).__name__}
            if isinstance(v, (set, frozenset)):
                items = list(v)
                n = min(len(items), MAX_ITEMS)
                return {'t': 'set', 'id': i, 'items': [kid(x) for x in items[:n]], 'more': len(items) - n, 'cls': type(v).__name__}
            if isinstance(v, dict):
                items = list(v.items())
                n = min(len(items), MAX_KEYS)
                if all(isinstance(k, str) for k, _ in items):          # like a JavaScript object: keys are names
                    return {'t': 'obj', 'id': i, 'cls': '', 'entries': [[k, kid(x)] for k, x in items[:n]],
                            'more': len(items) - n, 'tn': type(v).__name__}
                return {'t': 'map', 'id': i, 'entries': [[kid(k), kid(x)] for k, x in items[:n]], 'more': len(items) - n,
                        'cls': type(v).__name__}
            fields = getattr(v, '__dict__', None)
            if isinstance(fields, dict):                                # an instance of a class: its attributes
                items = [(k, x) for k, x in fields.items() if not k.startswith('__')]
                n = min(len(items), MAX_KEYS)
                return {'t': 'obj', 'id': i, 'cls': type(v).__name__, 'entries': [[k, kid(x)] for k, x in items[:n]],
                        'more': len(items) - n}
            return _prim('str', json.dumps(_clip(repr(v), 80), ensure_ascii=False))
        except Exception:
            return _prim('str', '"[unreadable]"')

    def capture(self, named):
        """named: [(name, value, scope)] → {vars, refs}; locals first, like the JavaScript tracer."""
        named = sorted(named, key=lambda x: 0 if x[2] == 'local' else 1)
        ctx = {'seen': set(), 'refs': set()}
        out = [{'name': n, 'scope': sc, 'node': self.ser(v, ctx, 0)} for n, v, sc in named]
        return out, sorted(ctx['refs'])


def _shown(name, v):
    """Variables worth showing: not dunders, modules, functions or classes (like the JavaScript tracer skipping functions)."""
    if name.startswith('__') or name == 'print':
        return False
    return not isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type))


def trace(src):
    """Runs src and returns {'steps', 'logs', 'error'}. Raises SyntaxError if it does not compile."""
    code = compile(src, FILE, 'exec')
    ser = Serializer()
    steps, logs, stack = [], [], []
    g = {'__name__': '__main__', '__builtins__': builtins}

    def _print(*args, sep=' ', end='\n', file=None, flush=False):
        logs.append({'type': 'log', 's': sep.join(str(a) for a in args)})
    g['print'] = _print

    def snapshot(frame, line):
        named = []
        if frame is not None and frame.f_code.co_name != '<module>':
            local = frame.f_locals
            free = set(frame.f_code.co_freevars)
            for n, v in list(local.items()):
                if _shown(n, v):
                    named.append((n, v, 'closure' if n in free else 'local'))
            scope = 'global'
        else:
            scope = 'global'
        seen = {n for n, _, _ in named}
        for n, v in list(g.items()):
            if n not in seen and _shown(n, v):
                named.append((n, v, scope))
        vars_, refs = ser.capture(named)
        steps.append({'line': line, 'stack': [dict(s) for s in stack], 'vars': vars_, 'refs': refs, 'logs': len(logs)})

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != FILE:
            return None                                                  # never step into the standard library
        if event == 'call' and frame.f_code.co_name != '<module>':
            args = ', '.join(f'{n}={brief(frame.f_locals.get(n))}' for n in frame.f_code.co_varnames[:frame.f_code.co_argcount])
            stack.append({'name': frame.f_code.co_name, 'args': _clip(args, 70)})
            if len(stack) > MAX_CALLS:
                raise StopRun(f'Trace stopped: more than {MAX_CALLS} nested calls.')
        elif event == 'line':
            if len(steps) >= MAX_STEPS:
                raise StopRun(f'Trace stopped after {MAX_STEPS} steps (possible infinite loop).')
            snapshot(frame, frame.f_lineno)
        elif event == 'return' and frame.f_code.co_name != '<module>' and stack:   # also when an exception leaves it
            stack.pop()
        return tracer

    error = None
    sys.settrace(tracer)
    try:
        exec(code, g)
    except StopRun as e:
        error = {'msg': str(e), 'soft': True}
    except BaseException as e:                                          # the program's own error
        error = {'msg': f'{type(e).__name__}: {e}'}
    finally:
        sys.settrace(None)
    del stack[:]
    snapshot(None, -1)                                                  # the end: what is left at the top level
    return {'steps': steps, 'logs': logs, 'error': error}


def trace_json(src):
    try:
        return json.dumps(trace(src), ensure_ascii=False)
    except SyntaxError as e:
        where = f' (line {e.lineno})' if e.lineno else ''
        return json.dumps({'syntax': f'{e.msg}{where}'})
