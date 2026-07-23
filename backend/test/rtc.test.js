import "dotenv/config";
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer, stopServer } from "./helpers/server.js";
import { TestUser, call, initCrypto } from "./helpers/client.js";

/**
 * The ICE endpoint.
 *
 * It must require a session and return a well-formed iceServers array. The test
 * server has no TURN configured, so this pins the STUN-only / no-relay shape;
 * the credential-minting branch is covered by config + docs, not exercised here
 * (it needs a running coturn to be meaningful).
 */

before(async () => {
    await initCrypto();
    await startServer();
});

after(async () => {
    await stopServer();
});

describe("GET /rtc/ice", () => {
    test("requires a session", async () => {
        await assert.rejects(
            () => call("/rtc/ice"),
            (err) => err.status === 401,
        );
    });

    test("returns an iceServers array and a ttl", async () => {
        const user = new TestUser();
        await user.register();
        const res = await call("/rtc/ice", { token: user.token });
        assert.ok(Array.isArray(res.iceServers));
        assert.equal(typeof res.ttl, "number");
        assert.equal(typeof res.relay, "boolean");
    });

    test("any configured TURN entry carries a minted username and credential", async () => {
        const user = new TestUser();
        await user.register();
        const res = await call("/rtc/ice", { token: user.token });
        const turn = res.iceServers.find(
            (s) => typeof s.urls === "string" && s.urls.startsWith("turn"),
        );
        if (!turn) {
            // No TURN in the test env -- then the endpoint must honestly report no relay.
            assert.equal(res.relay, false);
            return;
        }
        // If TURN is configured, the credential is HMAC-minted with an expiry tag.
        assert.match(turn.username, /^\d+:/);
        assert.ok(turn.credential && turn.credential.length > 0);
        assert.equal(res.relay, true);
    });
});
