import 'dotenv/config';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

import { startServer, stopServer } from './helpers/server.js';
import { TestUser, call, initCrypto } from './helpers/client.js';

/**
 * WebAuthn second factor (ROADMAP #5).
 *
 * The registration and assertion ceremonies themselves are the audited
 * @simplewebauthn library's job and need a real authenticator to exercise; there
 * is no value in re-testing them. What these tests pin is OUR contract around
 * them, and the one property that must never regress:
 *
 *   once a credential is enrolled, a correct password alone does not log you in.
 *
 * To get a credential in place without an authenticator we insert one directly.
 * That is legitimate here -- we are testing the gate, not the ceremony -- and it
 * lets us prove the login flow withholds the session token and demands an
 * assertion, then restores normal login once the credential is removed.
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

async function seedCredential(userId) {
  const id = crypto.randomBytes(20).toString('base64url');
  await db.query(
    `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, label)
     VALUES ($1, $2, $3, 0, 'test key')`,
    [id, userId, Buffer.from(crypto.randomBytes(65))]
  );
  return id;
}

describe('2FA enrollment', () => {
  test('a fresh account has 2FA disabled', async () => {
    const user = new TestUser();
    await user.register();
    const status = await user.twoFactorStatus();
    assert.equal(status.enabled, false);
    assert.deepEqual(status.credentials, []);
  });

  test('registration options require a session', async () => {
    await assert.rejects(
      () => call('/account/2fa/register/options', { method: 'POST' }),
      (err) => err.status === 401
    );
  });

  test('registration options are issued with a challenge token', async () => {
    const user = new TestUser();
    await user.register();
    const { options, challengeToken } = await user.twoFactorRegisterOptions();
    assert.ok(challengeToken, 'a challenge token is returned');
    assert.ok(options.challenge, 'options carry a challenge');
    assert.ok(options.rp?.id, 'options name the relying party');
  });
});

describe('2FA gates login', () => {
  test('with a credential enrolled, password alone yields a challenge, not a token', async () => {
    const user = new TestUser();
    await user.register();
    await seedCredential(user.userId);

    const res = await user.loginRaw();
    assert.equal(res.twoFactorRequired, true);
    assert.equal(res.token, undefined, 'no session token is handed out');
    assert.ok(res.challengeToken);
    assert.ok(Array.isArray(res.options.allowCredentials));
    assert.ok(res.options.allowCredentials.length >= 1);
  });

  test('a bogus assertion does not complete login', async () => {
    const user = new TestUser();
    await user.register();
    const credId = await seedCredential(user.userId);

    const res = await user.loginRaw();
    assert.equal(res.twoFactorRequired, true);

    // A structurally-present but cryptographically-empty assertion must fail.
    await assert.rejects(
      () =>
        user.completeTwoFactor(res.challengeToken, {
          id: credId,
          rawId: credId,
          type: 'public-key',
          response: { clientDataJSON: '', authenticatorData: '', signature: '' },
          clientExtensionResults: {},
        }),
      (err) => err.status === 401
    );
  });

  test('removing the last credential restores normal login', async () => {
    const user = new TestUser();
    await user.register();
    const credId = await seedCredential(user.userId);

    let res = await user.loginRaw();
    assert.equal(res.twoFactorRequired, true);

    await user.removeCredential(credId);

    res = await user.loginRaw();
    assert.ok(res.token, 'a session token is issued again');
    assert.equal(res.twoFactorRequired, undefined);
  });
});
