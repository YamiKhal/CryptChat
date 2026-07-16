import dotenv from 'dotenv';

dotenv.config();

function required(name, { min } = {}) {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: ${name} is not set. Refusing to start.`);
    process.exit(1);
  }
  if (min && value.length < min) {
    console.error(`FATAL: ${name} must be at least ${min} characters. Refusing to start.`);
    process.exit(1);
  }
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

// A short or placeholder JWT secret forges every session, so this is a boot
// failure rather than a warning. Previously an unset secret let the process
// start and threw per-request inside jwt.sign.
const JWT_SECRET = required('JWT_SECRET', { min: 32 });

if (JWT_SECRET === 'change_this_to_a_long_random_string') {
  console.error('FATAL: JWT_SECRET is still the example value. Refusing to start.');
  process.exit(1);
}

const corsOrigin = process.env.CORS_ORIGIN || (isProd ? '' : 'http://localhost:5173');

if (isProd && (!corsOrigin || corsOrigin === '*')) {
  console.error('FATAL: CORS_ORIGIN must be an explicit origin in production, not "*" or empty.');
  process.exit(1);
}

export const config = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: JWT_SECRET,

  // Exact-match allowlist. Also gates the WebSocket handshake, which closes the
  // cross-site WebSocket hijacking hole: browsers do not apply the same-origin
  // policy to WebSockets, so any page could otherwise open an authenticated
  // socket with the user's token.
  allowedOrigins: corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),

  tokenTtl: process.env.TOKEN_TTL || '7d',

  // Channel join codes are bearer credentials. They expire.
  channelCodeTtlHours: Number(process.env.CHANNEL_CODE_TTL_HOURS) || 24,

  // Queue rows are undelivered mail, not archive. Dropped after this window.
  queueTtlHours: Number(process.env.QUEUE_TTL_HOURS) || 72,

  limits: {
    // A message envelope is ciphertext of body + display name + signature.
    // Generous enough for a resized avatar, tight enough that the queue is not
    // a free object store.
    maxEnvelopeBytes: Number(process.env.MAX_ENVELOPE_BYTES) || 256 * 1024,
    maxJsonBytes: '512kb',
    maxQueuePerRecipient: Number(process.env.MAX_QUEUE_PER_RECIPIENT) || 5000,
  },

  auth: {
    maxFailures: 8,
    lockoutMinutes: 15,
  },
};
