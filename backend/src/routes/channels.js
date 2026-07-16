import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { joinLimiter, apiLimiter } from '../middleware/security.js';
import { notifyMemberJoined } from '../ws/relay.js';

const router = Router();

// Crockford base32 minus I, L, O, U: no character pairs a human can misread
// when retyping a code, and no accidental words.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

function generateCode() {
  // Rejection sampling. The old implementation did
  // randomBytes(5).toString('base64url').toUpperCase(), which folded the
  // case-sensitive base64url alphabet onto uppercase -- collapsing ~40 bits to
  // far fewer, mapping distinct codes onto each other, and leaving '-' and '_'
  // in a code presented as uppercase.
  const out = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH)) {
      if (byte < 256 - (256 % ALPHABET.length)) {
        out.push(ALPHABET[byte % ALPHABET.length]);
        if (out.length === CODE_LENGTH) break;
      }
    }
  }
  return out.join('');
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

router.post('/create', apiLimiter, requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let channel = null;
    for (let attempt = 0; attempt < 5 && !channel; attempt++) {
      const code = generateCode();
      // Let the UNIQUE constraint arbitrate instead of SELECT-then-INSERT,
      // which races. The old loop also fell through and inserted a known
      // duplicate after 5 clashes, turning a retry into a 500.
      const inserted = await client.query(
        `INSERT INTO channels (code, created_by, code_expires_at)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, code_expires_at`,
        [code, req.userId, String(config.channelCodeTtlHours)]
      );
      if (inserted.rowCount > 0) channel = inserted.rows[0];
    }

    if (!channel) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'could not allocate channel code, retry' });
    }

    await client.query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)',
      [channel.id, req.userId]
    );

    await client.query('COMMIT');

    res.json({
      channelId: channel.id,
      code: channel.code,
      codeExpiresAt: channel.code_expires_at,
      members: [],
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// body: { code } -> membership + the public keys needed to receive a wrapped
// channel key. The key itself is never here: an existing member wraps it
// client-side and relays it.
router.post('/join', joinLimiter, requireAuth, async (req, res, next) => {
  try {
    const code = normalizeCode(req.body?.code);
    if (!CODE_RE.test(code)) {
      return res.status(400).json({ error: 'invalid code format' });
    }

    const channel = await pool.query(
      'SELECT id, code_expires_at FROM channels WHERE code = $1',
      [code]
    );
    if (channel.rowCount === 0) {
      return res.status(404).json({ error: 'channel not found' });
    }

    const { id: channelId, code_expires_at: expiresAt } = channel.rows[0];
    if (expiresAt && new Date(expiresAt) < new Date()) {
      return res.status(410).json({ error: 'channel code expired' });
    }

    const inserted = await pool.query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [channelId, req.userId]
    );
    const isNewMember = inserted.rowCount > 0;

    const members = await pool.query(
      `SELECT u.id, u.pubkey, u.sign_pubkey FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1 AND u.id != $2`,
      [channelId, req.userId]
    );

    const self = await pool.query('SELECT pubkey, sign_pubkey FROM users WHERE id = $1', [req.userId]);

    if (isNewMember) {
      // Wake existing members so one of them wraps the channel key for this
      // joiner. If nobody is online, the joiner waits: the server has no key
      // to hand over on its own.
      notifyMemberJoined(channelId, {
        userId: req.userId,
        pubkey: self.rows[0].pubkey,
        signPubkey: self.rows[0].sign_pubkey,
      });
    }

    res.json({
      channelId,
      code,
      isNewMember,
      members: members.rows.map((m) => ({
        userId: m.id,
        pubkey: m.pubkey,
        signPubkey: m.sign_pubkey,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Channels this user belongs to. Server-side truth for membership; the client
// still needs a local key per channel to read anything.
router.get('/list', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.code, c.code_expires_at, c.created_at, cm.joined_at,
              (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count
       FROM channel_members cm
       JOIN channels c ON c.id = cm.channel_id
       WHERE cm.user_id = $1
       ORDER BY cm.joined_at DESC`,
      [req.userId]
    );
    res.json({
      channels: result.rows.map((r) => ({
        channelId: r.id,
        code: r.code,
        codeExpiresAt: r.code_expires_at,
        createdAt: r.created_at,
        joinedAt: r.joined_at,
        memberCount: Number(r.member_count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:channelId/members', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.params;

    // Membership check first: without it this endpoint leaks the public keys
    // and roster of any channel whose UUID leaks.
    const member = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, req.userId]
    );
    if (member.rowCount === 0) return res.status(404).json({ error: 'channel not found' });

    const members = await pool.query(
      `SELECT u.id, u.pubkey, u.sign_pubkey, cm.joined_at FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1`,
      [channelId]
    );

    res.json({
      members: members.rows.map((m) => ({
        userId: m.id,
        pubkey: m.pubkey,
        signPubkey: m.sign_pubkey,
        joinedAt: m.joined_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:channelId/rotate-code', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const member = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, req.userId]
    );
    if (member.rowCount === 0) return res.status(404).json({ error: 'channel not found' });

    const code = generateCode();
    const updated = await pool.query(
      `UPDATE channels SET code = $1, code_expires_at = now() + ($2 || ' hours')::interval
       WHERE id = $3 RETURNING code, code_expires_at`,
      [code, String(config.channelCodeTtlHours), channelId]
    );
    res.json({ code: updated.rows[0].code, codeExpiresAt: updated.rows[0].code_expires_at });
  } catch (err) {
    next(err);
  }
});

router.delete('/:channelId/leave', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.channelId, req.userId]
    );
    await pool.query(
      'DELETE FROM message_queue WHERE channel_id = $1 AND recipient_id = $2',
      [req.params.channelId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
