import sodium from 'libsodium-wrappers-sumo';
import { Bytes } from '@/lib/binary';
import { ensureReady, toB64, fromB64 } from '@/lib/crypto/internal';

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

