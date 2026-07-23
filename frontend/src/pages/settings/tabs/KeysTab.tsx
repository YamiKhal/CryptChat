import { useState, useRef, ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Upload, RefreshCw, Check } from "lucide-react";
import { useSession } from "@/lib/session";
import { AccountDescriptor } from "@/lib/vault";
import { downloadBackup, readBackupFile } from "@/lib/backup/exportImport";
import { BackupContainer } from "@/lib/backup/container";
import { useAutoBackup } from "@/lib/backup/AutoBackupContext";
import Avatar from "@/components/ui/Avatar";
import { Toggle } from "@/components/ui/Toggle";
import { SettingsSection, SettingRow } from "@/components/settings/SettingsUI";
import { SetStatus } from "@/pages/settings/types";

/**
 * Backups & identities. Discord-rule for this page: one line per row, the
 * control on the right, every caveat lives behind the row's InfoTip instead of
 * an inline banner.
 */
export default function KeysTab({
    account,
    setStatus,
}: {
    account: AccountDescriptor;
    setStatus: SetStatus;
}) {
    const session = useSession();
    const navigate = useNavigate();
    const backup = useAutoBackup();

    const [importFile, setImportFile] = useState<BackupContainer | null>(null);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    async function handleExport() {
        setStatus(null);
        setBusy(true);
        try {
            const ok = await downloadBackup(account.userId, account.username);
            setStatus(
                ok
                    ? { kind: "ok", text: "Backup downloaded." }
                    : { kind: "error", text: "nothing to back up yet" },
            );
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    async function handleBackupFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setStatus(null);
        try {
            setImportFile(await readBackupFile(file));
        } catch (err) {
            setImportFile(null);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleImport() {
        if (!importFile) return;
        setStatus(null);
        if (importFile.account.userId !== account.userId) {
            setStatus({
                kind: "error",
                text: "this backup belongs to a different identity",
            });
            return;
        }
        const ok = confirm(
            "Restore this backup?\n\n" +
                "Everything currently on this device for this account. channels, contacts and message history. is replaced by the backup. The app reloads and asks for your password.",
        );
        if (!ok) return;
        setBusy(true);
        try {
            // Reloads on success, so no further state updates run here.
            await session.restoreFromBackup(importFile);
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
            setBusy(false);
        }
    }

    return (
        <div className="space-y-8">
            <SettingsSection title="Backup">
                <SettingRow
                    title="Export"
                    description="One encrypted file. keys, channels, history."
                    info="Sealed with your login password."
                    infoDetails="Writes everything on this device to one encrypted file. Restore it after clearing your browser, or on a new device. Anyone holding the file can attempt an offline crack, so keep it private. and a password change makes older backups unreadable."
                    control={
                        <button
                            onClick={handleExport}
                            disabled={busy}
                            className="btn-ghost"
                        >
                            <Download size={15} />
                            Download
                        </button>
                    }
                />
                <SettingRow
                    title="Import"
                    description={
                        importFile
                            ? "Backup loaded. restoring replaces this device."
                            : "Restore a backup file onto this device."
                    }
                    info="Replaces everything on this device."
                    infoDetails="Loads a backup file and replaces this device's data with it. The app reloads and asks for the password the backup was made under."
                    control={
                        importFile ? (
                            <button
                                onClick={handleImport}
                                disabled={busy}
                                className="btn-primary"
                            >
                                <Check size={15} />
                                Restore
                            </button>
                        ) : (
                            <button
                                onClick={() => fileInput.current?.click()}
                                className="btn-ghost"
                            >
                                <Upload size={15} />
                                Choose file
                            </button>
                        )
                    }
                />
                <input
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleBackupFile}
                />
                <AutoBackupRow backup={backup} navigate={navigate} />
            </SettingsSection>

            <SettingsSection
                title="Identities on this device"
                info="Each identity is a separate encrypted store keyed by its own password."
            >
                <div className="space-y-1.5 py-3.5">
                    {session.accounts.map((other) => {
                        const isActive = other.userId === account.userId;
                        return (
                            <div
                                key={other.userId}
                                className={`flex items-center gap-2.5 rounded-lg border p-2.5 transition-colors ${
                                    isActive
                                        ? "border-primary-line bg-primary-soft"
                                        : "border-border hover:border-primary-line"
                                }`}
                            >
                                <Avatar name={other.username} size="sm" />
                                <span className="t-base flex-1 truncate font-medium">
                                    {other.username}
                                </span>
                                {isActive ? (
                                    <span className="tag bg-primary-soft text-primary">
                                        active
                                    </span>
                                ) : (
                                    <button
                                        onClick={() => {
                                            session.selectAccount(other.userId);
                                            navigate("/channels");
                                        }}
                                        className="btn-ghost px-3 py-1"
                                    >
                                        Switch
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </SettingsSection>
        </div>
    );
}

/**
 * Auto-backup as ONE row: title, a status dot in the description and the
 * control that fits the state. a toggle when it can simply be on/off, an
 * upgrade button without premium, nothing on unsupported browsers.
 */
function AutoBackupRow({
    backup,
    navigate,
}: {
    backup: ReturnType<typeof useAutoBackup>;
    navigate: (to: string) => void;
}) {
    if (!backup) return null;

    if (!backup.supported) {
        return (
            <SettingRow
                title="Automatic backup"
                description="Needs Chrome or Edge."
                info="Firefox and Safari cannot write to a chosen file."
                infoDetails="Automatic backup keeps a file on disk that rewrites itself after every change. Only Chromium browsers grant that file access. elsewhere, use Export above."
            />
        );
    }

    if (!backup.premium) {
        return (
            <SettingRow
                title="Automatic backup"
                description="Pick a file once. it keeps itself current."
                info="A supporter feature."
                infoDetails="Supporters pick a file on disk that CryptChat rewrites silently after every change. It lives outside the browser, so clearing browsing data cannot touch it. A cloud-synced folder covers a lost device too."
                control={
                    <button
                        onClick={() => navigate("/subscribe")}
                        className="btn-ghost"
                    >
                        Upgrade
                    </button>
                }
            />
        );
    }

    const statusText = !backup.configured
        ? "Off"
        : backup.status === "saving"
          ? "Saving…"
          : backup.status === "reconnect"
            ? "Reconnect needed"
            : backup.status === "error"
              ? (backup.error ?? "Backup failed")
              : backup.lastSavedAt
                ? `Saved ${new Date(backup.lastSavedAt).toLocaleTimeString()}`
                : "Waiting for the next change";

    const dot = !backup.configured
        ? "bg-border"
        : backup.status === "error"
          ? "bg-error"
          : backup.status === "reconnect"
            ? "bg-warn"
            : "bg-ok";

    return (
        <SettingRow
            title="Automatic backup"
            info="Rewrites a file on disk after every change."
            infoDetails="The file lives outside the browser, so clearing browsing data cannot erase it. Put it in a cloud-synced folder (Drive, Dropbox, iCloud) and a lost device is covered as well."
            control={
                backup.status === "reconnect" ? (
                    <button
                        onClick={() => backup.reconnect()}
                        className="btn-primary"
                    >
                        <RefreshCw size={15} />
                        Reconnect
                    </button>
                ) : (
                    <Toggle
                        checked={backup.configured}
                        onChange={(next) =>
                            next ? backup.configure() : backup.disable()
                        }
                        label="Automatic backup"
                    />
                )
            }
        >
            <p className="t-small text-muted flex items-center gap-1.5">
                <span
                    className={`inline-block size-1.5 rounded-full ${dot}`}
                    aria-hidden="true"
                />
                {statusText}
                {backup.configured &&
                    (backup.status === "idle" || backup.status === "saved") && (
                        <button
                            onClick={() => backup.backupNow()}
                            className="text-muted hover:text-primary ml-1 underline underline-offset-2"
                        >
                            back up now
                        </button>
                    )}
            </p>
        </SettingRow>
    );
}
