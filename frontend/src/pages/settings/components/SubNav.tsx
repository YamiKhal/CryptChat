import { useEffect, useState } from "react";

/**
 * Quick-jump list of the sections within the open tab. Expands downward when the
 * tab opens and collapses when another is chosen; the shell hides it entirely
 * for tabs with a single section.
 */
export function SubNav({
    items,
    onJump,
}: {
    items: { id: string; title: string }[];
    onJump: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setOpen(true));
        return () => cancelAnimationFrame(frame);
    }, []);
    return (
        <div
            className={`grid transition-all duration-200 ease-out motion-reduce:transition-none ${
                open
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0"
            }`}
        >
            <div className="overflow-hidden">
                <div className="border-border mt-1 ml-5 space-y-0.5 border-l pl-2">
                    {items.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => onJump(item.id)}
                            className="t-base text-muted hover:bg-surface-raised hover:text-foreground block w-full cursor-pointer truncate rounded px-2 py-1 text-left transition-colors"
                        >
                            {item.title}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
