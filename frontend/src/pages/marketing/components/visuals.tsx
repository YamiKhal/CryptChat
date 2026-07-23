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
    "$ relay connected",
    "> channel opened - decryption completed",
    "> sending message...",
    "✓ encrypted message was sent",
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
        <div className="border-border bg-surface overflow-hidden rounded-2xl border text-left">
            <div className="border-border bg-surface-raised text-muted flex items-center gap-2 border-b px-4 py-3">
                <span className="bg-error size-2.5 rounded-full" />
                <span className="bg-warn size-2.5 rounded-full" />
                <span className="bg-ok size-2.5 rounded-full" />
                <Terminal size={14} className="ml-2" aria-hidden="true" />
                <span className="t-small font-medium">how-it-works</span>
            </div>
            {/* Fixed min-height so the loop never shifts layout. */}
            <div className="min-h-40 space-y-2.5 p-5 font-mono">
                {SCRIPT.map((text, i) => {
                    if (i > pos.line) return null;
                    const shown =
                        i === pos.line ? text.slice(0, pos.chars) : text;
                    const accent = text.startsWith("$") || text.startsWith("✓");
                    return (
                        <div key={i} className="t-base">
                            <span
                                className={
                                    accent ? "text-primary" : "text-muted"
                                }
                            >
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
                className={`t-base max-w-[80%] rounded-2xl border px-3.5 py-2 ${
                    self
                        ? "border-primary-line bg-primary-soft text-foreground rounded-br-sm"
                        : "border-border bg-surface-raised text-foreground rounded-bl-sm"
                }`}
            >
                {children}
            </div>
        </div>
    );
}

export function ChatMockup() {
    return (
        <div className="border-border bg-surface rounded-2xl border p-4 shadow-xl">
            <div className="border-border mb-3 flex items-center gap-2 border-b pb-3">
                <span className="bg-primary-soft text-primary grid size-7 place-items-center rounded-full">
                    <ShieldCheck size={14} aria-hidden="true" />
                </span>
                <span className="t-base text-foreground font-semibold">
                    GroupChat
                </span>
            </div>
            <div className="space-y-2.5">
                <Bubble>OH wow, new place. Who can read this?</Bubble>
                <Bubble self>just us... everything stored local.</Bubble>
                <Bubble>
                    <span className="text-muted flex items-center gap-1.5">
                        <Lock size={13} aria-hidden="true" />
                        Passphrase required
                    </span>
                </Bubble>
                <Bubble self>
                    <span className="flex items-center gap-1.5">
                        <Flame
                            size={13}
                            className="text-warn"
                            aria-hidden="true"
                        />
                        You are lucky if you reading this, it's gonna go in 5.
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
        <div className="border-border bg-surface space-y-3 rounded-2xl border p-5 shadow-xl">
            <div className="t-small text-warn flex items-center gap-2 font-semibold tracking-wider uppercase">
                <Flame size={14} aria-hidden="true" />
                burn on read
            </div>
            <div className="border-warn-line bg-warn-soft t-base text-foreground rounded-2xl rounded-bl-sm border px-3.5 py-2">
                the meeting moved to friday. memorise it.
            </div>
            <div className="border-border bg-surface-raised t-base text-muted rounded-2xl rounded-bl-sm border px-3.5 py-2 line-through">
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
        <div className="border-border bg-surface space-y-4 rounded-2xl border p-5 shadow-xl">
            <div className="t-small text-primary flex items-center gap-2 font-semibold tracking-wider uppercase">
                <KeyRound size={14} aria-hidden="true" />
                your recovery phrase
            </div>
            <div className="flex flex-wrap gap-2">
                {PHRASE.map((w, i) => (
                    <span
                        key={w}
                        className="border-primary-line bg-primary-soft t-base text-foreground rounded-lg border px-2.5 py-1 font-mono"
                    >
                        <span className="text-muted mr-1.5">{i + 1}</span>
                        {w}
                    </span>
                ))}
                <span className="border-border bg-surface-raised t-base text-muted rounded-lg border px-2.5 py-1">
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
        <div className="border-border bg-surface space-y-4 rounded-2xl border p-5 shadow-xl">
            <div className="t-small text-primary font-semibold tracking-wider uppercase">
                make it yours
            </div>
            <div className="flex gap-3">
                {ACCENTS.map((c) => (
                    <span
                        key={c}
                        className="border-border size-9 rounded-full border-2"
                        style={{ backgroundColor: c }}
                    />
                ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="border-border bg-surface-raised rounded-xl border p-3">
                    <p className="t-small text-foreground font-semibold">
                        dark
                    </p>
                    <div className="bg-primary mt-2 h-1.5 w-3/4 rounded-full" />
                    <div className="bg-border mt-1.5 h-1.5 w-1/2 rounded-full" />
                </div>
                <div className="border-primary-line bg-primary-soft rounded-xl border p-3">
                    <p className="t-small text-foreground font-semibold">
                        custom
                    </p>
                    <div className="bg-secondary mt-2 h-1.5 w-3/4 rounded-full" />
                    <div className="bg-border mt-1.5 h-1.5 w-1/2 rounded-full" />
                </div>
            </div>
            <p className="t-small text-muted">
                Light, dark or a custom accent.
            </p>
        </div>
    );
}
