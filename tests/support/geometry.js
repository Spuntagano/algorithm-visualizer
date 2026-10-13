/** Geometry checks on graph view-models: overlaps, edges through nodes, crossings. */
/** Sample an SVG path made of M / L / H / V / C commands into a polyline. */
function sample(d) {
  const tok = d.match(/[MLCHV]|-?[\d.]+(?:e-?\d+)?/g); let i = 0, cur = [0, 0]; const pts = [];
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === 'M' || c === 'L') { cur = [num(), num()]; pts.push(cur); }
    else if (c === 'H') { cur = [num(), cur[1]]; pts.push(cur); }
    else if (c === 'V') { cur = [cur[0], num()]; pts.push(cur); }
    else if (c === 'C') {
      const p1 = [num(), num()], p2 = [num(), num()], p3 = [num(), num()];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push([u ** 3 * cur[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                  u ** 3 * cur[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]]);
      }
      cur = p3;
    }
  }
  return pts;
}
const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const segCross = (a, b, c, d) => {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
};

/**
 * @param view     { width, height, prims } as returned by buildSemanticView / buildMemoryView
 * @param nodeCls  regex matched against the className of node rectangles
 * @param edgeCls  regex matched against the className of edge paths
 */
export function analyse(view, nodeCls, edgeCls) {
  const nodes = [], edges = [];
  for (const n of view.prims) {
    const cls = n.p.className || '';
    if (n.tag === 'rect' && nodeCls.test(cls)) nodes.push({ x: n.p.x, y: n.p.y, w: n.p.width, h: n.p.height });
    if (n.tag === 'path' && edgeCls.test(cls)) edges.push(sample(n.p.d));
  }
  const W = view.width, H = view.height, problems = [];
  nodes.forEach((a, i) => nodes.forEach((b, j) => {
    if (j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) problems.push(`node ${i} overlaps node ${j}`);
  }));
  nodes.forEach((n, i) => { if (n.x < -0.5 || n.y < -0.5 || n.x + n.w > W + 0.5 || n.y + n.h > H + 0.5) problems.push(`node ${i} outside canvas`); });
  const inside = (n, [x, y]) => x > n.x + 1.5 && x < n.x + n.w - 1.5 && y > n.y + 1.5 && y < n.y + n.h - 1.5;
  edges.forEach((pts, i) => {
    // an arrow may start inside its own node (memory view: it leaves from the cell holding the reference)
    const own = nodes.findIndex(n => inside(n, pts[0]));
    if (own >= 0 && Math.abs(pts[1][1] - pts[0][1]) > 0.5) problems.push(`edge ${i} leaves its own node at an angle, across its other cells`);
    pts.forEach(p => {
      if (p[0] < -0.5 || p[1] < -0.5 || p[0] > W + 0.5 || p[1] > H + 0.5) problems.push(`edge ${i} leaves canvas`);
      nodes.forEach((n, ni) => { if (ni !== own && inside(n, p)) problems.push(`edge ${i} passes through node ${ni}`); });
    });
  });
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++)
    for (let a = 0; a + 1 < edges[i].length; a++) for (let b = 0; b + 1 < edges[j].length; b++)
      if (segCross(edges[i][a], edges[i][a + 1], edges[j][b], edges[j][b + 1])) crossings++;
  return { nodes: nodes.length, edges: edges.length, crossings, problems: [...new Set(problems)] };
}
