/** The whole page: wires the stepper hook to the panels. */
import { useEffect, useRef, useState } from 'react';
import { EXAMPLES } from '../examples.js';
import { useStepper } from '../hooks/useStepper.js';
import { CodePanel } from './CodePanel.jsx';
import { Header } from './Header.jsx';
import { SPLIT_DEFAULT, Splitter } from './Splitter.jsx';
import { StatePanel } from './StatePanel.jsx';
import { Transport } from './Transport.jsx';

const NAMES = Object.keys(EXAMPLES);

/** Status line under the code while stepping: only on the last step. */
function runBanner(trace, atLast, count) {
  if (!atLast) return null;
  if (trace.error) return { text: trace.error.msg + (trace.error.soft ? '' : ' (thrown after the last step shown)'), error: !trace.error.soft };
  return { text: 'Finished. The program ran ' + (count - 1) + ' statements.', error: false };
}

const SPLIT_KEY = 'algorithm-stepper.split';
/** The divider position the viewer chose last time, or the default (storage can be missing or blocked). */
function readSplit() {
  try { const v = parseFloat(localStorage.getItem(SPLIT_KEY)); return Number.isFinite(v) ? v : SPLIT_DEFAULT; } catch { return SPLIT_DEFAULT; }
}

/** How long typing has to pause before the edited code is run again. */
export const RERUN_DELAY = 350;

export function App() {
  const [example, setExample] = useState('');       // '' until an example is picked: the page starts with an empty editor
  const [code, setCode] = useState('');
  const [views, setViews] = useState({});          // per-variable choice: 'boxes' | 'graph' | 'memory' (absent: DEFAULT_VIEW)
  const [showPtrs, setShowPtrs] = useState(true);
  const [split, setSplitState] = useState(readSplit);  // the editor's share of the width, in percent
  const grid = useRef(null);
  const setSplit = v => { setSplitState(v); try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* storage blocked: not kept */ } };
  const [breakpoints, setBreakpoints] = useState([]);  // marked line numbers, kept by the editor as the code changes
  const s = useStepper(code, breakpoints);
  const stale = code !== s.tracedCode;               // edited since the last run: its trace no longer matches the code

  const runNow = () => { s.run(code); };
  const pickExample = name => { setExample(name); setCode(EXAMPLES[name]); setViews({}); s.run(EXAMPLES[name]); };
  const setView = (name, mode) => setViews(v => {
    const next = { ...v };
    next[name] = mode;
    return next;
  });

  useEffect(() => {                                // an edit resets the run: stop playing, re-run once typing pauses
    if (!stale) return undefined;
    s.pause();
    const t = setTimeout(() => s.run(code), RERUN_DELAY);
    return () => clearTimeout(t);
  }, [code, stale]);                                // `s` is new every render; only the code matters here

  useEffect(() => {                                // keyboard: ← → Home End Space (unless typing or on a control), F8 / Shift+F8
    const onKey = e => {
      if (!s.trace || stale) return;
      if (e.key === 'F8') { e.preventDefault(); if (e.shiftKey) s.prevBreak(); else s.nextBreak(); return; }   // also from the editor
      const t = e.target;
      if (['TEXTAREA', 'SELECT', 'INPUT', 'BUTTON'].includes(t.tagName) || t.isContentEditable || (t.closest && t.closest('.cm-editor, [role=separator]'))) return;
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

  const showing = !!s.trace && !stale;
  const banner = s.notice && !stale ? { text: s.notice, error: true }
    : showing ? runBanner(s.trace, s.idx === s.last, s.count) : null;

  return (
    <>
      <Header examples={NAMES} example={example} onExample={pickExample} />
      <main className="grid" ref={grid} style={{ '--split': String(split) }}>   {/* left: the editor; right: the debugger; the timeline runs along the bottom */}
        <CodePanel code={code} onCode={setCode} onRun={runNow} onBreakpoints={setBreakpoints}
          line={showing && s.step ? s.step.line : 0} prevLine={showing && s.prev ? s.prev.line : 0} banner={banner} />
        <Splitter value={split} onChange={setSplit} gridRef={grid} />
        <div className="debug">
          <StatePanel step={s.trace ? s.step : null} prev={s.prev} stepNo={s.idx} logs={s.trace ? s.trace.logs : []} stale={stale} runs={s.runs}
            vars={{ views, onView: setView, showPtrs }} />
        </div>
      </main>
      <Transport s={s} disabled={stale} showPtrs={showPtrs} onPtrs={setShowPtrs} />
    </>
  );
}
