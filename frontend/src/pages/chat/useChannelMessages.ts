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
    /** Channels we have announced our profile to on the current connection. */
    const announced = useRef<Set<string>>(new Set());

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
    //
    // A set, not the last channel seen: that only remembered one, so bouncing
    // A -> B -> A re-announced to A every time. The announcement is fanned out to
    // every member, so a switch was costing each of them a frame to decrypt.
    // Cleared on disconnect below, since a reconnect may find members who joined
    // while we were away.
    useEffect(() => {
        if (!channelId || !hasKey || !connected) return;
        if (announced.current.has(channelId)) return;
        announced.current.add(channelId);
        broadcastProfile(channelId).catch(() => {});
    }, [channelId, hasKey, connected, broadcastProfile]);

    useEffect(() => {
        if (!connected) announced.current.clear();
    }, [connected]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    // Mark the channel read while it is open: on entry and each time the
    // transcript grows. Clears the unread badge on the channel list. markChannelRead
    // never moves the marker backwards, so this only ever writes when there is
    // genuinely newer material.
    //
    // Mark up to the newest message's relay stamp, not "now": a device whose clock
    // runs behind the relay would otherwise write a marker older than the messages
    // it just showed and leave them unread.
    const newest = messages.length
        ? messages[messages.length - 1].createdAt
        : undefined;
    useEffect(() => {
        if (!vault || !channelId || !newest) return;
        // Empty channel -> nothing to mark. Marking "now" here was a feedback loop:
        // the marker always advanced, which bumped the revision, which reloaded the
        // (still empty) transcript, which re-ran this effect -- flickering the empty
        // state between "decrypting" and "no messages" forever.
        //
        // Depend on the stamp string, not the messages array: an equal reload
        // produces the same string, so it does not retrigger; only a genuinely
        // newer message does. Bump the shared revision when the marker advances so
        // the channel list recomputes its unread badge now rather than on the next
        // unrelated relay event.
        vault
            .markChannelRead(channelId, newest)
            .then((advanced) => {
                if (advanced) bumpRevision();
            })
            .catch(() => {});
    }, [vault, channelId, newest, bumpRevision]);

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
