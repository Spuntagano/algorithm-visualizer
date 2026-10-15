/** The whole page: wires the stepper hook to the panels. */
import { useEffect, useRef, useState } from 'react';
import { EXAMPLES, LUA_EXAMPLES, PY_EXAMPLES, TS_EXAMPLES } from '../examples.js';
import { LANG_NAMES } from '../editor.js';
import { useStepper } from '../hooks/useStepper.js';
import { CodePanel } from './CodePanel.jsx';
import { Header } from './Header.jsx';
import { SPLIT_DEFAULT, Splitter } from './Splitter.jsx';
import { StatePanel } from './StatePanel.jsx';
import { Transport } from './Transport.jsx';

const EXAMPLES_BY_LANG = { javascript: EXAMPLES, typescript: TS_EXAMPLES, lua: LUA_EXAMPLES, python: PY_EXAMPLES };

/** Status line under the code while stepping: only on the last step. */
function runBanner(trace, atLast, count) {
  if (!atLast) return null;
  if (trace.error) return { text: trace.error.msg + (trace.error.soft ? '' : ' (thrown after the last step shown)'), error: !trace.error.soft };
  return { text: 'Finished. The program ran ' + (count - 1) + ' statements.', error: false };
}

const LANG_KEY = 'algorithm-stepper.lang';
/** The language the viewer used last time (JavaScript unless they picked another). */
function readLang() {
  try { const v = localStorage.getItem(LANG_KEY); return v && EXAMPLES_BY_LANG[v] ? v : 'javascript'; } catch { return 'javascript'; }
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
  const [lang, setLangState] = useState(readLang);   // 'javascript' | 'typescript' | 'lua' | 'python'
  const examples = EXAMPLES_BY_LANG[lang];
  const [views, setViews] = useState({});          // per-variable choice: 'boxes' | 'graph' | 'memory' (absent: DEFAULT_VIEW)
  const [showPtrs, setShowPtrs] = useState(true);
  const [split, setSplitState] = useState(readSplit);  // the editor's share of the width, in percent
  const grid = useRef(null);
  const setSplit = v => { setSplitState(v); try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* storage blocked: not kept */ } };
  const [breakpoints, setBreakpoints] = useState([]);  // marked line numbers, kept by the editor as the code changes
  const s = useStepper('', breakpoints, lang);
  const stale = code !== s.tracedCode || lang !== s.tracedLang;   // edited (or switched language) since the last run

  const runNow = () => { s.run(code, lang); };
  const pickExample = name => { setExample(name); setCode(examples[name]); setViews({}); s.run(examples[name], lang); };
  /**
   * Another language: an example still as it was loaded is swapped for its twin (or cleared); anything the viewer
   * wrote or edited is kept and re-run, never replaced.
   */
  const setLang = next => {
    if (next === lang) return;
    setLangState(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* storage blocked: not kept */ }
    if (!example || code !== examples[example]) return;   // own or edited code: the re-run effect picks the new language up
    const twin = EXAMPLES_BY_LANG[next][example];
    setExample(twin != null ? example : ''); setViews({});
    setCode(twin != null ? twin : '');
    s.run(twin != null ? twin : '', next);
  };
  const setView = (name, mode) => setViews(v => {
    const next = { ...v };
    next[name] = mode;
    return next;
  });

  useEffect(() => {                                // an edit resets the run: stop playing, re-run once typing pauses
    if (!stale) return undefined;
    s.pause();
    if (s.isRunning(code, lang)) return undefined;   // already on its way (an example was just picked)
    const t = setTimeout(() => s.run(code, lang), RERUN_DELAY);
    return () => clearTimeout(t);
  }, [code, lang, stale]);                          // `s` is new every render; only the code and language matter here

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
  const banner = s.loading ? { text: 'Loading Python… the first run downloads it (about 12 MB), later runs are instant.', error: false }
    : s.notice && !stale ? { text: s.notice, error: true }
    : showing ? runBanner(s.trace, s.idx === s.last, s.count) : null;

  return (
    <>
      <Header examples={Object.keys(examples)} example={example} onExample={pickExample} lang={lang} langs={LANG_NAMES} onLang={setLang} />
      <main className="grid" ref={grid} style={{ '--split': String(split) }}>   {/* left: the editor; right: the debugger; the timeline runs along the bottom */}
        <CodePanel code={code} lang={lang} onCode={setCode} onRun={runNow} onBreakpoints={setBreakpoints}
          line={showing && s.step ? s.step.line : 0} prevLine={showing && s.prev ? s.prev.line : 0} banner={banner} />
        <Splitter value={split} onChange={setSplit} gridRef={grid} />
        <div className="debug">
          <StatePanel step={s.trace ? s.step : null} prev={s.prev} stepNo={s.idx} logs={s.trace ? s.trace.logs : []} stale={stale} runs={s.runs} lang={lang}
            vars={{ views, onView: setView, showPtrs }} />
        </div>
      </main>
      <Transport s={s} disabled={stale} showPtrs={showPtrs} onPtrs={setShowPtrs} />
    </>
  );
}
