/** The left panel: one CodeMirror editor, editable while editing, read-only with the current line while stepping. */
import { useEffect, useRef } from 'react';
import { Compartment, EditorState, EditorView, editorExtensions, modeExtensions, setStep } from '../editor.js';

function CodeEditor({ editing, code, onCode, onRun, line, prevLine }) {
  const host = useRef(null), view = useRef(null);
  const latest = useRef({ onCode, onRun });
  latest.current = { onCode, onRun };
  const editable = useRef(null);

  useEffect(() => {                                         // create once; React never touches its DOM
    editable.current = new Compartment();
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: code,
        extensions: editorExtensions({ onChange: c => latest.current.onCode(c), onRun: () => latest.current.onRun(), editable: editable.current }),
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  useEffect(() => {                                         // code set from outside (an example was picked)
    const v = view.current;
    if (!v || v.state.doc.toString() === code) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code }, selection: { anchor: 0 }, scrollIntoView: true });
  }, [code]);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch({ effects: editable.current.reconfigure(modeExtensions(editing)) });
  }, [editing]);

  useEffect(() => {                                         // step lines, kept in view
    const v = view.current;
    if (!v) return;
    const lines = editing ? { line: 0, prevLine: 0 } : { line, prevLine };
    const n = lines.line, effects = [setStep.of(lines)];
    if (n >= 1 && n <= v.state.doc.lines) effects.push(EditorView.scrollIntoView(v.state.doc.line(n).from, { y: 'nearest', yMargin: 48 }));
    v.dispatch({ effects });
  }, [editing, line, prevLine, code]);

  return <div className={'code-editor' + (editing ? ' editing' : '')} ref={host} />;
}

/**
 * @param banner  status line under the code, as an object with `text` and `error`, or null
 */
export function CodePanel({ editing, code, onCode, onRun, line, prevLine, banner }) {
  return (
    <section className="panel code-panel" aria-label="Code">
      <CodeEditor editing={editing} code={code} onCode={onCode} onRun={onRun} line={line} prevLine={prevLine} />
      {banner && <div id="banner" className={'banner' + (banner.error ? ' err' : '')} role="status">{banner.text}</div>}
    </section>
  );
}
