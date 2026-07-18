import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { joinLimiter, apiLimiter } from '../middleware/security.js';
import { notifyMemberJoined, notifyMemberLeft } from '../ws/relay.js';
import { entitlementsFor } from '../lib/entitlements.js';

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The other member of a DM `userId` belongs to, or null if this is not a DM the
// user is in. Used by block/unblock so those act on "the person on the other
// side" without the client having to name them -- and so they cannot be aimed at
// a group channel or one the caller is not part of.
async function otherDmMember(channelId, userId) {
  if (!UUID_RE.test(channelId)) return null;
  const r = await pool.query(
    `SELECT other.user_id
       FROM channels c
       JOIN channel_members me    ON me.channel_id = c.id AND me.user_id = $2
       JOIN channel_members other ON other.channel_id = c.id AND other.user_id != $2
      WHERE c.id = $1 AND c.type = 'dm'`,
    [channelId, userId]
  );
  return r.rows[0]?.user_id ?? null;
}

router.post('/create', apiLimiter, requireAuth, async (req, res, next) => {
  const incognito = req.body?.incognito === true;

  // Incognito channels are a supporter feature. Checked before allocating a
  // code so a free user never gets a half-created channel back.
  if (incognito) {
    const ent = await entitlementsFor(req.userId);
    if (!ent.premium) {
      return res.status(403).json({ error: 'incognito channels are a supporter feature' });
    }
  }

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
        `INSERT INTO channels (code, created_by, code_expires_at, incognito)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, code_expires_at, incognito`,
        [code, req.userId, String(config.channelCodeTtlHours), incognito]
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
      incognito: channel.incognito,
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
      'SELECT id, code_expires_at, incognito, type FROM channels WHERE code = $1',
      [code]
    );
    // A DM carries a code too (the NOT NULL column), but it must never be
    // joinable that way -- it is 1:1 by construction. Report "not found" rather
    // than a distinct error, so a leaked DM code does not even confirm the DM
    // exists.
    if (channel.rowCount === 0 || channel.rows[0].type === 'dm') {
      return res.status(404).json({ error: 'channel not found' });
    }

    const { id: channelId, code_expires_at: expiresAt, incognito } = channel.rows[0];
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
      incognito,
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
      `SELECT c.id, c.code, c.code_expires_at, c.created_at, c.incognito, c.type, cm.joined_at,
              (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count,
              (SELECT x.user_id FROM channel_members x
                WHERE x.channel_id = c.id AND x.user_id != $1 LIMIT 1) AS peer_id,
              EXISTS (
                SELECT 1 FROM dm_blocks b
                 WHERE b.blocker_id = $1
                   AND b.blocked_id = (SELECT x2.user_id FROM channel_members x2
                                        WHERE x2.channel_id = c.id AND x2.user_id != $1 LIMIT 1)
              ) AS blocked
       FROM channel_members cm
       JOIN channels c ON c.id = cm.channel_id
       WHERE cm.user_id = $1
       ORDER BY cm.joined_at DESC`,
      [req.userId]
    );
    res.json({
      channels: result.rows.map((r) => ({
        channelId: r.id,
        // A DM's code is an unused artifact of the NOT NULL column; never surface
        // it, so the DM UI cannot present a "share this code" affordance.
        code: r.type === 'dm' ? '' : r.code,
        codeExpiresAt: r.code_expires_at,
        createdAt: r.created_at,
        joinedAt: r.joined_at,
        incognito: r.incognito,
        type: r.type,
        memberCount: Number(r.member_count),
        // Peer identity and block state are meaningful only for a DM.
        ...(r.type === 'dm' ? { peerId: r.peer_id, blocked: r.blocked === true } : {}),
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
    const removed = await pool.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.channelId, req.userId]
    );
    await pool.query(
      'DELETE FROM message_queue WHERE channel_id = $1 AND recipient_id = $2',
      [req.params.channelId, req.userId]
    );

    // Tell the remaining members someone left -- anonymously. Only when a
    // membership row was actually removed, so a repeated leave does not emit a
    // phantom event.
    if (removed.rowCount > 0) notifyMemberLeft(req.params.channelId);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Open (or re-open) a 1:1 direct message with another user.
//
// Unlike /create + /join, there is no code to exchange: the initiator already
// knows the peer (they right-clicked them in a shared channel), so the server
// just materialises the pair's DM and adds both members. Idempotent on dm_key --
// a second call returns the same room. The initiator's client then mints the
// channel key and wraps it for the peer over the relay, exactly as a group join
// does. The server never holds the key.
router.post('/dm', apiLimiter, requireAuth, async (req, res, next) => {
  const peerId = String(req.body?.peerId || '');
  if (!UUID_RE.test(peerId)) return res.status(400).json({ error: 'invalid peer' });
  if (peerId === req.userId) return res.status(400).json({ error: 'cannot DM yourself' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const peer = await client.query(
      'SELECT id, pubkey, sign_pubkey FROM users WHERE id = $1',
      [peerId]
    );
    if (peer.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no such user' });
    }

    // A blocked user cannot open a new DM with the blocker. Symmetric knowledge
    // is deliberate: we do not say *who* blocked whom, only that it cannot start.
    const blocked = await client.query(
      'SELECT 1 FROM dm_blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [peerId, req.userId]
    );
    if (blocked.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'cannot start a direct message with this user' });
    }

    const dmKey = [req.userId, peerId].sort().join(':');

    let channelId = null;
    // Whether *this* call created the room. The initiator's client uses it to
    // decide whether to mint the channel key (new DM) or ask the peer for it
    // (the DM already existed but this device has no key).
    let created = false;
    const existing = await client.query('SELECT id FROM channels WHERE dm_key = $1', [dmKey]);
    if (existing.rowCount > 0) {
      channelId = existing.rows[0].id;
    } else {
      // Untargeted ON CONFLICT DO NOTHING covers both the code and dm_key unique
      // constraints. A miss is either a code collision (retry a fresh code) or a
      // concurrent creation of the same DM (re-read dm_key and use it).
      for (let attempt = 0; attempt < 5 && !channelId; attempt++) {
        const ins = await client.query(
          `INSERT INTO channels (code, created_by, type, dm_key)
           VALUES ($1, $2, 'dm', $3)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [generateCode(), req.userId, dmKey]
        );
        if (ins.rowCount > 0) {
          channelId = ins.rows[0].id;
          created = true;
        } else {
          const race = await client.query('SELECT id FROM channels WHERE dm_key = $1', [dmKey]);
          if (race.rowCount > 0) channelId = race.rows[0].id;
        }
      }
    }

    if (!channelId) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'could not allocate a channel, retry' });
    }

    // Both memberships, idempotently: re-DMing after one side left re-adds them.
    await client.query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [channelId, req.userId, peerId]
    );

    await client.query('COMMIT');

    res.json({
      channelId,
      type: 'dm',
      created,
      peer: {
        userId: peerId,
        pubkey: peer.rows[0].pubkey,
        signPubkey: peer.rows[0].sign_pubkey,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Block the other member of a DM: their DM messages stop reaching me (enforced
// in the relay's send path) and they cannot open a fresh DM with me. Delete
// unblocks. Both act on "the person on the other side", resolved server-side, so
// a client cannot aim a block at an arbitrary user id.
router.post('/:channelId/block', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const other = await otherDmMember(req.params.channelId, req.userId);
    if (!other) return res.status(404).json({ error: 'not a direct message' });
    await pool.query(
      'INSERT INTO dm_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, other]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:channelId/block', apiLimiter, requireAuth, async (req, res, next) => {
  try {
    const other = await otherDmMember(req.params.channelId, req.userId);
    if (!other) return res.status(404).json({ error: 'not a direct message' });
    await pool.query(
      'DELETE FROM dm_blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [req.userId, other]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
