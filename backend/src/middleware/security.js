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
    // PUT is required for blob chunk uploads. The allowlist is still explicit
    // rather than open -- it is the origin check above that does the real work.
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Chunk-Index'],
  };
}

/**
 * Wrap every limiter so the test suite can turn them off.
 *
 * `config.rateLimitsEnabled` is false only outside production -- config.js
 * refuses to boot production with the flag set, because these are a real
 * security control and losing them silently would be worse than any test
 * convenience they buy.
 */
function limiter(options) {
  if (!config.rateLimitsEnabled) return (req, res, next) => next();
  return rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, ...options });
}

// Password verification is deliberately expensive (Argon2id), so an unthrottled
// /auth/login is also a CPU exhaustion vector, not just a guessing oracle.
export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'too many attempts, try again later' },
});

export const registerLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'too many registrations from this address' },
});

// Join is a code-guessing oracle: 8 chars over a 32-symbol alphabet is ~40 bits,
// which is only out of reach if guessing stays slow.
export const joinLimiter = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: { error: 'too many join attempts' },
});

export const apiLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
});

// Every request here sends mail to an address the caller typed. Unthrottled,
// that is a free spam cannon pointed at arbitrary mailboxes with our domain on
// the From line -- which costs us the sending reputation the recovery flow
// depends on.
export const emailLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'too many email requests, try again later' },
});

// Tighter than authLimiter. This endpoint answers a question about whether an
// address has an account; the response is padded and identical either way, but
// rate limiting is what stops someone grinding a list of addresses through it
// regardless.
export const recoveryLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 6,
  message: { error: 'too many recovery attempts, try again later' },
});

// The redemption code is ~100 bits, so guessing is not the threat this stops --
// it is here to keep a redeem loop from being a cheap way to probe the table.
export const billingLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'too many attempts, try again later' },
});
