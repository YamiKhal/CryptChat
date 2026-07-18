import 'dotenv/config';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { startServer, stopServer } from './helpers/server.js';
import { TestUser, call, initCrypto } from './helpers/client.js';

/**
 * Direct messages: creation, blocking, and leave.
 *
 * The security-relevant contracts:
 *  - a DM is 1:1 and cannot be joined by its code (so a leaked code is inert);
 *  - creation is idempotent per pair;
 *  - a blocked user cannot open a new DM and their messages are not delivered;
 *  - leaving removes only the leaver's own membership.
 */

let db;

before(async () => {
  await initCrypto();
  await startServer();
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

after(async () => {
  await db?.end();
  await stopServer();
});

const dm = (user, peerId) =>
  call('/channel/dm', { method: 'POST', token: user.token, body: { peerId } });

async function pair() {
  const a = new TestUser();
  const b = new TestUser();
  await a.register();
  await b.register();
  return { a, b };
}

// A base64url ciphertext/nonce the relay will accept and route. It never gets
// decrypted here -- routing is what these tests exercise.
const CT = 'A'.repeat(64);
const NONCE = 'B'.repeat(24);

describe('DM creation', () => {
  test('creates a 1:1 channel and returns the peer keys', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    assert.equal(res.type, 'dm');
    assert.equal(res.created, true);
    assert.equal(res.peer.userId, b.userId);
    assert.ok(res.peer.pubkey && res.peer.signPubkey);
  });

  test('is idempotent per pair -- a second call returns the same room', async () => {
    const { a, b } = await pair();
    const first = await dm(a, b.userId);
    const second = await dm(a, b.userId);
    assert.equal(second.channelId, first.channelId);
    assert.equal(second.created, false);
  });

  test('the same pair maps to one DM regardless of who starts it', async () => {
    const { a, b } = await pair();
    const fromA = await dm(a, b.userId);
    const fromB = await dm(b, a.userId);
    assert.equal(fromB.channelId, fromA.channelId);
    assert.equal(fromB.created, false);
  });

  test('cannot DM yourself', async () => {
    const { a } = await pair();
    await assert.rejects(
      () => dm(a, a.userId),
      (err) => err.status === 400
    );
  });

  test('a DM shows up in the list as type dm with the peer', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    const list = await a.listChannels();
    const found = list.channels.find((c) => c.channelId === res.channelId);
    assert.ok(found);
    assert.equal(found.type, 'dm');
    assert.equal(found.peerId, b.userId);
    assert.equal(found.code, ''); // the DM's code is never surfaced
  });

  test('a DM cannot be joined by its code', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    // Reach past the API for the code (it is deliberately never returned).
    const row = await db.query('SELECT code FROM channels WHERE id = $1', [res.channelId]);
    const code = row.rows[0].code;

    const outsider = new TestUser();
    await outsider.register();
    await assert.rejects(
      () => call('/channel/join', { method: 'POST', token: outsider.token, body: { code } }),
      (err) => err.status === 404
    );
  });
});

describe('blocking', () => {
  test('a blocked user cannot open a new DM with the blocker', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    // A blocks B.
    await call(`/channel/${res.channelId}/block`, { method: 'POST', token: a.token });

    // Fresh pair with no existing room would still be blockable; here B tries to
    // (re-)initiate against A and is refused.
    await assert.rejects(
      () => dm(b, a.userId),
      (err) => err.status === 403
    );
  });

  test("a blocked sender's DM message is not delivered", async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);

    // B blocks A, then both connect.
    await call(`/channel/${res.channelId}/block`, { method: 'POST', token: b.token });
    await a.connectRelay();
    await b.connectRelay();

    a.sendRelay({
      type: 'send',
      channelId: res.channelId,
      clientId: crypto.randomUUID(),
      ciphertext: CT,
      nonce: NONCE,
    });

    const blocked = await b.expectNoRelay(
      (m) => m.type === 'message' && m.channelId === res.channelId,
      { window: 600 }
    );
    assert.equal(blocked, true, 'the blocker received nothing');

    a.closeRelay();
    b.closeRelay();
  });

  test('unblocking restores delivery', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    await call(`/channel/${res.channelId}/block`, { method: 'POST', token: b.token });
    await call(`/channel/${res.channelId}/block`, { method: 'DELETE', token: b.token });

    await a.connectRelay();
    await b.connectRelay();

    a.sendRelay({
      type: 'send',
      channelId: res.channelId,
      clientId: crypto.randomUUID(),
      ciphertext: CT,
      nonce: NONCE,
    });

    const got = await b.waitForRelay(
      (m) => m.type === 'message' && m.channelId === res.channelId
    );
    assert.equal(got.senderId, a.userId);

    a.closeRelay();
    b.closeRelay();
  });
});

describe('leaving a DM', () => {
  test('removes only the leaver -- the other side keeps the DM', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);

    await call(`/channel/${res.channelId}/leave`, { method: 'DELETE', token: b.token });

    const aList = await a.listChannels();
    assert.ok(
      aList.channels.some((c) => c.channelId === res.channelId),
      'A still has the DM'
    );

    const bList = await b.listChannels();
    assert.ok(
      !bList.channels.some((c) => c.channelId === res.channelId),
      'B no longer has the DM'
    );
  });

  test('re-opening after leaving re-adds membership to the same room', async () => {
    const { a, b } = await pair();
    const res = await dm(a, b.userId);
    await call(`/channel/${res.channelId}/leave`, { method: 'DELETE', token: b.token });

    const reopened = await dm(b, a.userId);
    assert.equal(reopened.channelId, res.channelId);
    const bList = await b.listChannels();
    assert.ok(bList.channels.some((c) => c.channelId === res.channelId));
  });
});
