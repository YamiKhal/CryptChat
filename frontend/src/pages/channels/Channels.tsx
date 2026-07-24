import { useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
    Copy,
    Pencil,
    LogOut,
    Ban,
    Image as ImageIcon,
    Trash2,
    Plus,
} from "lucide-react";
import { api } from "@/lib/api";
import { generateChannelKey } from "@/lib/crypto";
import { fileToAsset } from "@/lib/binary";
import { useSession } from "@/lib/session";
import { useRelayContext } from "@/lib/relayContext";
import { StoredChannel } from "@/lib/vault";
import { ContextMenu, MenuItem } from "@/components/ui/ContextMenu";
import { ChannelNameModal } from "@/components/channel/ChannelNameModal";
import { NewChannelModal } from "@/components/channel/NewChannelModal";
import AccountBar from "@/components/layout/AccountBar";
import { ChannelRow } from "@/pages/channels/ChannelRow";
import { useChannelList } from "@/pages/channels/useChannelList";

export default function Channels() {
    const { vault, token, account } = useSession();
    const { revision, membershipRevision } = useRelayContext();
    const navigate = useNavigate();
    const { channelId: activeChannelId } = useParams<{ channelId: string }>();

    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const [menu, setMenu] = useState<{
        channel: StoredChannel;
        x: number;
        y: number;
    } | null>(null);
    const [renaming, setRenaming] = useState<StoredChannel | null>(null);
    const iconTarget = useRef<StoredChannel | null>(null);
    const iconInput = useRef<HTMLInputElement>(null);

    const { channels, unread, premium, reload } = useChannelList(
        vault,
        token,
        revision,
        membershipRevision,
    );

    async function handleCreate(name: string, incognito: boolean) {
        if (!vault || !token) return;
        setError("");
        setBusy(true);
        try {
            const res = await api.createChannel(token, incognito);

            // The creator mints the channel key locally
            const key = await generateChannelKey();

            await vault.saveChannel({
                channelId: res.channelId,
                code: res.code,
                key,
                hasKey: true,
                incognito: res.incognito,
                label: name.trim() || undefined,
                joinedAt: new Date().toISOString(),
            });

            setShowNew(false);
            reload();
            navigate(`/chat/${res.channelId}`);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleJoin(code: string) {
        if (!vault || !token) return;
        setError("");
        setNotice("");
        setBusy(true);
        try {
            const res = await api.joinChannel(token, code.trim());

            const existing = vault.getChannel(res.channelId);
            if (existing?.hasKey) {
                setShowNew(false);
                navigate(`/chat/${res.channelId}`);
                return;
            }

            await vault.saveChannel({
                channelId: res.channelId,
                code: res.code,
                key: "",
                hasKey: false,
                incognito: res.incognito,
                joinedAt: new Date().toISOString(),
            });

            reload();

            if (res.members.length === 0) {
                setNotice(
                    "Joined. You are the only member. no key to receive yet.",
                );
            } else {
                setNotice(
                    "Joined. Waiting for a member to send the channel key…",
                );
            }

            setShowNew(false);
            navigate(`/chat/${res.channelId}`);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function copyCode(code: string) {
        try {
            await navigator.clipboard.writeText(code);
        } catch {
            setNotice(`Channel code: ${code}`);
        }
        setError("");
    }

    async function handleRename(channel: StoredChannel, name: string) {
        if (!vault) return;
        await vault.saveChannel({
            ...channel,
            label: name.trim() || undefined,
        });
        reload();
    }

    function pickIcon(channel: StoredChannel) {
        iconTarget.current = channel;
        iconInput.current?.click();
    }

    async function handleIconFile(file: File | undefined) {
        const channel = iconTarget.current;
        iconTarget.current = null;
        if (iconInput.current) iconInput.current.value = "";
        if (!file || !vault || !channel) return;
        try {
            const icon = await fileToAsset(file, {
                maxDimension: 256,
                square: true,
                mime: "image/webp",
                quality: 0.85,
            });
            await vault.saveChannel({ ...channel, icon });
            reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function handleRemoveIcon(channel: StoredChannel) {
        if (!vault) return;
        await vault.saveChannel({ ...channel, icon: undefined });
        reload();
    }

    async function handleAcceptDm(channel: StoredChannel) {
        if (!vault || !token) return;
        setError("");
        try {
            await api.acceptDm(token, channel.channelId);
            await vault.saveChannel({ ...channel, request: false });
            reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function handleDeclineDm(channel: StoredChannel) {
        if (!vault || !token) return;
        if (
            !confirm(
                "Decline this message request? It is removed and they are not told.",
            )
        )
            return;
        await api.leaveChannel(token, channel.channelId).catch(() => {});
        await vault.removeChannel(channel.channelId);
        reload();
    }

    async function handleLeave(channel: StoredChannel) {
        if (!vault || !token) return;
        const message =
            channel.type === "dm"
                ? "Leave this direct message? It is removed from this device; the other person keeps their copy."
                : "Leave this channel? Its key and local messages are deleted from this device.";
        if (!confirm(message)) return;
        await api.leaveChannel(token, channel.channelId).catch(() => {});
        await vault.removeChannel(channel.channelId);
        reload();
    }

    async function handleToggleBlock(channel: StoredChannel) {
        if (!vault || !token) return;
        const next = !channel.blocked;
        try {
            if (next) await api.blockDm(token, channel.channelId);
            else await api.unblockDm(token, channel.channelId);
            await vault.saveChannel({ ...channel, blocked: next });
            reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    function menuItems(channel: StoredChannel): MenuItem[] {
        const items: MenuItem[] = [
            {
                label: "Copy channel code",
                icon: <Copy size={14} />,
                onSelect: () => copyCode(channel.code),
            },
            {
                label: channel.label ? "Rename" : "Set a name",
                icon: <Pencil size={14} />,
                onSelect: () => setRenaming(channel),
            },
        ];
        if (channel.type !== "dm") {
            items.push({
                label: channel.icon ? "Change picture" : "Set a picture",
                icon: <ImageIcon size={14} />,
                onSelect: () => pickIcon(channel),
            });
            if (channel.icon) {
                items.push({
                    label: "Remove picture",
                    icon: <Trash2 size={14} />,
                    onSelect: () => handleRemoveIcon(channel),
                });
            }
        }
        if (channel.type === "dm") {
            items.push({
                label: channel.blocked ? "Unblock" : "Block",
                icon: <Ban size={14} />,
                danger: !channel.blocked,
                onSelect: () => handleToggleBlock(channel),
            });
        }
        items.push({
            label:
                channel.type === "dm" ? "Leave conversation" : "Leave channel",
            icon: <LogOut size={14} />,
            danger: true,
            onSelect: () => handleLeave(channel),
        });
        return items;
    }

    if (!vault || !account) return null;

    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
                <div className="mb-1 flex items-center justify-between px-2 pt-1">
                    <p className="t-small text-muted font-semibold tracking-wider uppercase">
                        channels
                    </p>
                    <button
                        onClick={() => {
                            setError("");
                            setNotice("");
                            setShowNew(true);
                        }}
                        className="text-muted hover:bg-surface-raised hover:text-primary rounded-lg p-1.5 transition-colors"
                        title="New channel"
                        aria-label="New channel"
                    >
                        <Plus size={18} />
                    </button>
                </div>

                {error && !showNew && (
                    <p className="border-error-line bg-error-soft t-base text-error mb-2 rounded-lg border p-2.5">
                        {error}
                    </p>
                )}
                {notice && (
                    <p className="border-info-line bg-info-soft t-base text-info mb-2 rounded-lg border p-2.5">
                        {notice}
                    </p>
                )}

                {channels.length === 0 && (
                    <p className="t-base text-muted px-2 py-1">
                        No channels yet. Create one or join with a code.
                    </p>
                )}

                {channels.map((channel) => (
                    <ChannelRow
                        key={channel.channelId}
                        channel={channel}
                        peerName={
                            channel.peerId
                                ? vault.getContact(channel.peerId)?.displayName
                                : undefined
                        }
                        peerAvatar={
                            channel.peerId
                                ? vault.getContact(channel.peerId)?.avatar
                                : undefined
                        }
                        unread={unread[channel.channelId] ?? 0}
                        active={channel.channelId === activeChannelId}
                        onOpen={() => navigate(`/chat/${channel.channelId}`)}
                        onOpenMenu={(x, y) => setMenu({ channel, x, y })}
                        onAccept={() => handleAcceptDm(channel)}
                        onDecline={() => handleDeclineDm(channel)}
                    />
                ))}
            </div>

            <AccountBar />

            {showNew && (
                <NewChannelModal
                    premium={premium}
                    busy={busy}
                    error={error}
                    onCreate={handleCreate}
                    onJoin={handleJoin}
                    onClose={() => {
                        setShowNew(false);
                        setError("");
                    }}
                />
            )}

            {menu && (
                <ContextMenu
                    items={menuItems(menu.channel)}
                    position={{ x: menu.x, y: menu.y }}
                    onClose={() => setMenu(null)}
                />
            )}

            {renaming && (
                <ChannelNameModal
                    channel={renaming}
                    onClose={() => setRenaming(null)}
                    onSubmit={(name) => handleRename(renaming, name)}
                />
            )}

            <input
                ref={iconInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleIconFile(e.target.files?.[0])}
            />
        </div>
    );
}
