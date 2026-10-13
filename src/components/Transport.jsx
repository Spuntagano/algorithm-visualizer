/** The bottom bar: first / back / play / forward / last, step over / out, scrubber, speed, pointer tags. */
const Icon = ({ children }) => <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>;

/** @param s  the object returned by useStepper() */
export function Transport({ s, showPtrs, onPtrs }) {
  const atFirst = s.idx === 0, atLast = s.idx === s.last;
  return (
    <footer className="transport" id="transport">
      <div className="tc">
        <button className="ib" id="bFirst" title="First step (Home)" aria-label="First step" disabled={atFirst} onClick={() => s.go(0)}>
          <Icon><rect x="3" y="3" width="2" height="10" /><path d="M13 3v10L6 8z" /></Icon></button>
        <button className="ib" id="bPrev" title="Back one step (Left arrow)" aria-label="Back one step" disabled={atFirst} onClick={() => s.go(s.idx - 1)}>
          <Icon><path d="M12 3v10L5 8z" /></Icon></button>
        <button className="ib play" id="bPlay" title="Play / pause (Space)" aria-label={s.playing ? 'Pause' : 'Play'} onClick={s.togglePlay}>
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
        <button className="btn small" id="bOver" title="Run until the current function reaches its next statement" disabled={atLast} onClick={s.stepOver}>Step over</button>
        <button className="btn small" id="bOut" title="Run until the current function returns" disabled={atLast} onClick={s.stepOut}>Step out</button>
      </div>
      <div className="scrub">
        <input type="range" id="scrub" min={0} max={s.last} value={s.idx} aria-label="Step position" onChange={e => s.go(+e.target.value)} />
        <span id="stepLabel">Step {s.idx + 1} of {s.count}{s.step.line > 0 ? ` · line ${s.step.line}` : ' · done'}</span>
      </div>
      <div className="opts">
        <label>Speed
          <select id="speed" aria-label="Playback speed" value={s.speed} onChange={e => s.setSpeed(+e.target.value)}>
            <option value={1000}>Slow</option><option value={500}>Normal</option><option value={180}>Fast</option><option value={50}>Very fast</option>
          </select>
        </label>
        <label><input type="checkbox" id="ptrToggle" checked={showPtrs} onChange={e => onPtrs(e.target.checked)} /> Pointer tags</label>
      </div>
    </footer>
  );
}
