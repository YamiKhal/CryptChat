import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Server-side crypto for the account layer -- and *only* the account layer.
 *
 * Nothing here touches messages, channel keys, or blobs: those are sealed on the
 * client under keys this process never sees, and that stays true. This module
 * exists because monetization needs a mailbox we can actually reach, which means
 * the server must be able to decrypt an email address. Read IDENTITY.md before
 * changing anything in here.
 *
 * Two distinct jobs, deliberately not sharing a key:
 *   - blind index (HMAC)     -- equality lookup without a reversible column
 *   - envelope encryption    -- reversible storage of the address itself
 */

const AES_ALG = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard; 96-bit IVs are the only size GCM is proven at
const TAG_BYTES = 16;
const DEK_BYTES = 32;

/* ------------------------------------------------------------------ */
/* blind index                                                         */
/* ------------------------------------------------------------------ */

/**
 * Equality-searchable index over a low-entropy value.
 *
 * HMAC, never a bare hash. sha256(email) looks like protection and is not: the
 * input space is small enough that anyone holding a dump grinds their candidate
 * list offline and confirms who has an account. The pepper lives in the
 * environment and never in Postgres, so a database dump on its own has nothing
 * to test against -- an attacker needs the app server too.
 *
 * Normalization happens before hashing or the index misses on case alone. Note
 * we do NOT strip gmail-style dots or +tags: two addresses that differ that way
 * are different addresses, and collapsing them would let one person's index
 * entry collide with another's.
 */
export function blindIndex(value, pepper) {
  return crypto
    .createHmac('sha256', pepper)
    .update(value.trim().toLowerCase())
    .digest('hex');
}

export function emailIndex(email) {
  return blindIndex(email, config.identity.emailIndexPepper);
}

export function usernameIndex(username) {
  return blindIndex(username, config.identity.usernameIndexPepper);
}

/**
 * Legacy bare-SHA-256 username hash.
 *
 * Only for the dual-read migration: accounts registered before the HMAC change
 * still have this in `username_hash`, and dropping it would lock every one of
 * them out permanently. Login tries the HMAC first, falls back to this, and
 * rewrites the row on success. Never use it for a new row.
 */
export function legacyUsernameHash(username) {
  return crypto.createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
}

/* ------------------------------------------------------------------ */
/* envelope encryption                                                 */
/* ------------------------------------------------------------------ */

/**
 * Per-row data key, wrapped under the master key.
 *
 * Envelope rather than encrypting straight under the master: rotating the master
 * then rewrites only the wrapped DEKs, not every address, and a DEK leak is
 * scoped to one row.
 */
function wrapDek(dek) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALG, config.identity.emailMasterKey, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function unwrapDek(wrapped) {
  const raw = Buffer.from(wrapped, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(AES_ALG, config.identity.emailMasterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypt an address for storage. Returns the columns to persist.
 *
 * The mask is computed here, at write time, and stored alongside. It is the only
 * form any API hands back. Deriving a mask on read would mean decrypting on
 * read, which is exactly the thing we promise not to do outside the send path.
 */
export function encryptEmail(email) {
  const normalized = email.trim().toLowerCase();
  const dek = crypto.randomBytes(DEK_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALG, dek, iv);
  const ct = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);

  const payload = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  const wrapped = wrapDek(dek);
  dek.fill(0);

  return {
    emailCt: payload,
    emailDek: wrapped,
    emailHash: emailIndex(normalized),
    emailMask: maskEmail(normalized),
  };
}

/**
 * Decrypt an address.
 *
 * CALLERS: the outbound mail path, and nothing else. Any new call site is a
 * change to what this product claims about itself -- if you are about to add one
 * to a route handler that returns JSON to a client, stop.
 */
export function decryptEmail({ emailCt, emailDek }) {
  const dek = unwrapDek(emailDek);
  try {
    const raw = Buffer.from(emailCt, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(AES_ALG, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Display mask: `ab•••••••@outlook.com`.
 *
 * Fixed-width elision, not proportional. A mask that tracks the real length
 * leaks the length, which narrows a guess considerably when combined with a
 * known domain. Two leading characters rather than four: four is enough to
 * recognize a name on most personal addresses, which is the thing a shoulder-
 * surfer or a support screenshot should not give away.
 */
export function maskEmail(email) {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return '•••••••';

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const head = local.slice(0, 2);
  return `${head}•••••••@${domain}`;
}

/* ------------------------------------------------------------------ */
/* tokens                                                              */
/* ------------------------------------------------------------------ */

/**
 * Single-use token for a mailed link. Returned in the clear to the caller (who
 * mails it) and stored only as a hash.
 *
 * The token is a bearer credential for "this mailbox proved control", so the
 * database holds sha256 of it: a dump yields nothing usable, and a plain
 * comparison against a stored plaintext token would be a timing side channel
 * anyway. sha256 without a KDF is correct here -- unlike a password, this input
 * is 256 bits of CSPRNG output and has no dictionary to grind.
 */
export function issueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Redemption code for a purchased entitlement: `XXXX-XXXX-XXXX-XXXX`.
 *
 * Crockford base32 (no I/L/O/U) because a human retypes this off a receipt page,
 * and those are the characters they get wrong. 20 symbols x 5 bits = 100 bits,
 * far past guessable, so the rate limit on redeem is defense in depth rather
 * than the actual barrier.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function issueRedemptionCode() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += CROCKFORD[bytes[i] % CROCKFORD.length];
  }
  return out;
}

/**
 * Normalize a retyped code before lookup: strip separators, uppercase, and map
 * the characters people substitute (O->0, I/L->1) back onto the alphabet.
 */
export function normalizeRedemptionCode(code) {
  return String(code)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function redemptionIndex(code) {
  return blindIndex(normalizeRedemptionCode(code), config.identity.redeemPepper);
}

/* ------------------------------------------------------------------ */
/* timing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Pad a handler to a fixed wall-clock floor.
 *
 * The recovery lookup must answer identically whether or not an address is
 * registered, and "identical" includes latency -- a matched address does real
 * work (decrypt, send mail) that an unmatched one does not, and the difference
 * is trivially measurable. Callers do the work, then await this against the
 * timestamp they took on entry.
 */
export async function padTo(startedAt, floorMs) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < floorMs) {
    await new Promise((resolve) => setTimeout(resolve, floorMs - elapsed));
  }
}
