# CryptChat

Monorepo: `backend/` (Express + ws + Postgres) and `frontend/` (Vite + React).
Deployment lives in [DEPLOY.md](DEPLOY.md).

## Local development

One-time setup (installs root, backend, and frontend deps, and creates `.env`
files if missing):

```
npm run setup
cp backend/.env.example backend/.env     # only if backend/.env doesn't exist
cp frontend/.env.example frontend/.env   # only if frontend/.env doesn't exist
```

Then set `JWT_SECRET` in `backend/.env`. The server **refuses to boot** without
one that is at least 32 characters and is not the example placeholder — a weak
signing secret forges every session, so it fails loudly instead of running
insecurely:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`CORS_ORIGIN` must also be an explicit origin (not `*`) when
`NODE_ENV=production`. It gates both CORS and the WebSocket handshake.

Then boot **everything** from the repo root with one command:

```
npm run dev
```

This starts Postgres (Docker), then runs the backend and frontend together with
combined, colour-tagged logs. The backend applies `schema.sql` on boot, so there
is no manual DB setup. `Ctrl+C` stops both.

- Backend: http://localhost:3000  (auto-restarts on change via nodemon)
- Frontend: http://localhost:5173  (hot-reloads via Vite)
- Postgres: host port **5433** (chosen to avoid clashing with other local Postgres)

### Root scripts

| Command                 | What it does                                        |
|-------------------------|-----------------------------------------------------|
| `npm run setup`         | Install deps for root + backend + frontend          |
| `npm run dev`           | Start db + backend + frontend together              |
| `npm run dev:backend`   | Backend only                                        |
| `npm run dev:frontend`  | Frontend only                                       |
| `npm run db:up`         | Start Postgres in the background                     |
| `npm run db:down`       | Stop Postgres                                        |
| `npm run db:reset`      | Wipe the DB volume and start fresh                  |
| `npm run build`         | Production build of the frontend                    |

**Restarting:** backend and frontend already auto-reload on file changes. To
restart the whole stack, `Ctrl+C` then `npm run dev` again. To wipe the DB,
`npm run db:reset`.

### Docker (backend + db only)
```
docker compose up --build
```
Runs Postgres + backend. Frontend is run separately (`npm run dev:frontend`).

## What the server knows

Nothing that identifies you or your messages. It stores `sha256(username)`, an
Argon2id password verifier, two public keys, and ciphertext it cannot open.
Display names and avatars are **not** server-side — they travel inside the
end-to-end encrypted envelope and are only ever sent to people who already hold
the channel key.

The relay does see metadata it cannot avoid seeing: which user IDs share a
channel, and when they send.

## Key exchange

The server never holds a channel key, so it cannot hand one to a joiner:

1. The creator mints the channel key locally (`generateChannelKey`).
2. A joiner posts the code to `/channel/join`; the server registers membership
   and pushes `member-joined` to existing members.
3. An online member wraps the key for the joiner's X25519 public key
   (`crypto_box`, authenticated) and relays it as `key-offer`. If nobody is
   online, it is parked in `key_offers` until the joiner connects.
4. The joiner unwraps it, then publishes its profile and pulls the others'
   (`request-profile`).

If no member is online, the joiner sits in a **no key** state and the UI says
so, rather than showing an empty channel that will never populate.

## Message authenticity

Every member holds the same channel key, so decryption alone proves nothing
about *who* wrote a message. Each envelope is signed with the sender's Ed25519
key over a length-prefixed canonical encoding that commits to `channelId` and
`senderId`, so a message cannot be replayed into another channel or
reattributed. Peer keys are pinned on first use; a key change is flagged in the
UI rather than silently accepted. Unverified messages render an
`unverified` badge.

Compare fingerprints (Settings → identity) out of band to confirm nobody
swapped keys in between.

## Keys at rest, and moving devices

Private keys and channel keys are encrypted at rest with a key derived from
your password via Argon2id (`crypto_pwhash`), namespaced per account — two
usernames in the same browser cannot read each other's vaults. The vault key is
held in memory, with an optional tab-scoped `sessionStorage` copy so a reload
does not re-prompt.

Because the server never has your private keys, logging in on a new device
leaves it with **no keys**. That device shows an import prompt: export an
encrypted key file (Settings → export keys) and import it there. Use a
different passphrase for the file than your login password — the file leaves
the device.

There is no password reset. Forgetting it means the vault is unrecoverable.

> **Note:** the frontend depends on `libsodium-wrappers-sumo`, not
> `libsodium-wrappers`. The standard build omits `crypto_pwhash` (Argon2id),
> which the vault depends on, while `@types` declares it either way — so the
> standard build typechecks and then fails at runtime.
