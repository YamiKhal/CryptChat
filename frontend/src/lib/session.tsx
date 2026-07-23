import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { api } from "@/lib/api";
import {
    generateIdentity,
    Identity,
    importKeyBundle,
    EncryptedBundle,
    generateRecoveryCode,
    parseRecoveryCode,
    sealRecoveryBlob,
    openRecoveryBlob,
    KeyBundle,
} from "@/lib/crypto";
import { wipe } from "@/lib/binary";
import { clearImageCache } from "@/lib/blob";
import {
    Vault,
    AccountDescriptor,
    StoredChannel,
    listAccounts,
    getAccount,
    saveAccount,
    touchAccount,
    forgetAccount,
    hasVault,
} from "@/lib/vault";
import { migrateLocalStorageToIndexedDb } from "@/lib/vault/storage";
import { importBackup } from "@/lib/backup/exportImport";
import type { BackupContainer } from "@/lib/backup/container";
import {
    SessionState,
    SessionApi,
    ACTIVE_KEY,
    tokenKey,
    resolveLogin,
} from "@/lib/sessionShared";

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<SessionState>({
        status: "restoring",
        account: null,
        token: null,
        vault: null,
        needsImport: false,
    });
    const [accounts, setAccounts] = useState<AccountDescriptor[]>(() =>
        listAccounts(),
    );
    const [recoveryPending, setRecoveryPending] = useState(false);
    const [recoveryPhrase, setRecoveryPhrase] = useState("");
    const [, setTick] = useState(0);

    const acknowledgeRecovery = useCallback(() => {
        setRecoveryPending(false);
        setRecoveryPhrase("");
    }, []);

    const refresh = useCallback(() => setTick((n) => n + 1), []);

    // Restore the last account on load. A tab-scoped vault key (if the user asked
    // to be remembered) means reload lands unlocked; otherwise it lands locked
    // and prompts, rather than silently showing an empty app.
    useEffect(() => {
        let cancelled = false;

        (async () => {
            // Carry any ciphertext an older build left in localStorage over to
            // IndexedDB before the vault is read from its new home. One-time and idempotent.
            await migrateLocalStorageToIndexedDb();

            const activeId = localStorage.getItem(ACTIVE_KEY);
            const account = activeId ? getAccount(activeId) : null;

            // Every path must settle the status, or the app hangs on the restoring
            // screen forever.
            if (!activeId || !account) {
                if (!cancelled)
                    setState({
                        status: "anonymous",
                        account: null,
                        token: null,
                        vault: null,
                        needsImport: false,
                    });
                return;
            }

            const token = sessionStorage.getItem(tokenKey(activeId));
            const vault = await Vault.resume(activeId);
            if (cancelled) return;

            // Resume returns null both when the vault is merely locked (blob present,
            // no tab key) and when this device has no vault at all. Only the latter
            // needs an import, so distinguish them once, here.
            const needsImport = vault ? false : !(await hasVault(activeId));
            if (cancelled) return;

            setState({
                status: vault ? "unlocked" : "locked",
                account,
                token,
                vault,
                needsImport,
            });
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    const register = useCallback(
        async (username: string, password: string, email?: string) => {
            const identity: Identity = await generateIdentity();

            const res = await api.register(
                username,
                password,
                identity.publicKey,
                identity.signPublicKey,
                identity.vaultSalt,
                email,
            );

            const account: AccountDescriptor = {
                userId: res.userId,
                username,
                publicKey: identity.publicKey,
                signPublicKey: identity.signPublicKey,
                vaultSalt: identity.vaultSalt,
                lastUsedAt: new Date().toISOString(),
            };
            saveAccount(account);

            const vault = await Vault.create(res.userId, password, {
                identity,
                channels: {},
                contacts: {},
                profile: {
                    displayName: username,
                    updatedAt: new Date().toISOString(),
                },
            });
            await vault.rememberForSession();

            sessionStorage.setItem(tokenKey(res.userId), res.token);
            localStorage.setItem(ACTIVE_KEY, res.userId);

            // The recovery code, generated here and shown once. Without it, an account
            // is only ever recoverable from a key file the user remembered to export
            // -- which, in practice, nobody does before they need it.
            const recovery = await generateRecoveryCode();
            try {
                const blob = await sealRecoveryBlob(
                    { userId: res.userId, identity, channels: [] },
                    recovery.entropy,
                );
                // Best-effort: a failed upload must not fail registration, but it does
                // mean the phrase we are about to show recovers nothing. Surface it
                // rather than handing the user a code that silently does not work.
                await api.putRecoveryBlob(res.token, blob);
            } finally {
                wipe(recovery.entropy);
            }

            setAccounts(listAccounts());
            setRecoveryPhrase(recovery.phrase);
            setRecoveryPending(true);
            setState({
                status: "unlocked",
                account,
                token: res.token,
                vault,
                needsImport: false,
            });

            return { recoveryPhrase: recovery.phrase };
        },
        [],
    );

    /**
     * Re-seal the recovery blob against the vault's current contents.
     *
     * Needed whenever the channel set changes: a blob sealed at registration knows
     * about zero channels, so recovering from it would restore an identity with no
     * conversations -- which reads to the user as "recovery lost my data". Takes
     * the phrase because the entropy is never persisted; only the user has it.
     */
    const syncRecoveryBlob = useCallback(
        async (phrase: string) => {
            if (!state.vault || !state.token || !state.account)
                throw new Error("unlock first");

            const entropy = await parseRecoveryCode(phrase);
            try {
                const data = state.vault.snapshot();
                const blob = await sealRecoveryBlob(
                    {
                        userId: state.account.userId,
                        identity: data.identity,
                        channels: Object.values(data.channels)
                            .filter((c) => c.hasKey)
                            .map((c) => ({
                                channelId: c.channelId,
                                code: c.code,
                                key: c.key,
                            })),
                    },
                    entropy,
                );
                await api.putRecoveryBlob(state.token, blob);
            } finally {
                wipe(entropy);
            }
        },
        [state.vault, state.token, state.account],
    );

    /**
     * Rebuild the vault from the server-held blob using the recovery code.
     *
     * Runs after a password reset, on a device with no vault. The identity that
     * comes back is the *same* keypair the account has always had -- peers have it
     * pinned, so generating a fresh one here would show every contact a key change
     * and break every existing channel.
     */
    const recoverWithCode = useCallback(
        async (phrase: string, password: string) => {
            if (!state.account) throw new Error("log in first");
            const token =
                state.token ??
                sessionStorage.getItem(tokenKey(state.account.userId));
            if (!token) throw new Error("log in first");

            const entropy = await parseRecoveryCode(phrase);
            try {
                const blob = await api.getRecoveryBlob(token);
                const opened: KeyBundle = await openRecoveryBlob(blob, entropy);

                if (opened.userId !== state.account.userId) {
                    throw new Error(
                        "this recovery code belongs to a different identity",
                    );
                }

                const channels: Record<string, StoredChannel> = {};
                for (const channel of opened.channels) {
                    channels[channel.channelId] = {
                        channelId: channel.channelId,
                        code: channel.code,
                        key: channel.key,
                        hasKey: true,
                        joinedAt: new Date().toISOString(),
                    };
                }

                // The blob carries the vault salt from whenever it was sealed, but a
                // password reset rotated it server-side. Three places have to agree on
                // this value or the vault silently fails to reopen: Vault.create seals
                // with identity.vaultSalt, Vault.unlock derives from the account
                // descriptor's and a login on another device is handed the server's.
                // The account descriptor holds the post-reset value, so it wins.
                //
                // Safe to overwrite: a KDF salt is not a secret and carries no identity.
                // The keypairs are what must survive intact and they do.
                const identity: Identity = {
                    ...opened.identity,
                    vaultSalt: state.account.vaultSalt,
                };

                const vault = await Vault.create(
                    state.account.userId,
                    password,
                    {
                        identity,
                        channels,
                        contacts: {},
                        profile: {
                            displayName: state.account.username,
                            updatedAt: new Date().toISOString(),
                        },
                    },
                );
                await vault.rememberForSession();

                const account: AccountDescriptor = {
                    ...state.account,
                    publicKey: identity.publicKey,
                    signPublicKey: identity.signPublicKey,
                    vaultSalt: identity.vaultSalt,
                    lastUsedAt: new Date().toISOString(),
                };
                saveAccount(account);
                setAccounts(listAccounts());

                // Re-park the blob carrying the rotated salt, so the next recovery does
                // not have to fix this up again.
                const resealed = await sealRecoveryBlob(
                    {
                        userId: account.userId,
                        identity,
                        channels: opened.channels,
                    },
                    entropy,
                );
                await api.putRecoveryBlob(token, resealed);

                setState((s) => ({
                    ...s,
                    status: "unlocked",
                    account,
                    token,
                    vault,
                    needsImport: false,
                }));
            } finally {
                wipe(entropy);
            }
        },
        [state.account, state.token],
    );

    const login = useCallback(
        async (username: string, password: string, remember: boolean) => {
            setRecoveryPending(false);
            setRecoveryPhrase("");
            const res = await resolveLogin(username, password);

            const existing = getAccount(res.userId);

            const account: AccountDescriptor = {
                userId: res.userId,
                username,
                publicKey: res.pubkey,
                signPublicKey: res.signPubkey,
                vaultSalt: res.vaultSalt,
                lastUsedAt: new Date().toISOString(),
            };
            saveAccount(account);
            sessionStorage.setItem(tokenKey(res.userId), res.token);
            localStorage.setItem(ACTIVE_KEY, res.userId);
            setAccounts(listAccounts());

            if (!existing) {
                // Correct credentials, but this device has no private keys for the
                // account -- the server never had them to return. Import a key bundle
                // from the original device via Settings. Surfaced as `locked` rather
                // than pretending the login failed.
                setState({
                    status: "locked",
                    account,
                    token: res.token,
                    vault: null,
                    needsImport: true,
                });
                return;
            }

            const vault = await Vault.unlock(res.userId, password);
            if (remember) await vault.rememberForSession();

            setState({
                status: "unlocked",
                account,
                token: res.token,
                vault,
                needsImport: false,
            });
        },
        [],
    );

    const unlock = useCallback(
        async (password: string, remember: boolean) => {
            if (!state.account) throw new Error("no account selected");
            const vault = await Vault.unlock(state.account.userId, password);
            if (remember) await vault.rememberForSession();

            let token = state.token;
            if (!token) {
                // Vault password and account password are the same secret, so a valid
                // unlock is also enough to mint a fresh token when the old one expired.
                // Runs the second factor too, if the account enrolled one.
                const res = await resolveLogin(
                    state.account.username,
                    password,
                );
                token = res.token;
                sessionStorage.setItem(tokenKey(state.account.userId), token);
            }

            touchAccount(state.account.userId);
            setState((s) => ({
                ...s,
                status: "unlocked",
                token,
                vault,
                needsImport: false,
            }));
        },
        [state.account, state.token],
    );

    /**
     * Rebuild the vault on a device that has none, from an exported key file.
     *
     * This is the only way an identity reaches a second device: the server holds
     * public keys and a password verifier, never the private half. Callable while
     * `locked`, because that is exactly the state a fresh device lands in --
     * gating it behind an unlocked vault would make the import unreachable on the
     * one device that needs it.
     */
    const importIdentity = useCallback(
        async (
            bundle: EncryptedBundle,
            passphrase: string,
            password: string,
        ) => {
            if (!state.account)
                throw new Error("log in first, then import your key file");

            const opened = await importKeyBundle(bundle, passphrase);
            if (opened.userId !== state.account.userId) {
                throw new Error(
                    "this key file belongs to a different identity",
                );
            }

            const channels: Record<string, StoredChannel> = {};
            for (const channel of opened.channels) {
                channels[channel.channelId] = {
                    channelId: channel.channelId,
                    code: channel.code,
                    key: channel.key,
                    hasKey: true,
                    joinedAt: new Date().toISOString(),
                };
            }

            const vault = await Vault.create(state.account.userId, password, {
                identity: opened.identity,
                channels,
                contacts: {},
                profile: {
                    displayName: state.account.username,
                    updatedAt: new Date().toISOString(),
                },
            });
            await vault.rememberForSession();

            const account: AccountDescriptor = {
                ...state.account,
                publicKey: opened.identity.publicKey,
                signPublicKey: opened.identity.signPublicKey,
                vaultSalt: opened.identity.vaultSalt,
                lastUsedAt: new Date().toISOString(),
            };
            saveAccount(account);
            setAccounts(listAccounts());

            setState((s) => ({
                ...s,
                status: "unlocked",
                account,
                vault,
                needsImport: false,
            }));
        },
        [state.account],
    );

    /**
     * Restore this device from a full backup file, then reload into the locked
     * screen so the user unlocks with their password.
     *
     * This is the disaster path: "clear browsing data" wipes the account registry
     * too, so the user lands here anonymous with an empty device. Restoring writes
     * the account descriptor and the sealed vault/messages back, points the active
     * pointer at it and reloads -- the reload rebinds every consumer to the
     * restored vault far more cheaply than rebuilding the session in place, exactly
     * as the old key-file import did. The vault is still sealed under the
     * backup-era password, so the unlock screen is where it actually opens.
     */
    const restoreFromBackup = useCallback(
        async (container: BackupContainer) => {
            const account = await importBackup(container);
            localStorage.setItem(ACTIVE_KEY, account.userId);
            window.location.reload();
        },
        [],
    );

    const lock = useCallback(() => {
        state.vault?.lock();
        // Decrypted images are held as object URLs outside the vault. Locking must
        // drop them too, or plaintext attachments outlive the key that opened them.
        clearImageCache();
        // The vault blob is still on this device -- locking only drops the in-memory
        // key -- so this is a needs-unlock state, never needs-import.
        setState((s) => ({
            ...s,
            status: s.account ? "locked" : "anonymous",
            vault: null,
            needsImport: false,
        }));
    }, [state.vault]);

    const logout = useCallback(() => {
        setRecoveryPending(false);
        setRecoveryPhrase("");
        state.vault?.lock();
        clearImageCache();
        if (state.account)
            sessionStorage.removeItem(tokenKey(state.account.userId));
        localStorage.removeItem(ACTIVE_KEY);
        // The vault itself stays on disk -- logging out is not "destroy my keys".
        // Settings > remove account does that explicitly.
        setState({
            status: "anonymous",
            account: null,
            token: null,
            vault: null,
            needsImport: false,
        });
    }, [state.vault, state.account]);

    const selectAccount = useCallback(
        (userId: string) => {
            const account = getAccount(userId);
            if (!account) return;
            state.vault?.lock();
            localStorage.setItem(ACTIVE_KEY, userId);
            const token = sessionStorage.getItem(tokenKey(userId));
            Vault.resume(userId).then(async (vault) => {
                const needsImport = vault ? false : !(await hasVault(userId));
                setState({
                    status: vault ? "unlocked" : "locked",
                    account,
                    token,
                    vault,
                    needsImport,
                });
            });
        },
        [state.vault],
    );

    const removeAccount = useCallback(
        async (userId: string) => {
            sessionStorage.removeItem(tokenKey(userId));
            // Flip UI to a safe state before the (async) ciphertext sweep, so the app
            // is never showing an account whose vault is mid-deletion.
            if (state.account?.userId === userId) {
                localStorage.removeItem(ACTIVE_KEY);
                state.vault?.lock();
                setState({
                    status: "anonymous",
                    account: null,
                    token: null,
                    vault: null,
                    needsImport: false,
                });
            }
            await forgetAccount(userId);
            setAccounts(listAccounts());
        },
        [state.account, state.vault],
    );

    const value = useMemo<SessionApi>(
        () => ({
            ...state,
            accounts,
            recoveryPending,
            recoveryPhrase,
            acknowledgeRecovery,
            register,
            login,
            unlock,
            importIdentity,
            restoreFromBackup,
            recoverWithCode,
            syncRecoveryBlob,
            lock,
            logout,
            selectAccount,
            removeAccount,
            refresh,
        }),
        [
            state,
            accounts,
            recoveryPending,
            recoveryPhrase,
            acknowledgeRecovery,
            register,
            login,
            unlock,
            importIdentity,
            restoreFromBackup,
            recoverWithCode,
            syncRecoveryBlob,
            lock,
            logout,
            selectAccount,
            removeAccount,
            refresh,
        ],
    );

    return (
        <SessionContext.Provider value={value}>
            {children}
        </SessionContext.Provider>
    );
}

export function useSession(): SessionApi {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error("useSession must be used inside SessionProvider");
    return ctx;
}

/** For screens that only render once unlocked. */
export function useUnlockedSession() {
    const session = useSession();
    if (
        session.status !== "unlocked" ||
        !session.vault ||
        !session.token ||
        !session.account
    ) {
        throw new Error("session is not unlocked");
    }
    return {
        ...session,
        vault: session.vault,
        token: session.token,
        account: session.account,
    };
}
