# Algorithm Stepper (React edition)

Step through JavaScript one statement at a time and watch arrays, objects, Maps and Sets change.
Each variable can be shown as **Memory** (how the values are stored: nesting, shared objects, cycles), **Boxes** (the values) or **Graph** (nodes and edges: trees, linked lists and graphs built from the keys and values). Each name always means the same picture. Arrays, objects, Maps and Sets start in Memory (`DEFAULT_VIEW` in `src/components/Variables.jsx`); the choice is kept per variable while you step and edit.

## Breakpoints
Click a line number (or press F9 on a line) to toggle a breakpoint. **Continue** (F8) jumps to the next step on a marked
line, **previous** (Shift+F8) to the one before; Play pauses when it reaches one, and the timeline has a tick for every hit.
Because the whole run is recorded first, going back to an earlier breakpoint is as instant as going forward. Breakpoints
follow their code as you edit (`breakpointField` in `src/editor.js`) and are cleared when an example is loaded.

## What gets drawn as a graph
**Boxes** works for every value and **Memory** for every array, object, Map and Set. **Graph** is offered only when the value is one
of these shapes. A Graph choice survives a step where the value is not a graph (a list shrunk to one node): the card shows boxes and says so.
Rules in `src/graph/semantic.js`; the same summary is behind the **?** next to *Variables* in the app.
Most shapes are recognised by shape alone; names matter only where noted.

| Shape | Example | Notes |
|---|---|---|
| Object or Map of neighbour lists (arrays or Sets) | `{ A: ["B", "C"], B: ["C"] }` | keys are the nodes |
| …a listed name with no entry of its own | `{ a: ["b", "c"], b: ["c"] }` | `c` is still a node |
| …weighted, as objects or `[name, weight]` pairs | `{ A: { B: 4 } }`, `{ A: [["B", 4]] }` | weights on the edges |
| …A→B and B→A both listed | `{ A: ["B", "C"], B: ["A", "C"], C: ["A", "B"] }` | one edge without arrowheads |
| …neighbours written as edge objects | `{ A: [{ node: "B", weight: 4 }], B: [] }` | target and weight fields† |
| Array of index arrays | `const adj = [[1, 2], [2], []]` | **variable name** must contain `graph`, `adj`, `neigh`, `tree`, or be `g` |
| …neighbours as lists of values | `const adj = [[[1, 0, 3]], [[4, 2]], []]` | the node is the first position where every list holds a node number (first, middle or last); one other number is a weight, more go on the arrow (`0, 3`) |
| Array of `[from, to]` / `[from, to, weight]` | `const edges = [[0, 1], [1, 2, 7]]` | **variable name** must contain `edge` |
| Objects holding similar objects | `{ val: 1, next: { val: 2, next: null } }` | linked lists, doubly linked lists |
| …with `left` / `right` fields | `{ val: 1, left: {…}, right: {…} }` | binary tree, sides kept |
| …with an array of children or neighbours | `{ name: "r", children: [{…}, {…}] }`, `a.nbrs = [b, c]` | n-ary trees, node-and-neighbour graphs |
| Records naming each other by key | `{ a: { next: ["b"] }, b: { next: [] } }` | keys are the nodes |
| Records naming each other by index | `[{ v: "a", out: [1, 2] }, { v: "b", out: [] }]` | **field name** must look like a link\* |
| Records naming each other by a unique `id`, `key` or `name` | `[{ id: "test", deps: ["build"] }, { id: "build", deps: [] }]` | numeric ids need a link-like field name\* |
| …with edge objects | `[{ id: "A", edges: [{ to: "B", w: 4 }] }, { id: "B", edges: [] }]` | target and weight fields† |

\* `next`, `prev`, `out`, `adj`, `neigh`, `nbr`, `edge`, `link`, `child`, `kid`, `parent`, `left`, `right`, `succ`, `pred`, `dep`, or exactly `to` / `from` / `in`.
Numbers in other fields are data, so `[{ name: "A", age: 1 }]` stays as boxes.

† An edge object's target is the first of `to`, `node`, `target`, `dest`, `id`, `key`, `name`, `vertex`, `neighbor` / `neighbour`, `v`, `n`
that names a node (or else the one field whose value is a node's key); its weight is a `weight`, `w`, `cost`, `dist`, `distance`,
`len`, `length`, `capacity`, `cap` or `time` field. Its other values are drawn on the arrow as `key value` lines
(`{ v: 1, start: 0, end: 3 }` → `start 0` / `end 3`); an edge with only a weight shows the bare number.

- **Layout** follows the shape, whichever row matched: one chain from one start is drawn as a Linked list, a branching structure with one start as a Tree, anything else as a Graph (Undirected graph when no edge has a direction).
- **Labels**: nodes named by a key or id show it; other nodes take their label from a field named `val`, `value`, `data`, `key`, `name`, `id`, `label`, `title`, `v`, `x`, `n`, `item`, `char`, `letter` or `weight`; those fields are never links.
- **Tags**: another variable holding a node (or its name / index) shows on it as `↑ cur`; an array or Set containing nodes shows as `∈ visited`.
- **Values in a node**: each node lists its own plain values as `key value` rows (numbers, strings, booleans, short arrays; not links), up to 8 rows.
  When a node has values besides its label, the label field is a row too, so `{ id: 1, weight: 3 }` reads `id 1` / `weight 3`; a node with only a label (`{ val: 1, left, right }`) keeps the compact title.
  A value that changed since the last step is marked. Other variables never add rows to a node (they only tag it: `↑ cur`, `∈ visited`).
- **Not a graph**: lists of values that never name another entry (`{ fruits: ["apple"] }`), lone numbers (`memo = { 2: 1, 3: 2 }`), nested arrays of nodes (`kids: [[x], [y]]`).
- **Limits**: 60 nodes in Graph, 50 boxes in Memory; snapshots expand 5 levels deep, 60 items / 30 entries per container.

## Structure
- `src/engine/` – acorn instrumentation, snapshotting and tracing. Plain JS, no DOM, no React. `runner.js` runs the tracer in a Web Worker (bundled from `worker.js` by `build.mjs`) so an infinite loop is stopped after 3 s; it falls back to the main thread where workers are unavailable.
- `src/graph/` – graph math (general graphs and the Memory view are laid out by dagre, trees and lists by a small tidy-tree layout) and **view-model builders**. They return drawable primitives (`{tag, p, text}`), so geometry is testable without a DOM.
- `src/hooks/useStepper.js` – trace, step index, playback, re-runs.
- `src/editor.js` – CodeMirror 6 setup: highlighting, keys, and the current/previous step lines (the step state is testable without a DOM).
- `src/components/` – React UI. `CodePanel.jsx` hosts the CodeMirror editor, always editable: an edit re-runs the code (after a short pause in typing) and goes back to step 1; `Graph.jsx` turns primitives into SVG.
- `css/` – styles, inlined into the build.

## Commands
    npm install
    npm run build        # dist/algorithm-stepper.html (one self-contained file, ~970 KB)
    npm run dev          # watch + unminified build (shows React warnings), served on http://localhost:8000/
    npm run check        # lint + unit tests
    npm run test:browser # Playwright against the built file

## Recipes
- New example: add it to `src/examples.js`.
- New view of a value: add a builder in `src/graph/` returning `{width, height, prims}` and render it with `<Graph>`.
