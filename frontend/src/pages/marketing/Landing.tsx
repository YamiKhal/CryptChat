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
        <section className="relative overflow-hidden pb-5">
            <div className="mx-auto max-w-4xl px-4 pt-20 pb-14 text-center sm:px-6 lg:pt-28">
                {/* Terminal + floating tiles. Tiles are decorative, hidden on small
                screens, bobbing on independent phases. */}
                <div className="relative mx-auto max-w-2xl px-4 sm:px-6">
                    <div
                        data-reveal
                        style={
                            { "--reveal-delay": "320ms" } as React.CSSProperties
                        }
                    >
                        <TerminalCard />
                    </div>
                </div>
                <p
                    data-reveal
                    style={{ "--reveal-delay": "160ms" } as React.CSSProperties}
                    className="t-lead text-muted mx-auto mt-6 max-w-xl"
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
        </section>
    );
}

/* ---- ticker ------------------------------------------------------------- */

function Ticker() {
    // Track holds the list twice; the loop translates -50% for a seamless wrap.
    const row = [...MARQUEE, ...MARQUEE];
    return (
        <div className="mk-marquee border-primary bg-bg mt-5 border-t border-b py-3">
            <div className="mk-marquee-track">
                {row.map((t, i) => (
                    <span
                        key={i}
                        className="text-primary flex items-center gap-8 pr-8 text-xl font-semibold tracking-wide whitespace-nowrap uppercase"
                    >
                        {t}
                        <span aria-hidden="true">|</span>
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
                Your Privacy
            </h2>
            <p
                data-reveal
                style={{ "--reveal-delay": "80ms" } as React.CSSProperties}
                className="t-lead text-muted mt-3 max-w-lg"
            >
                Every feature was built around a single idea... who can see and
                stores what.
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
                        className="mk-lift group border-border bg-surface relative space-y-3 overflow-hidden rounded-2xl border p-6"
                    >
                        <div className="text-muted/10 group-hover:text-primary/30 pointer-events-none absolute -top-2 right-2 mt-5 transition-colors">
                            <Icon name={f.icon} size={96} />
                        </div>
                        <h3 className="t-h2 text-foreground relative pt-10 font-bold">
                            {f.title}
                        </h3>
                        <p className="t-base text-muted relative">{f.body}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}

/* ---- deep dives --------------------------------------------------------- */

function DeepDives() {
    return (
        <section className="border-border bg-surface border-t">
            <div className="mx-auto max-w-6xl space-y-24 px-4 py-20 sm:px-6 lg:py-28">
                <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                    <div data-reveal>
                        <h2 className="t-display-2 text-foreground mt-2">
                            A room for those chosen
                        </h2>
                        <p className="t-lead text-muted mt-4">
                            Messages encrypt before they leave and decrypt only
                            on the far end. The relay is a courier that never
                            opens the envelope. Replies, reactions, calls and
                            attachments included.
                        </p>
                    </div>
                    <div
                        data-reveal
                        style={
                            { "--reveal-delay": "120ms" } as React.CSSProperties
                        }
                    >
                        <ChatMockup />
                    </div>
                </div>

                <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                    <div
                        data-reveal
                        style={
                            { "--reveal-delay": "120ms" } as React.CSSProperties
                        }
                        className="lg:order-1"
                    >
                        <BurnMockup />
                    </div>
                    <div data-reveal className="lg:order-2">
                        <h2 className="t-display-2 text-foreground mt-2">
                            Methods to relay info
                        </h2>
                        <p className="t-lead text-muted mt-4">
                            Burn a message so it destroys itself the moment it
                            is read, or seal one behind its own passphrase.
                        </p>
                        <Link
                            to="/showcase"
                            className="t-base text-primary hover:text-primary-strong mt-5 inline-flex items-center gap-1.5 font-semibold"
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
        <section className="border-border border-t">
            <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
                <div
                    data-reveal
                    className="border-primary-line bg-primary-soft rounded-3xl border px-6 py-14 text-center sm:px-12"
                >
                    <h2 className="t-display-2 text-foreground text-balance">
                        Nothing to configure. Nothing to trust us with.
                    </h2>
                    <p className="t-lead text-muted mx-auto mt-4 max-w-xl">
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
