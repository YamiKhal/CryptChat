# Voice, video & screen-share calls (coturn)

CryptChat's 1:1 calls (inside direct messages) are peer-to-peer WebRTC. The media
is DTLS-SRTP encrypted end-to-end and **never touches our servers**. The backend
does exactly two things for a call:

1. Routes the **signaling** (offer / answer / ICE candidates). as signed,
   channel-key-encrypted envelopes over the existing relay socket, so it sees
   only ciphertext, not the SDP.
2. Hands out **ICE servers** at `GET /rtc/ice` so the two browsers can find a
   path to each other.

Tiers, exactly:

- **Voice**. free for both sides.
- **Video**. supporter feature, **both** sides must be premium (the caller is
  gated when starting; a non-premium callee auto-declines a video offer).
- **Screen-share**. only the person **sharing** needs premium; the other side
  sees the shared screen whatever their tier. It runs inside an ordinary voice
  call, so two free users can talk and a premium one can still share to them.

Outgoing audio uses the browser's echo-cancellation, noise-suppression and
auto-gain, so a voice call is a conversation rather than a feedback loop.

You can ship calls with **no extra infrastructure**. two peers on the same LAN
or behind friendly NATs will connect with STUN alone. What you cannot do without
TURN is connect the ~10–20% of calls where both peers sit behind strict
(symmetric) NATs. For a real deployment you want a **coturn** server providing
both STUN and TURN. This guide sets that up alongside the existing
Coolify-on-Hetzner deployment described in [DEPLOY.md](../DEPLOY.md).

---

## Why coturn (and not a public STUN)

A public STUN server (e.g. Google's) would work, but it means a third party
learns the IP address of everyone who places a call. the wrong trade for a
privacy product. Self-hosting coturn keeps ICE discovery on infrastructure you
control. TURN, when a call needs it, only ever relays **encrypted** SRTP; coturn
cannot read the media.

Credentials are **not** static. `/rtc/ice` mints a short-lived username/password
pair using coturn's `use-auth-secret` (HMAC) scheme, so a leaked credential
expires within the hour and no long-lived TURN password is stored anywhere.

---

## 1. DNS & firewall (Hetzner)

Point a subdomain at your Hetzner VPS, e.g. `turn.yourdomain.com → <VPS IP>`.

Open these ports on the **Hetzner Cloud Firewall** (and any host firewall/ufw):

| Port        | Proto   | Purpose                       |
| ----------- | ------- | ----------------------------- |
| 3478        | UDP+TCP | STUN / TURN                   |
| 5349        | UDP+TCP | STUN / TURN over TLS (turns:) |
| 49152–65535 | UDP     | TURN relay media port range   |

The relay range is wide by design. each relayed call leases a port from it.

---

## 2. Run coturn as a Coolify resource

Coolify deploys from your monorepo; add coturn as one more resource. The cleanest
route is a **Docker Compose** resource (Coolify → New Resource → Docker Compose)
pointing at the `coturn/coturn` image, with `network_mode: host` so the wide UDP
relay range is reachable without per-port mapping.

```yaml
# coturn/docker-compose.yml  (a separate Coolify resource, same repo)
services:
    coturn:
        image: coturn/coturn:4.6-alpine
        restart: unless-stopped
        network_mode: host
        command: ["-c", "/etc/coturn/turnserver.conf"]
        volumes:
            - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
            # TLS cert + key for turns: (see step 3).
            - /etc/letsencrypt/live/turn.yourdomain.com:/certs:ro
```

`turnserver.conf`:

```ini
# Listen on all interfaces; advertise the public IP.
listening-port=3478
tls-listening-port=5349
external-ip=<YOUR_VPS_PUBLIC_IP>

# The relay media range opened in the firewall above.
min-port=49152
max-port=65535

# HMAC time-limited credentials. This secret MUST equal the backend's
# TURN_SECRET -- that is the whole handshake.
use-auth-secret
static-auth-secret=<PASTE_THE_SAME_VALUE_AS_TURN_SECRET>

# The realm can be your domain; it is not a secret.
realm=turn.yourdomain.com

# TLS for turns:.
cert=/certs/fullchain.pem
pkey=/certs/privkey.pem

# Lock it down: no relaying to private ranges, no multicast, no loopback.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# Optional: keep logs quiet / off-disk on a small VPS.
no-cli
```

> If `network_mode: host` is awkward in your Coolify setup, you can instead map
> `3478`, `5349` and the full `49152-65535/udp` range explicitly. but host
> networking is far simpler for the relay range.

---

## 3. TLS certificate for `turns:`

Browsers on an HTTPS page must reach TURN over TLS (`turns:`), so coturn needs a
real certificate for `turn.yourdomain.com`. Two options:

- **Reuse Coolify's**: if Coolify/Traefik already issued a cert for the
  subdomain, mount that path into the container (as in the compose above).
- **Standalone certbot** on the VPS:
    ```bash
    certbot certonly --standalone -d turn.yourdomain.com
    ```
    then mount `/etc/letsencrypt/live/turn.yourdomain.com` read-only. Add a
    `--deploy-hook` that restarts the coturn resource on renewal so it picks up the
    new cert.

---

## 4. Point the backend at coturn

Set these on the **backend** Coolify resource (Environment Variables), matching
[backend/.env.example](../backend/.env.example):

```bash
TURN_URL=turns:turn.yourdomain.com:5349
TURN_SECRET=<same value as coturn static-auth-secret>
# STUN_URL is optional; it defaults to the TURN host rewritten to stun:.
STUN_URL=stun:turn.yourdomain.com:3478
TURN_CRED_TTL_SECONDS=3600
```

Redeploy the backend. Note the boot guard: in production, setting `TURN_URL`
without `TURN_SECRET` is a **fatal** error. a half-configured TURN would fail
every relayed call silently, so the server refuses to start instead.

With nothing set, `/rtc/ice` returns STUN-only (or empty) and the app still
offers calls, showing a "no relay. may not connect" hint during connection.

---

## 5. Verify

- `GET /rtc/ice` (with a valid session token) should return an `iceServers`
  array whose TURN entry has a fresh `username` (`<expiry>:<hash>`) and
  `credential` and `"relay": true`.
- From a machine that is **not** on the VPS:
    ```bash
    turnutils_uclient -T -u <username> -w <credential> turn.yourdomain.com
    ```
    (username/credential copied from an `/rtc/ice` response) should allocate a
    relay address.
- End to end: open a DM between two accounts on **different networks** (e.g. a
  laptop on Wi-Fi and a phone on cellular), place a voice call and confirm it
  connects. That path is the one STUN alone cannot make.
- Chrome/Edge `chrome://webrtc-internals` shows which candidate pair won
  (`relay` = TURN was used).

---

## What the server can and cannot see

Honest scope, in keeping with the rest of the project:

- **Cannot** see call media (P2P, DTLS-SRTP) or the SDP/candidates (encrypted in
  the signed envelope before they reach the relay).
- **Can** see that two DM members exchanged some ciphertext around a point in
  time and. if the call is relayed. coturn sees the two endpoints' IPs and
  relays encrypted SRTP it cannot decrypt.
- The premium gates (both-sides-premium video; sharer-premium screen-share) are
  enforced in the clients, not the server. media is P2P, so there is nothing
  server-side to enforce against. A modified client could bypass them; we treat
  them as product perks, not security boundaries and say so.
