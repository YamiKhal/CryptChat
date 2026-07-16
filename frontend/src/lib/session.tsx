import { createContext, useContext, useEffect, useMemo, useState, ReactNode, useCallback } from 'react';
import { api } from './api';
import { generateIdentity, Identity, importKeyBundle, EncryptedBundle } from './crypto';
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
} from './vault';

/**
 * Session state for multi-account use in one browser.
 *
 * Four states, and the differences matter:
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

type Status = 'restoring' | 'anonymous' | 'locked' | 'unlocked';

interface SessionState {
  status: Status;
  account: AccountDescriptor | null;
  token: string | null;
  vault: Vault | null;
}

interface SessionApi extends SessionState {
  accounts: AccountDescriptor[];
  /** True when the active account has no vault on this device (needs an import). */
  needsImport: boolean;
  register(username: string, password: string): Promise<void>;
  login(username: string, password: string, remember: boolean): Promise<void>;
  unlock(password: string, remember: boolean): Promise<void>;
  /** Rebuild this device's vault from an exported key file. */
  importIdentity(bundle: EncryptedBundle, passphrase: string, password: string): Promise<void>;
  lock(): void;
  logout(): void;
  selectAccount(userId: string): void;
  removeAccount(userId: string): void;
  /** Re-read vault-backed state after a mutation. */
  refresh(): void;
}

const SessionContext = createContext<SessionApi | null>(null);

const ACTIVE_KEY = 'darkchat:active';
const tokenKey = (userId: string) => `darkchat:tok:${userId}`;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    status: 'restoring',
    account: null,
    token: null,
    vault: null,
  });
  const [accounts, setAccounts] = useState<AccountDescriptor[]>(() => listAccounts());
  const [, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Restore the last account on load. A tab-scoped vault key (if the user asked
  // to be remembered) means reload lands unlocked; otherwise it lands locked
  // and prompts, rather than silently showing an empty app.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const activeId = localStorage.getItem(ACTIVE_KEY);
      const account = activeId ? getAccount(activeId) : null;

      // Every path must settle the status, or the app hangs on the restoring
      // screen forever.
      if (!activeId || !account) {
        if (!cancelled) setState({ status: 'anonymous', account: null, token: null, vault: null });
        return;
      }

      const token = sessionStorage.getItem(tokenKey(activeId));
      const vault = await Vault.resume(activeId);
      if (cancelled) return;

      setState({
        status: vault ? 'unlocked' : 'locked',
        account,
        token,
        vault,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const identity: Identity = await generateIdentity();

    const res = await api.register(
      username,
      password,
      identity.publicKey,
      identity.signPublicKey,
      identity.vaultSalt
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
      profile: { displayName: username, updatedAt: new Date().toISOString() },
    });
    await vault.rememberForSession();

    sessionStorage.setItem(tokenKey(res.userId), res.token);
    localStorage.setItem(ACTIVE_KEY, res.userId);

    setAccounts(listAccounts());
    setState({ status: 'unlocked', account, token: res.token, vault });
  }, []);

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    const res = await api.login(username, password);

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
      setState({ status: 'locked', account, token: res.token, vault: null });
      return;
    }

    const vault = await Vault.unlock(res.userId, password);
    if (remember) await vault.rememberForSession();

    setState({ status: 'unlocked', account, token: res.token, vault });
  }, []);

  const unlock = useCallback(
    async (password: string, remember: boolean) => {
      if (!state.account) throw new Error('no account selected');
      const vault = await Vault.unlock(state.account.userId, password);
      if (remember) await vault.rememberForSession();

      let token = state.token;
      if (!token) {
        // Vault password and account password are the same secret, so a valid
        // unlock is also enough to mint a fresh token when the old one expired.
        const res = await api.login(state.account.username, password);
        token = res.token;
        sessionStorage.setItem(tokenKey(state.account.userId), token);
      }

      touchAccount(state.account.userId);
      setState((s) => ({ ...s, status: 'unlocked', token, vault }));
    },
    [state.account, state.token]
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
    async (bundle: EncryptedBundle, passphrase: string, password: string) => {
      if (!state.account) throw new Error('log in first, then import your key file');

      const opened = await importKeyBundle(bundle, passphrase);
      if (opened.userId !== state.account.userId) {
        throw new Error('this key file belongs to a different identity');
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
        profile: { displayName: state.account.username, updatedAt: new Date().toISOString() },
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

      setState((s) => ({ ...s, status: 'unlocked', account, vault }));
    },
    [state.account]
  );

  const lock = useCallback(() => {
    state.vault?.lock();
    setState((s) => ({ ...s, status: s.account ? 'locked' : 'anonymous', vault: null }));
  }, [state.vault]);

  const logout = useCallback(() => {
    state.vault?.lock();
    if (state.account) sessionStorage.removeItem(tokenKey(state.account.userId));
    localStorage.removeItem(ACTIVE_KEY);
    // The vault itself stays on disk -- logging out is not "destroy my keys".
    // Settings > remove account does that explicitly.
    setState({ status: 'anonymous', account: null, token: null, vault: null });
  }, [state.vault, state.account]);

  const selectAccount = useCallback(
    (userId: string) => {
      const account = getAccount(userId);
      if (!account) return;
      state.vault?.lock();
      localStorage.setItem(ACTIVE_KEY, userId);
      const token = sessionStorage.getItem(tokenKey(userId));
      Vault.resume(userId).then((vault) => {
        setState({ status: vault ? 'unlocked' : 'locked', account, token, vault });
      });
    },
    [state.vault]
  );

  const removeAccount = useCallback(
    (userId: string) => {
      forgetAccount(userId);
      sessionStorage.removeItem(tokenKey(userId));
      setAccounts(listAccounts());
      if (state.account?.userId === userId) {
        localStorage.removeItem(ACTIVE_KEY);
        setState({ status: 'anonymous', account: null, token: null, vault: null });
      }
    },
    [state.account]
  );

  const value = useMemo<SessionApi>(
    () => ({
      ...state,
      accounts,
      needsImport: state.status === 'locked' && !!state.account && !hasVault(state.account.userId),
      register,
      login,
      unlock,
      importIdentity,
      lock,
      logout,
      selectAccount,
      removeAccount,
      refresh,
    }),
    [
      state,
      accounts,
      register,
      login,
      unlock,
      importIdentity,
      lock,
      logout,
      selectAccount,
      removeAccount,
      refresh,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** For screens that only render once unlocked. */
export function useUnlockedSession() {
  const session = useSession();
  if (session.status !== 'unlocked' || !session.vault || !session.token || !session.account) {
    throw new Error('session is not unlocked');
  }
  return {
    ...session,
    vault: session.vault,
    token: session.token,
    account: session.account,
  };
}
