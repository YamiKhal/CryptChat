import { api } from "@/lib/api";
import {
    createFileEncryptor,
    createFileDecryptor,
    createHasher,
    Attachment,
    FILE_CHUNK_OVERHEAD,
} from "@/lib/crypto";
import {
    Bytes,
    blobToBytes,
    sanitizeFilename,
    encodeImage,
    packAsset,
    sniffImageMime,
    RENDERABLE_IMAGE_MIME,
} from "@/lib/binary";

/**
 * Encrypted file transfer.
 *
 * Files never travel in the message envelope -- a 50MB attachment would be
 * base64'd (+33%), JSON-stringified and then duplicated once per recipient in
 * the message queue. Instead the bytes go to the blob store as a single
 * ciphertext copy and the envelope carries a pointer plus the key.
 *
 * The server sees: a member of channel X uploaded N ciphertext bytes. Not the
 * filename, not the type, not the contents.
 */

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Attachments this size or smaller render inline automatically.
 *
 * A cap exists because decoding is where the danger is, not downloading: a 40MB
 * PNG can declare 30000x30000 and expand to gigabytes once decoded, so
 * auto-decoding anything a peer sends is a memory bomb. Bigger images still
 * render, but only after a click.
 */
export const AUTO_RENDER_MAX_BYTES = 12 * 1024 * 1024;

/** Object URLs held for rendered images, so scrolling doesn't refetch 50MB. */
const IMAGE_CACHE_BUDGET = 96 * 1024 * 1024;
const imageCache = new Map<
    string,
    { url: string; size: number; mime: string }
>();
let cacheBytes = 0;

/** Evict least-recently-used until under budget. Map preserves insertion order. */
function trimCache(protectId?: string) {
    for (const [id, entry] of imageCache) {
        if (cacheBytes <= IMAGE_CACHE_BUDGET) break;
        if (id === protectId) continue;
        URL.revokeObjectURL(entry.url);
        imageCache.delete(id);
        cacheBytes -= entry.size;
    }
}

function touch(blobId: string) {
    const entry = imageCache.get(blobId);
    if (!entry) return undefined;
    // Re-insert to move it to the end (most recently used).
    imageCache.delete(blobId);
    imageCache.set(blobId, entry);
    return entry;
}

/** Drop every cached image. Called on lock, so nothing decrypted outlives the vault. */
export function clearImageCache() {
    for (const entry of imageCache.values()) URL.revokeObjectURL(entry.url);
    imageCache.clear();
    cacheBytes = 0;
}

export interface RenderableImage {
    url: string;
    mime: string;
}

/**
 * Download, decrypt and hand back a URL safe to put in an <img>.
 *
 * The declared MIME is ignored: the bytes are sniffed and only rendered if they
 * really are a bitmap on the allowlist. A file claiming `image/png` that is
 * actually HTML gets rejected here rather than becoming a same-origin document.
 *
 * Because the *original* bytes are served (not the canvas-flattened thumbnail),
 * an animated GIF arrives with all its frames and plays.
 */
export async function loadRenderableImage(
    attachment: Attachment,
    token: string,
    onProgress?: ProgressFn,
): Promise<RenderableImage> {
    const cached = touch(attachment.blobId);
    if (cached) return { url: cached.url, mime: cached.mime };

    const blob = await downloadAndDecrypt(attachment, token, onProgress);
    const bytes = await blobToBytes(blob);

    const mime = sniffImageMime(bytes);
    if (!mime || !RENDERABLE_IMAGE_MIME.has(mime)) {
        throw new Error("not a renderable image");
    }

    // Rebuilt with the *sniffed* type, never the sender's claim.
    const url = URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: mime }),
    );

    imageCache.set(attachment.blobId, { url, size: bytes.length, mime });
    cacheBytes += bytes.length;
    trimCache(attachment.blobId);

    return { url, mime };
}

/** True if this attachment should be treated as an inline image at all. */
export function looksRenderable(attachment: Attachment): boolean {
    // Only a hint for deciding whether to try; the sniff after download decides.
    return RENDERABLE_IMAGE_MIME.has(attachment.mime);
}

/** Images get an inline thumbnail so chat renders without pulling the full file. */
const THUMB_MAX_DIMENSION = 320;
const THUMBNAILABLE = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
]);

export interface TransferProgress {
    loaded: number;
    total: number;
    phase: "encrypting" | "uploading" | "downloading" | "decrypting" | "done";
}

type ProgressFn = (p: TransferProgress) => void;

/**
 * Encrypt a file and upload it in chunks.
 *
 * Reads via `File.slice()` so only one chunk is ever in memory -- a 50MB file
 * is never materialised as a single buffer.
 */
export async function encryptAndUpload(
    file: File,
    channelId: string,
    token: string,
    onProgress?: ProgressFn,
): Promise<Attachment> {
    if (file.size === 0) throw new Error("file is empty");
    if (file.size > MAX_FILE_BYTES) {
        throw new Error(
            `file too large (max ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB)`,
        );
    }

    const encryptor = await createFileEncryptor();
    const hasher = await createHasher();

    // Ask the server for the chunk size it expects, so client and server agree
    // on chunk framing without a hardcoded constant drifting between them.
    const chunkSize = await api.blobChunkSize(token);
    const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
    const cipherBytes = file.size + chunkCount * FILE_CHUNK_OVERHEAD;

    const { blobId } = await api.blobInit(token, {
        channelId,
        declaredBytes: cipherBytes,
        declaredChunks: chunkCount,
    });

    onProgress?.({ loaded: 0, total: file.size, phase: "uploading" });

    let uploaded = 0;
    for (let index = 0; index < chunkCount; index++) {
        const start = index * chunkSize;
        const slice = file.slice(start, Math.min(start + chunkSize, file.size));
        const plain = await blobToBytes(slice);

        hasher.update(plain);
        const isLast = index === chunkCount - 1;
        const cipher = encryptor.push(plain, isLast);

        await api.blobChunk(token, blobId, index, cipher);

        uploaded += plain.length;
        onProgress?.({
            loaded: uploaded,
            total: file.size,
            phase: "uploading",
        });
    }

    await api.blobFinish(token, blobId);

    let thumb;
    if (THUMBNAILABLE.has(file.type)) {
        try {
            // Re-encoded through canvas: strips EXIF from the preview even though
            // the original file's own metadata necessarily survives inside it.
            thumb = packAsset(
                await encodeImage(file, {
                    maxDimension: THUMB_MAX_DIMENSION,
                    mime: "image/webp",
                    quality: 0.7,
                }),
            );
        } catch {
            thumb = undefined;
        }
    }

    onProgress?.({ loaded: file.size, total: file.size, phase: "done" });

    return {
        blobId,
        key: encryptor.key,
        header: encryptor.header,
        name: sanitizeFilename(file.name),
        mime: file.type || "application/octet-stream",
        size: file.size,
        hash: hasher.digest(),
        chunkSize,
        thumb,
    };
}

/**
 * Download and decrypt.
 *
 * The network hands back arbitrary-sized pieces, but secretstream needs exact
 * chunk boundaries, so this buffers until a full ciphertext chunk is available.
 * A mis-split would fail authentication rather than corrupt silently -- but it
 * would fail every time, so the framing has to be right.
 */
export async function downloadAndDecrypt(
    attachment: Attachment,
    token: string,
    onProgress?: ProgressFn,
): Promise<Blob> {
    const cipherChunk = attachment.chunkSize + FILE_CHUNK_OVERHEAD;

    const response = await api.blobDownload(token, attachment.blobId);
    if (!response.body) throw new Error("no response body");

    const decryptor = await createFileDecryptor(
        attachment.key,
        attachment.header,
    );
    const hasher = await createHasher();

    const reader = response.body.getReader();
    const parts: Bytes[] = [];

    let buffer = new Uint8Array(0);
    let done = false;
    let sawFinal = false;
    let plaintextBytes = 0;

    const consume = (chunk: Bytes) => {
        const { message, final } = decryptor.pull(chunk);
        hasher.update(message);
        parts.push(message);
        plaintextBytes += message.length;
        if (final) sawFinal = true;
        onProgress?.({
            loaded: plaintextBytes,
            total: attachment.size,
            phase: "downloading",
        });
    };

    while (!done) {
        const { value, done: finished } = await reader.read();
        done = finished;

        if (value) {
            const merged = new Uint8Array(buffer.length + value.length);
            merged.set(buffer, 0);
            merged.set(value, buffer.length);
            buffer = merged;

            let offset = 0;
            while (buffer.length - offset >= cipherChunk) {
                consume(buffer.subarray(offset, offset + cipherChunk));
                offset += cipherChunk;
            }
            buffer = buffer.slice(offset);
        }
    }

    // Whatever is left is the final short chunk.
    if (buffer.length > 0) consume(buffer);

    // TAG_FINAL is the anti-truncation check: without it, a server that returned
    // only the first half of the file would produce a shorter file that still
    // decrypted cleanly, with no indication anything was missing.
    if (!sawFinal) throw new Error("file is incomplete or was truncated");

    if (plaintextBytes !== attachment.size) {
        throw new Error("decrypted size does not match the signed size");
    }
    // The hash is inside the signed envelope, so this ties the bytes to what the
    // sender actually committed to.
    if (hasher.digest() !== attachment.hash) {
        throw new Error("file failed integrity check");
    }

    onProgress?.({
        loaded: attachment.size,
        total: attachment.size,
        phase: "done",
    });

    // Hand the chunk array straight to Blob rather than concatenating first.
    // Blob accepts the parts and lets the browser page them to disk, so peak
    // memory is roughly the file size instead of ~3x it: concatenating would
    // allocate a second full-size buffer and the Blob copy a third, which is how
    // a 50MB download turns into a ~150MB spike and OOMs a phone tab.
    //
    // Deliberately octet-stream: never let a downloaded blob be renderable.
    return new Blob(parts as unknown as BlobPart[], {
        type: "application/octet-stream",
    });
}
