/** The right panel: calls (stack or tree), variables and console output for the current step. */
import { Calls } from './CallTree.jsx';
import { GraphHelp } from './GraphHelp.jsx';
import { Variables } from './Variables.jsx';

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
 * `trace`: the whole run, for the call tree.
 */
export function StatePanel({ step, prev, stepNo, logs, stale, runs, vars, trace = null, lang = 'javascript' }) {
  return (
    <section className={'panel state-panel' + (stale ? ' stale' : '')} aria-label="Program state" aria-busy={stale || undefined} data-run={runs}>
      {!step
        ? <div id="placeholder" className="placeholder">Write or paste your code, or pick an example: it runs as you type.<br />Ctrl/Cmd + Enter plays it step by step.</div>
        : (
          <div id="stateBody">
            <div className="sect"><Calls trace={trace} step={step} stepNo={stepNo} /></div>
            <div className="sect"><div className="sect-head"><h2>Variables</h2><GraphHelp lang={lang} /></div><Variables step={step} prev={prev} stepNo={stepNo} steps={trace ? trace.steps : null} {...vars} /></div>
            <div className="sect"><h2>Output</h2><Output lines={logs.slice(0, step.logs)} print={lang === 'ruby' ? 'puts' : lang === 'c' ? 'printf' : lang === 'cpp' ? 'cout <<' : lang === 'java' ? 'System.out.println' : lang === 'go' ? 'fmt.Println' : lang === 'csharp' ? 'Console.WriteLine' : lang === 'kotlin' ? 'println' : lang === 'swift' ? 'print' : lang === 'php' ? 'echo' : lang === 'python' || lang === 'lua' ? 'print' : 'console.log'} /></div>
          </div>
        )}
    </section>
  );
}
