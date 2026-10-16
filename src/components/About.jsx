/**
 * The i at the right end of the timeline: what this app is, what it shows, and the keys that drive it. A native popover
 * like the language info (LangInfo.jsx), opening above its button.
 */
import { useRef } from 'react';
import { usePopover } from '../hooks/usePopover.js';
import { LANG_NAMES, MOD } from '../editor.js';

const K = ({ children }) => <kbd>{children}</kbd>;

export function About() {
  const btn = useRef(null), pop = useRef(null);
  usePopover(btn, pop, 480);
  const langs = Object.values(LANG_NAMES);
  return (
    <>
      <button ref={btn} type="button" className="help-btn" id="aboutBtn" popoverTarget="about" title="About this app" aria-label="About this app">i</button>
      <div ref={pop} id="about" className="help-pop" popover="auto" role="dialog" aria-labelledby="aboutTitle">
        <h3 id="aboutTitle">About Algorithm visualizer</h3>
        <p>
          Write or paste code, or pick an example, and step through it one statement at a time: forwards, backwards, or
          straight to a breakpoint. The whole run is recorded first, so going back is as quick as going forward.
        </p>
        <p>
          It runs {langs.slice(0, -1).join(', ')} and {langs.at(-1)}, all in your browser. Your code is never sent
          anywhere, and the page works offline; Python, Ruby and PHP download their runtime once, the first time you use them.
        </p>
        <h4>What you see</h4>
        <ul className="help-notes">
          <li><b>Call stack</b> or <b>call tree</b>: the calls running now, or every call so far with what it returned</li>
          <li><b>Variables</b>, each shown as <b>Memory</b>, <b>Boxes</b>, <b>Grid</b> (a table) or <b>Graph</b> (nodes and edges); what changed in the last step is highlighted</li>
          <li><b>Output</b>: what the program printed so far</li>
        </ul>
        <h4>Keys</h4>
        <dl className="help-keys">
          <div><dt><K>Space</K> or <K>{MOD}</K>+<K>Enter</K></dt><dd>Play / pause</dd></div>
          <div><dt><K>←</K> <K>→</K></dt><dd>Back / forward one step</dd></div>
          <div><dt><K>Home</K> <K>End</K></dt><dd>First / last step</dd></div>
          <div><dt><K>F9</K> or a line number</dt><dd>Add or remove a breakpoint</dd></div>
          <div><dt><K>F8</K> <K>Shift</K>+<K>F8</K></dt><dd>Next / previous breakpoint</dd></div>
          <div><dt><K>{MOD}</K>+<K>Z</K> <K>{MOD}</K>+<K>Shift</K>+<K>Z</K></dt><dd>Undo / redo in the editor</dd></div>
        </dl>
        <p className="help-foot">The ? next to Variables explains when data becomes a graph; the i next to Language says what each language includes.</p>
      </div>
    </>
  );
}
