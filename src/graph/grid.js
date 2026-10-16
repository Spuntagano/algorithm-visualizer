/**
 * The Grid view's data: an array of arrays of plain values (a matrix, a board, a dynamic-programming table) as rows
 * and columns, with the cells that changed since the previous step and the variables that index a row or a column.
 * Drawn by components/GridView.jsx.
 */
import { markersFor, stepIndex } from '../model.js';

const MIN_ROWS = 2;

/**
 * @returns {{ id, rows: (object | null)[][], cols: number, base: number, more: number } | null}
 *   rows[r][c]: the primitive node in that cell (null past the end of a shorter row); null when it is not a grid
 */
export function gridOf(step, name) {
  const v = step && step.vars.find(x => x.name === name);
  if (!v) return null;
  const { resolve } = stepIndex(step);
  const outer = resolve(v.node);
  if (!outer || outer.t !== 'arr' || outer.items.length < MIN_ROWS) return null;
  const rows = [];
  for (const it of outer.items) {
    const row = resolve(it);
    if (!row || row.t !== 'arr' || !row.items.every(x => x.t === 'p')) return null;
    rows.push(row);
  }
  const cols = Math.max(...rows.map(r => r.items.length));
  if (!cols) return null;
  return {
    id: outer.id, cols, base: outer.base || 0, more: outer.more || 0,
    rows: rows.map(r => Array.from({ length: cols }, (_, c) => r.items[c] || null)),
    rowMore: rows.map(r => r.more || 0),
  };
}

/** Which cells differ from the same grid in the previous step: a set of "r,c" (everything is new without one) */
export function changedCells(grid, prevGrid) {
  const out = new Set();
  if (!prevGrid) return out;
  grid.rows.forEach((row, r) => row.forEach((cell, c) => {
    const was = prevGrid.rows[r] && prevGrid.rows[r][c];
    if (cell && (!was || was.s !== cell.s || was.k !== cell.k)) out.add(r + ',' + c);
  }));
  return out;
}

const ROWISH = /^(i|ii|i\d|r|row|y|top|bottom)$/i, COLISH = /^(j|jj|j\d|c|col|x|left|right)$/i;
const SIZEISH = /^(n|m|len|length|size|count|rows|cols|width|height|w|h)$/i;   // how big, not where
const bare = name => name.replace(/^[$@]+/, '');                                // PHP's $i is i

/**
 * The variables holding a valid row number, and those holding a valid column number: { rows: {r: [names]}, cols,
 * cell: [r, c] | null }. A name says which side it indexes (i, r, row, y: a row; j, c, col, x: a column); any other
 * number that fits tags both, except one named like a size (n, m, len, rows…). `cell`: where the one tagged row meets
 * the one tagged column (dp[i][j]).
 */
export function gridMarkers(grid, vars, selfName) {
  const fake = n => ({ id: null, items: new Array(n), base: grid.base });
  const keep = re => vars.filter(v => !re.test(bare(v.name)) && !SIZEISH.test(bare(v.name)));
  const rows = markersFor(fake(grid.rows.length), keep(COLISH), selfName);
  const cols = markersFor(fake(grid.cols), keep(ROWISH), selfName);
  const rk = Object.keys(rows), ck = Object.keys(cols);
  return { rows, cols, cell: rk.length === 1 && ck.length === 1 ? [+rk[0], +ck[0]] : null };
}
