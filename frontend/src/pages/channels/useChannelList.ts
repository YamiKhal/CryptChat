import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { Vault, StoredChannel } from "@/lib/vault";

/**
 * The channel list and its live upkeep: the local channel array, per-channel
 * unread counts, the premium flag (which gates the incognito toggle) and the
 * reconcile against server membership. Returns the data plus `reload`, which the
 * page's mutations call after a local vault write.
 */
export function useChannelList(
    vault: Vault | null,
    token: string | null,
    revision: number,
) {
    const [channels, setChannels] = useState<StoredChannel[]>([]);
    const [unread, setUnread] = useState<Record<string, number>>({});
    const [premium, setPremium] = useState(false);

    const reload = useCallback(() => {
        if (!vault) return;
        setChannels(vault.listChannels());
    }, [vault]);

    useEffect(reload, [reload, revision]);

    // Premium gates offering the incognito toggle
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        api.limits(token)
            .then((res) => !cancelled && setPremium(Boolean(res.premium)))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [token]);

    // Unread badges
    useEffect(() => {
        if (!vault) return;
        let cancelled = false;
        (async () => {
            const counts: Record<string, number> = {};
            for (const channel of vault.listChannels()) {
                counts[channel.channelId] = await vault.unreadCount(
                    channel.channelId,
                );
            }
            if (!cancelled) setUnread(counts);
        })();
        return () => {
            cancelled = true;
        };
    }, [vault, revision]);

    // Reconcile local channels against server membership
    useEffect(() => {
        if (!vault || !token) return;
        let cancelled = false;

        api.listChannels(token)
            .then(async ({ channels: remote }) => {
                if (cancelled) return;
                let changed = false;

                for (const summary of remote) {
                    const dmType = summary.type === "dm" ? "dm" : undefined;
                    const local = vault.getChannel(summary.channelId);
                    if (!local) {
                        await vault.saveChannel({
                            channelId: summary.channelId,
                            code: summary.code,
                            key: "",
                            hasKey: false,
                            incognito: summary.incognito,
                            type: dmType,
                            peerId: summary.peerId,
                            blocked: summary.blocked,
                            request: summary.request,
                            joinedAt: summary.joinedAt,
                        });
                        changed = true;
                    } else if (
                        local.code !== summary.code ||
                        local.incognito !== summary.incognito ||
                        local.type !== dmType ||
                        local.peerId !== summary.peerId ||
                        Boolean(local.blocked) !== Boolean(summary.blocked) ||
                        Boolean(local.request) !== Boolean(summary.request)
                    ) {
                        await vault.saveChannel({
                            ...local,
                            code: summary.code,
                            incognito: summary.incognito,
                            type: dmType,
                            peerId: summary.peerId,
                            blocked: summary.blocked,
                            request: summary.request,
                        });
                        changed = true;
                    }
                }

                if (changed) reload();
            })
            .catch(() => {
                // Offline
            });

        return () => {
            cancelled = true;
        };
    }, [vault, token, reload, revision]);

    return { channels, unread, premium, reload };
}
