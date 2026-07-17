import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * Blob storage.
 *
 * Everything here is ciphertext -- the client encrypts before upload and the
 * server has no key. That is why there is no encryption-at-rest concern, no
 * KMS, and no reason to reach for S3's server-side encryption: the bytes are
 * already opaque when they arrive.
 *
 * The interface is deliberately narrow (append / read / remove / size) so an
 * S3 adapter can replace this without touching a single call site. The one
 * design decision that leaks through is `downloadUrl()`: callers ask for a URL
 * rather than bytes, so a future S3 adapter can hand back a presigned URL and
 * let the browser talk straight to storage, while local disk returns its own
 * endpoint and streams.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class LocalDiskBlobStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  /**
   * Resolve a blob id to a path.
   *
   * The id always comes from gen_random_uuid() in Postgres, never from the
   * request body -- but this validates anyway and re-checks containment, so a
   * future caller that forgets cannot turn a path into `../../etc/passwd`.
   */
  pathFor(id) {
    if (!UUID.test(id)) throw new Error('invalid blob id');
    // Shard by first two hex chars: a flat directory with 100k+ entries makes
    // ext4 lookups crawl.
    const shard = id.slice(0, 2);
    const full = path.join(this.dir, shard, id);
    if (!full.startsWith(this.dir + path.sep)) throw new Error('path escape');
    return full;
  }

  async append(id, chunk, expectedSize) {
    const file = this.pathFor(id);
    await fsp.mkdir(path.dirname(file), { recursive: true });

    // Truncate to the size the database believes it has before appending. A
    // chunk write that died halfway leaves trailing bytes on disk that the DB
    // never counted; appending after them would silently corrupt the
    // secretstream. This makes a retry idempotent.
    const handle = await fsp.open(file, 'a+');
    try {
      const stat = await handle.stat();
      if (stat.size > expectedSize) {
        await handle.truncate(expectedSize);
      } else if (stat.size < expectedSize) {
        throw new Error('blob shorter than recorded size');
      }
      await handle.appendFile(chunk);
      return expectedSize + chunk.length;
    } finally {
      await handle.close();
    }
  }

  createReadStream(id, options) {
    return fs.createReadStream(this.pathFor(id), options);
  }

  async size(id) {
    try {
      return (await fsp.stat(this.pathFor(id))).size;
    } catch {
      return 0;
    }
  }

  async remove(id) {
    try {
      await fsp.unlink(this.pathFor(id));
    } catch (err) {
      // Already gone is success. Reaper and /leave can both race here.
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Local disk streams through this process. An S3 adapter would return a
   * short-lived presigned URL here instead, so 50MB never touches Node. The
   * membership check stays on the API either way -- it gates who gets a URL.
   */
  downloadUrl(id) {
    return { kind: 'stream', id };
  }
}

export const blobStore = new LocalDiskBlobStore(config.blob.dir);
