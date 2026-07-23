import type { Limits } from "@/lib/limits";

const BASE_URL = (
    import.meta.env.VITE_API_URL || "http://localhost:3000"
).replace(/\/$/, "");

export interface MemberInfo {
    userId: string;
    pubkey: string;
    signPubkey: string;
    joinedAt?: string;
}

export interface AuthResponse {
    token: string;
    userId: string;
    pubkey: string;
    signPubkey: string;
    vaultSalt: string;
    emailPending?: boolean;
}

/**
 * Login can resolve two ways. A normal account gets an AuthResponse. An account
 * with a second factor gets a challenge instead of a token: no session is issued
 * until the authenticator assertion is verified at /auth/login/2fa.
 */
export interface TwoFactorChallenge {
    twoFactorRequired: true;
    challengeToken: string;
    // The @simplewebauthn/browser options blob; passed straight to startAuthentication.
    options: unknown;
}

export type LoginResult = AuthResponse | TwoFactorChallenge;

export function isTwoFactorChallenge(r: LoginResult): r is TwoFactorChallenge {
    return (r as TwoFactorChallenge).twoFactorRequired === true;
}

export interface TwoFactorCredential {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
}

/** The mask, never the address. The server does not expose the plaintext. */
export interface EmailState {
    mask: string | null;
    verified: boolean;
    pendingMask?: string | null;
}

export interface Badge {
    active: boolean;
    /** When the badge was granted -- the record of when they subscribed. */
    since: string;
    until: string;
    /**
     * Gifted months banked but not yet counting.
     *
     * Parked while something else already covers the account, so nobody burns
     * gifted time they are simultaneously paying for. Starts automatically once
     * nothing else is active.
     */
    creditMonths?: number;
}

export interface Plan {
    slug: string;
    kind: "subscription" | "gift";
    months: number;
    label: string;
    blurb: string;
    /** Display price in the store currency, e.g. "4.99". Null when unpriced. */
    priceValue: string | null;
}

export interface MeResponse {
    userId: string;
    pubkey: string;
    signPubkey: string;
    vaultSalt: string;
    email: { mask: string; verified: boolean } | null;
    badge: Badge | null;
}

export interface RecoveryBlobResponse {
    ciphertext: string;
    nonce: string;
    salt: string;
    updatedAt: string;
}

export interface ResetResponse extends AuthResponse {
    needsRecoveryCode: true;
}

export interface ChannelSummary {
    channelId: string;
    code: string;
    codeExpiresAt: string | null;
    createdAt: string;
    joinedAt: string;
    memberCount: number;
    incognito?: boolean;
    /** 'dm' for a direct message, 'group' (or absent) otherwise. */
    type?: "dm" | "group";
    /** DM only: the other member. */
    peerId?: string;
    /** DM only: whether I have blocked the peer. */
    blocked?: boolean;
    /** DM only: an invitation to me I have not accepted yet (shows accept / decline). */
    request?: boolean;
}

export interface IceResponse {
    iceServers: RTCIceServer[];
    ttl: number;
    /** True when a TURN relay is configured, i.e. strict-NAT calls should connect. */
    relay: boolean;
}

export interface UnfurlResponse {
    url: string;
    kind: "link" | "youtube" | "image";
    title?: string;
    description?: string;
    siteName?: string;
    videoId?: string;
    /** Raw bytes proxied by the relay; the sender re-encodes before sending. */
    image?: { mime: string; data: string };
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

// The chunk size is server policy and fixed for the process lifetime.
let cachedChunkSize: number | null = null;

async function request<T>(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${BASE_URL}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...options.headers,
            },
        });
    } catch {
        throw new ApiError("cannot reach server", 0);
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(
            body.error || `request failed: ${res.status}`,
            res.status,
        );
    }
    return res.json() as Promise<T>;
}

export const api = {
    register: (
        username: string,
        password: string,
        pubkey: string,
        signPubkey: string,
        vaultSalt: string,
        /** Optional. An account without one is fully functional -- just unrecoverable by mail. */
        email?: string,
    ) =>
        request<AuthResponse>("/auth/register", {
            method: "POST",
            body: JSON.stringify({
                username,
                password,
                pubkey,
                signPubkey,
                vaultSalt,
                ...(email ? { email } : {}),
            }),
        }),

    login: (username: string, password: string) =>
        request<LoginResult>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        }),

    /** Complete a login that returned a TwoFactorChallenge. */
    completeTwoFactor: (challengeToken: string, response: unknown) =>
        request<AuthResponse>("/auth/login/2fa", {
            method: "POST",
            body: JSON.stringify({ challengeToken, response }),
        }),

    /* --- two-factor (WebAuthn) management --- */

    twoFactorStatus: (token: string) =>
        request<{ enabled: boolean; credentials: TwoFactorCredential[] }>(
            "/account/2fa",
            {},
            token,
        ),

    twoFactorRegisterOptions: (token: string) =>
        request<{ options: unknown; challengeToken: string }>(
            "/account/2fa/register/options",
            { method: "POST" },
            token,
        ),

    twoFactorRegisterVerify: (
        token: string,
        body: { response: unknown; challengeToken: string; label?: string },
    ) =>
        request<{ ok: true; credential: { id: string; label: string } }>(
            "/account/2fa/register/verify",
            { method: "POST", body: JSON.stringify(body) },
            token,
        ),

    twoFactorRemove: (token: string, id: string) =>
        request<{ ok: true }>(
            `/account/2fa/${encodeURIComponent(id)}`,
            { method: "DELETE" },
            token,
        ),

    me: (token: string) => request<MeResponse>("/auth/me", {}, token),

    /* --- recovery blob --- */

    /**
     * Park the recovery blob. Ciphertext only: it is sealed under the recovery
     * code, which never leaves this device.
     */
    putRecoveryBlob: (
        token: string,
        blob: { ciphertext: string; nonce: string; salt: string },
    ) =>
        request<{ ok: true }>(
            "/account/recovery-blob",
            { method: "PUT", body: JSON.stringify(blob) },
            token,
        ),

    getRecoveryBlob: (token: string) =>
        request<RecoveryBlobResponse>("/account/recovery-blob", {}, token),

    deleteRecoveryBlob: (token: string) =>
        request<{ ok: true }>(
            "/account/recovery-blob",
            { method: "DELETE" },
            token,
        ),

    /* --- limits --- */

    /**
     * Tier limits, from the only authority that matters.
     *
     * Never hardcode these client-side: the server enforces them and a client
     * that believes the wrong cap produces uploads that die at 99%.
     */
    limits: (token: string) => request<Limits>("/account/limits", {}, token),

    /* --- email --- */

    getEmail: (token: string) =>
        request<EmailState>("/account/email", {}, token),

    /** Password-gated: a hijacked session that can swap the address owns the account. */
    setEmail: (token: string, email: string, password: string) =>
        request<{ ok: true; pendingMask: string }>(
            "/account/email",
            { method: "POST", body: JSON.stringify({ email, password }) },
            token,
        ),

    verifyEmail: (token: string) =>
        request<{ ok: true; mask: string }>("/account/email/verify", {
            method: "POST",
            body: JSON.stringify({ token }),
        }),

    removeEmail: (token: string, password: string) =>
        request<{ ok: true }>(
            "/account/email",
            { method: "DELETE", body: JSON.stringify({ password }) },
            token,
        ),

    /* --- recovery --- */

    /**
     * Request a reset link.
     *
     * Always resolves the same way whether or not the address is registered --
     * the server refuses to confirm which addresses have accounts. Do not add a
     * "no account found" branch to the caller; there is nothing to branch on.
     */
    requestReset: (email: string) =>
        request<{ ok: true; message: string }>("/recovery/request", {
            method: "POST",
            body: JSON.stringify({ email }),
        }),

    resetPassword: (token: string, password: string, vaultSalt: string) =>
        request<ResetResponse>("/recovery/reset", {
            method: "POST",
            body: JSON.stringify({ token, password, vaultSalt }),
        }),

    /* --- billing --- */

    billingStatus: (token: string) =>
        request<{
            badge: Badge | null;
            billingEnabled: boolean;
            portalUrl: string | null;
        }>("/billing/status", {}, token),

    /** What is on sale. Unconfigured plans are simply absent. */
    plans: () =>
        request<{ plans: Plan[]; billingEnabled: boolean }>("/billing/plans"),

    /**
     * Anonymous by design: no session travels with the checkout.
     *
     * Sends a plan *slug*, never a price id. the server maps it. A price id from
     * the browser would let anyone check out against any price on the account.
     */
    startCheckout: (plan: string) =>
        request<{ url: string }>("/billing/checkout", {
            method: "POST",
            body: JSON.stringify({ plan }),
        }),

    /**
     * Confirm a completed checkout.
     *
     * Resolves to `{ pending: true }` (HTTP 202) while Stripe's webhook has not
     * landed yet -- 202 is a success status, so this does NOT throw and the caller
     * must check the flag. The redirect and the webhook race by design; Stripe
     * promises no ordering between them.
     */
    redemptionCode: (sessionId: string) =>
        request<{ mailed?: true; pending?: true }>(
            `/billing/code/${encodeURIComponent(sessionId)}`,
        ),

    redeem: (token: string, code: string) =>
        request<{
            badge: Badge | null;
            redeemed: {
                kind: "subscription" | "gift";
                months: number | null;
                /** True when gifted months were banked rather than started. */
                parked: boolean;
            };
        }>(
            "/billing/redeem",
            { method: "POST", body: JSON.stringify({ code }) },
            token,
        ),

    createChannel: (token: string, incognito = false) =>
        request<{
            channelId: string;
            code: string;
            codeExpiresAt: string;
            incognito: boolean;
            members: MemberInfo[];
        }>(
            "/channel/create",
            { method: "POST", body: JSON.stringify({ incognito }) },
            token,
        ),

    joinChannel: (token: string, code: string) =>
        request<{
            channelId: string;
            code: string;
            isNewMember: boolean;
            incognito: boolean;
            members: MemberInfo[];
        }>(
            "/channel/join",
            { method: "POST", body: JSON.stringify({ code }) },
            token,
        ),

    listChannels: (token: string) =>
        request<{ channels: ChannelSummary[] }>("/channel/list", {}, token),

    members: (token: string, channelId: string) =>
        request<{ members: MemberInfo[] }>(
            `/channel/${channelId}/members`,
            {},
            token,
        ),

    rotateCode: (token: string, channelId: string) =>
        request<{ code: string; codeExpiresAt: string }>(
            `/channel/${channelId}/rotate-code`,
            { method: "POST" },
            token,
        ),

    leaveChannel: (token: string, channelId: string) =>
        request<{ ok: true }>(
            `/channel/${channelId}/leave`,
            { method: "DELETE" },
            token,
        ),

    /**
     * Open (or re-open) a 1:1 DM with a peer. Idempotent server-side: a pair has
     * at most one DM. Returns the peer's public keys so the caller can wrap the
     * channel key for them, exactly as a group join does.
     */
    createDm: (token: string, peerId: string) =>
        request<{
            channelId: string;
            type: "dm";
            created: boolean;
            /** The peer is an active member holding the key; false means mint a fresh one. */
            peerActive: boolean;
            peer: MemberInfo;
        }>(
            "/channel/dm",
            { method: "POST", body: JSON.stringify({ peerId }) },
            token,
        ),

    /** Accept a pending DM invitation: releases the withheld key and messages. */
    acceptDm: (token: string, channelId: string) =>
        request<{ ok: true }>(
            `/channel/${channelId}/accept`,
            { method: "POST" },
            token,
        ),

    blockDm: (token: string, channelId: string) =>
        request<{ ok: true }>(
            `/channel/${channelId}/block`,
            { method: "POST" },
            token,
        ),

    unblockDm: (token: string, channelId: string) =>
        request<{ ok: true }>(
            `/channel/${channelId}/block`,
            { method: "DELETE" },
            token,
        ),

    /** ICE servers + a freshly minted, short-lived TURN credential for a call. */
    ice: (token: string) => request<IceResponse>("/rtc/ice", {}, token),

    /* --- encrypted blobs --- */

    blobInit: (
        token: string,
        body: {
            channelId: string;
            declaredBytes: number;
            declaredChunks: number;
        },
    ) =>
        request<{ blobId: string; chunkBytes: number }>(
            "/blob/init",
            { method: "POST", body: JSON.stringify(body) },
            token,
        ),

    blobChunkSize: async (token: string) => {
        if (cachedChunkSize !== null) return cachedChunkSize;
        const res = await request<{ chunkBytes: number }>(
            "/blob/config",
            {},
            token,
        );
        cachedChunkSize = res.chunkBytes;
        return cachedChunkSize;
    },

    /**
     * One ciphertext chunk. Raw bytes, not JSON -- base64 would add 33% to every
     * upload and the server's JSON parser is capped far below a chunk anyway.
     */
    blobChunk: async (
        token: string,
        blobId: string,
        index: number,
        cipher: Uint8Array,
    ) => {
        const res = await fetch(`${BASE_URL}/blob/${blobId}/chunk`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Chunk-Index": String(index),
                Authorization: `Bearer ${token}`,
            },
            body: cipher as unknown as BodyInit,
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new ApiError(
                body.error || `chunk upload failed: ${res.status}`,
                res.status,
            );
        }
        return res.json() as Promise<{
            chunksReceived: number;
            bytesReceived: number;
        }>;
    },

    blobStatus: (token: string, blobId: string) =>
        request<{
            status: string;
            chunksReceived: number;
            declaredChunks: number;
        }>(`/blob/${blobId}/status`, {}, token),

    blobFinish: (token: string, blobId: string) =>
        request<{ ok: true }>(
            `/blob/${blobId}/finish`,
            { method: "POST" },
            token,
        ),

    /** Returns the raw Response so the caller can stream and decrypt as it goes. */
    blobDownload: async (token: string, blobId: string) => {
        const res = await fetch(`${BASE_URL}/blob/${blobId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new ApiError(
                body.error || `download failed: ${res.status}`,
                res.status,
            );
        }
        return res;
    },

    /**
     * Ask the relay to fetch a URL's metadata.
     *
     * Only the sender ever calls this and only when the user opted in. It is
     * the one place the server learns message content, which is why it is never
     * automatic.
     */
    unfurl: (token: string, url: string) =>
        request<UnfurlResponse>(
            `/unfurl?url=${encodeURIComponent(url)}`,
            {},
            token,
        ),

    wsUrl: () => {
        const url = new URL(BASE_URL);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/ws";
        return url.toString();
    },

    /**
     * The token rides in the WebSocket subprotocol, not the query string.
     * Query strings land in access logs, proxy logs and browser history; a
     * subprotocol value does not.
     */
    wsProtocols: (token: string) => ["darkchat", `bearer.${token}`],
};
