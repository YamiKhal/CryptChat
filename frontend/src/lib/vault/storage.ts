/**
 * localStorage/sessionStorage key namespace for the vault.
 *
 * Every account gets its own namespace so two usernames in one browser profile
 * can neither see nor decrypt each other's state. At rest only the account
 * descriptor is plaintext; everything else is inside a secretbox.
 */

export const NS = 'darkchat';
export const ACCOUNT_INDEX = `${NS}:accounts`;
export const accountKey = (userId: string) => `${NS}:acct:${userId}`;
export const vaultKeyName = (userId: string) => `${NS}:vault:${userId}`;
export const messagesKeyName = (userId: string, channelId: string) => `${NS}:msgs:${userId}:${channelId}`;
export const sessionKeyName = (userId: string) => `${NS}:sk:${userId}`;

export function readJson<T>(store: Storage, key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
