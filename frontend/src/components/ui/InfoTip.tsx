import { useEffect, useRef, useState } from "react";

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
        const onKey = (e: KeyboardEvent) =>
            e.key === "Escape" && setOpen(false);
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open]);

    function showHover() {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        // Centre over the button, then clamp so the bubble stays on screen.
        const half = BUBBLE_WIDTH / 2;
        const x = Math.min(
            Math.max(r.left + r.width / 2, 8 + half),
            window.innerWidth - 8 - half,
        );
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
                aria-label={title ? `More about ${title}` : "More information"}
                className="border-border t-small text-muted hover:border-primary hover:text-primary focus-visible:text-primary inline-grid h-4 w-4 place-items-center rounded-full border leading-none font-semibold transition-colors motion-reduce:transition-none"
            >
                ?
            </button>

            {/* Hover / focus tooltip, fixed to the viewport and non-interactive. */}
            {hover && (
                <span
                    role="tooltip"
                    style={{
                        left: hover.x,
                        top: hover.y - 8,
                        width: BUBBLE_WIDTH,
                    }}
                    className="border-border bg-surface-raised t-small text-foreground animate-fade-in pointer-events-none fixed z-60 -translate-x-1/2 -translate-y-full rounded-md border px-2 py-1.5 leading-snug font-normal tracking-normal normal-case shadow-lg motion-reduce:animate-none"
                >
                    {tip}
                </span>
            )}

            {open && (
                <span
                    className="fixed inset-0 z-70 flex items-center justify-center bg-black/80 p-4 text-left font-normal tracking-normal normal-case"
                    onClick={() => setOpen(false)}
                >
                    <span
                        className="border-border bg-surface animate-fade-in w-full max-w-xs space-y-3 rounded-lg border p-4 motion-reduce:animate-none"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {title && (
                            <span className="t-h4 text-foreground block font-medium">
                                {title}
                            </span>
                        )}
                        <span className="t-base text-muted block leading-relaxed">
                            {details ?? tip}
                        </span>
                        <button
                            onClick={() => setOpen(false)}
                            className="btn-ghost t-base w-full"
                        >
                            Got it
                        </button>
                    </span>
                </span>
            )}
        </span>
    );
}
