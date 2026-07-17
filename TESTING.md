# Testing

```bash
npm run verify          # typecheck + every test + build. Run this before pushing.
```

That is the whole contract. Everything below is detail for when something fails.

## The commands

| command | what it runs | needs Postgres |
| --- | --- | --- |
| `npm run verify` | typecheck, all tests, production build | yes |
| `npm test` | frontend + backend suites | yes |
| `npm run test:unit` | pure-logic tests only — fast, no server | no |
| `npm run test:flows` | end-to-end flows against a real backend | yes |
| `npm run test:frontend` | vitest (crypto, limits, components) | no |
| `npm run test:backend` | node:test (crypto + flows) | yes |
| `npm run typecheck` | `tsc --noEmit` | no |

Postgres comes up automatically (`npm run db:up`) for the commands that need it.
If Docker is not running, the flow suite fails with a message saying so rather
than twenty confusing assertion errors.

Watch mode while working on a component: `npm --prefix frontend run test:watch`.

## What is actually covered

Four layers, each catching a different class of bug.

**1. Crypto properties** — `frontend/src/lib/crypto.test.ts` (43 tests)

Not round-trip checks. Each test pins a property that would be invisible in the
UI and catastrophic in the field:

- a message signed by one member cannot be attributed to another
- an envelope cannot be replayed into a different channel, or reattributed
- reply refs and reactions are inside the signature (a relay cannot repoint them)
- a channel key wrapped for Bob does not open for Carol, and a key from an
  impostor is rejected
- the recovery blob is opaque without the 24-word code
- `isSingleEmoji` rejects text, control characters, and bidi overrides — a peer
  picks that field and it renders verbatim

**2. Pure logic** — `frontend/src/lib/limits.test.ts`, `backend/test/identityCrypto.test.js` (53 tests)

Grapheme counting (an emoji is one character, not two), reaction folding
(idempotent add, remove-last drops the pill), envelope encryption, blind indexes
(HMAC, not a bare hash), masking (fixed width, so it does not leak length),
`padTo` (the timing floor that stops account enumeration).

**3. Components** — `frontend/src/components/*.test.tsx` (32 tests)

Real DOM, real user events, via Testing Library:

- the composer grows, stops at its ceiling, then scrolls — and shrinks again
  (the grow-only bug is a real one and is regression-tested)
- Enter sends, Shift+Enter newlines, IME composition does not fire a send
- the char limit blocks sending and upsells only non-supporters
- long-press opens the menu; a 50px drag cancels it (that is a scroll); a 3px
  wobble does not; a mouse pointerdown is ignored so right-click is not
  double-handled

**4. End-to-end flows** — `backend/test/flows.test.js` (48 tests)

A **real client** against a **real server**: real keys, real envelopes, real
HTTP. `backend/test/helpers/client.js` is a user emulator, not a mock — if it
and the frontend ever disagree, that disagreement is the bug.

Covers registration (with and without email), login, the recovery blob, email
verification, password reset, tier gating, billing, and channels. Specifically
including:

- an old session **stops working** the moment a password is reset
- a reset does **not** rotate identity keys (peers have them pinned)
- the recovery blob still opens after a reset
- `/recovery/request` answers identically for a known and an unknown address
- upload is refused without a verified email, and refused past the tier cap
- a non-member cannot upload into a channel
- one user cannot read another's recovery blob

## Why the tests are shaped this way

**The emulator is a re-implementation, not an import.** Sharing the frontend's
crypto module would let a bug cancel itself out on both sides — the test would
pass and the product would be broken.

**The flow suite spawns a real process.** The WebSocket handshake, the
body-parser ordering that keeps Stripe signatures verifiable, and the boot-time
config guards only exist in a real process. An in-process app instance would test
a different program than the one that ships.

**Mail links are read from the server log.** With no `MAIL_API_KEY`, the dev
mailer prints to stdout — the same thing a developer clicks locally. Tests read
it the same way rather than reaching into the database.

## Gotchas worth knowing

**`@vitest-environment node` on crypto tests.** Under jsdom, `TextEncoder` is
polyfilled from Node and returns typed arrays in Node's realm while the
`Uint8Array` global is jsdom's — libsodium's `instanceof` check then rejects
everything with "unsupported input type for message". Browsers have one realm, so
this is an artifact of the test environment. Anything touching libsodium declares
the node environment; component tests keep jsdom.

**Mail links need a log cursor.** Routes deliberately do not await the mail send
(awaiting the provider inside `/recovery/request` would leak timing and rebuild
the enumeration oracle), so the link lands *after* the HTTP response. Scanning
the whole log for the last match races and silently returns the **previous**
test's token. Use `captureMailLink(kind, action)`, which takes a cursor first.

**Rate limits are off in tests** via `DISABLE_RATE_LIMITS=true` — the suite
registers dozens of accounts in seconds, which is exactly what the registration
limiter exists to stop. That flag is a genuine hazard, so `config.js` **refuses
to boot production** with it set.

**Flow tests are slow and that is correct.** Argon2id is deliberately expensive.
A fast auth test would mean the hashing is not doing its job.

**The suites share one database.** Every test generates unique usernames, so they
do not collide. `npm run db:reset` wipes it if something gets wedged.

## Adding tests

Put it in the layer that catches the bug:

- a security property of the crypto → `crypto.test.ts`
- pure logic → `limits.test.ts` or `identityCrypto.test.js`
- something a user does with a mouse or a finger → a `*.test.tsx`
- anything crossing the network → `flows.test.js`

State the property in the test name, not the mechanics. `rejects an envelope
replayed into another channel` says what breaks if it fails; `test openEnvelope
2` does not.

If you fix a bug, add the test that would have caught it, and say so in a comment
— the salt-mismatch and grow-only regressions both have one, and they are the
most valuable tests in the suite.
