/**
 * Layout constants shared by the graph views.
 */
export const G = { CW: 7.9, HEAD: 20, IDX: 13, CELL: 34, ROW: 28, VG: 14, PAD: 14, MAXN: 50 };

/** Edge labels: line height, and the size of a label block (dagre and the tree layout leave room for it). */
export const EL_LINE = 12;
export const labelSize = lines => ({ width: Math.max(0, ...lines.map(l => l.length * 6.4)) + 8, height: lines.length * EL_LINE + 4 });
