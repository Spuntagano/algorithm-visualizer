/**
 * One card per variable. Each card has its own switch, and each name always means the same picture:
 *   Memory  how the values are stored (nesting, shared objects, cycles), for any array, object, Map or Set; the default
 *   Boxes   the values
 *   Graph   nodes and edges, offered only when the value is recognised as a graph (see GraphHelp.jsx)
 */
import { useMemo } from 'react';
import { buildMemoryView } from '../graph/memory.js';
import { buildSemanticView } from '../graph/semantic-view.js';
import { semanticGraph } from '../graph/semantic.js';
import { isCont, markersFor } from '../model.js';
import { Graph } from './Graph.jsx';
import { StepContext, Value } from './Values.jsx';

/** How an array, object, Map or Set is shown until its switch is used. */
export const DEFAULT_VIEW = 'memory';

function ViewSwitch({ name, mode, offerGraph, onChange }) {
  const opts = [['memory', 'Memory', 'How the values are stored: nesting, shared objects and cycles'], ['boxes', 'Boxes', 'The values, as boxes']];
  if (offerGraph) opts.push(['graph', 'Graph', 'Nodes and edges found in the keys and values (the ? next to Variables lists the shapes)']);
  return (
    <div className="vseg" role="group" aria-label={'How to show ' + name}>
      {opts.map(([m, label, title]) => (
        <button key={m} type="button" className={m === mode ? 'on' : ''} title={title} data-vt={name + '|' + m}
          aria-pressed={m === mode} onClick={() => onChange(name, m)}>{label}</button>
      ))}
    </div>
  );
}

/** What to draw for a variable: its graph, its memory layout, or nothing (→ boxes). */
function pickView(step, prev, v, wanted, sem, showPtrs) {
  if (wanted === 'graph') return sem ? buildSemanticView(step, prev, v.name, sem, showPtrs) : null;
  if (wanted === 'memory') {
    const mem = buildMemoryView(step, prev, v.name, showPtrs);
    if (mem) return { ...mem, caption: 'Memory layout · how the values are stored' };
  }
  return null;
}

function VarCard({ v, step, prev, stepNo, wanted, onView, showPtrs }) {
  const diff = !!prev;
  const pv = prev && prev.vars.find(x => x.name === v.name);
  const canGraph = isCont(v.node) || v.node.t === 'ref' || v.node.t === 'trunc';
  const sem = useMemo(() => (canGraph ? semanticGraph(step, v.name) : null), [canGraph, step, v.name]);
  const view = useMemo(
    () => (canGraph ? pickView(step, prev, v, wanted, sem, showPtrs) : null),
    [canGraph, step, prev, v, wanted, sem, showPtrs],
  );
  // a Graph choice survives a step where the value is not a graph (a list shrunk to one node): boxes, with a note
  const lostGraph = canGraph && wanted === 'graph' && !sem;
  const mode = view || lostGraph ? wanted : 'boxes';
  const changed = (diff && (!pv || JSON.stringify(pv.node) !== JSON.stringify(v.node))) || !!(view && view.changed);
  const markers = !view && showPtrs && v.node.t === 'arr' ? markersFor(v.node, step.vars, v.name) : null;

  return (
    <div className={'var' + (changed ? ' changed' : '')}>
      <div className="vname">
        {v.name}
        {v.scope !== 'local' && step.stack.length > 0 && <small>{v.scope}</small>}
        {canGraph && <ViewSwitch name={v.name} mode={mode} offerGraph={!!sem || lostGraph} onChange={onView} />}
      </div>
      {/* keyed by step so the "just changed" animation plays again on every step */}
      <div className="vval" key={stepNo}>
        {lostGraph && <p className="vnote">Not a graph at this step, so the values are shown.</p>}
        {view ? <Graph caption={view.caption} view={view} label={(mode === 'graph' ? 'Graph of ' : 'Memory layout of ') + v.name} />
          : <Value node={v.node} prev={pv ? pv.node : undefined} markers={markers} />}
      </div>
    </div>
  );
}

/**
 * @param views    maps a variable name to 'boxes', 'graph' or 'memory' (absent means DEFAULT_VIEW)
 * @param onView   called as onView(name, mode) when a switch is clicked
 */
export function Variables({ step, prev, stepNo, views, onView, showPtrs }) {
  const ctx = useMemo(() => ({ diff: !!prev, refs: new Set(step.refs) }), [prev, step]);
  return (
    <StepContext.Provider value={ctx}>
      <div id="vars">
        {!step.vars.length && <p className="empty">No variables declared yet.</p>}
        {step.vars.map(v => (
          <VarCard key={v.name} v={v} step={step} prev={prev} stepNo={stepNo}
            wanted={views[v.name] || DEFAULT_VIEW} onView={onView} showPtrs={showPtrs} />
        ))}
      </div>
    </StepContext.Provider>
  );
}
