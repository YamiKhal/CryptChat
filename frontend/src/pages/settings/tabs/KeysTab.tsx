import { useState, useRef, ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/lib/session";
import {
    exportKeyBundle,
    importKeyBundle,
    EncryptedBundle,
} from "@/lib/crypto";
import { saveAccount, Vault, AccountDescriptor } from "@/lib/vault";
import Avatar from "@/components/ui/Avatar";
import { InfoTip } from "@/components/ui/InfoTip";
import {
    SettingsSection,
    SettingBlock,
} from "@/components/settings/SettingsUI";
import { SetStatus } from "@/pages/settings/types";

export default function KeysTab({
    vault,
    account,
    setStatus,
}: {
    vault: Vault;
    account: AccountDescriptor;
    setStatus: SetStatus;
}) {
    const session = useSession();
    const navigate = useNavigate();

    const [exportPassphrase, setExportPassphrase] = useState("");
    const [importPassphrase, setImportPassphrase] = useState("");
    const [importFile, setImportFile] = useState<EncryptedBundle | null>(null);
    const [importPassword, setImportPassword] = useState("");
    const [busy, setBusy] = useState(false);

    const bundleInput = useRef<HTMLInputElement>(null);

    async function handleExport() {
        setStatus(null);
        if (exportPassphrase.length < 12) {
            setStatus({
                kind: "error",
                text: "export passphrase must be at least 12 characters",
            });
            return;
        }
        setBusy(true);
        try {
            const data = vault.snapshot();
            const bundle = await exportKeyBundle(
                {
                    userId: account.userId,
                    identity: data.identity,
                    channels: Object.values(data.channels)
                        .filter((c) => c.hasKey)
                        .map((c) => ({
                            channelId: c.channelId,
                            code: c.code,
                            key: c.key,
                        })),
                },
                exportPassphrase,
            );

            const blob = new Blob([JSON.stringify(bundle, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `darkchat-keys-${account.username}-${Date.now()}.json`;
            link.click();
            URL.revokeObjectURL(url);

            setExportPassphrase("");
            setStatus({
                kind: "ok",
                text: "Key file downloaded. It is encrypted — the passphrase is the only way in.",
            });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    async function handleBundleFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setStatus(null);
        try {
            setImportFile(JSON.parse(await file.text()) as EncryptedBundle);
            setStatus({
                kind: "info",
                text: "Key file loaded. Enter its passphrase to import.",
            });
        } catch {
            setStatus({ kind: "error", text: "not a valid key file" });
        }
    }

    /**
     * Import keys from another device.
     *
     * Rebuilds this device's vault from the bundle. The account password is
     * needed too: the bundle passphrase only opens the file, while the vault on
     * *this* device is keyed from the account password.
     */
    async function handleImport() {
        setStatus(null);
        setBusy(true);
        try {
            if (!importFile) throw new Error("choose a key file first");

            const bundle = await importKeyBundle(importFile, importPassphrase);

            if (bundle.userId !== account.userId) {
                throw new Error("this key file belongs to a different identity");
            }

            const existing = vault.snapshot();
            const channels = { ...existing.channels };
            for (const channel of bundle.channels) {
                channels[channel.channelId] = {
                    channelId: channel.channelId,
                    code: channel.code,
                    key: channel.key,
                    hasKey: true,
                    joinedAt:
                        existing.channels[channel.channelId]?.joinedAt ??
                        new Date().toISOString(),
                };
            }

            const rebuilt = await Vault.create(account.userId, importPassword, {
                identity: bundle.identity,
                channels,
                contacts: existing.contacts,
                profile: existing.profile,
            });
            await rebuilt.rememberForSession();

            saveAccount({
                ...account,
                publicKey: bundle.identity.publicKey,
                signPublicKey: bundle.identity.signPublicKey,
                vaultSalt: bundle.identity.vaultSalt,
                lastUsedAt: new Date().toISOString(),
            });

            setImportFile(null);
            setImportPassphrase("");
            setImportPassword("");
            setStatus({
                kind: "ok",
                text: `Imported ${bundle.channels.length} channel key(s). Reloading…`,
            });

            // Cheapest correct way to rebind every consumer to the rebuilt vault.
            setTimeout(() => window.location.reload(), 800);
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-8">
            <SettingsSection
                title="Export keys"
                info="Save an encrypted copy of your keys to move to another device."
                infoDetails="Writes your private keys and every channel key to an encrypted file, so you can move this identity to another device. The server cannot do this for you — it has never held these keys."
            >
                <SettingBlock>
                    <label className="block space-y-1">
                        <span className="t-base text-muted flex items-center gap-1.5">
                            passphrase for the file (min 12)
                            <InfoTip
                                title="Use a fresh passphrase"
                                tip="Different from your login password — this file leaves the device."
                                details="Use a different passphrase from your login password. This file leaves the device; if it shares the account secret, one leaked file is a full account compromise."
                            />
                        </span>
                        <input
                            className="field"
                            type="password"
                            autoComplete="new-password"
                            value={exportPassphrase}
                            onChange={(e) => setExportPassphrase(e.target.value)}
                        />
                    </label>
                    <button
                        onClick={handleExport}
                        disabled={busy}
                        className="btn-ghost w-full"
                    >
                        Export key file
                    </button>
                </SettingBlock>
            </SettingsSection>

            <SettingsSection
                title="Import keys"
                info="Restore an identity exported from another device."
                infoDetails="Restore an identity exported from another device. Replaces this device's keys and merges in the channel keys from the file."
            >
                <SettingBlock>
                    <input
                        ref={bundleInput}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={handleBundleFile}
                    />
                    <button
                        onClick={() => bundleInput.current?.click()}
                        className="btn-ghost t-base w-full"
                    >
                        {importFile ? "key file loaded ✓" : "choose key file"}
                    </button>

                    <label className="block space-y-1">
                        <span className="t-base text-muted">file passphrase</span>
                        <input
                            className="field"
                            type="password"
                            value={importPassphrase}
                            onChange={(e) => setImportPassphrase(e.target.value)}
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="t-base text-muted flex items-center gap-1.5">
                            your account password
                            <InfoTip
                                title="Account password"
                                tip="Re-encrypts the restored vault on this device."
                                details="The file passphrase only opens the exported file; your account password re-encrypts the vault on this device, which is keyed from it."
                            />
                        </span>
                        <input
                            className="field"
                            type="password"
                            value={importPassword}
                            onChange={(e) => setImportPassword(e.target.value)}
                        />
                    </label>

                    <button
                        onClick={handleImport}
                        disabled={
                            busy ||
                            !importFile ||
                            !importPassphrase ||
                            !importPassword
                        }
                        className="btn-ghost w-full"
                    >
                        Import
                    </button>
                </SettingBlock>
            </SettingsSection>

            <SettingsSection
                title="Identities on this device"
                info="Each identity is a separate encrypted store."
                infoDetails="Each identity has a separate encrypted store keyed by its own password. Switching does not expose one to the other."
            >
                <SettingBlock>
                    {session.accounts.map((other) => (
                        <div
                            key={other.userId}
                            className={`flex items-center gap-2 rounded border p-3 ${
                                other.userId === account.userId
                                    ? "border-primary-line bg-primary-soft"
                                    : "border-border"
                            }`}
                        >
                            <Avatar name={other.username} size="sm" />
                            <span className="t-base flex-1 truncate">
                                {other.username}
                            </span>
                            {other.userId === account.userId ? (
                                <span className="tag bg-primary-soft text-primary">
                                    active
                                </span>
                            ) : (
                                <button
                                    onClick={() => {
                                        session.selectAccount(other.userId);
                                        navigate("/channels");
                                    }}
                                    className="t-small text-muted hover:text-primary"
                                >
                                    switch
                                </button>
                            )}
                        </div>
                    ))}
                </SettingBlock>
            </SettingsSection>
        </div>
    );
}
