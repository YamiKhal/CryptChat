import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import MarketingLayout from "./components/MarketingLayout";
import {
    BurnMockup,
    ChatMockup,
    KeyCard,
    TerminalCard,
    ThemeSwatches,
} from "./components/visuals";
import { SHOWCASE } from "./content";

/**
 * A walked product tour: four alternating panels, each pairing the copy from
 * content.ts with a live UI mockup, all scroll-revealed. Panels flip sides on
 * wide screens; on mobile they stack text-first. No login needed.
 */

// Panel index -> its visual. Order matches SHOWCASE in content.ts.
const VISUALS: ReactNode[] = [
    <KeyCard key="k" />,
    <ChatMockup key="c" />,
    <BurnMockup key="b" />,
    <ThemeSwatches key="t" />,
];

export default function Showcase() {
    return (
        <MarketingLayout>
            <section className="border-b border-border">
                <div className="mx-auto max-w-3xl px-4 pt-20 pb-16 text-center sm:px-6 lg:pt-28">
                    <h1 data-reveal className="t-display text-balance text-foreground">
                        See exactly what happens to a message
                    </h1>
                    <p
                        data-reveal
                        style={{ "--reveal-delay": "100ms" } as React.CSSProperties}
                        className="t-lead mx-auto mt-5 max-w-xl text-muted"
                    >
                        From the keypair on your device to the ciphertext on the
                        wire. No magic, no plaintext, no server that can read you.
                    </p>
                </div>
            </section>

            <div className="mx-auto max-w-6xl space-y-24 px-4 py-20 sm:px-6 lg:space-y-32 lg:py-28">
                {SHOWCASE.map((panel, i) => (
                    <section
                        key={panel.kicker}
                        className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
                    >
                        <div
                            data-reveal
                            className={i % 2 === 1 ? "lg:order-2" : ""}
                        >
                            <p className="t-small font-semibold tracking-wider text-primary uppercase">
                                {panel.kicker}
                            </p>
                            <h2 className="t-display-2 mt-2 text-foreground">
                                {panel.title}
                            </h2>
                            <p className="t-lead mt-4 text-muted">{panel.body}</p>
                            <ul className="mt-6 space-y-2.5">
                                {panel.points.map((p) => (
                                    <li
                                        key={p}
                                        className="t-base flex items-start gap-2.5 text-foreground"
                                    >
                                        <span className="mt-0.5 inline-flex rounded-md border border-primary-line bg-primary-soft p-1 text-primary">
                                            <Check size={12} aria-hidden="true" />
                                        </span>
                                        {p}
                                    </li>
                                ))}
                            </ul>
                        </div>

                        <div
                            data-reveal
                            style={{ "--reveal-delay": "140ms" } as React.CSSProperties}
                            className={i % 2 === 1 ? "lg:order-1" : ""}
                        >
                            {VISUALS[i] ?? <TerminalCard />}
                        </div>
                    </section>
                ))}
            </div>

            <section className="border-t border-border bg-surface">
                <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
                    <h2 data-reveal className="t-display-2 text-foreground">
                        Ready when you are.
                    </h2>
                    <Link to="/login" className="btn-primary btn-hero shrink-0">
                        Launch App
                        <ArrowRight size={18} aria-hidden="true" />
                    </Link>
                </div>
            </section>
        </MarketingLayout>
    );
}
