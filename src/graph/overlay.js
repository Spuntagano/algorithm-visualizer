/**
 * The "Graph" view, part 2: other variables shown as tags on the nodes they point at (↑ cur)
 * or contain (∈ visited), and the node sizing that leaves room for them.
 */
import { isCont, keyOf, stepIndex } from '../model.js';

/* Other variables that point at, or contain, graph nodes: shown as small tags on those nodes. */
export function semTags(step, sem, graphName) {
  const tags = new Map(), { resolve } = stepIndex(step), prim = sem.keyKind === 'prim';
  const add = (k, nm, kind) => {
    if (!tags.has(k)) tags.set(k, []);
    const a = tags.get(k); if (!a.some(t => t.name === nm)) a.push({ name: nm, kind });
  };
  const keyFor = n => {
    if (prim) return n.t === 'p' && (n.k === 'str' || n.k === 'num') && sem.map.has(String(keyOf(n))) ? String(keyOf(n)) : null;
    return (n.t === 'ref' || n.t === 'trunc' || isCont(n)) && sem.map.has(String(n.id)) ? String(n.id) : null;
  };
  step.vars.forEach(w => {
    if (w.name === graphName) return;
    const k = keyFor(w.node);
    if (k != null) { add(k, w.name, 'ptr'); return; }
    const c = resolve(w.node);
    if (c && (c.t === 'arr' || c.t === 'set') && c.id !== sem.rootId) c.items.forEach(it => { const kk = keyFor(it); if (kk != null) add(kk, w.name, 'in'); });
  });
  tags.forEach(a => a.sort((x, y) => (x.kind === 'ptr' ? 0 : 1) - (y.kind === 'ptr' ? 0 : 1)));
  return tags;
}

export function sizeNode(n, tags) {
  const shown = tags.slice(0, 3), more = tags.length - shown.length;
  n.pills = shown.map(t => ({ s: (t.kind === 'ptr' ? '↑ ' : '∈ ') + t.name, tag: t }));
  if (more > 0) n.pills.push({ s: '+' + more, tag: null });
  n.w = Math.max(40, n.label.length * 8.8 + 22, n.caption.length * 6.3 + 20, ...n.pills.map(q => q.s.length * 6.4 + 22));
  n.h = Math.max(34, 8 + 18 + (n.caption ? 14 : 0) + n.pills.length * 16 + (n.pills.length ? 4 : 0) + 6);
}
