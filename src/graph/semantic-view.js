/**
 * The "Graph" view: lay a semantic graph out and describe how to draw it, highlighting what changed.
 * Pure: returns primitives for <Graph> (components/Graph.jsx) to draw.
 */
import { idBgFill, idFill } from '../color.js';
import { EL_LINE, labelSize } from './common.js';
import { layoutLayered } from './layout-layered.js';
import { layoutTree } from './layout-tree.js';
import { ROW_H, nodeRows, semTags, sizeNode, titleless } from './overlay.js';
import { P } from './prims.js';
import { semanticGraph } from './semantic.js';
import { spanning } from './structure.js';

/**
 * @param sem  result of semanticGraph(step, name) — its nodes are sized and positioned in place
 * @returns {{ width: number, height: number, caption: string, prims: any[], changed: boolean }}
 */
export function buildSemanticView(step, prev, name, sem, withPtrs) {
  const psem = prev ? semanticGraph(prev, name) : null;
  const tags = withPtrs ? semTags(step, sem, name) : new Map();
  const ptags = withPtrs && psem ? semTags(prev, psem, name) : new Map();
  sem.nodes.forEach(n => sizeNode(n, tags.get(n.key) || []));

  const sp = spanning(sem);
  const isTree = sem.edges.every((e, i) => e.from !== e.to && sp.treeEdge.has(i));
  const isList = isTree && sp.roots.length === 1 && sem.nodes.every(n => sp.treeKids.get(n.key).length <= 1);
  const layout = isList ? 'list' : isTree ? 'tree' : 'graph';

  /* edge labels, worked out before layout so it can leave room for them: an edge object's values as "key value" lines
     ({ v: 1, start: 0, end: 3 } → start 0 / end 3), else a bare weight, else the field name when it helps */
  const labs = new Set(sem.edges.map(e => e.label).filter(Boolean));
  const showLab = labs.size > 1 || (labs.size === 1 && ![...labs].every(l => ['left', 'right', 'next', 'children'].includes(String(l).toLowerCase())));
  sem.edges.forEach(e => {
    const onlyWeight = e.attrs && e.attrs.length === 1 && e.weight != null;
    e.lines = e.attrs && e.attrs.length && !onlyWeight ? e.attrs.map(([k, v]) => (k == null ? v : k + ' ' + v))   // a tuple's values have no names
      : e.weight != null ? [String(e.weight)] : showLab && e.label ? [e.label] : [];
  });
  const geo = layout === 'graph' ? layoutLayered(sem) : layoutTree(sem, sp, isList);

  const eKey = e => e.from + '\u0001' + e.to + '\u0001' + (e.label || '') + '\u0001' + (e.weight ?? '') + '\u0001' + JSON.stringify(e.attrs || null);
  const prevEdges = psem ? new Set(psem.edges.map(eKey)) : null;

  const prims = [];
  let changed = false;
  geo.edges.forEach(g => {
    const isNew = !!prevEdges && !prevEdges.has(eKey(g.e));
    if (isNew) changed = true;
    const p = { d: g.d, className: 'g-edge' + (isNew ? ' chg' : '') };
    if (!g.e.undirected) p.markerEnd = isNew ? 'arrow-chg' : 'arrow';
    prims.push(P('path', p));
    if (g.e.lines.length) {                          // a box behind the label, so the arrow does not run through its text
      const { width, height } = labelSize(g.e.lines);
      prims.push(P('rect', { x: g.lx - width / 2, y: g.ly - height / 2, width, height, rx: 3, className: 'g-elabel-bg' }));
    }
    const y0 = g.ly + 4 - (g.e.lines.length - 1) * EL_LINE / 2;
    g.e.lines.forEach((text, k) => prims.push(P('text', { x: g.lx, y: y0 + k * EL_LINE, textAnchor: 'middle', className: 'g-elabel' + (isNew ? ' chg' : '') }, text)));
  });

  sem.nodes.forEach(n => {
    const old = psem && psem.map.get(n.key), nt = tags.get(n.key) || [];
    const ch = !!psem && (!old || old.label !== n.label);
    if (ch) changed = true;
    prims.push(P('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, className: 'g-snode' + (nt.some(t => t.kind === 'ptr') ? ' ptr' : '') + (ch ? ' chg' : '') }));
    const plain = !n.rows.length && !n.pills.length;
    if (!titleless(n)) prims.push(P('text', { x: n.x + n.w / 2, y: plain ? n.y + n.h / 2 + 4.5 : n.y + 21, textAnchor: 'middle', className: 'g-slabel' }, n.label));

    /* rows: the node's own values; a value that changed since the last step is marked */
    const oldRows = old ? nodeRows(old) : null;
    let ry = n.y + n.top + 2;
    n.rows.forEach(r => {
      const was = oldRows && oldRows.find(q => q.k === r.k);
      const fresh = !!old && !r.more && (!was || was.text !== r.text);
      if (fresh) { changed = true; prims.push(P('rect', { x: n.x + 4, y: ry, width: n.w - 8, height: ROW_H, rx: 3, className: 'g-frow chg' })); }
      if (r.more) prims.push(P('text', { x: n.x + 10, y: ry + 11, className: 'g-fkey' }, r.text));
      else {
        prims.push(P('text', { x: n.x + 10, y: ry + 11, className: 'g-fkey' }, r.k));
        prims.push(P('text', { x: n.x + 10 + n.keyW + 8, y: ry + 11, className: 'g-fval g-t' + (r.kind ? ' ' + r.kind : '') + (r.main ? ' main' : '') }, r.text));
      }
      ry += ROW_H;
    });
    let py = n.y + n.top + (n.rows.length ? n.rows.length * ROW_H + 4 : 0) + 4;
    n.pills.forEach(q => {
      const pw = q.s.length * 6.4 + 12, px = n.x + (n.w - pw) / 2;
      const was = q.tag && (ptags.get(n.key) || []).some(t => t.name === q.tag.name && t.kind === q.tag.kind);
      const fresh = !!psem && q.tag && !was;
      prims.push(P('rect', { x: px, y: py, width: pw, height: 14, rx: 4, className: 'g-pill' + (fresh ? ' chg' : ''), style: q.tag ? idBgFill(q.tag.name) : { fill: 'var(--surface-2)' } }));
      prims.push(P('text', { x: n.x + n.w / 2, y: py + 10.5, textAnchor: 'middle', className: 'g-pilltxt', style: q.tag ? idFill(q.tag.name) : { fill: 'var(--muted)' } }, q.s));
      py += 16;
    });
  });

  const kindName = layout === 'list' ? 'Linked list' : layout === 'tree' ? 'Tree' : (sem.edges.some(e => e.undirected) && !sem.edges.some(e => !e.undirected) ? 'Undirected graph' : 'Graph');
  const caption = kindName + ' · ' + sem.nodes.length + ' nodes · ' + sem.edges.length + ' edges · built from the keys and values';
  return { width: geo.width, height: geo.height, caption, prims, changed };
}
