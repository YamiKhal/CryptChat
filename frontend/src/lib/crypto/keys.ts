import sodium from 'libsodium-wrappers-sumo';
import { Bytes, stringToBytes, bytesToString, concatBytes, wipe } from '@/lib/binary';
import { ensureReady, toB64, fromB64 } from '@/lib/crypto/internal';

/* ------------------------------------------------------------------ */
/* identity                                                            */
/* ------------------------------------------------------------------ */

export interface Identity {
  publicKey: string;
  privateKey: string;
  signPublicKey: string;
  signPrivateKey: string;
  vaultSalt: string;
}

export async function generateIdentity(): Promise<Identity> {
  await ensureReady();
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);

  return {
    publicKey: toB64(box.publicKey),
    privateKey: toB64(box.privateKey),
    signPublicKey: toB64(sign.publicKey),
    signPrivateKey: toB64(sign.privateKey),
    vaultSalt: toB64(salt),
  };
}

/**
 * Short fingerprint of a signing key, for out-of-band verification.
 * Two members can compare these over another channel to confirm the relay did
 * not substitute keys during a join.
 */
export async function keyFingerprint(signPublicKeyB64: string): Promise<string> {
  await ensureReady();
  const hash = sodium.crypto_generichash(8, fromB64(signPublicKeyB64));
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join('-');
}

/**
 * A safety number for a PAIR of identities, to verify end-to-end trust.
 *
 * Both people compute the same number and compare it out of band (read it aloud,
 * message it over another channel). If it matches, no one substituted a key
 * between them -- which is the one thing the encryption itself cannot prove,
 * since a malicious relay could hand each side a key it controls.
 *
 * Order-independent by construction: the two signing keys are sorted before
 * hashing, so Alice and Bob derive an identical number regardless of who asks.
 * Rendered as decimal groups because digits are what survive being read over a
 * phone line without "was that a capital B or an 8".
 */
export async function safetyNumber(signKeyA: string, signKeyB: string): Promise<string> {
  await ensureReady();
  const [x, y] = [signKeyA, signKeyB].sort();
  const digest = sodium.crypto_generichash(32, concatBytes(fromB64(x), fromB64(y)));

  // 12 groups of 5 digits (60 total), each from a 2-byte window of the digest.
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % 100000;
    groups.push(String(v).padStart(5, '0'));
  }
  return groups.join(' ');
}

/* ------------------------------------------------------------------ */
/* vault key derivation                                                */
/* ------------------------------------------------------------------ */

/**
 * Derive the at-rest vault key from the login password.
 *
 * The password already goes to the server as an Argon2id verifier, so this
 * derivation is deliberately a *different* computation over the same secret:
 * the server's verifier can never be used to unwrap the vault, and the vault
 * key never leaves the device.
 *
 * INTERACTIVE limits (~64MB, 2 passes) are the honest ceiling for a browser --
 * MODERATE stalls the main thread for seconds on low-end phones and, worse,
 * blows the WASM heap on some mobile Safari builds.
 */
export async function deriveVaultKey(password: string, saltB64: string): Promise<Bytes> {
  await ensureReady();
  const salt = fromB64(saltB64);
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error('invalid vault salt');
  }
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

export async function generateSalt(): Promise<string> {
  await ensureReady();
  return toB64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
}

/* ------------------------------------------------------------------ */
/* symmetric sealing                                                   */
/* ------------------------------------------------------------------ */

export interface Sealed {
  ciphertext: string;
  nonce: string;
}

export async function sealWithKey(plaintext: string, key: Bytes | string): Promise<Sealed> {
  await ensureReady();
  const k = typeof key === 'string' ? fromB64(key) : key;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(stringToBytes(plaintext), nonce, k);
  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce) };
}

export async function openWithKey(sealed: Sealed, key: Bytes | string): Promise<string> {
  await ensureReady();
  const k = typeof key === 'string' ? fromB64(key) : key;
  // secretbox is authenticated (XSalsa20-Poly1305): a tampered ciphertext
  // throws here rather than decrypting to attacker-chosen garbage.
  const plaintext = sodium.crypto_secretbox_open_easy(
    fromB64(sealed.ciphertext),
    fromB64(sealed.nonce),
    k
  );
  return bytesToString(plaintext);
}

/* ------------------------------------------------------------------ */
/* password-locked message body (ROADMAP #6, premium)                  */
/* ------------------------------------------------------------------ */

/**
 * A message body sealed a SECOND time under a per-message code.
 *
 * This layers on top of the normal channel encryption -- the whole envelope is
 * still E2E, this just makes the body unreadable without a code the sender
 * shares out of band. Argon2id slows brute force, but be honest about the
 * threat model (see IDENTITY/ROADMAP): the recipient already holds this
 * ciphertext, so a low-entropy code is guessable *by them*. It is a privacy
 * screen against shoulder-surfing and borrowed-but-unlocked devices, not
 * secrecy from a determined channel member.
 */
export interface LockedPayload {
  /** Argon2id salt, base64url. */
  salt: string;
  nonce: string;
  /** secretbox of the real body under Argon2id(code, salt). */
  ct: string;
  /** Optional plaintext hint shown to the recipient. Signed like everything else. */
  hint?: string;
}

function derivePasswordKey(code: string, salt: Bytes): Bytes {
  return sodium.crypto_pwhash(
    32,
    code,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

export async function sealWithPassword(
  body: string,
  code: string,
  hint?: string
): Promise<LockedPayload> {
  await ensureReady();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const key = derivePasswordKey(code, salt);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(stringToBytes(body), nonce, key);
  wipe(key);
  return {
    salt: toB64(salt),
    nonce: toB64(nonce),
    ct: toB64(ct),
    ...(hint ? { hint } : {}),
  };
}

/** Throws on a wrong code -- secretbox authentication fails rather than returning garbage. */
export async function openWithPassword(locked: LockedPayload, code: string): Promise<string> {
  await ensureReady();
  const key = derivePasswordKey(code, fromB64(locked.salt));
  try {
    const plaintext = sodium.crypto_secretbox_open_easy(
      fromB64(locked.ct),
      fromB64(locked.nonce),
      key
    );
    return bytesToString(plaintext);
  } catch {
    throw new Error('wrong code');
  } finally {
    wipe(key);
  }
}

/* ------------------------------------------------------------------ */
/* channel keys                                                        */
/* ------------------------------------------------------------------ */

export async function generateChannelKey(): Promise<string> {
  await ensureReady();
  return toB64(sodium.crypto_secretbox_keygen());
}

/**
 * Wrap a channel key for one recipient. Authenticated (crypto_box, not
 * crypto_box_seal) so the joiner learns *who* offered the key and can reject a
 * key injected by anyone outside the channel.
 */
export async function wrapChannelKeyForRecipient(
  channelKeyB64: string,
  recipientPubKeyB64: string,
  senderPrivKeyB64: string
): Promise<Sealed> {
  await ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(
    fromB64(channelKeyB64),
    nonce,
    fromB64(recipientPubKeyB64),
    fromB64(senderPrivKeyB64)
  );
  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce) };
}

export async function unwrapChannelKey(
  sealed: Sealed,
  senderPubKeyB64: string,
  recipientPrivKeyB64: string
): Promise<string> {
  await ensureReady();
  const key = sodium.crypto_box_open_easy(
    fromB64(sealed.ciphertext),
    fromB64(sealed.nonce),
    fromB64(senderPubKeyB64),
    fromB64(recipientPrivKeyB64)
  );
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error('unwrapped key has wrong length');
  }
  return toB64(key);
}

