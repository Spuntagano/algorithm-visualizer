/**
 * The "Graph" view, part 2: other variables shown as tags on the nodes they point at (↑ cur) or contain
 * (∈ visited), the rows of a node's own values, and the node sizing that leaves room for both.
 */
import { isCont, isText, keyOf, stepIndex } from '../model.js';

const MAX_ROWS = 8;     // value rows inside one node, before "+N more"
export const ROW_H = 15;

/* Other variables that point at, or contain, graph nodes: shown as small tags on those nodes. */
export function semTags(step, sem, graphName) {
  const tags = new Map(), { resolve } = stepIndex(step), prim = sem.keyKind === 'prim';
  const add = (k, nm, kind) => {
    if (!tags.has(k)) tags.set(k, []);
    const a = tags.get(k); if (!a.some(t => t.name === nm)) a.push({ name: nm, kind });
  };
  const keyFor = n => {
    if (prim) return n.t === 'p' && (isText(n) || n.k === 'num') && sem.map.has(String(keyOf(n))) ? String(keyOf(n)) : null;
    return (n.t === 'ref' || n.t === 'trunc' || isCont(n)) && sem.map.has(String(n.id)) ? String(n.id) : null;
  };
  step.vars.forEach(w => {
    if (w.name === graphName) return;
    const k = keyFor(w.node);
    if (k != null) { add(k, w.name, 'ptr'); return; }
    const c = resolve(w.node);
    if (c && (c.t === 'arr' || c.t === 'set') && c.id !== sem.rootId) c.items.forEach(it => { const kk = keyFor(it); if (kk != null) add(kk, w.name, 'in'); });
    // a set written as a table of trues, visited = { A = true } (Lua's way; { A: true } in JavaScript)
    else if (c && c.t === 'obj' && c.id !== sem.rootId && c.entries.length && c.entries.every(([, x]) => x.t === 'p' && x.k === 'bool' && /^true$/i.test(x.s)))
      c.entries.forEach(([k]) => { const kk = keyFor({ t: 'p', k: 'str', s: JSON.stringify(k) }); if (kk != null) add(kk, w.name, 'in'); });
  });
  tags.forEach(a => a.sort((x, y) => (x.kind === 'ptr' ? 0 : 1) - (y.kind === 'ptr' ? 0 : 1)));
  return tags;
}

export function sizeNode(n, tags) {
  const shown = tags.slice(0, 3), more = tags.length - shown.length;
  n.pills = shown.map(t => ({ s: (t.kind === 'ptr' ? '↑ ' : '∈ ') + t.name, tag: t }));
  if (more > 0) n.pills.push({ s: '+' + more, tag: null });
  n.rows = nodeRows(n);
  n.keyW = Math.max(0, ...n.rows.map(r => r.k.length * 6.4));          // keys in one column, values in the next
  const rowW = Math.max(0, ...n.rows.map(r => (r.more ? 0 : n.keyW + 8) + r.text.length * 6.6));
  n.top = titleless(n) ? 6 : 26;                                      // room for the title, if there is one
  n.w = Math.max(40, titleless(n) ? 0 : n.label.length * 8.8 + 22, rowW + 20, ...n.pills.map(q => q.s.length * 6.4 + 22));
  n.h = Math.max(34, n.top + (n.rows.length ? n.rows.length * ROW_H + 4 : 0) + n.pills.length * 16 + (n.pills.length ? 4 : 0) + 6);
}

/**
 * A node whose label came from one of its fields, and that has other values too, lists every field as `key value`
 * (the label field first) instead of a title, so { id: 1, weight: 3 } reads "id 1 / weight 3". A node with nothing
 * but its label keeps the compact title.
 */
export const titleless = n => !!(n.labelField && n.fields && n.fields.length);

/** The rows drawn inside a node: its own values (capped at MAX_ROWS). Other variables never add rows. */
export function nodeRows(n) {
  const rows = titleless(n) ? [{ ...n.labelField, main: true }, ...n.fields] : (n.fields || []);
  return rows.length <= MAX_ROWS ? rows : [...rows.slice(0, MAX_ROWS - 1), { k: '', text: '+' + (rows.length - MAX_ROWS + 1) + ' more', kind: '', more: true }];
}
