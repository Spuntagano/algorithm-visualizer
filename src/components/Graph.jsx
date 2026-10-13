/**
 * Draws a graph view-model (see graph/memory.js and graph/semantic-view.js): a caption above a
 * scrollable SVG. All layout is already done; this only turns primitives into elements.
 */
import { useId } from 'react';

/** Render a list of { tag, p, text | kids } primitives. */
export function Prims({ list, marks }) {
  return list.map((n, i) => {
    const Tag = n.tag;
    const props = n.p.markerEnd ? { ...n.p, markerEnd: `url(#${marks}-${n.p.markerEnd})` } : n.p;
    return <Tag key={i} {...props}>{n.kids ? <Prims list={n.kids} marks={marks} /> : n.text}</Tag>;
  });
}

/**
 * @param caption  line shown above the diagram
 * @param view     view-model with `width`, `height` and `prims`
 * @param label    accessible name of the diagram
 */
export function Graph({ caption, view, label }) {
  const uid = 'g' + useId().replace(/[^\w-]/g, '');   // unique per graph, so several can share a page
  return (
    <div className="gwrap">
      <div className="gcap">{caption}</div>
      <div className="graph">
        <svg className="gsvg" width={view.width} height={view.height} viewBox={`0 0 ${view.width} ${view.height}`} role="img" aria-label={label}>
          <defs>
            {[['arrow', 'g-head'], ['arrow-chg', 'g-head chg']].map(([name, cls]) => (
              <marker key={name} id={`${uid}-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L10,5 L0,10z" className={cls} />
              </marker>
            ))}
          </defs>
          <Prims list={view.prims} marks={uid} />
        </svg>
      </div>
    </div>
  );
}
