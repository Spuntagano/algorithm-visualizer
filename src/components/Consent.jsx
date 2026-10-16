/**
 * Asking before counting visits. index.html's window.analytics loads the Google tag only on the published site and only
 * once the visitor says yes; this is where they say it. The answer ('yes' or 'no') is kept in the browser, and About
 * can change it later. Until there is one, a bar above the timeline asks; Decline and Accept weigh the same.
 */
import { useState } from 'react';

const KEY = 'algorithm-visualizer.analytics';

/** Whether this page can count visits at all (the published site), from index.html's window.analytics */
export const analyticsAvailable = () => typeof window !== 'undefined' && !!(window.analytics && window.analytics.enabled);

/** The visitor's answer and a way to change it: [choice: 'yes' | 'no' | null, setChoice] */
export function useAnalyticsChoice() {
  const [choice, setState] = useState(() => { try { return localStorage.getItem(KEY); } catch { return null; } });
  const setChoice = v => {
    try { localStorage.setItem(KEY, v); } catch { /* blocked storage: the answer holds until the page is closed */ }
    if (typeof window !== 'undefined' && window.analytics) { if (v === 'yes') window.analytics.load(); else window.analytics.stop(); }
    setState(v);
  };
  return [choice === 'yes' || choice === 'no' ? choice : null, setChoice];
}

/** The bar that asks. @param onChoice  called with 'yes' or 'no' */
export function ConsentBanner({ onChoice }) {
  return (
    <section className="consent" id="consent" role="region" aria-label="Analytics consent">
      <p>
        Can this site count your visit with Google Analytics? It helps show which languages and examples people use.
        It sets cookies, and it never sees your code. Nothing is sent unless you accept.
      </p>
      <div className="consent-actions">
        <button type="button" className="btn" id="consentNo" onClick={() => onChoice('no')}>Decline</button>
        <button type="button" className="btn" id="consentYes" onClick={() => onChoice('yes')}>Accept</button>
      </div>
    </section>
  );
}
