# Algorithm Stepper (React edition)

Step through JavaScript one statement at a time and watch arrays, objects, Maps and Sets change.
Each variable can be shown as **Boxes**, **Graph** (trees, linked lists and graphs built from the keys and values) or **Raw** (memory layout).

## Structure
- `src/engine/` – acorn instrumentation, snapshotting and tracing. Plain JS, no DOM, no React. `runner.js` runs the tracer in a Web Worker (bundled from `worker.js` by `build.mjs`) so an infinite loop is stopped after 3 s; it falls back to the main thread where workers are unavailable.
- `src/graph/` – graph math (general graphs and the Raw memory view are laid out by dagre, trees and lists by a small tidy-tree layout) and **view-model builders**. They return drawable primitives (`{tag, p, text}`), so geometry is testable without a DOM.
- `src/hooks/useStepper.js` – trace, step index, playback, mode.
- `src/editor.js` – CodeMirror 6 setup: highlighting, keys, and the current/previous step lines (the step state is testable without a DOM).
- `src/components/` – React UI. `CodePanel.jsx` hosts the one CodeMirror editor (editable while editing, read-only while stepping); `Graph.jsx` turns primitives into SVG.
- `css/` – styles, inlined into the build.

## Commands
    npm install
    npm run build        # dist/algorithm-stepper.html (one self-contained file, ~970 KB)
    npm run dev          # watch + unminified build (shows React warnings)
    npm run check        # lint + unit tests
    npm run test:browser # Playwright against the built file

## Recipes
- New example: add it to `src/examples.js`.
- New view of a value: add a builder in `src/graph/` returning `{width, height, prims}` and render it with `<Graph>`.
