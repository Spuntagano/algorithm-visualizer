/**
 * Layered layout for general graphs, delegated to dagre (rank assignment, crossing reduction,
 * coordinate assignment and edge routing). We only turn its edge points into smooth SVG paths.
 */
import { Graph } from 'dagre-d3-es/src/graphlib/index.js';
import { layout } from 'dagre-d3-es/src/dagre/index.js';
import { G, labelSize } from './common.js';

/** Straight segments through dagre's routed points with rounded corners (full curves between points can clip nodes). */
function polyline(pts) {
  let d = 'M' + pts[0].x + ',' + pts[0].y;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const la = Math.hypot(b.x - a.x, b.y - a.y), lc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(10, la / 2, lc / 2), ka = r / (la || 1), kc = r / (lc || 1);
    d += ' L' + (b.x - (b.x - a.x) * ka) + ',' + (b.y - (b.y - a.y) * ka) + ' Q' + b.x + ',' + b.y + ' ' + (b.x + (c.x - b.x) * kc) + ',' + (b.y + (c.y - b.y) * kc);
  }
  const z = pts[pts.length - 1];
  return d + ' L' + z.x + ',' + z.y;
}

/** Positions sem.nodes in place and returns { width, height, edges: [{ e, d, lx, ly }] }. */
export function layoutLayered(sem) {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 52, marginx: G.PAD, marginy: G.PAD });
  g.setDefaultEdgeLabel(() => ({}));
  sem.nodes.forEach(n => g.setNode(n.key, { width: n.w, height: n.h }));
  sem.edges.forEach((e, i) => g.setEdge(e.from, e.to, e.lines && e.lines.length ? { ...labelSize(e.lines), labelpos: 'c' } : {}, String(i)));
  layout(g);

  const raw = sem.edges.map((e, i) => g.edge(e.from, e.to, String(i)).points);
  const lab = sem.edges.map((e, i) => { const d = g.edge(e.from, e.to, String(i)); return e.lines && e.lines.length && d.x != null ? d : null; });
  sem.nodes.forEach(n => { const p = g.node(n.key); n.x = p.x - n.w / 2; n.y = p.y - n.h / 2; });

  /* dagre's size ignores edge routes (loops, back edges), so fit the canvas to nodes and routes together */
  const xs = [...sem.nodes.flatMap(n => [n.x, n.x + n.w]), ...raw.flat().map(p => p.x), ...lab.filter(Boolean).flatMap(d => [d.x - d.width / 2, d.x + d.width / 2])];
  const ys = [...sem.nodes.flatMap(n => [n.y, n.y + n.h]), ...raw.flat().map(p => p.y), ...lab.filter(Boolean).flatMap(d => [d.y - d.height / 2, d.y + d.height / 2])];
  const dx = G.PAD - Math.min(...xs), dy = G.PAD - Math.min(...ys);
  sem.nodes.forEach(n => { n.x += dx; n.y += dy; });
  const edges = sem.edges.map((e, i) => {
    const pts = raw[i].map(p => ({ x: p.x + dx, y: p.y + dy }));
    const m = Math.floor((pts.length - 1) / 2);
    if (lab[i]) return { e, d: polyline(pts), lx: lab[i].x + dx, ly: lab[i].y + dy };   // where dagre left room for the label
    return { e, d: polyline(pts), lx: (pts[m].x + pts[m + 1].x) / 2, ly: (pts[m].y + pts[m + 1].y) / 2 };
  });
  return { width: Math.max(...xs) + dx + G.PAD, height: Math.max(...ys) + dy + G.PAD, edges };
}
