// Type-only: vault.ts imports applyReaction from here, so a value import would
// close a runtime cycle. `import type` is erased at compile time.
import type { StoredMessage } from '@/lib/vault';
import { MAX_REPLY_EXCERPT, type ReplyRef } from '@/lib/crypto';

/**
 * Tier limits, mirrored from the server for UX only.
 *
 * These are DEFAULTS. The real values come from `GET /account/limits` at
 * runtime, because the server is the only authority -- a client that believes
 * its cap is 50MB while the server enforces 20MB produces an upload that dies
 * at 99%. These exist so the composer renders sensibly before that fetch lands.
 */
export interface Limits {
  tier: 'free' | 'premium';
  premium: boolean;
  emailVerified: boolean;
  canUpload: boolean;
  uploadDenialReason: string | null;
  maxFileBytes: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  tier: 'free',
  premium: false,
  emailVerified: false,
  // Assume the restrictive answer until the server says otherwise. Rendering an
  // enabled upload button that then 403s is worse than briefly disabling one.
  canUpload: false,
  uploadDenialReason: null,
  maxFileBytes: 20 * 1024 * 1024,
  maxChars: 1000,
};

/**
 * On the character limit, stated plainly:
 *
 * This is a PRODUCT limit, not a security boundary, and it cannot be otherwise.
 * The relay only ever sees ciphertext, so it can cap *bytes* but cannot count
 * characters without being handed the plaintext -- which is the one thing this
 * whole system exists to prevent. A patched client can exceed it.
 *
 * What actually protects the server is the envelope byte ceiling
 * (MAX_ENVELOPE_BYTES), which is enforced on the relay and is a real limit on a
 * real resource. The character count is enforced here so the UI can show a
 * counter and refuse before spending Argon2 on a send that would be rejected.
 *
 * Do not "fix" this by shipping the plaintext length to the server. It would
 * leak message length far more precisely than ciphertext size already does, and
 * it would buy nothing -- a hostile client would simply lie.
 */
export function overCharLimit(text: string, limits: Limits): boolean {
  return countChars(text) > limits.maxChars;
}

/**
 * Count what a human would call characters.
 *
 * `.length` counts UTF-16 code units, so a single emoji reads as 2 and a
 * skin-toned family emoji as 7+ -- typing three emoji should not consume 20 of
 * someone's 1000 characters. Intl.Segmenter counts grapheme clusters, which is
 * what the user sees.
 */
export function countChars(text: string): number {
  // Feature-detected despite the ES2022 lib: `lib` describes the API's shape to
  // TypeScript, it does not promise the engine has it. Spreading code points is
  // the fallback -- still better than .length, just not grapheme-accurate.
  if (typeof Intl.Segmenter === 'undefined') return [...text].length;
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
}

/**
 * Build the reply reference for a message being replied to.
 *
 * The excerpt is snapshotted here, by the replier, and signed. See ReplyRef in
 * crypto.ts for why it is not resolved at render time.
 */
export function buildReplyRef(target: StoredMessage): ReplyRef {
  const hasImage = Boolean(target.asset) || Boolean(target.attachments?.some(isImage));
  const hasFile = Boolean(target.attachments?.length);

  let kind: ReplyRef['kind'] = 'text';
  if (!target.body.trim()) kind = hasImage ? 'image' : hasFile ? 'file' : 'text';

  const excerpt = target.body.trim().slice(0, MAX_REPLY_EXCERPT);

  return {
    id: target.id,
    senderId: target.senderId,
    displayName: target.displayName.slice(0, 64),
    excerpt,
    kind,
  };
}

function isImage(attachment: { mime: string }): boolean {
  return attachment.mime.startsWith('image/');
}

/**
 * Fold a reaction into a message's reaction map.
 *
 * Keyed by emoji, then by sender: one person cannot stack the same reaction, and
 * a replayed "add" after a "remove" is idempotent rather than resurrecting it.
 */
export function applyReaction(
  reactions: Record<string, string[]> | undefined,
  emoji: string,
  senderId: string,
  removed: boolean
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...(reactions ?? {}) };
  const senders = new Set(next[emoji] ?? []);

  if (removed) senders.delete(senderId);
  else senders.add(senderId);

  if (senders.size === 0) delete next[emoji];
  else next[emoji] = [...senders];

  return next;
}

/** The reaction picker's shortlist. Deliberately small -- this is not a keyboard. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
