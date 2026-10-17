/**
 * The Heap view: an array drawn as the binary tree it stands for, the children of the k-th cell (counting from the
 * first, whatever the array's base) at 2k + 1 and 2k + 2. Its cells are plain values or short tuples ((priority,
 * item), as Dijkstra keeps them). The array is repeated as a strip under the tree, so position and index go together.
 *
 * What is marked: the cells that changed since the previous step (a swap shows as two), the variables that hold an
 * index (i, parent, child, left, right, smallest, largest…), the cells past the heap's size when a variable like `size`
 * or `n` says it is smaller than the array (heapsort's sorted end), and in red each parent out of order with its child.
 * Whether it is a min- or a max-heap comes from the variable's name, else from how most parents compare with their
 * children over the whole run (the order holds between operations, so it wins even mid-swap).
 */
import { idBgFill, idFill } from '../color.js';
import { markersFor, stepIndex } from '../model.js';
import { P } from './prims.js';

/** The most cells drawn: seven levels. */
export const MAX_ITEMS = 127;
/** A variable with one of these names is shown as a heap until its switch says otherwise. */
export const HEAPISH = /heap|^pq$|^prio|priority/i;
const bare = name => name.replace(/^[$@]+/, '');   // PHP's $heap is heap
/** Names that hold how much of the array is the heap, most specific first. */
const SIZES = ['heapsize', 'heap_size', 'size', 'n', 'count', 'cnt', 'len', 'length', 'end'];
/** Names that hold a position in the heap (tagged on the tree); a value (x, top, last…) never is. */
const INDEXISH = /^(i|j|p|c|l|r|pos|cur|curr|parent|child|kid|left|right|lc|rc|smallest|largest|biggest|root)$|(idx|index)$/i;

export const isHeapName = name => HEAPISH.test(bare(name));

/** A cell's sort key and label: a plain value, or a tuple / short array of them. */
function cellOf(n) {
  if (n.t === 'p') return n.k === 'num' || n.k === 'str' || n.k === 'char' || n.k === 'bool' ? { key: keyOfPrim(n), s: n.s } : null;
  if (n.t === 'arr' && n.items.length >= 1 && n.items.length <= 3 && !n.more && n.items.every(x => x.t === 'p')) {
    const [o, c] = n.cls === 'tuple' ? ['(', ')'] : ['[', ']'];
    return { key: n.items.map(keyOfPrim), s: o + n.items.map(x => x.s).join(', ') + c };
  }
  return null;
}
const keyOfPrim = p => (p.k === 'num' ? Number(p.s) : p.k === 'bool' ? (p.s === 'true' || p.s === 'True' ? 1 : 0) : p.s);

/** Like the languages' own comparison: numbers as numbers, text as text, tuples item by item. */
export function compare(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = [].concat(a), y = [].concat(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = compare(x[i], y[i]); if (c) return c; }
    return x.length - y.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * @returns {{ id, items: { key, s }[], base: number, len: number, more: number } | null}  null when the variable is not
 *   an array of plain values or short tuples (an empty array is a heap with nothing in it yet)
 */
export function heapOf(step, name) {
  const v = step && step.vars.find(x => x.name === name);
  if (!v) return null;
  const { resolve } = stepIndex(step);
  const arr = resolve(v.node);
  if (!arr || arr.t !== 'arr') return null;
  const items = [];
  for (const it of arr.items) {
    const c = cellOf(it.t === 'ref' ? resolve(it) || it : it);
    if (!c) return null;
    items.push(c);
  }
  return { id: arr.id, items, base: arr.base || 0, len: items.length, more: arr.more || 0 };
}

/** How many cells are the heap: a size-like variable smaller than the array, else all of them. { size, by } */
export function heapSize(heap, vars) {
  for (const want of SIZES) {
    const v = vars.find(x => bare(x.name).toLowerCase() === want && x.node.t === 'p' && x.node.k === 'num' && /^\d+$/.test(x.node.s));
    if (v && +v.node.s < heap.len) return { size: +v.node.s, by: bare(v.name) };
  }
  return { size: heap.len, by: null };
}

/** The positions tagged by index variables: { k: [names] } (k counted from 0, the tree's own numbering). */
export function heapMarkers(heap, vars, selfName) {
  return markersFor({ id: null, items: new Array(heap.len), base: heap.base }, vars.filter(v => INDEXISH.test(bare(v.name))), selfName);
}

/** Parent-child pairs within the first `size` cells, by how they compare: { le: parent ≤ child, ge: parent ≥ child }. */
function votes(items, size) {
  let le = 0, ge = 0;
  for (let k = 1; k < size; k++) {
    const c = compare(items[(k - 1) >> 1].key, items[k].key);
    if (c < 0) le++; else if (c > 0) ge++;
  }
  return { le, ge };
}

const kinds = new WeakMap();
/**
 * 'min' or 'max': from the name (minHeap, max_heap), else from every step of the run (steps, when given) or this one.
 * Equal values vote for neither; a tie is a min-heap, the more common kind.
 */
export function heapKind(name, steps, step) {
  if (/max/i.test(name)) return 'max';
  if (/min/i.test(name)) return 'min';
  let cache = steps && kinds.get(steps);
  if (cache && cache.has(name)) return cache.get(name);
  let le = 0, ge = 0;
  const stride = steps ? Math.max(1, Math.floor(steps.length / 2000)) : 1;   // a long run: a sample is enough
  const list = steps || [step];
  for (let s = 0; s < list.length; s += stride) {
    const st = list[s], h = heapOf(st, name);
    if (!h) continue;
    const vt = votes(h.items, heapSize(h, st.vars).size);
    le += vt.le; ge += vt.ge;
  }
  const kind = ge > le ? 'max' : 'min';
  if (steps) { if (!cache) kinds.set(steps, cache = new Map()); cache.set(name, kind); }
  return kind;
}

const CH = 7.6, PADX = 9, H = 30, GAPX = 10, GAPY = 38, PAD = 14, MINW = 34, MAXW = 132, CELLGAP = 4, STRIP = 30;
const clipTo = (s, w) => (s.length * CH + 2 * PADX > w ? s.slice(0, Math.max(1, Math.floor((w - 2 * PADX) / CH) - 1)) + '…' : s);

/**
 * The drawing: the tree, then the array as a strip of numbered cells.
 * @param heap     from heapOf()
 * @param o.prev   the same heap at the previous step (from heapOf, or null): its changed cells are marked
 * @param o.markers  from heapMarkers(), or null to tag nothing
 * @param o.size   from heapSize()
 * @param o.kind   'min' or 'max'
 * @returns {{ width, height, prims, caption, bad: number, changed: Set<number> }}
 */
export function buildHeapView(heap, { prev = null, markers = null, size = { size: heap.len, by: null }, kind = 'min' } = {}) {
  const items = heap.items.slice(0, MAX_ITEMS), n = items.length, live = Math.min(size.size, n);
  const changed = new Set();
  if (prev && prev.id === heap.id) items.forEach((it, k) => { if (!prev.items[k] || prev.items[k].s !== it.s) changed.add(k); });
  const caption = (kind === 'max' ? 'Max-heap' : 'Min-heap') + (n ? ` · ${live} item${live === 1 ? '' : 's'}` : ' · empty');
  if (!n) return { width: 220, height: 2 * PAD + H, prims: [P('text', { x: PAD, y: PAD + H / 2 + 4, className: 'hp-empty' }, 'Nothing in the heap yet')], caption, bad: 0, changed };

  const levels = Math.floor(Math.log2(n)) + 1, leaves = 2 ** (levels - 1);
  const w = Math.min(MAXW, Math.max(MINW, Math.max(...items.map(it => it.s.length)) * CH + 2 * PADX));
  const treeW = leaves * (w + GAPX) - GAPX, stripW = n * (w + CELLGAP) - CELLGAP;
  const width = Math.max(treeW, stripW) + 2 * PAD, x0 = PAD + (width - 2 * PAD - treeW) / 2;
  const at = k => {
    const d = Math.floor(Math.log2(k + 1)), q = k + 1 - 2 ** d, slot = (treeW + GAPX) / 2 ** d;
    return { x: x0 + q * slot + slot / 2 - w / 2, y: PAD + d * (H + GAPY) };
  };
  const better = kind === 'max' ? (a, b) => compare(a, b) >= 0 : (a, b) => compare(a, b) <= 0;
  const edges = [], nodes = [], strip = [];
  let bad = 0;
  items.forEach((it, k) => {
    const b = at(k), out = k >= live, tags = markers && markers[k];
    if (k) {
      const pk = (k - 1) >> 1, pb = at(pk), wrong = !out && !better(items[pk].key, it.key);
      if (wrong) bad++;
      edges.push(P('line', { x1: pb.x + w / 2, y1: pb.y + H, x2: b.x + w / 2, y2: b.y, className: 'hp-edge' + (wrong ? ' bad' : out ? ' out' : '') }));
    }
    const cls = (out ? ' out' : '') + (changed.has(k) ? ' chg' : '') + (tags ? ' at' : '');
    const idx = k + heap.base;
    const kids = [
      P('title', {}, `index ${idx}: ${it.s}` + (out ? ` (past ${size.by} = ${size.size}, not in the heap)` : '') + (tags ? ' · ' + tags.join(', ') : '')),
      P('rect', { x: b.x, y: b.y, width: w, height: H, rx: H / 2, className: 'hp-node' + cls }),
      P('text', { x: b.x + w / 2, y: b.y + H / 2 + 4.5, textAnchor: 'middle', className: 'hp-label' }, clipTo(it.s, w)),
    ];
    if (tags) {
      const label = tags.join(', ');
      const tw = label.length * 6.6 + 10;
      const pill = { x: b.x + w / 2 - tw / 2, y: b.y + H + 4, width: tw, height: 16, rx: 4 };
      kids.push(P('rect', { ...pill, className: 'hp-tag-bg' }));   // opaque, so the edges under it do not show through
      kids.push(P('rect', { ...pill, style: idBgFill(tags[0]) }));
      kids.push(P('text', { x: b.x + w / 2, y: b.y + H + 16, textAnchor: 'middle', className: 'hp-tag', style: idFill(tags[0]) }, label));
    }
    nodes.push({ tag: 'g', p: { 'data-heap': k, className: 'hp-g' + cls }, kids });
  });
  const sy = PAD + levels * (H + GAPY) + 6, sx = PAD + (width - 2 * PAD - stripW) / 2;
  items.forEach((it, k) => {
    const x = sx + k * (w + CELLGAP), out = k >= live, cls = (out ? ' out' : '') + (changed.has(k) ? ' chg' : '') + (markers && markers[k] ? ' at' : '');
    strip.push(P('text', { x: x + w / 2, y: sy + 9, textAnchor: 'middle', className: 'hp-idx' + (markers && markers[k] ? ' at' : '') }, String(k + heap.base)));
    strip.push(P('rect', { x, y: sy + 14, width: w, height: STRIP, rx: 5, className: 'hp-cell' + cls }));
    strip.push(P('text', { x: x + w / 2, y: sy + 14 + STRIP / 2 + 4.5, textAnchor: 'middle', className: 'hp-label' }, clipTo(it.s, w)));
  });
  if (live < n && live > 0) {                    // where the heap ends and the rest of the array begins
    const x = sx + live * (w + CELLGAP) - CELLGAP / 2;
    strip.push(P('line', { x1: x, y1: sy + 8, x2: x, y2: sy + 14 + STRIP + 6, className: 'hp-end' }));
  }
  const notes = [];
  if (live < n) notes.push(`${n - live} past ${size.by} (dashed)`);
  if (bad) notes.push(`${bad} parent${bad === 1 ? '' : 's'} out of order (red)`);
  if (heap.len > n || heap.more) notes.push(`first ${n} shown`);
  return {
    width, height: sy + 14 + STRIP + PAD, prims: [...edges, ...nodes, ...strip], bad, changed,
    caption: caption + (notes.length ? ' · ' + notes.join(' · ') : ''),
  };
}
