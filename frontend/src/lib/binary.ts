/**
 * Binary codec layer.
 *
 * Everything that crosses the encryption boundary is bytes. This module is the
 * only place that knows how to turn browser things (File, Blob, ImageBitmap,
 * data URLs) into Uint8Array and back, so the crypto layer only ever sees
 * bytes and the storage layer only ever sees base64.
 *
 * Built for attachments generally, not just avatars: `decodeImage` /
 * `encodeImage` are size- and format-parameterised so message image uploads
 * reuse the same path.
 */

export type Bytes = Uint8Array;

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function stringToBytes(value: string): Bytes {
  return encoder.encode(value);
}

export function bytesToString(bytes: Bytes): string {
  // fatal: true -- invalid UTF-8 throws instead of silently yielding U+FFFD.
  // After decryption, malformed UTF-8 means something is wrong; it should not
  // render as replacement characters.
  return decoder.decode(bytes);
}

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

/**
 * base64url (RFC 4648 §5), unpadded -- matches libsodium's URL_SAFE_NO_PADDING
 * and survives URLs, JSON, and filenames untouched.
 */
export function bytesToBase64Url(bytes: Bytes): string {
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) blows the argument limit and throws
  // RangeError on anything image-sized.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Bytes {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Bytes): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Bytes {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value);
}

/* ------------------------------------------------------------------ */
/* byte utilities                                                      */
/* ------------------------------------------------------------------ */

export function concatBytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time equality. Any comparison of secret-derived bytes (MACs, key
 * fingerprints) must not early-exit on the first differing byte.
 */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Best-effort scrub of key material once it is no longer needed. */
export function wipe(bytes: Bytes): void {
  bytes.fill(0);
}

/* ------------------------------------------------------------------ */
/* blobs, files, data URLs                                             */
/* ------------------------------------------------------------------ */

export async function blobToBytes(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function bytesToBlob(bytes: Bytes, mime: string): Blob {
  // Uint8Array is generic over its backing buffer since TS 5.7, and BlobPart
  // only accepts an ArrayBuffer-backed view. Ours always is -- none of these
  // bytes come from a SharedArrayBuffer -- but the type cannot prove it.
  return new Blob([bytes as unknown as BlobPart], { type: mime });
}

export function bytesToDataUrl(bytes: Bytes, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBytes(dataUrl: string): { bytes: Bytes; mime: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('not a data URL');
  const [, mime, isBase64, payload] = match;
  return {
    mime,
    bytes: isBase64 ? base64ToBytes(payload) : stringToBytes(decodeURIComponent(payload)),
  };
}

/**
 * Object URL with an owner-driven lifetime. Object URLs pin their blob in
 * memory until explicitly revoked, so every caller gets a release handle
 * rather than a bare string it will forget to clean up.
 */
export function bytesToObjectUrl(bytes: Bytes, mime: string): { url: string; release: () => void } {
  const url = URL.createObjectURL(bytesToBlob(bytes, mime));
  return { url, release: () => URL.revokeObjectURL(url) };
}

/* ------------------------------------------------------------------ */
/* images                                                              */
/* ------------------------------------------------------------------ */

export interface ImageEncodeOptions {
  /** Longest edge in pixels. Aspect ratio is preserved. */
  maxDimension?: number;
  mime?: 'image/webp' | 'image/jpeg' | 'image/png';
  quality?: number;
  /** Crop to a centred square. Used for avatars. */
  square?: boolean;
}

export interface DecodedImage {
  bytes: Bytes;
  mime: string;
  width: number;
  height: number;
}

const ALLOWED_INPUT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/** Hard ceiling on input before decode, so a hostile file cannot exhaust memory. */
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Normalise arbitrary image input into re-encoded bytes.
 *
 * Everything is routed through a canvas rather than kept as-is. That is not
 * only for size: re-encoding drops EXIF -- including GPS coordinates and
 * device serial numbers -- which would otherwise ride along inside the
 * encrypted payload and deanonymise the sender to every channel member.
 * It also means the stored bytes are canvas output, not attacker-controlled
 * file structure.
 */
export async function encodeImage(
  source: Blob | File | Bytes,
  options: ImageEncodeOptions = {}
): Promise<DecodedImage> {
  const { maxDimension = 512, mime = 'image/webp', quality = 0.85, square = false } = options;

  const blob = source instanceof Blob ? source : bytesToBlob(source, 'application/octet-stream');

  if (blob.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`image too large (max ${Math.floor(MAX_IMAGE_INPUT_BYTES / 1024 / 1024)}MB)`);
  }
  if (blob.type && !ALLOWED_INPUT_MIME.has(blob.type)) {
    throw new Error(`unsupported image type: ${blob.type}`);
  }

  // createImageBitmap decodes off the main thread and, unlike an <img> element,
  // never runs embedded content -- an SVG in an <img> can execute script.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('could not decode image');
  }

  try {
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;

    if (square) {
      const side = Math.min(bitmap.width, bitmap.height);
      sx = Math.floor((bitmap.width - side) / 2);
      sy = Math.floor((bitmap.height - side) / 2);
      sw = side;
      sh = side;
    }

    const scale = Math.min(1, maxDimension / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);

    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, quality)
    );
    if (!encoded) throw new Error('image encoding failed');

    return { bytes: await blobToBytes(encoded), mime: encoded.type || mime, width: dw, height: dh };
  } finally {
    bitmap.close();
  }
}

/** Read stored bytes back into something renderable. Caller must release(). */
export function decodeImage(bytes: Bytes, mime: string): { url: string; release: () => void } {
  return bytesToObjectUrl(bytes, mime);
}

/* ------------------------------------------------------------------ */
/* framing                                                             */
/* ------------------------------------------------------------------ */

export interface BinaryAsset {
  mime: string;
  width?: number;
  height?: number;
  data: string;
}

/**
 * Wrap bytes for transport inside an encrypted envelope. base64 costs 33%
 * overhead, which is the price of putting bytes in a JSON payload that is then
 * sealed as one unit.
 */
export function packAsset(image: DecodedImage): BinaryAsset {
  return {
    mime: image.mime,
    width: image.width,
    height: image.height,
    data: bytesToBase64Url(image.bytes),
  };
}

export function unpackAsset(asset: BinaryAsset): DecodedImage {
  if (!asset || typeof asset.mime !== 'string' || !isBase64Url(asset.data)) {
    throw new Error('malformed asset');
  }
  if (!ALLOWED_INPUT_MIME.has(asset.mime)) {
    // A peer controls this field. Rendering an arbitrary MIME from a blob URL
    // is how a "profile picture" becomes an HTML document in a same-origin tab.
    throw new Error(`unsupported asset type: ${asset.mime}`);
  }
  return {
    bytes: base64UrlToBytes(asset.data),
    mime: asset.mime,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
  };
}

export async function fileToAsset(file: File, options?: ImageEncodeOptions): Promise<BinaryAsset> {
  return packAsset(await encodeImage(file, options));
}
