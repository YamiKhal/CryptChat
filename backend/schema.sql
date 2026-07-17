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
-- is not a secret, and the client needs it before it can decrypt anything, so
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
