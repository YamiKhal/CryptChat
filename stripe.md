# Stripe setup

Everything you need to do on Stripe's side to make subscriptions work, in order.
The code is already written. this is configuration.

Read [IDENTITY.md](IDENTITY.md) §3 first if you have not. The short version: the
purchase happens **logged out**, Stripe is told a random `entitlement_id` and
nothing else and the buyer redeems a code in-app to attach the badge. That is
what keeps your database free of a payment↔account link and it is why the setup
below looks slightly unusual.

---

## 1. Account and product

1. Create an account at <https://dashboard.stripe.com/register>. Stay in **test
   mode** (the toggle, top right) for all of this. Test mode has its own keys,
   its own products and its own webhooks. nothing you do here touches real
   money and nothing carries over to live mode automatically.

2. **Products → Add product.** Name it "Supporter". this is what appears on the
   checkout page and the receipt. Add a **Recurring** price, **Monthly**. Save.

3. Open the product and **Add price** three more times, all Recurring:

    | plan       | billing period              | env var                   |
    | ---------- | --------------------------- | ------------------------- |
    | monthly    | Monthly                     | `STRIPE_PRICE_MONTHLY`    |
    | quarterly  | Custom → every **3 months** | `STRIPE_PRICE_QUARTERLY`  |
    | semiannual | Custom → every **6 months** | `STRIPE_PRICE_SEMIANNUAL` |
    | yearly     | Yearly                      | `STRIPE_PRICE_YEARLY`     |

    **One product, four prices**. not four products. That is exactly what
    Stripe's model is for: a _product_ is the thing you sell, a _price_ is how you
    pay for it. Four products would fragment your reporting and gain nothing.

    (Stripe stores these as `interval` + `interval_count`, so "every 3 months" is
    `month × 3`. You never touch those fields directly.)

4. Copy each **price** id. they start with `price_`.

    > It must be the _price_ id, not the _product_ id (`prod_`). Checkout takes
    > prices; a product id fails at session creation with an unhelpful error.

    Every price you leave unconfigured is simply not offered. The picker only
    shows plans that resolve, so a partial setup is valid. the server warns at
    boot listing what is missing.

### Gift codes. a second product

**Products → Add product**, name it "Supporter Gift". Add **four one-off
prices** (Stripe calls this "One-off", not Recurring):

| gift      | env var                 |
| --------- | ----------------------- |
| 1 month   | `STRIPE_GIFT_PRICE_1M`  |
| 3 months  | `STRIPE_GIFT_PRICE_3M`  |
| 6 months  | `STRIPE_GIFT_PRICE_6M`  |
| 12 months | `STRIPE_GIFT_PRICE_12M` |

A separate product and the reason is the buyer's experience: the product name is
what they see at checkout and on the receipt. "Supporter Gift" reads correctly;
"Supporter" with a one-time charge does not. It also keeps recurring revenue and
one-off sales from blurring together in your dashboard.

Stripe _allows_ mixing recurring and one-off prices on one product. Don't.

**Stripe has no idea a gift is worth 3 months.** It only knows someone paid once.
The duration lives in [`src/lib/plans.js`](backend/src/lib/plans.js) and is
attached to the checkout session as metadata, server-side. That metadata is what
the webhook reads to decide what the code is worth.

### Never accept a price id from the browser

The client sends a **slug** (`gift3`, `yearly`); the server maps it to a
configured price. If the client could send a `price_...`, anyone could post the
id of your cheapest price. or a leftover £0 test price. and take 12 months for
nothing. `resolvePlan()` is the only way a price reaches Stripe.

## 2. API key

**Developers → API keys → Secret key** → reveal, copy. Starts with `sk_test_`.
This is `STRIPE_SECRET_KEY`.

The publishable key (`pk_test_`) is **not needed**. This integration uses
Stripe-hosted Checkout, so no card data ever touches your frontend. which is
also why you have no PCI surface to speak of.

> The secret key is a full-access credential to your Stripe account. It belongs
> in the server environment only. Never in the frontend, never in the repo.

## 3. Webhook

This is the part that actually grants entitlements and the part most likely to
be misconfigured. **Developers → Webhooks → Add endpoint.**

- Endpoint URL: `https://your-api-domain/billing/webhook`
- Events to send. exactly these three:

| event                           | what the code does with it                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `checkout.session.completed`    | creates the entitlement, generates the redemption code, writes `entitlement_id` into the subscription metadata, mails the code |
| `invoice.paid`                  | extends `expires_at` on renewal                                                                                                |
| `customer.subscription.deleted` | marks `cancelled`, badge runs out its paid period                                                                              |

Add the endpoint, then click into it and reveal the **Signing secret**. Starts
with `whsec_`. This is `STRIPE_WEBHOOK_SECRET`.

The server verifies every webhook against this secret and rejects anything that
fails. Without that check, "someone paid" is an unauthenticated POST away —
which is why the server refuses to boot if `STRIPE_SECRET_KEY` is set and this
is missing.

### Testing the webhook locally

Your machine has no public URL, so Stripe cannot reach `localhost`. Use the CLI:

```bash
# https://docs.stripe.com/stripe-cli
stripe login
stripe listen --forward-to localhost:3000/billing/webhook
```

`stripe listen` prints its **own** `whsec_`. use _that_ one in your local
`.env`, not the dashboard's. They are different secrets and mixing them up
produces a signature failure that looks exactly like an attack.

Then, in another terminal:

```bash
stripe trigger checkout.session.completed
```

Watch the backend log. You should see the redemption code printed by the dev
mailer (no `MAIL_API_KEY` set locally = mail goes to stdout).

## 4. Customer portal. how anyone cancels

**Settings → Billing → Customer portal.** Turn it on, allow "Cancel
subscriptions", save. Then copy the **login page** share link. it looks like
`https://billing.stripe.com/p/login/xxxxxxxx`. That is `STRIPE_PORTAL_URL`.

This step is not optional in practice and the reason is worth understanding.

Normally an app cancels a subscription by calling Stripe with the customer id it
stored. **We store no customer id**. that is the entire design. So we cannot
cancel on a user's behalf and building a cancel button would mean keeping the
payment↔account link we promised not to keep.

The portal _login page_ resolves it. The user enters the address they paid with,
Stripe emails them a magic link and they cancel inside Stripe. We are never in
the loop; we only learn the outcome when `customer.subscription.deleted` reaches
our webhook. The link is a plain public URL. nothing about the account travels
with it, so it is safe to show to everyone.

Without it, subscribers have no way to cancel except emailing you. The server
logs a loud warning at boot rather than failing, but treat it as required: in the
EU, UK and California, cancelling has to be about as easy as subscribing.

## 5. Environment

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen` locally, dashboard in prod
STRIPE_PRICE_ID=price_...
STRIPE_PORTAL_URL=https://billing.stripe.com/p/login/...
BILLING_GRACE_DAYS=3
```

Leave `STRIPE_SECRET_KEY` blank to switch billing off entirely: the routes 404
and the app is fully functional without them. Premium is additive. nothing in
the core product depends on it.

`PUBLIC_APP_URL` must also be correct, because it builds the checkout's
`success_url` and `cancel_url`. Wrong value = buyer pays and lands nowhere.

## 6. Card numbers for testing

| number                | result                            |
| --------------------- | --------------------------------- |
| `4242 4242 4242 4242` | succeeds                          |
| `4000 0000 0000 9995` | declined (insufficient funds)     |
| `4000 0025 0000 3155` | requires 3D Secure authentication |

Any future expiry, any CVC, any postcode.

## 7. Going live

1. Flip the dashboard to **live mode**.
2. Redo steps 1–4 in live mode. **Test-mode products, prices, webhooks and the
   portal do not exist in live mode**. this catches everyone once.
3. Swap the env vars for the live `sk_live_` / `whsec_` / `price_` /
   `billing.stripe.com/p/login/...` values.
4. Activate the account (Stripe asks for business details and a payout bank
   account before it will accept real charges).
5. Do one real purchase with a real card and redeem the code end to end. Refund
   it afterwards from the dashboard.

---

## How the flow actually runs

```
buyer (logged out)
  │
  ├─ POST /billing/checkout {plan: "yearly"|"gift3"|...}
  │      └─ slug ─► configured price. A price id from the browser is refused.
  │                 mode: subscription | payment (gifts are one-off)
  │                                     ────► Stripe Checkout session
  │                                           (no session, no user id sent)
  ├─ pays on Stripe's hosted page
  │
  ├─ redirected to /subscribe/done?session_id=...
  │
  │   meanwhile, independently:
  │   Stripe ──► POST /billing/webhook (checkout.session.completed)
  │                └─ generate redemption code, store HMAC(code)
  │                ├─ subscription: entitlement{kind:'subscription',
  │                │                  expires_at: period_end + grace}
  │                │    └─ write {entitlement_id} to subscription metadata
  │                │       (that is what lets a renewal find it)
  │                └─ gift: entitlement{kind:'gift', duration_months: N,
  │                                     expires_at: NULL}
  │                     no subscription object exists; nothing to tag
  │                └─ mail the code to the payer
  │
  └─ someone (the buyer, or whoever they gave it to) redeems it
       └─ POST /billing/redeem {code}
            └─ entitlement.user_id = them
            ├─ subscription  → status 'active', keeps Stripe's expiry
            ├─ gift, account uncovered → status 'active',
            │                            expires_at = now + N months
            └─ gift, already covered   → status 'credit', expires_at NULL
                                         PARKED. Starts when nothing else
                                         covers them. Nobody pays for
                                         gifted time.

later, cancelling:

user → STRIPE_PORTAL_URL (we are not involved)
  ├─ enters the email they paid with
  ├─ Stripe mails them a magic link
  └─ cancels inside Stripe
       └─ Stripe ──► POST /billing/webhook (customer.subscription.deleted)
            └─ status = 'cancelled'
            └─ expires_at untouched: they keep the badge through the period
               they already paid for
```

The browser redirect and the webhook **race**, deliberately. The success page
handles the webhook not having landed yet (`202 pending`) rather than assuming
ordering. Stripe makes no promise about which arrives first.

## Gift credit: months that wait their turn

A gift is **not** an expiry extension. It is credit and it only counts down when
nothing else is covering the account.

Redeem a 3-month gift while your subscription is billing and those months
**park**: `status='credit'`, no expiry. Your badge date does not move. The moment
the subscription stops renewing, the credit starts. automatically, on the next
badge read, no cron involved.

Why it has to work this way: the obvious implementation is
`expires_at += 3 months`. But a subscription's `invoice.paid` _also_ pushes
`expires_at` forward, so those gifted months would be consumed by time the user
was simultaneously paying for. They would pay for months they had been given.
Parking is what makes that impossible.

Consequences that follow, all tested in
[`test/credits.test.js`](backend/test/credits.test.js):

- **The clock starts at redemption, not purchase.** Buy a 12-month gift in
  January, hand it over in June, the recipient gets 12 months from June. This is
  why `expires_at` is nullable.
- **Credits queue, never overlap.** Two 3-month gifts are six months in sequence,
  not three months twice.
- **Gift codes never expire.** Prepaid value with an expiry is restricted or
  banned in much of the EU and US and an unredeemed row grants nothing anyway.
- **Subscription codes _do_ expire**, because Stripe's clock has been running
  since purchase. That asymmetry is deliberate.

Nothing is lost either way; it is only ever deferred.

## Things that will bite you

**The webhook is the source of truth, not the redirect.** A buyer who closes the
tab mid-redirect still gets their entitlement, because the webhook is what
creates it. Never grant anything from the success page.

**Stripe retries webhooks.** Delivery is at-least-once, not exactly-once. The
`billing_events` table dedupes on `event.id`; without it a retried `invoice.paid`
extends the subscription twice. If you add an event type, it goes through the
same dedupe.

**The webhook route must not be JSON-parsed.** Signature verification runs over
the exact bytes Stripe signed. `express.json()` would reparse and reserialize
them and every signature would fail. [index.js](backend/src/index.js) skips the
JSON parser for `/billing/webhook` specifically. if you move or rename that
route, move the skip with it.

**Return 500 on webhook failure, not 200.** A 500 makes Stripe retry. Swallowing
an error with a 200 means a payment silently granted nothing and Stripe will
never tell you again.

**The redemption code is shown once and stored as an HMAC.** You cannot look it
up for a user who lost it. the table has no plaintext to return. That is
deliberate (a dump yields no usable codes), but it means "I lost my code before
redeeming" is a support case: find the entitlement by Stripe customer, cancel and
re-issue, or refund. There is no lookup.

**Metadata carries the entitlement id and nothing else.** Not a user id, not a
username. not even "just for support". Adding one hands Stripe the exact link
this design exists to avoid, permanently, for every future customer.

**A gift checkout has no subscription object.** `session.subscription` is null,
`invoice.paid` never fires and `stripe.subscriptions.update` would throw. The
webhook branches on `session.metadata.kind`, which we set ourselves at session
creation. so it is trustworthy, unlike anything the browser sends.

**Adding a plan means adding a price, an env var and an entry in `plans.js`.**
Miss the last one and the price is unreachable; miss the env var and the plan is
silently hidden (with a boot warning). Nothing breaks loudly, which is exactly
why it is worth knowing.

## The claim you can defend

Stripe knows `payer email + card + entitlement_id`. Your database knows
`entitlement_id + user_id`. Neither side alone links a human to an account.
Anyone holding **both** joins them on `entitlement_id` immediately. a subpoena,
a breach spanning both, or anyone with Stripe dashboard access.

So the honest line is:

> We don't store payment information and our database contains no link between
> your payment and your account.

**Not** "there is no link." If you need that second sentence to be true, no
recurring subscription can deliver it. something must map renewals to an
entitlement. One-time passes sold as fresh anonymous codes can.
