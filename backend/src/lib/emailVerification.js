import { pool } from "../db.js";
import { config } from "../config.js";
import { encryptEmail, issueToken } from "./identityCrypto.js";
import { sendVerificationMail } from "./mailer.js";

/**
 * Attaching an address is a two-step commit and both entry points (registration
 * and Settings) must do it identically -- hence this module rather than two
 * copies that drift.
 */

/**
 * Deliberately loose.
 *
 * Strict email regexes are famously wrong: they reject valid addresses (plus
 * tags, long TLDs, unicode local parts) far more often than they catch anything
 * real. The actual validation is the confirmation link -- whether an address can
 * receive mail is not a question a regex can answer.
 */
export function validEmail(value) {
    return (
        typeof value === "string" &&
        value.length >= 3 &&
        value.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    );
}

export class EmailTakenError extends Error {
    constructor() {
        super("that address is already attached to an account");
    }
}

/**
 * Encrypt the address, park it on a token and mail the link.
 *
 * The address is NOT written to `users` here. It rides in the token row until
 * the link is clicked, so mistyping a stranger's address does not attach it to
 * your account and hand them a reset lever. It lands on the user only in
 * `consumeVerification`.
 */
export async function startEmailVerification(userId, email) {
    const encrypted = encryptEmail(email);

    // Checked here for a clean error; enforced for real by the partial unique
    // index at consume time, since two people can pass this check concurrently.
    const taken = await pool.query("SELECT 1 FROM users WHERE email_hash = $1 AND id <> $2", [
        encrypted.emailHash,
        userId,
    ]);
    if (taken.rowCount > 0) throw new EmailTakenError();

    const { token, tokenHash } = issueToken();

    // One live verification at a time. Otherwise every superseded link stays
    // armed and a stale one could attach an address the user has since replaced.
    await pool.query(
        `DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'verify' AND consumed_at IS NULL`,
        [userId],
    );

    await pool.query(
        `INSERT INTO email_tokens
       (token_hash, user_id, purpose, email_ct, email_dek, email_hash, email_mask, expires_at)
     VALUES ($1, $2, 'verify', $3, $4, $5, $6, now() + ($7 || ' hours')::interval)`,
        [
            tokenHash,
            userId,
            encrypted.emailCt,
            encrypted.emailDek,
            encrypted.emailHash,
            encrypted.emailMask,
            String(config.identity.verifyTtlHours),
        ],
    );

    // The row is committed before this returns; the *send* is not awaited.
    //
    // The split matters. Callers need the pending state to be readable the moment
    // they get a response -- otherwise a client that fetches its own email state
    // right after registering sees "no pending address" and the UI lies. But
    // awaiting the mail provider would put a third party's latency (and outages)
    // on the registration path, for a message whose delivery we cannot guarantee
    // anyway. So: commit synchronously, deliver in the background, log failures.
    //
    // A failed send is recoverable from Settings ("resend"); a failed *insert* is
    // not, which is why only one of them can fail the request.
    sendVerificationMail(email.trim().toLowerCase(), token).catch((err) =>
        console.error("verification mail failed to send:", err.message),
    );

    return { pendingMask: encrypted.emailMask };
}
