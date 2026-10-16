/** The bottom bar (the timeline): first / back / play / forward / last, previous / next breakpoint, step over / out,
    scrubber with a tick wherever a breakpoint is hit, speed, pointer tags, and the About button. */
import { MOD } from '../editor.js';
import { About } from './About.jsx';
const Icon = ({ children }) => <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>;

const NO_BPS = 'Click a line number, or press F9 on a line in the editor, to add a breakpoint';

/**
 * Always shown. With no trace (empty editor, syntax error, stopped run) the stepping controls are disabled;
 * speed and pointer tags are settings and stay usable.
 * @param s         the object returned by useStepper()
 * @param disabled  the code was edited and is being run again: stepping waits for the new trace
 * @param analytics  About's analytics setting (its choice and a setter), or null where visits are not counted
 */
export function Transport({ s, disabled: busy, showPtrs, onPtrs, analytics = null }) {
  const none = !s.trace || !s.step, disabled = busy || none;
  const atFirst = disabled || s.idx === 0, atLast = disabled || s.idx === s.last;
  const noBps = !s.breakpoints || !s.breakpoints.size;
  // ticks on the timeline where a breakpoint is hit; nearby hits share one tick so a long loop stays readable
  const ticks = disabled || !s.last ? [] : [...new Set((s.hits || []).map(i => Math.round((i / s.last) * 400) / 4))];
  return (
    <footer className="transport" id="transport">
      <div className="tc">
        <button className="ib" id="bFirst" title="First step (Home)" aria-label="First step" disabled={atFirst} onClick={() => s.go(0)}>
          <Icon><rect x="3" y="3" width="2" height="10" /><path d="M13 3v10L6 8z" /></Icon></button>
        <button className="ib" id="bPrev" title="Back one step (Left arrow)" aria-label="Back one step" disabled={atFirst} onClick={() => s.go(s.idx - 1)}>
          <Icon><path d="M12 3v10L5 8z" /></Icon></button>
        <button className="ib play" id="bPlay" title={`Play / pause (Space, or ${MOD}+Enter in the editor)`} aria-label={s.playing ? 'Pause' : 'Play'} disabled={disabled} onClick={s.togglePlay}>
          {s.playing
            ? <Icon><rect x="4" y="3" width="3" height="10" /><rect x="9" y="3" width="3" height="10" /></Icon>
            : <Icon><path d="M5 3v10l8-5z" /></Icon>}
        </button>
        <button className="ib" id="bNext" title="Forward one step (Right arrow)" aria-label="Forward one step" disabled={atLast} onClick={() => s.go(s.idx + 1)}>
          <Icon><path d="M4 3v10l7-5z" /></Icon></button>
        <button className="ib" id="bLast" title="Last step (End)" aria-label="Last step" disabled={atLast} onClick={() => s.go(s.last)}>
          <Icon><path d="M3 3v10l7-5z" /><rect x="11" y="3" width="2" height="10" /></Icon></button>
      </div>
      <div className="tc">
        <button className="ib bp" id="bBpPrev" aria-label="Back to the previous breakpoint" disabled={noBps || atFirst} onClick={s.prevBreak}
          title={noBps ? NO_BPS : 'Back to the previous breakpoint (Shift+F8)'}>
          <Icon><circle cx="4.5" cy="8" r="2.5" className="dot" /><path d="M14 3v10L8 8z" /></Icon></button>
        <button className="ib bp" id="bBpNext" aria-label="Continue to the next breakpoint" disabled={noBps || atLast} onClick={s.nextBreak}
          title={noBps ? NO_BPS : 'Continue to the next breakpoint (F8)'}>
          <Icon><path d="M2 3v10l6-5z" /><circle cx="11.5" cy="8" r="2.5" className="dot" /></Icon></button>
      </div>
      <div className="tc">
        <button className="btn small" id="bOver" title="Run until the current function reaches its next statement" disabled={atLast} onClick={s.stepOver}>Step over</button>
        <button className="btn small" id="bOut" title="Run until the current function returns" disabled={atLast} onClick={s.stepOut}>Step out</button>
      </div>
      <div className="scrub">
        <div className="scrub-track">
          <input type="range" id="scrub" min={0} max={s.last} value={s.idx} aria-label="Step position" disabled={disabled} onChange={e => s.go(+e.target.value)} />
          {ticks.map(p => <span key={p} className="bp-tick" aria-hidden="true" style={{ left: `calc(8px + (100% - 16px) * ${p / 100})` }} />)}
        </div>
        <span id="stepLabel">{none ? 'No steps yet' : `Step ${s.idx + 1} of ${s.count}${s.step.line > 0 ? ` · line ${s.step.line}` : ' · done'}`}</span>
      </div>
      <div className="opts">
        <label>Speed
          <select id="speed" aria-label="Playback speed" value={s.speed} onChange={e => s.setSpeed(+e.target.value)}>
            <option value={1000}>Slow</option><option value={500}>Normal</option><option value={180}>Fast</option><option value={50}>Very fast</option>
          </select>
        </label>
        <label><input type="checkbox" id="ptrToggle" checked={showPtrs} onChange={e => onPtrs(e.target.checked)} /> Pointer tags</label>
      </div>
      <div className="about-slot"><About analytics={analytics} /></div>
    </footer>
  );
}
