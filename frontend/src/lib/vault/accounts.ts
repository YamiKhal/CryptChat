import { AccountDescriptor } from '@/lib/vault/types';
import { NS, ACCOUNT_INDEX, accountKey, vaultKeyName, sessionKeyName, readJson } from '@/lib/vault/storage';

export function listAccounts(): AccountDescriptor[] {
  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  return ids
    .map((id) => readJson<AccountDescriptor | null>(localStorage, accountKey(id), null))
    .filter((a): a is AccountDescriptor => a !== null)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export function getAccount(userId: string): AccountDescriptor | null {
  return readJson<AccountDescriptor | null>(localStorage, accountKey(userId), null);
}

/**
 * Whether this device holds an encrypted vault for the account.
 *
 * False after a correct login on a new device: credentials are valid, but the
 * private keys were never on the server to send back. That state needs an
 * import prompt, not a password prompt -- no password can unlock a vault that
 * does not exist here.
 */
export function hasVault(userId: string): boolean {
  return localStorage.getItem(vaultKeyName(userId)) !== null;
}

export function saveAccount(account: AccountDescriptor): void {
  localStorage.setItem(accountKey(account.userId), JSON.stringify(account));
  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  if (!ids.includes(account.userId)) {
    localStorage.setItem(ACCOUNT_INDEX, JSON.stringify([...ids, account.userId]));
  }
}

export function touchAccount(userId: string): void {
  const account = getAccount(userId);
  if (account) saveAccount({ ...account, lastUsedAt: new Date().toISOString() });
}

/** Removes the account, its vault, and every message namespace it owns. */
export function forgetAccount(userId: string): void {
  localStorage.removeItem(accountKey(userId));
  localStorage.removeItem(vaultKeyName(userId));
  sessionStorage.removeItem(sessionKeyName(userId));

  const prefix = `${NS}:msgs:${userId}:`;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key);
  }

  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  localStorage.setItem(ACCOUNT_INDEX, JSON.stringify(ids.filter((id) => id !== userId)));
}
