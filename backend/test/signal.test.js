import "dotenv/config";
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer, stopServer } from "./helpers/server.js";
import { TestUser, call, initCrypto } from "./helpers/client.js";

/**
 * WebRTC call signaling over the relay.
 *
 * The relay routes an opaque ciphertext blob to the *other* DM member, in real
 * time only. The contracts pinned here: it reaches the peer, it is not queued
 * for an offline peer (a stale call offer is noise), it is dropped across a
 * block and it is refused on a non-DM channel.
 */

before(async () => {
    await initCrypto();
    await startServer();
});

after(async () => {
    await stopServer();
});

const dm = (user, peerId) =>
    call("/channel/dm", { method: "POST", token: user.token, body: { peerId } });

const CT = "C".repeat(64);
const NONCE = "D".repeat(24);

async function pair() {
    const a = new TestUser();
    const b = new TestUser();
    await a.register();
    await b.register();
    return { a, b };
}

const signal = (user, channelId) => ({
    type: "signal",
    channelId,
    ciphertext: CT,
    nonce: NONCE,
});

describe("call signaling", () => {
    test("routes a signal to the DM peer", async () => {
        const { a, b } = await pair();
        const res = await dm(a, b.userId);

        await a.connectRelay();
        await b.connectRelay();

        a.sendRelay(signal(a, res.channelId));

        const got = await b.waitForRelay(
            (m) => m.type === "signal" && m.channelId === res.channelId,
        );
        assert.equal(got.senderId, a.userId);
        assert.equal(got.ciphertext, CT);

        a.closeRelay();
        b.closeRelay();
    });

    test("is not queued for an offline peer", async () => {
        const { a, b } = await pair();
        const res = await dm(a, b.userId);

        // Only A is online when the signal is sent.
        await a.connectRelay();
        a.sendRelay(signal(a, res.channelId));
        await new Promise((r) => setTimeout(r, 200));
        a.closeRelay();

        // B connects afterwards and must NOT receive the stale signal.
        await b.connectRelay();
        const absent = await b.expectNoRelay((m) => m.type === "signal", { window: 600 });
        assert.equal(absent, true);
        b.closeRelay();
    });

    test("is dropped across a block", async () => {
        const { a, b } = await pair();
        const res = await dm(a, b.userId);
        await call(`/channel/${res.channelId}/block`, { method: "POST", token: b.token });

        await a.connectRelay();
        await b.connectRelay();
        a.sendRelay(signal(a, res.channelId));

        const absent = await b.expectNoRelay((m) => m.type === "signal", { window: 600 });
        assert.equal(absent, true);

        a.closeRelay();
        b.closeRelay();
    });

    test("is ignored on a non-DM (group) channel", async () => {
        const a = new TestUser();
        const b = new TestUser();
        await a.register();
        await b.register();

        // A normal group channel A creates and B joins.
        const created = await call("/channel/create", { method: "POST", token: a.token, body: {} });
        await call("/channel/join", {
            method: "POST",
            token: b.token,
            body: { code: created.code },
        });

        await a.connectRelay();
        await b.connectRelay();
        a.sendRelay(signal(a, created.channelId));

        const absent = await b.expectNoRelay((m) => m.type === "signal", { window: 600 });
        assert.equal(absent, true);

        a.closeRelay();
        b.closeRelay();
    });
});
