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
        <footer className="border-border bg-surface border-t">
            <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_auto_auto] lg:gap-20">
                <div>
                    <p className="text-primary flex items-center gap-2 font-bold tracking-tight">
                        <ShieldCheck size={26} aria-hidden="true" />
                        <span className="t-h2">{BRAND}</span>
                    </p>
                    <p className="t-base text-muted mt-2">{TAGLINE}</p>
                    <Link
                        to="/login"
                        className="btn-primary mt-6 inline-flex rounded-full px-6 font-semibold"
                    >
                        Launch App
                    </Link>
                </div>

                <nav className="space-y-2.5">
                    <p className="t-small text-muted font-semibold tracking-wider uppercase">
                        Product
                    </p>
                    <Link
                        to="/showcase"
                        className="t-base text-foreground hover:text-primary block"
                    >
                        Showcase
                    </Link>
                    <Link
                        to="/kb"
                        className="t-base text-foreground hover:text-primary block"
                    >
                        Knowledge Base
                    </Link>
                </nav>

                <nav className="space-y-2.5">
                    <p className="t-small text-muted font-semibold tracking-wider uppercase">
                        App
                    </p>
                    <Link
                        to="/login"
                        className="t-base text-foreground hover:text-primary block"
                    >
                        Log in
                    </Link>
                    <Link
                        to="/recover"
                        className="t-base text-foreground hover:text-primary block"
                    >
                        Recover account
                    </Link>
                </nav>
            </div>
            <div className="border-border border-t">
                <p className="t-small text-muted mx-auto max-w-6xl px-4 py-5 sm:px-6">
                    © {year} {BRAND}. For your privacy.
                </p>
            </div>
        </footer>
    );
}
