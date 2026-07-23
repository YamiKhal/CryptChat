import {
    buildBackup,
    restoreBackup,
    isBackupContainer,
    BackupContainer,
} from "@/lib/backup/container";
import { AccountDescriptor } from "@/lib/vault";

/**
 * Manual backup: download the whole vault as one JSON file and restore from it.
 *
 * This is the baseline that works in every browser, premium or not, Firefox
 * included -- unlike the silent File System Access auto-backup, which is
 * Chromium-only. The file is login-password-sealed ciphertext (see container.ts).
 */

/** Serialize a backup to the exact bytes written to a file or disk handle. */
export async function serializeBackup(userId: string): Promise<string | null> {
    const container = await buildBackup(userId);
    return container ? JSON.stringify(container) : null;
}

function timestampSlug(): string {
    // 2026-07-22T13-04-55 -- filesystem-safe, sorts chronologically.
    return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

export function backupFilename(username: string): string {
    return `darkchat-backup-${username}-${timestampSlug()}.json`;
}

/** Trigger a browser download of the full backup. Returns false if there is nothing to back up. */
export async function downloadBackup(
    userId: string,
    username: string,
): Promise<boolean> {
    const json = await serializeBackup(userId);
    if (!json) return false;

    const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
    );
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = backupFilename(username);
        link.click();
    } finally {
        URL.revokeObjectURL(url);
    }
    return true;
}

/** Parse a chosen file into a validated backup container, or throw. */
export async function readBackupFile(file: File): Promise<BackupContainer> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new Error("not a valid backup file");
    }
    if (!isBackupContainer(parsed)) throw new Error("not a valid backup file");
    return parsed;
}

/**
 * Restore a backup file onto this device.
 *
 * `expectedUserId`, when given, guards against restoring a file that belongs to
 * a *different* identity over the one you are signed into -- the caller passes
 * the active account's id so a stray file cannot silently replace it. Returns
 * the restored descriptor; the caller unlocks with the backup-era password.
 */
export async function importBackup(
    container: BackupContainer,
    expectedUserId?: string,
): Promise<AccountDescriptor> {
    if (expectedUserId && container.account.userId !== expectedUserId) {
        throw new Error("this backup belongs to a different identity");
    }
    return restoreBackup(container);
}
