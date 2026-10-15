/** The right panel: call stack, variables and console output for the current step. */
import { LANG_NAMES } from '../editor.js';
import { GraphHelp } from './GraphHelp.jsx';
import { Variables } from './Variables.jsx';

function CallStack({ stack }) {
  return (
    <div id="stack" className="frames">
      {stack.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => (
        <div key={i} className={'frame' + (i === stack.length - 1 ? ' top' : '')}>{f.name}(<span className="args">{f.args}</span>)</div>
      ))}
      <div className="frame base">top level{stack.length ? '' : ' (not inside a function)'}</div>
    </div>
  );
}

function Output({ lines, print }) {
  return (
    <pre id="out">
      {lines.length
        ? lines.map((l, i) => <span key={i} className={'l ' + l.type}>{l.s}</span>)
        : <span className="empty">Nothing printed yet. {print}(...) output appears here.</span>}
    </pre>
  );
}

/** `vars` carries how variables are shown: `views`, `onView` and `showPtrs` (see Variables.jsx). */
/**
 * `stale`: the code was edited and is being run again, so this state is about to be replaced.
 * `runs`: how many runs have finished (exposed as data-run).
 */
export function StatePanel({ step, prev, stepNo, logs, stale, runs, vars, lang = 'javascript' }) {
  return (
    <section className={'panel state-panel' + (stale ? ' stale' : '')} aria-label="Program state" aria-busy={stale || undefined} data-run={runs}>
      {!step
        ? <div id="placeholder" className="placeholder">Write or paste some {LANG_NAMES[lang] || 'JavaScript'}, or pick an example: it runs as you type.<br />Ctrl/Cmd + Enter runs it right away.</div>
        : (
          <div id="stateBody">
            <div className="sect"><h2>Call stack</h2><CallStack stack={step.stack} /></div>
            <div className="sect"><div className="sect-head"><h2>Variables</h2><GraphHelp lang={lang} /></div><Variables step={step} prev={prev} stepNo={stepNo} {...vars} /></div>
            <div className="sect"><h2>Output</h2><Output lines={logs.slice(0, step.logs)} print={lang === 'ruby' ? 'puts' : lang === 'c' ? 'printf' : lang === 'python' || lang === 'lua' ? 'print' : 'console.log'} /></div>
          </div>
        )}
    </section>
  );
}
