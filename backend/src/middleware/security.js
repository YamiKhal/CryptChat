import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export function securityHeaders() {
  return helmet({
    // The API serves JSON only; it never renders HTML. A deny-everything CSP
    // costs nothing here and neuters any reflected-content mistake.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
}

export function corsOptions() {
  return {
    origin(origin, callback) {
      // No Origin header: curl, server-to-server, same-origin navigation.
      // Browsers always send one for cross-origin requests, which is the case
      // this allowlist exists to stop.
      if (!origin) return callback(null, true);
      if (config.allowedOrigins.includes('*') && !config.isProd) return callback(null, true);
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('origin not allowed'));
    },
    credentials: false,
    methods: ['GET', 'POST', 'DELETE'],
  };
}

// Password verification is deliberately expensive (Argon2id), so an unthrottled
// /auth/login is also a CPU exhaustion vector, not just a guessing oracle.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many registrations from this address' },
});

// Join is a code-guessing oracle: 8 chars over a 32-symbol alphabet is ~40 bits,
// which is only out of reach if guessing stays slow.
export const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many join attempts' },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
