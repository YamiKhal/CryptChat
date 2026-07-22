import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown } from "lucide-react";
import MarketingLayout from "./components/MarketingLayout";
import { Icon } from "./components/icons";
import { KB } from "./content";

/**
 * Public knowledge base — the questions people ask before trusting an app with
 * private messages, answered plainly, no login. Grouped sections of animated
 * accordions: the open/close is a grid-template-rows transition (0fr -> 1fr),
 * which animates height smoothly without measuring content. One open at a time
 * per section keeps the page tidy.
 */
export default function KnowledgeBase() {
    return (
        <MarketingLayout>
            <section className="border-b border-border">
                <div className="mx-auto max-w-3xl px-4 pt-20 pb-16 text-center sm:px-6 lg:pt-28">
                    <h1 data-reveal className="t-display text-foreground">
                        Knowledge base
                    </h1>
                    <p
                        data-reveal
                        style={{ "--reveal-delay": "100ms" } as React.CSSProperties}
                        className="t-lead mx-auto mt-5 max-w-xl text-muted"
                    >
                        Straight answers about accounts, encryption, and your
                        data. Read anything here before you sign in.
                    </p>
                </div>
            </section>

            <div className="mx-auto max-w-3xl space-y-14 px-4 py-16 sm:px-6">
                {KB.map((section) => (
                    <KbGroup
                        key={section.title}
                        icon={section.icon}
                        title={section.title}
                        articles={section.articles}
                    />
                ))}
            </div>

            <section className="border-t border-border bg-surface">
                <div className="mx-auto flex max-w-3xl flex-col items-start gap-5 px-4 py-16 sm:px-6">
                    <h2 data-reveal className="t-display-2 text-foreground">
                        Still have a question?
                    </h2>
                    <p className="t-lead text-muted">
                        The fastest way to understand CryptChat is to make an
                        account — it takes a moment and nothing leaves your
                        device unencrypted.
                    </p>
                    <Link to="/login" className="btn-primary btn-hero">
                        Launch App
                        <ArrowRight size={18} aria-hidden="true" />
                    </Link>
                </div>
            </section>
        </MarketingLayout>
    );
}

function KbGroup({
    icon,
    title,
    articles,
}: {
    icon: (typeof KB)[number]["icon"];
    title: string;
    articles: { q: string; a: string }[];
}) {
    // Index of the open article in this section; null = all closed.
    const [open, setOpen] = useState<number | null>(null);

    return (
        <section data-reveal>
            <div className="mb-5 flex items-center gap-3">
                <span className="inline-flex rounded-xl border border-primary-line bg-primary-soft p-2.5 text-primary">
                    <Icon name={icon} size={20} />
                </span>
                <h2 className="t-h2 font-bold tracking-tight text-foreground">
                    {title}
                </h2>
            </div>
            <div className="space-y-3">
                {articles.map((a, i) => {
                    const isOpen = open === i;
                    return (
                        <div
                            key={a.q}
                            className={`overflow-hidden rounded-2xl border bg-surface transition-colors ${
                                isOpen ? "border-primary-line" : "border-border"
                            }`}
                        >
                            <button
                                type="button"
                                onClick={() => setOpen(isOpen ? null : i)}
                                aria-expanded={isOpen}
                                className="t-base flex w-full items-center justify-between gap-3 px-5 py-4 text-left font-semibold text-foreground hover:text-primary"
                            >
                                {a.q}
                                <ChevronDown
                                    size={18}
                                    aria-hidden="true"
                                    className={`shrink-0 text-muted transition-transform duration-300 ${
                                        isOpen ? "rotate-180 text-primary" : ""
                                    }`}
                                />
                            </button>
                            <div
                                className="grid transition-[grid-template-rows] duration-300 ease-out"
                                style={{
                                    gridTemplateRows: isOpen ? "1fr" : "0fr",
                                }}
                            >
                                <div className="overflow-hidden">
                                    <p className="t-base px-5 pb-4 text-muted">
                                        {a.a}
                                    </p>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
