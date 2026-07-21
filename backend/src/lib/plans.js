import { config } from "../config.js";

/**
 * What can be bought, and what each thing is worth.
 *
 * Two shapes, and the difference runs all the way through the system:
 *
 *   subscription -- recurring. Stripe owns the clock: it renews, it bills, and
 *                   `invoice.paid` extends the entitlement. Cancelling is the
 *                   user's, via the portal.
 *
 *   gift         -- a one-off payment worth N months. Stripe has no concept of
 *                   "this payment is worth 3 months", so the duration lives here
 *                   and nowhere else. There is no renewal and nothing to cancel.
 *
 * The slug is the only thing a client ever sends. It is mapped to a price id
 * here, server-side, from configuration -- a price id from the browser would let
 * someone check out against the cheapest price on the account (or a leftover
 * test price at zero) and take 12 months for free.
 */

export const PLANS = {
    /* --- subscriptions: one Stripe product, four recurring prices --- */
    monthly: {
        kind: "subscription",
        months: 1,
        label: "Monthly",
        blurb: "billed every month",
        priceKey: "monthly",
        priceValue: "4.99",
    },
    quarterly: {
        kind: "subscription",
        months: 3,
        label: "3 months",
        blurb: "billed every 3 months",
        priceKey: "quarterly",
        priceValue: "13.99",
    },
    semiannual: {
        kind: "subscription",
        months: 6,
        label: "6 months",
        blurb: "billed every 6 months",
        priceKey: "semiannual",
        priceValue: "25.99",
    },
    yearly: {
        kind: "subscription",
        months: 12,
        label: "12 months",
        blurb: "billed once a year",
        priceKey: "yearly",
        priceValue: "49.99",
    },

    /* --- gifts: a second Stripe product, four one-off prices --- */
    gift1: { kind: "gift", months: 1, label: "1 month", blurb: "one-off", priceKey: "gift1", priceValue: "4.99" },
    gift3: { kind: "gift", months: 3, label: "3 months", blurb: "one-off", priceKey: "gift3", priceValue: "13.99" },
    gift6: { kind: "gift", months: 6, label: "6 months", blurb: "one-off", priceKey: "gift6", priceValue: "25.99" },
    gift12: { kind: "gift", months: 12, label: "12 months", blurb: "one-off", priceKey: "gift12", priceValue: "49.99" },
};

/**
 * Resolve a client-supplied slug to a real plan, or null.
 *
 * Returns null for an unknown slug AND for a known slug whose price is not
 * configured -- a plan the operator never set up must not reach Stripe as
 * `price: undefined`, which fails with an error that says nothing useful.
 */
export function resolvePlan(slug) {
    if (typeof slug !== "string") return null;
    const plan = Object.prototype.hasOwnProperty.call(PLANS, slug) ? PLANS[slug] : null;
    if (!plan) return null;

    const priceId = config.billing.prices[plan.priceKey];
    if (!priceId) return null;

    return { slug, ...plan, priceId };
}

/** Every plan the operator has actually configured a price for. */
export function availablePlans() {
    return Object.keys(PLANS)
        .map((slug) => resolvePlan(slug))
        .filter(Boolean)
        .map(({ slug, kind, months, label, blurb, priceValue }) => ({
            slug,
            kind,
            months,
            label,
            blurb,
            // The display price. A plan the operator priced has one; keep it null
            // rather than undefined so it serialises predictably to the client.
            priceValue: priceValue ?? null,
        }));
}

/** Stripe checkout mode. Gifts are one-off payments, not subscriptions. */
export function checkoutMode(plan) {
    return plan.kind === "gift" ? "payment" : "subscription";
}
