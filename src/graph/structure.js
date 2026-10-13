/**
 * Breadth-first spanning forest of a semantic graph: depth gives layers, treeKids gives the hierarchy.
 */

/* Breadth-first spanning forest: depth gives layers, treeKids gives the hierarchy. */
export function spanning(sem) {
  const out = new Map(sem.nodes.map(n => [n.key, []])), indeg = new Map(sem.nodes.map(n => [n.key, 0]));
  sem.edges.forEach((e, i) => {
    if (e.from === e.to) return;
    out.get(e.from).push({ to: e.to, i });
    if (e.undirected) out.get(e.to).push({ to: e.from, i }); else indeg.set(e.to, indeg.get(e.to) + 1);
  });
  const depth = new Map(), order = [], roots = [], treeEdge = new Set(), treeKids = new Map(sem.nodes.map(n => [n.key, []]));
  const bfs = r => {
    depth.set(r, 0); roots.push(r); order.push(r);
    const q = [r];
    while (q.length) {
      const u = q.shift();
      for (const { to, i } of out.get(u)) if (!depth.has(to)) {
        depth.set(to, depth.get(u) + 1); order.push(to); treeKids.get(u).push({ key: to, i }); treeEdge.add(i); q.push(to);
      }
    }
  };
  [...sem.nodes.filter(n => indeg.get(n.key) === 0), ...sem.nodes].forEach(n => { if (!depth.has(n.key)) bfs(n.key); });
  return { depth, order, roots, treeEdge, treeKids };
}
