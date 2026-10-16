/**
 * The part of the Java library that algorithms use, with Java's own behaviour where a program can see it: HashMap and
 * HashSet iterate in Java's bucket order (String.hashCode, a table that doubles at 3/4 full), PriorityQueue keeps
 * Java's heap order, java.util.Random is Java's generator (new Random(42) gives Java's numbers), printf rounds half
 * up like Java's Formatter, and changing a list while a for-each walks it throws ConcurrentModificationException.
 * makeLib(api) gets the interpreter's helpers (./interp.js) and returns what it calls.
 */
import { javaDouble, strHash } from './values.js';

export function makeLib(api) {
  const { Num, JStr, Box, JObj, JArr, JFn, str, jstr, box, unbox, toStr, equalsV, hashOf, compareV, callFn, throwJava, fail, write, kindOf, typeOfValue } = api;
  const toInt = (v, what) => { const x = unbox(v, what); const k = kindOf(x); if (k === 'int') return x; if (k === 'char') return x.charCodeAt(0); fail(`incompatible types: ${typeOfValue(v)} cannot be converted to int${what ? ' (' + what + ')' : ''}`); };
  const toNum = v => { const x = unbox(v); const k = kindOf(x); return k === 'int' ? x : k === 'long' ? Number(x) : k === 'char' ? x.charCodeAt(0) : k === 'double' || k === 'float' ? x.v : fail(`a number is needed, not ${typeOfValue(v)}`); };
  const cmpWith = c => (c ? (a, b) => Number(unbox(callFn(c, [a, b], 'compare'))) : compareV);
  const VOID = undefined;

  /* ---- the collections ---- */
  class JList {
    constructor(kind, items = []) { this.kind = kind; this.a = items; this.mod = 0; }
    check(k, n = this.a.length) { if (k < 0 || k >= n) throwJava('IndexOutOfBoundsException', `Index ${k} out of bounds for length ${this.a.length}`); }
    mutable() { if (this.frozen) throwJava('UnsupportedOperationException', this.frozen === 'fixed' ? 'Arrays.asList(…) has a fixed size (copy it: new ArrayList<>(Arrays.asList(…)))' : 'this list cannot be changed (List.of makes an unmodifiable list: copy it with new ArrayList<>(…))'); this.mod++; }
  }
  class JDeque { constructor(kind = 'ArrayDeque') { this.kind = kind; this.a = []; this.mod = 0; } }
  class JPQ { constructor(cmp) { this.kind = 'PriorityQueue'; this.q = []; this.cmp = cmpWith(cmp); this.cmpFn = cmp; this.mod = 0; } }
  /** HashMap, LinkedHashMap, TreeMap: entries { k, v, seq }; a HashMap iterates in its bucket order */
  class JMap {
    constructor(kind, cmp = null) { this.kind = kind; this.e = []; this.cap = 16; this.seq = 0; this.cmpFn = cmp; this.cmp = kind === 'TreeMap' ? cmpWith(cmp) : null; this.mod = 0; }
    find(k) {
      if (this.cmp) {
        if (k === null) throwJava('NullPointerException', 'a TreeMap cannot hold null keys');
        let lo = 0, hi = this.e.length;
        while (lo < hi) { const m = (lo + hi) >> 1, c = this.cmp(this.e[m].k, k); if (c < 0) lo = m + 1; else if (c > 0) hi = m; else return { at: m, hit: true }; }
        return { at: lo, hit: false };
      }
      const h = hashOf(k);
      for (let i = 0; i < this.e.length; i++) if (this.e[i].h === h && equalsV(this.e[i].k, k)) return { at: i, hit: true };
      return { at: this.e.length, hit: false };
    }
    get(k) { const f = this.find(k); return f.hit ? this.e[f.at] : null; }
    put(k, v) {
      if (this.frozen) throwJava('UnsupportedOperationException', 'this map cannot be changed (Map.of makes an unmodifiable map)');
      const f = this.find(k);
      if (f.hit) { const old = this.e[f.at].v; this.e[f.at].v = v; return old; }
      this.e.splice(f.at, 0, { k, v, h: this.cmp ? 0 : hashOf(k), seq: this.seq++ });
      this.mod++;
      while (this.kind === 'HashMap' && this.e.length > this.cap * 0.75) this.cap *= 2;
      return null;
    }
    remove(k) { if (this.frozen) throwJava('UnsupportedOperationException', 'this map cannot be changed'); const f = this.find(k); if (!f.hit) return null; const [x] = this.e.splice(f.at, 1); this.mod++; return x.v; }
    /** The entries in iteration order */
    order() {
      if (this.kind !== 'HashMap') return this.e;
      const n = this.cap - 1;
      return [...this.e].sort((a, b) => (((a.h ^ (a.h >>> 16)) & n) - ((b.h ^ (b.h >>> 16)) & n)) || a.seq - b.seq);
    }
  }
  class JSet { constructor(kind, cmp = null) { this.kind = kind; this.m = new JMap(kind === 'TreeSet' ? 'TreeMap' : kind === 'LinkedHashSet' ? 'LinkedHashMap' : 'HashMap', cmp); } get mod() { return this.m.mod; } }
  /** map.keySet(), values(), entrySet(): live views */
  class JView { constructor(map, part) { this.kind = part === 'k' ? 'keySet' : part === 'v' ? 'values' : 'entrySet'; this.map = map; this.part = part; } get mod() { return this.map.mod; } items() { return this.map.order().map(en => (this.part === 'k' ? en.k : this.part === 'v' ? en.v : new JEntry(en))); } }
  class JEntry { constructor(en) { this.kind = 'Map.Entry'; this.en = en; } }
  class JSB { constructor(s = '') { this.kind = 'StringBuilder'; this.s = s; } }
  class JRandom {
    constructor(seed) { this.kind = 'Random'; this.setSeed(seed); }
    setSeed(seed) { this.seed = (BigInt(seed) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n); }
    next(bits) { this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n); return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits))); }
    nextInt(bound) {
      if (bound === undefined) return this.next(32);
      if (bound <= 0) throwJava('IllegalArgumentException', 'bound must be positive');
      if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
      let bits, v;
      do { bits = this.next(31); v = bits % bound; } while (((bits - v + (bound - 1)) | 0) < 0);
      return v;
    }
    nextDouble() { return (this.next(26) * 134217728 + this.next(27)) * 2 ** -53; }
  }
  class JIter { constructor(next, hasNext, remove) { this.kind = 'Iterator'; this.nextFn = next; this.hasNextFn = hasNext; this.removeFn = remove; } }
  class Stream { constructor(err) { this.kind = 'PrintStream'; this.err = err; } }
  class ClassRef { constructor(name) { this.kind = 'Class'; this.name = name; } }
  const OUT = new Stream(false), ERR = new Stream(true);
  let shared = null;
  const sharedRandom = () => shared || (shared = new JRandom(42));

  const isList = v => v instanceof JList;
  const isColl = v => v instanceof JList || v instanceof JDeque || v instanceof JPQ || v instanceof JSet || v instanceof JView;
  /** The elements of any collection (or array), in iteration order */
  const elems = v => {
    if (v instanceof JList || v instanceof JDeque) return v.a;
    if (v instanceof JPQ) return v.q;
    if (v instanceof JSet) return v.m.order().map(en => en.k);
    if (v instanceof JView) return v.items();
    if (v instanceof JArr) return v.a;
    if (v === null) throwJava('NullPointerException', 'the collection is null');
    fail(`${typeOfValue(v)} is not a collection`);
  };

  /* ---- Java's Formatter: printf, String.format ---- */
  /** A double rounded half up to p decimals, as Java's Formatter does (it starts from the shortest digits) */
  function fixedHalfUp(x, p) {
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
    const neg = x < 0 || Object.is(x, -0), [m, e] = Math.abs(x).toExponential().split('e');
    const digits = m.replace('.', ''), exp = +e;
    let int = exp >= 0 ? digits.slice(0, exp + 1).padEnd(exp + 1, '0') : '0';
    let frac = exp >= 0 ? digits.slice(exp + 1) : '0'.repeat(-exp - 1) + digits;
    if (frac.length > p) {
      const up = frac[p] >= '5';
      frac = frac.slice(0, p);
      if (up) {
        const all = (BigInt(int + frac) + 1n).toString().padStart(int.length + frac.length, '0');
        int = all.slice(0, all.length - p) || '0'; frac = p ? all.slice(all.length - p) : '';
      }
    }
    frac = frac.padEnd(p, '0');
    return (neg && (/[1-9]/.test(int + frac)) ? '-' : '') + int + (p ? '.' + frac : '');
  }
  const group = s => s.replace(/^(-?\d+)/, m => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  function format(fmt, args) {
    let out = '', ai = 0, i = 0;
    const re = /%(\d+\$)?([-#+ 0,(]*)(\d+)?(\.\d+)?([a-zA-Z%])/y;
    while (i < fmt.length) {
      const pc = fmt.indexOf('%', i);
      if (pc < 0) { out += fmt.slice(i); break; }
      out += fmt.slice(i, pc);
      re.lastIndex = pc;
      const m = re.exec(fmt);
      if (!m) throwJava('UnknownFormatConversionException', `Conversion = '${fmt[pc + 1] || '%'}'`);
      i = re.lastIndex;
      const [, pos, flags, w, pr, conv] = m;
      if (conv === 'n') { out += '\n'; continue; }
      if (conv === '%') { out += '%'; continue; }
      const a = pos ? args[parseInt(pos, 10) - 1] : args[ai++];
      if (a === undefined) throwJava('MissingFormatArgumentException', `Format specifier '%${conv}'`);
      const x = a instanceof Box ? a.v : a, k = kindOf(x), p = pr ? +pr.slice(1) : null;
      let s;
      const wrongType = javaType => throwJava('IllegalFormatConversionException', `${conv} != ${javaType}`);
      switch (conv.toLowerCase()) {
        case 'd':
          if (k !== 'int' && k !== 'long') wrongType(k === 'double' ? 'java.lang.Double' : k === 'char' ? 'java.lang.Character' : 'java.lang.' + typeOfValue(a));
          s = String(x);
          if (flags.includes(',')) s = group(s);
          if (flags.includes('+') && !s.startsWith('-')) s = '+' + s;
          break;
        case 'x': case 'o': {
          if (k !== 'int' && k !== 'long') wrongType('java.lang.' + typeOfValue(a));
          const big = BigInt.asUintN(k === 'long' ? 64 : 32, BigInt(x));
          s = big.toString(conv.toLowerCase() === 'x' ? 16 : 8);
          break;
        }
        case 'f': case 'e': case 'g': {
          if (k !== 'double' && k !== 'float') wrongType(k === 'int' ? 'java.lang.Integer' : 'java.lang.' + typeOfValue(a));
          const v = x.v, prec = p == null ? 6 : p;
          if (conv.toLowerCase() === 'f') s = fixedHalfUp(v, prec);
          else if (conv.toLowerCase() === 'e') s = v.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
          else s = String(parseFloat(v.toPrecision(prec || 1)));
          if (flags.includes(',')) s = group(s);
          if (flags.includes('+') && v >= 0) s = '+' + s;
          break;
        }
        case 's': s = toStr(a); if (p != null) s = s.slice(0, p); break;
        case 'c': s = k === 'char' ? x : k === 'int' ? String.fromCharCode(x) : wrongType('java.lang.' + typeOfValue(a)); break;
        case 'b': s = a === null ? 'false' : k === 'boolean' ? String(x) : 'true'; break;
        default: throwJava('UnknownFormatConversionException', `Conversion = '${conv}'`);
      }
      if (conv !== conv.toLowerCase()) s = s.toUpperCase();
      const width = w ? +w : 0;
      if (s.length < width) s = flags.includes('-') ? s.padEnd(width) : flags.includes('0') && /[dfxoe]/i.test(conv) ? s.replace(/^([+-]?)/, (_, sg) => sg + '0'.repeat(width - s.length)) : s.padStart(width);
      out += s;
    }
    return out;
  }

  /* ---- toString, equals, hashCode of the library's objects ---- */
  function libToStr(v) {
    if (v instanceof JSB) return v.s;
    if (v instanceof JEntry) return toStr(v.en.k) + '=' + toStr(v.en.v);
    if (v instanceof JMap) return '{' + v.order().map(en => (en.k === v ? '(this Map)' : toStr(en.k)) + '=' + (en.v === v ? '(this Map)' : toStr(en.v))).join(', ') + '}';
    if (isColl(v)) return '[' + elems(v).map(x => (x === v ? '(this Collection)' : toStr(x))).join(', ') + ']';
    if (v instanceof ClassRef) return 'class ' + v.name;
    return 'java.util.' + (v.kind || 'Object') + '@' + api.identityHash(v).toString(16);
  }
  function libEquals(a, b) {
    if (a === b) return true;
    if (a instanceof JList && b instanceof JList) return a.a.length === b.a.length && a.a.every((x, k) => equalsV(x, b.a[k]));
    if ((a instanceof JSet || a instanceof JView) && (b instanceof JSet || b instanceof JView)) { const x = elems(a), y = elems(b); return x.length === y.length && x.every(e => y.some(f => equalsV(e, f))); }
    if (a instanceof JMap && b instanceof JMap) return a.e.length === b.e.length && a.e.every(en => { const o = b.get(en.k); return o && equalsV(en.v, o.v); });
    if (a instanceof JEntry && b instanceof JEntry) return equalsV(a.en.k, b.en.k) && equalsV(a.en.v, b.en.v);
    return false;
  }
  function libHash(v) {
    if (v instanceof JList) return v.a.reduce((h, x) => (Math.imul(h, 31) + hashOf(x)) | 0, 1);
    if (v instanceof JSet) return elems(v).reduce((h, x) => (h + hashOf(x)) | 0, 0);
    if (v instanceof JMap) return v.e.reduce((h, en) => (h + (hashOf(en.k) ^ hashOf(en.v))) | 0, 0);
    if (v instanceof JEntry) return hashOf(v.en.k) ^ hashOf(v.en.v);
    return api.identityHash(v);
  }

  /* ---- sorting: stable, with the comparison called once per comparison (Java's sorts are stable too) ---- */
  function mergeSort(items, cmp) {
    if (items.length < 2) return items;
    const mid = items.length >> 1, l = mergeSort(items.slice(0, mid), cmp), r = mergeSort(items.slice(mid), cmp), out = [];
    let i = 0, j = 0;
    while (i < l.length && j < r.length) out.push(cmp(l[i], r[j]) <= 0 ? l[i++] : r[j++]);
    return out.concat(l.slice(i), r.slice(j));
  }

  /* ---- comparators made by the library ---- */
  const comparator = (fn, label) => new JFn({ native: ([a, b]) => fn(a, b), name: label, cmp: true });
  const keyCmp = (keyFn, cmp) => comparator((a, b) => (cmp ? cmpWith(cmp) : compareV)(callFn(keyFn, [a], 'apply'), callFn(keyFn, [b], 'apply')), 'Comparator.comparing');
  const isKeyFn = f => f instanceof JFn && !f.cmp && (f.params ? f.params.length === 1 : f.arity === 1);

  /** Methods of lambdas and of the library's functions: compare, apply…, and Comparator's reversed(), thenComparing() */
  function fnMethod(f, name, args, e) {
    switch (name) {
      case 'reversed': return comparator((a, b) => -cmpWith(f)(a, b), 'reversed');
      case 'thenComparing': case 'thenComparingInt': case 'thenComparingDouble': case 'thenComparingLong': {
        const other = args.length === 2 ? keyCmp(args[0], args[1]) : isKeyFn(args[0]) || name !== 'thenComparing' ? keyCmp(args[0]) : args[0];
        return comparator((a, b) => cmpWith(f)(a, b) || cmpWith(other)(a, b), 'thenComparing');
      }
      case 'negate': return new JFn({ native: a => !unbox(callFn(f, a)), name: 'negate' });
      case 'and': return new JFn({ native: a => !!unbox(callFn(f, a)) && !!unbox(callFn(args[0], a)), name: 'and' });
      case 'or': return new JFn({ native: a => !!unbox(callFn(f, a)) || !!unbox(callFn(args[0], a)), name: 'or' });
      case 'andThen': return new JFn({ native: a => { const r = callFn(f, a); return args[0] instanceof JFn && args[0].params && args[0].params.length === 1 && a.length === 1 ? callFn(args[0], [r]) : (callFn(args[0], a), r); }, name: 'andThen' });
      case 'compose': return new JFn({ native: a => callFn(f, [callFn(args[0], a)]), name: 'compose' });
      case 'equals': return f === args[0];
      case 'toString': return jstr(toStr(f));
      case 'hashCode': return api.identityHash(f);
    }
    void e;
    return callFn(f, args, name);                    // apply, test, accept, get, run, compare, applyAsInt…
  }

  /* ---- static fields ---- */
  const STATIC_FIELDS = {
    Integer: { MAX_VALUE: 2147483647, MIN_VALUE: -2147483648, SIZE: 32 },
    Long: { MAX_VALUE: 9223372036854775807n, MIN_VALUE: -9223372036854775808n, SIZE: 64 },
    Short: { MAX_VALUE: 32767, MIN_VALUE: -32768 }, Byte: { MAX_VALUE: 127, MIN_VALUE: -128 },
    Character: { MAX_VALUE: '￿', MIN_VALUE: '\0' },
    Double: { MAX_VALUE: new Num(Number.MAX_VALUE), MIN_VALUE: new Num(5e-324), POSITIVE_INFINITY: new Num(Infinity), NEGATIVE_INFINITY: new Num(-Infinity), NaN: new Num(NaN) },
    Float: { MAX_VALUE: new Num(3.4028234663852886e38, true), MIN_VALUE: new Num(1.401298464324817e-45, true), POSITIVE_INFINITY: new Num(Infinity, true), NEGATIVE_INFINITY: new Num(-Infinity, true), NaN: new Num(NaN, true) },
    Math: { PI: new Num(Math.PI), E: new Num(Math.E) },
    Boolean: { TRUE: box(true), FALSE: box(false) },
    System: { out: OUT, err: ERR, in: new ClassRef('InputStream') },
    Map: { Entry: new ClassRef('Map.Entry') },
    AbstractMap: { SimpleEntry: new ClassRef('AbstractMap.SimpleEntry') },
  };
  function staticField(cls, name, e) {
    const t = STATIC_FIELDS[cls];
    if (t && name in t) return t[name];
    void e;
    fail(`cannot find symbol: variable ${name} in class ${cls}`);
  }

  /* ---- making the library's objects ---- */
  const collArg = a => (a === undefined || kindOf(a instanceof Box ? a.v : a) === 'int' ? null : a);
  function construct(name, args, e) {
    switch (name) {
      case 'ArrayList': case 'LinkedList': case 'Vector': { const c = collArg(args[0]); return new JList(name, c ? elems(c).slice() : []); }
      case 'Stack': return new JList('Stack');
      case 'ArrayDeque': { const d = new JDeque(); const c = collArg(args[0]); if (c) d.a = elems(c).slice(); return d; }
      case 'PriorityQueue': {
        const cmp = args.find(a => a instanceof JFn || (a instanceof JObj));
        const pq = new JPQ(cmp || null);
        const c = args.find(a => isColl(a));
        if (c) for (const x of elems(c)) pqOffer(pq, x);
        return pq;
      }
      case 'HashMap': case 'LinkedHashMap': case 'TreeMap': {
        const m = new JMap(name, name === 'TreeMap' ? args.find(a => a instanceof JFn || a instanceof JObj) || null : null);
        const cap = args[0] !== undefined && kindOf(args[0] instanceof Box ? args[0].v : args[0]) === 'int' ? toInt(args[0]) : 0;
        if (cap > 12) { let c = 1; while (c < cap) c *= 2; m.cap = c; }
        const src = args.find(a => a instanceof JMap);
        if (src) for (const en of src.order()) m.put(en.k, en.v);
        return m;
      }
      case 'HashSet': case 'LinkedHashSet': case 'TreeSet': {
        const s = new JSet(name, name === 'TreeSet' ? args.find(a => a instanceof JFn || a instanceof JObj) || null : null);
        const cap = args[0] !== undefined && kindOf(args[0] instanceof Box ? args[0].v : args[0]) === 'int' ? toInt(args[0]) : 0;
        if (cap > 12) { let c = 1; while (c < cap) c *= 2; s.m.cap = c; }
        const c = args.find(a => isColl(a));
        if (c) for (const x of elems(c)) s.m.put(x, true);
        return s;
      }
      case 'StringBuilder': case 'StringBuffer': return new JSB(args[0] instanceof JStr ? args[0].s : '');
      case 'String':
        if (!args.length) return jstr('');
        if (args[0] instanceof JStr) return jstr(args[0].s);
        if (args[0] instanceof JArr) { const off = args[1] !== undefined ? toInt(args[1]) : 0, n = args[2] !== undefined ? toInt(args[2]) : args[0].a.length - off; return jstr(args[0].a.slice(off, off + n).join('')); }
        if (args[0] instanceof JSB) return jstr(args[0].s);
        break;
      case 'Random': return new JRandom(args.length ? BigInt(unbox(args[0])) : 42n);
      case 'Scanner': case 'BufferedReader': case 'InputStreamReader':
        fail(`new ${name}(…): this page has no keyboard input (put the values in the code instead)`);
      // falls through
      case 'Object': return new JObj({ name: 'Object', fields: [], methods: new Map(), sup: null, ifaces: [], statics: new Map(), decl: { members: [] }, builtin: true });
      case 'Integer': case 'Long': case 'Double': case 'Character': case 'Boolean': return new Box(name, api.coerce(args[0] instanceof JStr ? parse(name, args[0].s) : unbox(args[0]), { name: { Integer: 'int', Long: 'long', Double: 'double', Character: 'char', Boolean: 'boolean' }[name], dims: 0 }));
      case 'AbstractMap.SimpleEntry': case 'SimpleEntry': return new JEntry({ k: args[0], v: args[1] });
      case 'int': break;
    }
    void e;
    fail(`new ${name}(…) is not supported here`);
  }
  const parse = (name, s) => {
    if (name === 'Integer' || name === 'Long') {
      if (!/^[+-]?\d+$/.test(s)) throwJava('NumberFormatException', `For input string: "${s}"`);
      const v = BigInt(s);
      if (name === 'Integer' && (v > 2147483647n || v < -2147483648n)) throwJava('NumberFormatException', `For input string: "${s}"`);
      return name === 'Integer' ? Number(v) : BigInt.asIntN(64, v);
    }
    if (name === 'Double') { const t = s.trim(); if (!/^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[dDfF]?)$/.test(t)) throwJava('NumberFormatException', `For input string: "${s}"`); return new Num(parseFloat(t)); }
    if (name === 'Boolean') return s.toLowerCase() === 'true';
    return s;
  };

  /* ---- static methods: Math, Integer, Arrays, Collections, List.of… ---- */
  const KNOWN = new Set(['ArrayList', 'LinkedList', 'List', 'ArrayDeque', 'Deque', 'Queue', 'Stack', 'Vector', 'PriorityQueue', 'HashMap', 'LinkedHashMap',
    'TreeMap', 'Map', 'SortedMap', 'NavigableMap', 'HashSet', 'LinkedHashSet', 'TreeSet', 'Set', 'SortedSet', 'NavigableSet', 'Collection', 'Iterable',
    'Iterator', 'ListIterator', 'StringBuilder', 'StringBuffer', 'Math', 'Integer', 'Long', 'Double', 'Float', 'Short', 'Byte', 'Character', 'Boolean',
    'String', 'Object', 'Number', 'Arrays', 'Collections', 'Objects', 'System', 'Comparator', 'Comparable', 'Random', 'Scanner', 'Thread', 'Function',
    'BiFunction', 'Predicate', 'BiPredicate', 'Consumer', 'BiConsumer', 'Supplier', 'Runnable', 'UnaryOperator', 'BinaryOperator', 'IntBinaryOperator',
    'IntUnaryOperator', 'IntPredicate', 'IntFunction', 'ToIntFunction', 'ToLongFunction', 'ToDoubleFunction', 'IntConsumer', 'Callable', 'Map.Entry',
    'Entry', 'AbstractMap', 'AbstractMap.SimpleEntry', 'CharSequence', 'BufferedReader', 'InputStreamReader', 'StrictMath', 'Optional', 'Cloneable']);
  const sum = (a, b) => api.binop('+', unbox(a), unbox(b));
  function callStatic(cls, name, args, e) {
    const n = i => toNum(args[i]);
    const kinds = () => args.map(a => kindOf(a instanceof Box ? a.v : a));
    switch (cls) {
      case 'Math': case 'StrictMath': {
        const ks = kinds(), x = args[0] instanceof Box ? args[0].v : args[0];
        const widest = ks.includes('double') ? 'double' : ks.includes('float') ? 'float' : ks.includes('long') ? 'long' : 'int';
        const as = v => { v = v instanceof Box ? v.v : v; return widest === 'long' ? (typeof v === 'bigint' ? v : BigInt(kindOf(v) === 'char' ? v.charCodeAt(0) : v)) : widest === 'int' ? (kindOf(v) === 'char' ? v.charCodeAt(0) : v) : toNum(v); };
        const out = r => (widest === 'double' || widest === 'float' ? new Num(r, widest === 'float') : r);
        switch (name) {
          case 'abs': return widest === 'long' ? (as(x) < 0n ? BigInt.asIntN(64, -as(x)) : as(x)) : widest === 'int' ? (as(x) < 0 ? (-as(x)) | 0 : as(x)) : out(Math.abs(as(x)));
          case 'max': case 'min': { const a = as(args[0]), b = as(args[1]); return out(name === 'max' ? (a > b ? a : b) : (a < b ? a : b)); }
          case 'pow': return new Num(Math.pow(n(0), n(1)));
          case 'sqrt': case 'cbrt': case 'log': case 'log10': case 'exp': case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan': case 'floor': case 'ceil': case 'rint':
            return new Num(({ rint: v => (Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v)), log: Math.log } [name] || Math[name])(n(0)));
          case 'atan2': case 'hypot': return new Num(Math[name](n(0), n(1)));
          case 'round': { const v = n(0); return ks[0] === 'float' ? Math.floor(v + 0.5) | 0 : BigInt(Math.floor(v + 0.5)); }
          case 'signum': return new Num(Math.sign(n(0)));
          case 'random': return new Num(sharedRandom().nextDouble());
          case 'toRadians': return new Num(n(0) * Math.PI / 180);
          case 'toDegrees': return new Num(n(0) * 180 / Math.PI);
          case 'floorDiv': case 'floorMod': {
            const a = as(args[0]), b = as(args[1]);
            if (b == 0) throwJava('ArithmeticException', '/ by zero'); // eslint-disable-line eqeqeq
            if (widest === 'long') { const q = a / b - ((a % b !== 0n && (a < 0n) !== (b < 0n)) ? 1n : 0n); return name === 'floorDiv' ? q : a - q * b; }
            const q = Math.floor(a / b);
            return name === 'floorDiv' ? q | 0 : (a - q * b) | 0;
          }
          case 'addExact': case 'subtractExact': case 'multiplyExact': {
            const a = BigInt(as(args[0])), b = BigInt(as(args[1])), r = name === 'addExact' ? a + b : name === 'subtractExact' ? a - b : a * b;
            if (widest === 'long' ? BigInt.asIntN(64, r) !== r : BigInt.asIntN(32, r) !== r) throwJava('ArithmeticException', (widest === 'long' ? 'long' : 'integer') + ' overflow');
            return widest === 'long' ? r : Number(r);
          }
          case 'toIntExact': { const v = BigInt(unbox(args[0])); if (BigInt.asIntN(32, v) !== v) throwJava('ArithmeticException', 'integer overflow'); return Number(v); }
        }
        break;
      }
      case 'Integer': case 'Long': case 'Short': case 'Byte': {
        const L = cls === 'Long';
        switch (name) {
          case 'parseInt': case 'parseLong': case 'valueOf': {
            if (args[0] instanceof JStr) {
              if (args[1] !== undefined) { const r = toInt(args[1]), s = args[0].s; if (!new RegExp('^[+-]?[' + '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, r) + ']+$', 'i').test(s)) throwJava('NumberFormatException', `For input string: "${s}"` + (r !== 10 ? ` under radix ${r}` : '')); const v = BigInt.asIntN(L ? 64 : 32, BigInt(parseInt(s, r))); return name === 'valueOf' ? box(L ? v : Number(v)) : L ? v : Number(v); }
              const v = parse(L ? 'Long' : 'Integer', args[0].s);
              return name === 'valueOf' ? box(v) : v;
            }
            return box(api.coerce(unbox(args[0]), { name: L ? 'long' : 'int', dims: 0 }));
          }
          case 'toString': { const v = unbox(args[0]); return jstr(args[1] !== undefined ? BigInt(v).toString(toInt(args[1])) : String(v)); }
          case 'toBinaryString': return jstr(BigInt.asUintN(L ? 64 : 32, BigInt(unbox(args[0]))).toString(2));
          case 'toHexString': return jstr(BigInt.asUintN(L ? 64 : 32, BigInt(unbox(args[0]))).toString(16));
          case 'toOctalString': return jstr(BigInt.asUintN(L ? 64 : 32, BigInt(unbox(args[0]))).toString(8));
          case 'compare': { const a = unbox(args[0]), b = unbox(args[1]); return a < b ? -1 : a > b ? 1 : 0; }
          case 'max': case 'min': { const a = unbox(args[0]), b = unbox(args[1]); return name === 'max' ? (a > b ? a : b) : (a < b ? a : b); }
          case 'sum': return sum(args[0], args[1]);
          case 'signum': { const a = unbox(args[0]); return a > 0 ? 1 : a < 0 ? -1 : 0; }
          case 'bitCount': { let v = BigInt.asUintN(L ? 64 : 32, BigInt(unbox(args[0]))), c = 0; while (v) { c += Number(v & 1n); v >>= 1n; } return c; }
          case 'highestOneBit': { const v = unbox(args[0]); return v === 0 ? 0 : (1 << (31 - Math.clz32(v))) | 0; }
          case 'numberOfTrailingZeros': { const v = unbox(args[0]); return v === 0 ? 32 : 31 - Math.clz32(v & -v); }
          case 'numberOfLeadingZeros': return Math.clz32(unbox(args[0]));
          case 'hashCode': return hashOf(unbox(args[0]));
          case 'reverse': { let v = unbox(args[0]) >>> 0, r = 0; for (let k = 0; k < 32; k++) { r = (r << 1) | (v & 1); v >>>= 1; } return r | 0; }
        }
        break;
      }
      case 'Double': case 'Float': {
        const F = cls === 'Float';
        switch (name) {
          case 'parseDouble': case 'parseFloat': case 'valueOf': { const v = args[0] instanceof JStr ? parse('Double', args[0].s) : new Num(toNum(args[0])); const r = F ? new Num(v.v, true) : v; return name === 'valueOf' ? box(r) : r; }
          case 'compare': { const a = n(0), b = n(1); return a < b ? -1 : a > b ? 1 : 0; }
          case 'isNaN': return Number.isNaN(n(0));
          case 'isInfinite': return !Number.isFinite(n(0)) && !Number.isNaN(n(0));
          case 'toString': return jstr(javaDouble(n(0), F));
          case 'sum': return new Num(n(0) + n(1), F);
          case 'max': case 'min': return new Num(Math[name](n(0), n(1)), F);
        }
        break;
      }
      case 'Boolean':
        if (name === 'parseBoolean') return parse('Boolean', toStr(args[0]));
        if (name === 'valueOf') return box(args[0] instanceof JStr ? parse('Boolean', args[0].s) : unbox(args[0]));
        if (name === 'toString') return jstr(String(unbox(args[0])));
        if (name === 'compare') { const a = unbox(args[0]), b = unbox(args[1]); return a === b ? 0 : a ? 1 : -1; }
        break;
      case 'Character': {
        const c = args[0] === undefined ? '' : (() => { const x = unbox(args[0]); return typeof x === 'number' ? String.fromCharCode(x) : x; })();
        const test = re => re.test(c);
        switch (name) {
          case 'isDigit': return test(/^\p{Nd}$/u);
          case 'isLetter': return test(/^\p{L}$/u);
          case 'isLetterOrDigit': return test(/^[\p{L}\p{Nd}]$/u);
          case 'isAlphabetic': return test(/^\p{Alphabetic}$/u);
          case 'isUpperCase': return test(/^\p{Lu}$/u);
          case 'isLowerCase': return test(/^\p{Ll}$/u);
          case 'isWhitespace': case 'isSpaceChar': return test(/^[\s]$/);
          case 'toUpperCase': return typeof unbox(args[0]) === 'number' ? c.toUpperCase().charCodeAt(0) : c.toUpperCase();
          case 'toLowerCase': return typeof unbox(args[0]) === 'number' ? c.toLowerCase().charCodeAt(0) : c.toLowerCase();
          case 'getNumericValue': { const d = parseInt(c, 36); return Number.isNaN(d) ? -1 : d; }
          case 'valueOf': return box(c);
          case 'toString': return jstr(c);
          case 'compare': return c.charCodeAt(0) - unbox(args[1]).charCodeAt(0);
          case 'isDefined': return true;
          case 'toChars': return new JArr({ name: 'char', dims: 0 }, [String.fromCharCode(toInt(args[0]))]);
          case 'digit': { const d = parseInt(c, toInt(args[1])); return Number.isNaN(d) ? -1 : d; }
        }
        break;
      }
      case 'String':
        switch (name) {
          case 'valueOf': case 'copyValueOf': return jstr(args[0] instanceof JArr ? args[0].a.join('') : toStr(args[0]));
          case 'join': { const items = args.length === 2 && (isColl(args[1]) || args[1] instanceof JArr) ? elems(args[1]) : args.slice(1); return jstr(items.map(toStr).join(toStr(args[0]))); }
          case 'format': return jstr(format(toStr(args[0]), args.slice(1)));
        }
        break;
      case 'Arrays': return arraysCall(name, args, e);
      case 'Collections': return collectionsCall(name, args, e);
      case 'List': case 'Set': case 'Map':
        if (name === 'of' || name === 'copyOf') {
          if (cls === 'List') { const l = new JList('ImmutableCollections.ListN', name === 'copyOf' ? elems(args[0]).slice() : args.length === 1 && args[0] instanceof JArr ? args[0].a.slice() : args.slice()); l.frozen = 'immutable'; return l; }
          if (cls === 'Set') { const s = new JSet('LinkedHashSet'); for (const x of name === 'copyOf' ? elems(args[0]) : args) s.m.put(x, true); s.m.frozen = true; s.kind = 'ImmutableCollections.SetN'; return s; }
          const m = new JMap('LinkedHashMap');
          if (name === 'copyOf') for (const en of args[0].order()) m.put(en.k, en.v); else for (let k = 0; k + 1 < args.length; k += 2) m.put(args[k], args[k + 1]);
          m.frozen = true; m.kind = 'ImmutableCollections.MapN';
          return m;
        }
        if (cls === 'Map' && name === 'entry') return new JEntry({ k: args[0], v: args[1] });
        break;
      case 'Map.Entry': case 'Entry':
        if (name === 'comparingByKey') return comparator((a, b) => cmpWith(args[0])(a.en.k, b.en.k), 'comparingByKey');
        if (name === 'comparingByValue') return comparator((a, b) => cmpWith(args[0])(a.en.v, b.en.v), 'comparingByValue');
        break;
      case 'Objects':
        switch (name) {
          case 'equals': return equalsV(args[0], args[1]);
          case 'hash': return args.reduce((h, x) => (Math.imul(h, 31) + hashOf(x)) | 0, 1);
          case 'hashCode': return args[0] === null ? 0 : hashOf(args[0]);
          case 'isNull': return args[0] === null;
          case 'nonNull': return args[0] !== null;
          case 'toString': return jstr(args[0] === null && args[1] ? toStr(args[1]) : toStr(args[0]));
          case 'requireNonNull': if (args[0] === null) throwJava('NullPointerException', args[1] ? toStr(args[1]) : null); return args[0];
          case 'requireNonNullElse': return args[0] === null ? args[1] : args[0];
        }
        break;
      case 'System':
        switch (name) {
          case 'exit': return api.exit(toInt(args[0]));
          case 'currentTimeMillis': return 1700000000000n + BigInt(api.steps());
          case 'nanoTime': return 1700000000000000000n + BigInt(api.steps()) * 1000n;
          case 'lineSeparator': return str('\n');
          case 'identityHashCode': return api.identityHash(args[0]);
          case 'arraycopy': {
            const [s, sp, d, dp, len] = [args[0], toInt(args[1]), args[2], toInt(args[3]), toInt(args[4])];
            if (s === null || d === null) throwJava('NullPointerException', 'arraycopy: the array is null');
            if (sp < 0 || dp < 0 || len < 0 || sp + len > s.a.length || dp + len > d.a.length) throwJava('ArrayIndexOutOfBoundsException', `arraycopy: last ${sp + len > s.a.length ? 'source' : 'destination'} index ${(sp + len > s.a.length ? sp : dp) + len} out of bounds for length ${(sp + len > s.a.length ? s : d).a.length}`);
            const part = s.a.slice(sp, sp + len);
            part.forEach((x, k) => { d.a[dp + k] = x; });
            return VOID;
          }
        }
        break;
      case 'Comparator':
        switch (name) {
          case 'naturalOrder': return comparator(compareV, 'naturalOrder');
          case 'reverseOrder': return comparator((a, b) => compareV(b, a), 'reverseOrder');
          case 'comparing': return keyCmp(args[0], args[1]);
          case 'comparingInt': case 'comparingDouble': case 'comparingLong': return keyCmp(args[0]);
          case 'nullsFirst': case 'nullsLast': { const first = name === 'nullsFirst'; return comparator((a, b) => (a === null ? (b === null ? 0 : first ? -1 : 1) : b === null ? (first ? 1 : -1) : cmpWith(args[0])(a, b)), name); }
        }
        break;
      case 'Thread': if (name === 'sleep') return VOID; break;
      case 'Optional': fail('Optional is not supported here (use null checks)');
    }
    fail(`cannot find symbol: method ${name}(…) in class ${cls}` + (name === 'stream' ? '' : ''));
  }
  /** Integer::parseInt, String::valueOf as functions, and String::length (the first argument is the object) */
  function staticOrUnbound(cls, name, args, e) {
    try { return callStatic(cls, name, args, e); }
    catch (err) {
      if (!/cannot find symbol/.test(err.message) || !args.length) throw err;
      return callMethod(args[0], name, args.slice(1), e);
    }
  }
  function arraysCall(name, args, e) {
    const a = args[0];
    switch (name) {
      case 'toString': return jstr(a === null ? 'null' : '[' + a.a.map(toStr).join(', ') + ']');
      case 'deepToString': { const deep = x => (x instanceof JArr ? '[' + x.a.map(deep).join(', ') + ']' : toStr(x)); return jstr(deep(a)); }
      case 'sort': {
        const from = args.length >= 3 && !(args[1] instanceof JFn) ? toInt(args[1]) : 0, to = args.length >= 3 && !(args[1] instanceof JFn) ? toInt(args[2]) : a.a.length;
        const cmp = args.find(x => x instanceof JFn || (x instanceof JObj && x !== a));
        if (cmp && ['int', 'long', 'double', 'char', 'float', 'short', 'byte', 'boolean'].includes(a.et.name) && !a.et.dims) fail('no suitable method found for sort(' + a.et.name + '[], Comparator): a Comparator needs an array of objects (Integer[], not int[])');
        if (from < 0 || to > a.a.length || from > to) throwJava('ArrayIndexOutOfBoundsException', `Array index out of range: ${to}`);
        const part = mergeSort(a.a.slice(from, to), cmpWith(cmp));
        part.forEach((x, k) => { a.a[from + k] = x; });
        return VOID;
      }
      case 'fill': {
        const from = args.length === 4 ? toInt(args[1]) : 0, to = args.length === 4 ? toInt(args[2]) : a.a.length, v = args.at(-1);
        for (let k = from; k < to; k++) a.a[k] = api.coerce(v, a.et, 'the value');
        return VOID;
      }
      case 'asList': { const l = new JList('Arrays.ArrayList', args.length === 1 && a instanceof JArr && !['int', 'long', 'double', 'char', 'boolean'].includes(a.et.name) ? a.a : args.slice()); l.frozen = 'fixed'; return l; }
      case 'copyOf': { const n = toInt(args[1]); return new JArr(a.et, Array.from({ length: n }, (_, k) => (k < a.a.length ? a.a[k] : api.defaultOf(a.et)))); }
      case 'copyOfRange': { const f = toInt(args[1]), t = toInt(args[2]); if (f < 0 || f > a.a.length) throwJava('ArrayIndexOutOfBoundsException', `Array index out of range: ${f}`); return new JArr(a.et, Array.from({ length: t - f }, (_, k) => (f + k < a.a.length ? a.a[f + k] : api.defaultOf(a.et)))); }
      case 'equals': return a === args[1] || (a !== null && args[1] !== null && a.a.length === args[1].a.length && a.a.every((x, k) => api.sameValue(x, args[1].a[k]) || equalsV(x, args[1].a[k])));
      case 'hashCode': return a === null ? 0 : a.a.reduce((h, x) => (Math.imul(h, 31) + hashOf(x)) | 0, 1);
      case 'binarySearch': {
        let lo = 0, hi = a.a.length - 1;
        const key = args[1], cmp = cmpWith(args[2] || null);
        while (lo <= hi) { const m = (lo + hi) >>> 1, c = cmp(box(a.a[m]), box(key)); if (c < 0) lo = m + 1; else if (c > 0) hi = m - 1; else return m; }
        return -(lo + 1);
      }
      case 'stream': fail('streams (Arrays.stream(…)…) are not supported here: use a loop');
    }
    void e;
    fail(`cannot find symbol: method ${name}(…) in class Arrays`);
  }
  function collectionsCall(name, args, e) {
    const l = args[0];
    switch (name) {
      case 'sort': l.mutable(); l.a = mergeSort(l.a, cmpWith(args[1] || null)); return VOID;
      case 'reverse': l.mutable(); l.a.reverse(); return VOID;
      case 'shuffle': { l.mutable(); const r = args[1] || sharedRandom(); for (let k = l.a.length - 1; k > 0; k--) { const j = r.nextInt(k + 1); [l.a[k], l.a[j]] = [l.a[j], l.a[k]]; } return VOID; }
      case 'swap': { const i = toInt(args[1]), j = toInt(args[2]); l.check(i); l.check(j); [l.a[i], l.a[j]] = [l.a[j], l.a[i]]; return VOID; }
      case 'max': case 'min': {
        const xs = elems(l);
        if (!xs.length) throwJava('NoSuchElementException', null);
        const cmp = cmpWith(args[1] || null);
        return xs.reduce((best, x) => ((name === 'max' ? cmp(x, best) > 0 : cmp(x, best) < 0) ? x : best));
      }
      case 'frequency': return elems(l).filter(x => equalsV(x, args[1])).length;
      case 'reverseOrder': return args[0] ? comparator((a, b) => cmpWith(args[0])(b, a), 'reverseOrder') : comparator((a, b) => compareV(b, a), 'reverseOrder');
      case 'emptyList': { const x = new JList('EmptyList'); x.frozen = 'immutable'; return x; }
      case 'emptyMap': { const m = new JMap('LinkedHashMap'); m.frozen = true; return m; }
      case 'emptySet': { const s = new JSet('LinkedHashSet'); s.m.frozen = true; return s; }
      case 'singletonList': case 'nCopies': { const x = new JList('ImmutableList', name === 'nCopies' ? Array(toInt(args[0])).fill(args[1]) : [args[0]]); x.frozen = 'immutable'; return x; }
      case 'unmodifiableList': { const x = new JList('UnmodifiableList', l.a); x.frozen = 'immutable'; return x; }
      case 'unmodifiableMap': case 'unmodifiableSet': return l;
      case 'addAll': for (const x of args.slice(1)) listAdd(l, x); return true;
      case 'fill': l.a.fill(args[1]); return VOID;
    }
    void e;
    fail(`cannot find symbol: method ${name}(…) in class Collections`);
  }

  /* ---- instance methods ---- */
  const listAdd = (c, x) => { if (c instanceof JList) { c.mutable(); c.a.push(x); return true; } if (c instanceof JSet) return setAdd(c, x); if (c instanceof JDeque) { notNull(x, 'add'); c.a.push(x); c.mod++; return true; } if (c instanceof JPQ) { pqOffer(c, x); return true; } fail('cannot add to ' + typeOfValue(c)); };
  const setAdd = (s, x) => { if (s.m.frozen) throwJava('UnsupportedOperationException', 'this set cannot be changed (Set.of makes an unmodifiable set)'); if (s.m.get(x)) return false; s.m.put(x, true); return true; };
  const notNull = (x, what) => { if (x === null) throwJava('NullPointerException', `an ArrayDeque cannot hold null (${what})`); };
  const index = (l, v) => { for (let k = 0; k < l.a.length; k++) if (equalsV(l.a[k], v)) return k; return -1; };
  const isIntArg = v => kindOf(v) === 'int';
  function pqOffer(pq, x) {
    if (x === null) throwJava('NullPointerException', 'a PriorityQueue cannot hold null');
    let k = pq.q.length;
    pq.q.push(x); pq.mod++;
    while (k > 0) { const p = (k - 1) >>> 1, e = pq.q[p]; if (pq.cmp(x, e) >= 0) break; pq.q[k] = e; k = p; }
    pq.q[k] = x;
  }
  function pqRemoveAt(pq, i) {
    pq.mod++;
    const s = pq.q.length - 1;
    if (s === i) { pq.q.pop(); return; }
    const moved = pq.q.pop();
    let k = i;
    const half = pq.q.length >>> 1;
    while (k < half) { let child = 2 * k + 1, c = pq.q[child]; const r = child + 1; if (r < pq.q.length && pq.cmp(c, pq.q[r]) > 0) c = pq.q[child = r]; if (pq.cmp(moved, c) <= 0) break; pq.q[k] = c; k = child; }
    pq.q[k] = moved;
    if (pq.q[i] === moved) { let j = i; while (j > 0) { const p = (j - 1) >>> 1, e = pq.q[p]; if (pq.cmp(moved, e) >= 0) break; pq.q[j] = e; j = p; } pq.q[j] = moved; }
  }
  const empty = (what, ex = 'NoSuchElementException') => throwJava(ex, what);
  /** An object's iterator for for-each, which throws ConcurrentModificationException when the collection changes */
  function iterator(v, desc) {
    if (v instanceof JList) {
      let cursor = 0;
      const expect = v.mod;
      return () => {
        if (cursor === v.a.length) return { done: true };   // as Java's hasNext(): removing the second-last element ends the loop quietly
        if (v.mod !== expect) throwJava('ConcurrentModificationException', `${desc} was changed while a for-each loop was going through it (use an Iterator and its remove(), or removeIf)`);
        if (cursor > v.a.length) throwJava('ConcurrentModificationException', null);
        return { v: v.a[cursor++] };
      };
    }
    if (isColl(v) || v instanceof JMap) {
      if (v instanceof JMap) fail(`for-each over a Map: loop over ${desc}.entrySet(), ${desc}.keySet() or ${desc}.values()`);
      const items = elems(v).slice(), expect = v.mod;
      let k = 0;
      return () => {
        if (k >= items.length) return { done: true };
        if (v.mod !== expect) throwJava('ConcurrentModificationException', `${desc} was changed while a for-each loop was going through it`);
        return { v: items[k++] };
      };
    }
    if (v instanceof JStr) fail(`for-each over a String: loop over ${desc}.toCharArray()`);
    fail(`for-each not applicable to expression type ${typeOfValue(v)}`);
  }
  function explicitIterator(c) {
    if (c instanceof JList) {
      let cursor = 0, last = -1, expect = c.mod;
      return new JIter(() => { if (c.mod !== expect) throwJava('ConcurrentModificationException', null); if (cursor >= c.a.length) empty(null); last = cursor; return c.a[cursor++]; },
        () => cursor < c.a.length,
        () => { if (last < 0) throwJava('IllegalStateException', null); c.mutable(); c.a.splice(last, 1); cursor = last; last = -1; expect = c.mod; });
    }
    const items = elems(c).slice();
    let k = 0;
    return new JIter(() => { if (k >= items.length) empty(null); return items[k++]; }, () => k < items.length, () => {
      const x = items[k - 1];
      if (c instanceof JSet) c.m.remove(x);
      else if (c instanceof JView) { const en = c.part === 'e' ? x.en : c.map.order().find(en2 => (c.part === 'k' ? en2.k === x : en2.v === x)); c.map.remove(en.k); }
      else if (c instanceof JDeque) { c.a.splice(c.a.indexOf(x), 1); c.mod++; }
      else if (c instanceof JPQ) pqRemoveAt(c, c.q.indexOf(x));
    });
  }

  function callMethod(t, name, args, e) {
    const d = e && e.target ? srcOf(e.target) : 'it';
    if (t instanceof JStr) return stringMethod(t.s, name, args, d);
    if (t instanceof Box) return boxMethod(t, name, args);
    if (t instanceof JList) return listMethod(t, name, args, d);
    if (t instanceof JDeque) return dequeMethod(t, name, args, d);
    if (t instanceof JPQ) return pqMethod(t, name, args, d);
    if (t instanceof JMap) return mapMethod(t, name, args, d);
    if (t instanceof JSet) return setMethod(t, name, args, d);
    if (t instanceof JView) return viewMethod(t, name, args, d);
    if (t instanceof JEntry) {
      switch (name) { case 'getKey': return t.en.k; case 'getValue': return t.en.v; case 'setValue': { const o = t.en.v; t.en.v = args[0]; return o; } }
    }
    if (t instanceof JSB) return sbMethod(t, name, args, d);
    if (t instanceof Stream) return streamMethod(t, name, args);
    if (t instanceof JRandom) {
      switch (name) {
        case 'nextInt': return args.length === 2 ? toInt(args[0]) + t.nextInt(toInt(args[1]) - toInt(args[0])) : t.nextInt(args.length ? toInt(args[0]) : undefined);
        case 'nextDouble': return new Num(t.nextDouble());
        case 'nextBoolean': return t.next(1) !== 0;
        case 'nextLong': return BigInt.asIntN(64, (BigInt(t.next(32)) << 32n) + BigInt(t.next(32)));
        case 'setSeed': t.setSeed(unbox(args[0])); return VOID;
      }
    }
    if (t instanceof JIter) {
      switch (name) { case 'hasNext': return t.hasNextFn(); case 'next': return t.nextFn(); case 'remove': t.removeFn(); return VOID; }
    }
    if (t instanceof ClassRef) {
      if (name === 'getSimpleName' || name === 'getName') return jstr(t.name);
      return callStatic(t.name, name, args, e);
    }
    switch (name) {
      case 'toString': return jstr(toStr(t)); case 'equals': return equalsV(t, args[0]); case 'hashCode': return hashOf(t);
      case 'getClass': return new ClassRef(className(t));
      case 'stream': case 'parallelStream': fail('streams (.stream()…) are not supported here: use a loop');
    }
    fail(`cannot find symbol: method ${name}(${args.map(typeOfValue).join(', ')}) in ${className(t)}`);
  }
  const srcOf = e => (e.k === 'name' ? e.name : e.k === 'field' ? srcOf(e.e) + '.' + e.name : e.k === 'this' ? 'this' : e.k === 'call' ? srcOf(e.target || { k: 'name', name: '' }) + '.' + e.name + '()' : 'it');
  function stringMethod(s, name, args, d) {
    const idx = (k, n = s.length) => { if (k < 0 || k >= n) throwJava('StringIndexOutOfBoundsException', `Index ${k} out of bounds for length ${s.length}`); return k; };
    const tx = k => toStr(args[k]);
    switch (name) {
      case 'length': return s.length;
      case 'charAt': return s[idx(toInt(args[0], 'the index'))];
      case 'isEmpty': return s.length === 0;
      case 'isBlank': return s.trim().length === 0;
      case 'substring': case 'subSequence': {
        const b = toInt(args[0]), en = args[1] !== undefined ? toInt(args[1]) : s.length;
        if (b < 0 || en > s.length || b > en) throwJava('StringIndexOutOfBoundsException', `begin ${b}, end ${en}, length ${s.length}`);
        return jstr(s.slice(b, en));
      }
      case 'indexOf': case 'lastIndexOf': {
        const what = args[0] instanceof JStr ? args[0].s : kindOf(unbox(args[0])) === 'char' ? unbox(args[0]) : String.fromCharCode(toInt(args[0]));
        const from = args[1] !== undefined ? toInt(args[1]) : undefined;
        return name === 'indexOf' ? s.indexOf(what, from) : s.lastIndexOf(what, from);
      }
      case 'contains': return s.includes(tx(0));
      case 'startsWith': return s.startsWith(tx(0), args[1] !== undefined ? toInt(args[1]) : 0);
      case 'endsWith': return s.endsWith(tx(0));
      case 'equals': return args[0] instanceof JStr && args[0].s === s;
      case 'equalsIgnoreCase': return args[0] instanceof JStr && args[0].s.toLowerCase() === s.toLowerCase();
      case 'compareTo': return compareV(jstr(s), args[0]);
      case 'compareToIgnoreCase': return compareV(jstr(s.toLowerCase()), jstr(tx(0).toLowerCase()));
      case 'toUpperCase': return jstr(s.toUpperCase());
      case 'toLowerCase': return jstr(s.toLowerCase());
      case 'trim': return jstr(s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''));
      case 'strip': return jstr(s.trim());
      case 'stripLeading': return jstr(s.trimStart());
      case 'stripTrailing': return jstr(s.trimEnd());
      case 'concat': return jstr(s + tx(0));
      case 'repeat': { const n = toInt(args[0]); if (n < 0) throwJava('IllegalArgumentException', 'count is negative: ' + n); return jstr(s.repeat(n)); }
      case 'toCharArray': return new JArr({ name: 'char', dims: 0 }, [...s]);
      case 'chars': fail('streams (.chars()…) are not supported here: loop over ' + d + '.toCharArray()');
      // falls through
      case 'split': {
        const limit = args[1] !== undefined ? toInt(args[1]) : 0;
        let parts = s.split(javaRegex(tx(0)));
        if (s === '') return new JArr({ name: 'String', dims: 0 }, [jstr('')]);
        if (parts.length && parts[0] === '' && s.length && !javaRegex(tx(0)).test('')) { /* a leading empty string stays, as in Java, unless the match was empty */ }
        if (limit > 0 && parts.length > limit) { const re = javaRegex(tx(0), 'g'); let m, count = 0, last = 0; const out = []; while (count < limit - 1 && (m = re.exec(s))) { out.push(s.slice(last, m.index)); last = m.index + m[0].length; count++; if (!m[0].length) re.lastIndex++; } out.push(s.slice(last)); parts = out; }
        else if (limit === 0) while (parts.length > 1 && parts.at(-1) === '') parts.pop();
        return new JArr({ name: 'String', dims: 0 }, parts.map(jstr));
      }
      case 'replace': return jstr(s.split(tx(0)).join(tx(1)));
      case 'replaceAll': return jstr(s.replace(javaRegex(tx(0), 'g'), tx(1)));
      case 'replaceFirst': return jstr(s.replace(javaRegex(tx(0)), tx(1)));
      case 'matches': return new RegExp('^(?:' + javaRegex(tx(0)).source + ')$').test(s);
      case 'hashCode': return strHash(s);
      case 'intern': return str(s);
      case 'toString': return jstr(s);
      case 'codePointAt': return s.charCodeAt(idx(toInt(args[0])));
      case 'format': case 'formatted': return jstr(format(s, args));
      case 'lines': fail('streams (.lines()…) are not supported here: use split("\\n")');
    }
    fail(`cannot find symbol: method ${name}(…) in String` + (name === 'size' ? ' (a String has length())' : name === 'get' ? ' (a String has charAt(i))' : ''));
  }
  const javaRegex = (r, flags = '') => { try { return new RegExp(r.replace(/\\p\{Alpha\}/g, '[A-Za-z]').replace(/\\p\{Punct\}/g, '[!-\\/:-@\\[-`{-~]'), flags); } catch { throwJava('PatternSyntaxException', 'the regular expression "' + r + '" is not valid'); } };
  function boxMethod(b, name, args) {
    const v = b.v;
    switch (name) {
      case 'intValue': return api.castTo({ name: 'int', dims: 0 }, v);
      case 'longValue': return api.castTo({ name: 'long', dims: 0 }, v);
      case 'doubleValue': return api.castTo({ name: 'double', dims: 0 }, v);
      case 'floatValue': return api.castTo({ name: 'float', dims: 0 }, v);
      case 'shortValue': return api.castTo({ name: 'short', dims: 0 }, v);
      case 'byteValue': return api.castTo({ name: 'byte', dims: 0 }, v);
      case 'charValue': case 'booleanValue': return v;
      case 'compareTo': case 'compare': return compareV(b, args[0]);
      case 'equals': return equalsV(b, args[0]);
      case 'hashCode': return hashOf(b);
      case 'toString': return jstr(toStr(b));
      case 'isNaN': return Number.isNaN(v.v);
    }
    fail(`cannot find symbol: method ${name}(…) in ${b.k}` + (kindOf(v) !== 'ref' && ['length', 'size'].includes(name) ? '' : ''));
  }
  function listMethod(l, name, args, d) {
    const A = l.a;
    switch (name) {
      case 'add': case 'addLast': case 'offer': case 'offerLast':
        if (args.length === 2) { const k = toInt(args[0]); if (k < 0 || k > A.length) throwJava('IndexOutOfBoundsException', `Index: ${k}, Size: ${A.length}`); l.mutable(); A.splice(k, 0, args[1]); return VOID; }
        l.mutable(); A.push(args[0]); return name === 'addLast' ? VOID : true;
      case 'addFirst': case 'offerFirst': case 'push': l.mutable(); if (l.kind === 'Stack') { A.push(args[0]); return args[0]; } A.unshift(args[0]); return name === 'offerFirst' ? true : VOID;
      case 'get': { const k = toInt(args[0], 'the index'); l.check(k); return A[k]; }
      case 'set': { const k = toInt(args[0], 'the index'); l.check(k); if (l.frozen === 'immutable') l.mutable(); const o = A[k]; A[k] = args[1]; return o; }
      case 'size': return A.length;
      case 'isEmpty': case 'empty': return A.length === 0;
      case 'contains': return index(l, args[0]) >= 0;
      case 'indexOf': return index(l, args[0]);
      case 'lastIndexOf': { for (let k = A.length - 1; k >= 0; k--) if (equalsV(A[k], args[0])) return k; return -1; }
      case 'remove':
        if (!args.length) { if (!A.length) empty(null); l.mutable(); return A.shift(); }
        if (isIntArg(args[0])) { const k = args[0]; l.check(k); l.mutable(); return A.splice(k, 1)[0]; }   // remove(int index): an int is an index, an Integer a value
        { const k = index(l, args[0]); if (k < 0) return false; l.mutable(); A.splice(k, 1); return true; }
      case 'removeFirst': case 'pollFirst': case 'poll': case 'pop':
        if (l.kind === 'Stack' && name === 'pop') { if (!A.length) empty(null, 'EmptyStackException'); l.mutable(); return A.pop(); }
        if (!A.length) { if (name.startsWith('poll')) return null; empty(null); }
        l.mutable(); return A.shift();
      case 'removeLast': case 'pollLast': if (!A.length) { if (name === 'pollLast') return null; empty(null); } l.mutable(); return A.pop();
      case 'peek': case 'peekFirst': case 'element': case 'getFirst':
        if (l.kind === 'Stack' && name === 'peek') { if (!A.length) empty(null, 'EmptyStackException'); return A.at(-1); }
        if (!A.length) { if (name.startsWith('peek')) return null; empty(null); } return A[0];
      case 'peekLast': case 'getLast': case 'lastElement': if (!A.length) { if (name === 'peekLast') return null; empty(null); } return A.at(-1);
      case 'firstElement': if (!A.length) empty(null); return A[0];
      case 'search': { for (let k = A.length - 1; k >= 0; k--) if (equalsV(A[k], args[0])) return A.length - k; return -1; }
      case 'clear': l.mutable(); A.length = 0; return VOID;
      case 'addAll': {
        if (args.length === 2) { const k = toInt(args[0]); l.mutable(); A.splice(k, 0, ...elems(args[1])); return true; }
        const xs = elems(args[0]).slice(); if (!xs.length) return false; l.mutable(); A.push(...xs); return true;
      }
      case 'removeAll': case 'retainAll': { const xs = elems(args[0]); const keep = A.filter(x => (name === 'retainAll') === xs.some(y => equalsV(x, y))); const ch = keep.length !== A.length; if (ch) { l.mutable(); l.a = keep; } return ch; }
      case 'containsAll': return elems(args[0]).every(x => index(l, x) >= 0);
      case 'removeIf': { const keep = A.filter(x => !api.truthy(callFn(args[0], [x], 'test'))); const ch = keep.length !== A.length; if (ch) { l.mutable(); l.a = keep; } return ch; }
      case 'replaceAll': l.mutable(); l.a = A.map(x => callFn(args[0], [x], 'apply')); return VOID;
      case 'forEach': { const expect = l.mod; for (const x of A.slice()) { if (l.mod !== expect) throwJava('ConcurrentModificationException', null); callFn(args[0], [x], 'accept'); } return VOID; }
      case 'sort': l.mutable(); l.a = mergeSort(A, cmpWith(args[0] || null)); return VOID;
      case 'subList': { const f = toInt(args[0]), t = toInt(args[1]); if (f < 0 || t > A.length || f > t) throwJava('IndexOutOfBoundsException', `fromIndex: ${f}, toIndex: ${t}, size: ${A.length}`); return new JList('SubList', A.slice(f, t)); }
      case 'toArray': return new JArr({ name: 'Object', dims: 0 }, A.slice());
      case 'iterator': case 'listIterator': return explicitIterator(l);
      case 'reversed': return new JList(l.kind, A.slice().reverse());
      case 'equals': return libEquals(l, args[0]);
      case 'hashCode': return libHash(l);
      case 'toString': return jstr(libToStr(l));
      case 'stream': case 'parallelStream': fail('streams (.stream()…) are not supported here: use a loop');
      // falls through
      case 'length': fail(`cannot find symbol: method length() in ${l.kind} (a list has size())`);
    }
    fail(`cannot find symbol: method ${name}(…) in ${l.kind}` + (name === 'push' ? '' : ''));
    void d;
  }
  function dequeMethod(q, name, args, d) {
    const A = q.a, mod = () => { q.mod++; };
    switch (name) {
      case 'add': case 'addLast': case 'offer': case 'offerLast': notNull(args[0], name); mod(); A.push(args[0]); return name.startsWith('offer') || name === 'add' ? true : VOID;
      case 'addFirst': case 'offerFirst': case 'push': notNull(args[0], name); mod(); A.unshift(args[0]); return name === 'offerFirst' ? true : VOID;
      case 'poll': case 'pollFirst': if (!A.length) return null; mod(); return A.shift();
      case 'pollLast': if (!A.length) return null; mod(); return A.pop();
      case 'pop': case 'remove': case 'removeFirst':
        if (name === 'remove' && args.length) { const k = A.findIndex(x => equalsV(x, args[0])); if (k < 0) return false; mod(); A.splice(k, 1); return true; }
        if (!A.length) empty(null); mod(); return A.shift();
      case 'removeLast': if (!A.length) empty(null); mod(); return A.pop();
      case 'peek': case 'peekFirst': return A.length ? A[0] : null;
      case 'peekLast': return A.length ? A.at(-1) : null;
      case 'element': case 'getFirst': if (!A.length) empty(null); return A[0];
      case 'getLast': if (!A.length) empty(null); return A.at(-1);
      case 'size': return A.length;
      case 'isEmpty': return A.length === 0;
      case 'clear': mod(); A.length = 0; return VOID;
      case 'contains': return A.some(x => equalsV(x, args[0]));
      case 'iterator': return explicitIterator(q);
      case 'descendingIterator': { const xs = A.slice().reverse(); let k = 0; return new JIter(() => xs[k++], () => k < xs.length, () => {}); }
      case 'forEach': for (const x of A.slice()) callFn(args[0], [x], 'accept'); return VOID;
      case 'addAll': for (const x of elems(args[0])) { notNull(x, 'addAll'); A.push(x); } mod(); return true;
      case 'toString': return jstr(libToStr(q));
      case 'stream': fail('streams (.stream()…) are not supported here: use a loop');
      // falls through
      case 'get': fail(`cannot find symbol: method get(int) in ArrayDeque (a deque has no index: use peekFirst(), peekLast(), or a List)`);
    }
    void d;
    fail(`cannot find symbol: method ${name}(…) in ArrayDeque`);
  }
  function pqMethod(pq, name, args, d) {
    switch (name) {
      case 'add': case 'offer': pqOffer(pq, args[0]); return true;
      case 'poll': case 'remove':
        if (name === 'remove' && args.length) { const k = pq.q.findIndex(x => equalsV(x, args[0])); if (k < 0) return false; pqRemoveAt(pq, k); return true; }
        if (!pq.q.length) { if (name === 'poll') return null; empty(null); }
        { const top = pq.q[0]; pqRemoveAt(pq, 0); return top; }
      case 'peek': return pq.q.length ? pq.q[0] : null;
      case 'element': if (!pq.q.length) empty(null); return pq.q[0];
      case 'size': return pq.q.length;
      case 'isEmpty': return pq.q.length === 0;
      case 'clear': pq.q.length = 0; pq.mod++; return VOID;
      case 'contains': return pq.q.some(x => equalsV(x, args[0]));
      case 'addAll': for (const x of elems(args[0])) pqOffer(pq, x); return true;
      case 'iterator': return explicitIterator(pq);
      case 'toString': return jstr(libToStr(pq));
      case 'comparator': return pq.cmpFn;
      case 'toArray': return new JArr({ name: 'Object', dims: 0 }, pq.q.slice());
      case 'stream': fail('streams (.stream()…) are not supported here: use a loop');
    }
    void d;
    fail(`cannot find symbol: method ${name}(…) in PriorityQueue` + (name === 'push' || name === 'pop' ? ' (a PriorityQueue has offer() and poll())' : ''));
  }
  const treeOnly = (m, name) => { if (m.kind !== 'TreeMap' && m.kind !== 'TreeSet') fail(`cannot find symbol: method ${name}(…) in ${m.kind} (a TreeMap / TreeSet has it)`); };
  /** floor, ceiling, lower, higher in a sorted map's entries: the index, or -1 */
  function nearest(m, k, how) {
    const f = m.find(k);
    if (how === 'floor') return f.hit ? f.at : f.at - 1;
    if (how === 'ceiling') return f.hit ? f.at : f.at < m.e.length ? f.at : -1;
    if (how === 'lower') return f.at - 1;
    return f.hit ? (f.at + 1 < m.e.length ? f.at + 1 : -1) : f.at < m.e.length ? f.at : -1;
  }
  function mapMethod(m, name, args, d) {
    const tree = m.kind === 'TreeMap';
    switch (name) {
      case 'put': return m.put(args[0], args[1]);
      case 'get': { const en = m.get(args[0]); return en ? en.v : null; }
      case 'getOrDefault': { const en = m.get(args[0]); return en ? en.v : args[1]; }
      case 'containsKey': return !!m.get(args[0]);
      case 'containsValue': return m.e.some(en => equalsV(en.v, args[0]));
      case 'remove': return m.remove(args[0]);
      case 'size': return m.e.length;
      case 'isEmpty': return m.e.length === 0;
      case 'clear': m.e.length = 0; m.mod++; return VOID;
      case 'keySet': case 'navigableKeySet': return new JView(m, 'k');
      case 'values': return new JView(m, 'v');
      case 'entrySet': return new JView(m, 'e');
      case 'putIfAbsent': { const en = m.get(args[0]); if (en && en.v !== null) return en.v; m.put(args[0], args[1]); return null; }
      case 'computeIfAbsent': { const en = m.get(args[0]); if (en && en.v !== null) return en.v; const v = callFn(args[1], [args[0]], 'apply'); if (v !== null) m.put(args[0], v); return v; }
      case 'computeIfPresent': { const en = m.get(args[0]); if (!en || en.v === null) return null; const v = callFn(args[1], [args[0], en.v], 'apply'); if (v === null) m.remove(args[0]); else en.v = v; return v; }
      case 'compute': { const en = m.get(args[0]); const v = callFn(args[1], [args[0], en ? en.v : null], 'apply'); if (v === null) { if (en) m.remove(args[0]); } else m.put(args[0], v); return v; }
      case 'merge': { const en = m.get(args[0]); const v = en && en.v !== null ? callFn(args[2], [en.v, args[1]], 'apply') : args[1]; if (v === null) m.remove(args[0]); else m.put(args[0], v); return v; }
      case 'putAll': for (const en of args[0].order()) m.put(en.k, en.v); return VOID;
      case 'replace': { const en = m.get(args[0]); if (!en) return null; const o = en.v; en.v = args[1]; return o; }
      case 'forEach': { const expect = m.mod; for (const en of m.order().slice()) { if (m.mod !== expect) throwJava('ConcurrentModificationException', null); callFn(args[0], [en.k, en.v], 'accept'); } return VOID; }
      case 'equals': return libEquals(m, args[0]);
      case 'hashCode': return libHash(m);
      case 'toString': return jstr(libToStr(m));
    }
    if (tree || ['firstKey', 'lastKey', 'floorKey', 'ceilingKey', 'lowerKey', 'higherKey'].includes(name)) {
      treeOnly(m, name);
      const E = m.e, ent = i => (i >= 0 && i < E.length ? new JEntry(E[i]) : null), key = i => (i >= 0 && i < E.length ? E[i].k : null);
      switch (name) {
        case 'firstKey': if (!E.length) empty(null); return E[0].k;
        case 'lastKey': if (!E.length) empty(null); return E.at(-1).k;
        case 'firstEntry': return ent(0);
        case 'lastEntry': return ent(E.length - 1);
        case 'pollFirstEntry': { const x = ent(0); if (x) { E.shift(); m.mod++; } return x; }
        case 'pollLastEntry': { const x = ent(E.length - 1); if (x) { E.pop(); m.mod++; } return x; }
        case 'floorKey': case 'ceilingKey': case 'lowerKey': case 'higherKey': return key(nearest(m, args[0], name.replace('Key', '')));
        case 'floorEntry': case 'ceilingEntry': case 'lowerEntry': case 'higherEntry': return ent(nearest(m, args[0], name.replace('Entry', '')));
        case 'headMap': case 'tailMap': case 'subMap': {
          const r = new JMap('TreeMap', m.cmpFn);
          for (const en of E) {
            const c1 = m.cmp(en.k, args[0]);
            const inc = name === 'tailMap' ? (args[1] === undefined ? true : !!args[1]) : name === 'headMap' ? !!args[1] : (args[1] === undefined || typeof args[1] !== 'boolean' ? true : args[1]);
            const ok = name === 'headMap' ? c1 < 0 || (inc && c1 === 0) : name === 'tailMap' ? c1 > 0 || (inc && c1 === 0) : c1 >= 0 && m.cmp(en.k, args.length === 2 ? args[1] : args[2]) < 0;
            if (ok) r.put(en.k, en.v);
          }
          return r;
        }
        case 'descendingMap': { const r = new JMap('LinkedHashMap'); for (const en of [...E].reverse()) r.put(en.k, en.v); return r; }
        case 'descendingKeySet': { const l = new JList('ArrayList', [...E].reverse().map(en => en.k)); return l; }
      }
    }
    void d;
    fail(`cannot find symbol: method ${name}(…) in ${m.kind}` + (name === 'add' ? ' (a map has put(key, value))' : name === 'contains' ? ' (a map has containsKey and containsValue)' : name === 'length' ? ' (a map has size())' : ''));
  }
  function setMethod(s, name, args, d) {
    const m = s.m;
    switch (name) {
      case 'add': return setAdd(s, args[0]);
      case 'remove': return m.remove(args[0]) !== null;
      case 'contains': return !!m.get(args[0]);
      case 'size': return m.e.length;
      case 'isEmpty': return m.e.length === 0;
      case 'clear': m.e.length = 0; m.mod++; return VOID;
      case 'addAll': { let ch = false; for (const x of elems(args[0])) ch = setAdd(s, x) || ch; return ch; }
      case 'removeAll': { let ch = false; for (const x of elems(args[0])) ch = m.remove(x) !== null || ch; return ch; }
      case 'retainAll': { const keep = elems(args[0]); let ch = false; for (const en of [...m.e]) if (!keep.some(y => equalsV(en.k, y))) { m.remove(en.k); ch = true; } return ch; }
      case 'containsAll': return elems(args[0]).every(x => !!m.get(x));
      case 'removeIf': { let ch = false; for (const en of [...m.e]) if (api.truthy(callFn(args[0], [en.k], 'test'))) { m.remove(en.k); ch = true; } return ch; }
      case 'iterator': return explicitIterator(s);
      case 'forEach': for (const x of elems(s)) callFn(args[0], [x], 'accept'); return VOID;
      case 'equals': return libEquals(s, args[0]);
      case 'hashCode': return libHash(s);
      case 'toString': return jstr(libToStr(s));
      case 'toArray': return new JArr({ name: 'Object', dims: 0 }, elems(s));
      case 'stream': fail('streams (.stream()…) are not supported here: use a loop');
    }
    if (s.kind === 'TreeSet' || ['first', 'last', 'floor', 'ceiling', 'lower', 'higher'].includes(name)) {
      treeOnly(s, name);
      const E = m.e, key = i => (i >= 0 && i < E.length ? E[i].k : null);
      switch (name) {
        case 'first': if (!E.length) empty(null); return E[0].k;
        case 'last': if (!E.length) empty(null); return E.at(-1).k;
        case 'floor': case 'ceiling': case 'lower': case 'higher': return key(nearest(m, args[0], name));
        case 'pollFirst': { const x = key(0); if (E.length) { E.shift(); m.mod++; } return x; }
        case 'pollLast': { const x = key(E.length - 1); if (E.length) { E.pop(); m.mod++; } return x; }
        case 'headSet': case 'tailSet': case 'subSet': {
          const r = new JSet('TreeSet', m.cmpFn);
          for (const en of E) {
            const c1 = m.cmp(en.k, args[0]);
            const ok = name === 'headSet' ? c1 < 0 || (args[1] === true && c1 === 0) : name === 'tailSet' ? c1 > 0 || (args[1] !== false && c1 === 0) : c1 >= 0 && m.cmp(en.k, args.length === 2 ? args[1] : args[2]) < 0;
            if (ok) r.m.put(en.k, true);
          }
          return r;
        }
        case 'descendingSet': { const r = new JSet('LinkedHashSet'); for (const en of [...E].reverse()) r.m.put(en.k, true); return r; }
      }
    }
    void d;
    fail(`cannot find symbol: method ${name}(…) in ${s.kind}` + (name === 'get' ? ' (a set has no index: use contains, or loop over it)' : ''));
  }
  function viewMethod(v, name, args) {
    const xs = v.items();
    switch (name) {
      case 'size': return xs.length;
      case 'isEmpty': return xs.length === 0;
      case 'contains': return v.part === 'k' ? !!v.map.get(args[0]) : xs.some(x => equalsV(x, args[0]));
      case 'iterator': return explicitIterator(v);
      case 'remove': if (v.part === 'k') return v.map.remove(args[0]) !== null; break;
      case 'removeIf': { let ch = false; for (const x of xs) if (api.truthy(callFn(args[0], [x], 'test'))) { v.map.remove(v.part === 'e' ? x.en.k : v.part === 'k' ? x : v.map.order().find(en => en.v === x).k); ch = true; } return ch; }
      case 'forEach': for (const x of xs) callFn(args[0], [x], 'accept'); return VOID;
      case 'toString': return jstr(libToStr(v));
      case 'toArray': return new JArr({ name: 'Object', dims: 0 }, xs);
      case 'equals': return libEquals(v, args[0]);
      case 'stream': fail('streams (.stream()…) are not supported here: use a loop');
    }
    fail(`cannot find symbol: method ${name}(…) in ${v.kind}` + (name === 'get' ? ' (a set of keys has no index: loop over it)' : ''));
  }
  function sbMethod(b, name, args, d) {
    const idx = (k, n = b.s.length) => { if (k < 0 || k >= n) throwJava('StringIndexOutOfBoundsException', `index ${k},length ${b.s.length}`); return k; };
    switch (name) {
      case 'append': b.s += args[0] instanceof JArr ? args[0].a.join('') : toStr(args[0]); return b;
      case 'insert': { const k = toInt(args[0]); if (k < 0 || k > b.s.length) throwJava('StringIndexOutOfBoundsException', `offset ${k}, length ${b.s.length}`); b.s = b.s.slice(0, k) + toStr(args[1]) + b.s.slice(k); return b; }
      case 'reverse': b.s = [...b.s].reverse().join(''); return b;
      case 'toString': return jstr(b.s);
      case 'length': return b.s.length;
      case 'charAt': return b.s[idx(toInt(args[0]))];
      case 'setCharAt': { const k = idx(toInt(args[0])); b.s = b.s.slice(0, k) + unbox(args[1]) + b.s.slice(k + 1); return VOID; }
      case 'deleteCharAt': { const k = idx(toInt(args[0])); b.s = b.s.slice(0, k) + b.s.slice(k + 1); return b; }
      case 'delete': { const f = toInt(args[0]), t = Math.min(toInt(args[1]), b.s.length); if (f < 0 || f > t) throwJava('StringIndexOutOfBoundsException', `start ${f}, end ${t}, length ${b.s.length}`); b.s = b.s.slice(0, f) + b.s.slice(t); return b; }
      case 'replace': { const f = toInt(args[0]), t = Math.min(toInt(args[1]), b.s.length); b.s = b.s.slice(0, f) + toStr(args[2]) + b.s.slice(t); return b; }
      case 'setLength': { const n = toInt(args[0]); b.s = n <= b.s.length ? b.s.slice(0, n) : b.s.padEnd(n, '\0'); return VOID; }
      case 'indexOf': return b.s.indexOf(toStr(args[0]), args[1] !== undefined ? toInt(args[1]) : 0);
      case 'lastIndexOf': return b.s.lastIndexOf(toStr(args[0]));
      case 'isEmpty': return b.s.length === 0;
      case 'substring': return jstr(b.s.slice(toInt(args[0]), args[1] !== undefined ? toInt(args[1]) : undefined));
      case 'equals': return b === args[0];
      case 'hashCode': return api.identityHash(b);
      case 'compareTo': return compareV(jstr(b.s), jstr(args[0].s));
      case 'chars': fail('streams are not supported here');
    }
    void d;
    fail(`cannot find symbol: method ${name}(…) in StringBuilder`);
  }
  function streamMethod(s, name, args) {
    switch (name) {
      case 'println': write((args.length ? (args[0] instanceof JArr && args[0].et.name === 'char' && !args[0].et.dims ? args[0].a.join('') : toStr(args[0])) : '') + '\n', s.err); return VOID;
      case 'print': if (!args.length) fail('no suitable method found for print(no arguments)'); write(args[0] instanceof JArr && args[0].et.name === 'char' ? args[0].a.join('') : toStr(args[0]), s.err); return VOID;
      case 'printf': case 'format': write(format(toStr(args[0]), args.slice(1)), s.err); return s;
      case 'flush': case 'close': return VOID;
      case 'write': write(String.fromCharCode(toInt(args[0])), s.err); return VOID;
    }
    fail(`cannot find symbol: method ${name}(…) in PrintStream` + (name === 'printLn' || name === 'printline' ? ' (it is println)' : ''));
  }

  /* ---- the views ---- */
  const className = v => (v && v.kind ? v.kind : typeOfValue(v));
  function ser(v, id, ctx, depth, serv) {
    const items = xs => { const n = Math.min(xs.length, 60); return { items: xs.slice(0, n).map(x => serv(x, ctx, depth + 1)), more: xs.length - n }; };
    if (v instanceof JList || v instanceof JDeque) return { t: 'arr', id, len: v.a.length, ...items(v.a), cls: v.kind.replace(/^.*\./, '') };
    if (v instanceof JPQ) return { t: 'arr', id, len: v.q.length, ...items(v.q), cls: 'PriorityQueue' };
    if (v instanceof JMap) { const es = v.order(), n = Math.min(es.length, 30); return { t: 'map', id, entries: es.slice(0, n).map(en => [serv(en.k, ctx, depth + 1), serv(en.v, ctx, depth + 1)]), more: es.length - n, cls: v.kind.replace(/^.*\./, '') }; }
    if (v instanceof JSet) { const xs = elems(v); return { t: 'set', id, ...items(xs), cls: v.kind.replace(/^.*\./, '') }; }
    if (v instanceof JView) { const xs = v.items(); return { t: v.part === 'v' ? 'arr' : 'set', id, len: xs.length, ...items(xs), cls: v.kind }; }
    if (v instanceof JEntry) return { t: 'obj', id, cls: 'Map.Entry', entries: [['key', serv(v.en.k, ctx, depth + 1)], ['value', serv(v.en.v, ctx, depth + 1)]], more: 0 };
    if (v instanceof JSB) return { t: 'p', k: 'str', s: JSON.stringify(v.s.length > 80 ? v.s.slice(0, 80) + '…' : v.s) };
    return { t: 'p', k: 'sym', s: className(v) };
  }
  const brief = v => (v instanceof JSB ? JSON.stringify(v.s.slice(0, 14)) : isColl(v) || v instanceof JMap ? className(v).replace(/^.*\./, '') + '(' + (v instanceof JMap ? v.e.length : elems(v).length) + ')' : className(v));
  const KINDS = { List: ['ArrayList', 'LinkedList', 'Vector', 'Stack', 'SubList', 'Arrays.ArrayList', 'ImmutableCollections.ListN', 'EmptyList', 'ImmutableList', 'UnmodifiableList'],
    Deque: ['ArrayDeque', 'LinkedList'], Queue: ['ArrayDeque', 'LinkedList', 'PriorityQueue'], Map: ['HashMap', 'LinkedHashMap', 'TreeMap', 'ImmutableCollections.MapN'],
    Set: ['HashSet', 'LinkedHashSet', 'TreeSet', 'ImmutableCollections.SetN', 'keySet', 'entrySet'], SortedMap: ['TreeMap'], NavigableMap: ['TreeMap'], SortedSet: ['TreeSet'], NavigableSet: ['TreeSet'] };
  function instanceOf(v, name) {
    if (v === null || v === undefined) return false;
    const k = v.kind;
    if (!k) return false;
    if (k === name) return true;
    if (KINDS[name] && KINDS[name].includes(k)) return true;
    if (name === 'Collection' || name === 'Iterable') return isColl(v);
    if (name === 'CharSequence') return v instanceof JSB;
    if (name === 'Map.Entry' || name === 'Entry') return v instanceof JEntry;
    return false;
  }

  return {
    knows: n => KNOWN.has(n), className, toStr: libToStr, equals: libEquals, hash: libHash, isList, isComparatorLike: () => false,
    callComparator: () => null, staticField, callStatic, staticOrUnbound, callMethod, fnMethod, construct, instanceOf, iterator, ser, brief,
    classOf: name => new ClassRef(name),
  };
}
