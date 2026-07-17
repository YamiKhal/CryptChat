# Identity, Recovery, and Billing

CryptChat's threat model has one hard line: **the relay never learns a message
body, a channel key, a display name, or an avatar.** That line does not move.

This document covers everything on the *other* side of it — the account layer.
Monetization requires an identity we can bill and a mailbox we can reach, and
those are not free. This is the record of what we accepted, what we refused, and
why.

## Summary of the change

| Thing | Before | After |
|---|---|---|
| Email | none | optional, encrypted at rest, server-readable only inside the send path |
| Recovery | key file export only | recovery code (256-bit) + email confirmation |
| Vault backup | none (localStorage only) | server-held blob, sealed under the recovery code |
| Activity metadata | none | **still none** — deliberately |
| Payment link | none | Stripe ↔ random `entitlement_id` ↔ account |

Messages, channels, channel keys, blobs, and envelope signing are **unchanged**.
No part of this touches `crypto.ts` sealing, the relay, or the blob store.

---

## 1. Email

### What "encrypted" means here, precisely

The email is encrypted at rest with a **server-held key**. The server can
decrypt it. It does so in exactly one place: the outbound mail path. No API
route ever returns a plaintext address, and no operator UI displays one.

This is **"we never expose it"**, not **"we cannot read it."** Those are
different claims and only the first one is true. A database dump combined with
the KMS key yields plaintext addresses.

We say so in the privacy policy in those words. The alternative — sealing the
address with the vault key so the server truly cannot read it — makes the
address unreachable by our own mail sender, which makes recovery and activation
impossible. That was considered and rejected: an email nobody can send to is
decoration.

### Storage

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT UNIQUE;  -- HMAC-SHA256(pepper, normalized)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_ct TEXT;           -- AES-256-GCM(DEK, address)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_dek TEXT;          -- DEK wrapped under EMAIL_MASTER_KEY
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_mask TEXT;         -- precomputed display string
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
```

`email_hash` is an **HMAC, not a bare SHA-256**. A bare hash of an email is not
a protection — the input space is small enough that anyone holding a dump tests
their guesses offline and confirms whether a given person has an account. The
HMAC pepper (`EMAIL_INDEX_PEPPER`) lives in the environment, never in the
database, so a dump alone cannot be tested against.

> **Pre-existing issue, same class:** `hashUsername` in
> [auth.js:27](backend/src/routes/auth.js#L27) is a bare `sha256(username)`.
> Usernames are low-entropy, so today a DB dump enumerates the entire user list
> by rainbow table. This should become an HMAC under the same pepper. It needs a
> dual-read migration (try HMAC, fall back to legacy SHA-256 and rewrite on
> successful login) because changing it naively locks out every existing account.
> Tracked separately from this work but it lands in the same area.

Envelope encryption (`email_dek` wrapped under a master key) rather than
encrypting directly: it lets the master key rotate without rewriting every row.

### Masking

`email_mask` is computed **server-side at write time** and is the only form any
API returns. Never reconstruct a mask from ciphertext on the client — the client
would need the plaintext to do it, which defeats the point.

The requested "first 4 + last 4" leaks more than it looks: `aboEmad1231@outlook.com`
→ `aboE…k.com` still gives away the provider, and for short addresses the mask
approaches the address. Use instead: **first 2 of local part, provider domain
kept, everything else fixed-width elided** — `ab•••••••@outlook.com`. Fixed-width
matters: a mask that varies with length leaks the length.

### Verification

An unverified address is not an address. Gated features check
`email_verified_at IS NOT NULL`, never `email_ct IS NOT NULL`.

```sql
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,        -- sha256(token); the token itself is never stored
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,              -- 'verify' | 'reset'
  email_ct TEXT,                      -- pending address for 'verify'; applied only on confirm
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
```

Single-use, 24h for verify, 30 min for reset. The address is only written to
`users` when the token is consumed — otherwise typoing a stranger's address
silently attaches it to your account until they notice.

### Setting up the sender

You need a domain you control — no provider will let you send as `gmail.com`.

1. **Verify the domain** (Resend → Domains → Add). It returns DNS records: a
   DKIM `TXT` (signs your mail so it cannot be forged), SPF (`MX` + `TXT`,
   authorising Resend to send as you), and optionally DMARC. Add them at your
   registrar and verify. Minutes, usually.
2. **API key** with *sending access only* → `MAIL_API_KEY`.
3. `MAIL_FROM` must be at the verified domain: `CryptChat <noreply@example.com>`.
4. `PUBLIC_APP_URL` builds the links inside the mail. Getting this wrong mails
   your users a password-reset link pointing at someone else's host, so
   production refuses to boot without it.

Prefer a subdomain (`mail.example.com`) over the apex: a deliverability problem
then cannot poison the reputation of your main domain.

**Locally, set none of it.** With no `MAIL_API_KEY` the mailer prints the message
to stdout, link included — which is how a developer clicks through the flow and
how the test suite reads tokens. Production refuses to boot without it, because
auth mail silently going nowhere is worse than a loud failure.

Provider-agnostic: only `mailer.js` knows it is Resend. Postmark and SES are the
same shape.

### EmailJS is not usable for this

EmailJS sends from the browser under a publishable key. Any auth flow built on
it is trivially defeated: a locked-out user's recovery mail would be composed and
sent *by the client that requested it*, so an attacker who types your address
receives the token in their own browser. Recovery mail must originate on the
server, where the client cannot see or redirect it.

Use a server-side provider (Resend, Postmark, SES). `MAIL_API_KEY` + `MAIL_FROM`
in config, boot-checked like `JWT_SECRET`. EmailJS is fine for a contact form and
nothing else.

---

## 2. Recovery

### The trap

The password *is* the vault key ([vault.ts:211](frontend/src/lib/vault.ts#L211)).
Resetting the server-side password verifier does **not** open a local vault
sealed under the old password, and the server has never held the private keys
([auth.js:151-153](backend/src/routes/auth.js#L151-L153)).

So a naive "email password reset" produces a working login into an account with
zero channels, zero contacts, and zero history — the user reads this as total
data loss, and they are essentially right. Email reset alone must never be shipped
as "account recovery."

### The design: recovery code wraps a server-held key bundle

At registration the client generates a **256-bit recovery code**, rendered as 24
words, shown exactly once. From it:

```
RK           = Argon2id(code, recovery_salt)
recovery_blob = secretbox(KeyBundle, RK)      # same KeyBundle shape as the export
```

`KeyBundle` is what [crypto.ts:502](frontend/src/lib/crypto.ts#L502) already
defines: identity keypairs + every channel key. The blob is uploaded to the
server.

**Why server-side storage is safe here, when storing the vault would not be:**
the vault is sealed under a *human-chosen password* — a server holding it holds
an offline cracking target. The recovery blob is sealed under 256 bits of CSPRNG
output. There is no dictionary for that. The server holds ciphertext it cannot
attack, which is exactly the standard it already meets for message ciphertext.

This is strictly *stronger* than today's posture and it is what makes recovery
possible at all: the blob is the only copy of the keys reachable from a device
that has never seen the account.

```sql
CREATE TABLE IF NOT EXISTS recovery_blobs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  salt TEXT NOT NULL,          -- Argon2id salt for the recovery code; public by design
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**No recovery-code verifier is stored.** Not even a hash. A verifier would hand
the server (or a dump) an offline oracle to grind the code against. The
ciphertext is the check: a wrong code fails the Poly1305 tag, exactly as
`importKeyBundle` already works ([crypto.ts:566](frontend/src/lib/crypto.ts#L566)).

The blob is re-uploaded whenever the channel set changes, since a stale blob
recovers an account missing its newest channels.

### Recovery flow

Both factors are required. Email alone cannot recover; code alone cannot recover.

1. User submits username + email. Server HMACs the address and compares to
   `email_hash`.
2. **Response is identical whether or not it matched** — same body, same status,
   same latency. Otherwise the endpoint is an oracle that confirms which address
   owns which account.
3. On a real match, server mails a 30-minute single-use reset token.
4. Token consumed → user sets a new password. Server writes the new Argon2id
   verifier. `vault_salt` is **rotated** at this point, because the old local
   vault is unopenable anyway and keeping the salt implies otherwise.
5. Client prompts for the recovery code, pulls `recovery_blob`, unwraps the
   KeyBundle, rebuilds the vault under the new password, and re-uploads a fresh
   blob under a fresh salt.

Step 5 is not optional and the UI must not let the user skip it and land in a
half-restored account. If the user has no recovery code, the honest message is
that the channels are gone — the same answer the app gives today.

**Attacker with mailbox access, no recovery code:** resets the password, logs in,
sees an empty account. They now hold the username. They cannot read history and
cannot impersonate to existing contacts — a new identity means a new signing key,
and contacts pin on first use, so the change surfaces as `keyChangedAt` rather
than being silently accepted ([vault.ts:337](frontend/src/lib/vault.ts#L337)).
TOFU is what contains this, so it must not be weakened.

---

## 3. Subscriptions

### Structure

Purchase happens **logged out**, on a checkout page with no session. Stripe issues
a redemption code; the user redeems it in-app to attach a badge.

```sql
CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the only id Stripe ever sees
  redeem_hash TEXT UNIQUE,                        -- HMAC(pepper, code); nulled once redeemed
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- null until redeemed
  status TEXT NOT NULL DEFAULT 'unredeemed',      -- unredeemed|active|expired|cancelled
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

There is **no activity column and no login timestamp anywhere in this schema.**
That absence is a feature, not an omission — see §3.3.

1. `checkout.session.completed` → create an entitlement, generate a redemption
   code, store `HMAC(code)`, write `entitlement_id` into the Stripe subscription
   metadata. **Nothing else goes into that metadata** — no user id, no username.
2. The success page is the only place the code exists in plaintext. It is not
   emailed and not recoverable; losing it before redemption is a support ticket.
3. `POST /billing/redeem` (authenticated) → match `HMAC(code)`, set `user_id`,
   `status='active'`, `granted_at=now()`, null out `redeem_hash`.
4. `invoice.paid` → look up by `entitlement_id` from metadata, extend `expires_at`.

Badge = `status='active' AND expires_at > now()`. Nothing else is checked, and
no billing detail is ever read at request time.

### What this does and does not buy

Stripe knows `payer email + card + entitlement_id`. Our database knows
`entitlement_id + user_id`. Neither side alone links a human to an account.
Anyone holding **both** — a subpoena, a breach spanning both, an insider with
Stripe dashboard access — joins them on `entitlement_id` immediately.

So the accurate claim is: **"we don't store payment information and our database
contains no link between your payment and your account."** Not *"there is no
link."* Marketing must not round this up; the gap between those sentences is the
kind of thing that ends a privacy-first product's credibility permanently.

If true unlinkability is the goal, the only real answer is one-time passes sold
as fresh anonymous codes with no renewal mapping to maintain — no recurring
subscription can avoid holding a durable pointer.

### 3.3 No activity tracking — rejected on ethical grounds

An earlier draft auto-cancelled a subscription if the user did not log in during
the billing month, which required a `last_active_month` column. **This was
dropped deliberately and must not come back.**

The feature required building an activity log on paying accounts — the server
would have learned when each subscriber was last active, which is metadata it
has never held about anyone. That was the single largest privacy regression in
the whole design, larger than the email address, and it existed only to cancel
subscriptions users had not asked to cancel. Taking money is not a reason to
start surveilling.

Consequences, all of them good:

- No login timestamp anywhere in the schema. The server still cannot answer "when
  was this person last online" for any account, subscriber or not.
- No monthly sweep job, no Stripe cancel automation, no notice-period legal
  question in any jurisdiction.
- Cancellation is the user's, through Stripe's hosted portal **login page**
  (`STRIPE_PORTAL_URL`): they enter the address they paid with, Stripe mails them
  a magic link, and they cancel there. We handle `customer.subscription.deleted`
  by setting `status='cancelled'` and letting `expires_at` run out. We never
  cancel on someone's behalf — and could not if we wanted to, having stored no
  customer id. That is the design working as intended, but it does mean the
  portal link is **required in practice**: without it, subscribers have no route
  to cancel at all.

**Do not add `last_login_at` to `users` for analytics, engagement metrics, or
convenience.** If a future feature seems to need it, it does not — it needs a
different design. This paragraph is the reason.

---

## 4. What stays untouched

Re-evaluated and kept, all of it:

- E2E envelopes, signing, canonical byte encoding, replay/reattribution defenses
- Channel keys wrapped per recipient; server holds no key that opens anything
- Client-side vault; private keys never transmitted
- TOFU contact pinning with explicit key-change acceptance — load-bearing for the
  attacker-with-mailbox case above
- No filename, MIME, or content hash on the server; random blob ids, no dedup
- Sender-built link previews (recipients never fetch)
- Argon2id verifier, dummy-hash timing equalization, lockout accounting

Added:

- HMAC pepper for `email_hash` (and `username_hash`, separately)
- Server-side mail for anything auth-related
- Hard rate limits + constant-response recovery endpoints

Accepted and disclosed:

- We can read your email address (in the send path only)
- Stripe knows who paid

Considered and refused:

- Activity/login timestamps of any kind (§3.3)
- Server escrow of vault keys
- EmailJS or any client-side sender in an auth path

GDPR consequences that follow: the email makes this personal data, so we need a
deletion path, an export path, and DPAs with Stripe and the mail provider.

---

## 5. Build order

Each stage ships independently and leaves the app working.

1. **Config + crypto plumbing** — `EMAIL_MASTER_KEY`, `EMAIL_INDEX_PEPPER`,
   `MAIL_API_KEY`, `MAIL_FROM`, boot-checked. Envelope encrypt/decrypt helpers.
   No user-visible change.
2. **Recovery blob** — code generation at registration, blob upload, re-upload on
   channel change. Ships *before* email: it's the part that makes recovery mean
   something, and it's useful with no email at all.
3. **Email** — optional field at registration, add/change/remove in Settings,
   verification tokens, masked display.
4. **Reset flow** — reset tokens, constant-response lookup, forced recovery-code
   step, vault rebuild.
5. **Billing** — anonymous checkout, entitlement rows, redemption, webhooks,
   badge.
6. **`username_hash` HMAC migration** — dual-read, rewrite on login. Independent
   of everything above.
