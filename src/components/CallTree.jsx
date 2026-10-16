/**
 * The Calls section: the call stack at this step, or the call tree (every call made so far, under the call that made
 * it; graph/calltree.js). The tree is offered once the program calls a function, and shown first when it recurses.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { callTree, callTreeView, layoutCallTree } from '../graph/calltree.js';
import { Prims } from './Graph.jsx';

function CallStack({ stack }) {
  return (
    <div id="stack" className="frames">
      {stack.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => (
        <div key={i} className={'frame' + (i === stack.length - 1 ? ' top' : '')}>{f.name}(<span className="args">{f.args}</span>)</div>
      ))}
      <div className="frame base">top level{stack.length ? '' : ' (not inside a function)'}</div>
    </div>
  );
}

/** The tree at step `stepNo`, scrolled so the running call stays in sight. */
function Tree({ tree, layout, stepNo }) {
  const box = useRef(null);
  const view = useMemo(() => callTreeView(tree, layout, stepNo), [tree, layout, stepNo]);
  useEffect(() => {
    const el = box.current, cur = view.top !== undefined ? layout.pos[view.top] : null;
    if (!el || !cur) return;
    const H = 42;
    if (cur.x < el.scrollLeft || cur.x + cur.w > el.scrollLeft + el.clientWidth) el.scrollLeft = cur.x + cur.w / 2 - el.clientWidth / 2;
    if (cur.y < el.scrollTop || cur.y + H > el.scrollTop + el.clientHeight) el.scrollTop = cur.y + H / 2 - el.clientHeight / 2;
  }, [view, layout]);
  return (
    <div className="gwrap" id="callTree">
      <div className="gcap">{view.caption}</div>
      <div className="graph" ref={box}>
        <svg className="gsvg" width={view.width} height={view.height} viewBox={`0 0 ${view.width} ${view.height}`} role="img"
          aria-label={`Call tree: ${view.shown} calls so far`}>
          <Prims list={view.prims} marks="ct" />
        </svg>
      </div>
    </div>
  );
}

/** @param trace  the whole run (its steps and `rets`), for the tree; @param stepNo  the step shown */
export function Calls({ trace, step, stepNo }) {
  const tree = useMemo(() => (trace ? callTree(trace.steps, trace.rets || {}) : null), [trace]);
  const layout = useMemo(() => (tree && tree.nodes.length ? layoutCallTree(tree) : null), [tree]);
  const [choice, setChoice] = useState(null);   // what the switch picked; until then, the tree for a recursive program
  const mode = layout ? choice || (tree.recursive ? 'tree' : 'stack') : 'stack';
  return (
    <>
      <div className="sect-head">
        <h2>{mode === 'tree' ? 'Call tree' : 'Call stack'}</h2>
        {layout && (
          <div className="vseg" role="group" aria-label="How to show the calls">
            {[['stack', 'Stack', 'The calls running at this step'], ['tree', 'Tree', 'Every call made so far, under the call that made it']].map(([m, label, title]) => (
              <button key={m} type="button" id={'calls-' + m} className={m === mode ? 'on' : ''} title={title} aria-pressed={m === mode}
                onClick={() => setChoice(m)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {mode === 'tree' ? <Tree tree={tree} layout={layout} stepNo={stepNo} /> : <CallStack stack={step.stack} />}
    </>
  );
}
