# Stripe setup

Everything you need to do on Stripe's side to make subscriptions work, in order.
The code is already written — this is configuration.

Read [IDENTITY.md](IDENTITY.md) §3 first if you have not. The short version: the
purchase happens **logged out**, Stripe is told a random `entitlement_id` and
nothing else, and the buyer redeems a code in-app to attach the badge. That is
what keeps your database free of a payment↔account link, and it is why the setup
below looks slightly unusual.

---

## 1. Account and product

1. Create an account at <https://dashboard.stripe.com/register>. Stay in **test
   mode** (the toggle, top right) for all of this. Test mode has its own keys,
   its own products, and its own webhooks — nothing you do here touches real
   money, and nothing carries over to live mode automatically.

2. **Products → Add product.**
   - Name: whatever the tier is called (this is shown on the checkout page).
   - Pricing model: **Recurring**.
   - Price: your amount, **Monthly**.
   - Save.

3. Open the product, find the **price** (not the product) and copy its ID. It
   starts with `price_`. This is `STRIPE_PRICE_ID`.

   > It must be the *price* id, not the *product* id (`prod_`). Checkout takes
   > prices; a product id fails at session creation with an unhelpful error.

## 2. API key

**Developers → API keys → Secret key** → reveal, copy. Starts with `sk_test_`.
This is `STRIPE_SECRET_KEY`.

The publishable key (`pk_test_`) is **not needed**. This integration uses
Stripe-hosted Checkout, so no card data ever touches your frontend — which is
also why you have no PCI surface to speak of.

> The secret key is a full-access credential to your Stripe account. It belongs
> in the server environment only. Never in the frontend, never in the repo.

## 3. Webhook

This is the part that actually grants entitlements, and the part most likely to
be misconfigured. **Developers → Webhooks → Add endpoint.**

- Endpoint URL: `https://your-api-domain/billing/webhook`
- Events to send — exactly these three:

| event | what the code does with it |
| --- | --- |
| `checkout.session.completed` | creates the entitlement, generates the redemption code, writes `entitlement_id` into the subscription metadata, mails the code |
| `invoice.paid` | extends `expires_at` on renewal |
| `customer.subscription.deleted` | marks `cancelled`, badge runs out its paid period |

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

`stripe listen` prints its **own** `whsec_` — use *that* one in your local
`.env`, not the dashboard's. They are different secrets and mixing them up
produces a signature failure that looks exactly like an attack.

Then, in another terminal:

```bash
stripe trigger checkout.session.completed
```

Watch the backend log. You should see the redemption code printed by the dev
mailer (no `MAIL_API_KEY` set locally = mail goes to stdout).

## 4. Customer portal — how anyone cancels

**Settings → Billing → Customer portal.** Turn it on, allow "Cancel
subscriptions", save. Then copy the **login page** share link — it looks like
`https://billing.stripe.com/p/login/xxxxxxxx`. That is `STRIPE_PORTAL_URL`.

This step is not optional in practice, and the reason is worth understanding.

Normally an app cancels a subscription by calling Stripe with the customer id it
stored. **We store no customer id** — that is the entire design. So we cannot
cancel on a user's behalf, and building a cancel button would mean keeping the
payment↔account link we promised not to keep.

The portal *login page* resolves it. The user enters the address they paid with,
Stripe emails them a magic link, and they cancel inside Stripe. We are never in
the loop; we only learn the outcome when `customer.subscription.deleted` reaches
our webhook. The link is a plain public URL — nothing about the account travels
with it, so it is safe to show to everyone.

Without it, subscribers have no way to cancel except emailing you. The server
logs a loud warning at boot rather than failing, but treat it as required: in the
EU, UK, and California, cancelling has to be about as easy as subscribing.

## 5. Environment

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen` locally, dashboard in prod
STRIPE_PRICE_ID=price_...
STRIPE_PORTAL_URL=https://billing.stripe.com/p/login/...
BILLING_GRACE_DAYS=3
```

Leave `STRIPE_SECRET_KEY` blank to switch billing off entirely: the routes 404
and the app is fully functional without them. Premium is additive — nothing in
the core product depends on it.

`PUBLIC_APP_URL` must also be correct, because it builds the checkout's
`success_url` and `cancel_url`. Wrong value = buyer pays and lands nowhere.

## 6. Card numbers for testing

| number | result |
| --- | --- |
| `4242 4242 4242 4242` | succeeds |
| `4000 0000 0000 9995` | declined (insufficient funds) |
| `4000 0025 0000 3155` | requires 3D Secure authentication |

Any future expiry, any CVC, any postcode.

## 7. Going live

1. Flip the dashboard to **live mode**.
2. Redo steps 1–4 in live mode. **Test-mode products, prices, webhooks, and the
   portal do not exist in live mode** — this catches everyone once.
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
  ├─ POST /billing/checkout ─────────────► Stripe Checkout session
  │                                        (no session, no user id sent)
  ├─ pays on Stripe's hosted page
  │
  ├─ redirected to /subscribe/done?session_id=...
  │
  │   meanwhile, independently:
  │   Stripe ──► POST /billing/webhook (checkout.session.completed)
  │                └─ create entitlement row (random uuid)
  │                └─ generate redemption code, store HMAC(code)
  │                └─ write {entitlement_id} to subscription metadata
  │                └─ mail the code to the payer
  │
  └─ user logs into their account, Settings → Subscription
       └─ POST /billing/redeem {code}
            └─ entitlement.user_id = them, status = active
            └─ badge appears

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
ordering — Stripe makes no promise about which arrives first.

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
JSON parser for `/billing/webhook` specifically — if you move or rename that
route, move the skip with it.

**Return 500 on webhook failure, not 200.** A 500 makes Stripe retry. Swallowing
an error with a 200 means a payment silently granted nothing and Stripe will
never tell you again.

**The redemption code is shown once and stored as an HMAC.** You cannot look it
up for a user who lost it — the table has no plaintext to return. That is
deliberate (a dump yields no usable codes), but it means "I lost my code before
redeeming" is a support case: find the entitlement by Stripe customer, cancel and
re-issue, or refund. There is no lookup.

**Metadata carries the entitlement id and nothing else.** Not a user id, not a
username — not even "just for support". Adding one hands Stripe the exact link
this design exists to avoid, permanently, for every future customer.

## The claim you can defend

Stripe knows `payer email + card + entitlement_id`. Your database knows
`entitlement_id + user_id`. Neither side alone links a human to an account.
Anyone holding **both** joins them on `entitlement_id` immediately — a subpoena,
a breach spanning both, or anyone with Stripe dashboard access.

So the honest line is:

> We don't store payment information, and our database contains no link between
> your payment and your account.

**Not** "there is no link." If you need that second sentence to be true, no
recurring subscription can deliver it — something must map renewals to an
entitlement. One-time passes sold as fresh anonymous codes can.
