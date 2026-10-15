/**
 * The "Memory" view: how the values nest in memory, as a left-to-right tree.
 * Every object appears once; a second reference becomes a "↪ #id" tag, so arrows never cross.
 *
 * buildMemoryView() is pure: it lays the tree out and returns drawable primitives plus whether anything
 * changed since the previous step. <Graph> (components/Graph.jsx) draws them.
 */
import { Graph } from 'dagre-d3-es/src/graphlib/index.js';
import { layout } from 'dagre-d3-es/src/dagre/index.js';
import { idBgFill, idFill } from '../color.js';
import { clip, markersFor, stepIndex } from '../model.js';
import { G } from './common.js';
import { P, runs } from './prims.js';

const MARK_ROW = 13;   // height of one line under an array: the arrow, then each pointer name
const MARK_CW = 7.2;   // width of one character of a pointer name

/**
 * Where each pointer name goes under an array strip, without widening any cell: centred under its cell (but not off the
 * left of the box), names of one cell one under the other, and a name that would overlap one already on a row moves down.
 * Sets g.markPos[i] = [{ nm, cx, row }] (cx relative to the box) and g.markRows.
 */
function placeMarks(g) {
  const rows = []; let left = 0;
  g.markPos = g.cw.map((w, i) => {
    let r = 0;
    const placed = ((g.markers && g.markers[i]) || []).map(nm => {
      const half = nm.length * MARK_CW / 2, cx = Math.max(left + w / 2, half + 2), a = cx - half - 3, b = cx + half + 3;
      while ((rows[r] || []).some(([p, q]) => a < q && p < b)) r++;
      (rows[r] = rows[r] || []).push([a, b]);
      return { nm, cx, row: r++ };
    });
    left += w;
    return placed;
  });
  g.markRows = rows.length;
}

/**
 * The structure reachable from one variable, as a spanning tree.
 * A second reference to an object (shared, or a cycle) becomes a small tag instead of an arrow.
 */
export function buildVarGraph(step, name) {
  const v = step.vars.find(x => x.name === name);
  if (!v) return null;
  const { resolve } = stepIndex(step);
  const rootSrc = resolve(v.node);
  if (!rootSrc) return null;

  const nodes = new Map(), onPath = new Set();
  const make = src => {
    const g = { id: src.id, kind: src.t, cells: [], kids: [], more: src.more || 0 };
    nodes.set(src.id, g); onPath.add(src.id);
    g.title = src.t === 'obj' ? (src.cls || 'Object') : src.t === 'map' ? 'Map(' + (src.entries.length + src.more) + ')'
      : src.t === 'set' ? 'Set(' + (src.items.length + src.more) + ')' : 'Array(' + src.len + ')';
    let rows;
    if (src.t === 'arr') rows = src.items.map((x, i) => [String(i), x]);
    else if (src.t === 'set') rows = src.items.map(x => ['•', x]);
    else if (src.t === 'obj') rows = src.entries.map(([k, x]) => [clip(k), x]);
    else rows = src.entries.map(([k, x]) => [clip(k.t === 'p' ? k.s : '#' + k.id), x]);
    rows.forEach(([label, val]) => {
      const c = { label, text: null, kind: '', chip: null, refId: null, childId: null };
      if (val.t === 'p') { c.text = clip(val.s); c.kind = val.k; }
      else if (val.t === 'fn') c.text = clip('ƒ ' + val.s);
      else {
        const tgt = resolve(val);
        if (!tgt) c.chip = '…';
        else if (nodes.has(tgt.id)) { c.chip = (onPath.has(tgt.id) ? '↺ #' : '↪ #') + tgt.id; c.refId = tgt.id; }
        else if (nodes.size >= G.MAXN) c.chip = '…';
        else { c.childId = tgt.id; const idx = g.cells.length; g.kids.push({ cell: idx, node: make(tgt) }); }
      }
      g.cells.push(c);
    });
    onPath.delete(src.id);
    g.strip = (g.kind === 'arr' || g.kind === 'set') && g.cells.every(c => c.text != null);
    return g;
  };
  const root = make(rootSrc);
  return { root, nodes, rootSrc };
}

/**
 * Left-to-right tree laid out by dagre (rankdir LR, as layout-layered.js does top-down). Each arrow
 * leaves its cell horizontally, clears the node, then follows dagre's route to the child.
 * @returns {{ width: number, height: number, prims: any[], changed: boolean } | null}
 */
export function buildMemoryView(step, prev, name, withPtrs) {
  const vg = buildVarGraph(step, name);
  if (!vg) return null;
  const pg = prev ? buildVarGraph(prev, name) : null;
  const { CW, HEAD, IDX, CELL, ROW, VG, PAD } = G;
  const root = vg.root;

  if (withPtrs && root.strip && root.kind === 'arr') {
    const m = markersFor(vg.rootSrc, step.vars, name);
    const most = Math.max(0, ...Object.values(m).map(a => a.length));
    if (most) { root.markers = m; root.markRows = most; }
  }

  /* sizes */
  const cellW = c => Math.max(CELL, c.text != null ? c.text.length * CW + 18 : 0);
  for (const g of vg.nodes.values()) {
    const head = ('#' + g.id + ' ' + g.title).length * 6.7 + 20;
    if (g.strip) {
      g.cw = g.cells.map(cellW); if (g.more) g.cw.push(48); if (!g.cw.length) g.cw.push(64);   // pointer names never widen a cell
      if (g.markers) placeMarks(g);
      g.w = Math.max(head, g.cw.reduce((a, b) => a + b, 0));
      g.h = HEAD + (g.kind === 'arr' ? IDX : 0) + CELL + (g.markRows ? (g.markRows + 1) * MARK_ROW + 6 : 0);   // one arrow row, then the names
    } else {
      g.kw = Math.max(30, ...g.cells.map(c => c.label.length * CW + 16));
      const vw = Math.max(44, ...g.cells.map(c => c.chip != null ? c.chip.length * 7 + 20 : c.childId != null ? 34 : cellW(c)));
      g.w = Math.max(head, g.kw + vw); g.vw = g.w - g.kw;
      g.h = HEAD + Math.max(1, g.cells.length + (g.more ? 1 : 0)) * ROW;
    }
  }

  /* layout */
  const dg = new Graph();
  dg.setGraph({ rankdir: 'LR', nodesep: VG, ranksep: 48, marginx: PAD, marginy: PAD });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const g of vg.nodes.values()) dg.setNode(String(g.id), { width: g.w, height: g.h });
  const links = [];
  for (const g of vg.nodes.values()) g.kids.forEach(k => { dg.setEdge(String(g.id), String(k.node.id)); links.push([g, k]); });
  layout(dg);
  for (const g of vg.nodes.values()) { const p = dg.node(String(g.id)); g.x = p.x - g.w / 2; g.y = p.y - g.h / 2; }
  const { width, height } = dg.graph();
  const edges = links.map(([g, k]) => {
    const pts = dg.edge(String(g.id), String(k.node.id)).points.slice(1);
    return 'M' + (g.x + g.w - 12) + ',' + (g.y + HEAD + k.cell * ROW + ROW / 2) + ' H' + (g.x + g.w + 10) + pts.map(p => ' L' + p.x + ',' + p.y).join('');
  });

  /* draw */
  const prims = [];
  let markRight = 0;                                 // right edge of the pointer names, which may stick out of their cells
  let changed = false;
  for (const g of vg.nodes.values()) {
    const old = pg && pg.nodes.get(g.id);
    const isNew = !!pg && !old;
    if (isNew) changed = true;
    prims.push(P('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 6, className: 'g-node' + (isNew ? ' chg' : '') }));
    prims.push(runs({ x: g.x + 8, y: g.y + 14, className: 'g-head-t' }, [
      P('tspan', { style: { ...idFill(g.id), fontWeight: 700 } }, '#' + g.id),
      P('tspan', { dx: 6 }, g.title),
    ]));

    const isChanged = i => {
      if (!old) return false;
      const c = g.cells[i];
      const oc = (g.kind === 'obj' || g.kind === 'map') ? old.cells.find(x => x.label === c.label) : old.cells[i];
      const diff = !oc || oc.text !== c.text || oc.chip !== c.chip || oc.childId !== c.childId;
      if (diff) changed = true;
      return diff;
    };

    if (g.strip) {
      const top = g.y + HEAD + (g.kind === 'arr' ? IDX : 0);
      let x = g.x;
      if (!g.cells.length) {
        prims.push(P('rect', { x, y: top, width: g.cw[0], height: CELL, className: 'g-cell' }));
        prims.push(P('text', { x: x + g.cw[0] / 2, y: top + CELL / 2 + 4, textAnchor: 'middle', className: 'g-muted' }, 'empty'));
      }
      g.cells.forEach((c, i) => {
        const w = g.cw[i];
        prims.push(P('rect', { x, y: top, width: w, height: CELL, className: 'g-cell' + (isChanged(i) ? ' chg' : '') }));
        if (g.kind === 'arr') prims.push(P('text', { x: x + w / 2, y: top - 3, textAnchor: 'middle', className: 'g-idx' }, c.label));
        prims.push(P('text', { x: x + w / 2, y: top + CELL / 2 + 4, textAnchor: 'middle', className: 'g-t ' + c.kind }, c.text));
        if (g.markers && g.markers[i]) {             // pointer tags: one arrow up at the cell, then each name on its own line
          prims.push(P('text', { x: x + w / 2, y: top + CELL + MARK_ROW, textAnchor: 'middle', className: 'g-ptrarrow' }, '↑'));
          g.markPos[i].forEach(({ nm, cx, row }) => {
            markRight = Math.max(markRight, g.x + cx + nm.length * MARK_CW / 2);
            prims.push(P('text', { x: g.x + cx, y: top + CELL + MARK_ROW * (row + 2), textAnchor: 'middle', className: 'g-chiptxt', style: idFill(nm) }, nm));
          });
        }
        x += w;
      });
      if (g.more) prims.push(P('text', { x: x + 24, y: top + CELL / 2 + 4, textAnchor: 'middle', className: 'g-muted' }, '+' + g.more));
    } else {
      if (!g.cells.length) prims.push(P('text', { x: g.x + 10, y: g.y + HEAD + 18, className: 'g-muted' }, g.kind === 'map' ? 'empty map' : g.kind === 'obj' ? 'empty object' : 'empty'));
      g.cells.forEach((c, i) => {
        const ry = g.y + HEAD + i * ROW, vx = g.x + g.kw, cy = ry + ROW / 2;
        prims.push(P('rect', { x: g.x, y: ry, width: g.kw, height: ROW, className: 'g-key' }));
        prims.push(P('text', { x: g.x + 8, y: cy + 4, className: 'g-keyt' }, c.label));
        prims.push(P('rect', { x: vx, y: ry, width: g.vw, height: ROW, className: 'g-cell' + (isChanged(i) ? ' chg' : '') }));
        if (c.childId != null) prims.push(P('circle', { cx: g.x + g.w - 12, cy, r: 4, className: 'g-dot' }));
        else if (c.refId != null) {
          const w = c.chip.length * 7 + 10;
          prims.push(P('rect', { x: vx + 8, y: cy - 9, width: w, height: 18, rx: 4, style: idBgFill(c.refId) }));
          prims.push(P('text', { x: vx + 13, y: cy + 4, className: 'g-chiptxt', style: idFill(c.refId) }, c.chip));
        }
        else if (c.chip != null) prims.push(P('text', { x: vx + g.vw / 2, y: cy + 4, textAnchor: 'middle', className: 'g-muted' }, c.chip));
        else prims.push(P('text', { x: vx + g.vw / 2, y: cy + 4, textAnchor: 'middle', className: 'g-t ' + c.kind }, c.text));
      });
      if (g.more) prims.push(P('text', { x: g.x + 10, y: g.y + HEAD + g.cells.length * ROW + 18, className: 'g-muted' }, '+' + g.more + ' more'));
    }
  }

  edges.forEach(d => prims.push(P('path', { d, className: 'g-edge', markerEnd: 'arrow' })));

  return { width: Math.max(width, markRight + PAD), height, prims, changed };   // room for a name past the last cell
}
