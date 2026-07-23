import { startAuthentication } from "@simplewebauthn/browser";
import { api, AuthResponse, isTwoFactorChallenge } from "@/lib/api";
import { EncryptedBundle } from "@/lib/crypto";
import { Vault, AccountDescriptor } from "@/lib/vault";
import type { BackupContainer } from "@/lib/backup/container";

/**
 * Session state for multi-account use in one browser.
 *
 * Four states and the differences matter:
 *   restoring -- reading the account and resuming a tab-scoped vault key
 *   anonymous -- no account selected
 *   locked    -- account exists on this device, vault key not derived yet
 *   unlocked  -- vault key in memory, keys usable
 *
 * `restoring` is not cosmetic. Restore is async (it opens a secretbox), so
 * without a distinct state the first render reports `anonymous` and route
 * guards bounce a deep link -- a refresh on /chat/:id or /settings would land
 * on the auth screen and then redirect to /channels, losing the route.
 *
 * "Logged in" is not the same as "can read messages". A valid token from a
 * fresh device still leaves the vault locked and every channel unreadable,
 * because the server never had the private keys to give back.
 */
export type Status = "restoring" | "anonymous" | "locked" | "unlocked";

export interface SessionState {
    status: Status;
    account: AccountDescriptor | null;
    token: string | null;
    vault: Vault | null;
    /**
     * True when the active account has no vault on this device (needs an import).
     *
     * Tracked in state rather than derived on render: the vault blob now lives in
     * IndexedDB, so "is there a vault here" is an async query. It is resolved once
     * at each point that produces a `locked` status and carried forward, so route
     * guards can read it synchronously.
     */
    needsImport: boolean;
}

export interface SessionApi extends SessionState {
    accounts: AccountDescriptor[];
    /**
     * True between `register` and the user confirming they saved their recovery
     * code. While set, route guards must NOT redirect an unlocked session off the
     * auth screen -- doing so buries the one screen that shows the code.
     */
    recoveryPending: boolean;
    /**
     * The freshly generated recovery phrase, held here rather than in Auth's local
     * state because registering flips the app to `unlocked`, which remounts the
     * router subtree (providers get added above it) and would wipe component state.
     * Empty except during the acknowledge screen. Cleared on acknowledge/logout.
     */
    recoveryPhrase: string;
    /** Clear `recoveryPending`/`recoveryPhrase` once the user has acknowledged the code. */
    acknowledgeRecovery(): void;
    /**
     * Returned once, by `register` and never again. The caller MUST show it and
     * make the user confirm they wrote it down -- it is not stored anywhere and
     * cannot be reissued.
     */
    register(
        username: string,
        password: string,
        email?: string,
    ): Promise<{ recoveryPhrase: string }>;
    login(username: string, password: string, remember: boolean): Promise<void>;
    unlock(password: string, remember: boolean): Promise<void>;
    /** Rebuild this device's vault from an exported key file (legacy path). */
    importIdentity(
        bundle: EncryptedBundle,
        passphrase: string,
        password: string,
    ): Promise<void>;
    /**
     * Restore this whole device from a full backup file, then reload.
     *
     * The primary recovery path: unlike `importIdentity` (keys only), this brings
     * back channels, contacts, profile and message history too. The reload lands
     * on the locked screen, where the backup-era password unlocks the vault.
     */
    restoreFromBackup(container: BackupContainer): Promise<void>;
    /**
     * Rebuild this device's vault from the server-held recovery blob.
     *
     * The counterpart to `importIdentity` for people who have their recovery code
     * but no key file. This is the whole point of the recovery code existing.
     */
    recoverWithCode(phrase: string, password: string): Promise<void>;
    /** Re-seal and re-upload the recovery blob. Call after the channel set changes. */
    syncRecoveryBlob(phrase: string): Promise<void>;
    lock(): void;
    logout(): void;
    selectAccount(userId: string): void;
    removeAccount(userId: string): Promise<void>;
    /** Re-read vault-backed state after a mutation. */
    refresh(): void;
}

export const ACTIVE_KEY = "darkchat:active";
export const tokenKey = (userId: string) => `darkchat:tok:${userId}`;

/**
 * Resolve a login, transparently completing a WebAuthn second factor if the
 * account has one enrolled.
 *
 * The server withholds the session token when 2FA is on and returns a challenge
 * instead; this runs the authenticator ceremony and exchanges the assertion for
 * the real AuthResponse. Callers get an AuthResponse either way and never have
 * to know a second factor was involved.
 */
export async function resolveLogin(
    username: string,
    password: string,
): Promise<AuthResponse> {
    const result = await api.login(username, password);
    if (!isTwoFactorChallenge(result)) return result;

    // Prompts the authenticator (security key, passkey, platform biometric).
    // Throws if the user cancels, which surfaces as a normal login failure.
    const assertion = await startAuthentication({
        optionsJSON: result.options as Parameters<
            typeof startAuthentication
        >[0]["optionsJSON"],
    });
    return api.completeTwoFactor(result.challengeToken, assertion);
}
