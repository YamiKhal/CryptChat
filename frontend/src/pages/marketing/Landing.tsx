import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import MarketingLayout from "./components/MarketingLayout";
import { Icon } from "./components/icons";
import { Circuit, HERO_CIRCUIT } from "./components/CircuitWeb";
import { BurnMockup, ChatMockup, TerminalCard } from "./components/visuals";
import { FEATURES, HERO_LINE, HERO_SUB } from "./content";

/**
 * The product's front door, discord.com-style: a split hero with the copy and
 * CTAs on the left and a live typing terminal on the right, riding a tilted
 * semi-transparent "cyber net" that connects the feature icons. Below it a
 * staggered feature grid, two alternating deep-dive rows with UI mockups and
 * a bold closing band. Motion comes from marketing.css ([data-reveal], .mk-*)
 * and respects prefers-reduced-motion. Solid token fills only.
 */
export default function Landing() {
    return (
        <MarketingLayout>
            <Hero />
            <FeatureGrid />
            <DeepDives />
            <ClosingBand />
        </MarketingLayout>
    );
}

/* ---- hero --------------------------------------------------------------- */

function Hero() {
    return (
        <section className="relative">
            <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-20 pb-16 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:pt-28">
                {/* left: copy + CTAs (kept above the circuit at all sizes) */}
                <div className="relative z-10 text-center lg:text-left">
                    <h1 data-reveal className="t-display text-foreground">
                        {HERO_LINE}
                    </h1>
                    <p
                        data-reveal
                        style={
                            { "--reveal-delay": "160ms" } as React.CSSProperties
                        }
                        className="t-lead text-muted mx-auto mt-6 max-w-xl lg:mx-0"
                    >
                        {HERO_SUB}
                    </p>
                    <div
                        data-reveal
                        style={
                            { "--reveal-delay": "240ms" } as React.CSSProperties
                        }
                        className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start"
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

                {/* right: terminal over the tilted cyber net */}
                <div className="relative">
                    {/* Net sits absolute behind the terminal, oversized so its
                    strands reach the icons and bleed past the panel. Tilted and
                    faded so it reads as texture, never straight-on. */}
                    <div
                        className="pointer-events-none absolute top-1/2 left-1/2 z-0"
                        style={{
                            transform:
                                "translate(-50%, -50%) perspective(1000px) rotateY(-24deg) rotateX(9deg)",
                            opacity: 0.3,
                        }}
                    >
                        <Circuit preset={HERO_CIRCUIT} className="text-primary" />
                    </div>
                    <div
                        data-reveal
                        style={
                            { "--reveal-delay": "320ms" } as React.CSSProperties
                        }
                        className="relative z-10"
                    >
                        <TerminalCard />
                    </div>
                </div>
            </div>
        </section>
    );
}

/* ---- feature grid ------------------------------------------------------- */

function FeatureGrid() {
    // Card centers, measured from the DOM so connections follow whatever the
    // responsive grid lays out (1 / 2 / 3 columns). Cards link to their grid
    // neighbours (same row across, same column down); hovering a card lights
    // its segments and border green so the connection reads.
    const gridRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
    const [segs, setSegs] = useState<
        { a: number; b: number; x1: number; y1: number; x2: number; y2: number }[]
    >([]);
    const [active, setActive] = useState<number | null>(null);

    useLayoutEffect(() => {
        const compute = () => {
            const grid = gridRef.current;
            if (!grid) return;
            // offset* is the laid-out position relative to the positioned grid,
            // ignoring the data-reveal transform (rect would include it).
            const centers = cardRefs.current.map((el, i) => ({
                i,
                x: el!.offsetLeft + el!.offsetWidth / 2,
                y: el!.offsetTop + el!.offsetHeight / 2,
            }));
            // Cluster into rows/cols by rounding position to a tolerance, then
            // connect each card to the next one in its row and in its column.
            const TOL = 12;
            const key = (v: number) => Math.round(v / TOL);
            const list: typeof segs = [];
            const link = (a: number, b: number) =>
                list.push({
                    a,
                    b,
                    x1: centers[a].x,
                    y1: centers[a].y,
                    x2: centers[b].x,
                    y2: centers[b].y,
                });
            // rows: same y, connect consecutive by x
            const rows = new Map<number, number[]>();
            centers.forEach((c) => {
                const k = key(c.y);
                (rows.get(k) ?? rows.set(k, []).get(k)!).push(c.i);
            });
            rows.forEach((ids) => {
                ids.sort((a, b) => centers[a].x - centers[b].x);
                for (let n = 0; n < ids.length - 1; n++) link(ids[n], ids[n + 1]);
            });
            // cols: same x, connect consecutive by y
            const cols = new Map<number, number[]>();
            centers.forEach((c) => {
                const k = key(c.x);
                (cols.get(k) ?? cols.set(k, []).get(k)!).push(c.i);
            });
            cols.forEach((ids) => {
                ids.sort((a, b) => centers[a].y - centers[b].y);
                for (let n = 0; n < ids.length - 1; n++) link(ids[n], ids[n + 1]);
            });
            setSegs(list);
        };
        compute();
        const ro = new ResizeObserver(compute);
        if (gridRef.current) ro.observe(gridRef.current);
        window.addEventListener("resize", compute);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", compute);
        };
    }, []);

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
            <div ref={gridRef} className="relative mt-12">
                {/* connection lines behind the cards. cards are opaque so the
                lines only show through the gaps between them. */}
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                    {segs.map((s, k) => (
                        <line
                            key={k}
                            x1={s.x1}
                            y1={s.y1}
                            x2={s.x2}
                            y2={s.y2}
                            className={`mk-link ${
                                active !== null &&
                                (s.a === active || s.b === active)
                                    ? "is-lit"
                                    : ""
                            }`}
                        />
                    ))}
                </svg>
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {FEATURES.map((f, i) => (
                        <div
                            key={f.title}
                            ref={(el) => {
                                cardRefs.current[i] = el;
                            }}
                            data-reveal
                            onMouseEnter={() => setActive(i)}
                            onMouseLeave={() => setActive(null)}
                            style={
                                {
                                    "--reveal-delay": `${(i % 3) * 90}ms`,
                                } as React.CSSProperties
                            }
                            className="mk-lift mk-node group border-border bg-surface relative space-y-3 overflow-hidden rounded-2xl border p-6"
                        >
                            <div className="text-muted/10 group-hover:text-primary/30 pointer-events-none absolute -top-2 right-2 mt-5 transition-colors">
                                <Icon name={f.icon} size={96} />
                            </div>
                            <h3 className="t-h2 text-foreground relative pt-10 font-bold">
                                {f.title}
                            </h3>
                            <p className="t-base text-muted relative">
                                {f.body}
                            </p>
                        </div>
                    ))}
                </div>
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
