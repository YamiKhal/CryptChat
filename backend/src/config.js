import dotenv from 'dotenv';
import crypto from 'crypto';

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

/**
 * A 32-byte key or pepper for the account layer.
 *
 * In production these must be set explicitly and independently: they protect
 * different things (a reversible address, a search index, a payment code) and
 * sharing one key across them means one leak is three leaks.
 *
 * In development they are derived from JWT_SECRET via HKDF with a per-use label,
 * so `npm run dev` needs no extra setup and each derived key is still
 * independent of the others. This is a dev-only affordance -- deriving key
 * material from the session-signing secret in production would tie the blast
 * radius of a JWT_SECRET leak to the email store, so it is a boot failure there.
 */
function secretKey(name, label) {
  const configured = process.env[name];

  if (configured) {
    const raw = Buffer.from(configured, 'base64');
    if (raw.length !== 32) {
      console.error(
        `FATAL: ${name} must be exactly 32 bytes, base64-encoded (got ${raw.length}). Generate one with:\n` +
          `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
      );
      process.exit(1);
    }
    return raw;
  }

  if (isProd) {
    console.error(
      `FATAL: ${name} is not set. Refusing to start.\n` +
        `  It protects stored account data and must not be derived from JWT_SECRET in production.\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
    process.exit(1);
  }

  return Buffer.from(crypto.hkdfSync('sha256', JWT_SECRET, '', `cryptchat-dev-${label}`, 32));
}

// A reset link that points at the wrong origin mails users to an attacker's
// host, so this is explicit in production rather than inferred from a header.
const publicAppUrl = (
  process.env.PUBLIC_APP_URL || (isProd ? '' : 'http://localhost:5173')
).replace(/\/$/, '');

if (isProd && !publicAppUrl) {
  console.error('FATAL: PUBLIC_APP_URL must be set in production. It builds the links in outbound mail.');
  process.exit(1);
}

// WebAuthn (ROADMAP #5). The RP ID must be a registrable suffix of the origin
// the ceremony runs on -- i.e. the *frontend's* host, since that is the page
// calling navigator.credentials. Both default off the public app URL and can be
// overridden for deployments where the API and app hosts differ.
let derivedRpId = 'localhost';
try {
  derivedRpId = new URL(publicAppUrl).hostname;
} catch {
  // publicAppUrl empty/invalid in some dev setups; the default stands.
}
const webauthnRpId = process.env.WEBAUTHN_RP_ID || derivedRpId;
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || publicAppUrl || 'http://localhost:5173';

// Mail is what makes recovery and verification real. Without a provider the
// mailer logs to the console, which is fine locally and a silent hole in prod.
const mailApiKey = process.env.MAIL_API_KEY || '';
const mailFrom = process.env.MAIL_FROM || '';

if (isProd && (!mailApiKey || !mailFrom)) {
  console.error(
    'FATAL: MAIL_API_KEY and MAIL_FROM must be set in production, or verification and password reset mail silently goes nowhere.'
  );
  process.exit(1);
}

/**
 * A configured key with a placeholder MAIL_FROM is the failure mode to catch.
 *
 * `.env.example` ships `noreply@yourdomain.example`. Copy the file, paste a real
 * API key, forget the From line, and every send fails 403 at the provider --
 * hours after boot, inside a background mail send nobody is watching, on a
 * registration that already returned 200. Fail here instead, where the cause is
 * still in front of you.
 */
if (mailApiKey && /yourdomain\.example|example\.com>?$|@localhost/i.test(mailFrom)) {
  console.error(
    `FATAL: MAIL_API_KEY is set but MAIL_FROM is still a placeholder (${mailFrom}).\n` +
      '  Providers reject any From address at a domain you have not verified, so every\n' +
      '  verification and password-reset mail would fail with a 403 nobody sees.\n' +
      '  Set MAIL_FROM to an address at the domain you verified, e.g. CryptChat <noreply@yourdomain.com>'
  );
  process.exit(1);
}

// WebRTC 1:1 calls (DMs). Media is peer-to-peer and DTLS-SRTP encrypted; the
// server never sees it. These only configure ICE -- how the two peers find a
// path to each other.
//
//   STUN  -- public-IP discovery. Cheap, and self-hosted (coturn) so no third
//            party learns the caller's address.
//   TURN  -- relays SRTP when direct P2P fails on a strict NAT (~10-20% of
//            calls). The relay carries only ciphertext it cannot read, but it
//            costs bandwidth, so it runs on the same coturn.
//
// TURN credentials are NOT static here. /rtc/ice mints short-lived ones with
// coturn's use-auth-secret (HMAC) scheme, so a leaked credential expires in an
// hour rather than granting relay access forever. TURN_SECRET must match
// coturn's `static-auth-secret`.
//
// All optional: with none set, calls still connect on the same LAN / open NATs,
// and the UI says so. See docs/calls.md for the coturn-on-Coolify setup.
const turnUrl = process.env.TURN_URL || '';
const turnSecret = process.env.TURN_SECRET || '';

if (isProd && turnUrl && !turnSecret) {
  console.error(
    'FATAL: TURN_URL is set but TURN_SECRET is missing. /rtc/ice cannot mint\n' +
      '  credentials, so every call that needs relaying would fail. Set TURN_SECRET\n' +
      "  to coturn's static-auth-secret."
  );
  process.exit(1);
}

// Rate limits are a security control, not a nuisance: they are what keep
// /auth/login from being a cheap guessing oracle and an Argon2id CPU-exhaustion
// vector. The test suite needs them off (it registers dozens of accounts in
// seconds), so the switch exists -- and production refuses to boot with it,
// because an ops mistake here would be invisible until it was exploited.
const rateLimitsEnabled = process.env.DISABLE_RATE_LIMITS !== 'true';

if (isProd && !rateLimitsEnabled) {
  console.error(
    'FATAL: DISABLE_RATE_LIMITS is set in production. Refusing to start.\n' +
      '  Rate limits are what stop credential guessing and CPU exhaustion via Argon2id.'
  );
  process.exit(1);
}

// Billing is optional -- the app is complete without it. But a half-configured
// Stripe is worse than none: checkout would take money and the webhook that
// grants the entitlement would never verify, so the buyer pays and gets nothing.
/**
 * Price ids, one per purchasable plan.
 *
 * Explicit env vars rather than a lookup at boot: resolving prices from Stripe
 * would put a network call and a third-party outage on the startup path, for
 * values that change about once a year.
 *
 * STRIPE_PRICE_ID (the old single-price variable) is still read as the monthly
 * price so an existing deployment does not break on this upgrade.
 */
const prices = {
  monthly: process.env.STRIPE_PRICE_MONTHLY || '',
  quarterly: process.env.STRIPE_PRICE_QUARTERLY || '',
  semiannual: process.env.STRIPE_PRICE_SEMIANNUAL || '',
  yearly: process.env.STRIPE_PRICE_YEARLY || '',
  gift1: process.env.STRIPE_GIFT_PRICE_1M || '',
  gift3: process.env.STRIPE_GIFT_PRICE_3M || '',
  gift6: process.env.STRIPE_GIFT_PRICE_6M || '',
  gift12: process.env.STRIPE_GIFT_PRICE_12M || '',
};

if (process.env.STRIPE_SECRET_KEY) {
  const missing = ['STRIPE_WEBHOOK_SECRET'].filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(
      `FATAL: STRIPE_SECRET_KEY is set but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.\n` +
        '  A checkout without a verified webhook charges the customer and never grants the entitlement.'
    );
    process.exit(1);
  }

  // At least one price, or billing is switched on with nothing to sell: the
  // subscribe page renders an empty list and every checkout 400s.
  if (!Object.values(prices).some(Boolean)) {
    console.error(
      'FATAL: STRIPE_SECRET_KEY is set but no price is configured. Refusing to start.\n' +
        '  Set at least STRIPE_PRICE_MONTHLY. See stripe.md.'
    );
    process.exit(1);
  }

  // Unconfigured plans are simply not offered, so a partial setup is valid --
  // but it is far more often a forgotten paste than a deliberate choice.
  const unset = Object.entries(prices)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (unset.length) {
    console.warn(`WARNING: no price configured for: ${unset.join(', ')}. Those plans are hidden.`);
  }

  // A warning, not a boot failure: billing genuinely works without it. But we
  // hold no customer id by design, so this link is the ONLY route a subscriber
  // has to cancel. Without it, "how do I cancel" is a support ticket -- and in
  // several jurisdictions, cancellation has to be as easy as signing up.
  if (!process.env.STRIPE_PORTAL_URL) {
    console.warn(
      'WARNING: STRIPE_PORTAL_URL is not set. Subscribers will have no way to cancel.\n' +
        '  Stripe Dashboard > Settings > Billing > Customer portal > share the login link.\n' +
        '  We store no Stripe customer id (by design), so we cannot offer cancellation ourselves.'
    );
  }
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

  /**
   * Rate limiting, on unless explicitly disabled outside production.
   *
   * The test suite registers dozens of accounts in seconds, which the
   * registration limiter exists to stop -- so it needs a way off. That switch is
   * a genuine hazard: rate limits are what keep /auth/login from being both a
   * guessing oracle and a CPU-exhaustion vector, and an ops mistake that
   * disabled them in production would be silent. Hence the boot guard above:
   * production refuses to start with this set, rather than trusting nobody
   * copies it into the wrong .env.
   */
  rateLimitsEnabled,

  publicAppUrl,

  webauthn: {
    rpName: 'CryptChat',
    rpId: webauthnRpId,
    origin: webauthnOrigin,
  },

  rtc: {
    // Whether the app offers calls at all. STUN alone is enough to advertise
    // them (LAN / open-NAT calls work); TURN just widens who can connect.
    stunUrl: process.env.STUN_URL || turnUrl.replace(/^turns?:/, 'stun:') || '',
    turnUrl,
    turnSecret,
    // Lifetime of a minted TURN credential. Long enough to place a call and
    // reconnect once, short enough that a leaked one is soon useless.
    credentialTtlSeconds: Number(process.env.TURN_CRED_TTL_SECONDS) || 3600,
  },

  mail: {
    apiKey: mailApiKey,
    from: mailFrom || 'CryptChat <noreply@localhost>',
  },

  // The account layer, and nothing below it. See IDENTITY.md.
  identity: {
    // Wraps the per-row data key that encrypts an address. The only key in this
    // process that can reverse stored user data.
    emailMasterKey: secretKey('EMAIL_MASTER_KEY', 'email-master'),

    // Blind-index peppers. Separate from the master key: an index leak must not
    // imply a decryption capability, and vice versa.
    emailIndexPepper: secretKey('EMAIL_INDEX_PEPPER', 'email-index'),
    usernameIndexPepper: secretKey('USERNAME_INDEX_PEPPER', 'username-index'),
    redeemPepper: secretKey('REDEEM_PEPPER', 'redeem-index'),

    verifyTtlHours: 24,
    // Much shorter than verification: this one hands over the account.
    resetTtlMinutes: 30,
  },

  billing: {
    // Absent = billing routes 404 rather than half-working. The app is fully
    // usable without it; premium is additive.
    enabled: Boolean(process.env.STRIPE_SECRET_KEY),
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

    // Slug -> Stripe price id. See lib/plans.js; a plan with no price here is
    // never offered and cannot be checked out.
    prices,

    /**
     * Stripe's hosted Customer Portal *login* page.
     *
     * The only way a user can cancel, and the only way that is consistent with
     * this design. Normally an app cancels by calling Stripe with the customer
     * id it stored -- we deliberately store none, so we cannot, and a cancel
     * button here would require exactly the payment-to-account link we refuse to
     * keep.
     *
     * The login page sidesteps it: the user enters the address they paid with,
     * Stripe mails them a magic link, and they cancel there. We are not in the
     * loop at all; we only learn the outcome from the
     * customer.subscription.deleted webhook.
     *
     * Not fatal if unset -- billing still works -- but users then have no way to
     * cancel without emailing support, so the boot warning is loud.
     */
    portalUrl: process.env.STRIPE_PORTAL_URL || '',

    // Grace beyond the paid period, so a late webhook or a retried card does not
    // strip someone's badge mid-conversation.
    graceDays: Number(process.env.BILLING_GRACE_DAYS) || 3,
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
