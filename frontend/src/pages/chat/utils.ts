import { Attachment } from '@/lib/crypto';
import { downloadAndDecrypt } from '@/lib/blob';
import { saveBlob } from '@/lib/binary';

/** Disappearing-message durations offered in the composer. */
export const BURN_OPTIONS = [
  { ttl: 5, label: '5s' },
  { ttl: 30, label: '30s' },
  { ttl: 60, label: '1m' },
  { ttl: 300, label: '5m' },
  { ttl: 3600, label: '1h' },
] as const;

/**
 * Ceiling for embedding an image link's original bytes in the envelope.
 *
 * The envelope caps at 256KB and base64 adds ~33%, so ~150KB of image is the
 * most that fits alongside the message. Anything larger falls back to a
 * canvas-made thumbnail (which loses GIF animation, but fits).
 */
export const MAX_INLINE_PREVIEW_BYTES = 150 * 1024;

/**
 * Two consecutive messages from the same author group into one block (one header)
 * only if they land within this window. A longer pause re-shows the name + time,
 * so a day of back-and-forth is not one nameless wall of bubbles.
 */
export const GROUP_GAP_MS = 2 * 60 * 1000;

/**
 * Decrypt an attachment and save it.
 *
 * The bytes arrive as ciphertext and the key came inside the signed envelope, so
 * this is the only place the plaintext exists -- the relay stores something it
 * cannot open. saveBlob forces application/octet-stream regardless of the
 * sender's claimed MIME, so a hostile "image" cannot be navigated to as markup.
 */
export async function downloadAttachment(
  attachment: Attachment,
  token: string,
): Promise<void> {
  const blob = await downloadAndDecrypt(attachment, token);
  saveBlob(blob, attachment.name);
}

/** Local calendar-day key, so day dividers and grouping break at local midnight. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Divider label: "Today" / "Yesterday" / "19 July" / "19 July 2025" (year when not this year). */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
