import { pool } from "../db.js";

/**
 * Tiers and what they actually gate.
 *
 * One source of truth for both the server checks and the /account/limits
 * response the client reads. Duplicating these numbers in the frontend would
 * guarantee they drift and a client that thinks the cap is 50MB while the
 * server enforces 20MB produces an upload that dies at 99%.
 */

export const TIERS = {
    free: {
        name: "free",
        maxFileBytes: 20 * 1024 * 1024,
        maxChars: 1000,
    },
    premium: {
        name: "premium",
        maxFileBytes: 50 * 1024 * 1024,
        maxChars: 4000,
    },
};

/**
 * Resolve a user's tier and permissions in one query.
 *
 * `canUpload` is the interesting one. Uploading is gated on a *verified email*
 * or an active subscription, because an open upload endpoint on anonymous
 * accounts is a free, unattributable file host -- and the one thing that makes
 * abuse actionable is some thread back to a person. A verified mailbox is that
 * thread; so is a payment.
 *
 * Premium without an email is allowed on purpose: they paid, which is its own
 * accountability and forcing an address on someone who bought the product
 * specifically to stay private would be incoherent.
 */
export async function entitlementsFor(userId) {
    const result = await pool.query(
        `SELECT
       u.email_verified_at IS NOT NULL AS email_verified,
       EXISTS (
         SELECT 1 FROM entitlements e
          WHERE e.user_id = u.id AND e.status = 'active' AND e.expires_at > now()
       ) AS premium
     FROM users u WHERE u.id = $1`,
        [userId],
    );

    if (result.rowCount === 0) {
        // No such user. Return the most restrictive answer rather than throwing:
        // callers are permission checks and a missing row must never read as
        // "allowed".
        return { tier: TIERS.free, emailVerified: false, premium: false, canUpload: false };
    }

    const row = result.rows[0];
    const premium = row.premium === true;
    const emailVerified = row.email_verified === true;

    return {
        tier: premium ? TIERS.premium : TIERS.free,
        emailVerified,
        premium,
        canUpload: emailVerified || premium,
    };
}

/**
 * Why an upload is refused, in words the UI can show verbatim.
 *
 * A bare 403 leaves the user staring at a disabled button with no idea that
 * confirming an email would fix it.
 */
export function uploadDenialReason(ent) {
    if (ent.canUpload) return null;
    return "Confirm your email address to send files. Add one in Settings. it is encrypted and never shown to anyone.";
}
