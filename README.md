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
channel, when they send, and the **size** of messages and files. It also learns
any URL you explicitly ask it to preview (see [Link previews](#link-previews)).

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

## File attachments

Any file type, up to **50MB**. Files never travel in the message envelope —
base64 would add 33%, and the relay duplicates each queued message *per
recipient*. Instead:

1. The client mints a **random per-file key** (never the channel key) and
   encrypts with `crypto_secretstream_xchacha20poly1305` in 1MB chunks.
2. Chunks upload sequentially to the blob store as raw
   `application/octet-stream`. **One ciphertext copy**, regardless of member
   count. Resumable via `GET /blob/:id/status`.
3. The envelope carries only `{blobId, key, header, name, mime, size, hash}` —
   a few hundred bytes, well under the 256KB cap.
4. Recipients stream it back and decrypt. `TAG_FINAL` catches truncation, and
   the signed `hash` and `size` are verified before the file is saved.

The server stores ciphertext plus routing metadata. It never learns the
filename, the type, or the contents — the `blobs` table has no column for them.
Blob IDs are **random, not content hashes**: content-addressing would enable
dedup, which hands the server a confirmation oracle for known files.

Chunking also keeps every HTTP body ~1MB, which sidesteps proxy body limits
(Cloudflare's free tier rejects a single body over 100MB).

### Images render inline; everything else downloads

Images (`png`/`jpeg`/`gif`/`webp`/`avif`) display in the chat with no download
button. **Animated GIFs play** — the *original* bytes are served, not the
envelope thumbnail, which is canvas-flattened and would show only frame one.
The thumbnail is used as an instant poster while the real file arrives.

Loading is lazy (`IntersectionObserver`), cached with an LRU budget so scrolling
doesn't refetch, and the cache is dropped on lock so decrypted images never
outlive the key. Images above 12MB need a click — decoding is the risk, not
downloading: a 40MB PNG can declare 30000×30000 and expand to gigabytes.

**The declared MIME is never trusted.** A file's type is chosen by the sender,
so bytes are sniffed by magic number and only rendered if they really are a
bitmap on the allowlist. **SVG is excluded and must stay excluded** — it's a
document, not a bitmap, and a blob URL holding one executes script in this
origin. A file named `.png` containing HTML falls back to a download-only card.

Non-images are download-only, forced to `application/octet-stream`, with
filenames sanitized against bidi-override tricks (`invoice‮fdp.exe`).

**Honest limits.** The server *cannot scan attachments for malware* — it holds
ciphertext. That's inherent to E2E. And unlike images (which are re-encoded
through a canvas, stripping EXIF), **metadata inside a `.pdf`, `.docx`, `.zip`,
or `.mp4` cannot be stripped** — author names, GPS, local paths ride along
inside the format. Encryption hides that from the *relay*, not from the people
in the channel.

## Link previews

**Off by default.** Links render as plain clickable text and fetch nothing.

- Prefix a link with `!` to preview that one: `!https://example.com`
- Settings → *Always preview links* makes it the default for the first link.

The **sender** builds the preview: their client asks the relay to fetch the
URL's Open Graph tags (CORS stops the browser doing it directly), re-encodes
the thumbnail through the canvas path, and ships the result **inside the
encrypted envelope**. Recipients render it having made **zero network
requests**.

A link that *is* an image renders as the image. If the original is ≤150KB it is
embedded whole rather than canvas-thumbnailed, so a linked **GIF keeps its
frames and animates**; larger ones fall back to a static thumbnail to stay under
the 256KB envelope cap.

That last part is the whole point. If recipients unfurled links themselves,
posting a link to a server you control would harvest the IP address of everyone
in the channel. Same reason YouTube is a thumbnail and a link, **not an
iframe** — clicking is the user's own explicit choice to reveal themselves.

**The cost, stated plainly:** generating a preview tells the relay which URL you
sent. That's the one place the server learns message content, which is why it is
never automatic. Set `UNFURL_ENABLED=false` to remove the endpoint entirely.

`/unfurl` fetches user-supplied URLs, so it is hardened against SSRF: http/https
only, no credentials in URL, private/loopback/link-local/CGNAT/metadata ranges
rejected for **both** hostnames and literal IPs, DNS validated at connect time
via a `lookup` hook (closing DNS rebinding), redirects followed manually and
re-validated, plus size and time caps. Errors are generic so it can't be used as
an internal port scanner.

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
