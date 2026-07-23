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

const VISUALS: ReactNode[] = [
    <KeyCard key="k" />,
    <ChatMockup key="c" />,
    <BurnMockup key="b" />,
    <ThemeSwatches key="t" />,
];

export default function Showcase() {
    return (
        <MarketingLayout>
            <section className="border-border border-b">
                <div className="mx-auto max-w-3xl px-4 pt-20 pb-16 text-center sm:px-6 lg:pt-28">
                    <h1
                        data-reveal
                        className="t-display text-foreground text-balance"
                    >
                        Feature Showcase
                    </h1>
                    <p
                        data-reveal
                        style={
                            { "--reveal-delay": "100ms" } as React.CSSProperties
                        }
                        className="t-lead text-muted mx-auto mt-5 max-w-xl"
                    >
                        All the tools for secured messaging for you and your
                        pals
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
                            <h2 className="t-display-2 text-foreground mt-2">
                                {panel.title}
                            </h2>
                            <p className="t-lead text-muted mt-4">
                                {panel.body}
                            </p>
                            <ul className="mt-6 space-y-2.5">
                                {panel.points.map((p) => (
                                    <li
                                        key={p}
                                        className="t-base text-foreground flex items-start gap-2.5"
                                    >
                                        <span className="border-primary-line bg-primary-soft text-primary mt-0.5 inline-flex rounded-md border p-1">
                                            <Check
                                                size={12}
                                                aria-hidden="true"
                                            />
                                        </span>
                                        {p}
                                    </li>
                                ))}
                            </ul>
                        </div>

                        <div
                            data-reveal
                            style={
                                {
                                    "--reveal-delay": "140ms",
                                } as React.CSSProperties
                            }
                            className={i % 2 === 1 ? "lg:order-1" : ""}
                        >
                            {VISUALS[i] ?? <TerminalCard />}
                        </div>
                    </section>
                ))}
            </div>

            <section className="border-border bg-surface border-t">
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
