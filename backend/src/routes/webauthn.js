import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { apiLimiter } from '../middleware/security.js';
import {
  registrationOptions,
  verifyRegistration,
  issueChallengeToken,
  readChallengeToken,
} from '../lib/webauthn.js';

/**
 * WebAuthn enrollment and management (ROADMAP #5). Mounted at /account/2fa.
 *
 * All of this is behind requireAuth: enrolling a second factor is something an
 * already-authenticated session does. The login-time authentication ceremony
 * lives in routes/auth.js, since it is part of the login flow, not account
 * management.
 */

const router = Router();

router.post('/register/options', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const existing = (
      await pool.query('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [
        req.userId,
      ])
    ).rows;

    const options = await registrationOptions(req.userId, existing);
    const challengeToken = issueChallengeToken(options.challenge, {
      userId: req.userId,
      purpose: 'register',
    });

    res.json({ options, challengeToken });
  } catch (err) {
    next(err);
  }
});

router.post('/register/verify', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const { response, challengeToken, label } = req.body ?? {};

    let claims;
    try {
      claims = readChallengeToken(challengeToken, 'register');
    } catch {
      return res.status(400).json({ error: 'enrollment expired, start again' });
    }
    // The challenge was issued to this session; a token minted for another user
    // must not enroll a key here.
    if (claims.sub !== req.userId) return res.status(400).json({ error: 'challenge mismatch' });

    let verification;
    try {
      verification = await verifyRegistration(response, claims.challenge);
    } catch {
      return res.status(400).json({ error: 'could not verify authenticator' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'authenticator not verified' });
    }

    const { credential } = verification.registrationInfo;
    const cleanLabel =
      typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : 'Security key';

    await pool.query(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        credential.id,
        req.userId,
        Buffer.from(credential.publicKey),
        credential.counter ?? 0,
        credential.transports ? JSON.stringify(credential.transports) : null,
        cleanLabel,
      ]
    );

    res.json({ ok: true, credential: { id: credential.id, label: cleanLabel } });
  } catch (err) {
    next(err);
  }
});

router.get('/', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const rows = (
      await pool.query(
        `SELECT id, label, created_at, last_used_at
           FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
        [req.userId]
      )
    ).rows;

    res.json({
      enabled: rows.length > 0,
      credentials: rows.map((credential) => ({
        id: credential.id,
        label: credential.label,
        createdAt: credential.created_at,
        lastUsedAt: credential.last_used_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    // Scoped to the caller's own credentials -- a user can only remove their own.
    await pool.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
