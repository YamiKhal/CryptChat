# CryptChat: a messenger that refuses to lie to you

Most "private" chat apps ask you to trust a promise. CryptChat is built so you
don't have to trust ours — and, just as importantly, so it never makes a promise
the math can't keep.

## Why it exists

Encrypted messaging is a crowded space, and most of it is honest enough. But
there's a soft spot almost everyone shares: the marketing outruns the
cryptography. "We can't read your messages" quietly coexists with a server that
knows your phone number, your contact graph, when you're online, and who you
talk to at 2am. The encryption is real. The story told around it is a little too
comfortable.

CryptChat started from a stubborn question: what would a chat app look like if it
described itself *exactly* as truthfully as it behaved? Not "we can't" when the
honest answer is "we don't." Not "anonymous" when the truth is "anonymous from
the people in the room, not from the server that routes your packets." The whole
product is an experiment in matching the claim to the capability, down to the
wording on a button.

The account model reflects that from the first screen: there is no phone number,
no required email, no real name. You pick a username, the server stores a keyed
hash of it, and you're in. Everything below is what it takes to keep a promise
that small.

## The one rule

**Never promise more than the crypto delivers.**

That sounds like a constraint. In practice it became the design philosophy, and
it shows up everywhere:

- Delete a message and the UI says "deleted for everyone — on clients that
  cooperate," because a recipient's device already has the plaintext and no
  server can reach into it.
- Send a disappearing message and it tells you plainly: this can't stop a
  screenshot or a photo of the screen. It's tidy-up, not a vault.
- Lock a message behind a code and the app admits the recipient already holds
  the ciphertext, so a weak code is guessable — this is a privacy screen against
  a glance over the shoulder, not secrecy from the person you sent it to.

None of that copy is a disclaimer bolted on by legal. It's a feature. In a
category built on trust, the most valuable thing you can hand someone is the
truth about the edges.

## What "zero-knowledge" actually means here

The server is treated as honest-but-curious and possibly compromised. So it's
given as little as possible to be curious about.

It never learns your username — only a keyed hash of it. It never sees a message
body, a display name, or an avatar; those travel end-to-end encrypted and
signed, addressed only to people who already hold the channel key. It never
holds a channel key at all — when someone joins with a code, the server can only
announce them, and an existing member has to wrap the key for the newcomer and
pass it back through the relay as ciphertext.

Your private keys never touch the server, not even encrypted. Which leads to a
genuinely hard consequence: if the server can't help you recover, *how do you
ever get back in?*

## Goal: lose the device, keep the identity — with no backdoor

An account you can lose forever is a bad product; a server that can restore your
keys is a backdoor. The goal was to sit between those without cheating, and it
resolves into two independent factors that each cover exactly what the other
cannot.

A **24-word recovery code**, shown once at registration, is the only thing that
can decrypt a key bundle held for you on the server. That bundle is safe there
for a precise reason: the vault on your device is sealed under a human-chosen
password and would be an offline cracking target, but the recovery bundle is
sealed under 256 bits of randomness no dictionary can chew through. The server
holds ciphertext it cannot attack — the same standard it already meets for every
message it relays. The code is never transmitted, and no verifier for it is
stored, because a stored verifier would itself be an oracle to grind against.

An **optional email** is the second factor: it proves you own a mailbox, which
lets the server accept a new password. It decrypts nothing. Reset the password
without the code and you get a working login into an account with no channels and
no history — and the app says exactly that, rather than letting you find out by
scrolling an empty screen.

This is also where the honesty rule bites hardest. "Encrypted and unreadable"
and "we send you mail" cannot both be literally true. So email is encrypted at
rest, shown only as a fixed-width mask like `ab•••••••@outlook.com`, and never
returned by any API — but the mail path can decrypt it. The claim is "we never
expose it," not "we cannot read it." Small distinction. Entirely the point.

## Goal: support the project without paying in anonymity

Monetization needs an identity to bill and a mailbox to reach — both in tension
with a product whose whole pitch is knowing as little as possible about you. The
resolution: you buy a subscription **logged out**, on a page with no session,
and redeem a code on your account afterward. Stripe knows an email and an amount;
the database knows an entitlement id and a user. Neither side alone links a
person to a payment.

The defensible claim is "our database contains no link," never "there is no link
anywhere in the universe" — anyone holding *both* sides could join them on the
entitlement id. Rounding that up is exactly the kind of overstatement that ends a
privacy product's credibility, so it isn't rounded up.

The most revealing decision here was one that got **deleted**. An early design
auto-cancelled a subscription if you didn't log in during the billing month —
which required storing when each subscriber was last active. That was cut on
principle: it would have introduced the single largest piece of surveillance in
the whole system, an activity log on paying accounts, purely to cancel
subscriptions nobody asked to cancel. There is no login timestamp anywhere in the
schema, for subscribers or anyone else. Taking money is not a licence to start
watching. Cancellation instead runs through Stripe's own hosted portal, so the
server never has to know you were gone.

## Goal: one message, one identity, everywhere it lands

A message means nothing if two devices can't agree on *which* message it is.
Editing, deleting, and reacting all reference a message by id — so every device,
sender and recipient alike, has to name the same message the same way, or those
actions quietly point at nothing. The design carries one stable id end-to-end
from the moment a message is composed, independent of the server's own queue
bookkeeping. Distributed identity is deceptively easy to get *almost* right, and
"almost" is a react button that silently does nothing.

That same discipline runs through authenticity. Everyone in a channel holds the
same key, so decryption alone proves nothing about *who* wrote a message. Each
envelope is therefore signed with the sender's Ed25519 key over a canonical,
length-prefixed encoding that commits to both the channel and the sender — a
message cannot be replayed into another channel or reattributed to someone else.
Replies and reactions live *inside* that signed envelope, so a relay can't
repoint a reply at a different message or move a reaction onto one, and even the
"removed" flag on a reaction is signed so a replayed "add" can't undo it. Peer
keys are pinned on first use; a key change is surfaced in the UI, never silently
accepted.

## Goal: the metadata leaks less than the messages

The encryption is the easy part now — libsodium does the heavy lifting. The hard
part is everything *around* the message. Typing indicators, presence, "who's
premium," a colour that follows you between channels: each is a tiny correlation
handle, and a privacy product earns its keep in how carefully it refuses to leak
them.

So typing and presence signals are ephemeral relay metadata — never persisted,
never signed, never part of the transcript. The supporter badge is off by default
and self-asserted. Trust verification is deliberately session-scoped: compare
safety numbers out of band, and the confirmation evaporates on reconnect or
relogin, so trust is always re-established fresh rather than inherited from
history. Files never carry a filename, MIME type, or content hash on the server,
and blob ids are random rather than content-addressed — content-addressing would
hand the server a confirmation oracle for known files.

The honesty extends to what the relay *does* unavoidably see: which user ids
share a channel, when they send, and the size of what they send. That's inherent
to having a relay, and the docs say so instead of pretending otherwise.

## Features that carry the idea

Not a catalogue — just the ones that best express what the thing is for:

- **Safety numbers you actually verify.** Two people compare a number out of
  band; if it matches, no one swapped a key in the middle. Verification is
  session-scoped by design, so it's never assumed from history.
- **A second lock inside the first.** Password-protected messages seal the body a
  second time under a code shared out of band, layered on top of the normal
  end-to-end encryption — a deliberate privacy screen, honest about the fact that
  the recipient already holds the ciphertext.
- **Messages that clean up after themselves.** Disappearing messages start their
  clock when they're actually read and remove themselves from both sides — a
  cooperative-client feature, not a magic trick.
- **Incognito channels.** No names, no avatars — just stable per-channel colours,
  for conversations where identity is noise.
- **Direct messages, with blocking and leaving** scoped to the conversation, so
  the relationship graph never becomes a server-side social network.
- **Attachments the server can't read.** Any file type, encrypted client-side
  under a per-file key with a streaming cipher, uploaded once as ciphertext no
  matter how many recipients. Images render inline only after their bytes are
  sniffed by magic number — the declared type is never trusted, and SVG stays
  excluded because it can execute script.
- **Link previews built by the sender.** Off by default; when asked, *your*
  client fetches the URL and ships the preview inside the encrypted envelope, so
  recipients unfurl nothing and reveal no IP addresses by opening a chat.
- **A hardware second factor** (WebAuthn / passkeys) for the login path, plus a
  strict content-security policy so that even if a rendering bug slipped through,
  a stolen key would have nowhere to run and nothing to phone home to.

## Goal: real-time voice and video the server can't overhear

The newest addition is the one most products quietly compromise on. One-to-one
calls live inside direct messages and are peer-to-peer WebRTC: the media is
DTLS-SRTP encrypted end-to-end and **never touches the server**. The backend does
exactly two things — it routes the call signaling as signed,
channel-key-encrypted envelopes over the existing relay (so it never sees the
SDP), and it hands out ICE servers so two browsers can find each other.

The DTLS fingerprint is authenticated against the same identity keys that sign
messages, closing the door on a signaling server swapping keys to sit in the
middle. When a call has to relay through a self-hosted coturn to cross strict
NATs, that relay only ever forwards encrypted SRTP — it cannot read the media
either. Public STUN was rejected on the same grounds email-from-the-browser was:
it would leak the IP of everyone placing a call to a third party.

The tiering is drawn along honest lines. Voice is free for both sides. Video is a
supporter feature and *both* sides must be premium. Screen-share only gates the
person actually sharing, so two free users can talk while a supporter shares to
them. Every one of those checks is a client-side gate, documented as bypassable
by a patched client rather than dressed up as a security boundary — the same
model as custom themes and the character limit.

## Goal: make it yours without making it a tracker

Personalization is usually where privacy quietly leaks — a theme preference
becomes a row in a profile table, a wallpaper becomes a server-readable asset.
Here the light and custom themes are palette tokens, and the choice is persisted
in local storage, never sent to the server; a cosmetic preference has no business
in identity data. Custom themes and chat wallpapers are a supporter feature whose
config lives *in the encrypted vault*, syncing across a user's own devices
without the server ever reading it, and background images stay client-side for the
same reason. The interface commits fully to opaque, solid surfaces — no
translucency anywhere — precisely because a video wallpaper behind a
half-transparent panel would bleed through and turn a personal touch into a
legibility bug.

## What building it taught

Three things kept recurring.

The first: **honesty is a UX problem, not a legal one.** The right place to tell
someone a feature's limits is inside the feature, in plain words, at the moment
they use it — not buried in a policy nobody reads.

The second: **the cryptography is mostly solved; the composition isn't.** Signing
the right bytes, keeping ids consistent across devices, invalidating trust at the
right moment, authenticating a DTLS fingerprint against a signing key, not leaking
through a "someone is typing" — the interesting problems live in the seams between
good primitives.

The third: **every convenience is a potential leak, so make it a choice.** The
defaults lean paranoid; the conveniences are opt-in and labelled with their cost.

## Where it's going

The roadmap that isn't built yet is honest about its own difficulty. Group calls
are the big one: fanning media out to several people needs a forwarding server,
and a plain one would have to *decrypt* the stream to route it — a hard no here.
The only acceptable version encrypts each frame under a group key the forwarding
server never holds, so it routes ciphertext it can't read. That's a project of
its own, and 1:1 calls were deliberately built so they don't paint the
architecture into a decrypt-at-the-server corner.

Incognito channels have a deeper version waiting too. Today they hide identity in
the *interface* — no names, no avatars — but the envelope still carries a real
sender key, so a determined member reading the wire could correlate you across
rooms. Closing that gap means deriving a channel-scoped signing identity, so the
same person presents two unrelated keys in two incognito channels. The UI copy is
already careful to promise only the weaker guarantee that ships today.

And a passwordless-plus-fallback second factor, and a content-security policy
verified against a real browser rather than a build log. Each ships the same way
everything else did: only when it can be described truthfully.

## In the end

CryptChat is a bet that people can tell the difference between a product that
protects them and a product that says it does. The encryption is table stakes.
The differentiator is a refusal to round up — to claim erasure it can't
guarantee, anonymity it doesn't provide, or secrecy the recipient's own device
undermines.

Privacy software asks for your trust. The least it can do is earn it by being
honest about exactly how far it goes — and then going a little further than it
had to.
