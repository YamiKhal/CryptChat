import { useEffect, useState } from "react";
import { Flame, KeyRound, Lock, ShieldCheck, Terminal } from "lucide-react";

/**
 * The marketing pages' "product shots": small hand-built UI mockups instead of
 * screenshots, so they stay sharp at any size, follow the live theme, and cost
 * no assets. Solid token fills only.
 */

/* ------------------------------------------------------------------------- *
 * Terminal card — the hero visual. Types its script line by line on a loop,
 * with a blinking caret. Under prefers-reduced-motion it renders fully typed.
 * ------------------------------------------------------------------------- */

const SCRIPT = [
    "$ cryptchat unlock",
    "> vault opened · keys never left this device",
    "> channel #quiet-room joined",
    "→ message encrypted · sent",
    "✓ burn-on-read armed",
];

function useTypedLines(lines: string[]) {
    // {line, chars}: lines before `line` are fully typed, `line` is typed up to
    // `chars`, later lines are hidden. line === lines.length means all done.
    const [pos, setPos] = useState({ line: 0, chars: 0 });

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setPos({ line: lines.length, chars: 0 });
            return;
        }
        let line = 0;
        let chars = 0;
        let t: number;
        const tick = () => {
            const cur = lines[line];
            if (cur === undefined) {
                // Full script shown; hold, then wipe and start over.
                t = window.setTimeout(() => {
                    line = 0;
                    chars = 0;
                    setPos({ line: 0, chars: 0 });
                    t = window.setTimeout(tick, 500);
                }, 3400);
                return;
            }
            if (chars < cur.length) {
                chars += 1;
                setPos({ line, chars });
                t = window.setTimeout(tick, 26);
            } else {
                line += 1;
                chars = 0;
                setPos({ line, chars: 0 });
                t = window.setTimeout(tick, 380);
            }
        };
        t = window.setTimeout(tick, 500);
        return () => clearTimeout(t);
    }, [lines]);

    return pos;
}

export function TerminalCard() {
    const pos = useTypedLines(SCRIPT);
    return (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-xl">
            <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-3 text-muted">
                <span className="size-2.5 rounded-full bg-error" />
                <span className="size-2.5 rounded-full bg-warn" />
                <span className="size-2.5 rounded-full bg-ok" />
                <Terminal size={14} className="ml-2" aria-hidden="true" />
                <span className="t-small font-medium">cryptchat — session</span>
            </div>
            {/* Fixed min-height so the loop never shifts layout. */}
            <div className="min-h-44 space-y-2.5 p-5 font-mono">
                {SCRIPT.map((text, i) => {
                    if (i > pos.line) return null;
                    const shown = i === pos.line ? text.slice(0, pos.chars) : text;
                    const accent = text.startsWith("$") || text.startsWith("→");
                    return (
                        <div key={i} className="t-base">
                            <span className={accent ? "text-primary" : "text-muted"}>
                                {shown}
                            </span>
                            {i === pos.line && (
                                <span className="mk-caret text-primary">▍</span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------------- *
 * Chat mockup — three bubbles, one locked. Reads like the real transcript.
 * ------------------------------------------------------------------------- */

function Bubble({
    self,
    children,
}: {
    self?: boolean;
    children: React.ReactNode;
}) {
    return (
        <div className={`flex ${self ? "justify-end" : "justify-start"}`}>
            <div
                className={`max-w-[80%] rounded-2xl border px-3.5 py-2 t-base ${
                    self
                        ? "rounded-br-sm border-primary-line bg-primary-soft text-foreground"
                        : "rounded-bl-sm border-border bg-surface-raised text-foreground"
                }`}
            >
                {children}
            </div>
        </div>
    );
}

export function ChatMockup() {
    return (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-2 border-b border-border pb-3">
                <span className="grid size-7 place-items-center rounded-full bg-primary-soft text-primary">
                    <ShieldCheck size={14} aria-hidden="true" />
                </span>
                <span className="t-base font-semibold text-foreground">
                    #quiet-room
                </span>
                <span className="tag ml-auto border border-ok-line bg-ok-soft text-ok">
                    e2e
                </span>
            </div>
            <div className="space-y-2.5">
                <Bubble>hey — new place, who can read this?</Bubble>
                <Bubble self>just us. keys never left our devices.</Bubble>
                <Bubble>
                    <span className="flex items-center gap-1.5 text-muted">
                        <Lock size={13} aria-hidden="true" />
                        locked message · passphrase required
                    </span>
                </Bubble>
                <Bubble self>
                    <span className="flex items-center gap-1.5">
                        <Flame size={13} className="text-warn" aria-hidden="true" />
                        this one burns when you read it
                    </span>
                </Bubble>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------------- *
 * Burn mockup — a message mid-destruction.
 * ------------------------------------------------------------------------- */

export function BurnMockup() {
    return (
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <div className="flex items-center gap-2 t-small font-semibold tracking-wider text-warn uppercase">
                <Flame size={14} aria-hidden="true" />
                burn on read
            </div>
            <div className="rounded-2xl rounded-bl-sm border border-warn-line bg-warn-soft px-3.5 py-2 t-base text-foreground">
                the meeting moved to friday. memorise it.
            </div>
            <div className="rounded-2xl rounded-bl-sm border border-border bg-surface-raised px-3.5 py-2 t-base text-muted line-through">
                read once · destroyed on both sides
            </div>
            <p className="t-small text-muted">
                No copy kept. No undo. That is the feature.
            </p>
        </div>
    );
}

/* ------------------------------------------------------------------------- *
 * Key card — recovery phrase chips + a fingerprint line.
 * ------------------------------------------------------------------------- */

const PHRASE = ["ember", "vault", "quiet", "orbit", "cedar", "night"];

export function KeyCard() {
    return (
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <div className="flex items-center gap-2 t-small font-semibold tracking-wider text-primary uppercase">
                <KeyRound size={14} aria-hidden="true" />
                your recovery phrase
            </div>
            <div className="flex flex-wrap gap-2">
                {PHRASE.map((w, i) => (
                    <span
                        key={w}
                        className="rounded-lg border border-primary-line bg-primary-soft px-2.5 py-1 t-base font-mono text-foreground"
                    >
                        <span className="mr-1.5 text-muted">{i + 1}</span>
                        {w}
                    </span>
                ))}
                <span className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 t-base text-muted">
                    + 6 more
                </span>
            </div>
            <p className="t-small text-muted">
                Generated on your device. Shown once. Held only by you.
            </p>
        </div>
    );
}

/* ------------------------------------------------------------------------- *
 * Theme swatches — the "make it yours" visual.
 * ------------------------------------------------------------------------- */

const ACCENTS = ["#34c07a", "#45c3d6", "#7cb0ef", "#e2b566", "#f16d6b"];

export function ThemeSwatches() {
    return (
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <div className="t-small font-semibold tracking-wider text-primary uppercase">
                make it yours
            </div>
            <div className="flex gap-3">
                {ACCENTS.map((c) => (
                    <span
                        key={c}
                        className="size-9 rounded-full border-2 border-border"
                        style={{ backgroundColor: c }}
                    />
                ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-surface-raised p-3">
                    <p className="t-small font-semibold text-foreground">dark</p>
                    <div className="mt-2 h-1.5 w-3/4 rounded-full bg-primary" />
                    <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-border" />
                </div>
                <div className="rounded-xl border border-primary-line bg-primary-soft p-3">
                    <p className="t-small font-semibold text-foreground">custom</p>
                    <div className="mt-2 h-1.5 w-3/4 rounded-full bg-secondary" />
                    <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-border" />
                </div>
            </div>
            <p className="t-small text-muted">
                Light, dark, and a custom accent — your vault, your look.
            </p>
        </div>
    );
}
