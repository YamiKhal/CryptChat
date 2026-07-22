import type { Sealed } from '@/lib/crypto';
import { dbGet, dbPut, dbDelete, dbKeys } from '@/lib/vault/db';

/**
 * Storage key namespace for the vault, split across two backing stores.
 *
 * Every account gets its own namespace so two usernames in one browser profile
 * can neither see nor decrypt each other's state. At rest only the account
 * descriptor is plaintext; everything else is inside a secretbox.
 *
 * WHERE each thing lives:
 *   - Account registry + active-account pointer + session key: localStorage /
 *     sessionStorage. Small, and the account API stays synchronous.
 *   - Sealed vault blob + per-channel message logs: IndexedDB. Large and
 *     unbounded (see db.ts). These are the `*Sealed` accessors below.
 */

export const NS = 'darkchat';
export const ACCOUNT_INDEX = `${NS}:accounts`;
export const accountKey = (userId: string) => `${NS}:acct:${userId}`;
export const vaultKeyName = (userId: string) => `${NS}:vault:${userId}`;
export const messagesKeyName = (userId: string, channelId: string) =>
  `${NS}:msgs:${userId}:${channelId}`;
export const messagesPrefix = (userId: string) => `${NS}:msgs:${userId}:`;
export const sessionKeyName = (userId: string) => `${NS}:sk:${userId}`;
/** IndexedDB key holding the FileSystemFileHandle for premium auto-backup. */
export const backupHandleKey = (userId: string) => `${NS}:bh:${userId}`;

export function readJson<T>(store: Storage, key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* sealed blobs (IndexedDB)                                            */
/* ------------------------------------------------------------------ */

/** Read a sealed blob, or null when absent or unreadable. */
export async function getSealed(key: string): Promise<Sealed | null> {
  return dbGet<Sealed>(key);
}

export async function putSealed(key: string, sealed: Sealed): Promise<void> {
  await dbPut(key, sealed);
}

export async function delSealed(key: string): Promise<void> {
  await dbDelete(key);
}

/** Every message-log key for an account, so a delete can sweep all channels. */
export async function messageKeys(userId: string): Promise<string[]> {
  return dbKeys(messagesPrefix(userId));
}

/* ------------------------------------------------------------------ */
/* one-time migration: localStorage sealed blobs -> IndexedDB          */
/* ------------------------------------------------------------------ */

/**
 * Move any vault/message ciphertext left in localStorage by an older build into
 * IndexedDB, then delete the localStorage copy.
 *
 * Idempotent and safe to call on every boot: after the first pass there is
 * nothing under the prefixes to move. Runs before the session restores, so the
 * vault is read from its new home. A blob that fails to parse is dropped rather
 * than carried -- it was unopenable ciphertext either way.
 */
export async function migrateLocalStorageToIndexedDb(): Promise<void> {
  const vaultPrefix = `${NS}:vault:`;
  const msgPrefix = `${NS}:msgs:`;

  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith(vaultPrefix) || key.startsWith(msgPrefix))) stale.push(key);
  }
  if (stale.length === 0) return;

  for (const key of stale) {
    const raw = localStorage.getItem(key);
    if (raw) {
      try {
        await putSealed(key, JSON.parse(raw) as Sealed);
      } catch {
        // Unparseable: it could never have been opened. Drop it.
      }
    }
    localStorage.removeItem(key);
  }
}
