import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { blobStore } from '../blobStore.js';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CIPHER_CHUNK = config.blob.chunkBytes + config.blob.chunkOverheadBytes;

// Chunk PUTs need their own budget. A 50MB upload is ~50 requests back to
// back, which the general 120/min apiLimiter would throttle into a stall.
const chunkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 400,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'upload rate limit' },
});

const initLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many uploads' },
});

async function isMember(channelId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  return r.rowCount > 0;
}

/**
 * Upload policy. The client must frame chunks exactly as the server expects,
 * so it asks rather than hardcoding a constant that could drift out of sync
 * with BLOB_CHUNK_BYTES and break every upload.
 */
router.get('/config', requireAuth, (req, res) => {
  res.json({
    chunkBytes: config.blob.chunkBytes,
    maxFileBytes: config.blob.maxFileBytes,
    chunkOverheadBytes: config.blob.chunkOverheadBytes,
  });
});

/**
 * Reserve a blob. Validates membership, size, and quota *before* a single byte
 * is accepted.
 *
 * body: { channelId, declaredBytes, declaredChunks }
 */
router.post('/init', initLimiter, requireAuth, async (req, res, next) => {
  try {
    const { channelId, declaredBytes, declaredChunks } = req.body ?? {};

    if (!UUID.test(channelId ?? '')) {
      return res.status(400).json({ error: 'invalid channelId' });
    }
    if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) {
      return res.status(400).json({ error: 'invalid declaredBytes' });
    }
    if (!Number.isInteger(declaredChunks) || declaredChunks <= 0) {
      return res.status(400).json({ error: 'invalid declaredChunks' });
    }

    // declaredBytes is ciphertext: plaintext + 17 bytes of tag per chunk.
    const maxCiphertext =
      config.blob.maxFileBytes + declaredChunks * config.blob.chunkOverheadBytes;
    if (declaredBytes > maxCiphertext) {
      return res.status(413).json({
        error: `file too large (max ${Math.floor(config.blob.maxFileBytes / 1024 / 1024)}MB)`,
      });
    }

    // Chunk count must match the declared size, or a client could claim one
    // chunk and then stream forever.
    const expectedChunks = Math.ceil(declaredBytes / CIPHER_CHUNK);
    if (declaredChunks !== expectedChunks) {
      return res.status(400).json({ error: 'declaredChunks does not match declaredBytes' });
    }

    if (!(await isMember(channelId, req.userId))) {
      return res.status(404).json({ error: 'channel not found' });
    }

    const used = await pool.query(
      `SELECT coalesce(sum(declared_bytes), 0)::bigint AS total
       FROM blobs WHERE owner_id = $1 AND status != 'expired'`,
      [req.userId]
    );
    if (Number(used.rows[0].total) + declaredBytes > config.blob.quotaPerUserBytes) {
      return res.status(507).json({ error: 'storage quota exceeded' });
    }

    const inserted = await pool.query(
      `INSERT INTO blobs (channel_id, owner_id, declared_bytes, declared_chunks)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [channelId, req.userId, declaredBytes, declaredChunks]
    );

    res.json({
      blobId: inserted.rows[0].id,
      chunkBytes: config.blob.chunkBytes,
    });
  } catch (err) {
    next(err);
  }
});

/** Resume point. Lets a client continue an upload instead of restarting 50MB. */
router.get('/:blobId/status', requireAuth, async (req, res, next) => {
  try {
    const { blobId } = req.params;
    if (!UUID.test(blobId)) return res.status(400).json({ error: 'invalid blobId' });

    const row = await pool.query(
      'SELECT status, chunks_received, bytes_received, declared_chunks FROM blobs WHERE id = $1 AND owner_id = $2',
      [blobId, req.userId]
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'not found' });

    const b = row.rows[0];
    res.json({
      status: b.status,
      chunksReceived: b.chunks_received,
      bytesReceived: Number(b.bytes_received),
      declaredChunks: b.declared_chunks,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Append one ciphertext chunk. Raw body -- deliberately not JSON.
 *
 * express.json() is capped at 512kb and would both reject and mangle these.
 * Chunks are opaque bytes and must never go near a body parser.
 *
 * Chunks must arrive in order. Sequential append means no offset arithmetic
 * and no way for a reordered write to corrupt the stream; the client resumes
 * from /status.
 */
router.put(
  '/:blobId/chunk',
  chunkLimiter,
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: CIPHER_CHUNK + 1024 }),
  async (req, res, next) => {
    try {
      const { blobId } = req.params;
      if (!UUID.test(blobId)) return res.status(400).json({ error: 'invalid blobId' });

      const index = Number(req.get('X-Chunk-Index'));
      if (!Number.isInteger(index) || index < 0) {
        return res.status(400).json({ error: 'invalid X-Chunk-Index' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'empty chunk' });
      }
      if (req.body.length > CIPHER_CHUNK) {
        return res.status(413).json({ error: 'chunk too large' });
      }

      // owner_id in the predicate: only the uploader may write, and only while
      // pending. Without it any member could scribble into someone's upload.
      const row = await pool.query(
        `SELECT chunks_received, bytes_received, declared_chunks, declared_bytes, status
         FROM blobs WHERE id = $1 AND owner_id = $2`,
        [blobId, req.userId]
      );
      if (row.rowCount === 0) return res.status(404).json({ error: 'not found' });

      const b = row.rows[0];
      if (b.status !== 'pending') return res.status(409).json({ error: 'upload already finished' });

      if (index !== b.chunks_received) {
        return res.status(409).json({
          error: 'out of order chunk',
          expected: b.chunks_received,
        });
      }
      if (Number(b.bytes_received) + req.body.length > Number(b.declared_bytes)) {
        return res.status(413).json({ error: 'upload exceeds declared size' });
      }
      if (index >= b.declared_chunks) {
        return res.status(413).json({ error: 'more chunks than declared' });
      }

      const newSize = await blobStore.append(blobId, req.body, Number(b.bytes_received));

      await pool.query(
        'UPDATE blobs SET chunks_received = $1, bytes_received = $2 WHERE id = $3',
        [index + 1, newSize, blobId]
      );

      res.json({ chunksReceived: index + 1, bytesReceived: newSize });
    } catch (err) {
      next(err);
    }
  }
);

/** Seal the upload. Only now is it downloadable. */
router.post('/:blobId/finish', requireAuth, async (req, res, next) => {
  try {
    const { blobId } = req.params;
    if (!UUID.test(blobId)) return res.status(400).json({ error: 'invalid blobId' });

    const row = await pool.query(
      `SELECT chunks_received, declared_chunks, bytes_received, declared_bytes, status
       FROM blobs WHERE id = $1 AND owner_id = $2`,
      [blobId, req.userId]
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'not found' });

    const b = row.rows[0];
    if (b.status === 'complete') return res.json({ ok: true, blobId });

    if (b.chunks_received !== b.declared_chunks) {
      return res.status(400).json({ error: 'upload incomplete' });
    }
    // Cross-check disk against the database: if they disagree the stream is
    // not what was reserved, and half a secretstream is undecryptable anyway.
    const onDisk = await blobStore.size(blobId);
    if (onDisk !== Number(b.declared_bytes) || onDisk !== Number(b.bytes_received)) {
      return res.status(400).json({ error: 'size mismatch' });
    }

    await pool.query(
      `UPDATE blobs SET status = 'complete', completed_at = now(),
              expires_at = now() + ($1 || ' days')::interval
       WHERE id = $2`,
      [String(config.blob.ttlDays), blobId]
    );

    res.json({ ok: true, blobId });
  } catch (err) {
    next(err);
  }
});

/**
 * Stream ciphertext to any member of the blob's channel.
 *
 * The membership join is what stops a leaked blobId from being a public
 * download link. The server hands out bytes it cannot read; the file key rides
 * in the E2E envelope.
 */
router.get('/:blobId', requireAuth, async (req, res, next) => {
  try {
    const { blobId } = req.params;
    if (!UUID.test(blobId)) return res.status(400).json({ error: 'invalid blobId' });

    const row = await pool.query(
      `SELECT b.id, b.declared_bytes, b.status
       FROM blobs b
       JOIN channel_members cm ON cm.channel_id = b.channel_id
       WHERE b.id = $1 AND cm.user_id = $2 AND b.status = 'complete'`,
      [blobId, req.userId]
    );
    // 404 rather than 403: a non-member should not learn the blob exists.
    if (row.rowCount === 0) return res.status(404).json({ error: 'not found' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', row.rows[0].declared_bytes);
    // Opaque ciphertext must never be sniffed into a renderable type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = blobStore.createReadStream(blobId);
    stream.on('error', (err) => {
      console.error('blob read failed:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'read failed' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * Drop expired blobs and abandoned uploads, from disk and the database.
 *
 * Undelivered mail is not an archive and neither is this. Without the reaper
 * the volume fills, and a full volume is how a storage problem becomes an
 * outage.
 */
export function startBlobReaper() {
  const run = async () => {
    try {
      const stale = await pool.query(
        `DELETE FROM blobs
         WHERE (status = 'complete' AND expires_at < now())
            OR (status = 'pending' AND created_at < now() - ($1 || ' hours')::interval)
         RETURNING id`,
        [String(config.blob.pendingTtlHours)]
      );

      for (const { id } of stale.rows) {
        await blobStore.remove(id).catch((err) =>
          console.error(`blob unlink ${id} failed:`, err.message)
        );
      }

      if (stale.rowCount > 0) console.log(`blob reaper removed ${stale.rowCount}`);
    } catch (err) {
      console.error('blob reaper failed:', err.message);
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

export default router;
