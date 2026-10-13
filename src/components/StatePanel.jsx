/** The right panel: call stack, variables and console output for the current step. */
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

function Output({ lines }) {
  return (
    <pre id="out">
      {lines.length
        ? lines.map((l, i) => <span key={i} className={'l ' + l.type}>{l.s}</span>)
        : <span className="empty">Nothing printed yet. console.log(...) output appears here.</span>}
    </pre>
  );
}

/** `vars` carries how variables are shown: `views`, `onView` and `showPtrs` (see Variables.jsx). */
export function StatePanel({ run, step, prev, stepNo, logs, vars }) {
  return (
    <section className="panel state-panel" aria-label="Program state">
      {!run
        ? <div id="placeholder" className="placeholder">Write or paste some JavaScript, then press Visualize.<br />Tip: Ctrl/Cmd + Enter also runs it.</div>
        : (
          <div id="stateBody">
            <div className="sect"><h2>Call stack</h2><CallStack stack={step.stack} /></div>
            <div className="sect"><h2>Variables</h2><Variables step={step} prev={prev} stepNo={stepNo} {...vars} /></div>
            <div className="sect"><h2>Output</h2><Output lines={logs.slice(0, step.logs)} /></div>
          </div>
        )}
    </section>
  );
}
