import { ReactNode, useEffect } from "react";
import MarketingNav from "./MarketingNav";
import MarketingFooter from "./MarketingFooter";
import "../marketing.css";

/**
 * Shell shared by every public page: nav on top, page body in the middle,
 * footer at the bottom, all on the solid app background.
 *
 * Also owns the scroll-reveal machinery: one IntersectionObserver watches every
 * [data-reveal] element on the mounted page and stamps .is-visible the first
 * time it scrolls into view (then stops watching it — reveals play once).
 * Pages opt in per element; stagger with style={{ "--reveal-delay": "120ms" }}.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
    useEffect(() => {
        const els = document.querySelectorAll("[data-reveal]");
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        e.target.classList.add("is-visible");
                        io.unobserve(e.target);
                    }
                }
            },
            { threshold: 0.15, rootMargin: "0px 0px -48px 0px" },
        );
        els.forEach((el) => io.observe(el));
        return () => io.disconnect();
    }, []);

    return (
        <div className="flex min-h-screen flex-col bg-bg text-foreground">
            <MarketingNav />
            <main className="flex-1">{children}</main>
            <MarketingFooter />
        </div>
    );
}
