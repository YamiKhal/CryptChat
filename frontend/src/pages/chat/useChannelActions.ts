import { useState, useEffect, useReducer, useRef } from "react";
import { NavigateFunction } from "react-router-dom";
import { StoredChannel, Vault } from "@/lib/vault";
import { fileToAsset } from "@/lib/binary";
import { api } from "@/lib/api";
import { useContextMenu } from "@/components/ui/ContextMenu";
import type { useRelayContext } from "@/lib/relayContext";
import type { useCall } from "@/lib/callContext";

type Relay = ReturnType<typeof useRelayContext>;

/**
 * Channel-scoped actions that live on the header rather than the composer: leave,
 * block/unblock a DM, copy the invite code, rename, set or clear the group
 * picture, place a call and open a DM with a member. Also owns the header
 * context-menu wiring and the local block flag.
 */
export function useChannelActions({
    vault,
    channelId,
    token,
    channel,
    isDm,
    call,
    navigate,
    openDirectMessage,
    setError,
}: {
    vault: Vault;
    channelId: string | undefined;
    token: string | null;
    channel: StoredChannel | undefined;
    isDm: boolean;
    call: ReturnType<typeof useCall>;
    navigate: NavigateFunction;
    openDirectMessage: Relay["openDirectMessage"];
    setError: (message: string) => void;
}) {
    // Mirrors channel.blocked so a block/unblock re-renders the composer without a
    // full vault-driven refresh.
    const [dmBlocked, setDmBlocked] = useState(false);
    // The header name's own context menu (copy code / rename / block / leave).
    const [headerMenu, setHeaderMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);
    const [renamingChannel, setRenamingChannel] = useState(false);
    // Bumped after a local channel edit (icon) so the header, which reads `channel`
    // straight from the vault, re-renders once the mutated value is in place.
    const [, bumpChannel] = useReducer((n: number) => n + 1, 0);

    const iconInput = useRef<HTMLInputElement>(null);
    const {
        handlers: headerHandlers,
        position: headerPos,
        close: closeHeaderPress,
    } = useContextMenu();

    // Keep the local block flag in step with the vault (reconciled from the server
    // on the channel list), so opening a DM already shows the right composer state.
    useEffect(() => {
        setDmBlocked(Boolean(channel?.blocked));
    }, [channelId, channel?.blocked]);

    // A right-click / long-press on the header name arms useContextMenu; lift its
    // position into the page-owned menu, matching how message rows do it.
    useEffect(() => {
        if (headerPos) {
            setHeaderMenu({ x: headerPos.x, y: headerPos.y });
            closeHeaderPress();
        }
    }, [headerPos, closeHeaderPress]);

    async function handleLeave() {
        if (!channelId || !token) return;
        const prompt = isDm
            ? "Leave this direct message? It is removed from this device; the other person keeps their copy."
            : "Leave this channel? Its key and local messages are deleted from this device.";
        if (!confirm(prompt)) return;
        await api.leaveChannel(token, channelId).catch(() => {});
        await vault.removeChannel(channelId);
        navigate("/channels");
    }

    async function handleToggleBlock() {
        if (!channelId || !token || !channel) return;
        const next = !dmBlocked;
        try {
            if (next) await api.blockDm(token, channelId);
            else await api.unblockDm(token, channelId);
            setDmBlocked(next);
            await vault.saveChannel({ ...channel, blocked: next });
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function copyChannelCode() {
        if (!channel) return;
        try {
            await navigator.clipboard.writeText(channel.code);
            setError("");
        } catch {
            // Clipboard blocked (insecure context / denied): surface the code so it
            // can still be copied by hand rather than failing silently.
            setError(`Channel code: ${channel.code}`);
        }
    }

    async function handleRenameChannel(name: string) {
        if (!channel) return;
        await vault.saveChannel({
            ...channel,
            label: name.trim() || undefined,
        });
        // saveChannel mutates the vault in place; closing the modal re-renders and
        // getChannel returns the new label.
    }

    async function handleIconFile(file: File | undefined) {
        if (iconInput.current) iconInput.current.value = "";
        if (!file || !channel) return;
        try {
            // Same pipeline as the profile avatar: square, downscaled, re-encoded to
            // WebP (which strips EXIF). Only ever called for a group -- the menu hides
            // this for a DM, whose icon tracks the peer.
            const icon = await fileToAsset(file, {
                maxDimension: 256,
                square: true,
                mime: "image/webp",
                quality: 0.85,
            });
            await vault.saveChannel({ ...channel, icon });
            setError("");
            bumpChannel();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function handleRemoveIcon() {
        if (!channel) return;
        await vault.saveChannel({ ...channel, icon: undefined });
        bumpChannel();
    }

    function startCall(kind: "audio" | "video") {
        if (!channelId || !channel?.peerId) return;
        void call.startCall(channelId, channel.peerId, kind);
    }

    /** Open a DM with a member from the message menu, then jump to it. */
    async function handleStartDm(userId: string) {
        try {
            const id = await openDirectMessage(userId);
            if (id) navigate(`/chat/${id}`);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return {
        dmBlocked,
        headerMenu,
        setHeaderMenu,
        renamingChannel,
        setRenamingChannel,
        iconInput,
        headerHandlers,
        handleLeave,
        handleToggleBlock,
        copyChannelCode,
        handleRenameChannel,
        handleIconFile,
        handleRemoveIcon,
        startCall,
        handleStartDm,
    };
}
