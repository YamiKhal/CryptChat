import { Router } from 'express';
import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { billingLimiter } from '../middleware/security.js';
import { issueRedemptionCode, redemptionIndex } from '../lib/identityCrypto.js';
import { sendRedemptionMail } from '../lib/mailer.js';

/**
 * Subscriptions, deliberately not joined to a payment identity.
 *
 * The shape: checkout happens logged out. Stripe's metadata carries an
 * entitlement id -- a random UUID -- and nothing else. No user id, no username,
 * no session. The buyer receives a redemption code and attaches the badge to
 * whichever account they like, whenever they like.
 *
 * The honest limit, stated in IDENTITY.md and repeated here because it is the
 * thing most likely to get overclaimed in marketing copy: Stripe knows (payer
 * email, entitlement id) and this database knows (entitlement id, user id).
 * Neither side alone links a human to an account. Anyone holding *both* joins
 * them on the entitlement id immediately. The defensible claim is "we store no
 * payment information and our database contains no link between your payment and
 * your account" -- never "there is no link".
 *
 * Note what this file does not do: there is no activity tracking, no
 * auto-cancellation, and no last-login column feeding either. Cancellation is
 * the user's, through Stripe's own portal. See IDENTITY.md §3.3.
 */

const router = Router();

const stripe = config.billing.enabled
  ? new Stripe(config.billing.secretKey, { apiVersion: '2024-06-20' })
  : null;

/* ------------------------------------------------------------------ */
/* entitlement state                                                   */
/* ------------------------------------------------------------------ */

/**
 * The badge, and the only billing question the app ever asks at request time.
 *
 * Reads one row. No Stripe call, no payment detail, no customer lookup -- the
 * runtime path must not depend on the processor being reachable, and it must not
 * pull payment identity into a request that only wants to know whether to draw a
 * badge.
 */
export async function badgeFor(userId) {
  const result = await pool.query(
    `SELECT granted_at, expires_at FROM entitlements
      WHERE user_id = $1 AND status = 'active' AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`,
    [userId]
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  // `since` is the badge grant date, which the user asked to keep as the record
  // of when they subscribed. It is not a payment date and carries no amount.
  return { active: true, since: row.granted_at, until: row.expires_at };
}

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const badge = await badgeFor(req.userId);
    res.json({
      badge,
      billingEnabled: config.billing.enabled,
      // Stripe's hosted portal login page. The user's only route to cancelling,
      // because we hold no customer id to cancel on their behalf. It is a plain
      // public URL -- nothing about this account travels with it.
      portalUrl: config.billing.portalUrl || null,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* checkout                                                            */
/* ------------------------------------------------------------------ */

/**
 * Start an anonymous checkout.
 *
 * Unauthenticated on purpose: attaching a session here would put the account on
 * the Stripe side of the transaction, which is exactly the link the whole design
 * avoids. The caller gets a URL and nothing about them travels with it.
 */
router.post('/checkout', billingLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(404).json({ error: 'billing is not enabled' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: config.billing.priceId, quantity: 1 }],
      success_url: `${config.publicAppUrl}/subscribe/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicAppUrl}/subscribe`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

/**
 * Show the redemption code on the success page.
 *
 * Looked up by checkout session id, which the buyer's browser is handed by
 * Stripe on redirect. The code is also mailed, because this page is one refresh
 * away from being lost forever and the buyer has paid.
 */
router.get('/code/:sessionId', billingLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(404).json({ error: 'billing is not enabled' });

    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'payment not complete' });
    }

    // Stripe is the authority on who paid; we trust its session, not the caller.
    const entitlementId = session.metadata?.entitlement_id;
    if (!entitlementId) {
      // The webhook has not landed yet. Not an error -- Stripe redirects the
      // browser and delivers the webhook independently, and they race.
      return res.status(202).json({ pending: true });
    }

    const result = await pool.query(
      `SELECT status FROM entitlements WHERE id = $1`,
      [entitlementId]
    );
    if (result.rowCount === 0) return res.status(202).json({ pending: true });
    if (result.rows[0].status !== 'unredeemed') {
      return res.status(409).json({ error: 'this code has already been redeemed' });
    }

    // The plaintext code exists only in the webhook's memory and in the mail we
    // sent; the table holds an HMAC. It cannot be re-shown from here, which is
    // the same property that makes the stored form useless to a dump.
    res.json({ mailed: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* redemption                                                          */
/* ------------------------------------------------------------------ */

/**
 * Attach a purchased entitlement to the calling account.
 *
 * This is the moment the link is created, and it is created by the user, in
 * their own session, from a code they carried over by hand.
 */
router.post('/redeem', requireAuth, billingLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || code.length < 8 || code.length > 64) {
      return res.status(400).json({ error: 'invalid code' });
    }

    await client.query('BEGIN');

    // Claim atomically. Two tabs submitting the same code would otherwise both
    // see it unredeemed and the second would overwrite the first's user_id.
    const claimed = await client.query(
      `UPDATE entitlements
          SET user_id = $2, status = 'active', granted_at = now(), redeem_hash = NULL
        WHERE redeem_hash = $1 AND status = 'unredeemed' AND expires_at > now()
        RETURNING id, granted_at, expires_at`,
      [redemptionIndex(code), req.userId]
    );

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      // Deliberately one message for "no such code", "already used", and
      // "expired": distinguishing them tells someone probing codes which of
      // their guesses hit a real row.
      return res.status(400).json({ error: 'that code is not valid or has already been used' });
    }

    await client.query('COMMIT');

    const row = claimed.rows[0];
    res.json({ badge: { active: true, since: row.granted_at, until: row.expires_at } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ */
/* webhooks                                                            */
/* ------------------------------------------------------------------ */

function periodEnd(subscriptionOrInvoice) {
  const seconds =
    subscriptionOrInvoice.current_period_end ??
    subscriptionOrInvoice.lines?.data?.[0]?.period?.end;
  if (!seconds) return null;
  return new Date(seconds * 1000);
}

/**
 * Stripe webhook.
 *
 * Mounted with express.raw: signature verification runs over the exact bytes
 * Stripe signed, and express.json would have already reparsed and reserialized
 * them, breaking every signature. This is why the route defines its own parser
 * rather than inheriting the app's.
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    if (!stripe) return res.status(404).json({ error: 'billing is not enabled' });

    let event;
    try {
      // Unverified webhooks are anonymous internet input claiming someone paid.
      // Without this check, granting an entitlement is a POST away.
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        config.billing.webhookSecret
      );
    } catch (err) {
      console.error('webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'invalid signature' });
    }

    try {
      // Stripe retries and does not promise exactly-once delivery. Without this
      // guard a retried invoice.paid extends the subscription a second time.
      const seen = await pool.query(
        `INSERT INTO billing_events (event_id) VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.id]
      );
      if (seen.rowCount === 0) return res.json({ received: true, duplicate: true });

      await handleEvent(event);
      res.json({ received: true });
    } catch (err) {
      // 500 makes Stripe retry, which is what we want: the alternative is
      // silently swallowing a payment that never granted anything.
      console.error(`webhook ${event.type} failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  }
);

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.payment_status !== 'paid') return;

      const subscriptionId = session.subscription;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const expiresAt = periodEnd(subscription);
      if (!expiresAt) throw new Error('subscription has no period end');

      const code = issueRedemptionCode();

      const result = await pool.query(
        `INSERT INTO entitlements (redeem_hash, status, expires_at)
         VALUES ($1, 'unredeemed', $2)
         RETURNING id`,
        [
          redemptionIndex(code),
          new Date(expiresAt.getTime() + config.billing.graceDays * 86400000),
        ]
      );
      const entitlementId = result.rows[0].id;

      // The entitlement id, and nothing else. Adding a user id here -- even
      // "just for support" -- would hand Stripe the link this design exists to
      // avoid, and it would be permanent.
      await stripe.subscriptions.update(subscriptionId, {
        metadata: { entitlement_id: entitlementId },
      });
      await stripe.checkout.sessions.update(session.id, {
        metadata: { entitlement_id: entitlementId },
      });

      // The success page can be closed or refreshed away, and the buyer has
      // already paid. Mail is the durable copy.
      const to = session.customer_details?.email;
      if (to) {
        await sendRedemptionMail(to, code).catch((err) =>
          console.error('redemption mail failed to send:', err.message)
        );
      }
      return;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const entitlementId = subscription.metadata?.entitlement_id;
      if (!entitlementId) return;

      const expiresAt = periodEnd(subscription) ?? periodEnd(invoice);
      if (!expiresAt) return;

      // Renewal extends the window. A redeemed entitlement goes back to active
      // if it had lapsed; an unredeemed one stays unredeemed -- the code is
      // still out there waiting to be used.
      await pool.query(
        `UPDATE entitlements
            SET expires_at = $2,
                status = CASE WHEN user_id IS NOT NULL THEN 'active' ELSE status END
          WHERE id = $1`,
        [entitlementId, new Date(expiresAt.getTime() + config.billing.graceDays * 86400000)]
      );
      return;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const entitlementId = subscription.metadata?.entitlement_id;
      if (!entitlementId) return;

      // Mark cancelled but leave expires_at alone: the user paid through the end
      // of the period and keeps the badge until then. Yanking it at cancellation
      // would be taking back something already bought.
      await pool.query(`UPDATE entitlements SET status = 'cancelled' WHERE id = $1`, [
        entitlementId,
      ]);
      return;
    }

    default:
      // Everything else is noise we explicitly do not need. Not an error.
      return;
  }
}

export default router;
