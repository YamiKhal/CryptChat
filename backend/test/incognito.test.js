import 'dotenv/config';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { startServer, stopServer } from './helpers/server.js';
import { TestUser, call, initCrypto } from './helpers/client.js';

/**
 * Incognito channels (ROADMAP #7).
 *
 * The security-relevant contract here is the gate: incognito is a supporter
 * feature, so a free account must not be able to create one. The rest (colours,
 * no names) is client-side rendering, tested in the frontend. We seed premium
 * directly rather than run a real checkout -- billing is off in the test server.
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

async function makePremium(userId) {
  await db.query(
    `INSERT INTO entitlements (user_id, status, expires_at, kind)
     VALUES ($1, 'active', now() + interval '1 month', 'subscription')`,
    [userId]
  );
}

describe('incognito creation gate', () => {
  test('a free account cannot create an incognito channel', async () => {
    const user = new TestUser();
    await user.register();

    await assert.rejects(
      () => call('/channel/create', { method: 'POST', token: user.token, body: { incognito: true } }),
      (err) => err.status === 403
    );
  });

  test('a free account can still create a normal channel', async () => {
    const user = new TestUser();
    await user.register();
    const res = await call('/channel/create', { method: 'POST', token: user.token, body: {} });
    assert.equal(res.incognito, false);
  });

  test('a premium account can create an incognito channel', async () => {
    const user = new TestUser();
    await user.register();
    await makePremium(user.userId);

    const res = await call('/channel/create', {
      method: 'POST',
      token: user.token,
      body: { incognito: true },
    });
    assert.equal(res.incognito, true);
  });
});

describe('incognito flag propagation', () => {
  test('the flag shows up in the channel list', async () => {
    const user = new TestUser();
    await user.register();
    await makePremium(user.userId);

    const created = await call('/channel/create', {
      method: 'POST',
      token: user.token,
      body: { incognito: true },
    });

    const list = await user.listChannels();
    const found = list.channels.find((c) => c.channelId === created.channelId);
    assert.ok(found, 'the channel is in the list');
    assert.equal(found.incognito, true);
  });

  test('a joiner learns the channel is incognito', async () => {
    const owner = new TestUser();
    await owner.register();
    await makePremium(owner.userId);
    const created = await call('/channel/create', {
      method: 'POST',
      token: owner.token,
      body: { incognito: true },
    });

    const joiner = new TestUser();
    await joiner.register();
    const res = await call('/channel/join', {
      method: 'POST',
      token: joiner.token,
      body: { code: created.code },
    });
    assert.equal(res.incognito, true);
  });
});
