import { Router } from 'express';
import argon2 from 'argon2';
import crypto from 'crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { authLimiter, registerLimiter } from '../middleware/security.js';

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
  if (!DUMMY_HASH) DUMMY_HASH = await argon2.hash(crypto.randomBytes(32).toString('hex'), ARGON_OPTIONS);
  return DUMMY_HASH;
}

function hashUsername(username) {
  return crypto.createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
}

const B64 = /^[A-Za-z0-9_-]{16,128}$/;

function validKeyMaterial(...keys) {
  return keys.every((k) => typeof k === 'string' && B64.test(k));
}

function validUsername(u) {
  return typeof u === 'string' && u.trim().length >= 3 && u.trim().length <= 64;
}

function validPassword(p) {
  // Length is the only rule that reliably buys entropy. Composition rules push
  // users toward predictable substitutions.
  return typeof p === 'string' && p.length >= 12 && p.length <= 1024;
}

async function checkLockout(usernameHash) {
  const row = await pool.query(
    'SELECT failures, locked_until FROM login_attempts WHERE username_hash = $1',
    [usernameHash]
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
    [usernameHash, config.auth.maxFailures, String(config.auth.lockoutMinutes)]
  );
}

async function clearFailures(usernameHash) {
  await pool.query('DELETE FROM login_attempts WHERE username_hash = $1', [usernameHash]);
}

// body: { username, password, pubkey, signPubkey, vaultSalt }
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { username, password, pubkey, signPubkey, vaultSalt } = req.body ?? {};

    if (!validUsername(username)) {
      return res.status(400).json({ error: 'username must be 3-64 characters' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'password must be at least 12 characters' });
    }
    if (!validKeyMaterial(pubkey, signPubkey, vaultSalt)) {
      return res.status(400).json({ error: 'pubkey, signPubkey, vaultSalt required (base64url)' });
    }

    const usernameHash = hashUsername(username);
    const pwHash = await argon2.hash(password, ARGON_OPTIONS);

    const result = await pool.query(
      `INSERT INTO users (username_hash, pw_hash, pubkey, sign_pubkey, vault_salt)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username_hash) DO NOTHING
       RETURNING id`,
      [usernameHash, pwHash, pubkey, signPubkey, vaultSalt]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'username taken' });
    }

    const userId = result.rows[0].id;
    res.json({ token: signToken(userId), userId, pubkey, signPubkey, vaultSalt });
  } catch (err) {
    next(err);
  }
});

// body: { username, password }
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (!validUsername(username) || typeof password !== 'string') {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const usernameHash = hashUsername(username);

    const lockedFor = await checkLockout(usernameHash);
    if (lockedFor !== null) {
      return res.status(429).json({ error: 'account temporarily locked', retryAfter: lockedFor });
    }

    const result = await pool.query(
      'SELECT id, pw_hash, pubkey, sign_pubkey, vault_salt FROM users WHERE username_hash = $1',
      [usernameHash]
    );

    if (result.rowCount === 0) {
      await argon2.verify(await dummyHash(), password).catch(() => false);
      await recordFailure(usernameHash);
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await argon2.verify(user.pw_hash, password).catch(() => false);
    if (!valid) {
      await recordFailure(usernameHash);
      return res.status(401).json({ error: 'invalid credentials' });
    }

    await clearFailures(usernameHash);

    // The client needs its own salt and public keys to rebuild session state.
    // The private half never touched this server and cannot be recovered here:
    // a new device gets its keys from the Settings export, not from login.
    res.json({
      token: signToken(user.id),
      userId: user.id,
      pubkey: user.pubkey,
      signPubkey: user.sign_pubkey,
      vaultSalt: user.vault_salt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, pubkey, sign_pubkey, vault_salt FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const u = result.rows[0];
    res.json({ userId: u.id, pubkey: u.pubkey, signPubkey: u.sign_pubkey, vaultSalt: u.vault_salt });
  } catch (err) {
    next(err);
  }
});

export default router;
