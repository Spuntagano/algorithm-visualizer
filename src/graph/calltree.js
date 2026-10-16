/**
 * The call tree: every call the run made, under the call that made it, built from the stacks of the steps. Drawn by
 * components/CallTree.jsx, step by step: the calls made so far, the ones still running (the stack) highlighted, and
 * what each finished call returned.
 *
 * A frame's `id` (given by the engines that know each call) tells two calls apart; a frame without one (Lua, PHP) is
 * the same call as the one at its place in the previous step's stack when it, and everything under it, has the same
 * name and arguments. `rets` (from the engine) maps a call id to what that call returned.
 */
import { P, runs } from './prims.js';

/**
 * @returns {{ nodes: { cid, name, args, label, parent, kids, depth, first, last, ret, repeat }[], paths: number[][],
 *   recursive: boolean }}  paths[s]: the nodes on the stack at step s, outermost first
 */
export function callTree(steps, rets = {}) {
  const nodes = [], paths = [], byKey = new Map();
  let recursive = false, prev = [];
  steps.forEach((st, s) => {
    const cur = []; let same = true;
    const names = new Set();
    st.stack.forEach((f, i) => {
      if (names.has(f.name)) recursive = true;
      names.add(f.name);
      const p = prev[i];
      same = same && p !== undefined && (f.id != null ? nodes[p].cid === f.id : nodes[p].cid == null && nodes[p].name === f.name && nodes[p].args === f.args);
      if (same) { nodes[p].last = s; cur.push(p); return; }
      const key = f.name + '(' + f.args + ')';
      const n = {
        cid: f.id, name: f.name, args: f.args, label: f.name + '(' + valuesOnly(f.args) + ')',
        parent: i ? cur[i - 1] : -1, kids: [], depth: i, first: s, last: s,
        ret: f.id != null && rets[f.id] !== undefined ? rets[f.id] : null,
        repeat: byKey.get(key) ?? -1,          // an earlier call with the same arguments (a repeated subproblem)
      };
      if (n.repeat < 0) byKey.set(key, nodes.length);
      if (i) nodes[cur[i - 1]].kids.push(nodes.length);
      cur.push(nodes.length); nodes.push(n);
    });
    paths.push(cur); prev = cur;
  });
  return { nodes, paths, recursive };
}

/** "n=3, memo={…}" → "3, {…}": the call reads like the code (fib(3)); the names stay in the frame's tooltip */
export const valuesOnly = args => args.replace(/(^|, )\$?[A-Za-z_]\w*=/g, '$1');

const CH = 7.4, PADX = 10, H = 42, GAPX = 14, GAPY = 34, PAD = 12, MAXW = 210;
const clipTo = (s, w) => (s.length * CH + 2 * PADX > w ? s.slice(0, Math.max(1, Math.floor((w - 2 * PADX) / CH) - 1)) + '…' : s);

/**
 * Lays the whole tree out once (so calls keep their places while stepping), parents centred over their children
 * (as far as their own subtree's width allows).
 * @returns {{ width, height, pos: { x, y, w }[] }}  pos[i]: the box of node i (x its left edge)
 */
export function layoutCallTree(tree) {
  const { nodes } = tree, pos = [], span = [];
  const boxW = n => Math.min(MAXW, Math.max(44, Math.max(n.label.length, n.ret != null ? n.ret.length + 2 : 0) * CH + 2 * PADX));
  const widthOf = i => {          // the subtree's width, children first (iteratively: recursion can be hundreds deep)
    const order = []; const st = [i];
    while (st.length) { const k = st.pop(); order.push(k); st.push(...nodes[k].kids); }
    for (let j = order.length - 1; j >= 0; j--) {
      const n = nodes[order[j]];
      const kids = n.kids.reduce((a, k, x) => a + span[k] + (x ? GAPX : 0), 0);
      span[order[j]] = Math.max(boxW(n), kids);
    }
    return span[i];
  };
  let left = PAD, depth = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parent !== -1) continue;
    widthOf(i);
    const st = [[i, left]], L = new Map(), order = [];
    while (st.length) {                          // each subtree's left edge, parents before children
      const [k, l] = st.pop(), n = nodes[k];
      L.set(k, l); order.push(k);
      depth = Math.max(depth, n.depth);
      const kids = n.kids.reduce((a, c, x) => a + span[c] + (x ? GAPX : 0), 0);
      let x = l + (span[k] - kids) / 2;
      for (const c of n.kids) { st.push([c, x]); x += span[c] + GAPX; }
    }
    for (let j = order.length - 1; j >= 0; j--) { // children before parents: a parent centred over its first and last child
      const k = order[j], n = nodes[k], w = boxW(n), l = L.get(k);
      const mid = n.kids.length ? (pos[n.kids[0]].x + pos[n.kids[0]].w / 2 + pos[n.kids.at(-1)].x + pos[n.kids.at(-1)].w / 2) / 2 : l + span[k] / 2;
      pos[k] = { x: Math.min(Math.max(mid - w / 2, l), l + span[k] - w), y: PAD + n.depth * (H + GAPY), w };
    }
    left += span[i] + GAPX * 2;
  }
  return { width: Math.max(left - GAPX * 2 + PAD, 0), height: PAD * 2 + (depth + 1) * H + depth * GAPY, pos };
}

/**
 * The drawing at step s: the calls made by then, the stack's calls marked (the current one most), the finished ones
 * with what they returned, a repeated call dashed.
 */
export function callTreeView(tree, layout, s) {
  const { nodes } = tree, path = new Set(tree.paths[s] || []), top = (tree.paths[s] || []).at(-1);
  const edges = [], boxes = [];
  let shown = 0, repeats = 0;
  nodes.forEach((n, i) => {
    if (n.first > s) return;
    shown++;
    const b = layout.pos[i], done = !path.has(i);   // shown and no longer on the stack: it has returned (or thrown)
    if (n.parent !== -1) {
      const pb = layout.pos[n.parent], x1 = pb.x + pb.w / 2, y1 = pb.y + H, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
      edges.push(P('path', { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, className: 'ct-edge' + (path.has(i) ? ' on' : '') }));
    }
    if (n.repeat >= 0) repeats++;
    const cls = 'ct-node' + (i === top ? ' cur' : path.has(i) ? ' on' : done ? ' done' : '') + (n.repeat >= 0 ? ' rep' : '');
    const ret = done && n.ret != null;
    const kids = [
      P('title', {}, n.name + '(' + n.args + ')' + (ret ? ' returned ' + n.ret : '') + (n.repeat >= 0 ? ' · called with the same arguments before' : '')),
      P('rect', { x: b.x, y: b.y, width: b.w, height: H, rx: 8, className: cls }),
      P('text', { x: b.x + b.w / 2, y: b.y + (ret ? 17 : 25), textAnchor: 'middle', className: 'ct-label' }, clipTo(n.label, b.w)),
    ];
    if (ret) kids.push(runs({ x: b.x + b.w / 2, y: b.y + 33, textAnchor: 'middle', className: 'ct-ret' }, [P('tspan', { className: 'ct-arrow' }, '→ '), P('tspan', {}, clipTo(n.ret, b.w - 16))]));
    boxes.push({ tag: 'g', p: { 'data-call': i, className: 'ct-g' + (i === top ? ' cur' : '') }, kids });
  });
  return {
    width: layout.width, height: layout.height, prims: [...edges, ...boxes], shown, repeats, top,
    caption: `${shown} call${shown === 1 ? '' : 's'} so far` + (repeats ? ` · ${repeats} repeated (dashed: same arguments as an earlier call)` : ''),
  };
}
