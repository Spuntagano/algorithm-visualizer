/**
 * Tidy-tree layout for trees and linked lists: parents sit centred over their children and subtrees
 * never overlap, so straight edges can never cross.
 */
import { G, labelSize } from './common.js';

/* Tidy tree: parents centred over their children, subtrees never overlap, so straight edges never cross. */
export function layoutTree(sem, sp, lr) {
  const PAD = G.PAD, GB = 22, PH = 34, FG = 36;
  const lab = sem.edges.filter(e => e.lines && e.lines.length).map(e => labelSize(e.lines));   // labels sit between levels
  const GD = (lr ? 64 : 54) + Math.max(0, ...lab.map(l => (lr ? l.width : l.height) - (lr ? 40 : 24)));
  const bre = n => (lr ? n.h : n.w), dep = n => (lr ? n.w : n.h);
  const binary = sem.edges.length > 0 && sem.edges.every(e => e.label === 'left' || e.label === 'right');
  const slotsOf = n => {
    const kids = sp.treeKids.get(n.key);
    if (!kids.length) return [];
    if (!binary) return kids.map(k => k.key);
    const Lk = kids.find(k => sem.edges[k.i].label === 'left'), Rk = kids.find(k => sem.edges[k.i].label === 'right');
    return Lk && Rk ? [Lk.key, Rk.key] : Lk ? [Lk.key, null] : [null, Rk.key];
  };
  const sw = new Map(), cb = new Map(), lvl = new Map();
  const span = k => {
    const n = sem.map.get(k); let sum = 0;
    slotsOf(n).forEach((c, j) => { sum += (c ? span(c) : PH) + (j ? GB : 0); });
    sw.set(k, Math.max(bre(n), sum)); return sw.get(k);
  };
  const assign = (k, left, d) => {
    const n = sem.map.get(k), slots = slotsOf(n); lvl.set(k, d);
    if (!slots.length) { cb.set(k, left + sw.get(k) / 2); return; }
    let total = 0; slots.forEach((c, j) => { total += (c ? sw.get(c) : PH) + (j ? GB : 0); });
    let x = left + (sw.get(k) - total) / 2; const centers = [];
    slots.forEach(c => { if (c) { assign(c, x, d + 1); centers.push(cb.get(c)); } x += (c ? sw.get(c) : PH) + GB; });
    cb.set(k, slots.includes(null) ? left + sw.get(k) / 2 : (centers[0] + centers[centers.length - 1]) / 2);
  };
  let cur = PAD;
  sp.roots.forEach(r => { span(r); assign(r, cur, 0); cur += sw.get(r) + FG; });
  const thick = []; sem.nodes.forEach(n => { thick[lvl.get(n.key)] = Math.max(thick[lvl.get(n.key)] || 0, dep(n)); });
  const D = [PAD]; for (let d = 1; d < thick.length; d++) D[d] = D[d - 1] + thick[d - 1] + GD;
  sem.nodes.forEach(n => {
    const c = cb.get(n.key), d = D[lvl.get(n.key)];
    if (lr) { n.y = c - n.h / 2; n.x = d; } else { n.x = c - n.w / 2; n.y = d; }
  });
  const edges = sem.edges.map(e => {
    const f = sem.map.get(e.from), t = sem.map.get(e.to);
    const [a, b] = lvl.get(e.from) <= lvl.get(e.to) ? [f, t] : [t, f];
    const A = lr ? [a.x + a.w, a.y + a.h / 2] : [a.x + a.w / 2, a.y + a.h];
    const B = lr ? [b.x, b.y + b.h / 2] : [b.x + b.w / 2, b.y];
    return { e, d: 'M' + A + ' L' + B, lx: (A[0] + B[0]) / 2, ly: (A[1] + B[1]) / 2 };
  });
  return { width: Math.max(...sem.nodes.map(n => n.x + n.w)) + PAD, height: Math.max(...sem.nodes.map(n => n.y + n.h)) + PAD, edges };
}
