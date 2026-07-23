import { useEffect, useState } from "react";
import { Gift } from "lucide-react";
import { api, Plan } from "@/lib/api";
import InfoBox from "@/components/ui/InfoBox";

/**
 * Pick a plan and go to checkout.
 *
 * Self-contained on purpose: it fetches its own plans and drives its own Stripe
 * checkout, so both the logged-out /subscribe page and the in-app Settings tab
 * drop it in with no wiring. The checkout is anonymous either way -- a slug is
 * sent, never a price id and no session travels with it. That is what keeps a
 * payment unlinkable to an account and it holds whether or not someone is
 * signed in when they click.
 */

// No currency is configured server-side; Stripe's account currency is the
// source of truth. USD is its default and this is the one place to change it.
const CURRENCY = "$";

function priceLabel(plan: Plan): string | null {
    if (!plan.priceValue) return null;
    return `${CURRENCY}${plan.priceValue}`;
}

/** Per-month equivalent, for multi-month plans where the saving is the point. */
function perMonth(plan: Plan): string | null {
    if (!plan.priceValue || plan.months <= 1) return null;
    const each = Number(plan.priceValue) / plan.months;
    if (!Number.isFinite(each)) return null;
    return `${CURRENCY}${each.toFixed(2)}/mo`;
}

export default function PlanPicker({
    defaultMode = "subscription",
    /** Lock to gifting and hide the toggle -- an existing subscriber should not
      buy a second recurring plan, but can still gift a code. */
    giftOnly = false,
}: {
    defaultMode?: "subscription" | "gift";
    giftOnly?: boolean;
}) {
    const initialMode = giftOnly ? "gift" : defaultMode;
    const [plans, setPlans] = useState<Plan[] | null>(null);
    const [mode, setMode] = useState<"subscription" | "gift">(initialMode);
    const [selected, setSelected] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        api.plans()
            .then((res) => {
                if (cancelled) return;
                setPlans(res.plans);
                setSelected(
                    res.plans.find((p) => p.kind === initialMode)?.slug ?? null,
                );
            })
            .catch((err) => !cancelled && setError((err as Error).message));
        return () => {
            cancelled = true;
        };
    }, [initialMode]);

    const shown = (plans ?? []).filter((p) => p.kind === mode);

    function pickMode(next: "subscription" | "gift") {
        setMode(next);
        // Carry the choice across tabs by duration -- eyeing 3 months then switching
        // to gifting most likely still wants 3 months.
        const current = plans?.find((p) => p.slug === selected);
        const match = plans?.find(
            (p) => p.kind === next && p.months === current?.months,
        );
        setSelected(
            match?.slug ?? plans?.find((p) => p.kind === next)?.slug ?? null,
        );
    }

    async function handleCheckout() {
        if (!selected) return;
        setError("");
        setBusy(true);
        try {
            const { url } = await api.startCheckout(selected);
            // Stripe-hosted: no card data touches this origin.
            window.location.href = url;
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="space-y-3">
            {giftOnly ? (
                <p className="t-base text-muted">
                    Gift a code to someone. or bank one for yourself.
                </p>
            ) : (
                <div className="border-border bg-surface-raised grid grid-cols-2 gap-1 rounded-lg border p-0.5">
                    {(["subscription", "gift"] as const).map((m) => (
                        <button
                            key={m}
                            onClick={() => pickMode(m)}
                            aria-pressed={mode === m}
                            className={`t-base rounded-md px-2 py-1.5 transition-colors ${
                                mode === m
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted hover:text-foreground"
                            }`}
                        >
                            <span className="inline-flex items-center gap-1.5">
                                {m === "gift" && (
                                    <Gift size={12} aria-hidden="true" />
                                )}
                                {m === "subscription"
                                    ? "Subscribe"
                                    : "Gift a code"}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {plans === null && (
                <p className="t-base text-muted py-4 text-center">loading…</p>
            )}

            {plans !== null && shown.length === 0 && (
                <p className="t-base text-muted py-4 text-center">
                    {mode === "gift"
                        ? "Gift codes are not available yet."
                        : "Nothing is on sale yet."}
                </p>
            )}

            <div className="space-y-1.5">
                {shown.map((plan) => {
                    const price = priceLabel(plan);
                    const each = perMonth(plan);
                    return (
                        <button
                            key={plan.slug}
                            onClick={() => setSelected(plan.slug)}
                            aria-pressed={selected === plan.slug}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                selected === plan.slug
                                    ? "border-primary bg-primary-soft"
                                    : "border-border hover:border-primary-line"
                            }`}
                        >
                            <span className="min-w-0">
                                <span className="t-h4 block">{plan.label}</span>
                                <span className="t-small text-muted block">
                                    {plan.blurb}
                                </span>
                            </span>
                            {price && (
                                <span className="flex-none text-right">
                                    <span className="t-h4 block tabular-nums">
                                        {price}
                                    </span>
                                    {each && (
                                        <span className="t-small text-muted block tabular-nums">
                                            {each}
                                        </span>
                                    )}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {mode === "gift" && shown.length > 0 && (
                <InfoBox>
                    A gift is a code, not a subscription. nothing renews and
                    there is nothing to cancel. The months start when it is{" "}
                    <em>redeemed</em>, not today. If whoever redeems it already
                    has a subscription, the months are held in reserve and start
                    once that subscription stops renewing. Nobody pays for time
                    they were given.
                </InfoBox>
            )}

            {error && <InfoBox variant="error">{error}</InfoBox>}

            <button
                onClick={handleCheckout}
                disabled={busy || !selected}
                className="btn-primary w-full"
            >
                {busy
                    ? "redirecting…"
                    : mode === "gift"
                      ? "Buy gift code"
                      : "Subscribe"}
            </button>
        </div>
    );
}
