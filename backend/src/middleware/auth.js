import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const ISSUER = 'CryptChat';

export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
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

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing token' });
  }
  try {
    req.userId = verifyToken(header.slice(7)).sub;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
