import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import ThemeToggle from "@/components/theme/ThemeToggle";
import { BRAND } from "../content";

/**
 * Top bar for the public marketing pages. Solid surface, sticky; picks up a
 * drop shadow once the page scrolls so it reads as floating over content. The
 * wordmark returns home, the pill links reach the public pages, and Launch App
 * is the one route into the product — /login forwards an already-unlocked user
 * straight to /channels.
 */

const links = [
    { to: "/showcase", label: "Showcase" },
    { to: "/kb", label: "Knowledge Base" },
];

function PillLink({ to, label }: { to: string; label: string }) {
    return (
        <NavLink
            to={to}
            className={({ isActive }) =>
                `rounded-full px-4 py-1.5 t-base font-medium transition-colors ${
                    isActive
                        ? "bg-primary-soft text-primary"
                        : "text-muted hover:bg-surface-raised hover:text-foreground"
                }`
            }
        >
            {label}
        </NavLink>
    );
}

export default function MarketingNav() {
    const [scrolled, setScrolled] = useState(false);

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 8);
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    return (
        <header
            className={`sticky top-0 z-20 border-b border-border bg-surface transition-shadow duration-300 ${
                scrolled ? "shadow-lg" : ""
            }`}
        >
            <nav className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
                <Link
                    to="/"
                    className="flex items-center gap-2 font-bold tracking-tight text-primary transition-transform hover:scale-[1.03]"
                >
                    <ShieldCheck size={22} aria-hidden="true" />
                    <span className="t-h3">{BRAND}</span>
                </Link>

                <div className="ml-4 hidden items-center gap-1 sm:flex">
                    {links.map((l) => (
                        <PillLink key={l.to} {...l} />
                    ))}
                </div>

                <div className="ml-auto flex items-center gap-2">
                    <ThemeToggle className="text-muted" />
                    <Link
                        to="/login"
                        className="btn-primary rounded-full px-5 font-semibold"
                    >
                        Launch App
                    </Link>
                </div>
            </nav>

            {/* Small screens: links drop under the bar so they never crowd the
                Launch App button. */}
            <div className="flex items-center gap-1 border-t border-border px-4 py-2 sm:hidden">
                {links.map((l) => (
                    <PillLink key={l.to} {...l} />
                ))}
            </div>
        </header>
    );
}
