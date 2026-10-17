# CLAUDE.md

The README explains the features, commands and source layout; read it first. This file has only what it doesn't say.

## Working rules
- Run `npm run check` (lint, unit tests, build) before committing. Pushing to `master` deploys the site.
- Every example exists in every language: the `*_EXAMPLES` objects in `src/examples.js` all have the same names, so
  switching language can swap an untouched example for its twin. A new example means one entry per language.
- `src/engine/` and `src/graph/` stay plain JS with no DOM and no React, so they can be tested in Node.
- Each tracer emits the same snapshot format, so the views never need to know which language ran.

## Adding things
- **A language:** use an existing one (e.g. Kotlin) as the map; `grep -ril kotlin` outside `src/engine/kotlin/` lists
  every place to touch. That is its engine under `src/engine/<lang>/`, `build.mjs` (engine packing), `runner.js`,
  `worker.js` and `sync.js`, `src/editor.js` (`LANG_NAMES`, highlighting; `src/c-mode.js` for C-like ones),
  `App.jsx` (`EXAMPLES_BY_LANG`), `StatePanel.jsx` (the print word), `LangInfo.jsx`, `GraphHelp.jsx` (examples in that
  language), `index.html`, its examples, `tests/<lang>.test.js` and `tests/browser.mjs`, and the README's Languages
  table and section.
- **A graph shape:** the rule in `src/graph/semantic.js`, the in-app help in `src/components/GraphHelp.jsx`, and the
  table in the README's "What gets drawn as a graph", all three kept in step.

## README
- Keep what a visitor needs first (link, demo, features, getting started) at the top and per-language detail at the
  bottom.
- `docs/demo.gif` is the only image; regenerate it with `node tools/demo-gif.mjs` after a build when the look changes.

## Environment
Headless Chromium (`npm run test:browser`, `tools/og-images.mjs`, `tools/demo-gif.mjs`) needs system libraries that may
be missing (`libnss3`, `libnspr4`, `libasound2t64`). Install them once with `sudo npx playwright install-deps chromium`.
