import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown } from "lucide-react";
import MarketingLayout from "./components/MarketingLayout";
import { Icon } from "./components/icons";
import { KB } from "./content";

export default function KnowledgeBase() {
    return (
        <MarketingLayout>
            <section className="border-border border-b">
                <div className="mx-auto max-w-3xl px-4 pt-20 pb-16 text-center sm:px-6 lg:pt-28">
                    <h1 data-reveal className="t-display text-foreground">
                        Knowledge base
                    </h1>
                    <p
                        data-reveal
                        style={
                            { "--reveal-delay": "100ms" } as React.CSSProperties
                        }
                        className="t-lead text-muted mx-auto mt-5 max-w-xl"
                    >
                        Some of your questions answered
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

            <section className="border-border bg-surface border-t">
                <div className="mx-auto flex max-w-3xl flex-col items-start gap-5 px-4 py-16 sm:px-6">
                    <h2 data-reveal className="t-display-2 text-foreground">
                        Still have a question?
                    </h2>
                    <p className="t-lead text-muted">
                        The fastest way to understand CryptChat is to make an
                        account. It takes a moment and nothing leaves your
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
                <span className="border-primary-line bg-primary-soft text-primary inline-flex rounded-xl border p-2.5">
                    <Icon name={icon} size={20} />
                </span>
                <h2 className="t-h2 text-foreground font-bold tracking-tight">
                    {title}
                </h2>
            </div>
            <div className="space-y-3">
                {articles.map((a, i) => {
                    const isOpen = open === i;
                    return (
                        <div
                            key={a.q}
                            className={`bg-surface overflow-hidden rounded-2xl border transition-colors ${
                                isOpen ? "border-primary-line" : "border-border"
                            }`}
                        >
                            <button
                                type="button"
                                onClick={() => setOpen(isOpen ? null : i)}
                                aria-expanded={isOpen}
                                className="t-base text-foreground hover:text-primary flex w-full items-center justify-between gap-3 px-5 py-4 text-left font-semibold"
                            >
                                {a.q}
                                <ChevronDown
                                    size={18}
                                    aria-hidden="true"
                                    className={`text-muted shrink-0 transition-transform duration-300 ${
                                        isOpen ? "text-primary rotate-180" : ""
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
                                    <p className="t-base text-muted px-5 pb-4">
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
