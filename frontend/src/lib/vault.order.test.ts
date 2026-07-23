// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { Vault, StoredMessage } from "@/lib/vault";
import { generateIdentity } from "@/lib/crypto";

/**
 * Transcript ordering and concurrent writes.
 *
 * Messages used to be ordered by the sender's own `sentAt`. Two devices' clocks
 * disagree by seconds, so in a quick exchange a reply stamped by a slow clock
 * landed above the message it answered. Ordering is on the relay's `createdAt`
 * instead, which every member sees the same value of.
 *
 * The second half pins the write path: transcript mutations are load-change-save
 * over IndexedDB and two of them racing on one channel used to lose a message.
 */

function installStorage() {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        value: {
            getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
            setItem: (k: string, v: string) => void map.set(k, String(v)),
            removeItem: (k: string) => void map.delete(k),
            clear: () => map.clear(),
            key: (i: number) => [...map.keys()][i] ?? null,
            get length() {
                return map.size;
            },
        },
        configurable: true,
    });
}

const SELF = "self-user";
const PEER = "peer-user";
const CHAN = "chan-1";

function msg(
    id: string,
    senderId: string,
    createdAt: string,
    extra: Partial<StoredMessage> = {},
): StoredMessage {
    return {
        id,
        channelId: CHAN,
        senderId,
        displayName: senderId,
        body: id,
        createdAt,
        verified: true,
        ...extra,
    };
}

async function emptyVault() {
    const identity = await generateIdentity();
    const vault = await Vault.create(SELF, "a-perfectly-fine-password", {
        identity,
        channels: {},
        contacts: {},
        profile: { displayName: "me", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    await vault.saveChannel({
        channelId: CHAN,
        code: "ABCDEFGH",
        key: identity.vaultSalt,
        hasKey: true,
        joinedAt: "2026-01-01T00:00:00.000Z",
    });
    return vault;
}

const idsOf = async (vault: Vault) =>
    (await vault.loadMessages(CHAN)).map((m) => m.id);

describe("transcript ordering", () => {
    beforeEach(installStorage);

    it("orders on the relay stamp, not the sender's clock", async () => {
        const vault = await emptyVault();

        // The peer's device runs five seconds slow. Their reply reaches the relay
        // after ours but claims an earlier `sentAt`.
        await vault.appendMessage(
            msg("ours", SELF, "2026-01-02T00:00:10.000Z", {
                sentAt: "2026-01-02T00:00:10.000Z",
            }),
        );
        await vault.appendMessage(
            msg("theirs", PEER, "2026-01-02T00:00:11.000Z", {
                sentAt: "2026-01-02T00:00:06.000Z",
            }),
        );

        expect(await idsOf(vault)).toEqual(["ours", "theirs"]);
    });

    it("breaks a tied stamp on id, the same way on append and on reload", async () => {
        // A tie is reachable: the relay reads its clock once per send, so a coarse
        // clock repeats a value. With no tiebreak the order would follow whichever
        // arrived first, and two devices that received them in opposite orders
        // would render the pair differently.
        const at = "2026-01-02T00:00:00.000Z";
        const vault = await emptyVault();

        await vault.appendMessage(msg("bbb", PEER, at));
        await vault.appendMessage(msg("aaa", SELF, at));
        const arrivedLateFirst = await idsOf(vault);

        await vault.clearMessages(CHAN);
        await vault.appendMessage(msg("aaa", SELF, at));
        await vault.appendMessage(msg("bbb", PEER, at));

        expect(arrivedLateFirst).toEqual(["aaa", "bbb"]);
        expect(await idsOf(vault)).toEqual(arrivedLateFirst);
    });

    it("adopts the relay stamp for our own message once it is acked", async () => {
        const vault = await emptyVault();
        // Our clock is a minute fast, so our copy is stamped ahead of the peer's
        // message that actually came after it.
        await vault.appendMessage(
            msg("ours", SELF, "2026-01-02T00:01:00.000Z", { pending: true }),
        );
        await vault.appendMessage(msg("theirs", PEER, "2026-01-02T00:00:30.000Z"));
        expect(await idsOf(vault)).toEqual(["theirs", "ours"]);

        const changed = await vault.confirmSentMessage(
            CHAN,
            "ours",
            "2026-01-02T00:00:20.000Z",
        );

        expect(changed).toBe(true);
        expect(await idsOf(vault)).toEqual(["ours", "theirs"]);
        const ours = (await vault.loadMessages(CHAN)).find(
            (m) => m.id === "ours",
        );
        expect(ours?.pending).toBeUndefined();
    });

    it("clears pending on an ack that carries no stamp", async () => {
        const vault = await emptyVault();
        await vault.appendMessage(
            msg("ours", SELF, "2026-01-02T00:00:00.000Z", { pending: true }),
        );

        expect(await vault.confirmSentMessage(CHAN, "ours", undefined)).toBe(
            true,
        );
        const ours = (await vault.loadMessages(CHAN)).find(
            (m) => m.id === "ours",
        );
        expect(ours?.pending).toBeUndefined();
        expect(ours?.createdAt).toBe("2026-01-02T00:00:00.000Z");
    });

    it("reports no change when the ack tells us nothing new", async () => {
        const vault = await emptyVault();
        await vault.appendMessage(msg("ours", SELF, "2026-01-02T00:00:00.000Z"));

        expect(
            await vault.confirmSentMessage(
                CHAN,
                "ours",
                "2026-01-02T00:00:00.000Z",
            ),
        ).toBe(false);
        expect(await vault.confirmSentMessage(CHAN, "missing", undefined)).toBe(
            false,
        );
    });
});

describe("concurrent transcript writes", () => {
    beforeEach(installStorage);

    it("keeps every message when appends race", async () => {
        const vault = await emptyVault();

        // Our own send and an arriving message, started together. Both read the
        // transcript before either writes; without a lock the second save wrote
        // back a list missing the first message.
        await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                vault.appendMessage(
                    msg(
                        `m${i}`,
                        i % 2 ? PEER : SELF,
                        `2026-01-02T00:00:${String(i).padStart(2, "0")}.000Z`,
                    ),
                ),
            ),
        );

        expect(await idsOf(vault)).toEqual(
            Array.from({ length: 10 }, (_, i) => `m${i}`),
        );
    });

    it("does not lose an append to a concurrent reaction or edit", async () => {
        const vault = await emptyVault();
        await vault.appendMessage(msg("first", PEER, "2026-01-02T00:00:00.000Z"));

        await Promise.all([
            vault.applyReactionToMessage(CHAN, "first", "👍", SELF, false),
            vault.appendMessage(msg("second", SELF, "2026-01-02T00:00:01.000Z")),
            vault.editMessage(CHAN, "first", PEER, "edited"),
        ]);

        const messages = await vault.loadMessages(CHAN);
        expect(messages.map((m) => m.id)).toEqual(["first", "second"]);
        expect(messages[0].reactions).toEqual({ "👍": [SELF] });
        expect(messages[0].body).toBe("edited");
    });
});
