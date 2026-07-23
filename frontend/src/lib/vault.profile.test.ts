// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { Vault } from "@/lib/vault";
import { generateIdentity } from "@/lib/crypto";

/**
 * Profile updates report whether they changed anything.
 *
 * Peers re-announce their profile on every channel they open, and the
 * announcement is normally identical to what we already hold. The caller bumps
 * the relay revision on a change, and a revision reloads the channel list,
 * recomputes every unread count and re-decrypts the open transcript -- so
 * treating a repeat as news made one person switching channels refresh the app
 * for every other member.
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

const PEER = "peer-user";
const AVATAR = { mime: "image/png", data: "aaaa" };

async function vaultWithPeer() {
    const identity = await generateIdentity();
    const vault = await Vault.create("self-user", "a-perfectly-fine-password", {
        identity,
        channels: {},
        contacts: {},
        profile: { displayName: "me", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    await vault.pinContact({
        userId: PEER,
        publicKey: "pub",
        signPublicKey: "sign",
    });
    return vault;
}

describe("contact profile updates", () => {
    beforeEach(installStorage);

    it("reports a change the first time a profile arrives", async () => {
        const vault = await vaultWithPeer();

        expect(
            await vault.updateContactProfile(PEER, {
                displayName: "ada",
                avatar: AVATAR,
            }),
        ).toBe(true);
        expect(vault.getContact(PEER)?.displayName).toBe("ada");
    });

    it("reports no change when the same profile is re-announced", async () => {
        const vault = await vaultWithPeer();
        await vault.updateContactProfile(PEER, {
            displayName: "ada",
            avatar: AVATAR,
            bio: "hello",
        });

        // A freshly parsed envelope, so the asset is an equal object and never the
        // same reference. Comparing by identity would call this news.
        expect(
            await vault.updateContactProfile(PEER, {
                displayName: "ada",
                avatar: { ...AVATAR },
                bio: "hello",
            }),
        ).toBe(false);
    });

    it("notices a new avatar behind an unchanged name", async () => {
        const vault = await vaultWithPeer();
        await vault.updateContactProfile(PEER, {
            displayName: "ada",
            avatar: AVATAR,
        });

        expect(
            await vault.updateContactProfile(PEER, {
                displayName: "ada",
                avatar: { mime: "image/png", data: "bbbb" },
            }),
        ).toBe(true);
        expect(vault.getContact(PEER)?.avatar?.data).toBe("bbbb");
    });

    it("notices an avatar being cleared", async () => {
        const vault = await vaultWithPeer();
        await vault.updateContactProfile(PEER, {
            displayName: "ada",
            avatar: AVATAR,
        });

        // An envelope always carries the key, so a peer who removed their avatar
        // sends it as undefined. That clears ours, and counts as news.
        expect(
            await vault.updateContactProfile(PEER, {
                displayName: "ada",
                avatar: undefined,
            }),
        ).toBe(true);
        expect(vault.getContact(PEER)?.avatar).toBeUndefined();
    });

    it("reports no change for a field the caller did not mention", async () => {
        const vault = await vaultWithPeer();
        await vault.updateContactProfile(PEER, {
            displayName: "ada",
            avatar: AVATAR,
        });

        // An omitted key keeps its old value, so nothing moved.
        expect(
            await vault.updateContactProfile(PEER, { displayName: "ada" }),
        ).toBe(false);
        expect(vault.getContact(PEER)?.avatar).toEqual(AVATAR);
    });

    it("reports no change for a contact we have never pinned", async () => {
        const vault = await vaultWithPeer();
        expect(
            await vault.updateContactProfile("stranger", { displayName: "x" }),
        ).toBe(false);
    });
});
