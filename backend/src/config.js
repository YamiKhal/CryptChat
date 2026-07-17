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
    // Generous enough for a resized avatar, an attachment pointer, and a link
    // preview thumbnail, tight enough that the queue is not a free object
    // store. File bytes never travel in here -- they go to the blob store and
    // the envelope carries only a pointer plus its key.
    maxEnvelopeBytes: Number(process.env.MAX_ENVELOPE_BYTES) || 256 * 1024,
    maxJsonBytes: '512kb',
    maxQueuePerRecipient: Number(process.env.MAX_QUEUE_PER_RECIPIENT) || 5000,
  },

  auth: {
    maxFailures: 8,
    lockoutMinutes: 15,
  },

  blob: {
    // Where ciphertext lands. In Coolify this is a persistent storage mount
    // backed by a Hetzner Volume -- deliberately a different disk from
    // Postgres, so a full blob volume fails uploads instead of wedging the
    // database and taking the whole app down.
    dir: process.env.BLOB_DIR || './data/blobs',

    maxFileBytes: Number(process.env.MAX_FILE_BYTES) || 50 * 1024 * 1024,

    // Plaintext bytes per secretstream chunk. 1MB keeps a 50MB upload at 50
    // requests; 64KB would be 800 and would trip rate limits for nothing. It
    // also keeps every HTTP body small enough to slip under proxy body caps
    // (Cloudflare's free tier rejects a single body over 100MB).
    chunkBytes: Number(process.env.BLOB_CHUNK_BYTES) || 1024 * 1024,

    // crypto_secretstream ABYTES: each chunk carries a 17-byte auth tag.
    chunkOverheadBytes: 17,

    // Files outlive the message queue (72h). Someone offline for a long
    // weekend should still get the file.
    ttlDays: Number(process.env.BLOB_TTL_DAYS) || 30,

    // Total stored ciphertext per user. Without this the blob store is a free
    // anonymous file host.
    quotaPerUserBytes: Number(process.env.BLOB_QUOTA_PER_USER_BYTES) || 2 * 1024 * 1024 * 1024,

    // An upload that never calls /finish is abandoned; reap it.
    pendingTtlHours: Number(process.env.BLOB_PENDING_TTL_HOURS) || 24,
  },

  unfurl: {
    // Link previews are opt-in per message ("!" prefix) or per user. The
    // relay learns any URL it is asked to preview -- that is the whole cost of
    // the feature, and why it is never automatic.
    enabled: process.env.UNFURL_ENABLED !== 'false',
    timeoutMs: Number(process.env.UNFURL_TIMEOUT_MS) || 5000,
    maxHtmlBytes: Number(process.env.UNFURL_MAX_HTML_BYTES) || 512 * 1024,
    maxImageBytes: Number(process.env.UNFURL_MAX_IMAGE_BYTES) || 2 * 1024 * 1024,
    maxRedirects: 3,
  },
};
