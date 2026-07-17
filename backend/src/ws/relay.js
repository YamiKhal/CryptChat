import { WebSocketServer } from 'ws';
import { pool } from '../db.js';
import { config } from '../config.js';
import { verifyToken, epochValid } from '../middleware/auth.js';

// userId -> Set<ws>. A Set, not a single socket: the old Map held one socket
// per user, so opening a second tab silently evicted the first tab's delivery
// path while leaving its socket open and mute.
const connections = new Map();

function socketsFor(userId) {
  return connections.get(userId) ?? new Set();
}

function addConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(userId);
}

function sendTo(userId, payload) {
  const data = JSON.stringify(payload);
  let delivered = false;
  for (const ws of socketsFor(userId)) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      delivered = true;
    }
  }
  return delivered;
}

/**
 * Drop every live socket for an account.
 *
 * The handshake epoch check only gates *new* connections. A socket opened before
 * a password reset stays open and keeps receiving relayed messages -- the reset
 * would lock an attacker out of HTTP while leaving them subscribed to the very
 * conversations it was meant to protect. Called by the reset path.
 *
 * 4001 rather than a normal close so the client can tell "your session was
 * revoked" from "the network blipped" and prompt for a password instead of
 * silently reconnecting in a loop.
 */
export function disconnectUser(userId) {
  for (const ws of socketsFor(userId)) {
    try {
      ws.close(4001, 'session expired');
    } catch {
      // Already closing; the close handler cleans up the registry.
    }
  }
}

const B64 = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The relay routes these; it cannot read any of them. 'reaction' is a separate
// kind rather than a mutation of a stored message because the relay holds no
// message to mutate -- it holds ciphertext addressed to a recipient. The client
// folds reactions into the target when it decrypts them.
const KINDS = new Set(['message', 'profile', 'reaction']);

function validCiphertext(value, max = config.limits.maxEnvelopeBytes) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && B64.test(value);
}

function validNonce(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 64 && B64.test(value);
}

// Per-socket token bucket. Membership checks hit the database on every frame,
// so an unthrottled socket is a database amplifier.
function makeBucket({ capacity, refillPerSec }) {
  let tokens = capacity;
  let last = Date.now();
  return function take() {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function originAllowed(origin) {
  if (!origin) return !config.isProd;
  if (config.allowedOrigins.includes('*') && !config.isProd) return true;
  return config.allowedOrigins.includes(origin);
}

function extractToken(req) {
  // Preferred: Sec-WebSocket-Protocol. A token in the query string lands in
  // access logs, proxy logs, and Referer headers; a subprotocol value does not.
  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    for (const part of proto.split(',').map((p) => p.trim())) {
      if (part.startsWith('bearer.')) return part.slice('bearer.'.length);
    }
  }
  return null;
}

export function attachRelay(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.limits.maxEnvelopeBytes + 4096,

    // Browsers do not apply the same-origin policy to WebSockets and will
    // happily attach the user's credentials to a socket opened by any site.
    // Rejecting unknown origins at the handshake is what closes cross-site
    // WebSocket hijacking.
    verifyClient(info, done) {
      if (!originAllowed(info.origin)) return done(false, 403, 'origin not allowed');

      const token = extractToken(info.req);
      if (!token) return done(false, 401, 'missing token');

      // Verify here, not in the connection handler. Checking only that a token
      // is *present* lets an invalid one complete the handshake and allocate a
      // socket before being closed -- an unauthenticated caller should never
      // get that far.
      let claims;
      try {
        claims = verifyToken(token);
      } catch {
        return done(false, 401, 'invalid token');
      }

      // The signature being valid is not enough: a token from before a password
      // reset still verifies. `done` may be called asynchronously, so the epoch
      // check happens here rather than after the socket is allocated.
      epochValid(claims)
        .then((ok) => {
          if (!ok) return done(false, 401, 'session expired');
          info.req.userId = claims.sub;
          done(true);
        })
        .catch(() => done(false, 500, 'internal error'));
    },

    handleProtocols(protocols) {
      return protocols.has('darkchat') ? 'darkchat' : false;
    },
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws, req) => {
    // Set by verifyClient, which already rejected anything unverifiable.
    const userId = req.userId;
    if (!userId) {
      ws.close(4001, 'invalid token');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const take = makeBucket({ capacity: 40, refillPerSec: 8 });

    addConnection(userId, ws);

    try {
      await flushQueue(userId, ws);
      await flushKeyOffers(userId, ws);
    } catch (err) {
      console.error('flush failed:', err.message);
    }

    ws.on('message', async (raw) => {
      if (!take()) {
        ws.close(4029, 'rate limit');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      try {
        switch (msg.type) {
          case 'send':        return await handleSend(userId, msg, ws);
          case 'ack':         return await handleAck(userId, msg);
          case 'key-offer':       return await handleKeyOffer(userId, msg, ws);
          case 'key-ack':         return await handleKeyAck(userId, msg);
          case 'request-key':     return await handleRequestKey(userId, msg);
          case 'request-profile': return await handleRequestProfile(userId, msg);
          default:                return;
        }
      } catch (err) {
        console.error(`relay ${msg.type} failed:`, err.message);
      }
    });

    ws.on('close', () => removeConnection(userId, ws));
    ws.on('error', () => removeConnection(userId, ws));
  });
}

async function isMember(channelId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  return r.rowCount > 0;
}

async function handleSend(senderId, msg, ws) {
  const { channelId, ciphertext, nonce } = msg;
  const kind = KINDS.has(msg.kind) ? msg.kind : 'message';

  if (!UUID.test(channelId ?? '') || !validCiphertext(ciphertext) || !validNonce(nonce)) {
    return;
  }
  if (!(await isMember(channelId, senderId))) return;

  const members = await pool.query(
    'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
    [channelId, senderId]
  );

  for (const { user_id: recipientId } of members.rows) {
    const backlog = await pool.query(
      'SELECT count(*)::int AS n FROM message_queue WHERE recipient_id = $1',
      [recipientId]
    );
    if (backlog.rows[0].n >= config.limits.maxQueuePerRecipient) continue;

    // One row per recipient, each carrying recipient_id. The old code inserted
    // per-member rows with no recipient, then flushed by joining
    // channel_members -- so every member received every row, N times over, and
    // could delete rows addressed to anyone else.
    const inserted = await pool.query(
      `INSERT INTO message_queue (channel_id, sender_id, recipient_id, ciphertext, nonce, kind)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [channelId, senderId, recipientId, ciphertext, nonce, kind]
    );
    const queued = inserted.rows[0];

    sendTo(recipientId, {
      type: 'message',
      messageId: queued.id,
      channelId,
      senderId,
      kind,
      ciphertext,
      nonce,
      createdAt: queued.created_at,
    });
  }

  if (msg.clientId) {
    ws.send(JSON.stringify({ type: 'sent', clientId: msg.clientId, channelId }));
  }
}

async function handleAck(userId, msg) {
  if (!UUID.test(msg.messageId ?? '')) return;
  // The recipient_id predicate is the whole point. Previously this was
  // DELETE ... WHERE id = $1 with no ownership check, so any authenticated
  // user could destroy any other user's undelivered messages by id -- and
  // flushQueue handed out everyone's ids.
  await pool.query(
    'DELETE FROM message_queue WHERE id = $1 AND recipient_id = $2',
    [msg.messageId, userId]
  );
}

// A member wraps the channel key with crypto_box for a specific joiner. The
// server routes the ciphertext and stores it if the joiner is offline. It
// cannot open it.
async function handleKeyOffer(senderId, msg, ws) {
  const { channelId, recipientId, ciphertext, nonce } = msg;

  if (!UUID.test(channelId ?? '') || !UUID.test(recipientId ?? '')) return;
  if (!validCiphertext(ciphertext, 4096) || !validNonce(nonce)) return;
  if (recipientId === senderId) return;

  if (!(await isMember(channelId, senderId))) return;
  if (!(await isMember(channelId, recipientId))) return;

  const inserted = await pool.query(
    `INSERT INTO key_offers (channel_id, sender_id, recipient_id, ciphertext, nonce)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, sender_id, recipient_id)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, created_at = now()
     RETURNING id, created_at`,
    [channelId, senderId, recipientId, ciphertext, nonce]
  );
  const offer = inserted.rows[0];

  const sender = await pool.query('SELECT pubkey, sign_pubkey FROM users WHERE id = $1', [senderId]);

  sendTo(recipientId, {
    type: 'key-offer',
    offerId: offer.id,
    channelId,
    senderId,
    senderPubkey: sender.rows[0].pubkey,
    senderSignPubkey: sender.rows[0].sign_pubkey,
    ciphertext,
    nonce,
    createdAt: offer.created_at,
  });

  ws.send(JSON.stringify({ type: 'key-offer-sent', channelId, recipientId }));
}

async function handleKeyAck(userId, msg) {
  if (!UUID.test(msg.offerId ?? '')) return;
  await pool.query(
    'DELETE FROM key_offers WHERE id = $1 AND recipient_id = $2',
    [msg.offerId, userId]
  );
}

// A member with no local key asks the channel for one (new device, cleared
// storage). Only reaches members who are online and hold the key.
async function handleRequestKey(userId, msg) {
  const { channelId } = msg;
  if (!UUID.test(channelId ?? '')) return;
  if (!(await isMember(channelId, userId))) return;

  const self = await pool.query('SELECT pubkey, sign_pubkey FROM users WHERE id = $1', [userId]);
  const members = await pool.query(
    'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
    [channelId, userId]
  );

  for (const { user_id: memberId } of members.rows) {
    sendTo(memberId, {
      type: 'key-request',
      channelId,
      requesterId: userId,
      requesterPubkey: self.rows[0].pubkey,
      requesterSignPubkey: self.rows[0].sign_pubkey,
    });
  }
}

// A member who just installed a channel key asks the others to re-send their
// profiles.
//
// Profiles fan out to whoever is a member at send time, so a joiner misses
// every profile broadcast that happened before it arrived -- it would see
// names (those ride in each message envelope) but never avatars. This lets the
// joiner pull them once, on demand, instead of members re-broadcasting on a
// timer. The server relays the request; the profiles themselves stay
// end-to-end encrypted.
async function handleRequestProfile(userId, msg) {
  const { channelId } = msg;
  if (!UUID.test(channelId ?? '')) return;
  if (!(await isMember(channelId, userId))) return;

  const members = await pool.query(
    'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
    [channelId, userId]
  );

  for (const { user_id: memberId } of members.rows) {
    sendTo(memberId, { type: 'profile-request', channelId, requesterId: userId });
  }
}

// Called from the join route so existing members can wrap the key immediately
// rather than on the joiner's next reconnect.
export function notifyMemberJoined(channelId, joiner) {
  pool
    .query('SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2', [
      channelId,
      joiner.userId,
    ])
    .then(({ rows }) => {
      for (const { user_id: memberId } of rows) {
        sendTo(memberId, {
          type: 'member-joined',
          channelId,
          userId: joiner.userId,
          pubkey: joiner.pubkey,
          signPubkey: joiner.signPubkey,
        });
      }
    })
    .catch((err) => console.error('notifyMemberJoined failed:', err.message));
}

async function flushQueue(userId, ws) {
  const pending = await pool.query(
    `SELECT id, channel_id, sender_id, ciphertext, nonce, kind, created_at
     FROM message_queue
     WHERE recipient_id = $1
     ORDER BY created_at ASC
     LIMIT 1000`,
    [userId]
  );

  for (const row of pending.rows) {
    ws.send(JSON.stringify({
      type: 'message',
      messageId: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      kind: row.kind,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      createdAt: row.created_at,
    }));
  }
}

async function flushKeyOffers(userId, ws) {
  const pending = await pool.query(
    `SELECT ko.id, ko.channel_id, ko.sender_id, ko.ciphertext, ko.nonce, ko.created_at,
            u.pubkey, u.sign_pubkey
     FROM key_offers ko
     JOIN users u ON u.id = ko.sender_id
     WHERE ko.recipient_id = $1
     ORDER BY ko.created_at ASC`,
    [userId]
  );

  for (const row of pending.rows) {
    ws.send(JSON.stringify({
      type: 'key-offer',
      offerId: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      senderPubkey: row.pubkey,
      senderSignPubkey: row.sign_pubkey,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      createdAt: row.created_at,
    }));
  }
}

// Undelivered mail is not an archive. Anything past the TTL is dropped so the
// queue cannot be farmed as storage or subpoenaed as history.
export function startQueueReaper() {
  const run = async () => {
    try {
      await pool.query(
        `DELETE FROM message_queue WHERE created_at < now() - ($1 || ' hours')::interval`,
        [String(config.queueTtlHours)]
      );
      await pool.query(
        `DELETE FROM key_offers WHERE created_at < now() - ($1 || ' hours')::interval`,
        [String(config.queueTtlHours)]
      );
      await pool.query(
        `DELETE FROM login_attempts WHERE updated_at < now() - interval '24 hours'`
      );
    } catch (err) {
      console.error('queue reaper failed:', err.message);
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
