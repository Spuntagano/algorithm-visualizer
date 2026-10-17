/**
 * One card per variable. Each card has its own switch, and each name always means the same picture:
 *   Memory  how the values are stored (nesting, shared objects, cycles), for any array, object, Map or Set; the default
 *   Boxes   the values
 *   Grid    rows and columns, offered for an array of arrays of plain values (graph/grid.js); shown first for one
 *   Heap    the binary tree an array stands for (graph/heap.js), offered for an array of plain values; shown first for
 *           one named like a heap (heap, pq, minHeap…)
 *   Graph   nodes and edges, offered only when the value is recognised as a graph (see GraphHelp.jsx)
 */
import { useMemo } from 'react';
import { buildMemoryView } from '../graph/memory.js';
import { buildSemanticView } from '../graph/semantic-view.js';
import { semanticGraph } from '../graph/semantic.js';
import { changedCells, gridMarkers, gridOf } from '../graph/grid.js';
import { buildHeapView, heapKind, heapMarkers, heapOf, heapSize, isHeapName } from '../graph/heap.js';
import { isCont, markersFor } from '../model.js';
import { Graph } from './Graph.jsx';
import { GridView } from './GridView.jsx';
import { StepContext, Value } from './Values.jsx';

/** How an array, object, Map or Set is shown until its switch is used. */
export const DEFAULT_VIEW = 'memory';

function ViewSwitch({ name, mode, offerGraph, offerGrid, offerHeap, onChange }) {
  const opts = [['memory', 'Memory', 'How the values are stored: nesting, shared objects and cycles'], ['boxes', 'Boxes', 'The values, as boxes']];
  if (offerGrid) opts.push(['grid', 'Grid', 'Rows and columns, like a table']);
  if (offerHeap) opts.push(['heap', 'Heap', 'A binary tree: the children of the k-th cell are the (2k + 1)-th and (2k + 2)-th']);
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

/** The Heap view of `heap` (from heapOf) at this step. */
function heapView(heap, step, prev, name, steps, showPtrs) {
  const size = heapSize(heap, step.vars);
  const view = buildHeapView(heap, {
    prev: prev ? heapOf(prev, name) : null, size, kind: heapKind(name, steps, step),
    markers: showPtrs ? heapMarkers(heap, step.vars, name) : null,
  });
  return { ...view, changed: view.changed.size > 0 };
}

function VarCard({ v, step, prev, stepNo, chosen, onView, showPtrs, steps }) {
  const diff = !!prev;
  const pv = prev && prev.vars.find(x => x.name === v.name);
  const canGraph = isCont(v.node) || v.node.t === 'ref' || v.node.t === 'trunc';
  const grid = useMemo(() => (canGraph ? gridOf(step, v.name) : null), [canGraph, step, v.name]);
  const heap = useMemo(() => (canGraph ? heapOf(step, v.name) : null), [canGraph, step, v.name]);
  const heapNamed = isHeapName(v.name);
  const offerHeap = !!heap && (heap.len >= 2 || heapNamed);   // any list of numbers can be a heap; an empty one only by name
  // a grid, or a list named like a heap, is shown as one until the switch says otherwise; a Grid or Heap choice waits
  // out a step where the value is not one
  const auto = grid ? 'grid' : heap && heapNamed ? 'heap' : DEFAULT_VIEW;
  const wanted = (chosen === 'grid' && !grid) || (chosen === 'heap' && !heap) ? auto : chosen || auto;
  const sem = useMemo(() => (canGraph ? semanticGraph(step, v.name) : null), [canGraph, step, v.name]);
  const view = useMemo(
    () => (!canGraph || wanted === 'grid' ? null
      : wanted === 'heap' ? heapView(heap, step, prev, v.name, steps, showPtrs)
      : pickView(step, prev, v, wanted, sem, showPtrs)),
    [canGraph, step, prev, v, wanted, sem, heap, steps, showPtrs],
  );
  // a Graph choice survives a step where the value is not a graph (a list shrunk to one node): boxes, with a note
  const lostGraph = canGraph && wanted === 'graph' && !sem;
  const mode = view || lostGraph || wanted === 'grid' ? wanted : 'boxes';
  const gridParts = useMemo(() => {
    if (mode !== 'grid') return null;
    const pg = prev ? gridOf(prev, v.name) : null;
    return { changed: changedCells(grid, pg && pg.id === grid.id ? pg : null), markers: showPtrs ? gridMarkers(grid, step.vars, v.name) : null };
  }, [mode, grid, prev, step, v.name, showPtrs]);
  const changed = (diff && (!pv || JSON.stringify(pv.node) !== JSON.stringify(v.node))) || !!(view && view.changed);
  const markers = !view && showPtrs && v.node.t === 'arr' ? markersFor(v.node, step.vars, v.name) : null;

  return (
    <div className={'var' + (changed ? ' changed' : '')}>
      <div className="vname">
        {v.name}
        {v.scope !== 'local' && step.stack.length > 0 && <small>{v.scope}</small>}
        {canGraph && <ViewSwitch name={v.name} mode={mode} offerGraph={!!sem || lostGraph} offerGrid={!!grid} offerHeap={offerHeap} onChange={onView} />}
      </div>
      {/* keyed by step so the "just changed" animation plays again on every step */}
      <div className="vval" key={stepNo}>
        {lostGraph && <p className="vnote">Not a graph at this step, so the values are shown.</p>}
        {gridParts ? <GridView grid={grid} name={v.name} {...gridParts} />
          : view ? <Graph caption={view.caption} view={view} label={(mode === 'graph' ? 'Graph of ' : mode === 'heap' ? 'Heap of ' : 'Memory layout of ') + v.name} />
          : <Value node={v.node} prev={pv ? pv.node : undefined} markers={markers} />}
      </div>
    </div>
  );
}

/**
 * @param views    maps a variable name to 'boxes', 'grid', 'heap', 'graph' or 'memory' (absent: Grid for a grid, Heap for a
 *                 list named like a heap, else DEFAULT_VIEW)
 * @param onView   called as onView(name, mode) when a switch is clicked
 * @param steps    every step of the run, or null: whether a heap is a min- or a max-heap is decided over all of them
 */
export function Variables({ step, prev, stepNo, views, onView, showPtrs, steps = null }) {
  const ctx = useMemo(() => ({ diff: !!prev, refs: new Set(step.refs) }), [prev, step]);
  return (
    <StepContext.Provider value={ctx}>
      <div id="vars">
        {!step.vars.length && <p className="empty">No variables declared yet.</p>}
        {step.vars.map(v => (
          <VarCard key={v.name} v={v} step={step} prev={prev} stepNo={stepNo}
            chosen={views[v.name]} onView={onView} showPtrs={showPtrs} steps={steps} />
        ))}
      </div>
    </StepContext.Provider>
  );
}
