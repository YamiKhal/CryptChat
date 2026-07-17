// The "sumo" build, not the standard one. crypto_pwhash (Argon2id) -- which
// the whole at-rest vault depends on -- is omitted from the standard build,
// though @types declares it either way. Importing 'libsodium-wrappers' here
// compiles cleanly and then throws at runtime on first registration.
import sodium from 'libsodium-wrappers-sumo';
import {
  Bytes,
  stringToBytes,
  bytesToString,
  concatBytes,
  wipe,
  BinaryAsset,
} from './binary';

/**
 * Crypto layer.
 *
 * Threat model: the relay is honest-but-curious and may be compromised. It
 * routes ciphertext and knows who talks to whom and when. It must never learn
 * a message body, a display name, an avatar, or a channel key -- and it must
 * not be able to forge attribution.
 *
 * Two keypairs per identity, never shared:
 *   - box  (X25519)  -- wrapping channel keys for a specific recipient
 *   - sign (Ed25519) -- authorship, verified against a pinned key
 *
 * Reusing one keypair for both agreement and signatures is a known footgun,
 * so they are generated and stored separately.
 */

let readyPromise: Promise<void> | null = null;

export async function ensureReady(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready;
  await readyPromise;
}

const B64 = sodium.base64_variants?.URLSAFE_NO_PADDING ?? 5;

function toB64(bytes: Bytes): string {
  return sodium.to_base64(bytes, B64);
}

function fromB64(value: string): Bytes {
  return sodium.from_base64(value, B64);
}

export const ENVELOPE_VERSION = 2;

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

/* ------------------------------------------------------------------ */
/* signed envelopes                                                    */
/* ------------------------------------------------------------------ */

/**
 * A file living in the blob store. The envelope carries the pointer *and the
 * key*; the server holds only ciphertext it cannot open.
 */
export interface Attachment {
  blobId: string;
  /** secretstream key, base64. Random per file -- never the channel key. */
  key: string;
  /** secretstream header (public nonce), base64. */
  header: string;
  name: string;
  mime: string;
  /** Plaintext size, for display and for verifying the decrypted result. */
  size: number;
  /** blake2b of the plaintext. Signed, so the sender commits to the content. */
  hash: string;
  chunkSize: number;
  /** Small inline preview so chat renders images without pulling the full file. */
  thumb?: BinaryAsset;
}

/**
 * A link preview built by the *sender* and shipped inside the envelope.
 *
 * Recipients render this without touching the network. If each recipient
 * fetched the URL to build its own preview, posting a link to a server you
 * control would collect the IP address of everyone in the channel.
 */
export interface LinkPreview {
  url: string;
  /** 'image' is a link that *is* an image, embedded rather than described. */
  kind: 'link' | 'youtube' | 'image';
  title?: string;
  description?: string;
  siteName?: string;
  videoId?: string;
  /** Re-encoded through canvas by the sender: EXIF stripped, size bounded. */
  image?: BinaryAsset;
}

export interface EnvelopeContent {
  v: number;
  kind: 'message' | 'profile';
  body: string;
  displayName: string;
  avatar?: BinaryAsset;
  attachments?: Attachment[];
  preview?: LinkPreview;
  sentAt: string;
}

export interface SignedEnvelope extends EnvelopeContent {
  senderId: string;
  channelId: string;
  sig: string;
}

/**
 * Canonical byte encoding of everything the signature commits to.
 *
 * Length-prefixed rather than concatenated or JSON-stringified. Plain
 * concatenation is ambiguous -- ("ab","c") and ("a","bc") would produce
 * identical signed bytes, letting a member shift a boundary to reattribute
 * text. JSON.stringify is unusable here because key order is not guaranteed
 * stable across engines, so a valid signature could fail to verify elsewhere.
 *
 * channelId and senderId are inside the signature so a captured envelope
 * cannot be replayed into a different channel or reattributed to another
 * member by a relay that rewrites the outer senderId field.
 */
function assetField(asset?: BinaryAsset): string {
  return asset ? `${asset.mime}:${asset.data}` : '';
}

function canonicalBytes(env: Omit<SignedEnvelope, 'sig'>): Bytes {
  const fields = [
    String(env.v),
    env.kind,
    env.channelId,
    env.senderId,
    env.sentAt,
    env.displayName,
    env.body,
    assetField(env.avatar),
  ];

  // Attachments are signed field-by-field, including the key and the content
  // hash. Signing only the blobId would let another member (or a relay holding
  // the channel key) repoint a message at different bytes, or swap the key so
  // the file silently fails to open. The count is signed too, so an attachment
  // cannot be appended or dropped.
  const attachments = env.attachments ?? [];
  fields.push(String(attachments.length));
  for (const a of attachments) {
    fields.push(
      a.blobId,
      a.key,
      a.header,
      a.name,
      a.mime,
      String(a.size),
      a.hash,
      String(a.chunkSize),
      assetField(a.thumb)
    );
  }

  // The preview is sender-asserted text rendered next to their name, so it has
  // to be signed like anything else they say.
  fields.push(env.preview ? '1' : '0');
  if (env.preview) {
    fields.push(
      env.preview.url,
      env.preview.kind,
      env.preview.title ?? '',
      env.preview.description ?? '',
      env.preview.siteName ?? '',
      env.preview.videoId ?? '',
      assetField(env.preview.image)
    );
  }

  const parts: Bytes[] = [stringToBytes('darkchat-envelope-v2')];
  for (const field of fields) {
    const bytes = stringToBytes(field);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, false);
    parts.push(len, bytes);
  }
  return concatBytes(...parts);
}

export async function createEnvelope(
  content: Omit<EnvelopeContent, 'v'>,
  channelId: string,
  senderId: string,
  signPrivKeyB64: string,
  channelKeyB64: string
): Promise<Sealed> {
  await ensureReady();

  const unsigned: Omit<SignedEnvelope, 'sig'> = {
    ...content,
    v: ENVELOPE_VERSION,
    channelId,
    senderId,
  };

  const sig = sodium.crypto_sign_detached(canonicalBytes(unsigned), fromB64(signPrivKeyB64));
  const envelope: SignedEnvelope = { ...unsigned, sig: toB64(sig) };

  return sealWithKey(JSON.stringify(envelope), channelKeyB64);
}

export interface OpenedEnvelope {
  envelope: SignedEnvelope;
  verified: boolean;
}

/**
 * Open and verify.
 *
 * Decryption alone proves only that the author held the channel key -- which
 * every member does. Without the signature check, any member (or a relay that
 * obtained the key) could forge a message attributed to anyone else. The
 * caller supplies the *pinned* signing key for the claimed sender; a mismatch
 * is reported rather than thrown so the UI can surface it.
 */
export async function openEnvelope(
  sealed: Sealed,
  channelKeyB64: string,
  expected: { senderId: string; channelId: string; signPublicKey: string | null }
): Promise<OpenedEnvelope> {
  await ensureReady();

  const json = await openWithKey(sealed, channelKeyB64);
  const envelope = JSON.parse(json) as SignedEnvelope;

  if (typeof envelope !== 'object' || envelope === null) throw new Error('malformed envelope');
  if (envelope.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${envelope.v}`);
  if (typeof envelope.body !== 'string' || typeof envelope.displayName !== 'string') {
    throw new Error('malformed envelope');
  }

  // The transport's claim about the sender and channel must match what the
  // signature covers, or attribution can be swapped at the relay.
  if (envelope.senderId !== expected.senderId) throw new Error('sender mismatch');
  if (envelope.channelId !== expected.channelId) throw new Error('channel mismatch');

  if (!expected.signPublicKey) return { envelope, verified: false };

  const { sig, ...unsigned } = envelope;
  const verified = sodium.crypto_sign_verify_detached(
    fromB64(sig),
    canonicalBytes(unsigned),
    fromB64(expected.signPublicKey)
  );

  return { envelope, verified };
}

/* ------------------------------------------------------------------ */
/* file streams                                                        */
/* ------------------------------------------------------------------ */

/**
 * File encryption uses crypto_secretstream_xchacha20poly1305, not secretbox.
 *
 * secretbox would require holding the whole file in memory and, worse, offers
 * no protection against a truncated or reordered stream -- a server could serve
 * the first half of a file and it would decrypt cleanly. secretstream chains
 * every chunk to the last and marks the end with TAG_FINAL, so a short read is
 * detectable rather than silently valid.
 *
 * Each file gets its own random key. It never derives from the channel key, so
 * a file's key can travel in one envelope without exposing anything else.
 */

export interface FileStreamHeader {
  key: string;
  header: string;
}

export async function createFileEncryptor() {
  await ensureReady();
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);

  return {
    key: toB64(key),
    header: toB64(header),
    /** `final` must be true for the last chunk, or the reader rejects the stream. */
    push(chunk: Bytes, final: boolean): Bytes {
      return sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        null,
        final
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      );
    },
  };
}

export async function createFileDecryptor(keyB64: string, headerB64: string) {
  await ensureReady();
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
    fromB64(headerB64),
    fromB64(keyB64)
  );

  return {
    pull(chunk: Bytes): { message: Bytes; final: boolean } {
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk);
      // Tampered, reordered, or wrong-key chunks land here.
      if (!result) throw new Error('file chunk failed authentication');
      return {
        message: result.message,
        final: result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
      };
    },
  };
}

export const FILE_CHUNK_OVERHEAD = 17; // crypto_secretstream ABYTES

/** Streaming blake2b, so a 50MB file is never buffered just to hash it. */
export async function createHasher() {
  await ensureReady();
  const state = sodium.crypto_generichash_init(null, 32);
  return {
    update(chunk: Bytes) {
      sodium.crypto_generichash_update(state, chunk);
    },
    digest(): string {
      return toB64(sodium.crypto_generichash_final(state, 32));
    },
  };
}

export async function hashBytes(bytes: Bytes): Promise<string> {
  await ensureReady();
  return toB64(sodium.crypto_generichash(32, bytes));
}

/* ------------------------------------------------------------------ */
/* key export / import                                                 */
/* ------------------------------------------------------------------ */

export interface KeyBundle {
  v: number;
  userId: string;
  identity: Identity;
  channels: { channelId: string; code: string; key: string }[];
  exportedAt: string;
}

export interface EncryptedBundle {
  format: 'darkchat-keys';
  v: number;
  kdf: 'argon2id';
  salt: string;
  ciphertext: string;
  nonce: string;
}

/**
 * Export keys under a passphrase chosen for the export itself.
 *
 * Not the login password: the export file leaves the device, so wrapping it
 * with the same secret that guards the account means one leaked file is a full
 * account compromise. A separate passphrase and a fresh salt keep the two
 * blast radii apart.
 */
export async function exportKeyBundle(
  bundle: Omit<KeyBundle, 'v' | 'exportedAt'>,
  passphrase: string
): Promise<EncryptedBundle> {
  await ensureReady();
  if (passphrase.length < 12) throw new Error('export passphrase must be at least 12 characters');

  const salt = await generateSalt();
  const key = await deriveVaultKey(passphrase, salt);
  try {
    const payload: KeyBundle = { ...bundle, v: 1, exportedAt: new Date().toISOString() };
    const sealed = await sealWithKey(JSON.stringify(payload), key);
    return {
      format: 'darkchat-keys',
      v: 1,
      kdf: 'argon2id',
      salt,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
    };
  } finally {
    wipe(key);
  }
}

export async function importKeyBundle(
  encrypted: EncryptedBundle,
  passphrase: string
): Promise<KeyBundle> {
  await ensureReady();
  if (encrypted?.format !== 'darkchat-keys') throw new Error('not a CryptChat key file');
  if (encrypted.v !== 1) throw new Error(`unsupported key file version ${encrypted.v}`);

  const key = await deriveVaultKey(passphrase, encrypted.salt);
  try {
    // A wrong passphrase surfaces as a Poly1305 auth failure, which is what
    // makes this file safe to carry on a USB stick.
    const json = await openWithKey(
      { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce },
      key
    ).catch(() => {
      throw new Error('wrong passphrase or corrupted key file');
    });
    return JSON.parse(json) as KeyBundle;
  } finally {
    wipe(key);
  }
}
