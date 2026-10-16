/**
 * The Grid view: an array of arrays as a table (graph/grid.js), row and column numbers on its edges, the variables
 * that hold a row or column number tagged there, and the cells that just changed marked.
 */
import { hueOf } from '../color.js';

const Tags = ({ names }) => (names ? names.map(nm => <span key={nm} className="chip" style={{ '--h': hueOf(nm) }}>{nm}</span>) : null);

/**
 * @param grid     from gridOf()
 * @param changed  "r,c" of the cells that changed
 * @param markers  from gridMarkers(), or null to show no tags; the cell its tags meet at is outlined
 */
export function GridView({ grid, changed, markers, name }) {
  const { rows, cols, base } = grid;
  const at = markers && markers.cell;   // the cell the row and column tags meet at
  return (
    <div className="gridv-wrap">
      <div className="gridv-scroll">
        <table className="gridv" aria-label={'Grid of ' + name}>
          <thead>
            <tr>
              <th className="gridv-corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col" className={markers && markers.cols[c] ? 'tagged' : ''}>
                  <span className="gridv-n">{c + base}</span><Tags names={markers && markers.cols[c]} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th scope="row" className={markers && markers.rows[r] ? 'tagged' : ''}>
                  <span className="gridv-n">{r + base}</span><Tags names={markers && markers.rows[r]} />
                </th>
                {row.map((cell, c) => (
                  <td key={c} className={(!cell ? 'gridv-none' : changed.has(r + ',' + c) ? 'chg' : '') + (at && at[0] === r && at[1] === c ? ' at' : '')}>
                    {cell && <span className={'prim ' + cell.k}>{cell.s}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="len">{rows.length} × {cols}{grid.more > 0 ? ` · +${grid.more} more rows` : ''}{grid.rowMore.some(Boolean) ? ' · long rows cut off' : ''}</div>
    </div>
  );
}
