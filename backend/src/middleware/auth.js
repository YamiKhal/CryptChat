import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db.js';

const ISSUER = 'CryptChat';

/**
 * `epoch` pins the token to a generation of the account's password.
 *
 * Tokens are stateless and live for TOKEN_TTL, so without a generation counter a
 * password reset does not evict anyone: an attacker with a live session keeps it
 * for the full TTL *after* the victim resets, which defeats the point of
 * resetting. Bumping users.token_epoch invalidates every token that does not
 * carry the new value.
 */
export function signToken(userId, epoch = 0) {
  return jwt.sign({ sub: userId, epoch }, config.jwtSecret, {
    expiresIn: config.tokenTtl,
    issuer: ISSUER,
    audience: ISSUER,
    algorithm: 'HS256',
  });
}

export function verifyToken(token) {
  // Pinning the algorithm blocks the `alg: none` and RS256->HS256 confusion
  // families; jsonwebtoken accepts whatever the token's own header claims
  // unless told otherwise.
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: ISSUER,
  });
}

/**
 * Confirm a verified token still belongs to the current password generation.
 *
 * One indexed primary-key lookup per authenticated request. That is a real cost
 * and it buys real revocation -- the alternative is caching, which reintroduces
 * a window where a revoked session still works, i.e. the exact bug being fixed.
 *
 * Tokens minted before this column existed have no `epoch` claim; they are
 * treated as generation 0, which matches the column default, so existing
 * sessions survive the deploy.
 */
export async function epochValid(claims) {
  const result = await pool.query('SELECT token_epoch FROM users WHERE id = $1', [claims.sub]);
  if (result.rowCount === 0) return false;
  return result.rows[0].token_epoch === (claims.epoch ?? 0);
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing token' });
  }

  let claims;
  try {
    claims = verifyToken(header.slice(7));
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }

  try {
    if (!(await epochValid(claims))) {
      // Distinct from 'invalid token' so the client knows to prompt for a
      // password rather than assume corruption.
      return res.status(401).json({ error: 'session expired' });
    }
  } catch (err) {
    return next(err);
  }

  req.userId = claims.sub;
  next();
}
