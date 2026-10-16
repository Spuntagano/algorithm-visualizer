/**
 * CodeMirror 6 setup for the code panel: JavaScript / TypeScript / Lua / Python / Ruby / PHP / Java / Kotlin / C# / Go / C / C++ highlighting, the editing keymap, the
 * current / previous step lines while stepping, and breakpoints. Colours come from the CSS variables in css/tokens.css,
 * so light and dark mode follow the rest of the page. Only the view needs a DOM; the state parts
 * (stepField, setStep) can be used and tested without one.
 */
import { indentLess, indentMore, defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { pythonLanguage } from '@codemirror/lang-python';
import { HighlightStyle, StreamLanguage, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lua as luaMode } from '@codemirror/legacy-modes/mode/lua';
import { ruby as rubyMode } from '@codemirror/legacy-modes/mode/ruby';
import { cMode, cppMode, csMode, goMode, javaMode, ktMode } from './c-mode.js';
import { phpMode } from './php-mode.js';
import { Compartment, EditorState, MapMode, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, gutterLineClass, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** Sets the step lines (1-based; 0 = none). */
export const setStep = StateEffect.define();

const curLine = Decoration.line({ class: 'cm-step-cur', attributes: { 'aria-current': 'step' } });
const prevLine = Decoration.line({ class: 'cm-step-prev' });
const curGutter = new class extends GutterMarker { elementClass = 'cm-step-cur'; }();

/** The current and previous step lines, kept valid when the document changes. */
export const stepField = StateField.define({
  create: () => ({ line: 0, prevLine: 0 }),
  update(v, tr) {
    const set = tr.effects.find(e => e.is(setStep));
    if (set) return set.value;
    return tr.docChanged && (v.line || v.prevLine) ? { line: 0, prevLine: 0 } : v;   // stale after an edit
  },
  provide: f => [
    EditorView.decorations.compute([f], state => stepDecorations(state, state.field(f))),
    gutterLineClass.compute([f], state => {
      const { line } = state.field(f), b = new RangeSetBuilder();
      if (line >= 1 && line <= state.doc.lines) b.add(state.doc.line(line).from, state.doc.line(line).from, curGutter);
      return b.finish();
    }),
  ],
});

function stepDecorations(state, { line, prevLine: prev }) {
  const marks = [];
  if (prev && prev !== line) marks.push([prev, prevLine]);
  if (line) marks.push([line, curLine]);
  marks.sort((a, b) => a[0] - b[0]);
  const b = new RangeSetBuilder();
  for (const [n, deco] of marks) if (n >= 1 && n <= state.doc.lines) b.add(state.doc.line(n).from, state.doc.line(n).from, deco);
  return b.finish();
}

/** Line numbers carrying each step decoration, as { cur: [...], prev: [...] } (for tests). */
export function stepLines(state) {
  const out = { cur: [], prev: [] };
  for (const set of state.facet(EditorView.decorations)) if (typeof set !== 'function') set.between(0, state.doc.length, (from, _to, deco) => {
    const cls = deco.spec.class, n = state.doc.lineAt(from).number;
    if (cls === 'cm-step-cur') out.cur.push(n); else if (cls === 'cm-step-prev') out.prev.push(n);
  });
  return out;
}

/* Breakpoints: one marker per marked line, anchored where its code starts (after the indentation), so it moves with
   the code as it is edited: Enter before the code takes the marker down with it (Enter on an indented line replaces the
   indentation, which a marker at the line start would stay in front of); re-indenting keeps it; deleting the line removes it. */
export const toggleBreakpoint = StateEffect.define();   // value: any position on the line
export const clearBreakpoints = StateEffect.define();

const bpMarker = new class extends GutterMarker {
  startSide = 1; endSide = 1;                        // stay with the code when text is inserted right before it (both sides, or it is dropped)
  mapMode = MapMode.TrackDel;                        // gone only when the text on both sides of it is deleted, i.e. the line
  toDOM() { const d = document.createElement('span'); d.className = 'cm-bp-dot'; return d; }
}();

/** Where a line's code starts: after its indentation (the line end for a blank line). */
const codeStart = line => line.from + (/^\s*/.exec(line.text)[0].length);

export const breakpointField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (tr.effects.some(e => e.is(clearBreakpoints))) return RangeSet.empty;
    const doc = tr.state.doc;
    let lines = null;                                // a set of line numbers, rebuilt only when something changed
    if (tr.docChanged) { set = set.map(tr.changes); lines = new Set(); set.between(0, doc.length, from => { lines.add(doc.lineAt(from).number); }); }
    for (const e of tr.effects) if (e.is(toggleBreakpoint)) {
      if (!lines) { lines = new Set(); set.between(0, doc.length, from => { lines.add(doc.lineAt(from).number); }); }
      const n = doc.lineAt(Math.min(e.value, doc.length)).number;
      if (lines.has(n)) lines.delete(n); else lines.add(n);
    }
    return lines ? RangeSet.of([...lines].sort((a, b) => a - b).map(n => bpMarker.range(codeStart(doc.line(n))))) : set;
  },
});

/** The marked line numbers, in order. */
export function breakpointLines(state) {
  const out = [];
  state.field(breakpointField).between(0, state.doc.length, from => { out.push(state.doc.lineAt(from).number); });
  return out;
}

const toggleAt = (view, line) => { view.dispatch({ effects: toggleBreakpoint.of(line.from) }); return true; };
// the gutter only draws markers placed at a line's start, while the anchors sit where the code starts: draw a copy
const atLineStarts = new WeakMap();
const gutterMarkers = state => {
  const anchors = state.field(breakpointField);
  if (!atLineStarts.has(anchors)) atLineStarts.set(anchors, RangeSet.of(breakpointLines(state).map(n => bpMarker.range(state.doc.line(n).from))));
  return atLineStarts.get(anchors);
};
const breakpointGutter = [
  gutter({
    class: 'cm-bp-gutter', markers: v => gutterMarkers(v.state), initialSpacer: () => bpMarker,
    domEventHandlers: { mousedown: toggleAt },
  }),
];

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.self, t.atom], color: 'var(--code-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-str)' },
  { tag: t.number, color: 'var(--code-num)' },
  { tag: t.comment, color: 'var(--code-com)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--surface)', fontSize: '13.5px', height: '100%' },
  '&.cm-focused': { outline: 'none' },                       // no focus border: the blinking cursor shows it
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 16px 0 4px', borderLeft: '3px solid transparent' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 8px 0 4px', cursor: 'pointer' },   // click: toggle a breakpoint
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  // the selection is drawn BELOW the text, so the step lines on top of it are translucent (css/tokens.css)
  '.cm-selectionBackground': { backgroundColor: 'var(--code-sel-blur)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--code-sel)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--line)' },
  '.cm-line.cm-step-prev': { backgroundColor: 'var(--code-prev)' },
  '.cm-line.cm-step-cur': { backgroundColor: 'var(--code-cur)', borderLeftColor: 'var(--accent)' },
  '.cm-gutterElement.cm-step-cur': { color: 'var(--accent)', fontWeight: '700' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-bp-gutter': { cursor: 'pointer', minWidth: '16px' },
  '.cm-bp-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-bp-dot': { width: '9px', height: '9px', borderRadius: '50%', backgroundColor: 'var(--err)', display: 'block' },
});

/** @typedef {'javascript' | 'typescript' | 'lua' | 'python' | 'ruby' | 'php' | 'java' | 'kotlin' | 'csharp' | 'go' | 'c' | 'cpp'} Lang */
export const LANG_NAMES = { javascript: 'JavaScript', typescript: 'TypeScript', lua: 'Lua', python: 'Python', ruby: 'Ruby', php: 'PHP', java: 'Java', kotlin: 'Kotlin', csharp: 'C#', go: 'Go', c: 'C', cpp: 'C++' };
const luaLanguage = StreamLanguage.define(luaMode), rubyLanguage = StreamLanguage.define(rubyMode), cLanguage = StreamLanguage.define(cMode),
  phpLanguage = StreamLanguage.define(phpMode), cppLanguage = StreamLanguage.define(cppMode),
  javaLanguage = StreamLanguage.define(javaMode), goLanguage = StreamLanguage.define(goMode), csLanguage = StreamLanguage.define(csMode), ktLanguage = StreamLanguage.define(ktMode);

/* Everything about the editor that depends on the language: highlighting, indentation, the hint and the label. */
const languageConf = new Compartment();
const languageExtensions = lang => [
  lang === 'python' ? pythonLanguage : lang === 'typescript' ? typescriptLanguage : lang === 'lua' ? luaLanguage : lang === 'ruby' ? rubyLanguage : lang === 'c' ? cLanguage : lang === 'php' ? phpLanguage : lang === 'cpp' ? cppLanguage : lang === 'java' ? javaLanguage : lang === 'go' ? goLanguage : lang === 'csharp' ? csLanguage : lang === 'kotlin' ? ktLanguage : javascriptLanguage,
  indentUnit.of(['python', 'c', 'cpp', 'php', 'java', 'kotlin', 'csharp', 'go'].includes(lang) ? '    ' : '  '), EditorState.tabSize.of(['python', 'c', 'cpp', 'php', 'java', 'kotlin', 'csharp', 'go'].includes(lang) ? 4 : 2),
  placeholder(`Write or paste ${LANG_NAMES[lang]}, or pick an example above`),
  EditorView.contentAttributes.of({ 'aria-label': LANG_NAMES[lang] + ' code' }),
];
/** Switches an editor to another language (the code itself is left as it is). */
export function setLanguage(view, lang) { view.dispatch({ effects: languageConf.reconfigure(languageExtensions(lang)) }); }

/** Tab inserts one indent (two spaces, or four in Python) at the cursor, or indents a selection; Shift-Tab outdents. */
const tabKeys = [
  { key: 'Tab', run: v => v.state.selection.ranges.some(r => !r.empty) ? indentMore(v) : (v.dispatch(v.state.replaceSelection(v.state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' }), true) },
  { key: 'Shift-Tab', run: indentLess },
];

/**
 * Everything the editor needs.
 * @param {{ onChange: (code: string) => void, onRun: () => void, onBreakpoints?: (lines: number[]) => void, lang?: Lang }} o
 */
export function editorExtensions({ onChange, onRun, onBreakpoints = () => {}, lang = 'javascript' }) {
  return [
    breakpointField, breakpointGutter, lineNumbers({ domEventHandlers: { mousedown: toggleAt } }), history(), drawSelection(), bracketMatching(),
    languageConf.of(languageExtensions(lang)), syntaxHighlighting(highlight), theme, stepField,
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { onRun(); return true; } },
      { key: 'F9', run: v => { v.dispatch({ effects: toggleBreakpoint.of(v.state.selection.main.head) }); return true; } },
    ])),
    keymap.of([...tabKeys, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ id: 'editor', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    EditorView.updateListener.of(u => {
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.startState.field(breakpointField) !== u.state.field(breakpointField)) {      // rebuilt on edits: report real changes only
        const before = breakpointLines(u.startState), after = breakpointLines(u.state);
        if (before.join() !== after.join()) onBreakpoints(after);
      }
    }),
  ];
}

export { EditorState, EditorView };
