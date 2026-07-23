import { Router } from "express";
import crypto from "crypto";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { apiLimiter } from "../middleware/security.js";

const router = Router();

/**
 * ICE servers for a 1:1 WebRTC call.
 *
 * The server's whole role in a call is here: it tells the two peers how to find
 * a path to each other and nothing more. Media never touches it (DTLS-SRTP,
 * peer-to-peer) and call signaling rides the relay as ciphertext it cannot
 * read. Even the TURN relay, when used, carries only encrypted SRTP.
 *
 * TURN credentials are minted per request and expire. This is coturn's
 * `use-auth-secret` scheme: the password is HMAC-SHA1(static-auth-secret,
 * username) where username embeds an expiry timestamp, so a credential that
 * leaks is useless within the hour rather than granting relay access forever. We
 * store no long-lived TURN password anywhere.
 */
router.get("/ice", apiLimiter, requireAuth, (req, res) => {
    const iceServers = [];

    if (config.rtc.stunUrl) {
        iceServers.push({ urls: config.rtc.stunUrl });
    }

    if (config.rtc.turnUrl && config.rtc.turnSecret) {
        const expiry = Math.floor(Date.now() / 1000) + config.rtc.credentialTtlSeconds;
        // coturn treats the whole username as opaque and only checks the HMAC, but a
        // per-user suffix keeps two callers from sharing one credential. A short hash
        // slice, not the raw id -- the credential should not carry an account id in
        // the clear.
        const tag = crypto.createHash("sha256").update(req.userId).digest("hex").slice(0, 8);
        const username = `${expiry}:${tag}`;
        const credential = crypto
            .createHmac("sha1", config.rtc.turnSecret)
            .update(username)
            .digest("base64");
        iceServers.push({ urls: config.rtc.turnUrl, username, credential });
    }

    // `enabled` lets the client decide whether to show call buttons at all and
    // `relay` whether to warn that a strict-NAT call may not connect.
    res.json({
        iceServers,
        ttl: config.rtc.credentialTtlSeconds,
        relay: Boolean(config.rtc.turnUrl && config.rtc.turnSecret),
    });
});

export default router;
