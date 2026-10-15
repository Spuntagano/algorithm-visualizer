/**
 * The Lua tracer: runs the program in Fengari (Lua 5.3 written in JavaScript) under a line hook and records a snapshot
 * before every line, in the same format as the JavaScript tracer (see src/model.js), so every view works unchanged.
 * Tables become arrays (keys 1..n, with `base: 1` so they are numbered like in Lua), objects (string keys) or maps;
 * a table with a metatable that is a global "class" gets that class's name.
 *
 * runLuaTrace(code) returns { steps, logs, error }, or throws an Error ("line 3: unexpected symbol…") on a syntax error.
 */
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

const MAX_STEPS = 3000;  // stop runaway loops
const MAX_CALLS = 300;   // stop runaway recursion
const MAX_DEPTH = 5;     // how deeply nested values are expanded
const MAX_ITEMS = 60;    // array elements kept per table
const MAX_KEYS = 30;     // object / map entries kept per table
const CHUNK = '=code';   // the program's chunk name: error messages say "code:3: …"

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const S = s => to_luastring(s);

/** Lua's way of writing a number: 3, 3.0, 0.5, inf, nan */
function numText(L, i) {
  if (lua.lua_isinteger(L, i)) return String(lua.lua_tointeger(L, i));
  const x = lua.lua_tonumber(L, i);
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  return Number.isInteger(x) && Math.abs(x) < 1e15 ? x.toFixed(1) : String(x);
}

/** "code:3: attempt to …" → "line 3: attempt to …" */
const tidy = msg => String(msg).replace(/^code:(\d+):\s*/, 'line $1: ');

export function runLuaTrace(code) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const steps = [], logs = [];
  const ids = new Map();                    // table → stable id for the whole run
  const idOf = p => { if (!ids.has(p)) ids.set(p, ids.size + 1); return ids.get(p); };
  let stopped = null;                       // the reason the run was cut short (step / call limit)

  /* print → the Output panel (Lua separates values with tabs) */
  lua.lua_pushcfunction(L, L2 => {
    const n = lua.lua_gettop(L2), parts = [];
    for (let i = 1; i <= n; i++) { parts.push(to_jsstring(lauxlib.luaL_tolstring(L2, i))); lua.lua_pop(L2, 1); }
    logs.push({ type: 'log', s: parts.join('\t') });
    return 0;
  });
  lua.lua_setglobal(L, S('print'));

  /* the standard library's names, so only the program's own globals are shown */
  const builtin = new Set();
  lua.lua_pushglobaltable(L); lua.lua_pushnil(L);
  while (lua.lua_next(L, -2) !== 0) { if (lua.lua_type(L, -2) === lua.LUA_TSTRING) builtin.add(lua.lua_tojsstring(L, -2)); lua.lua_pop(L, 1); }
  lua.lua_pop(L, 1);

  /* ---- values → snapshot nodes ---- */
  let classNames = new Map();               // metatable → the global name it is stored under (a "class")
  const isClassTable = i => {               // a table used as a class (it has its own __index)
    const t = lua.lua_absindex(L, i);       // raw lookup: an instance finds __index only through its metatable
    lua.lua_pushstring(L, S('__index')); lua.lua_rawget(L, t);
    const has = lua.lua_type(L, -1) !== lua.LUA_TNIL; lua.lua_pop(L, 1);
    return has;
  };

  function prim(i) {
    switch (lua.lua_type(L, i)) {
      case lua.LUA_TNIL: return { t: 'p', k: 'null', s: 'nil' };
      case lua.LUA_TBOOLEAN: return { t: 'p', k: 'bool', s: lua.lua_toboolean(L, i) ? 'true' : 'false' };
      case lua.LUA_TNUMBER: return { t: 'p', k: 'num', s: numText(L, i) };
      case lua.LUA_TSTRING: return { t: 'p', k: 'str', s: JSON.stringify(clip(lua.lua_tojsstring(L, i), 80)) };
      case lua.LUA_TFUNCTION: return { t: 'fn', s: 'function' };
      case lua.LUA_TTABLE: return null;
      default: return { t: 'p', k: 'str', s: JSON.stringify('[' + to_jsstring(lua.lua_typename(L, lua.lua_type(L, i))) + ']') };
    }
  }

  function ser(i, ctx, depth) {
    i = lua.lua_absindex(L, i);
    const p0 = prim(i);
    if (p0) return p0;
    const id = idOf(lua.lua_topointer(L, i));
    if (ctx.seen.has(id)) { ctx.refs.add(id); return { t: 'ref', id }; }
    ctx.seen.add(id);
    if (depth >= MAX_DEPTH) return { t: 'trunc', id };
    // first pass: the keys (numbers and strings are read later by key; other keys are kept with their value now)
    const nums = [], strs = [], other = [];
    lua.lua_pushnil(L);
    while (lua.lua_next(L, i) !== 0) {
      const kt = lua.lua_type(L, -2);
      if (kt === lua.LUA_TNUMBER) nums.push({ n: lua.lua_tonumber(L, -2), int: lua.lua_isinteger(L, -2), text: numText(L, -2) });
      else if (kt === lua.LUA_TSTRING) strs.push(lua.lua_tojsstring(L, -2));
      else if (other.length < MAX_KEYS) other.push([ser(-2, ctx, depth + 1), ser(-1, ctx, depth + 1)]);
      lua.lua_pop(L, 1);
    }
    let cls = '';
    if (lua.lua_getmetatable(L, i)) { cls = classNames.get(lua.lua_topointer(L, -1)) || ''; lua.lua_pop(L, 1); }
    const count = nums.length + strs.length + other.length;
    const valueAt = getter => { getter(); const v = ser(-1, ctx, depth + 1); lua.lua_pop(L, 1); return v; };
    const rawField = k => () => { lua.lua_pushstring(L, S(k)); lua.lua_rawget(L, i); };   // raw: never through a metatable
    nums.sort((a, b) => a.n - b.n);
    const isArray = !strs.length && !other.length && nums.every((k, j) => k.int && k.n === j + 1);
    if (isArray && !cls) {                  // {} or {a, b, c}: a list, numbered from 1
      const n = Math.min(nums.length, MAX_ITEMS);
      const items = []; for (let j = 1; j <= n; j++) items.push(valueAt(() => lua.lua_rawgeti(L, i, j)));
      return { t: 'arr', id, len: nums.length, items, more: nums.length - n, cls: 'table', base: 1 };
    }
    if (!nums.length && !other.length) {   // string keys only: an object (sorted: Lua tables have no order)
      strs.sort();
      const keep = strs.slice(0, MAX_KEYS);
      const entries = keep.map(k => [k, valueAt(rawField(k))]);
      return { t: 'obj', id, cls, entries, more: strs.length - keep.length, tn: 'table' };
    }
    const entries = [];                     // anything else: a map, numbers first, then strings
    const rawNum = k => () => { if (k.int) lua.lua_pushinteger(L, k.n); else lua.lua_pushnumber(L, k.n); lua.lua_rawget(L, i); };
    for (const k of nums) { if (entries.length >= MAX_KEYS) break; entries.push([{ t: 'p', k: 'num', s: k.text }, valueAt(rawNum(k))]); }
    strs.sort();
    for (const k of strs) { if (entries.length >= MAX_KEYS) break; entries.push([{ t: 'p', k: 'str', s: JSON.stringify(k) }, valueAt(rawField(k))]); }
    for (const e of other) { if (entries.length >= MAX_KEYS) break; entries.push(e); }
    return { t: 'map', id, entries, more: count - entries.length, cls: cls || 'table' };
  }

  /** Short preview of a value, for call-stack arguments. */
  function brief(i) {
    const p = prim(i);
    if (p) return p.t === 'fn' ? 'ƒ' : p.k === 'str' ? JSON.stringify(clip(JSON.parse(p.s), 14)) : p.s;
    return '{…}';
  }

  /* ---- one snapshot ---- */
  const ar = new lua.lua_Debug();
  /** The program's frames, innermost first: [{ level, what, name, nparams }] */
  function frames() {
    const out = [];
    for (let level = 0; lua.lua_getstack(L, level, ar); level++) {
      lua.lua_getinfo(L, S('Snu'), ar);
      if (to_jsstring(ar.source) !== CHUNK) continue;
      out.push({ level, what: to_jsstring(ar.what), name: ar.name ? to_jsstring(ar.name) : null, nparams: ar.nparams });
    }
    return out;
  }
  /** Calls the visitor with each named local of a frame, its value on top of the stack. */
  function eachLocal(level, visit) {
    if (!lua.lua_getstack(L, level, ar)) return;
    for (let n = 1; ; n++) {
      const name = lua.lua_getlocal(L, ar, n);
      if (!name) break;
      const nm = to_jsstring(name);
      if (!nm.startsWith('(')) visit(nm, n); // "(for index)" and other internals are not variables
      lua.lua_pop(L, 1);
    }
  }

  function snapshot(line) {
    // which global tables are "classes", so objects whose metatable they are get the class's name
    classNames = new Map();
    lua.lua_pushglobaltable(L); lua.lua_pushnil(L);
    while (lua.lua_next(L, -2) !== 0) {
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING && lua.lua_type(L, -1) === lua.LUA_TTABLE) classNames.set(lua.lua_topointer(L, -1), lua.lua_tojsstring(L, -2));
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);

    const fr = frames();
    const ctx = { seen: new Set(), refs: new Set() };
    const vars = [], names = new Set();
    const add = (name, scope) => {          // the value is on top of the stack
      if (names.has(name)) return;
      const t = lua.lua_type(L, -1);
      if (t === lua.LUA_TFUNCTION || (t === lua.LUA_TTABLE && isClassTable(-1))) return;   // like functions and classes in JavaScript
      names.add(name);
      vars.push({ name, scope, node: ser(-1, ctx, 0) });
    };
    const inner = fr[0];
    if (inner && inner.what !== 'main') {
      eachLocal(inner.level, nm => add(nm, 'local'));
      lua.lua_getstack(L, inner.level, ar); lua.lua_getinfo(L, S('f'), ar);           // the function, for its upvalues
      for (let n = 1; ; n++) {
        const up = lua.lua_getupvalue(L, -1, n);
        if (!up) break;
        const nm = to_jsstring(up);
        if (nm !== '_ENV' && nm) add(nm, 'closure');
        lua.lua_pop(L, 1);
      }
      lua.lua_pop(L, 1);
    }
    const main = fr.find(f => f.what === 'main');
    if (main) eachLocal(main.level, nm => add(nm, 'global'));
    lua.lua_pushglobaltable(L); lua.lua_pushnil(L);
    while (lua.lua_next(L, -2) !== 0) {
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
        const nm = lua.lua_tojsstring(L, -2);
        if (!builtin.has(nm)) add(nm, 'global');
      }
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);
    vars.sort((a, b) => (a.scope === 'local' ? 0 : 1) - (b.scope === 'local' ? 0 : 1));

    const stack = fr.filter(f => f.what === 'Lua').reverse().map(f => {
      const args = [];
      eachLocal(f.level, (nm, n) => { if (n <= f.nparams) args.push(nm + '=' + brief(-1)); });
      return { name: f.name || '(anonymous)', args: clip(args.join(', '), 70) };
    });
    steps.push({ line, stack, vars, refs: [...ctx.refs].sort((a, b) => a - b), logs: logs.length });
    return stack.length;
  }

  /* ---- run ---- */
  if (lauxlib.luaL_loadbuffer(L, S(code), null, S(CHUNK)) !== lua.LUA_OK) throw new Error(tidy(lua.lua_tojsstring(L, -1)));
  let ended = false;
  lua.lua_sethook(L, (L2, hookAr) => {
    if (stopped) lauxlib.luaL_error(L2, S(stopped));                 // keep stopping, even if the program catches the error with pcall
    lua.lua_getinfo(L2, S('S'), hookAr);
    if (to_jsstring(hookAr.source) !== CHUNK) return;
    if (hookAr.event === lua.LUA_HOOKRET) {                           // the program's end: its top-level locals are still alive here
      if (to_jsstring(hookAr.what) === 'main') { snapshot(-1); ended = true; }
      return;
    }
    if (steps.length >= MAX_STEPS) { stopped = `Trace stopped after ${MAX_STEPS} steps (possible infinite loop).`; lauxlib.luaL_error(L2, S(stopped)); }
    lua.lua_getinfo(L2, S('l'), hookAr);
    if (snapshot(hookAr.currentline) > MAX_CALLS) { stopped = `Trace stopped: more than ${MAX_CALLS} nested calls.`; lauxlib.luaL_error(L2, S(stopped)); }
  }, lua.LUA_MASKLINE | lua.LUA_MASKRET, 0);

  let error = null;
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    const msg = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : 'error';
    error = stopped ? { msg: stopped, soft: true } : { msg: 'Error on ' + tidy(msg) };
  }
  lua.lua_sethook(L, null, 0, 0);
  if (!ended) {                                                       // stopped early: what was shown last, as the end
    const last = steps.at(-1);
    steps.push(last ? { ...last, line: -1, stack: [] } : { line: -1, stack: [], vars: [], refs: [], logs: logs.length });
  }
  return { steps, logs, error };
}
