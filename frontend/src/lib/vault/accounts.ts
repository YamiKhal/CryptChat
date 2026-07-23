import { AccountDescriptor } from "@/lib/vault/types";
import {
    ACCOUNT_INDEX,
    accountKey,
    vaultKeyName,
    sessionKeyName,
    backupHandleKey,
    readJson,
    getSealed,
    delSealed,
    messageKeys,
} from "@/lib/vault/storage";
import { dbDelete } from "@/lib/vault/db";

export function listAccounts(): AccountDescriptor[] {
    const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
    return ids
        .map((id) =>
            readJson<AccountDescriptor | null>(
                localStorage,
                accountKey(id),
                null,
            ),
        )
        .filter((a): a is AccountDescriptor => a !== null)
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export function getAccount(userId: string): AccountDescriptor | null {
    return readJson<AccountDescriptor | null>(
        localStorage,
        accountKey(userId),
        null,
    );
}

/**
 * Whether this device holds an encrypted vault for the account.
 *
 * False after a correct login on a new device: credentials are valid, but the
 * private keys were never on the server to send back. That state needs an
 * import prompt, not a password prompt -- no password can unlock a vault that
 * does not exist here.
 *
 * Async now that the vault blob lives in IndexedDB: callers that need it in
 * synchronous render (session's `needsImport`) resolve it once at login and
 * carry the answer in session state rather than querying here per render.
 */
export async function hasVault(userId: string): Promise<boolean> {
    return (await getSealed(vaultKeyName(userId))) !== null;
}

export function saveAccount(account: AccountDescriptor): void {
    localStorage.setItem(accountKey(account.userId), JSON.stringify(account));
    const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
    if (!ids.includes(account.userId)) {
        localStorage.setItem(
            ACCOUNT_INDEX,
            JSON.stringify([...ids, account.userId]),
        );
    }
}

export function touchAccount(userId: string): void {
    const account = getAccount(userId);
    if (account)
        saveAccount({ ...account, lastUsedAt: new Date().toISOString() });
}

/**
 * Removes the account, its vault and every message namespace it owns.
 *
 * The plaintext registry (localStorage) is cleared synchronously first, so the
 * account is gone from the switcher immediately; the sealed blobs (IndexedDB)
 * are then swept. Awaiting the whole thing lets a caller know the ciphertext is
 * actually gone -- which "erase my keys" in the danger zone must guarantee.
 */
export async function forgetAccount(userId: string): Promise<void> {
    localStorage.removeItem(accountKey(userId));
    sessionStorage.removeItem(sessionKeyName(userId));

    const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
    localStorage.setItem(
        ACCOUNT_INDEX,
        JSON.stringify(ids.filter((id) => id !== userId)),
    );

    await delSealed(vaultKeyName(userId));
    for (const key of await messageKeys(userId)) await delSealed(key);
    // The saved backup file handle is per-account too; drop it so a later account
    // with a reused id can never inherit a stranger's disk target.
    await dbDelete(backupHandleKey(userId));
}
