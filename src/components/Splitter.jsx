/**
 * The divider between the editor and the debugger: drag it, or focus it and use the arrow keys, to share the width.
 * While dragging it only updates the grid's --split variable (no React render per move); the value is committed on release.
 */
import { useRef } from 'react';

export const SPLIT_MIN = 20, SPLIT_MAX = 80, SPLIT_DEFAULT = 50;
const clamp = v => Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 10) / 10;

/**
 * @param value     the editor's share of the width, in percent
 * @param onChange  called with the new percentage when a drag ends or a key moves it
 * @param gridRef   the grid element whose --split variable sets the columns
 */
export function Splitter({ value, onChange, gridRef }) {
  const drag = useRef(null);

  const pctAt = clientX => {
    const r = gridRef.current.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * 100);
  };
  const onPointerDown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = value;
    document.body.classList.add('resizing');
  };
  const onPointerMove = e => {
    if (drag.current == null) return;
    drag.current = pctAt(e.clientX);
    gridRef.current.style.setProperty('--split', String(drag.current));
  };
  const onPointerUp = () => {
    if (drag.current == null) return;
    const v = drag.current;
    drag.current = null;
    document.body.classList.remove('resizing');
    onChange(v);
  };
  const onKeyDown = e => {
    const step = e.shiftKey ? 10 : 2;
    const next = { ArrowLeft: value - step, ArrowRight: value + step, Home: SPLIT_MIN, End: SPLIT_MAX, Enter: SPLIT_DEFAULT }[e.key];
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();                             // arrow keys here resize; they must not also step the debugger
    onChange(clamp(next));
  };

  return (
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the editor and the debugger"
      aria-valuemin={SPLIT_MIN} aria-valuemax={SPLIT_MAX} aria-valuenow={Math.round(value)} tabIndex={0}
      title="Drag to resize, or focus it and use the Left / Right arrows (Shift for bigger steps); double-click or Enter resets"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(SPLIT_DEFAULT)} onKeyDown={onKeyDown} />
  );
}
