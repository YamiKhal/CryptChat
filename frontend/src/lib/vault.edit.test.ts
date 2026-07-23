// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { Vault, StoredMessage } from "@/lib/vault";
import { generateIdentity, sealWithPassword } from "@/lib/crypto";

/**
 * Edit and delete authorization (ROADMAP #4).
 *
 * The signature (checked in the relay layer) proves who *sent* an edit; the
 * vault proves they were allowed to. These tests pin the second half: one member
 * can never edit or delete another member's message, a tombstone cannot be
 * edited back to life and a delete leaves no plaintext behind.
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
const OTHER = "other-user";
const CHAN = "chan-1";

function msg(id: string, senderId: string): StoredMessage {
    return {
        id,
        channelId: CHAN,
        senderId,
        displayName: senderId,
        body: "original",
        createdAt: "2026-01-02T00:00:00.000Z",
        verified: true,
    };
}

async function vaultWith(...messages: StoredMessage[]) {
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
    for (const m of messages) await vault.appendMessage(m);
    return vault;
}

async function bodyOf(vault: Vault, id: string) {
    const all = await vault.loadMessages(CHAN);
    return all.find((m) => m.id === id);
}

describe("editMessage", () => {
    beforeEach(installStorage);

    it("lets the author edit their own message", async () => {
        const vault = await vaultWith(msg("m1", SELF));
        const result = await vault.editMessage(CHAN, "m1", SELF, "corrected");
        expect(result).not.toBeNull();
        const after = await bodyOf(vault, "m1");
        expect(after?.body).toBe("corrected");
        expect(after?.editedAt).toBeTruthy();
    });

    it("refuses to let a non-author edit", async () => {
        const vault = await vaultWith(msg("m1", OTHER));
        const result = await vault.editMessage(CHAN, "m1", SELF, "hijacked");
        expect(result).toBeNull();
        expect((await bodyOf(vault, "m1"))?.body).toBe("original");
    });

    it("returns null when the target is not here yet", async () => {
        const vault = await vaultWith();
        expect(await vault.editMessage(CHAN, "ghost", SELF, "x")).toBeNull();
    });

    it("will not edit a tombstone back to life", async () => {
        const vault = await vaultWith(msg("m1", SELF));
        await vault.deleteMessage(CHAN, "m1", SELF);
        const result = await vault.editMessage(CHAN, "m1", SELF, "undelete me");
        expect(result).toBeNull();
        const after = await bodyOf(vault, "m1");
        expect(after?.deleted).toBe(true);
        expect(after?.body).toBe("");
    });
});

describe("deleteMessage", () => {
    beforeEach(installStorage);

    it("lets the author delete, leaving a tombstone with no plaintext", async () => {
        const vault = await vaultWith({
            ...msg("m1", SELF),
            body: "secret words",
        });
        const result = await vault.deleteMessage(CHAN, "m1", SELF);
        expect(result).not.toBeNull();
        const after = await bodyOf(vault, "m1");
        expect(after?.deleted).toBe(true);
        expect(after?.body).toBe("");
        // The id and sender survive so a reply that quoted it still resolves.
        expect(after?.id).toBe("m1");
        expect(after?.senderId).toBe(SELF);
    });

    it("refuses to let a non-author delete", async () => {
        const vault = await vaultWith(msg("m1", OTHER));
        expect(await vault.deleteMessage(CHAN, "m1", SELF)).toBeNull();
        expect((await bodyOf(vault, "m1"))?.deleted).toBeUndefined();
    });
});

describe("unlockMessage (ROADMAP #6)", () => {
    beforeEach(installStorage);

    async function lockedMsg(
        id: string,
        plaintext: string,
        code: string,
    ): Promise<StoredMessage> {
        const locked = await sealWithPassword(plaintext, code);
        return {
            id,
            channelId: CHAN,
            senderId: OTHER,
            displayName: OTHER,
            body: "",
            locked,
            protected: true,
            createdAt: "2026-01-02T00:00:00.000Z",
            verified: true,
        };
    }

    it("reveals the body with the right code and clears the lock", async () => {
        const vault = await vaultWith(
            await lockedMsg("m1", "the eagle lands at noon", "owl"),
        );
        const updated = await vault.unlockMessage(CHAN, "m1", "owl");
        const m = updated.find((x) => x.id === "m1");
        expect(m?.body).toBe("the eagle lands at noon");
        expect(m?.locked).toBeUndefined();
        // Persisted, so a reload stays unlocked.
        expect((await bodyOf(vault, "m1"))?.body).toBe(
            "the eagle lands at noon",
        );
    });

    it("a wrong code throws and leaves the message locked", async () => {
        const vault = await vaultWith(await lockedMsg("m1", "secret", "owl"));
        await expect(vault.unlockMessage(CHAN, "m1", "cat")).rejects.toThrow(
            /wrong code/,
        );
        const m = await bodyOf(vault, "m1");
        expect(m?.locked).toBeTruthy();
        expect(m?.body).toBe("");
    });
});
