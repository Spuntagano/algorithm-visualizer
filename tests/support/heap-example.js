/** What every language's "Binary heap" example must show in the Heap view (src/graph/heap.js). */
import assert from 'node:assert/strict';
import { buildHeapView, heapKind, heapMarkers, heapOf, heapSize } from '../../src/graph/heap.js';

/**
 * @param t     a trace: { steps, logs, error }
 * @param name  the heap's variable name as the engine reports it (PHP: '$heap')
 * @param o.tmpSwap  the example swaps through a temporary (three statements), so no single step changes two cells
 */
export function checkHeapExample(t, name, lang, { tmpSwap = false } = {}) {
  assert.equal(t.error, null, lang);
  assert.equal(t.logs.map(l => l.s).join(' ').match(/\d+/g).join(' '), '1 2 3 5 7 8 9', lang + ': popped smallest first');
  assert.equal(heapKind(name, t.steps), 'min', lang);
  const views = t.steps.map((s, i) => {
    const h = heapOf(s, name);
    if (!h) return null;
    const prev = i ? heapOf(t.steps[i - 1], name) : null;
    const size = heapSize(h, s.vars);
    return { h, size, view: buildHeapView(h, { prev, size, kind: 'min', markers: heapMarkers(h, s.vars, name) }), markers: heapMarkers(h, s.vars, name) };
  });
  const full = views.filter(v => v && v.size.size === 7);
  assert.ok(full.length, lang + ': all seven values in the heap at some point');
  assert.deepEqual(full[0].h.items.slice(0, 7).map(it => it.s), ['1', '3', '2', '5', '9', '8', '7'], lang + ': the heap after the seven pushes');
  assert.equal(full[0].view.bad, 0, lang + ': in order between operations');
  assert.ok(views.some(v => v && v.view.bad > 0), lang + ': a parent out of order mid-sift');
  if (tmpSwap) assert.ok(views.some(v => v && v.view.changed.size === 1), lang + ': each half of a swap changes a cell');
  else assert.ok(views.some(v => v && v.view.changed.size === 2), lang + ': a swap changes two cells in one step');
  assert.ok(views.some(v => v && v.markers[0] && Object.values(v.markers).flat().some(n => n.replace('$', '') === 'smallest')), lang + ': smallest tagged while sifting down');
  for (const v of views) if (v) for (const names of Object.values(v.markers)) for (const n of names) assert.doesNotMatch(n, /^\$?(x|top|last|size|k)$/, lang + ': a value or a count is never an index');
}
