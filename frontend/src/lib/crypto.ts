// The "sumo" build, not the standard one. crypto_pwhash (Argon2id) -- which
// the whole at-rest vault depends on -- is omitted from the standard build,
// though @types declares it either way. Importing 'libsodium-wrappers' here
// compiles cleanly and then throws at runtime on first registration.
import sodium from 'libsodium-wrappers-sumo';
import {
  Bytes,
  stringToBytes,
  bytesToString,
  bytesToBase64Url,
  concatBytes,
  wipe,
  isBase64Url,
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

/**
 * The envelope format version. Bumped once per additive field block (see the
 * `env.v >= N` ladder in canonicalBytes); new envelopes are always written at
 * the current value.
 *
 * Every older version stays *verifiable* (see SUPPORTED_VERSIONS and
 * canonicalBytes): messages already sitting in a vault were signed under an
 * earlier field list, and refusing to open them would silently destroy existing
 * transcripts. That is why the canonical encoding only ever appends.
 */
export const ENVELOPE_VERSION = 8;
const SUPPORTED_VERSIONS = new Set([2, 3, 4, 5, 6, 7, 8]);

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

/**
 * What a reply points at.
 *
 * The excerpt and display name are *snapshots taken by the replier*, not looked
 * up at render time. That is deliberate: the quoted text has to be what the
 * replier was actually looking at, and it has to survive the recipient not
 * having the original message (joined late, cleared their history, or the
 * sender deleted it locally). It also means the quote is covered by the
 * replier's signature -- they are on the record for what they claim was said.
 *
 * Consequence worth knowing: the excerpt is the *replier's* claim about the
 * original, so the UI must render it as a quote attributed to them, never as
 * authoritative text from the original author. `id` is what the UI resolves
 * against the local transcript to scroll to the real thing.
 */
export interface ReplyRef {
  id: string;
  senderId: string;
  displayName: string;
  /** Empty when the target had no text (a bare image or file). */
  excerpt: string;
  kind: 'text' | 'image' | 'file';
}

/** A reaction is its own envelope, not a mutation of the target. */
export interface ReactionRef {
  targetId: string;
  /** A single emoji. Validated on the way in -- see isSingleEmoji. */
  emoji: string;
  /** Toggling off is a signed act too, or a relay could replay the add. */
  removed: boolean;
}

/**
 * An edit: the id of the message being changed and its new text.
 *
 * A separate signed envelope, not a rewrite of the original -- the relay holds
 * only ciphertext it cannot mutate, and the edit has to be attributable. The
 * recipient additionally checks that the editor is the original author (see
 * openEnvelope's callers): the signature proves who sent the edit, but only the
 * per-message author check stops one member editing another's words.
 */
export interface EditRef {
  targetId: string;
  body: string;
}

/** A delete: a signed tombstone pointing at the message to remove. */
export interface DeleteRef {
  targetId: string;
}

/**
 * A WebRTC call-control frame for a DM: ring, offer/answer, trickled ICE, or
 * hangup/decline. Signed like every other envelope so a malicious relay cannot
 * forge a ringing peer, inject an SDP, or spoof a hangup.
 *
 * These are never stored -- they ride the relay in real time and the recipient's
 * call layer consumes them directly. The SDP and candidates are the sensitive
 * part (they carry IP addresses and DTLS fingerprints); keeping them inside the
 * signed, channel-key-encrypted envelope is what stops the server from seeing
 * the shape of a call.
 */
export interface CallSignal {
  kind: 'ringing' | 'offer' | 'answer' | 'ice' | 'hangup' | 'decline' | 'video';
  /** Ties frames to one call attempt, so a late hangup can't kill a new call. */
  callId: string;
  /** What media the caller is offering. Screen-share rides 'video' with screen:true. */
  media?: 'audio' | 'video';
  screen?: boolean;
  /** SDP for offer/answer. */
  sdp?: string;
  /** A single trickled ICE candidate (JSON string), for kind 'ice'. */
  candidate?: string;
  /**
   * For kind 'video': whether the sender is now sending live video (camera on, or
   * a screen being shared). Sent on every change so the receiver toggles the
   * remote video tile deterministically -- a replaceTrack(null) does not reliably
   * mute the far track, so relying on that alone leaves a frozen last frame.
   */
  on?: boolean;
}

/**
 * Burn-after-read: the message self-destructs `ttl` seconds after the recipient
 * first sees it. Signed so a relay cannot strip or shorten it.
 *
 * Honest scope, same family as delete: this only removes the local copy on a
 * cooperating client. It cannot stop a screenshot, a photo of the screen, or a
 * modified client that ignores the timer. It is auto-tidy, not a guarantee
 * against the person you are talking to.
 */
export interface BurnRef {
  /** Seconds after first view before the message is deleted locally. */
  ttl: number;
}

export interface EnvelopeContent {
  v: number;
  kind: 'message' | 'profile' | 'reaction' | 'edit' | 'delete' | 'call';
  body: string;
  displayName: string;
  avatar?: BinaryAsset;
  attachments?: Attachment[];
  preview?: LinkPreview;
  replyTo?: ReplyRef;
  reaction?: ReactionRef;
  edit?: EditRef;
  del?: DeleteRef;
  /** Present when the body is password-locked; the plaintext body is then ''. */
  locked?: LockedPayload;
  /** Present on a burn-after-read message. */
  burn?: BurnRef;
  /**
   * Opt-in supporter badge. Self-asserted (the server signs no attestation), so
   * it means "this sender chose to show a crown", not a verified payment. Sent
   * only when the user enables it and never in incognito channels.
   */
  supporter?: boolean;
  /**
   * Profile-only (kind === 'profile'): a free-text bio, which may contain
   * [label](url) links, and a banner image. Signed like the avatar, so a relay
   * can neither rewrite a bio nor swap a banner. Empty on message envelopes.
   */
  bio?: string;
  background?: BinaryAsset;
  /**
   * Whole-message spoiler: the recipient's UI covers the bubble until clicked.
   * Signed (v7) so a relay can neither strip the cover off a message meant to be
   * hidden nor slap one onto a message that was not.
   */
  spoiler?: boolean;
  /** Present on a 'call' envelope: WebRTC signaling for a 1:1 DM call. */
  call?: CallSignal;
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

  // v3 fields are appended, never interleaved, and the domain string changes
  // with the version. Both matter: a v2 envelope must produce byte-identical
  // input to what it was signed over, or every message already in a vault stops
  // verifying and the UI marks the entire history "unverified".
  if (env.v >= 3) {
    // Reply metadata is signed. Without this a relay could repoint a reply at a
    // different message, or forge one, and make someone appear to be answering
    // something they never saw.
    fields.push(env.replyTo ? '1' : '0');
    if (env.replyTo) {
      fields.push(
        env.replyTo.id,
        env.replyTo.senderId,
        env.replyTo.displayName,
        env.replyTo.excerpt,
        env.replyTo.kind
      );
    }

    // Same for reactions: the target and the toggle state are both signed, so a
    // relay can neither move a reaction onto another message nor replay an old
    // "add" to undo someone's removal.
    fields.push(env.reaction ? '1' : '0');
    if (env.reaction) {
      fields.push(
        env.reaction.targetId,
        env.reaction.emoji,
        env.reaction.removed ? '1' : '0'
      );
    }
  }

  // v4 adds edit and delete, both signed acts pointing at a target message.
  // Appended after the v3 block for the same reason v3 was appended after v2:
  // an existing v3 envelope must still hash to exactly what it was signed over.
  if (env.v >= 4) {
    fields.push(env.edit ? '1' : '0');
    if (env.edit) fields.push(env.edit.targetId, env.edit.body);

    fields.push(env.del ? '1' : '0');
    if (env.del) fields.push(env.del.targetId);

    // The locked payload is signed too: the ciphertext, salt, nonce, and hint
    // are all part of what the sender committed to, so a relay cannot swap the
    // sealed body or rewrite the hint.
    fields.push(env.locked ? '1' : '0');
    if (env.locked) {
      fields.push(env.locked.salt, env.locked.nonce, env.locked.ct, env.locked.hint ?? '');
    }

    // The burn timer is signed so a relay cannot strip it (keeping a message
    // that was meant to vanish) or lengthen it.
    fields.push(env.burn ? '1' : '0');
    if (env.burn) fields.push(String(env.burn.ttl));
  }

  // v5 adds the opt-in supporter flag. New version rather than another append to
  // v4, so every v4 message already in a vault still verifies unchanged.
  if (env.v >= 5) {
    fields.push(env.supporter ? '1' : '0');
  }

  // v6 adds call signaling. Appended after v5 so every v5 message already in a
  // vault verifies unchanged. The whole signal is signed -- kind, callId, media,
  // and the SDP/candidate -- so a relay cannot forge a ring, swap an SDP (which
  // would let it man-in-the-middle the media path), or spoof a hangup.
  if (env.v >= 6) {
    fields.push(env.call ? '1' : '0');
    if (env.call) {
      fields.push(
        env.call.kind,
        env.call.callId,
        env.call.media ?? '',
        env.call.screen ? '1' : '0',
        env.call.sdp ?? '',
        env.call.candidate ?? '',
        env.call.on ? '1' : '0'
      );
    }
  }

  // v7 adds the whole-message spoiler flag. Appended after v6 so every v6
  // message already in a vault verifies unchanged.
  if (env.v >= 7) {
    fields.push(env.spoiler ? '1' : '0');
  }

  // v8 adds the profile bio and banner. Signed even on message envelopes (as
  // empty strings) so the encoding stays fixed; only profile envelopes ever set
  // them. Appended after v7 so every v7 message already in a vault verifies
  // unchanged.
  if (env.v >= 8) {
    fields.push(env.bio ?? '');
    fields.push(assetField(env.background));
  }

  const parts: Bytes[] = [stringToBytes(`darkchat-envelope-v${env.v}`)];
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

/**
 * Bound on a quoted excerpt. A reply carries the replier's snapshot of the
 * original, and without a cap that field is an arbitrary-length string a peer
 * can push into every recipient's vault.
 */
export const MAX_REPLY_EXCERPT = 140;

/**
 * Bound on a profile bio. A peer picks this and it lands in every recipient's
 * vault, so it is capped rather than trusted to be reasonable.
 */
export const MAX_BIO = 500;

/**
 * One emoji. Not "a short string" -- a peer picks this and it is rendered
 * verbatim next to a message, so anything that is not a single pictograph is
 * refused rather than displayed.
 *
 * Uses Intl.Segmenter where available: an emoji like a flag or a skin-toned
 * family is several code points joined by ZWJ, so counting `.length` or even
 * [...spread] rejects perfectly ordinary emoji. Falls back to a code-point cap
 * on engines without it (bounded, if slightly permissive).
 */
export function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return false;

  // No control characters, and no bidi overrides -- a U+202E inside a reaction
  // would reorder the text rendered around it. This field is a pictograph, not
  // a text channel, so anything structural is refused outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(value)) return false;

  if (typeof Intl.Segmenter !== 'undefined') {
    const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)];
    if (graphemes.length !== 1) return false;
  } else if ([...value].length > 8) {
    // No Segmenter: fall back to a code-point cap. Bounded, if permissive -- a
    // ZWJ sequence like a family emoji is legitimately several code points.
    return false;
  }

  return /\p{Extended_Pictographic}/u.test(value);
}

function isValidReplyRef(value: unknown): value is ReplyRef {
  const r = value as ReplyRef;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    r.id.length <= 64 &&
    typeof r.senderId === 'string' &&
    r.senderId.length <= 64 &&
    typeof r.displayName === 'string' &&
    r.displayName.length <= 64 &&
    typeof r.excerpt === 'string' &&
    r.excerpt.length <= MAX_REPLY_EXCERPT &&
    (r.kind === 'text' || r.kind === 'image' || r.kind === 'file')
  );
}

function isValidReactionRef(value: unknown): value is ReactionRef {
  const r = value as ReactionRef;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.targetId === 'string' &&
    r.targetId.length > 0 &&
    r.targetId.length <= 64 &&
    typeof r.removed === 'boolean' &&
    isSingleEmoji(r.emoji)
  );
}

/**
 * A generous cap on an edited body -- above the premium message limit, since the
 * UI enforces the tier cap and this is only the outer bound that keeps a hostile
 * peer from pushing an unbounded string into every recipient's vault.
 */
export const MAX_EDIT_BODY = 8192;

function isValidTargetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isValidEditRef(value: unknown): value is EditRef {
  const e = value as EditRef;
  return (
    typeof e === 'object' &&
    e !== null &&
    isValidTargetId(e.targetId) &&
    typeof e.body === 'string' &&
    e.body.length <= MAX_EDIT_BODY
  );
}

function isValidDeleteRef(value: unknown): value is DeleteRef {
  const d = value as DeleteRef;
  return typeof d === 'object' && d !== null && isValidTargetId(d.targetId);
}

/** Bound on an SDP blob. Real offers are a few KB; this only fences the outer size. */
export const MAX_SDP = 64 * 1024;
const CALL_KINDS = new Set(['ringing', 'offer', 'answer', 'ice', 'hangup', 'decline', 'video']);

function isValidCallSignal(value: unknown): value is CallSignal {
  const c = value as CallSignal;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.kind === 'string' &&
    CALL_KINDS.has(c.kind) &&
    typeof c.callId === 'string' &&
    c.callId.length > 0 &&
    c.callId.length <= 64 &&
    (c.media === undefined || c.media === 'audio' || c.media === 'video') &&
    (c.screen === undefined || typeof c.screen === 'boolean') &&
    (c.sdp === undefined || (typeof c.sdp === 'string' && c.sdp.length <= MAX_SDP)) &&
    (c.candidate === undefined || (typeof c.candidate === 'string' && c.candidate.length <= 4096)) &&
    (c.on === undefined || typeof c.on === 'boolean')
  );
}

/** Bound on the sealed body, matching the envelope's overall generosity. */
export const MAX_LOCKED_CT = 16384;
export const MAX_LOCK_HINT = 140;

/** One second to one week. Bounds a peer-supplied timer to something sane. */
export const MAX_BURN_TTL = 7 * 24 * 3600;

function isValidBurnRef(value: unknown): value is BurnRef {
  const b = value as BurnRef;
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof b.ttl === 'number' &&
    Number.isFinite(b.ttl) &&
    b.ttl >= 1 &&
    b.ttl <= MAX_BURN_TTL
  );
}

function isValidLockedPayload(value: unknown): value is LockedPayload {
  const l = value as LockedPayload;
  return (
    typeof l === 'object' &&
    l !== null &&
    isBase64Url(l.salt) &&
    isBase64Url(l.nonce) &&
    isBase64Url(l.ct) &&
    l.ct.length <= MAX_LOCKED_CT &&
    (l.hint === undefined || (typeof l.hint === 'string' && l.hint.length <= MAX_LOCK_HINT))
  );
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
  // Older versions are still accepted for reading: they are what messages
  // already in a vault were signed under. Only ENVELOPE_VERSION is ever written.
  if (!SUPPORTED_VERSIONS.has(envelope.v)) {
    throw new Error(`unsupported envelope version ${envelope.v}`);
  }
  if (typeof envelope.body !== 'string' || typeof envelope.displayName !== 'string') {
    throw new Error('malformed envelope');
  }

  // A peer controls these. Validating shape here keeps malformed or hostile
  // structures out of the UI, which would otherwise render whatever it was
  // handed.
  if (envelope.replyTo && !isValidReplyRef(envelope.replyTo)) {
    throw new Error('malformed reply reference');
  }
  if (envelope.reaction && !isValidReactionRef(envelope.reaction)) {
    throw new Error('malformed reaction');
  }
  if (envelope.edit && !isValidEditRef(envelope.edit)) {
    throw new Error('malformed edit');
  }
  if (envelope.del && !isValidDeleteRef(envelope.del)) {
    throw new Error('malformed delete');
  }
  if (envelope.locked && !isValidLockedPayload(envelope.locked)) {
    throw new Error('malformed locked payload');
  }
  if (envelope.burn && !isValidBurnRef(envelope.burn)) {
    throw new Error('malformed burn timer');
  }
  if (envelope.call && !isValidCallSignal(envelope.call)) {
    throw new Error('malformed call signal');
  }
  // A peer controls the bio. Cap it so a hostile profile cannot push an
  // unbounded string into every recipient's vault. The banner is validated on
  // render (unpackAsset enforces the image allowlist), like any other asset.
  if (envelope.bio !== undefined && (typeof envelope.bio !== 'string' || envelope.bio.length > MAX_BIO)) {
    throw new Error('malformed bio');
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

/* ------------------------------------------------------------------ */
/* recovery code                                                       */
/* ------------------------------------------------------------------ */

/**
 * The recovery code: 256 bits of CSPRNG output, rendered as 24 words.
 *
 * This is what makes recovery possible at all. The vault lives only in this
 * browser's localStorage and the server has never held a private key, so a
 * device that has never seen the account has nothing to unlock -- no password
 * can fix that, because the ciphertext simply is not there. The recovery blob
 * (a KeyBundle sealed under this code, parked on the server) is the only copy it
 * can reach.
 *
 * Why the server may hold that blob when it may not hold the vault: the vault is
 * sealed under a human-chosen password, so a server holding it holds an offline
 * cracking target worth grinding. This is sealed under 256 random bits. There is
 * no dictionary, no wordlist, and no amount of GPU that makes 2^256 approachable
 * -- the server holds ciphertext it cannot attack, exactly the standard it
 * already meets for every message it relays.
 *
 * Words, not hex: this gets written on paper and typed back months later, and
 * people transcribe words correctly far more often than 64 hex characters.
 */
export const RECOVERY_CODE_WORDS = 24;

/**
 * BIP39, via @scure/bip39 rather than hand-rolled.
 *
 * The encoding is not the interesting part of this feature and getting it subtly
 * wrong is entirely possible -- the checksum, the bit packing, and NFKD
 * normalization of typed input all have edge cases. @scure/bip39 is audited and
 * its English wordlist is chosen so the first four letters of every word are
 * unique, which is what makes a handwritten phrase survive bad handwriting.
 *
 * Using BIP39 here does NOT mean this is a crypto wallet. It is a well-specified
 * way to render 256 bits as words and read them back, nothing more.
 *
 * Lazily imported: the wordlist is ~13KB and users who never register or recover
 * should not pay for it in the main bundle.
 */
async function bip39() {
  // The `.js` suffix is required: the package's export map lists
  // "./wordlists/english.js" and nothing resolves without it.
  const [core, english] = await Promise.all([
    import('@scure/bip39'),
    import('@scure/bip39/wordlists/english.js'),
  ]);
  return { core, wordlist: english.wordlist };
}

export interface RecoveryCode {
  /** The 24 words, space-separated. Shown once, never stored, never sent. */
  phrase: string;
  /** Raw entropy, for immediate use in deriving the wrap key. */
  entropy: Bytes;
}

export async function generateRecoveryCode(): Promise<RecoveryCode> {
  const { core, wordlist } = await bip39();
  // 256 bits -> 24 words.
  const phrase = core.generateMnemonic(wordlist, 256);
  return { phrase, entropy: core.mnemonicToEntropy(phrase, wordlist) };
}

/**
 * Parse a typed-back phrase into entropy.
 *
 * A mistyped word fails the BIP39 checksum here, which matters for the error
 * message: without it the user would see "wrong recovery code" from a failed
 * Poly1305 tag, indistinguishable from "the server handed you a corrupt blob".
 */
export async function parseRecoveryCode(phrase: string): Promise<Bytes> {
  const { core, wordlist } = await bip39();
  const normalized = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');

  const count = normalized ? normalized.split(' ').length : 0;
  if (count !== RECOVERY_CODE_WORDS) {
    throw new Error(`recovery code must be ${RECOVERY_CODE_WORDS} words (got ${count})`);
  }

  try {
    return core.mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new Error('recovery code is not valid -- check for a mistyped word');
  }
}

/**
 * The blob the server parks. Same shape as an exported key file, but wrapped
 * under the recovery code instead of a chosen passphrase.
 */
export interface RecoveryBlob {
  ciphertext: string;
  nonce: string;
  salt: string;
}

async function deriveRecoveryKey(entropy: Bytes, saltB64: string): Promise<Bytes> {
  await ensureReady();
  const salt = fromB64(saltB64);
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error('invalid recovery salt');
  }

  // The entropy goes in as base64 text, not as raw bytes reinterpreted as a
  // string. Random bytes are not valid UTF-8, so decoding them would either
  // throw (our decoder is fatal:true) or -- with a lenient decoder -- silently
  // map whole byte ranges onto U+FFFD and collapse the entropy. base64 is a
  // lossless, injective rendering, so distinct codes stay distinct keys.
  //
  // Argon2id over already-uniform 256-bit input is not doing the work it does
  // over a password: there is nothing to slow down, because there is nothing to
  // guess. It is here so the blob's format matches the export path, and so that
  // if product ever shortens the code, the derivation is already hardened rather
  // than needing to be remembered. INTERACTIVE limits keep it off the critical
  // path.
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    bytesToBase64Url(entropy),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

export async function sealRecoveryBlob(
  bundle: Omit<KeyBundle, 'v' | 'exportedAt'>,
  entropy: Bytes
): Promise<RecoveryBlob> {
  await ensureReady();
  const salt = await generateSalt();
  const key = await deriveRecoveryKey(entropy, salt);
  try {
    const payload: KeyBundle = { ...bundle, v: 1, exportedAt: new Date().toISOString() };
    const sealed = await sealWithKey(JSON.stringify(payload), key);
    return { ciphertext: sealed.ciphertext, nonce: sealed.nonce, salt };
  } finally {
    wipe(key);
  }
}

export async function openRecoveryBlob(blob: RecoveryBlob, entropy: Bytes): Promise<KeyBundle> {
  await ensureReady();
  const key = await deriveRecoveryKey(entropy, blob.salt);
  try {
    const json = await openWithKey({ ciphertext: blob.ciphertext, nonce: blob.nonce }, key).catch(
      () => {
        throw new Error('wrong recovery code');
      }
    );
    return JSON.parse(json) as KeyBundle;
  } finally {
    wipe(key);
  }
}
