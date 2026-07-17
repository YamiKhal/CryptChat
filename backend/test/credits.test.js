import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, stopServer } from './helpers/server.js';
import { TestUser, initCrypto } from './helpers/client.js';
import { pool } from '../src/db.js';
import { badgeFor } from '../src/routes/billing.js';
import { issueRedemptionCode, redemptionIndex } from '../src/lib/identityCrypto.js';

/**
 * Gift credit, and the rule that makes it fair: gifted months must never burn
 * while something else is already paying for the account.
 *
 * These drive the database directly rather than through Stripe, because the
 * behaviour under test is entirely ours -- Stripe has no concept of "this
 * payment is worth 3 months", let alone of parking them.
 */

before(async () => {
  await initCrypto();
  await startServer();
});

after(async () => {
  await stopServer();
  await pool.end();
});

/** Insert an unredeemed entitlement the way the webhook would. */
async function issueCode({ kind, months = null, expiresInDays = null }) {
  const code = issueRedemptionCode();
  const expiresAt =
    expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 86400000);

  await pool.query(
    `INSERT INTO entitlements (redeem_hash, status, kind, duration_months, expires_at)
     VALUES ($1, 'unredeemed', $2, $3, $4)`,
    [redemptionIndex(code), kind, months, expiresAt]
  );
  return code;
}

async function newUser() {
  const user = new TestUser();
  await user.register();
  return user;
}

function monthsBetween(a, b) {
  return (new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24 * 30.44);
}

describe('gift credit', () => {
  test('a gift redeemed on a bare account starts counting immediately', async () => {
    const user = await newUser();
    const code = await issueCode({ kind: 'gift', months: 3 });

    const res = await user.redeem(code);

    assert.equal(res.redeemed.parked, false);
    assert.ok(res.badge.active);
    // ~3 months out, allowing for month-length wobble.
    const months = monthsBetween(res.badge.until, Date.now());
    assert.ok(months > 2.8 && months < 3.2, `expected ~3 months, got ${months.toFixed(2)}`);
  });

  test('the clock starts at redemption, not at purchase', async () => {
    // The whole reason expires_at is nullable. A gift bought in January and
    // handed over in June owes the recipient a full term from June.
    const user = await newUser();
    const code = await issueCode({ kind: 'gift', months: 12 });

    // Backdate the purchase by a year.
    await pool.query(
      `UPDATE entitlements SET created_at = now() - interval '12 months'
        WHERE redeem_hash = $1`,
      [redemptionIndex(code)]
    );

    const res = await user.redeem(code);
    const months = monthsBetween(res.badge.until, Date.now());
    assert.ok(months > 11.8, `a year-old gift must still grant 12 months, got ${months.toFixed(2)}`);
  });

  test('a gift redeemed while a subscription is active is PARKED, not burned', async () => {
    const user = await newUser();

    // An active subscription with 30 days to run.
    const subCode = await issueCode({ kind: 'subscription', expiresInDays: 30 });
    await user.redeem(subCode);
    const before = await user.billingStatus();

    const giftCode = await issueCode({ kind: 'gift', months: 3 });
    const res = await user.redeem(giftCode);

    assert.equal(res.redeemed.parked, true, 'gift must park while the sub is paying');
    // The badge date must not move: the gift is not extending a period the
    // subscription is already paying to extend.
    assert.equal(
      new Date(res.badge.until).getTime(),
      new Date(before.badge.until).getTime(),
      'parking must not move the expiry'
    );
    assert.equal(res.badge.creditMonths, 3);
  });

  test('parked credit activates once the subscription lapses', async () => {
    const user = await newUser();

    const subCode = await issueCode({ kind: 'subscription', expiresInDays: 30 });
    await user.redeem(subCode);

    const giftCode = await issueCode({ kind: 'gift', months: 3 });
    await user.redeem(giftCode);

    // The subscription runs out.
    await pool.query(
      `UPDATE entitlements SET expires_at = now() - interval '1 day'
        WHERE user_id = $1 AND kind = 'subscription'`,
      [user.userId]
    );

    // Reading the badge is what starts the credit -- no cron involved.
    const badge = await badgeFor(user.userId);

    assert.ok(badge?.active, 'credit should now be covering the account');
    const months = monthsBetween(badge.until, Date.now());
    assert.ok(months > 2.8 && months < 3.2, `expected ~3 months from now, got ${months.toFixed(2)}`);
    assert.equal(badge.creditMonths, 0);
  });

  test('credits queue rather than run in parallel', async () => {
    const user = await newUser();

    // Two 3-month gifts on a bare account: the first starts, the second waits.
    const first = await issueCode({ kind: 'gift', months: 3 });
    const second = await issueCode({ kind: 'gift', months: 3 });

    const a = await user.redeem(first);
    assert.equal(a.redeemed.parked, false);

    const b = await user.redeem(second);
    assert.equal(b.redeemed.parked, true, 'the second gift must wait for the first');

    // Still ~3 months, not 6: they are sequential.
    const months = monthsBetween(b.badge.until, Date.now());
    assert.ok(months < 3.2, `expected the first gift only, got ${months.toFixed(2)} months`);
    assert.equal(b.badge.creditMonths, 3);

    // Burn the first.
    await pool.query(
      `UPDATE entitlements SET expires_at = now() - interval '1 day'
        WHERE user_id = $1 AND status = 'active'`,
      [user.userId]
    );

    const badge = await badgeFor(user.userId);
    const next = monthsBetween(badge.until, Date.now());
    assert.ok(next > 2.8 && next < 3.2, `second gift should now run, got ${next.toFixed(2)}`);
    assert.equal(badge.creditMonths, 0, 'nothing left in reserve');
  });

  test('total granted time is the sum, just spread over the queue', async () => {
    const user = await newUser();

    await user.redeem(await issueCode({ kind: 'gift', months: 1 }));
    await user.redeem(await issueCode({ kind: 'gift', months: 6 }));

    const status = await user.billingStatus();
    // 1 month running, 6 banked. Nothing lost.
    assert.equal(status.badge.creditMonths, 6);
    const running = monthsBetween(status.badge.until, Date.now());
    assert.ok(running < 1.2, 'only the first month should be counting');
  });

  test('an unredeemed gift grants nothing', async () => {
    const user = await newUser();
    await issueCode({ kind: 'gift', months: 12 });

    const badge = await badgeFor(user.userId);
    assert.equal(badge, null);
  });

  test('a gift code does not go stale', async () => {
    // Unredeemed gifts never expire -- prepaid value with an expiry date is
    // restricted or banned in much of the EU and US.
    const user = await newUser();
    const code = await issueCode({ kind: 'gift', months: 3 });

    await pool.query(
      `UPDATE entitlements SET created_at = now() - interval '5 years'
        WHERE redeem_hash = $1`,
      [redemptionIndex(code)]
    );

    const res = await user.redeem(code);
    assert.ok(res.badge.active, 'a five-year-old gift code must still work');
  });

  test('a gift code is single-use', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const code = await issueCode({ kind: 'gift', months: 3 });

    await alice.redeem(code);
    await assert.rejects(() => bob.redeem(code), (e) => e.status === 400);
  });

  test('redeeming twice concurrently grants the code once', async () => {
    const user = await newUser();
    const code = await issueCode({ kind: 'gift', months: 3 });

    const results = await Promise.allSettled([user.redeem(code), user.redeem(code)]);
    const ok = results.filter((r) => r.status === 'fulfilled');

    assert.equal(ok.length, 1, 'exactly one redeem should succeed');
  });

  test('two gifts redeemed concurrently do not both start counting', async () => {
    // The advisory lock's job: without it both would read "nothing covers this
    // account" and both would start, burning one of them for free.
    const user = await newUser();
    const a = await issueCode({ kind: 'gift', months: 3 });
    const b = await issueCode({ kind: 'gift', months: 3 });

    await Promise.all([user.redeem(a), user.redeem(b)]);

    const active = await pool.query(
      `SELECT count(*)::int AS n FROM entitlements
        WHERE user_id = $1 AND status = 'active'`,
      [user.userId]
    );
    assert.equal(active.rows[0].n, 1, 'only one gift may be counting at a time');

    const parked = await pool.query(
      `SELECT count(*)::int AS n FROM entitlements
        WHERE user_id = $1 AND status = 'credit'`,
      [user.userId]
    );
    assert.equal(parked.rows[0].n, 1, 'the other must be parked, not lost');
  });
});

describe('subscription entitlements', () => {
  test('an expired subscription code cannot be redeemed', async () => {
    // Unlike gifts: a subscription's clock is Stripe's and has been running
    // since purchase.
    const user = await newUser();
    const code = await issueCode({ kind: 'subscription', expiresInDays: -1 });
    await assert.rejects(() => user.redeem(code), (e) => e.status === 400);
  });

  test('a subscription keeps the expiry Stripe set', async () => {
    const user = await newUser();
    const code = await issueCode({ kind: 'subscription', expiresInDays: 90 });

    const res = await user.redeem(code);
    assert.equal(res.redeemed.parked, false);

    const months = monthsBetween(res.badge.until, Date.now());
    assert.ok(months > 2.8 && months < 3.2, `expected ~90 days, got ${months.toFixed(2)} months`);
  });
});
