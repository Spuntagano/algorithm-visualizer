/** The whole page: wires the stepper hook to the panels. */
import { useEffect, useState } from 'react';
import { EXAMPLES } from '../examples.js';
import { useStepper } from '../hooks/useStepper.js';
import { CodePanel } from './CodePanel.jsx';
import { Header } from './Header.jsx';
import { StatePanel } from './StatePanel.jsx';
import { Transport } from './Transport.jsx';

const NAMES = Object.keys(EXAMPLES);

/** Status line under the code while stepping: only on the last step. */
function runBanner(trace, atLast, count) {
  if (!atLast) return null;
  if (trace.error) return { text: trace.error.msg + (trace.error.soft ? '' : ' (thrown after the last step shown)'), error: !trace.error.soft };
  return { text: 'Finished. The program ran ' + (count - 1) + ' statements.', error: false };
}

export function App() {
  const [example, setExample] = useState(NAMES[0]);
  const [code, setCode] = useState(EXAMPLES[NAMES[0]]);
  const [views, setViews] = useState({});          // per-variable: 'graph' | 'raw'
  const [showPtrs, setShowPtrs] = useState(true);
  const s = useStepper(code);
  const editing = s.mode === 'edit';

  const run = c => { s.run(c).then(ok => { if (ok) setViews({}); }); };
  const pickExample = name => { setExample(name); setCode(EXAMPLES[name]); run(EXAMPLES[name]); };
  const setView = (name, mode) => setViews(v => {
    const next = { ...v };
    if (mode === 'boxes') delete next[name]; else next[name] = mode;
    return next;
  });

  useEffect(() => {                                // keyboard: ← → Home End Space, only while stepping
    const onKey = e => {
      if (editing || !s.trace) return;
      if (['TEXTAREA', 'SELECT', 'INPUT', 'BUTTON'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowRight') s.go(s.idx + 1);
      else if (e.key === 'ArrowLeft') s.go(s.idx - 1);
      else if (e.key === 'Home') s.go(0);
      else if (e.key === 'End') s.go(s.last);
      else if (e.key === ' ') s.togglePlay();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const banner = editing
    ? (s.notice ? { text: s.notice, error: true } : null)
    : runBanner(s.trace, s.idx === s.last, s.count);

  return (
    <>
      <Header examples={NAMES} example={example} onExample={pickExample} editing={editing} busy={s.running} onRun={() => run(code)} onEdit={s.edit} />
      <main className="grid">
        <CodePanel editing={editing} code={code} onCode={setCode} onRun={() => run(code)}
          line={s.step ? s.step.line : 0} prevLine={s.prev ? s.prev.line : 0} banner={banner} />
        <StatePanel run={!editing} step={s.step} prev={s.prev} stepNo={s.idx} logs={s.trace ? s.trace.logs : []}
          vars={{ views, onView: setView, showPtrs }} />
      </main>
      {!editing && <Transport s={s} showPtrs={showPtrs} onPtrs={setShowPtrs} />}
    </>
  );
}
