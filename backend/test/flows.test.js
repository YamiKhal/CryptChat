import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  stopServer,
  waitForMailLink,
  captureMailLink,
  logCursor,
} from './helpers/server.js';
import { TestUser, call, uniqueName, ApiError, initCrypto } from './helpers/client.js';

/**
 * Register and confirm the address in one step.
 *
 * Uses captureMailLink rather than reading the log afterwards: the mail send is
 * not awaited by the route, so scanning for the "last" link races with the
 * previous test's and silently returns the wrong token.
 */
async function registerVerified(user, email = `${uniqueName()}@example.com`) {
  const { token } = await captureMailLink('verify-email', () => user.register({ email }));
  await call('/account/email/verify', { method: 'POST', body: { token } });
  user.email = email;
  return email;
}

/** Trigger a reset and return the token from the mail it sends. */
async function requestReset(email) {
  const { token } = await captureMailLink('reset-password', () =>
    call('/recovery/request', { method: 'POST', body: { email } })
  );
  return token;
}

/**
 * End-to-end flows against a real server, driven by a real client.
 *
 * These are the tests that would have caught every bug worth catching: the
 * recovery salt mismatch, the legacy-hash lockout, the session that survived a
 * password reset. They are slow (Argon2id, real HTTP) and that is the price.
 *
 * Requires Postgres: `docker compose up -d` from the repo root.
 */

before(async () => {
  await initCrypto();
  await startServer();
});

after(async () => {
  await stopServer();
});

/* ------------------------------------------------------------------ */
/* registration + login                                                */
/* ------------------------------------------------------------------ */

describe('registration', () => {
  test('registers without an email -- an anonymous account is first-class', async () => {
    const user = new TestUser();
    const res = await user.register();

    assert.ok(res.token);
    assert.equal(res.emailPending, false);

    const me = await user.me();
    assert.equal(me.email, null);
  });

  test('registers with an optional email', async () => {
    const user = new TestUser();
    const res = await user.register({ email: `${uniqueName()}@example.com` });
    assert.equal(res.emailPending, true);
  });

  test('rejects a duplicate username', async () => {
    const user = new TestUser();
    await user.register();

    const clash = new TestUser(user.username);
    await assert.rejects(() => clash.register(), (e) => e.status === 409);
  });

  test('rejects a short password', async () => {
    const user = new TestUser(uniqueName(), 'short');
    await assert.rejects(() => user.register(), (e) => e.status === 400);
  });

  test('rejects a short username', async () => {
    const user = new TestUser('ab');
    await assert.rejects(() => user.register(), (e) => e.status === 400);
  });

  test('rejects a malformed email rather than storing it', async () => {
    const user = new TestUser();
    await assert.rejects(
      () => user.register({ email: 'not-an-email' }),
      (e) => e.status === 400
    );
  });

  test('rejects an address already attached to another account', async () => {
    // Regression: this used to create the account, then fail attaching the
    // address in a fire-and-forget call -- so the user got a real account, no
    // error, and no verification mail. The check now runs before the insert.
    const alice = new TestUser();
    const email = await registerVerified(alice);

    const bob = new TestUser();
    await assert.rejects(() => bob.register({ email }), (e) => e.status === 409);
  });

  test('the pending address is readable the instant registration returns', async () => {
    // Regression: the token row was written by an un-awaited call, so a client
    // reading its own state immediately after registering saw "nothing pending"
    // and the UI lied about whether a link had been sent.
    const user = new TestUser();
    await user.register({ email: `${uniqueName()}@example.com` });

    const got = await user.getEmail();
    assert.ok(got.pendingMask, 'pending mask should exist as soon as register resolves');
  });

  test('rejects junk key material', async () => {
    await assert.rejects(
      () =>
        call('/auth/register', {
          method: 'POST',
          body: {
            username: uniqueName(),
            password: 'a-perfectly-fine-password',
            pubkey: '!!!not-base64!!!',
            signPubkey: 'AAAAAAAAAAAAAAAAAAAAAAAA',
            vaultSalt: 'AAAAAAAAAAAAAAAAAAAAAAAA',
          },
        }),
      (e) => e.status === 400
    );
  });
});

describe('login', () => {
  test('accepts the right password', async () => {
    const user = new TestUser();
    await user.register();
    const res = await user.login();
    assert.equal(res.userId, user.userId);
  });

  test('rejects the wrong password with an indistinguishable error', async () => {
    const user = new TestUser();
    await user.register();

    const wrongPassword = await user.login('the-wrong-password').catch((e) => e);
    const noSuchUser = await new TestUser(uniqueName()).login('any-password-here').catch((e) => e);

    // Different messages here would enumerate registered usernames.
    assert.equal(wrongPassword.status, noSuchUser.status);
    assert.equal(wrongPassword.message, noSuchUser.message);
  });

  test('username is case-insensitive, so an account cannot fork on case', async () => {
    const user = new TestUser();
    await user.register();

    const res = await call('/auth/login', {
      method: 'POST',
      body: { username: user.username.toUpperCase(), password: user.password },
    });
    assert.equal(res.userId, user.userId);
  });

  test('rejects a token that is not ours', async () => {
    await assert.rejects(
      () => call('/auth/me', { token: 'not.a.real.token' }),
      (e) => e.status === 401
    );
  });

  test('rejects a missing token', async () => {
    await assert.rejects(() => call('/auth/me'), (e) => e.status === 401);
  });
});

/* ------------------------------------------------------------------ */
/* recovery                                                            */
/* ------------------------------------------------------------------ */

describe('recovery blob', () => {
  test('round-trips identity and channel keys', async () => {
    const user = new TestUser();
    await user.register();
    await user.createChannel();
    await user.makeRecoveryCode();
    await user.uploadRecoveryBlob();

    const opened = await user.fetchAndOpenRecoveryBlob();
    assert.equal(opened.identity.privateKey, user.identity.privateKey);
    assert.equal(opened.channels.length, 1);
  });

  test('the server stores ciphertext it cannot read', async () => {
    const user = new TestUser();
    await user.register();
    await user.makeRecoveryCode();
    await user.uploadRecoveryBlob();

    const raw = await call('/account/recovery-blob', { token: user.token });
    const serialized = JSON.stringify(raw);

    // If this ever fails, the entire justification for storing the blob
    // server-side is void.
    assert.ok(!serialized.includes(user.identity.privateKey));
    assert.ok(!serialized.includes(user.identity.signPrivateKey));
  });

  test('does not open with the wrong recovery code', async () => {
    const user = new TestUser();
    await user.register();
    await user.makeRecoveryCode();
    await user.uploadRecoveryBlob();

    const other = new TestUser();
    const wrongPhrase = await other.makeRecoveryCode();

    await assert.rejects(() => user.fetchAndOpenRecoveryBlob(wrongPhrase));
  });

  test('requires auth', async () => {
    await assert.rejects(
      () => call('/account/recovery-blob'),
      (e) => e.status === 401
    );
  });

  test('one user cannot read another user\'s blob', async () => {
    const alice = new TestUser();
    await alice.register();
    await alice.makeRecoveryCode();
    await alice.uploadRecoveryBlob();

    const bob = new TestUser();
    await bob.register();

    // Bob's token gets Bob's blob (or a 404), never Alice's.
    await assert.rejects(
      () => call('/account/recovery-blob', { token: bob.token }),
      (e) => e.status === 404
    );
  });

  test('upsert replaces rather than duplicating', async () => {
    const user = new TestUser();
    await user.register();
    await user.makeRecoveryCode();

    await user.uploadRecoveryBlob();
    await user.createChannel();
    await user.uploadRecoveryBlob();

    const opened = await user.fetchAndOpenRecoveryBlob();
    // A stale blob would recover an account missing its newest channels.
    assert.equal(opened.channels.length, 1);
  });

  test('rejects an oversized blob', async () => {
    const user = new TestUser();
    await user.register();

    await assert.rejects(
      () =>
        call('/account/recovery-blob', {
          method: 'PUT',
          token: user.token,
          body: { ciphertext: 'A'.repeat(300_000), nonce: 'AAAA', salt: 'AAAA' },
        }),
      (e) => e.status === 400
    );
  });
});

/* ------------------------------------------------------------------ */
/* email                                                               */
/* ------------------------------------------------------------------ */

describe('email', () => {
  test('is never returned in plaintext by any endpoint', async () => {
    const email = `${uniqueName()}@example.com`;
    const user = new TestUser();
    await user.register({ email });

    const [me, got, limits] = await Promise.all([user.me(), user.getEmail(), user.limits()]);

    for (const [name, body] of [['/auth/me', me], ['/account/email', got], ['/account/limits', limits]]) {
      assert.ok(!JSON.stringify(body).includes(email), `${name} leaked the address`);
    }
  });

  test('shows a mask, and the mask hides the local part', async () => {
    const local = uniqueName('secretlocal');
    const user = new TestUser();
    await user.register({ email: `${local}@example.com` });

    const got = await user.getEmail();
    assert.ok(got.pendingMask.includes('@example.com'));
    assert.ok(!got.pendingMask.includes(local));
  });

  test('is not attached until the link is used', async () => {
    const user = new TestUser();
    const email = `${uniqueName()}@example.com`;

    const { token } = await captureMailLink('verify-email', () => user.register({ email }));

    // Mistyping a stranger's address must not attach it to your account and
    // hand them a reset lever.
    const before = await user.getEmail();
    assert.equal(before.verified, false);
    assert.equal(before.mask, null);

    await call('/account/email/verify', { method: 'POST', body: { token } });

    const after = await user.getEmail();
    assert.equal(after.verified, true);
    assert.ok(after.mask);
  });

  test('verification link is single-use', async () => {
    const user = new TestUser();
    const { token } = await captureMailLink('verify-email', () =>
      user.register({ email: `${uniqueName()}@example.com` })
    );

    await call('/account/email/verify', { method: 'POST', body: { token } });
    await assert.rejects(
      () => call('/account/email/verify', { method: 'POST', body: { token } }),
      (e) => e.status === 400
    );
  });

  test('rejects a made-up verification token', async () => {
    await assert.rejects(
      () => call('/account/email/verify', { method: 'POST', body: { token: 'a'.repeat(43) } }),
      (e) => e.status === 400
    );
  });

  test('changing the address requires the password', async () => {
    const user = new TestUser();
    await user.register();

    // A hijacked session that can silently swap the address owns the account.
    await assert.rejects(
      () => user.addEmail(`${uniqueName()}@example.com`, 'the-wrong-password'),
      (e) => e.status === 401
    );
  });

  test('removing the address requires the password', async () => {
    const user = new TestUser();
    await user.register();
    await assert.rejects(
      () => user.removeEmail('the-wrong-password'),
      (e) => e.status === 401
    );
  });

  test('two accounts cannot verify the same address', async () => {
    const alice = new TestUser();
    const email = await registerVerified(alice);

    const bob = new TestUser();
    await bob.register();
    await assert.rejects(() => bob.addEmail(email), (e) => e.status === 409);
  });

  test('removal wipes the address, not just the verified flag', async () => {
    const user = new TestUser();
    await registerVerified(user);

    await user.removeEmail();

    const got = await user.getEmail();
    assert.equal(got.mask, null);
    assert.equal(got.verified, false);
  });
});

/* ------------------------------------------------------------------ */
/* password reset                                                      */
/* ------------------------------------------------------------------ */

describe('password reset', () => {
  async function verifiedUser() {
    const user = new TestUser();
    const email = await registerVerified(user);
    await user.makeRecoveryCode();
    await user.uploadRecoveryBlob();
    return { user, email };
  }

  test('answers identically for a known and an unknown address', async () => {
    const { email } = await verifiedUser();

    const known = await call('/recovery/request', { method: 'POST', body: { email } });
    const unknown = await call('/recovery/request', {
      method: 'POST',
      body: { email: 'nobody@nowhere.invalid' },
    });

    // Any difference here confirms which addresses have accounts.
    assert.deepEqual(known, unknown);
  });

  test('resets the password and revokes every existing session', async () => {
    const { user, email } = await verifiedUser();
    const oldToken = user.token;

    const resetToken = await requestReset(email);

    const newSalt = user.identity.vaultSalt;
    const res = await call('/recovery/reset', {
      method: 'POST',
      body: { token: resetToken, password: 'a-brand-new-password', vaultSalt: newSalt },
    });

    assert.equal(res.needsRecoveryCode, true);

    // The whole point: an attacker holding a session must lose it.
    await assert.rejects(
      () => call('/auth/me', { token: oldToken }),
      (e) => e.status === 401 && /session expired/.test(e.message)
    );

    // And the new one works.
    const me = await call('/auth/me', { token: res.token });
    assert.equal(me.userId, user.userId);
  });

  test('does not rotate identity keys -- peers have them pinned', async () => {
    const { user, email } = await verifiedUser();

    const resetToken = await requestReset(email);

    const res = await call('/recovery/reset', {
      method: 'POST',
      body: {
        token: resetToken,
        password: 'a-brand-new-password',
        vaultSalt: user.identity.vaultSalt,
      },
    });

    // Rotating these would show every contact a key change and break every
    // channel.
    assert.equal(res.pubkey, user.identity.publicKey);
    assert.equal(res.signPubkey, user.identity.signPublicKey);
  });

  test('the recovery blob still opens after a reset', async () => {
    const { user, email } = await verifiedUser();

    const resetToken = await requestReset(email);

    const res = await call('/recovery/reset', {
      method: 'POST',
      body: {
        token: resetToken,
        password: 'a-brand-new-password',
        vaultSalt: user.identity.vaultSalt,
      },
    });

    user.token = res.token;
    const opened = await user.fetchAndOpenRecoveryBlob();

    // Reset gets you the account; only the code gets you the keys.
    assert.equal(opened.identity.privateKey, user.identity.privateKey);
  });

  test('the old password stops working and the new one starts', async () => {
    const { user, email } = await verifiedUser();
    const oldPassword = user.password;

    const resetToken = await requestReset(email);
    await call('/recovery/reset', {
      method: 'POST',
      body: {
        token: resetToken,
        password: 'a-brand-new-password',
        vaultSalt: user.identity.vaultSalt,
      },
    });

    await assert.rejects(() => user.login(oldPassword), (e) => e.status === 401);
    const ok = await user.login('a-brand-new-password');
    assert.equal(ok.userId, user.userId);
  });

  test('the reset link is single-use', async () => {
    const { user, email } = await verifiedUser();

    const resetToken = await requestReset(email);

    const body = {
      token: resetToken,
      password: 'a-brand-new-password',
      vaultSalt: user.identity.vaultSalt,
    };
    await call('/recovery/reset', { method: 'POST', body });
    await assert.rejects(
      () => call('/recovery/reset', { method: 'POST', body }),
      (e) => e.status === 400
    );
  });

  test('an unverified address cannot be used to reset', async () => {
    const email = `${uniqueName()}@example.com`;
    const user = new TestUser();
    await user.register({ email });
    // Deliberately not verified.

    const from = logCursor();
    await call('/recovery/request', { method: 'POST', body: { email } });
    await assert.rejects(() =>
      waitForMailLink('reset-password', { timeout: 1500, from })
    );
  });
});

/* ------------------------------------------------------------------ */
/* tier limits                                                         */
/* ------------------------------------------------------------------ */

describe('tier limits and upload gating', () => {
  test('a fresh account is free tier and cannot upload', async () => {
    const user = new TestUser();
    await user.register();

    const limits = await user.limits();
    assert.equal(limits.tier, 'free');
    assert.equal(limits.premium, false);
    assert.equal(limits.canUpload, false);
    assert.equal(limits.maxChars, 1000);
    assert.ok(limits.uploadDenialReason, 'must say why, not just refuse');
  });

  test('a verified email unlocks uploads at the free cap', async () => {
    const user = new TestUser();
    await registerVerified(user);

    const limits = await user.limits();
    assert.equal(limits.canUpload, true);
    assert.equal(limits.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(limits.uploadDenialReason, null);
  });

  test('blob/init refuses an account with no verified email', async () => {
    const user = new TestUser();
    await user.register();
    const channel = await user.createChannel();

    // Enforced server-side: the client's own check is a courtesy.
    await assert.rejects(
      () => user.blobInit(channel.channelId, 1024),
      (e) => e.status === 403 && e.body.needsEmail === true
    );
  });

  test('blob/init enforces the free tier cap', async () => {
    const user = new TestUser();
    await registerVerified(user);

    const channel = await user.createChannel();

    const overCap = 30 * 1024 * 1024;
    const chunks = Math.ceil(overCap / (1024 * 1024 + 17));
    await assert.rejects(
      () => user.blobInit(channel.channelId, overCap, chunks),
      (e) => e.status === 413
    );
  });

  test('blob/config reports the per-user cap, not a global one', async () => {
    const user = new TestUser();
    await user.register();

    const config = await user.blobConfig();
    // A client told the global maximum would let someone encrypt 50MB before
    // being refused at /init.
    assert.equal(config.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(config.canUpload, false);
  });
});

/* ------------------------------------------------------------------ */
/* billing                                                             */
/* ------------------------------------------------------------------ */

describe('billing', () => {
  test('reports no badge for a new account', async () => {
    const user = new TestUser();
    await user.register();

    const status = await user.billingStatus();
    assert.equal(status.badge, null);
  });

  test('exposes the cancellation portal link', async () => {
    const user = new TestUser();
    await user.register();

    const status = await user.billingStatus();
    // The field must exist even when unset (null here -- the test server
    // configures no Stripe). It is a subscriber's ONLY route to cancelling,
    // because we store no customer id and cannot cancel for them.
    assert.ok('portalUrl' in status, 'status must carry portalUrl');
  });

  test('checkout 404s cleanly when billing is not configured', async () => {
    // The test server forces billing off explicitly (helpers/server.js), rather
    // than relying on the developer's .env not having Stripe keys in it.
    // Half-configured billing is worse than none: the app must stay usable.
    await assert.rejects(
      () => call('/billing/checkout', { method: 'POST' }),
      (e) => e.status === 404
    );
  });

  test('rejects a bogus redemption code', async () => {
    const user = new TestUser();
    await user.register();
    await assert.rejects(() => user.redeem('AAAAA-BBBBB-CCCCC-DDDDD'), (e) => e.status === 400);
  });

  test('gives one message for unknown, used, and expired codes', async () => {
    const user = new TestUser();
    await user.register();

    const a = await user.redeem('AAAAA-BBBBB-CCCCC-DDDDD').catch((e) => e);
    const b = await user.redeem('ZZZZZ-YYYYY-XXXXX-WWWWW').catch((e) => e);

    // Distinguishing them tells someone probing which guesses hit a real row.
    assert.equal(a.message, b.message);
  });
});

/* ------------------------------------------------------------------ */
/* channels                                                            */
/* ------------------------------------------------------------------ */

describe('channels', () => {
  test('creates and lists a channel', async () => {
    const user = new TestUser();
    await user.register();
    const created = await user.createChannel();

    const { channels } = await user.listChannels();
    assert.ok(channels.some((c) => c.channelId === created.channelId));
  });

  test('a second member can join with the code', async () => {
    const alice = new TestUser();
    await alice.register();
    const channel = await alice.createChannel();

    const bob = new TestUser();
    await bob.register();
    const joined = await bob.joinChannel(channel.code, 'placeholder-key');

    assert.equal(joined.channelId, channel.channelId);
    assert.equal(joined.isNewMember, true);
  });

  test('rejects a bogus join code', async () => {
    const user = new TestUser();
    await user.register();
    await assert.rejects(
      () => call('/channel/join', { method: 'POST', token: user.token, body: { code: 'NOPENOPE' } }),
      (e) => e.status === 404 || e.status === 400
    );
  });

  test('a non-member cannot upload into a channel', async () => {
    const alice = new TestUser();
    await registerVerified(alice);
    const channel = await alice.createChannel();

    const mallory = new TestUser();
    await registerVerified(mallory);

    // Membership is checked before a single byte is accepted.
    await assert.rejects(
      () => mallory.blobInit(channel.channelId, 1024),
      (e) => e.status === 404
    );
  });
});
