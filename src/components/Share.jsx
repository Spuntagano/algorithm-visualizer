/**
 * Share: a link that opens this code in this language (the code travels inside the link: src/share.js), and the
 * <iframe> that puts the same thing in another page. A native popover under its button, like the language info.
 */
import { useEffect, useRef, useState } from 'react';
import { usePopover } from '../hooks/usePopover.js';
import { shareLinks } from '../share.js';

/** Long links can be cut short by some chat apps and browsers. */
const LONG = 8000;

function CopyField({ id, label, value, multiline = false }) {
  const [copied, setCopied] = useState(false);
  const field = useRef(null);
  useEffect(() => setCopied(false), [value]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch { field.current.select(); document.execCommand('copy'); }   // no clipboard access (an http page): select it
    setCopied(true);
  };
  const Field = multiline ? 'textarea' : 'input';
  return (
    <div className="share-field">
      <label htmlFor={id}>{label}</label>
      <div className="share-row">
        <Field ref={field} id={id} readOnly value={value || 'Making the link…'} rows={multiline ? 4 : undefined} spellCheck={false}
          onFocus={e => e.target.select()} />
        <button type="button" className="btn small" id={id + 'Copy'} disabled={!value} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

/**
 * @param code  the editor's code; @param lang  its language (an id from LANG_NAMES)
 * @param step  the step shown, { no (from 1), count, line }, or null while there is none: the links can open at it
 */
export function Share({ code, lang, step = null }) {
  const btn = useRef(null), pop = useRef(null);
  usePopover(btn, pop, 520);
  const [open, setOpen] = useState(false);
  const [atStep, setAtStep] = useState(false);   // whether the links open at the step shown (kept between openings)
  const [links, setLinks] = useState(null);
  const canStep = !!step && step.no > 1;
  const want = atStep && canStep ? step.no : null;
  useEffect(() => {
    const p = pop.current;
    const onToggle = e => setOpen(e.newState === 'open');
    p.addEventListener('beforetoggle', onToggle);
    return () => p.removeEventListener('beforetoggle', onToggle);
  }, []);
  useEffect(() => {                              // made while the popover is open, for the code (and step) as they are
    if (!open) return undefined;
    let live = true;
    setLinks(null);
    shareLinks(code, lang, undefined, { step: want }).then(l => { if (live) setLinks(l); });
    return () => { live = false; };
  }, [open, code, lang, want]);
  const empty = !code.trim();
  return (
    <>
      <button ref={btn} type="button" className="btn share-btn" id="shareBtn" popoverTarget="share" disabled={empty}
        title={empty ? 'Write some code first, then share it' : 'Share a link to this code, or embed it in a page'}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" /></svg>
        Share
      </button>
      <div ref={pop} id="share" className="help-pop share-pop" popover="auto" role="dialog" aria-labelledby="shareTitle">
        <h3 id="shareTitle">Share this code</h3>
        <p>The code is inside the link itself: nothing is uploaded, and the link works for as long as the site does.</p>
        <label className="share-step" title={canStep ? 'The link and the embed open at this step instead of the first' : 'Step forward first: a link opens at step 1 anyway'}>
          <span className="share-step-text">
            <span className="share-step-main">{canStep ? `Open at step ${step.no}` : 'Open at the current step'}</span>
            <span className="share-step-sub">{canStep ? `of ${step.count}${step.line > 0 ? ` · line ${step.line}` : ''}` : 'Step forward first'}</span>
          </span>
          <input type="checkbox" role="switch" id="shareAtStep" checked={atStep && canStep} disabled={!canStep} onChange={e => setAtStep(e.target.checked)} />
        </label>
        <CopyField id="shareLink" label="Link" value={links && links.link} />
        <CopyField id="shareEmbed" label="Embed in a page (blog, course, docs)" value={links && links.iframe} multiline />
        {links && links.link.length > LONG && <p className="share-warn">This code makes a long link ({links.link.length.toLocaleString()} characters); some apps cut links that long.</p>}
        {links && (
          <p className="help-foot">
            <a className="share-preview" id="sharePreview" href={links.embedSrc} target="_blank" rel="noopener noreferrer" title="Open the embedded version in a new tab">
              Preview the embed
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3L7.5 8.5" /></svg>
            </a>
          </p>
        )}
      </div>
    </>
  );
}
