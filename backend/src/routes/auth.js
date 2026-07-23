import { Router } from "express";
import argon2 from "argon2";
import crypto from "crypto";
import { pool } from "../db.js";
import { config } from "../config.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { authLimiter, registerLimiter } from "../middleware/security.js";
import { usernameIndex, legacyUsernameHash, emailIndex } from "../lib/identityCrypto.js";
import { validEmail, startEmailVerification } from "../lib/emailVerification.js";
import { badgeFor } from "./billing.js";
import {
    authenticationOptions,
    verifyAuthentication,
    issueChallengeToken,
    readChallengeToken,
} from "../lib/webauthn.js";

const router = Router();

const ARGON_OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 64 * 1024,
    timeCost: 3,
    parallelism: 1,
};

// A dummy verifier to burn against when the username does not exist, so a miss
// costs the same wall-clock time as a wrong password. Without it, response
// latency alone enumerates registered usernames.
let DUMMY_HASH = null;
async function dummyHash() {
    if (!DUMMY_HASH)
        DUMMY_HASH = await argon2.hash(crypto.randomBytes(32).toString("hex"), ARGON_OPTIONS);
    return DUMMY_HASH;
}

/**
 * Look up a user by username, tolerating both hash generations.
 *
 * `username_hash` used to be a bare sha256. Usernames are low-entropy, so that
 * column let anyone holding a database dump rainbow-table the entire user list
 * and confirm whether a specific person had an account -- for a product that
 * advertises that the server never learns your name, that was the name, sitting
 * in a column, reversible offline.
 *
 * It is now an HMAC under a pepper that lives in the environment rather than the
 * database, so a dump alone has nothing to test against. Existing rows cannot be
 * rewritten in a migration (the pepper needs the plaintext username, which the
 * server does not have and never had), so they are converted lazily: the only
 * moment the server ever sees a plaintext username is a login and that is when
 * the row gets rewritten. `username_hash_legacy` marks who is still pending.
 */
async function findUser(username, columns) {
    const hmac = usernameIndex(username);

    const byHmac = await pool.query(
        `SELECT ${columns}, username_hash_legacy FROM users WHERE username_hash = $1`,
        [hmac],
    );
    if (byHmac.rowCount > 0) return { row: byHmac.rows[0], hash: hmac, legacy: false };

    const legacy = await pool.query(
        `SELECT ${columns}, username_hash_legacy FROM users WHERE username_hash = $1 AND username_hash_legacy = TRUE`,
        [legacyUsernameHash(username)],
    );
    if (legacy.rowCount > 0) {
        return { row: legacy.rows[0], hash: legacyUsernameHash(username), legacy: true };
    }

    return null;
}

/**
 * Upgrade a legacy row to the HMAC index. Called only after the password checks
 * out, because until then we have no business believing the username.
 */
async function upgradeUsernameHash(userId, username) {
    try {
        await pool.query(
            `UPDATE users SET username_hash = $2, username_hash_legacy = FALSE WHERE id = $1`,
            [userId, usernameIndex(username)],
        );
    } catch (err) {
        // A unique-violation here means something is genuinely wrong (two rows
        // claiming one username), but the user's login already succeeded and
        // failing it now would be worse than staying on the legacy hash.
        console.error("username hash upgrade failed:", err.message);
    }
}

const B64 = /^[A-Za-z0-9_-]{16,128}$/;

function validKeyMaterial(...keys) {
    return keys.every((k) => typeof k === "string" && B64.test(k));
}

function validUsername(u) {
    return typeof u === "string" && u.trim().length >= 3 && u.trim().length <= 64;
}

function validPassword(p) {
    // Length is the only rule that reliably buys entropy. Composition rules push
    // users toward predictable substitutions.
    return typeof p === "string" && p.length >= 12 && p.length <= 1024;
}

async function checkLockout(usernameHash) {
    const row = await pool.query(
        "SELECT failures, locked_until FROM login_attempts WHERE username_hash = $1",
        [usernameHash],
    );
    if (row.rowCount === 0) return null;
    const { locked_until: lockedUntil } = row.rows[0];
    if (lockedUntil && new Date(lockedUntil) > new Date()) {
        return Math.ceil((new Date(lockedUntil) - new Date()) / 1000);
    }
    return null;
}

async function recordFailure(usernameHash) {
    await pool.query(
        `INSERT INTO login_attempts (username_hash, failures, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (username_hash) DO UPDATE SET
       failures = login_attempts.failures + 1,
       updated_at = now(),
       locked_until = CASE
         WHEN login_attempts.failures + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
         ELSE login_attempts.locked_until
       END`,
        [usernameHash, config.auth.maxFailures, String(config.auth.lockoutMinutes)],
    );
}

async function clearFailures(usernameHash) {
    await pool.query("DELETE FROM login_attempts WHERE username_hash = $1", [usernameHash]);
}

// body: { username, password, pubkey, signPubkey, vaultSalt, email? }
router.post("/register", registerLimiter, async (req, res, next) => {
    try {
        const { username, password, pubkey, signPubkey, vaultSalt, email } = req.body ?? {};

        if (!validUsername(username)) {
            return res.status(400).json({ error: "username must be 3-64 characters" });
        }
        if (!validPassword(password)) {
            return res.status(400).json({ error: "password must be at least 12 characters" });
        }
        if (!validKeyMaterial(pubkey, signPubkey, vaultSalt)) {
            return res
                .status(400)
                .json({ error: "pubkey, signPubkey, vaultSalt required (base64url)" });
        }

        // Optional and it stays optional. An account with no address is a
        // first-class account -- it simply cannot be recovered by mail.
        const wantsEmail = email !== undefined && email !== null && email !== "";
        if (wantsEmail && !validEmail(email)) {
            return res.status(400).json({ error: "that does not look like an email address" });
        }

        const usernameHash = usernameIndex(username);

        // Registering with a username whose legacy row exists must not create a
        // duplicate: the unique index is on the column and the two generations
        // hash differently, so the ON CONFLICT below would not fire.
        const existing = await findUser(username, "id");
        if (existing) return res.status(409).json({ error: "username taken" });

        // Checked BEFORE the account is created, not after. Attaching the address is
        // a second step, so a clash discovered later would leave a real account
        // sitting there with no email and no error -- the user would be told nothing
        // and never receive a link.
        if (wantsEmail) {
            const taken = await pool.query("SELECT 1 FROM users WHERE email_hash = $1", [
                emailIndex(email),
            ]);
            if (taken.rowCount > 0) {
                return res
                    .status(409)
                    .json({ error: "that address is already attached to an account" });
            }
        }

        const pwHash = await argon2.hash(password, ARGON_OPTIONS);

        const result = await pool.query(
            `INSERT INTO users (username_hash, pw_hash, pubkey, sign_pubkey, vault_salt, username_hash_legacy)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (username_hash) DO NOTHING
       RETURNING id, token_epoch`,
            [usernameHash, pwHash, pubkey, signPubkey, vaultSalt],
        );

        if (result.rowCount === 0) {
            return res.status(409).json({ error: "username taken" });
        }

        const userId = result.rows[0].id;

        // Awaited, so the pending state is readable the instant this returns -- a
        // client that fetches its own email state right after registering must not
        // be told there is nothing pending. The mail *send* inside is still
        // fire-and-forget, so a provider outage cannot fail a registration.
        if (wantsEmail) {
            await startEmailVerification(userId, email).catch((err) =>
                console.error("starting email verification failed:", err.message),
            );
        }

        res.json({
            token: signToken(userId, result.rows[0].token_epoch),
            userId,
            pubkey,
            signPubkey,
            vaultSalt,
            emailPending: wantsEmail,
        });
    } catch (err) {
        next(err);
    }
});

// body: { username, password }
router.post("/login", authLimiter, async (req, res, next) => {
    try {
        const { username, password } = req.body ?? {};
        if (!validUsername(username) || typeof password !== "string") {
            return res.status(401).json({ error: "invalid credentials" });
        }

        // Lockout is keyed on the HMAC regardless of which generation the row is on,
        // so a legacy account's failures and its post-upgrade failures land in the
        // same bucket rather than giving an attacker two budgets.
        const lockoutKey = usernameIndex(username);

        const lockedFor = await checkLockout(lockoutKey);
        if (lockedFor !== null) {
            return res
                .status(429)
                .json({ error: "account temporarily locked", retryAfter: lockedFor });
        }

        const found = await findUser(
            username,
            "id, pw_hash, pubkey, sign_pubkey, vault_salt, token_epoch",
        );

        if (!found) {
            await argon2.verify(await dummyHash(), password).catch(() => false);
            await recordFailure(lockoutKey);
            return res.status(401).json({ error: "invalid credentials" });
        }

        const user = found.row;
        const valid = await argon2.verify(user.pw_hash, password).catch(() => false);
        if (!valid) {
            await recordFailure(lockoutKey);
            return res.status(401).json({ error: "invalid credentials" });
        }

        await clearFailures(lockoutKey);

        // A correct password is the only proof that this username belongs to this
        // row and therefore the only safe moment to rewrite its index.
        if (found.legacy) await upgradeUsernameHash(user.id, username);

        // Second factor, if the account enrolled one. A correct password is no
        // longer sufficient on its own: we withhold the session token and hand back
        // an authentication challenge instead. See POST /login/2fa.
        const creds = (
            await pool.query("SELECT id, transports FROM webauthn_credentials WHERE user_id = $1", [
                user.id,
            ])
        ).rows;
        if (creds.length > 0) {
            const options = await authenticationOptions(creds);
            const challengeToken = issueChallengeToken(options.challenge, {
                userId: user.id,
                purpose: "login",
            });
            return res.json({ twoFactorRequired: true, challengeToken, options });
        }

        // The client needs its own salt and public keys to rebuild session state.
        // The private half never touched this server and cannot be recovered here:
        // a new device gets its keys from a key file export or the recovery blob,
        // not from login.
        res.json({
            token: signToken(user.id, user.token_epoch),
            userId: user.id,
            pubkey: user.pubkey,
            signPubkey: user.sign_pubkey,
            vaultSalt: user.vault_salt,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Complete a login that required a second factor.
 *
 * The challenge token carries the userId and the challenge we issued; it is
 * short-lived and audience-scoped so it can never stand in for a session. A
 * valid assertion against one of the user's enrolled credentials mints the real
 * session token -- the same shape /login would have returned outright.
 */
router.post("/login/2fa", authLimiter, async (req, res, next) => {
    try {
        const { challengeToken, response } = req.body ?? {};

        let claims;
        try {
            claims = readChallengeToken(challengeToken, "login");
        } catch {
            return res.status(401).json({ error: "login challenge expired, start again" });
        }

        const credId = response?.id;
        if (typeof credId !== "string")
            return res.status(400).json({ error: "malformed response" });

        const credRow = (
            await pool.query(
                "SELECT id, public_key, counter, transports FROM webauthn_credentials WHERE id = $1 AND user_id = $2",
                [credId, claims.sub],
            )
        ).rows[0];
        if (!credRow) return res.status(401).json({ error: "unknown authenticator" });

        let verification;
        try {
            verification = await verifyAuthentication(response, claims.challenge, credRow);
        } catch {
            return res.status(401).json({ error: "authentication failed" });
        }
        if (!verification.verified) return res.status(401).json({ error: "authentication failed" });

        // Advance the signature counter (clone detection) and record use.
        await pool.query(
            "UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2",
            [verification.authenticationInfo.newCounter, credId],
        );

        const user = (
            await pool.query(
                "SELECT id, pubkey, sign_pubkey, vault_salt, token_epoch FROM users WHERE id = $1",
                [claims.sub],
            )
        ).rows[0];
        if (!user) return res.status(401).json({ error: "authentication failed" });

        res.json({
            token: signToken(user.id, user.token_epoch),
            userId: user.id,
            pubkey: user.pubkey,
            signPubkey: user.sign_pubkey,
            vaultSalt: user.vault_salt,
        });
    } catch (err) {
        next(err);
    }
});

router.get("/me", requireAuth, async (req, res, next) => {
    try {
        const result = await pool.query(
            `SELECT id, pubkey, sign_pubkey, vault_salt, email_mask, email_verified_at
         FROM users WHERE id = $1`,
            [req.userId],
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "not found" });

        const u = result.rows[0];
        const badge = await badgeFor(req.userId);

        res.json({
            userId: u.id,
            pubkey: u.pubkey,
            signPubkey: u.sign_pubkey,
            vaultSalt: u.vault_salt,
            // The mask, never the address.
            email: u.email_mask
                ? { mask: u.email_mask, verified: u.email_verified_at !== null }
                : null,
            badge,
        });
    } catch (err) {
        next(err);
    }
});

export default router;
