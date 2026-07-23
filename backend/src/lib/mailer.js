import { config } from "../config.js";

/**
 * Outbound mail. Server-side, by necessity.
 *
 * EmailJS and every other browser-side sender is unusable for auth mail: the
 * client composing the message is the client requesting it, so an attacker who
 * types someone else's address receives the token in their own browser. The
 * whole point of a recovery mail is that it goes somewhere the requester cannot
 * see unless they already control the mailbox.
 *
 * Provider-agnostic on purpose -- Resend's shape is the default because it is
 * the least ceremony, but nothing above this module knows which one is behind it.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * In dev, log instead of sending.
 *
 * Boot already refuses to start in production without a real key, so this branch
 * cannot silently swallow production mail -- it only exists so `npm run dev`
 * works with no provider account and the token lands in the terminal where a
 * developer can click it.
 */
function logInsteadOfSending(to, subject, text) {
    console.log(
        [
            "",
            "─── mail (dev: not actually sent) ────────────────",
            `to:      ${to}`,
            `subject: ${subject}`,
            "",
            text,
            "──────────────────────────────────────────────────",
            "",
        ].join("\n"),
    );
}

/**
 * Strip the local part of any address, keep the domain.
 *
 * Provider errors are the only thing that explains a rejected send and they
 * routinely quote addresses ("The x.com domain is not verified", "You can only
 * send to <your address>"). Dropping the whole message to avoid logging an
 * address throws away the diagnosis with it -- a bare "403" is unactionable and
 * the operator ends up reading Resend's dashboard to learn what their own logs
 * should have told them.
 *
 * The domain is what identifies a misconfiguration; the local part is what
 * identifies a person. So keep one and redact the other.
 */
function redactAddresses(text) {
    return String(text).replace(/[^\s<>@",;]+@([^\s<>@",;]+)/g, "•••@$1");
}

async function send({ to, subject, text }) {
    if (!config.mail.apiKey) {
        logInsteadOfSending(to, subject, text);
        return;
    }

    let res;
    try {
        res = await fetch(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.mail.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ from: config.mail.from, to: [to], subject, text }),
        });
    } catch (err) {
        throw new Error(`could not reach the mail provider: ${err.message}`);
    }

    if (res.ok) return;

    // Read the provider's explanation, redacted. Never let a parse failure here
    // mask the real error -- a body that is not JSON is itself a symptom.
    let detail = "";
    try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        detail = parsed.message || parsed.error || body;
    } catch {
        detail = "(no readable body)";
    }

    const hint = HINTS[res.status];
    throw new Error(
        `mail provider rejected the request: ${res.status} ${redactAddresses(detail)}` +
            (hint ? `\n  ${hint}` : ""),
    );
}

/**
 * The two failures that actually happen and what they mean.
 *
 * Both are configuration, both look identical from the call site and neither is
 * obvious from the status code alone.
 */
const HINTS = {
    403:
        "Usually MAIL_FROM is not at a domain you have verified with the provider " +
        "(check for a leftover placeholder like noreply@yourdomain.example), or the " +
        "API key is scoped to a different domain.",
    401: "MAIL_API_KEY is wrong, revoked, or lacks sending access.",
    422: 'The provider rejected the message shape -- check MAIL_FROM is "Name <addr@domain>".',
    429: "Rate limited by the mail provider.",
};

/**
 * Every template is plain text, no HTML, no tracking pixel, no click wrapper.
 *
 * A tracking pixel in a recovery mail would tell us when a user opened it, which
 * is exactly the activity metadata this product refuses to collect elsewhere
 * (IDENTITY.md §3.3). Link wrappers would route a user's click through us for
 * the same non-reason. Plain text is also what survives every client.
 */

// Exported for the tests: this is the guard that keeps addresses out of logs,
// and it is worth pinning rather than trusting a regex by eye.
export { redactAddresses };

export async function sendVerificationMail(to, token) {
    const url = `${config.publicAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await send({
        to,
        subject: "Confirm your CryptChat email",
        text: [
            "Someone added this address to a CryptChat account.",
            "",
            "Confirm it:",
            url,
            "",
            "This link works once and expires in 24 hours.",
            "",
            "If this wasn't you, ignore this mail -- the address is not attached to",
            "the account until the link is used.",
        ].join("\n"),
    });
}

export async function sendResetMail(to, token) {
    const url = `${config.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await send({
        to,
        subject: "Reset your CryptChat password",
        text: [
            "A password reset was requested for the CryptChat account using this",
            "address.",
            "",
            "Reset it:",
            url,
            "",
            "This link works once and expires in 30 minutes.",
            "",
            "IMPORTANT: resetting your password does not restore your channels. Your",
            "messages and keys are encrypted with a key only your devices hold. After",
            "resetting you will be asked for your recovery code -- the 24 words shown",
            "when you registered. Without it, the account comes back empty.",
            "",
            "If this wasn't you, ignore this mail and nothing changes.",
        ].join("\n"),
    });
}

export async function sendRedemptionMail(to, code, { months = 0, isGift = false } = {}) {
    const period = months === 1 ? "1 month" : `${months} months`;

    const giftBody = [
        `Thanks. Here is your gift code, good for ${period} of CryptChat Supporter:`,
        "",
        `    ${code}`,
        "",
        "Give it to whoever you like, or keep it. Whoever redeems it enters it under",
        "Settings > Subscription in the app.",
        "",
        `The ${period} start when the code is redeemed, not today -- so there is no`,
        "rush and nothing is lost by holding on to it. The code does not expire.",
        "",
        "If the person redeeming it already has a subscription, the gifted months are",
        "held in reserve and start once that subscription stops renewing. They will",
        "never pay for time they were given.",
        "",
        "This code is the only link between this payment and an account and we store",
        "only a hash of it -- we cannot look it up or re-send it. Keep this email",
        "until it has been redeemed.",
    ];

    const subscriptionBody = [
        "Thanks for subscribing. Here is your redemption code:",
        "",
        `    ${code}`,
        "",
        "Enter it under Settings > Subscription in the app to activate your badge.",
        "",
        "This code is the only link between this payment and an account and we store",
        "only a hash of it -- we cannot look it up or re-send it. Keep this email",
        "until you have redeemed it.",
    ];

    await send({
        to,
        subject: isGift
            ? `Your CryptChat gift code (${period})`
            : "Your CryptChat subscription code",
        text: (isGift ? giftBody : subscriptionBody).join("\n"),
    });
}
