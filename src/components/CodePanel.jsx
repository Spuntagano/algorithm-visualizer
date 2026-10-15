/** The left panel: one CodeMirror editor, always editable, showing the current and previous step lines. */
import { useEffect, useRef } from 'react';
import { EditorState, EditorView, clearBreakpoints, editorExtensions, setStep } from '../editor.js';

function CodeEditor({ code, onCode, onRun, onBreakpoints, line, prevLine }) {
  const host = useRef(null), view = useRef(null);
  const latest = useRef({ onCode, onRun, onBreakpoints });
  latest.current = { onCode, onRun, onBreakpoints };

  useEffect(() => {                                         // create once; React never touches its DOM
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: code,
        extensions: editorExtensions({ onChange: c => latest.current.onCode(c), onRun: () => latest.current.onRun(), onBreakpoints: b => latest.current.onBreakpoints(b) }),
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  useEffect(() => {                                         // code set from outside (an example was picked): new code, no breakpoints
    const v = view.current;
    if (!v || v.state.doc.toString() === code) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code }, effects: clearBreakpoints.of(null), selection: { anchor: 0 }, scrollIntoView: true });
  }, [code]);

  useEffect(() => {                                         // step lines, kept in view unless the cursor is in use
    const v = view.current;
    if (!v) return;
    const effects = [setStep.of({ line, prevLine })];
    if (!v.hasFocus && line >= 1 && line <= v.state.doc.lines) effects.push(EditorView.scrollIntoView(v.state.doc.line(line).from, { y: 'nearest', yMargin: 48 }));
    v.dispatch({ effects });
  }, [line, prevLine, code]);

  return <div className="code-editor" ref={host} />;
}

/**
 * @param banner         status line under the code, as an object with `text` and `error`, or null
 * @param onBreakpoints  called with the marked line numbers whenever breakpoints are added, removed or moved
 */
export function CodePanel({ code, onCode, onRun, onBreakpoints, line, prevLine, banner }) {
  return (
    <section className="panel code-panel" aria-label="Code">
      <CodeEditor code={code} onCode={onCode} onRun={onRun} onBreakpoints={onBreakpoints} line={line} prevLine={prevLine} />
      {banner && <div id="banner" className={'banner' + (banner.error ? ' err' : '')} role="status">{banner.text}</div>}
    </section>
  );
}
