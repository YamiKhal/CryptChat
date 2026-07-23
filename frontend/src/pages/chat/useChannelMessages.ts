import { useState, useEffect, useRef } from "react";
import { StoredMessage, StoredChannel, Vault } from "@/lib/vault";
import { Limits, DEFAULT_LIMITS } from "@/lib/limits";
import { api } from "@/lib/api";
import { setActiveChannel } from "@/lib/sounds";
import { PresenceEvent } from "@/lib/relayContext";

type PresenceNotice = { id: string; text: string; at: string };

/**
 * Owns the decrypted transcript for the open channel and every effect that keeps
 * it live: loading on entry, tier limits, the read marker, the burn-after-read
 * sweep, session-scoped presence notices and announcing our profile once a key
 * is held. Returns the transcript plus the scroll anchor.
 */
export function useChannelMessages({
    vault,
    channelId,
    channel,
    token,
    connected,
    revision,
    bumpRevision,
    broadcastProfile,
    lastPresence,
}: {
    vault: Vault | null;
    channelId: string | undefined;
    channel: StoredChannel | undefined;
    token: string | null;
    connected: boolean;
    revision: number;
    bumpRevision: () => void;
    broadcastProfile: (channelId: string) => Promise<void>;
    lastPresence: PresenceEvent | null;
}) {
    const [messages, setMessages] = useState<StoredMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
    const [presenceLog, setPresenceLog] = useState<PresenceNotice[]>([]);

    const bottomRef = useRef<HTMLDivElement>(null);
    const announced = useRef<string | null>(null);

    const hasKey = channel?.hasKey;

    // Tell the sound engine which channel is on screen, so a message that lands
    // here uses the soft in-chat cue rather than the louder "elsewhere" alert.
    useEffect(() => {
        setActiveChannel(channelId ?? null);
        return () => setActiveChannel(null);
    }, [channelId]);

    // Tier limits come from the server, never hardcoded here: it is the only
    // authority and a client that believes the wrong cap produces uploads that
    // die at 99% or messages the relay rejects.
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        api.limits(token)
            .then((res) => !cancelled && setLimits(res))
            // Keep the restrictive defaults on failure rather than assuming premium.
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [token, revision]);

    // Load the decrypted transcript for this channel. Messages are stored per
    // channel inside the vault, so opening a channel is one secretbox open.
    useEffect(() => {
        if (!vault || !channelId) return;
        let cancelled = false;

        setLoading(true);
        vault.loadMessages(channelId).then((loaded) => {
            if (cancelled) return;
            setMessages(loaded);
            setLoading(false);
        });

        return () => {
            cancelled = true;
        };
    }, [vault, channelId, revision]);

    // Announce our display name and avatar once per channel, once we hold a key.
    // Peers cannot render a name they were never sent -- the server has none to
    // give them.
    useEffect(() => {
        if (!channelId || !hasKey || !connected) return;
        if (announced.current === channelId) return;
        announced.current = channelId;
        broadcastProfile(channelId).catch(() => {});
    }, [channelId, hasKey, connected, broadcastProfile]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    // Mark the channel read while it is open: on entry and each time the
    // transcript grows. Clears the unread badge on the channel list. markChannelRead
    // never moves the marker backwards, so this only ever writes when there is
    // genuinely newer material.
    useEffect(() => {
        if (!vault || !channelId) return;
        // Bump the shared revision when the marker actually advances, so the channel
        // list recomputes its unread badge now rather than waiting for the next
        // unrelated relay event (which left the badge stuck at 1-2).
        vault
            .markChannelRead(channelId)
            .then((advanced) => {
                if (advanced) bumpRevision();
            })
            .catch(() => {});
    }, [vault, channelId, messages.length, bumpRevision]);

    // Burn-after-read sweep. While the channel is open, start the clock on any
    // burn message on screen and remove ones whose time is up. Running only while
    // open is the point: "read" means it was shown here.
    useEffect(() => {
        if (!vault || !channelId) return;
        let active = true;
        const tick = async () => {
            const res = await vault.processBurns(channelId);
            if (active && res.changed) setMessages(res.messages);
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [vault, channelId, messages.length]);

    // Anonymous "someone joined / left" as centered system lines in the transcript,
    // so they are actually seen. Session-scoped (never persisted, never signed) and
    // cleared when switching channels.
    useEffect(() => {
        setPresenceLog([]);
    }, [channelId]);
    useEffect(() => {
        if (!lastPresence || lastPresence.channelId !== channelId) return;
        // Stamp it when it happened. The render merges these into the transcript by
        // time, so a leave stays at its moment and later messages fall after it.
        setPresenceLog((log) => [
            ...log,
            {
                id: String(lastPresence.nonce),
                text:
                    lastPresence.event === "joined"
                        ? "Someone joined the channel"
                        : "Someone left the channel",
                at: new Date().toISOString(),
            },
        ]);
    }, [lastPresence, channelId]);

    return { messages, setMessages, loading, limits, presenceLog, bottomRef };
}
