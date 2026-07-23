# Deployment (Coolify)

## Repo model. one monorepo

Everything lives in a single Git repository: `backend/`, `frontend/`,
`docker-compose.yml` and this file. Do **not** split into two repos. Coolify
deploys multiple "resources" from different base directories of the _same_ repo.

### What to push to GitHub

Push the whole project **except** what `.gitignore` excludes:

- Ignored (never pushed): `node_modules/`, `dist/` and every `.env` file.
- Pushed: all source, both `package.json` + `package-lock.json`, both
  `.env.example`, `schema.sql`, `Dockerfile`, `docker-compose.yml`, configs.

First-time setup:

```bash
git init
git add .
git commit -m "chore: initial commit"
git branch -M main
git remote add origin git@github.com:<you>/CryptChat.git
git push -u origin main
```

Secrets (`JWT_SECRET`, DB password) are set in the Coolify UI, **not** committed.

---

## Coolify. three resources in one project

Create one Coolify Project, then add these three resources. All point at the
same GitHub repo; they differ by **Base Directory** and build settings.

### 1. Postgres (database)

- Coolify → **New Resource → Database → PostgreSQL 16**.
- After it starts, copy its **internal connection URL** (looks like
  `postgres://postgres:<pw>@<service-name>:5432/postgres`). Backend uses this.
- No manual schema step: the backend applies `schema.sql` itself on boot
  (idempotent, retries until the DB is reachable).

### 2. Backend (application)

- Coolify → **New Resource → Application → your GitHub repo**.
- **Build Pack:** Dockerfile.
- **Base Directory:** `/backend` (Dockerfile is `backend/Dockerfile`).
- **Port (exposed):** `3000`.
- Give it a public domain, e.g. `https://api.CryptChat.example.com`.
- **Environment variables.** Everything below is checked at boot; a missing one
  logs `FATAL: ...` and exits, so the container restart-loops instead of half-working.

    | Key                    | Value                                                                                      |
    | ---------------------- | ------------------------------------------------------------------------------------------ |
    | `NODE_ENV`             | `production`                                                                               |
    | `PORT`                 | `3000`                                                                                     |
    | `DATABASE_URL`         | internal Postgres URL from step 1 (point db name at the one you want, e.g. `.../darkchat`) |
    | `JWT_SECRET`           | random string, min 32 chars (`openssl rand -hex 32`)                                       |
    | `CORS_ORIGIN`          | the frontend's public URL (step 3), e.g. `https://CryptChat.example.com`. no `*`           |
    | `PUBLIC_APP_URL`       | same frontend URL. builds links in outbound mail, derives the WebAuthn RP id               |
    | `MAIL_API_KEY`         | mail provider key. without it, verification and reset mail goes nowhere                    |
    | `MAIL_FROM`            | sender address, e.g. `no-reply@CryptChat.example.com`                                      |
    | `EMAIL_MASTER_KEY`     | 32 random bytes, base64 (see command below)                                                |
    | `EMAIL_INDEX_PEPPER`   | 32 random bytes, base64. must differ from the others                                       |
    | `USERNAME_INDEX_PEPPER`| 32 random bytes, base64. must differ from the others                                       |
    | `REDEEM_PEPPER`        | 32 random bytes, base64. must differ from the others                                       |
    | `BLOB_DIR`             | `/data/blobs`. must match the persistent storage mount below                               |

    ```bash
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    ```

    > Generate the four key/pepper values **separately**. They protect different
    > things (a reversible address, two search indexes, a payment code); reusing
    > one value across them makes one leak three leaks. Losing
    > `EMAIL_MASTER_KEY` makes every stored address unreadable. back it up.

- **Optional.** Billing is off unless `STRIPE_SECRET_KEY` is set (routes 404,
  app fully usable). If you enable it, also set `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PORTAL_URL` (else users cannot cancel) and the `STRIPE_PRICE_*` /
  `STRIPE_GIFT_PRICE_*` ids. Calls need `TURN_URL` + `TURN_SECRET`.

- WebSocket relay is served on the same domain at path `/ws`. Coolify's Traefik
  proxy passes WebSockets through on the app's domain by default. no extra config.

#### Persistent storage for attachments (required)

Encrypted files are written to `BLOB_DIR`. Without a volume they live in the
container filesystem and **every redeploy wipes them**.

- Coolify → backend app → **Storages** → add persistent storage mounted at
  `/data/blobs`.
- Back it with a **Hetzner Volume** (block storage, ~€0.044/GB/mo, resizes live)
  rather than the VPS root disk. plans are small and 50MB files fill them fast.

> **Put blobs on a different disk from Postgres.** If they share one and blobs
> fill it, Postgres cannot write and the whole app goes down. Separate volumes
> turn a storage incident into a failed upload instead of an outage.

**Backups:** Coolify backs up Postgres, _not_ arbitrary volumes. the blob volume
is unprotected by default. Use `restic`/`borg` from the Volume to a **Hetzner
Storage Box** (cheap, off-box; it speaks SFTP/Borg, not S3, so it's a backup
target, not a live store).

**Uploads and proxies:** files upload in ~1MB chunks, so no single request is
large. If you ever put Cloudflare in front of this, that matters. the free tier
rejects any request body over 100MB.

**Scaling out:** `src/blobStore.js` is a narrow interface (`append` /
`createReadStream` / `size` / `remove` / `downloadUrl`). Swapping local disk for
S3-compatible storage (e.g. Hetzner Object Storage) is one adapter with no
call-site changes. Worth doing if you go multi-node, pass a few hundred GB, or
want browsers to talk straight to storage via presigned URLs instead of
streaming through Node.

### 3. Frontend (static site)

- Coolify → **New Resource → Application → same GitHub repo**.
- **Build Pack:** Nixpacks (static). or "Static" if offered.
- **Base Directory:** `/frontend`.
- **Install command:** `npm install`
- **Build command:** `npm run build`
- **Output / Publish directory:** `dist`
- Give it a public domain, e.g. `https://CryptChat.example.com`.
- **Build-time environment variable:**

    | Key            | Value                                                          |
    | -------------- | -------------------------------------------------------------- |
    | `VITE_API_URL` | backend's public URL, e.g. `https://api.CryptChat.example.com` |

    > ⚠️ `VITE_API_URL` is **baked into the JS at build time**, not read at
    > runtime. If the backend URL changes, you must **rebuild/redeploy the
    > frontend**. This also drives the WebSocket URL (`https:`→`wss:`, `+/ws`).

### Wiring recap

```
browser ──HTTPS──▶ frontend (static, CryptChat.example.com)
   │
   ├──HTTPS  fetch (VITE_API_URL) ─▶ backend api.CryptChat.example.com  ─▶ Postgres
   └──WSS    /ws (token in query) ─▶ backend (same domain)
```

`CORS_ORIGIN` on the backend must equal the frontend's origin, or the browser
blocks every API call.

---

## Deploy order

1. Deploy **Postgres** first.
2. Deploy **backend** (needs `DATABASE_URL`). It logs `schema ready` once tables
   exist, then `CryptChat backend on :3000`.
3. Deploy **frontend** last (needs the backend URL in `VITE_API_URL`).

Redeploy = push to `main`; enable auto-deploy per resource in Coolify if wanted.
Changing the backend URL later means redeploying the frontend too.

---

## Alternative: single docker-compose deploy

Coolify can also deploy `docker-compose.yml` directly (db + backend). It does
**not** include the frontend and the compose file publishes Postgres on host
port `5433` for local dev. remove that `ports:` block for a server deploy. The
three-resource split above is the recommended path; use compose only if you
specifically want DB + backend bundled.

```

```
