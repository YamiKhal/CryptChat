import { dbGet, dbPut, dbDelete } from '@/lib/vault/db';
import { backupHandleKey } from '@/lib/vault/storage';
import { serializeBackup, backupFilename } from '@/lib/backup/exportImport';
import { supportsFileSystemAccess } from '@/lib/backup/support';

/**
 * Premium silent auto-backup to a real disk file (File System Access API).
 *
 * The user picks a file once; its handle is persisted in IndexedDB (handles are
 * structured-cloneable, so they survive a reload). Thereafter every vault change
 * rewrites that file with no prompt and no dialog -- the point of "silent". A
 * file chosen this way lives OUTSIDE browser storage, so "clear browsing data"
 * cannot touch it: that is the whole durability win over IndexedDB.
 *
 * Chromium-only; callers gate on `supportsFileSystemAccess()` and offer manual
 * export elsewhere.
 */

export type BackupErrorCode =
  | 'unsupported' // browser has no File System Access API
  | 'not-configured' // no file has been picked for this account
  | 'permission' // the browser dropped write permission; needs a re-grant (user gesture)
  | 'empty'; // nothing to back up (no vault on this device)

export class AutoBackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AutoBackupError';
  }
}

function getHandle(userId: string): Promise<FileSystemFileHandle | null> {
  return dbGet<FileSystemFileHandle>(backupHandleKey(userId));
}

export async function isBackupConfigured(userId: string): Promise<boolean> {
  return (await getHandle(userId)) !== null;
}

/**
 * Prompt the user to choose the backup file and remember it for this account.
 *
 * Must run inside a user gesture (a click) -- the picker requires one. Returns
 * false if the user cancels the dialog. Writes an initial copy immediately so
 * the file is never left empty after being chosen.
 */
export async function configureBackup(userId: string, username: string): Promise<boolean> {
  if (!supportsFileSystemAccess()) {
    throw new AutoBackupError('unsupported', 'this browser cannot auto-backup to a file');
  }

  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker!({
      suggestedName: backupFilename(username),
      types: [{ description: 'CryptChat backup', accept: { 'application/json': ['.json'] } }],
      id: 'darkchat-backup',
    });
  } catch (err) {
    // The user dismissing the picker rejects with AbortError -- not an error we
    // surface, just "they changed their mind".
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }

  await dbPut(backupHandleKey(userId), handle);
  await writeBackup(userId);
  return true;
}

/** Forget the chosen file. Does not delete the file itself -- it is the user's. */
export async function disableBackup(userId: string): Promise<void> {
  await dbDelete(backupHandleKey(userId));
}

/**
 * Re-grant write permission after the browser dropped it (e.g. across a restart).
 *
 * Must run inside a user gesture. Returns whether permission is now granted.
 */
export async function reconnectBackup(userId: string): Promise<boolean> {
  const handle = await getHandle(userId);
  if (!handle) throw new AutoBackupError('not-configured', 'no backup file is set up');
  const granted = (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  if (granted) await writeBackup(userId);
  return granted;
}

/**
 * Write the current vault to the configured file.
 *
 * Silent path: it queries (never prompts for) permission, because a background
 * write triggered by a vault change has no user gesture to spend. If the browser
 * has dropped the grant it throws `permission`, and the UI surfaces a
 * "reconnect" affordance the user can click. The write itself is atomic --
 * `createWritable` stages to a swap file and only replaces the target on
 * `close()`, so a crash mid-write cannot corrupt the previous good backup.
 */
export async function writeBackup(userId: string): Promise<void> {
  const handle = await getHandle(userId);
  if (!handle) throw new AutoBackupError('not-configured', 'no backup file is set up');

  const permission = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
  if (permission !== 'granted') {
    throw new AutoBackupError('permission', 'backup file needs permission again');
  }

  const json = await serializeBackup(userId);
  if (!json) throw new AutoBackupError('empty', 'nothing to back up');

  const writable = await handle.createWritable();
  try {
    await writable.write(json);
  } finally {
    // close() commits the swap; if write threw, close still releases the lock.
    await writable.close();
  }
}
