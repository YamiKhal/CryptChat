# CryptChat: a messenger that refuses to lie to you

Most "private" chat apps ask you to trust a promise. CryptChat is built so you
don't have to trust ours — and, just as importantly, so we never make a promise
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

## The problems worth writing down

A few challenges were interesting enough that solving them shaped the product.

**Recovery without a backdoor.** An account you can lose forever is a bad
product; a server that can restore your keys is a backdoor. The answer is two
independent factors: an optional email that proves you own a mailbox, and a
24-word recovery code that is the only thing which can decrypt a key bundle we
hold for you. That bundle is safe on our servers precisely because it's sealed
under 256 bits of randomness no dictionary can chew through. We can store it and
still not be able to open it.

**The email paradox.** We wanted optional email for recovery — but "encrypted
and unreadable" and "we send you mail" can't both be literally true. So we
didn't pretend. Email is encrypted at rest and shown only as a masked fragment,
never exposed to anyone, including you. The honest claim is "we never expose it,"
not "we cannot read it." Small distinction. Entirely the point.

**Payments that don't identify you.** Supporting the project shouldn't cost you
your anonymity. You buy a subscription logged out and redeem a code on your
account afterward, so our database holds no link between a person and a payment.
We're careful not to oversell even this: the payment processor still knows an
email and an amount. The defensible claim is "our database contains no link,"
never "there is no link anywhere in the universe."

**A message with two names.** One of the more satisfying bugs. Each device was
storing a message under a different id — the sender kept its own, the recipient
used the server's queue id. Everything worked until you tried to edit, delete,
or react to your *own* message: the action pointed at an id no one else had, and
silently went nowhere. The fix was to carry one stable id end-to-end so every
device agrees on what a message *is*. Distributed identity is deceptively easy to
get almost right.

**Metadata is the real adversary.** The encryption is the easy part now;
libsodium does the heavy lifting. The hard part is everything *around* the
message. Typing indicators, presence, "who's premium," a colour that follows you
between channels — each is a tiny correlation handle, and a privacy product earns
its keep in how carefully it refuses to leak them. That's why the supporter
badge is off by default and self-asserted, why trust verification lives and dies
with a single session, and why incognito channels are described as hiding
identity *in the interface* — not from a determined member reading the wire.

## Features that carry the idea

Not a catalogue — just the ones that best express what the thing is for:

- **Safety numbers you actually verify.** Two people compare a number out of
  band; if it matches, no one swapped a key in the middle. Verification is
  deliberately session-scoped — it evaporates on reconnect or relogin — so trust
  is always re-established fresh rather than assumed from history.
- **A second lock inside the first.** Password-protected messages seal the body a
  second time under a code shared out of band, layered on top of the normal
  end-to-end encryption.
- **Messages that clean up after themselves.** Disappearing messages start their
  clock when they're actually read and remove themselves from both sides — an
  honest, cooperative-client version of the feature, not a magic trick.
- **Incognito channels.** No names, no avatars — just stable per-channel colours,
  for conversations where identity is noise.
- **A hardware second factor** for login, and a strict content-security policy so
  that even if a rendering bug slipped through, a stolen key has nowhere to run
  and nothing to phone home to.

## What building it taught

Three things kept recurring.

The first: **honesty is a UX problem, not a legal one.** The right place to tell
someone a feature's limits is inside the feature, in plain words, at the moment
they use it — not buried in a policy nobody reads.

The second: **the cryptography is mostly solved; the composition isn't.** Signing
the right bytes, keeping ids consistent across devices, invalidating trust at the
right moment, not leaking through a "someone is typing" — the bugs live in the
seams between good primitives.

The third: **every convenience is a potential leak, so make it a choice.** The
defaults lean paranoid; the conveniences are opt-in and labelled with their cost.

## Where it's going

The roadmap that isn't built yet is honest about its own difficulty. Real-time
calls are the big one — one-to-one voice and video are genuinely end-to-end over
WebRTC, but group calls demand per-frame encryption so the routing server never
sees decrypted media, and that's a project of its own. Incognito channels have a
deeper version waiting: channel-scoped signing identities, so a determined member
can't correlate you across rooms — closing the gap the current UI is careful not
to overstate. And a passwordless-plus-fallback second factor, and a
content-security policy verified against a real browser rather than a build log.

Each of those ships the same way everything else did: only when we can describe
it truthfully.

## In the end

CryptChat is a bet that people can tell the difference between a product that
protects them and a product that says it does. The encryption is table stakes.
The differentiator is a refusal to round up — to claim erasure we can't
guarantee, anonymity we don't provide, or secrecy the recipient's own device
undermines.

Privacy software asks for your trust. The least it can do is earn it by being
honest about exactly how far it goes — and then going a little further than it
had to.
