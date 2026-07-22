import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { BRAND, TAGLINE } from "../content";

/**
 * Foot of every public page. Big brand block on a solid surface, the same
 * destinations as the nav, so the marketing layer is fully navigable from top
 * or bottom.
 */
export default function MarketingFooter() {
    const year = new Date().getFullYear();
    return (
        <footer className="border-t border-border bg-surface">
            <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_auto_auto] lg:gap-20">
                <div>
                    <p className="flex items-center gap-2 font-bold tracking-tight text-primary">
                        <ShieldCheck size={26} aria-hidden="true" />
                        <span className="t-h2">{BRAND}</span>
                    </p>
                    <p className="t-base mt-2 text-muted">{TAGLINE}</p>
                    <Link
                        to="/login"
                        className="btn-primary mt-6 inline-flex rounded-full px-6 font-semibold"
                    >
                        Launch App
                    </Link>
                </div>

                <nav className="space-y-2.5">
                    <p className="t-small font-semibold tracking-wider text-muted uppercase">
                        Product
                    </p>
                    <Link
                        to="/showcase"
                        className="t-base block text-foreground hover:text-primary"
                    >
                        Showcase
                    </Link>
                    <Link
                        to="/kb"
                        className="t-base block text-foreground hover:text-primary"
                    >
                        Knowledge Base
                    </Link>
                </nav>

                <nav className="space-y-2.5">
                    <p className="t-small font-semibold tracking-wider text-muted uppercase">
                        App
                    </p>
                    <Link
                        to="/login"
                        className="t-base block text-foreground hover:text-primary"
                    >
                        Log in
                    </Link>
                    <Link
                        to="/recover"
                        className="t-base block text-foreground hover:text-primary"
                    >
                        Recover account
                    </Link>
                </nav>
            </div>
            <div className="border-t border-border">
                <p className="t-small mx-auto max-w-6xl px-4 py-5 text-muted sm:px-6">
                    © {year} {BRAND}. Your keys, your account.
                </p>
            </div>
        </footer>
    );
}
