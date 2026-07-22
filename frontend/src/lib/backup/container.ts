import type { Sealed } from '@/lib/crypto';
import { AccountDescriptor, getAccount, saveAccount } from '@/lib/vault';
import {
  getSealed,
  putSealed,
  vaultKeyName,
  messagesKeyName,
  messagesPrefix,
  messageKeys,
} from '@/lib/vault/storage';

/**
 * A full-vault backup: everything needed to bring this identity back on a bare
 * device, and nothing the server could not already see.
 *
 * WHAT IS IN HERE, and why it is safe to hand around:
 *   - `account`: the plaintext account descriptor. It is already plaintext in
 *     localStorage; it holds public keys, the username, and the KDF salt -- no
 *     private key and no message.
 *   - `vault` + `messages`: the *sealed* blobs, byte-for-byte as they sit in
 *     IndexedDB. Both are secretbox ciphertext under the login-password vault
 *     key. This file is only as strong as that password (a deliberate choice --
 *     see the Backup settings warning), which is why it must not be sealed under
 *     a weaker secret and why the manual-export UI warns before it leaves the
 *     device.
 *
 * Restore writes these bytes back and lets a normal unlock decrypt them, so no
 * key material is ever re-derived or re-encrypted here.
 */
export interface BackupContainer {
  format: 'darkchat-backup';
  v: number;
  exportedAt: string;
  account: AccountDescriptor;
  vault: Sealed;
  messages: { channelId: string; sealed: Sealed }[];
}

export const BACKUP_FORMAT = 'darkchat-backup';
export const BACKUP_VERSION = 1;

/**
 * Assemble a backup from the at-rest ciphertext for `userId`.
 *
 * Does not need the vault unlocked: it copies sealed bytes, it never opens them.
 * Returns null when there is no vault to back up (nothing sealed on this device).
 */
export async function buildBackup(userId: string): Promise<BackupContainer | null> {
  const account = getAccount(userId);
  if (!account) return null;

  const vault = await getSealed(vaultKeyName(userId));
  if (!vault) return null;

  const prefix = messagesPrefix(userId);
  const keys = await messageKeys(userId);
  const messages: BackupContainer['messages'] = [];
  for (const key of keys) {
    const sealed = await getSealed(key);
    if (sealed) messages.push({ channelId: key.slice(prefix.length), sealed });
  }

  return {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    account,
    vault,
    messages,
  };
}

/** Structural validation of a parsed file, before it is trusted as a backup. */
export function isBackupContainer(value: unknown): value is BackupContainer {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<BackupContainer>;
  return (
    c.format === BACKUP_FORMAT &&
    typeof c.v === 'number' &&
    typeof c.account === 'object' &&
    c.account !== null &&
    typeof c.account.userId === 'string' &&
    typeof c.account.vaultSalt === 'string' &&
    typeof c.vault === 'object' &&
    c.vault !== null &&
    Array.isArray(c.messages)
  );
}

/**
 * Write a backup's ciphertext into this device's stores, then hand back the
 * restored account descriptor so the caller can unlock it.
 *
 * This OVERWRITES the target account's vault and message logs on this device --
 * the caller is responsible for confirming that with the user first (the UI
 * does). It does not touch the active session or unlock anything: the restored
 * vault is sealed under whatever password was in force when the backup was made,
 * so only that password will open it.
 */
export async function restoreBackup(container: BackupContainer): Promise<AccountDescriptor> {
  if (!isBackupContainer(container)) throw new Error('not a valid backup file');
  if (container.v !== BACKUP_VERSION) {
    throw new Error(`unsupported backup version ${container.v}`);
  }

  const { account } = container;

  // Register the account first: without its descriptor (salt + public keys) the
  // vault key cannot be derived and the restored blob is unopenable.
  saveAccount({ ...account, lastUsedAt: new Date().toISOString() });

  await putSealed(vaultKeyName(account.userId), container.vault);
  for (const { channelId, sealed } of container.messages) {
    await putSealed(messagesKeyName(account.userId, channelId), sealed);
  }

  return account;
}
