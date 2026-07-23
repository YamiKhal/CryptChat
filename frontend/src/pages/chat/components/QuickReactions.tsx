import { useEffect, useRef } from "react";
import { QUICK_REACTIONS } from "@/lib/limits";

/** Anchored strip of the eight most-used reactions. */
export function QuickReactions({
    x,
    y,
    onPick,
    onClose,
}: {
    x: number;
    y: number;
    onPick: (emoji: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDown = (e: Event) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    // Clamp inside the viewport: opened near an edge this would otherwise render
    // with half its emoji unreachable.
    const width = 268;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - 56));

    return (
        <div
            ref={ref}
            className="border-border bg-surface-raised animate-fade-in fixed z-50 flex gap-0.5 rounded-full border px-1.5 py-1"
            style={{ left, top }}
        >
            {QUICK_REACTIONS.map((emoji) => (
                <button
                    key={emoji}
                    onClick={() => onPick(emoji)}
                    className="t-h2 rounded-full p-1 leading-none transition-transform hover:scale-125"
                    aria-label={`React with ${emoji}`}
                >
                    {emoji}
                </button>
            ))}
        </div>
    );
}
