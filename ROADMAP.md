# CryptChat Roadmap

## Status

Shipped (built, tested, `npm run verify` green): **#1 theme + light mode, #2
custom themes + wallpaper, #3 typing / anon join-leave / unread, #4 delete +
edit (envelope v4), #5 WebAuthn 2FA, #6 password-locked messages, #7 incognito
channels, direct messages + block/leave, #8 1:1 WebRTC calls (voice free;
video + screen-share premium; envelope v6, coturn signaling).**

**Direct messages + 1:1 calls shipped.** A `type='dm'` channel created by
right-clicking a user (no join code), with DM-scoped blocking and leave. Calls
are peer-to-peer WebRTC: media is DTLS-SRTP end-to-end and never touches the
server; signaling rides the relay as signed, channel-key-encrypted `call`
envelopes (v6), so the server sees neither SDP nor media. ICE is served from
`GET /rtc/ice` with short-lived coturn HMAC credentials. see
[docs/calls.md](docs/calls.md) for the coturn-on-Coolify/Hetzner setup. The
video/screen-share premium gate is an honest client-side check (bypassable by a
patched client, documented as such), the same model as custom themes.

Deferred by decision: **group-call SFrame (#9)**. 1:1 calls do not need
per-frame encryption (no media server sees the stream), so this is only required
if group calls are added later. TOTP fallback for #5 remains a later addition.

**#7 shipped as display-only.** Members are shown as per-channel colors and no
name/avatar is sent. but the envelope still carries the real `senderId`, so the
§7 crux (channel-scoped signing identities, for true unlinkability from other
members) is NOT yet implemented. Incognito currently hides identity in the
interface, not from a member reading the wire. Closing that gap needs the relay
to stop binding `senderId` to the socket's real account. a real change, left as
follow-up. UI copy reflects the current, weaker guarantee.

Operational notes for the shipped work:

- Schema changes auto-apply on boot (all `IF NOT EXISTS` / idempotent `ALTER`).
- WebAuthn derives its RP ID and origin from `PUBLIC_APP_URL`; override with
  `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` only when the API and app are on
  different hosts.
- New deps: `@simplewebauthn/server` (backend), `@simplewebauthn/browser`
  (frontend).

---

Planned features, ordered by dependency. Each entry states what it is, the
security verdict (what it protects and. just as important. what it does
**not**) and the honest UX copy the feature must ship with. Nothing here is
allowed to claim more than the crypto delivers; the whole product's value is
that we don't lie about what we can see.

The invariant that governs every item below: **chats, channels, messages and
encryption keys stay maximum-security exactly as they are today.** Everything
here is identity, transport, or presentation. If any item starts to erode
message-layer security, it does not ship in that form.

Build order is dependency-driven, top to bottom. Numbers are the section refs
used in commits.

---

## 1. Theme tokens + light theme

**Blocks:** #2 (custom themes). Do this first.

Today `frontend/src/index.css` has no CSS custom properties and no
`prefers-color-scheme`. colors are hardcoded. Light theme is not a toggle bolted
on; it's a palette migration:

1. Extract the palette into CSS custom properties (`--bg`, `--fg`, `--muted`,
   `--border`, `--accent`, `--warn`, `--info`, …) on `:root`.
2. Define a light set under `[data-theme="light"]`.
3. Toggle flips `data-theme` on the root element.
4. Persist the choice in **localStorage, not the server.** No reason to leak a
   cosmetic preference into identity data and no reason to block on a network
   round-trip to render.

**Security:** none touched. Pure presentation.

---

## 2. Custom themes + chat backgrounds (premium)

**Depends on:** #1.

Once the palette is tokens, premium users pick their own values. Custom chat
backgrounds are a client-side image.

- Store the theme config **in the vault** (encrypted, syncs across a user's
  devices) rather than the server in plaintext. It's low-sensitivity, but the
  vault is where per-user client state already lives and it costs nothing to keep
  it there.
- Background images stay client-side, held in the vault. Never uploaded as
  server-readable assets.

**Security:** none touched. Gate the picker behind the premium entitlement
(`entitlementsFor`), nothing more.

---

## 3. Ephemeral relay signals (typing / join-leave / pending count)

One small subsystem, three features. Ship together. The shared property: these
are **ephemeral relay metadata. never persisted, never signed, never in the
transcript.**

### 3a. Typing indicator (anonymous)

Transient ws signal. "Someone is typing" in incognito channels, "X is typing" in
named channels. Not stored, not signed, not part of message history.

- **Metadata honesty:** the relay sees typing timing. It already sees connection
  and message timing, so this adds no new class of leak. but the internal note
  stands: this is relay-visible presence, not a zero-knowledge signal.

### 3b. Join / left (anonymous)

The server manages membership, so it knows exactly who joined or left. The
feature emits an anonymized event. "someone joined", "someone left". as a
**display choice.** Internal docs and code comments must not imply the server is
blind to identity here; it isn't. We're choosing not to surface it in the UI.

### 3c. Pending message count

The relay already queues ciphertext for offline recipients (same machinery as
parked reactions). Count undelivered messages per channel **without reading
them** and render a badge. Server counts envelopes; it does not decrypt them.

**Security:** message content untouched. All three are transport-layer presence.
The only consideration is metadata exposure to the relay, which is inherent to
having a relay and is unchanged by these features.

---

## 4. Envelope v4. delete + edit

**Extends:** the existing signed-envelope system (v3). Both operations are
**signed acts**, exactly like reactions. they introduce no new trust
assumption.

The unavoidable truth of end-to-end encryption: recipients already hold the
plaintext. We **cannot** guarantee erasure from a device that already received a
message. Every honest E2E product has this limit. What we can do, safely:

### Delete

- A signed **tombstone** envelope (v4) referencing the target message id.
- The relay drops the stored ciphertext. a real deletion for anyone offline or
  not-yet-synced.
- Cooperating clients hide the message.
- A patched/malicious client can keep its own copy. Unavoidable, universal.

### Edit

- A new signed envelope referencing the original id; the edit is covered by the
  sender's signature.
- Keep the edit history signed so nobody. including the original sender. can
  silently rewrite the record. An edited message renders as edited.

**Required UX copy:** "Deleted for everyone" / "Edited" must be honest —
qualify internally and in help text as "on clients that cooperate." We never
imply cryptographic erasure we can't deliver.

**Security:** signature-covered, no new trust. Safe.

---

## 5. Two-factor auth. WebAuthn first, TOTP fallback later

2FA gates the **login path only.** It is orthogonal to E2E: message keys live in
the vault, sealed under the password-derived key and 2FA never touches them.

### WebAuthn / passkeys (primary)

Phishing-resistant, hardware-bound, no shared secret sitting server-side. This is
the right default. The credential is registered against the account in the
identity layer; the server verifies the assertion before issuing a session token
and before releasing the recovery blob.

### TOTP (later, fallback)

For users without a security key or passkey-capable device. The TOTP secret is
stored in the identity layer. **server-readable, like the email**, which is
acceptable because it is not a crypto root. It's a phishable shared secret, which
is exactly why it's the fallback and not the default.

**What 2FA protects:** the online login path against a stolen password. The
attacker still needs the authenticator.

**What 2FA does NOT protect. state this in the security docs:** an offline
attack. If someone holds a database dump plus the user's password, they decrypt
the vault directly; the 2FA check never runs because there's no login. 2FA is not
a substitute for a strong password. Copy must not imply otherwise.

---

## 6. Password-protected messages (premium)

The sender sets a code; the recipient needs it to read the message.

**Mechanism:** double-wrap. The normal E2E envelope is the outer layer. The body
is additionally encrypted under `Argon2id(code)` as an inner layer. The recipient
decrypts the outer envelope normally, then is prompted for the code to decrypt
the inner. The code travels out-of-band (spoken, another channel).

**Honest adversary model. do not oversell this.** The recipient already holds
the inner ciphertext. A low-entropy code is brute-forceable _by them_. So this
does **not** protect against a determined channel member. It protects against:
shoulder-surfing, a borrowed-but-unlocked device, a casual over-the-shoulder
read. Argon2id slows brute force but cannot manufacture entropy the user didn't
put in the code.

Frame it in-product as a **confirmation gate / privacy screen**, never as
secrecy from the recipient. Gate behind premium.

**Security:** the outer E2E layer is unchanged. The inner layer is strictly
additive and can never weaken the outer envelope.

---

## 7. Incognito channels (premium)

No usernames, no avatars. colors only, a unique color per member.

**The one real design decision:** the `senderId` in an envelope is the signing
public key, i.e. a persistent pseudonym. If a member reuses their normal identity
key inside an incognito channel, they're linkable across channels and the feature
is defeated. Therefore:

- Derive a **channel-scoped signing keypair** for each incognito channel. The
  same person in two incognito channels presents two unrelated keys.
- Assign display color deterministically from the channel: `HMAC(channelSalt,
memberChannelId)`. stable within the channel, unlinkable outside it.

**Security:** message content and signing are unchanged in mechanism; what
changes is the _identity_ bound to the signature, scoped per channel. Gate
creation behind premium.

---

## 8. WebRTC calls. 1:1 voice/video + screen share

**Needs infra:** STUN + TURN servers (operational cost).

WebRTC's DTLS-SRTP gives true end-to-end encrypted media for peer-to-peer, out of
the box. Signaling rides the existing ws relay.

- **Authenticate the DTLS fingerprint with the existing X25519 identity keys.**
  Without this the signaling server could swap keys and MITM the call. With it,
  the media path is authenticated against the same identities used for messages.
- TURN relays media through NAT when direct connection fails, but it sees
  **ciphertext only**. DTLS-SRTP holds end to end through the relay.
- **Screen sharing** is `getDisplayMedia`. one additional WebRTC track. Same
  DTLS-SRTP E2E, near-zero extra work once calls exist. Ships with this item.

**Security:** genuinely E2E for 1:1 provided fingerprint authentication is done.
The TURN operator sees encrypted media only.

---

## 9. Group calls. E2E via SFrame (planned, largest)

Group calls need a Selective Forwarding Unit (SFU) to fan out media. A plain SFU
**decrypts media** to route it. which would break the E2E promise. That is a
hard no for this product.

The plan is therefore to build the call architecture in #8 so it extends to
group **with per-frame E2EE (SFrame / Insertable Streams):**

- Media frames are encrypted with a group key the SFU never holds.
- The SFU forwards **ciphertext frames**. it routes without decrypting.
- Group key distribution rides the existing identity keys / channel membership.

Caveats to design around: browser support for Insertable Streams, key rotation on
membership change and performance. This is the biggest item and comes last, but
#8 must be built so it doesn't paint us into a decrypt-at-the-SFU corner.

**Security:** the target is true group E2E. We do **not** ship a decrypt-at-SFU
version as a shortcut.

---

## Cross-cutting notes

- **Premium gating** (#2, #6, #7) all go through the existing `entitlementsFor` /
  `TIERS` machinery. No new entitlement plumbing. add capability flags.
- **Honesty copy is a feature requirement, not a nicety.** #4, #5, #6 and #9
  each carry a specific limit the UI must state plainly. A feature that overstates
  its guarantee is a bug in this product.
- **Metadata to the relay** (#3 and call signaling) is inherent to having a
  server. Document it; don't pretend the relay is blind where it isn't.
