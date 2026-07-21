import { BinaryAsset } from '@/lib/binary';
import { LockedPayload } from '@/lib/crypto/keys';

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

