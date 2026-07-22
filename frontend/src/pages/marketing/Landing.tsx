import { Link } from "react-router-dom";
import { ArrowRight, Flame, KeyRound, Lock, Phone } from "lucide-react";
import MarketingLayout from "./components/MarketingLayout";
import { Icon } from "./components/icons";
import { BurnMockup, ChatMockup, TerminalCard } from "./components/visuals";
import { FEATURES, HERO_LINE, HERO_SUB, MARQUEE, TAGLINE } from "./content";

/**
 * The product's front door, discord.com-style: a huge centred hero over a live
 * typing terminal with floating feature tiles, a looping claim ticker, a
 * staggered feature grid, two alternating deep-dive rows with UI mockups, and
 * a bold closing band. Motion comes from marketing.css ([data-reveal], .mk-*)
 * and respects prefers-reduced-motion. Solid token fills only.
 */
export default function Landing() {
    return (
        <MarketingLayout>
            <Hero />
            <Ticker />
            <FeatureGrid />
            <DeepDives />
            <ClosingBand />
        </MarketingLayout>
    );
}

/* ---- hero --------------------------------------------------------------- */

function Hero() {
    return (
        <section className="relative overflow-hidden border-b border-border">
            <div className="mx-auto max-w-4xl px-4 pt-20 pb-14 text-center sm:px-6 lg:pt-28">
                <span
                    data-reveal
                    className="tag border border-primary-line bg-primary-soft text-primary"
                >
                    {TAGLINE}
                </span>
                <h1
                    data-reveal
                    style={{ "--reveal-delay": "80ms" } as React.CSSProperties}
                    className="t-display mt-6 text-balance text-foreground"
                >
                    {HERO_LINE}
                </h1>
                <p
                    data-reveal
                    style={{ "--reveal-delay": "160ms" } as React.CSSProperties}
                    className="t-lead mx-auto mt-6 max-w-xl text-muted"
                >
                    {HERO_SUB}
                </p>
                <div
                    data-reveal
                    style={{ "--reveal-delay": "240ms" } as React.CSSProperties}
                    className="mt-8 flex flex-wrap items-center justify-center gap-3"
                >
                    <Link to="/login" className="btn-primary btn-hero">
                        Launch App
                        <ArrowRight size={18} aria-hidden="true" />
                    </Link>
                    <Link to="/showcase" className="btn-ghost btn-hero">
                        See how it works
                    </Link>
                </div>
            </div>

            {/* Terminal + floating tiles. Tiles are decorative, hidden on small
                screens, bobbing on independent phases. */}
            <div className="relative mx-auto max-w-2xl px-4 pb-20 sm:px-6">
                <div
                    data-reveal
                    style={{ "--reveal-delay": "320ms" } as React.CSSProperties}
                >
                    <TerminalCard />
                </div>

                <FloatTile className="mk-float -top-6 -left-24 hidden lg:grid">
                    <Lock size={22} className="text-secondary" aria-hidden="true" />
                </FloatTile>
                <FloatTile className="mk-float-alt top-24 -right-28 hidden lg:grid">
                    <Flame size={22} className="text-warn" aria-hidden="true" />
                </FloatTile>
                <FloatTile className="mk-float -bottom-2 -right-16 hidden xl:grid">
                    <KeyRound size={22} className="text-primary" aria-hidden="true" />
                </FloatTile>
                <FloatTile className="mk-float-alt bottom-24 -left-32 hidden xl:grid">
                    <Phone size={22} className="text-info" aria-hidden="true" />
                </FloatTile>
            </div>
        </section>
    );
}

function FloatTile({
    className,
    children,
}: {
    className: string;
    children: React.ReactNode;
}) {
    return (
        <div
            className={`absolute size-14 place-items-center rounded-2xl border border-border bg-surface shadow-lg ${className}`}
            aria-hidden="true"
        >
            {children}
        </div>
    );
}

/* ---- ticker ------------------------------------------------------------- */

function Ticker() {
    // Track holds the list twice; the loop translates -50% for a seamless wrap.
    const row = [...MARQUEE, ...MARQUEE];
    return (
        <div className="mk-marquee border-b border-border bg-primary py-3">
            <div className="mk-marquee-track">
                {row.map((t, i) => (
                    <span
                        key={i}
                        className="t-base flex items-center gap-8 pr-8 font-semibold tracking-wide whitespace-nowrap text-primary-foreground uppercase"
                    >
                        {t}
                        <span aria-hidden="true">✦</span>
                    </span>
                ))}
            </div>
        </div>
    );
}

/* ---- feature grid ------------------------------------------------------- */

function FeatureGrid() {
    return (
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
            <h2 data-reveal className="t-display-2 text-foreground">
                Built to keep quiet
            </h2>
            <p
                data-reveal
                style={{ "--reveal-delay": "80ms" } as React.CSSProperties}
                className="t-lead mt-3 max-w-lg text-muted"
            >
                Every feature answers one question — who can read this? The
                answer is always only the people you chose.
            </p>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map((f, i) => (
                    <div
                        key={f.title}
                        data-reveal
                        style={
                            {
                                "--reveal-delay": `${(i % 3) * 90}ms`,
                            } as React.CSSProperties
                        }
                        className="mk-lift space-y-3 rounded-2xl border border-border bg-surface p-6"
                    >
                        <div className="inline-flex rounded-xl border border-primary-line bg-primary-soft p-2.5 text-primary">
                            <Icon name={f.icon} size={22} />
                        </div>
                        <h3 className="t-h3 font-bold text-foreground">
                            {f.title}
                        </h3>
                        <p className="t-base text-muted">{f.body}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}

/* ---- deep dives --------------------------------------------------------- */

function DeepDives() {
    return (
        <section className="border-t border-border bg-surface">
            <div className="mx-auto max-w-6xl space-y-24 px-4 py-20 sm:px-6 lg:py-28">
                <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                    <div data-reveal>
                        <p className="t-small font-semibold tracking-wider text-primary uppercase">
                            Conversations
                        </p>
                        <h2 className="t-display-2 mt-2 text-foreground">
                            A room only you two can hear
                        </h2>
                        <p className="t-lead mt-4 text-muted">
                            Messages encrypt before they leave and decrypt only
                            on the far end. The relay is a courier that never
                            opens the envelope — replies, reactions, calls and
                            attachments included.
                        </p>
                    </div>
                    <div
                        data-reveal
                        style={{ "--reveal-delay": "120ms" } as React.CSSProperties}
                    >
                        <ChatMockup />
                    </div>
                </div>

                <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                    <div
                        data-reveal
                        style={{ "--reveal-delay": "120ms" } as React.CSSProperties}
                        className="lg:order-1"
                    >
                        <BurnMockup />
                    </div>
                    <div data-reveal className="lg:order-2">
                        <p className="t-small font-semibold tracking-wider text-warn uppercase">
                            Control
                        </p>
                        <h2 className="t-display-2 mt-2 text-foreground">
                            Some messages should not live forever
                        </h2>
                        <p className="t-lead mt-4 text-muted">
                            Burn a message so it destroys itself the moment it is
                            read, or seal one behind its own passphrase. Gone
                            means gone — on both sides, with no copy to recover.
                        </p>
                        <Link
                            to="/showcase"
                            className="t-base mt-5 inline-flex items-center gap-1.5 font-semibold text-primary hover:text-primary-strong"
                        >
                            Take the full tour
                            <ArrowRight size={16} aria-hidden="true" />
                        </Link>
                    </div>
                </div>
            </div>
        </section>
    );
}

/* ---- closing band ------------------------------------------------------- */

function ClosingBand() {
    return (
        <section className="border-t border-border">
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
                <div
                    data-reveal
                    className="rounded-3xl border border-primary-line bg-primary-soft px-6 py-14 text-center sm:px-12"
                >
                    <h2 className="t-display-2 text-balance text-foreground">
                        Nothing to configure. Nothing to trust us with.
                    </h2>
                    <p className="t-lead mx-auto mt-4 max-w-xl text-muted">
                        Make an account and start a channel. Your keys stay on
                        your device from the first message.
                    </p>
                    <Link
                        to="/login"
                        className="btn-primary btn-hero mt-8 inline-flex"
                    >
                        Launch App
                        <ArrowRight size={18} aria-hidden="true" />
                    </Link>
                </div>
            </div>
        </section>
    );
}
