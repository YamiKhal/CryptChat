CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The server never learns a username, a display name, an avatar, or a message
-- body. It stores sha256(username) for lookup, an Argon2id password verifier,
-- and two public keys per user. Everything else it holds is ciphertext.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username_hash TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ed25519 verify key. Separate from `pubkey` (X25519 box key): signing and
-- key agreement must not share a keypair. Nullable + backfilled so existing
-- rows survive; registration has required it since this migration landed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sign_pubkey TEXT;

-- Per-user salt for the client's Argon2id vault KDF. Public by design: a salt
-- is not a secret and the client needs it before it can decrypt anything, so
-- it must survive a fresh device install. The vault key itself is derived
-- client-side and never sent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_salt TEXT;

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Channel codes are join credentials, so they expire and can be rotated.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();

-- Membership state. 'active' is a full member; 'pending' is a DM invitee who has
-- not accepted yet. The default is 'active' so every existing row and every
-- group join is a full member with no migration -- only the invited side of a
-- new DM is ever 'pending'. While pending, the relay withholds that channel's
-- messages and wrapped key from the user (see flushQueue / flushKeyOffers): the
-- invitee sees a request with the inviter's identity, never the content, until
-- they accept. Accepting flips this to 'active' and releases what was held.
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Each queued row now targets exactly one recipient. Without this, flushQueue
-- joined on channel_members and handed every member every row -- N copies of
-- each message in an N-member channel -- and let any member ack-delete another
-- member's undelivered mail.
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message';

-- Rows predating recipient_id cannot be routed and are unreadable noise.
DELETE FROM message_queue WHERE recipient_id IS NULL;

CREATE INDEX IF NOT EXISTS message_queue_recipient_idx
  ON message_queue (recipient_id, created_at);

-- Wrapped channel keys, parked for a member who was offline when someone
-- joined. crypto_box ciphertext addressed to one recipient: the server holds
-- it but has no key that opens it.
CREATE TABLE IF NOT EXISTS key_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (channel_id, sender_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS key_offers_recipient_idx
  ON key_offers (recipient_id, created_at);

-- Encrypted file attachments.
--
-- The bytes live on disk, not here -- Postgres holds only routing metadata.
-- Note what is absent: no filename, no MIME type, no content hash. Those are
-- attacker-useful and travel inside the E2E envelope instead. The server knows
-- only that a user put N ciphertext bytes in a channel at a time.
--
-- The id is random (gen_random_uuid), deliberately NOT a hash of the content.
-- Content-addressing would enable cross-user dedup, which hands the server a
-- confirmation oracle: it could test whether you uploaded a known file just by
-- checking whether its address already exists.
CREATE TABLE IF NOT EXISTS blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 'pending' until /finish. Pending rows are abandoned uploads and get reaped.
  status TEXT NOT NULL DEFAULT 'pending',

  declared_chunks INT NOT NULL,
  chunks_received INT NOT NULL DEFAULT 0,
  -- Ciphertext bytes actually on disk. Authoritative for resume: the file is
  -- truncated back to this on a retry, so a half-written chunk cannot corrupt
  -- the stream.
  bytes_received BIGINT NOT NULL DEFAULT 0,
  declared_bytes BIGINT NOT NULL,

  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS blobs_expires_idx ON blobs (expires_at);
CREATE INDEX IF NOT EXISTS blobs_owner_idx ON blobs (owner_id, status);
CREATE INDEX IF NOT EXISTS blobs_channel_idx ON blobs (channel_id);

-- Failed-login accounting for lockout. Keyed by username_hash so it works for
-- usernames that do not exist, which is what stops enumeration-by-timing.
CREATE TABLE IF NOT EXISTS login_attempts (
  username_hash TEXT PRIMARY KEY,
  failures INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===================================================================
-- Account layer: email, recovery, billing.
--
-- Everything above this line is zero-knowledge and stays that way. Everything
-- below exists because a product that takes money needs a mailbox it can reach
-- and a badge it can grant. Read IDENTITY.md before extending any of it.
--
-- Note what is still absent, deliberately: there is no last_login_at, no
-- last_active_at and no activity column of any kind. The server does not know
-- when anyone was online and is not going to start.
-- ===================================================================

-- Session generation. Bumped whenever the password changes and carried in every
-- JWT as `epoch`.
--
-- Without this a password reset does not actually take the account back: tokens
-- are stateless and live for TOKEN_TTL (7d), so an attacker holding a session
-- keeps read/write access for a week *after* the victim resets -- which is
-- exactly the window the reset exists to close. Requiring the claim to match
-- turns a reset into an immediate revocation of every other session.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_epoch INT NOT NULL DEFAULT 0;

-- Optional email. Encrypted at rest under a server-held key (envelope: the DEK
-- is per-row and wrapped by EMAIL_MASTER_KEY). The server *can* read this -- it
-- must, to send to it -- but does so only in the outbound mail path and no API
-- returns anything but `email_mask`.
--
-- email_hash is an HMAC under EMAIL_INDEX_PEPPER, not a bare digest: emails are
-- low-entropy enough that a plain sha256 column lets anyone with a dump confirm
-- whether a given person has an account. The pepper is not in the database.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_ct TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_dek TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_mask TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Partial: an address may be attached to at most one account, but "no email" is
-- the common case and NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_hash_idx
  ON users (email_hash) WHERE email_hash IS NOT NULL;

-- Marks rows whose username_hash is still the legacy bare sha256. Login rewrites
-- them to the HMAC form on the next successful password check; until then lookup
-- falls back. Without the flag there is no way to tell the two hash shapes apart
-- -- both are 64 hex chars.
--
-- The two statements do different jobs and the order matters. The first runs
-- exactly once (IF NOT EXISTS makes later boots a no-op) and backfills every
-- pre-existing row to TRUE, which is correct: those rows predate the HMAC by
-- definition. The second flips the default so rows inserted from now on are
-- FALSE. Doing this as an UPDATE instead would re-run on every boot and mark
-- freshly-registered HMAC accounts as legacy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_hash_legacy BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ALTER COLUMN username_hash_legacy SET DEFAULT FALSE;

-- The only copy of a user's keys that a never-seen-before device can reach.
--
-- Sealed client-side under Argon2id(recovery code), where the code is 256 bits
-- of CSPRNG output shown once at registration. The server holding this is safe
-- in a way that holding the vault would not be: the vault is sealed under a
-- human-chosen password and would be an offline cracking target, whereas there
-- is no dictionary for 256 random bits.
--
-- No verifier for the code is stored -- not even a hash. A verifier would hand
-- anyone with a dump an offline oracle to grind against. The ciphertext is the
-- check: a wrong code fails the Poly1305 tag.
CREATE TABLE IF NOT EXISTS recovery_blobs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  -- Argon2id salt for the recovery code. Public by design, like vault_salt: the
  -- client needs it before it can derive anything.
  salt TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Mailed single-use tokens: address confirmation and password reset.
--
-- Stored as sha256(token). The token is 256 bits of CSPRNG output, so a plain
-- digest is right here -- there is nothing to grind and unlike a password it
-- needs no KDF.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  -- For 'verify': the pending address, encrypted. It is written to users only
  -- when the link is used, so typoing a stranger's address does not attach it to
  -- your account until they confirm it (and they never will).
  email_ct TEXT,
  email_dek TEXT,
  email_hash TEXT,
  email_mask TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS email_tokens_expires_idx ON email_tokens (expires_at);

-- A paid subscription, deliberately not joined to a payment identity.
--
-- Purchase happens logged out. Stripe's metadata carries `id` from this table
-- and nothing else -- no user id, no username. The buyer gets a redemption code
-- and attaches the badge themselves.
--
-- Honest limit: Stripe knows (payer email, id) and this table knows (id,
-- user_id). Neither side alone links a human to an account; anyone holding both
-- joins them on `id` immediately. The claim is "our database contains no link",
-- not "there is no link".
CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC of the redemption code. Nulled once redeemed: it has no further use and
  -- keeping it is keeping a credential.
  redeem_hash TEXT UNIQUE,
  -- Null until redeemed. This column is the entire user<->payment link.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unredeemed',
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entitlements_user_idx ON entitlements (user_id, status);

-- 'subscription' | 'gift'. A subscription's clock is Stripe's (it renews and
-- invoice.paid extends it). A gift is a one-off payment worth N months, which
-- Stripe has no way to express -- so the duration lives here.
ALTER TABLE entitlements ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'subscription';

-- Months a gift is worth. Null for subscriptions, where Stripe owns the period.
ALTER TABLE entitlements ADD COLUMN IF NOT EXISTS duration_months INT;

-- Nullable, because an unredeemed gift has no expiry *yet*.
--
-- This is the crux of the gift model: the clock starts when the code is
-- redeemed, not when it is bought. Someone who buys a 12-month gift in January
-- and hands it over in June must give the recipient 12 months from June. Setting
-- expires_at at purchase would silently burn the difference.
ALTER TABLE entitlements ALTER COLUMN expires_at DROP NOT NULL;

-- Unredeemed gift codes never expire. Prepaid value with an expiry date is
-- restricted or outright banned in much of the EU and US and an unredeemed row
-- grants nothing anyway -- the only cost of keeping it is one dead row.
--
-- status values:
--   unredeemed -- bought, code outstanding, grants nothing
--   credit     -- gift redeemed but PARKED: the account has an active
--                 subscription, so these months must not burn yet
--   active     -- currently granting time; expires_at is meaningful
--   cancelled  -- subscription cancelled at Stripe; runs out its paid period
--   expired    -- ran out
--
-- 'credit' is the interesting one. Without it, redeeming a gift while
-- subscribed would extend an expiry the subscription is already paying to
-- extend -- so the user would pay for months they had been given. Parked credit
-- waits until no subscription is active, then starts counting. See badgeFor().
CREATE INDEX IF NOT EXISTS entitlements_credit_idx
  ON entitlements (user_id, kind, status) WHERE status = 'credit';

-- Stripe retries webhooks and does not promise exactly-once. Without this, a
-- retried invoice.paid extends the subscription twice.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------
-- WebAuthn second factor (ROADMAP #5)
--
-- Optional. A registered credential turns login into two steps: a correct
-- password no longer issues a session on its own -- the account must also prove
-- possession of an enrolled authenticator. This gates the LOGIN path only; it is
-- not a crypto root and never touches the vault (message keys are sealed under
-- the password, which WebAuthn does not replace). An offline attacker with a DB
-- dump plus the password decrypts the vault directly -- the assertion never runs
-- -- so this is protection against online credential theft, not a backup leak.
--
-- The stored public key and counter are not secrets. We hold no username here to
-- put in the authenticator UI, by design; the ceremony uses a neutral label.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id          TEXT PRIMARY KEY,               -- base64url credential id
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  BYTEA NOT NULL,                 -- COSE public key
  counter     BIGINT NOT NULL DEFAULT 0,      -- signature counter, clone detection
  transports  TEXT,                           -- JSON array, hint for the next ceremony
  label       TEXT,                           -- user-facing name for the key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx
  ON webauthn_credentials (user_id);

-- Incognito channels (ROADMAP #7, premium). A display mode: members appear only
-- as stable per-channel colors, never names or avatars and no profile is
-- broadcast into the channel. The flag itself is not sensitive -- the server
-- already knows the membership it routes for -- so it lives here in plaintext.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS incognito BOOLEAN NOT NULL DEFAULT FALSE;

-- The sender's stable message id, carried end-to-end so every client stores a
-- message under the SAME id. Without it, the sender kept its own random client
-- id while recipients used this table's row id -- so an edit/delete/reaction
-- targeting a message could never be matched on the other side.
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS client_id TEXT;

-- ------------------------------------------------------------------
-- Direct messages (1:1 channels) + blocking.
--
-- A DM is an ordinary channel with type='dm' and exactly two members, created by
-- one user against another rather than joined by a code. It reuses the whole
-- channel-key handshake (the initiator mints a key and wraps it for the peer),
-- so nothing below changes what the server can see: message bodies and call
-- signaling stay end-to-end encrypted ciphertext it only routes.
-- ------------------------------------------------------------------

-- 'group' (code-joinable, N members) | 'dm' (1:1, created against a user).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'group';

-- The two members' UUIDs sorted and joined 'min:max'. Its uniqueness is what
-- makes DM creation idempotent: a pair has at most one DM, so a second attempt
-- returns the existing room instead of a duplicate. Null for group channels;
-- the partial unique index below lets those NULLs coexist.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_key_idx
  ON channels (dm_key) WHERE dm_key IS NOT NULL;

-- One row = "blocker no longer wants blocked's DM messages and blocked cannot
-- open a new DM with blocker". Pair-scoped, not channel-scoped, so it survives
-- leaving and re-creating the DM. DM-scoped by design: it never touches a shared
-- group channel (see the block-scope decision in the plan).
--
-- Enforced in two places: the relay skips queueing a message to a recipient who
-- blocked the sender (delivery stops) and POST /channel/dm refuses a blocked
-- initiator (no new DM).
CREATE TABLE IF NOT EXISTS dm_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Lookup by (recipient blocked sender?) on every relayed DM frame, so index the
-- direction the relay queries.
CREATE INDEX IF NOT EXISTS dm_blocks_pair_idx ON dm_blocks (blocker_id, blocked_id);
