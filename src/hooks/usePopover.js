/**
 * Places a native popover (popover="auto") under its button, in page coordinates (position: absolute in the top layer),
 * so it scrolls along with the button; closing it on scroll instead would also close it right after it opens when a tap
 * follows a scroll, or when a phone's address bar moves. It is right-aligned with the button when it fits, never wider
 * than `maxWidth` or the window less a 16px gutter, and as tall as the room below the button (longer text scrolls inside).
 */
import { useEffect } from 'react';

export function usePopover(btn, pop, maxWidth = 520) {
  useEffect(() => {
    const p = pop.current;
    const place = () => {
      const r = btn.current.getBoundingClientRect(), w = Math.min(maxWidth, window.innerWidth - 32);
      Object.assign(p.style, {
        width: w + 'px',
        left: window.scrollX + Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)) + 'px',
        top: window.scrollY + r.bottom + 6 + 'px',
        maxHeight: Math.max(160, window.innerHeight - r.bottom - 22) + 'px',
      });
    };
    const onToggle = e => { if (e.newState === 'open') place(); };
    // follow the button when the window is resized or the panel it sits in scrolls (never when the popover itself scrolls)
    const follow = e => { if (p.matches(':popover-open') && !(e.target instanceof Node && p.contains(e.target))) place(); };
    p.addEventListener('beforetoggle', onToggle);
    window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true);
    return () => { p.removeEventListener('beforetoggle', onToggle); window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, [btn, pop, maxWidth]);
}
