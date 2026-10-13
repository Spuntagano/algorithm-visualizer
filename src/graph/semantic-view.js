/**
 * The "Graph" view: lay a semantic graph out and describe how to draw it, highlighting what changed.
 * Pure: returns primitives for <Graph> (components/Graph.jsx) to draw.
 */
import { idBgFill, idFill } from '../color.js';
import { layoutLayered } from './layout-layered.js';
import { layoutTree } from './layout-tree.js';
import { semTags, sizeNode } from './overlay.js';
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
  const geo = layout === 'graph' ? layoutLayered(sem) : layoutTree(sem, sp, isList);

  const labs = new Set(sem.edges.map(e => e.label).filter(Boolean));
  const showLab = labs.size > 1 || (labs.size === 1 && ![...labs].every(l => l === 'left' || l === 'right' || l === 'next' || l === 'children'));
  const eKey = e => e.from + '\u0001' + e.to + '\u0001' + (e.label || '');
  const prevEdges = psem ? new Set(psem.edges.map(eKey)) : null;

  const prims = [];
  let changed = false;
  geo.edges.forEach(g => {
    const isNew = !!prevEdges && !prevEdges.has(eKey(g.e));
    if (isNew) changed = true;
    const p = { d: g.d, className: 'g-edge' + (isNew ? ' chg' : '') };
    if (!g.e.undirected) p.markerEnd = isNew ? 'arrow-chg' : 'arrow';
    prims.push(P('path', p));
    const text = g.e.weight != null ? String(g.e.weight) : (showLab && g.e.label ? g.e.label : '');
    if (text) prims.push(P('text', { x: g.lx, y: g.ly + 4, textAnchor: 'middle', className: 'g-elabel' }, text));
  });

  sem.nodes.forEach(n => {
    const old = psem && psem.map.get(n.key), nt = tags.get(n.key) || [];
    const ch = !!psem && (!old || old.label !== n.label || old.caption !== n.caption);
    if (ch) changed = true;
    prims.push(P('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, className: 'g-snode' + (nt.some(t => t.kind === 'ptr') ? ' ptr' : '') + (ch ? ' chg' : '') }));
    const plain = !n.caption && !n.pills.length;
    prims.push(P('text', { x: n.x + n.w / 2, y: plain ? n.y + n.h / 2 + 4.5 : n.y + 21, textAnchor: 'middle', className: 'g-slabel' }, n.label));
    if (n.caption) prims.push(P('text', { x: n.x + n.w / 2, y: n.y + 36, textAnchor: 'middle', className: 'g-scap' }, n.caption));
    let py = n.y + 8 + 18 + (n.caption ? 14 : 0) + 4;
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
