/**
 * The "Boxes" view: a snapshot node drawn as nested HTML (array cells, object tables, Map and Set).
 * Changed values are marked by comparing with the node at the same position in the previous step.
 */
import { createContext, useContext } from 'react';
import { hueOf } from '../color.js';

/** What the values below need to know about the step: highlight changes? which objects appear twice? */
export const StepContext = createContext({ diff: false, refs: new Set() });

const isLeaf = n => n.t === 'p' || n.t === 'ref' || n.t === 'fn' || n.t === 'trunc';
const primChanged = (diff, n, p) => diff && (!p || p.t !== 'p' || p.s !== n.s);

/** "#3" tag shown on objects that are reachable more than once in this step. */
function Badge({ node, children }) {
  const { refs } = useContext(StepContext);
  if (!refs.has(node.id)) return children;
  return (
    <span className="holder">
      <span className="badge" style={{ '--h': hueOf(node.id) }}>#{node.id}</span>
      {children}
    </span>
  );
}

/** The `i`, `j`… tags under array cells. */
function Chips({ names }) {
  return (
    <div className="ptrs">
      {names.map(nm => <span key={nm} className="chip" style={{ '--h': hueOf(nm) }}>{nm}</span>)}
    </div>
  );
}

/**
 * @param node     snapshot node to draw
 * @param prev     the node at the same place in the previous step (or undefined)
 * @param markers  pointer tags by array index, for a top-level array only
 */
export function Value({ node: n, prev: p, markers = null }) {
  const { diff } = useContext(StepContext);
  switch (n.t) {
    case 'p':
      return <span className={'prim ' + n.k + (primChanged(diff, n, p) ? ' chg' : '')}>{n.s}</span>;
    case 'fn':
      return <span className="prim null">ƒ {n.s}</span>;
    case 'ref':
      return <span className="ref" style={{ '--h': hueOf(n.id) }}>→ #{n.id}</span>;
    case 'trunc':
      return <span className="empty">…</span>;
    case 'arr': {
      const same = p && p.t === 'arr';
      const lenChanged = diff && same && p.len !== n.len;
      return (
        <Badge node={n}>
          <div className="arr-wrap">
            {n.len > 0 && (
              <div className="arr">
                {n.items.map((it, i) => {
                  const pi = same ? p.items[i] : undefined;
                  const changed = it.t === 'p' && primChanged(diff, it, pi);
                  return (
                    <div className="cell" key={i}>
                      <div className={'cellbox' + (isLeaf(it) ? '' : ' nested') + (changed ? ' chg' : '')}>
                        <Value node={it} prev={pi} />
                      </div>
                      <div className="idx">{i}</div>
                      {markers && markers[i] && <Chips names={markers[i]} />}
                    </div>
                  );
                })}
                {n.more > 0 && <div className="more">+{n.more} more</div>}
              </div>
            )}
            <div className={'len' + (lenChanged ? ' chg' : '')}>{(n.cls && n.cls !== 'list' ? n.cls + ' · ' : '') + (n.len === 0 ? (n.cls ? 'empty' : 'empty array') : 'length ' + n.len)}</div>
          </div>
        </Badge>
      );
    }
    case 'set': {
      const same = p && p.t === 'set';
      return (
        <Badge node={n}>
          <div>
            <div className="len">{n.cls || 'Set'} · size {n.items.length + n.more}</div>
            <div className="set">
              {!n.items.length && <span className="empty">empty set</span>}
              {n.items.map((it, i) => {
                const had = same && p.items.some(x => x.t === it.t && (it.t === 'p' ? x.s === it.s : x.id === it.id));
                return <span key={i} className={'item' + (diff && !had ? ' chg' : '')}><Value node={it} prev={it.t === 'p' ? it : undefined} /></span>;
              })}
              {n.more > 0 && <span className="more">+{n.more}</span>}
            </div>
          </div>
        </Badge>
      );
    }
    case 'map': case 'obj': {
      const same = p && p.t === n.t;
      const title = n.t === 'map' ? (n.cls || 'Map') + ' · size ' + (n.entries.length + n.more) : n.cls || n.tn;   // cls / tn: Python type names
      return (
        <Badge node={n}>
          <div className="obj">
            {title && <div className="cls">{title}</div>}
            {!n.entries.length && <div className="row"><div className="v empty">{n.t === 'map' ? 'empty map' : 'empty object'}</div></div>}
            {n.entries.map(([k, v], i) => {
              let pe;
              if (same) pe = n.t === 'obj' ? p.entries.find(e => e[0] === k) : p.entries.find(e => e[0].t === k.t && (k.t === 'p' ? e[0].s === k.s : e[0].id === k.id));
              return (
                <div className={'row' + (diff && !pe ? ' chg' : '')} key={i}>
                  <div className="k">{n.t === 'obj' ? k : <Value node={k} prev={k} />}</div>
                  <div className="v"><Value node={v} prev={pe ? pe[1] : undefined} /></div>
                </div>
              );
            })}
            {n.more > 0 && <div className="row"><div className="v empty">+{n.more} more</div></div>}
          </div>
        </Badge>
      );
    }
    default:
      return <span>?</span>;
  }
}
