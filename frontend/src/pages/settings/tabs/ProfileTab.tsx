import { useState, useEffect, useRef, ChangeEvent } from "react";
import { useSession } from "@/lib/session";
import { useRelayContext } from "@/lib/relayContext";
import {
    fileToAsset,
    BinaryAsset,
    base64UrlToBytes,
    bytesToDataUrl,
} from "@/lib/binary";
import { Vault, AccountDescriptor } from "@/lib/vault";
import Avatar from "@/components/ui/Avatar";
import {
    SettingsSection,
    SettingRow,
} from "@/components/settings/SettingsUI";
import { SetStatus } from "@/pages/settings/types";

export default function ProfileTab({
    vault,
    account,
    setStatus,
}: {
    vault: Vault;
    account: AccountDescriptor;
    setStatus: SetStatus;
}) {
    const session = useSession();
    const { broadcastProfileEverywhere } = useRelayContext();

    const [displayName, setDisplayName] = useState("");
    const [avatar, setAvatar] = useState<BinaryAsset | undefined>();
    const [bio, setBio] = useState("");
    const [background, setBackground] = useState<BinaryAsset | undefined>();
    const [busy, setBusy] = useState(false);

    const avatarInput = useRef<HTMLInputElement>(null);
    const backgroundInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDisplayName(vault.profile.displayName);
        setAvatar(vault.profile.avatar);
        setBio(vault.profile.bio ?? "");
        setBackground(vault.profile.background);
    }, [vault]);

    async function handleAvatar(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setStatus(null);
        try {
            const asset = await fileToAsset(file, {
                maxDimension: 256,
                square: true,
                mime: "image/webp",
                quality: 0.85,
            });
            setAvatar(asset);
            setStatus({ kind: "info", text: "Avatar ready. Save to apply." });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleBackground(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setStatus(null);
        try {
            const asset = await fileToAsset(file, {
                maxDimension: 640,
                mime: "image/webp",
                quality: 0.7,
            });
            setBackground(asset);
            setStatus({ kind: "info", text: "Banner ready. Save to apply." });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSaveProfile() {
        if (!displayName.trim()) {
            setStatus({ kind: "error", text: "display name cannot be empty" });
            return;
        }
        setBusy(true);
        try {
            await vault.setProfile({
                displayName: displayName.trim(),
                avatar,
                bio: bio.trim() || undefined,
                background,
            });
            // Peers only know a name if it is sent to them, encrypted and signed.
            await broadcastProfileEverywhere();
            session.refresh();
            setStatus({
                kind: "ok",
                text: "Profile saved and sent to your channels.",
            });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-8">
            <SettingsSection
                title="Profile"
                info="Only channel members see this — never the server."
                infoDetails="Your name, picture, bio, and banner are encrypted and signed, then sent only to members of channels you are in. The server stores none of it — it only ever holds a hash of your username."
            >
                <SettingRow
                    title="Picture"
                    control={
                        <div className="flex items-center gap-2">
                            {avatar && (
                                <button
                                    onClick={() => setAvatar(undefined)}
                                    className="t-base text-muted hover:text-error"
                                >
                                    Remove
                                </button>
                            )}
                            <button
                                onClick={() => avatarInput.current?.click()}
                                className="btn-ghost"
                            >
                                Change
                            </button>
                        </div>
                    }
                >
                    <input
                        ref={avatarInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={handleAvatar}
                    />
                    <Avatar
                        asset={avatar}
                        name={displayName || account.username}
                        size="lg"
                    />
                </SettingRow>

                <SettingRow title="Display name">
                    <input
                        className="field max-w-sm"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        maxLength={48}
                    />
                </SettingRow>

                <SettingRow title="Bio">
                    <textarea
                        className="field min-h-20 max-w-sm resize-y"
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        maxLength={500}
                        placeholder="Say something. [label](https://…) makes a link."
                    />
                    {bio.length > 400 && (
                        <span className="t-small text-muted">
                            {bio.length}/500
                        </span>
                    )}
                </SettingRow>

                <SettingRow
                    title="Banner"
                    control={
                        <div className="flex items-center gap-2">
                            {background && (
                                <button
                                    onClick={() => setBackground(undefined)}
                                    className="t-base text-muted hover:text-error"
                                >
                                    Remove
                                </button>
                            )}
                            <button
                                onClick={() => backgroundInput.current?.click()}
                                className="btn-ghost"
                            >
                                Change
                            </button>
                        </div>
                    }
                >
                    <input
                        ref={backgroundInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={handleBackground}
                    />
                    <div className="border-border bg-surface-raised h-14 w-28 overflow-hidden rounded-lg border">
                        {background && (
                            <img
                                src={bytesToDataUrl(
                                    base64UrlToBytes(background.data),
                                    background.mime,
                                )}
                                alt=""
                                className="h-full w-full object-cover"
                            />
                        )}
                    </div>
                </SettingRow>
            </SettingsSection>

            <button
                onClick={handleSaveProfile}
                disabled={busy}
                className="btn-primary w-full"
            >
                Save
            </button>
        </div>
    );
}
