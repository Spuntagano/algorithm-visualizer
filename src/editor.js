/**
 * CodeMirror 6 setup for the code panel: JavaScript highlighting, the editing keymap, and the
 * current / previous step lines while stepping. Colours come from the CSS variables in css/tokens.css,
 * so light and dark mode follow the rest of the page. Only the view needs a DOM; the state parts
 * (stepField, setStep) can be used and tested without one.
 */
import { indentLess, indentMore, defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, drawSelection, gutterLineClass, keymap, lineNumbers } from '@codemirror/view';
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

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.self, t.atom], color: 'var(--code-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-str)' },
  { tag: t.number, color: 'var(--code-num)' },
  { tag: t.comment, color: 'var(--code-com)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--surface)', fontSize: '13.5px', height: '100%' },
  '&.cm-focused': { outline: 'none' },                       // the panel shows focus: see css/layout.css
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 16px 0 4px', borderLeft: '3px solid transparent' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 8px 0 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--accent-tint)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--line)' },
  '.cm-line.cm-step-prev': { backgroundColor: 'var(--surface-2)' },
  '.cm-line.cm-step-cur': { backgroundColor: 'var(--accent-tint)', borderLeftColor: 'var(--accent)' },
  '.cm-gutterElement.cm-step-cur': { color: 'var(--accent)', fontWeight: '700' },
});

/** Tab inserts two spaces at the cursor (or indents a selection); Shift-Tab outdents. */
const tabKeys = [
  { key: 'Tab', run: v => v.state.selection.ranges.some(r => !r.empty) ? indentMore(v) : (v.dispatch(v.state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input' }), true) },
  { key: 'Shift-Tab', run: indentLess },
];

/**
 * Everything the editor needs. `editable` is a Compartment the caller reconfigures between modes.
 * @param {{ onChange: (code: string) => void, onRun: () => void, editable: Compartment }} o
 */
export function editorExtensions({ onChange, onRun, editable }) {
  return [
    lineNumbers(), history(), drawSelection(), bracketMatching(), indentUnit.of('  '), EditorState.tabSize.of(2),
    javascriptLanguage, syntaxHighlighting(highlight), theme, stepField,
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { onRun(); return true; } }])),
    keymap.of([...tabKeys, ...defaultKeymap, ...historyKeymap]),
    editable.of(modeExtensions(true)),
    EditorView.contentAttributes.of({ id: 'editor', 'aria-label': 'JavaScript code', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
  ];
}

/** Editable while editing; read-only while stepping. */
export const modeExtensions = editing => [EditorView.editable.of(editing), EditorState.readOnly.of(!editing)];

export { Compartment, EditorState, EditorView };
