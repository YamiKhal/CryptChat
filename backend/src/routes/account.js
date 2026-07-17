import { Router } from 'express';
import argon2 from 'argon2';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { emailLimiter } from '../middleware/security.js';
import { hashToken } from '../lib/identityCrypto.js';
import { validEmail, startEmailVerification, EmailTakenError } from '../lib/emailVerification.js';
import { entitlementsFor, uploadDenialReason } from '../lib/entitlements.js';

/**
 * The account layer: recovery blobs and email.
 *
 * Nothing in here can read a message, a channel key, or a vault. The recovery
 * blob is opaque ciphertext to this process by construction; the email is the
 * one piece of user data the server can reverse, and only in the mail path.
 */

const router = Router();

/* ------------------------------------------------------------------ */
/* recovery blob                                                       */
/* ------------------------------------------------------------------ */

const B64 = /^[A-Za-z0-9_-]+$/;

// The blob holds an identity plus every channel key, so it grows with channel
// count. Generous, but not an unbounded free store keyed to an account.
const MAX_BLOB_BYTES = 256 * 1024;

function validBlob({ ciphertext, nonce, salt }) {
  return (
    typeof ciphertext === 'string' &&
    ciphertext.length > 0 &&
    ciphertext.length <= MAX_BLOB_BYTES &&
    B64.test(ciphertext) &&
    typeof nonce === 'string' &&
    B64.test(nonce) &&
    typeof salt === 'string' &&
    B64.test(salt)
  );
}

/**
 * Park the recovery blob.
 *
 * The server stores this without any means to open it: it is sealed under
 * Argon2id(256-bit recovery code), and the code is generated client-side, shown
 * once, and never transmitted. There is deliberately no verifier column -- see
 * schema.sql.
 *
 * Upsert rather than insert: the blob is rewritten whenever the channel set
 * changes, because a stale blob recovers an account missing its newest channels.
 */
router.put('/recovery-blob', requireAuth, async (req, res, next) => {
  try {
    const { ciphertext, nonce, salt } = req.body ?? {};
    if (!validBlob({ ciphertext, nonce, salt })) {
      return res.status(400).json({ error: 'ciphertext, nonce, salt required (base64url)' });
    }

    await pool.query(
      `INSERT INTO recovery_blobs (user_id, ciphertext, nonce, salt, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce,
         salt = EXCLUDED.salt,
         updated_at = now()`,
      [req.userId, ciphertext, nonce, salt]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Fetch the blob for the authenticated account.
 *
 * Requires a valid token, i.e. the password. That is not what protects the blob
 * -- the recovery code does -- but it keeps the endpoint from being a free
 * ciphertext-harvesting oracle for anyone who knows a user id.
 */
router.get('/recovery-blob', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT ciphertext, nonce, salt, updated_at FROM recovery_blobs WHERE user_id = $1',
      [req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'no recovery blob' });

    const row = result.rows[0];
    res.json({
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      salt: row.salt,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/recovery-blob', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM recovery_blobs WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * What this account is allowed to do.
 *
 * The client reads this rather than hardcoding tier numbers, so the two cannot
 * drift. Note `maxChars` is advisory: the relay only ever sees ciphertext and
 * cannot count characters, so the client enforces the limit for UX and the
 * server enforces bytes. See the comment on MAX_CHARS in the frontend.
 */
router.get('/limits', requireAuth, async (req, res, next) => {
  try {
    const ent = await entitlementsFor(req.userId);
    res.json({
      tier: ent.tier.name,
      premium: ent.premium,
      emailVerified: ent.emailVerified,
      canUpload: ent.canUpload,
      uploadDenialReason: uploadDenialReason(ent),
      maxFileBytes: ent.tier.maxFileBytes,
      maxChars: ent.tier.maxChars,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* email                                                               */
/* ------------------------------------------------------------------ */

/** What the client is allowed to know about its own address. */
router.get('/email', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT email_mask, email_verified_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });

    const row = result.rows[0];
    const pending = await pool.query(
      `SELECT email_mask FROM email_tokens
        WHERE user_id = $1 AND purpose = 'verify' AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [req.userId]
    );

    // Never the address. The mask is precomputed at write time precisely so this
    // handler does not need a decrypt key in scope.
    res.json({
      mask: row.email_mask,
      verified: row.email_verified_at !== null,
      pendingMask: pending.rowCount ? pending.rows[0].email_mask : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Attach or change an address. Requires the password again.
 *
 * Re-auth because a hijacked session that can swap the recovery address owns the
 * account permanently: the attacker points the mailbox at themselves, then uses
 * the reset flow at leisure. This is the same reason every other product asks
 * for your password before touching your email.
 *
 * The address is NOT written to `users` here. It rides in the token row until
 * the link is clicked, so a typo'd stranger's address does not sit on your
 * account claiming to be yours.
 */
router.post('/email', requireAuth, emailLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    if (!validEmail(email)) return res.status(400).json({ error: 'that does not look like an email address' });
    if (typeof password !== 'string') return res.status(401).json({ error: 'password required' });

    const user = await pool.query('SELECT pw_hash FROM users WHERE id = $1', [req.userId]);
    if (user.rowCount === 0) return res.status(404).json({ error: 'not found' });

    const valid = await argon2.verify(user.rows[0].pw_hash, password).catch(() => false);
    if (!valid) return res.status(401).json({ error: 'wrong password' });

    const { pendingMask } = await startEmailVerification(req.userId, email);
    res.json({ ok: true, pendingMask });
  } catch (err) {
    if (err instanceof EmailTakenError) return res.status(409).json({ error: err.message });
    next(err);
  }
});

/**
 * Consume a verification link.
 *
 * Unauthenticated: the user clicking the link may be in a different browser than
 * the one holding the session, and forcing a login here would strand them. The
 * token is the credential -- 256 bits, single-use, short-lived.
 */
router.post('/email/verify', emailLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { token } = req.body ?? {};
    if (typeof token !== 'string' || token.length < 16) {
      return res.status(400).json({ error: 'invalid or expired link' });
    }

    await client.query('BEGIN');

    // Consume and check in one atomic step. A SELECT-then-UPDATE would let two
    // concurrent clicks both pass the check before either marked it used.
    const claimed = await client.query(
      `UPDATE email_tokens SET consumed_at = now()
        WHERE token_hash = $1
          AND purpose = 'verify'
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING user_id, email_ct, email_dek, email_hash, email_mask`,
      [hashToken(token)]
    );

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid or expired link' });
    }

    const row = claimed.rows[0];

    await client.query(
      `UPDATE users SET
         email_ct = $2, email_dek = $3, email_hash = $4, email_mask = $5,
         email_verified_at = now()
       WHERE id = $1`,
      [row.user_id, row.email_ct, row.email_dek, row.email_hash, row.email_mask]
    );

    await client.query('COMMIT');
    res.json({ ok: true, mask: row.email_mask });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The partial unique index fires here if the address got attached elsewhere
    // between request and click.
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'that address is already attached to an account' });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Detach the address.
 *
 * Password-gated for the same reason as attaching. Wipes the ciphertext and the
 * index rather than just clearing the verified flag: "remove my email" has to
 * mean the bytes are gone, or the word is a lie.
 */
router.delete('/email', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body ?? {};
    if (typeof password !== 'string') return res.status(401).json({ error: 'password required' });

    const user = await pool.query('SELECT pw_hash FROM users WHERE id = $1', [req.userId]);
    if (user.rowCount === 0) return res.status(404).json({ error: 'not found' });

    const valid = await argon2.verify(user.rows[0].pw_hash, password).catch(() => false);
    if (!valid) return res.status(401).json({ error: 'wrong password' });

    await pool.query(
      `UPDATE users SET
         email_ct = NULL, email_dek = NULL, email_hash = NULL,
         email_mask = NULL, email_verified_at = NULL
       WHERE id = $1`,
      [req.userId]
    );
    await pool.query(`DELETE FROM email_tokens WHERE user_id = $1`, [req.userId]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
export { MAX_BLOB_BYTES };
