# Deployment (Coolify)

## Repo model — one monorepo

Everything lives in a single Git repository: `backend/`, `frontend/`,
`docker-compose.yml`, and this file. Do **not** split into two repos. Coolify
deploys multiple "resources" from different base directories of the *same* repo.

### What to push to GitHub

Push the whole project **except** what `.gitignore` excludes:

- Ignored (never pushed): `node_modules/`, `dist/`, and every `.env` file.
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

## Coolify — three resources in one project

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
- **Base Directory:** `/backend`  (Dockerfile is `backend/Dockerfile`).
- **Port (exposed):** `3000`.
- Give it a public domain, e.g. `https://api.CryptChat.example.com`.
- **Environment variables:**

  | Key            | Value                                                        |
  |----------------|-------------------------------------------------------------|
  | `PORT`         | `3000`                                                      |
  | `DATABASE_URL` | internal Postgres URL from step 1 (point db name at the one you want, e.g. `.../darkchat`) |
  | `JWT_SECRET`   | long random string (`openssl rand -hex 32`)                |
  | `CORS_ORIGIN`  | the frontend's public URL (step 3), e.g. `https://CryptChat.example.com` |

- WebSocket relay is served on the same domain at path `/ws`. Coolify's Traefik
  proxy passes WebSockets through on the app's domain by default — no extra config.

### 3. Frontend (static site)

- Coolify → **New Resource → Application → same GitHub repo**.
- **Build Pack:** Nixpacks (static) — or "Static" if offered.
- **Base Directory:** `/frontend`.
- **Install command:** `npm install`
- **Build command:** `npm run build`
- **Output / Publish directory:** `dist`
- Give it a public domain, e.g. `https://CryptChat.example.com`.
- **Build-time environment variable:**

  | Key            | Value                                         |
  |----------------|-----------------------------------------------|
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
**not** include the frontend, and the compose file publishes Postgres on host
port `5433` for local dev — remove that `ports:` block for a server deploy. The
three-resource split above is the recommended path; use compose only if you
specifically want DB + backend bundled.
```
