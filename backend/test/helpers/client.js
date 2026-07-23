import { createRequire } from "module";
import fs from "fs";
import WebSocket from "ws";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const require = createRequire(import.meta.url);
// The CJS build: the package's ESM entry is broken (see frontend/vitest.config.ts).
const sodium = require("libsodium-wrappers-sumo");

/**
 * A user emulator.
 *
 * This is a real client, not a mock. It generates real keys, seals real
 * envelopes and speaks the real HTTP and WebSocket protocol -- so these tests
 * fail for the same reasons the browser would. Mocking the crypto here would
 * mean the suite passes while the product is broken.
 *
 * Deliberately a re-implementation of the frontend's crypto rather than an
 * import of it: the frontend is TypeScript and browser-targeted and a shared
 * module would let a bug cancel itself out on both sides. If these two ever
 * disagree, that disagreement is the bug.
 */

/**
 * Where the emulator points.
 *
 * TEST_PORT lets a suite run on a free port when 3000 is taken (a dev server,
 * or two suites at once). The server helper reads the same variable, so the two
 * cannot drift apart.
 */
const TEST_PORT = process.env.TEST_PORT || "3000";
const API = process.env.TEST_API_URL || `http://localhost:${TEST_PORT}`;

let ready = false;
export async function initCrypto() {
    if (!ready) {
        await sodium.ready;
        ready = true;
    }
}

const B64 = () => sodium.base64_variants.URLSAFE_NO_PADDING;
const toB64 = (b) => sodium.to_base64(b, B64());
const fromB64 = (s) => sodium.from_base64(s, B64());

function bytesToBase64Url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return Buffer.from(s, "binary").toString("base64url");
}

export class ApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

async function call(path, { method = "GET", body, token } = {}) {
    const res = await fetch(API + path, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        parsed = { raw: text };
    }

    if (!res.ok) throw new ApiError(parsed.error || `HTTP ${res.status}`, res.status, parsed);
    return { ...parsed, __status: res.status };
}

export { call, API };

/** Unique per run, so tests never collide on a username. */
export function uniqueName(prefix = "u") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A full client identity: keys, vault salt, recovery code.
 */
export class TestUser {
    constructor(username, password) {
        this.username = username || uniqueName();
        this.password = password || "a-perfectly-fine-password";
        this.token = null;
        this.userId = null;
        this.channels = new Map();
    }

    async generateIdentity() {
        await initCrypto();
        const box = sodium.crypto_box_keypair();
        const sign = sodium.crypto_sign_keypair();
        this.identity = {
            publicKey: toB64(box.publicKey),
            privateKey: toB64(box.privateKey),
            signPublicKey: toB64(sign.publicKey),
            signPrivateKey: toB64(sign.privateKey),
            vaultSalt: toB64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)),
        };
        return this.identity;
    }

    async register({ email } = {}) {
        if (!this.identity) await this.generateIdentity();

        const res = await call("/auth/register", {
            method: "POST",
            body: {
                username: this.username,
                password: this.password,
                pubkey: this.identity.publicKey,
                signPubkey: this.identity.signPublicKey,
                vaultSalt: this.identity.vaultSalt,
                ...(email ? { email } : {}),
            },
        });

        this.token = res.token;
        this.userId = res.userId;
        this.email = email ?? null;
        return res;
    }

    async login(password = this.password) {
        const res = await call("/auth/login", {
            method: "POST",
            body: { username: this.username, password },
        });
        this.token = res.token;
        this.userId = res.userId;
        return res;
    }

    me() {
        return call("/auth/me", { token: this.token });
    }

    limits() {
        return call("/account/limits", { token: this.token });
    }

    /* --- recovery --- */

    async makeRecoveryCode() {
        await initCrypto();
        this.recoveryPhrase = bip39.generateMnemonic(wordlist, 256);
        this.recoveryEntropy = bip39.mnemonicToEntropy(this.recoveryPhrase, wordlist);
        return this.recoveryPhrase;
    }

    #deriveRecoveryKey(entropy, salt) {
        return sodium.crypto_pwhash(
            32,
            bytesToBase64Url(entropy),
            fromB64(salt),
            sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_ALG_ARGON2ID13,
        );
    }

    async uploadRecoveryBlob() {
        await initCrypto();
        if (!this.recoveryPhrase) await this.makeRecoveryCode();

        const salt = toB64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
        const key = this.#deriveRecoveryKey(this.recoveryEntropy, salt);
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const payload = {
            v: 1,
            userId: this.userId,
            identity: this.identity,
            channels: [...this.channels.values()].map((c) => ({
                channelId: c.channelId,
                code: c.code,
                key: c.key,
            })),
            exportedAt: new Date().toISOString(),
        };

        const ciphertext = sodium.crypto_secretbox_easy(
            Buffer.from(JSON.stringify(payload), "utf8"),
            nonce,
            key,
        );

        await call("/account/recovery-blob", {
            method: "PUT",
            token: this.token,
            body: { ciphertext: toB64(ciphertext), nonce: toB64(nonce), salt },
        });

        return { ciphertext: toB64(ciphertext), nonce: toB64(nonce), salt };
    }

    async fetchAndOpenRecoveryBlob(phrase = this.recoveryPhrase) {
        await initCrypto();
        const blob = await call("/account/recovery-blob", { token: this.token });
        const entropy = bip39.mnemonicToEntropy(phrase, wordlist);
        const key = this.#deriveRecoveryKey(entropy, blob.salt);

        const opened = sodium.crypto_secretbox_open_easy(
            fromB64(blob.ciphertext),
            fromB64(blob.nonce),
            key,
        );
        return JSON.parse(Buffer.from(opened).toString("utf8"));
    }

    /* --- email --- */

    addEmail(email, password = this.password) {
        return call("/account/email", {
            method: "POST",
            token: this.token,
            body: { email, password },
        });
    }

    getEmail() {
        return call("/account/email", { token: this.token });
    }

    removeEmail(password = this.password) {
        return call("/account/email", { method: "DELETE", token: this.token, body: { password } });
    }

    /* --- channels --- */

    async createChannel() {
        await initCrypto();
        const res = await call("/channel/create", { method: "POST", token: this.token });
        const key = toB64(sodium.crypto_secretbox_keygen());
        this.channels.set(res.channelId, { channelId: res.channelId, code: res.code, key });
        return res;
    }

    async joinChannel(code, key) {
        const res = await call("/channel/join", {
            method: "POST",
            token: this.token,
            body: { code },
        });
        this.channels.set(res.channelId, { channelId: res.channelId, code, key });
        return res;
    }

    listChannels() {
        return call("/channel/list", { token: this.token });
    }

    leaveChannel(channelId) {
        this.channels.delete(channelId);
        return call(`/channel/${channelId}/leave`, { method: "DELETE", token: this.token });
    }

    /* --- blobs --- */

    blobConfig() {
        return call("/blob/config", { token: this.token });
    }

    blobInit(channelId, declaredBytes, declaredChunks = 1) {
        return call("/blob/init", {
            method: "POST",
            token: this.token,
            body: { channelId, declaredBytes, declaredChunks },
        });
    }

    /* --- webauthn / 2fa --- */

    twoFactorStatus() {
        return call("/account/2fa", { token: this.token });
    }

    twoFactorRegisterOptions() {
        return call("/account/2fa/register/options", { method: "POST", token: this.token });
    }

    removeCredential(id) {
        return call(`/account/2fa/${id}`, { method: "DELETE", token: this.token });
    }

    /** Login without mutating this.token, so the raw body (2fa branch) is inspectable. */
    loginRaw(password = this.password) {
        return call("/auth/login", { method: "POST", body: { username: this.username, password } });
    }

    completeTwoFactor(challengeToken, response) {
        return call("/auth/login/2fa", { method: "POST", body: { challengeToken, response } });
    }

    /* --- billing --- */

    billingStatus() {
        return call("/billing/status", { token: this.token });
    }

    redeem(code) {
        return call("/billing/redeem", { method: "POST", token: this.token, body: { code } });
    }

    /* --- relay (WebSocket) --- */

    /**
     * Open the real relay socket, speaking the same subprotocol the browser does:
     * 'darkchat' plus a 'bearer.<token>' entry the handshake reads instead of a
     * query string. Buffers every inbound frame so a test can assert on one that
     * may have already arrived.
     */
    async connectRelay() {
        const url = API.replace(/^http/, "ws") + "/ws";
        const ws = new WebSocket(url, ["darkchat", `bearer.${this.token}`]);

        this._inbox = [];
        this._waiters = [];

        ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            this._inbox.push(msg);
            for (let i = this._waiters.length - 1; i >= 0; i--) {
                if (this._waiters[i].pred(msg)) {
                    this._waiters[i].resolve(msg);
                    this._waiters.splice(i, 1);
                }
            }
        });

        await new Promise((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });

        this.ws = ws;
        return ws;
    }

    sendRelay(obj) {
        this.ws.send(JSON.stringify(obj));
    }

    /** Resolve with the first buffered or future frame matching `pred`. */
    waitForRelay(pred, { timeout = 5000 } = {}) {
        const existing = this._inbox.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = { pred, resolve };
            this._waiters.push(waiter);
            const timer = setTimeout(() => {
                const i = this._waiters.indexOf(waiter);
                if (i >= 0) this._waiters.splice(i, 1);
                reject(new Error("waitForRelay timed out"));
            }, timeout);
            timer.unref?.();
        });
    }

    /** Assert a frame did NOT arrive within `window` ms. */
    async expectNoRelay(pred, { window = 500 } = {}) {
        try {
            await this.waitForRelay(pred, { timeout: window });
            return false;
        } catch {
            return true;
        }
    }

    closeRelay() {
        try {
            this.ws?.close();
        } catch {
            // already closing
        }
    }
}

/**
 * Pull the most recent mailed link out of the dev mailer's console output.
 *
 * The dev mailer prints to stdout when MAIL_API_KEY is unset, which is exactly
 * how a developer clicks through the flow locally -- so the tests read it the
 * same way rather than reaching into the database.
 */
export function lastMailLink(logPath, kind) {
    const pattern = new RegExp(`${kind}\\?token=([A-Za-z0-9_-]+)`, "g");
    const log = fs.readFileSync(logPath, "utf8");
    const matches = [...log.matchAll(pattern)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

export async function waitFor(fn, { timeout = 5000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try {
            const result = await fn();
            if (result) return result;
        } catch (err) {
            last = err;
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    throw last ?? new Error("waitFor timed out");
}
