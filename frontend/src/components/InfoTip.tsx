import { useEffect, useRef, useState } from 'react';

/**
 * A small "?" affordance that keeps explanatory text out of the way.
 *
 * Hover (or keyboard focus) shows a short `tip`. Clicking opens a dialog with
 * the fuller `details` (falling back to `tip`), closeable by button, backdrop,
 * or Escape. The point is to let a settings screen stay terse while the long
 * rationale is one deliberate click away rather than dumped inline.
 *
 * The hover bubble is positioned with `fixed` off the button's rect, not as an
 * absolutely-positioned child. A settings card clips its rounded corners with
 * overflow-hidden and the pane scrolls, either of which would otherwise crop a
 * bubble that pops above the row; a viewport-fixed layer sits over both.
 *
 * Transitions and the dialog's entrance animation are dropped under
 * prefers-reduced-motion.
 */
const BUBBLE_WIDTH = 208; // w-52

export function InfoTip({
  tip,
  details,
  title,
}: {
  tip: string;
  details?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function showHover() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Centre over the button, then clamp so the bubble stays on screen.
    const half = BUBBLE_WIDTH / 2;
    const x = Math.min(Math.max(r.left + r.width / 2, 8 + half), window.innerWidth - 8 - half);
    setHover({ x, y: r.top });
  }

  return (
    <span className="inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        onPointerEnter={showHover}
        onPointerLeave={() => setHover(null)}
        onFocus={showHover}
        onBlur={() => setHover(null)}
        aria-label={title ? `More about ${title}` : 'More information'}
        className="inline-grid h-4 w-4 place-items-center rounded-full border border-border
                   text-[10px] font-semibold leading-none text-muted transition-colors
                   hover:border-primary hover:text-primary focus-visible:text-primary
                   motion-reduce:transition-none"
      >
        ?
      </button>

      {/* Hover / focus tooltip, fixed to the viewport and non-interactive. */}
      {hover && (
        <span
          role="tooltip"
          style={{ left: hover.x, top: hover.y - 8, width: BUBBLE_WIDTH }}
          className="pointer-events-none fixed z-60 -translate-x-1/2 -translate-y-full rounded-md
                     border border-border bg-surface-raised px-2 py-1.5 text-[11px] font-normal
                     normal-case leading-snug tracking-normal text-foreground shadow-lg
                     animate-fade-in motion-reduce:animate-none"
        >
          {tip}
        </span>
      )}

      {open && (
        <span
          className="fixed inset-0 z-70 flex items-center justify-center bg-black p-4 text-left
                     font-normal normal-case tracking-normal"
          onClick={() => setOpen(false)}
        >
          <span
            className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-surface p-4
                       animate-fade-in motion-reduce:animate-none"
            onClick={(e) => e.stopPropagation()}
          >
            {title && <span className="block text-sm font-medium text-foreground">{title}</span>}
            <span className="block text-xs leading-relaxed text-muted">{details ?? tip}</span>
            <button onClick={() => setOpen(false)} className="btn-ghost w-full text-xs">
              Got it
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
