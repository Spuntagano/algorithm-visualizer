/**
 * One card per variable. Each card has its own Boxes | Graph | Raw switch; "Raw" is offered only when
 * a graph pattern was found in the variable's keys and values.
 */
import { useMemo } from 'react';
import { buildMemoryView } from '../graph/memory.js';
import { buildSemanticView } from '../graph/semantic-view.js';
import { semanticGraph } from '../graph/semantic.js';
import { isCont, markersFor } from '../model.js';
import { Graph } from './Graph.jsx';
import { StepContext, Value } from './Values.jsx';

function ViewSwitch({ name, mode, hasSem, onChange }) {
  const opts = [['boxes', 'Boxes', 'Show the values as boxes'],
    ['graph', 'Graph', hasSem ? 'Nodes and edges drawn from the keys and values' : 'Draw how the values nest, as a diagram']];
  if (hasSem) opts.push(['raw', 'Raw', 'How the data is laid out in memory']);
  return (
    <div className="vseg" role="group" aria-label={'How to show ' + name}>
      {opts.map(([m, label, title]) => (
        <button key={m} type="button" className={m === mode ? 'on' : ''} title={title} data-vt={name + '|' + m}
          aria-pressed={m === mode} onClick={() => onChange(name, m)}>{label}</button>
      ))}
    </div>
  );
}

/** What to draw for a variable: a semantic graph, the memory layout, or nothing (→ boxes). */
function pickView(step, prev, v, wanted, sem, showPtrs) {
  if (wanted === 'graph' && sem) return { ...buildSemanticView(step, prev, v.name, sem, showPtrs) };
  if (wanted !== 'boxes') {
    const raw = buildMemoryView(step, prev, v.name, showPtrs);
    if (raw) return { ...raw, caption: sem ? 'Memory layout · how the values are stored' : 'Structure · no node-and-edge pattern found, showing how the values nest' };
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
  const mode = view ? wanted : 'boxes';
  const changed = (diff && (!pv || JSON.stringify(pv.node) !== JSON.stringify(v.node))) || !!(view && view.changed);
  const markers = !view && showPtrs && v.node.t === 'arr' ? markersFor(v.node, step.vars, v.name) : null;

  return (
    <div className={'var' + (changed ? ' changed' : '')}>
      <div className="vname">
        {v.name}
        {v.scope !== 'local' && step.stack.length > 0 && <small>{v.scope}</small>}
        {canGraph && <ViewSwitch name={v.name} mode={mode} hasSem={!!sem} onChange={onView} />}
      </div>
      {/* keyed by step so the "just changed" animation plays again on every step */}
      <div className="vval" key={stepNo}>
        {view ? <Graph caption={view.caption} view={view} label={'Graph of ' + v.name} />
          : <Value node={v.node} prev={pv ? pv.node : undefined} markers={markers} />}
      </div>
    </div>
  );
}

/**
 * @param views    maps a variable name to 'graph' or 'raw' (absent means boxes)
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
            wanted={views[v.name] || 'boxes'} onView={onView} showPtrs={showPtrs} />
        ))}
      </div>
    </StepContext.Provider>
  );
}
