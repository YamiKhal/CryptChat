// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { generateIdentity } from "@/lib/crypto";
import {
    Vault,
    saveAccount,
    AccountDescriptor,
    StoredMessage,
} from "@/lib/vault";
import { getSealed, migrateLocalStorageToIndexedDb } from "@/lib/vault/storage";
import { resetDbForTests } from "@/lib/vault/db";
import {
    buildBackup,
    restoreBackup,
    isBackupContainer,
} from "@/lib/backup/container";
import { importBackup } from "@/lib/backup/exportImport";

/**
 * Full-vault backup roundtrip and the localStorage->IndexedDB migration.
 *
 * Node environment: a real Vault means real Argon2id + secretbox, which is the
 * point -- the backup carries sealed bytes and only a real unlock proves they
 * survived the trip. localStorage is mocked (below); IndexedDB comes from
 * fake-indexeddb via the shared setup and is wiped between cases there.
 */

function installStorage() {
    const map = new Map<string, string>();
    const store = {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    };
    Object.defineProperty(globalThis, "localStorage", {
        value: store,
        configurable: true,
    });
}

const USER = "user-1";
const PASSWORD = "a-perfectly-fine-password";
const CHANNEL = "chan-1";

async function seedDevice(): Promise<AccountDescriptor> {
    const identity = await generateIdentity();
    const account: AccountDescriptor = {
        userId: USER,
        username: "alice",
        publicKey: identity.publicKey,
        signPublicKey: identity.signPublicKey,
        vaultSalt: identity.vaultSalt,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
    };
    saveAccount(account);

    const vault = await Vault.create(USER, PASSWORD, {
        identity,
        channels: {},
        contacts: {},
        profile: {
            displayName: "Alice",
            updatedAt: "2026-01-01T00:00:00.000Z",
        },
    });
    await vault.saveChannel({
        channelId: CHANNEL,
        code: "ABCDEFGH",
        key: identity.vaultSalt,
        hasKey: true,
        joinedAt: "2026-01-01T00:00:00.000Z",
        label: "general",
    });
    const message: StoredMessage = {
        id: "m1",
        channelId: CHANNEL,
        senderId: "someone",
        displayName: "Someone",
        body: "secret history",
        createdAt: "2026-01-02T00:00:00.000Z",
        verified: true,
    };
    await vault.appendMessage(message);
    return account;
}

describe("full-vault backup", () => {
    beforeEach(installStorage);

    it("round-trips channels and message history through a wiped device", async () => {
        await seedDevice();

        const container = await buildBackup(USER);
        expect(container).not.toBeNull();
        expect(container!.account.userId).toBe(USER);
        expect(container!.messages).toHaveLength(1);
        expect(container!.messages[0].channelId).toBe(CHANNEL);

        // Wipe the device: fresh account registry, empty IndexedDB.
        installStorage();
        await resetDbForTests();
        expect(await getSealed(`darkchat:vault:${USER}`)).toBeNull();

        // Restore, then prove the ciphertext actually opens with the same password.
        const restored = await restoreBackup(container!);
        expect(restored.userId).toBe(USER);

        const vault = await Vault.unlock(USER, PASSWORD);
        const channels = vault.listChannels();
        expect(channels).toHaveLength(1);
        expect(channels[0].label).toBe("general");
        const messages = await vault.loadMessages(CHANNEL);
        expect(messages).toHaveLength(1);
        expect(messages[0].body).toBe("secret history");
    });

    it("restored vault stays sealed under the original password", async () => {
        await seedDevice();
        const container = await buildBackup(USER);
        installStorage();
        await resetDbForTests();
        await restoreBackup(container!);

        await expect(Vault.unlock(USER, "the-wrong-password")).rejects.toThrow(
            /wrong password/,
        );
    });

    it("buildBackup returns null when there is no vault on the device", async () => {
        expect(await buildBackup("nobody")).toBeNull();
    });

    it("importBackup refuses a file belonging to another identity", async () => {
        await seedDevice();
        const container = await buildBackup(USER);
        await expect(
            importBackup(container!, "a-different-user"),
        ).rejects.toThrow(/different identity/);
    });

    it("rejects structurally invalid files", () => {
        expect(isBackupContainer(null)).toBe(false);
        expect(isBackupContainer({ format: "something-else" })).toBe(false);
        expect(isBackupContainer({ format: "darkchat-backup", v: 1 })).toBe(
            false,
        );
    });
});

describe("localStorage -> IndexedDB migration", () => {
    beforeEach(installStorage);

    it("moves sealed blobs and leaves the plaintext registry alone", async () => {
        const sealed = { ciphertext: "ct", nonce: "nz" };
        localStorage.setItem(`darkchat:vault:${USER}`, JSON.stringify(sealed));
        localStorage.setItem(
            `darkchat:msgs:${USER}:${CHANNEL}`,
            JSON.stringify(sealed),
        );
        localStorage.setItem(
            `darkchat:acct:${USER}`,
            JSON.stringify({ userId: USER }),
        );

        await migrateLocalStorageToIndexedDb();

        // Sealed blobs are gone from localStorage and present in IndexedDB.
        expect(localStorage.getItem(`darkchat:vault:${USER}`)).toBeNull();
        expect(
            localStorage.getItem(`darkchat:msgs:${USER}:${CHANNEL}`),
        ).toBeNull();
        expect(await getSealed(`darkchat:vault:${USER}`)).toEqual(sealed);
        expect(await getSealed(`darkchat:msgs:${USER}:${CHANNEL}`)).toEqual(
            sealed,
        );

        // The plaintext account descriptor stays in localStorage.
        expect(localStorage.getItem(`darkchat:acct:${USER}`)).not.toBeNull();
    });

    it("is a no-op on a device with nothing to migrate", async () => {
        await expect(migrateLocalStorageToIndexedDb()).resolves.toBeUndefined();
    });
});
