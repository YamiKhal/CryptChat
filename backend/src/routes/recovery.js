import { Router } from 'express';
import argon2 from 'argon2';
import { pool } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../middleware/auth.js';
import { recoveryLimiter } from '../middleware/security.js';
import { emailIndex, decryptEmail, issueToken, hashToken, padTo } from '../lib/identityCrypto.js';
import { sendResetMail } from '../lib/mailer.js';
import { disconnectUser } from '../ws/relay.js';

/**
 * Password reset by mailbox control.
 *
 * Read this before changing anything here: a reset gets the user *back into the
 * account*. It does not, and cannot, decrypt their vault -- that is sealed under
 * the old password on a device this server has never touched. The recovery code
 * is the other half, and the client is required to walk the user through it
 * immediately after. See IDENTITY.md §2.
 */

const router = Router();

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

/**
 * Wall-clock floor for the request handler.
 *
 * A matched address does real work an unmatched one does not: decrypt the
 * address, hit the mail provider over the network. That difference is trivially
 * measurable and turns this endpoint into an oracle answering "does this person
 * have an account here" -- for a product whose entire pitch is that the server
 * does not know who you are, that is the worst possible leak. Both paths are
 * padded to the same floor, and the mail send is deliberately not awaited inside
 * the measured window.
 */
const RESPONSE_FLOOR_MS = 1200;

function validPassword(p) {
  return typeof p === 'string' && p.length >= 12 && p.length <= 1024;
}

const B64 = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Request a reset link.
 *
 * The response is identical in body, status, and timing whether or not the
 * address is attached to an account. There is no "no account with that email"
 * error, and there must never be one -- that message is the enumeration oracle.
 */
router.post('/request', recoveryLimiter, async (req, res, next) => {
  const startedAt = Date.now();

  // Everything that could distinguish the two paths is inside this try. An
  // unexpected failure must still produce the same answer at the same time, so
  // errors are logged rather than surfaced.
  try {
    const { email } = req.body ?? {};

    if (typeof email === 'string' && email.length >= 3 && email.length <= 254) {
      const result = await pool.query(
        `SELECT id, email_ct, email_dek FROM users
          WHERE email_hash = $1 AND email_verified_at IS NOT NULL`,
        [emailIndex(email)]
      );

      if (result.rowCount > 0) {
        const user = result.rows[0];
        const { token, tokenHash } = issueToken();

        // One live reset link at a time: every unexpired link is a standing
        // credential for the account.
        await pool.query(
          `DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset' AND consumed_at IS NULL`,
          [user.id]
        );
        await pool.query(
          `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
           VALUES ($1, $2, 'reset', now() + ($3 || ' minutes')::interval)`,
          [tokenHash, user.id, String(config.identity.resetTtlMinutes)]
        );

        // The one place in this codebase that turns stored ciphertext back into
        // an address, and it hands it straight to the mailer.
        const address = decryptEmail({ emailCt: user.email_ct, emailDek: user.email_dek });

        // Not awaited: provider latency varies by hundreds of milliseconds and
        // would show through the padding as a timing signal for "this address
        // exists". Failures are logged, never returned.
        sendResetMail(address, token).catch((err) =>
          console.error('reset mail failed to send:', err.message)
        );
      }
    }
  } catch (err) {
    console.error('reset request failed:', err);
  }

  await padTo(startedAt, RESPONSE_FLOOR_MS);

  // Always this. Never a hint either way.
  res.json({
    ok: true,
    message: 'If that address is attached to a verified account, a reset link is on its way.',
  });
});

/**
 * Consume a reset link and set a new password.
 *
 * The client supplies a fresh vault salt: the old local vault is unopenable
 * regardless (its key came from the old password), so keeping the salt would
 * imply a continuity that does not exist. The identity keys are NOT rotated --
 * they live in the recovery blob and must still match the public keys peers have
 * pinned, or every contact sees a key change and every channel breaks.
 */
router.post('/reset', recoveryLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { token, password, vaultSalt } = req.body ?? {};

    if (typeof token !== 'string' || token.length < 16) {
      return res.status(400).json({ error: 'invalid or expired link' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'password must be at least 12 characters' });
    }
    if (typeof vaultSalt !== 'string' || !B64.test(vaultSalt)) {
      return res.status(400).json({ error: 'vaultSalt required (base64url)' });
    }

    await client.query('BEGIN');

    // Claim atomically: a SELECT-then-UPDATE would let two concurrent clicks
    // both pass before either marked the token used.
    const claimed = await client.query(
      `UPDATE email_tokens SET consumed_at = now()
        WHERE token_hash = $1
          AND purpose = 'reset'
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING user_id`,
      [hashToken(token)]
    );

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid or expired link' });
    }

    const userId = claimed.rows[0].user_id;
    const pwHash = await argon2.hash(password, ARGON_OPTIONS);

    // token_epoch bump is what makes this a revocation rather than just a new
    // password: every session minted under the old one stops verifying.
    const updated = await client.query(
      `UPDATE users
          SET pw_hash = $2, vault_salt = $3, token_epoch = token_epoch + 1
        WHERE id = $1
        RETURNING pubkey, sign_pubkey, token_epoch`,
      [userId, pwHash, vaultSalt]
    );

    // A reset means "someone may have my password". Clear the lockout so the
    // legitimate user is not locked out by the attacker's failed guesses.
    await client.query(
      `DELETE FROM login_attempts WHERE username_hash = (SELECT username_hash FROM users WHERE id = $1)`,
      [userId]
    );

    await client.query('COMMIT');

    // The HTTP epoch check only gates new requests; sockets opened before the
    // reset stay subscribed until dropped.
    disconnectUser(userId);

    const user = updated.rows[0];
    res.json({
      token: signToken(userId, user.token_epoch),
      userId,
      pubkey: user.pubkey,
      signPubkey: user.sign_pubkey,
      vaultSalt,
      // The client must not stop here. Without the recovery code the account
      // comes back empty, and saying so is the difference between a recovery
      // flow and a data-loss bug the user discovers on their own.
      needsRecoveryCode: true,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
