import { Folder } from "lucide-react";
import Avatar from "@/components/ui/Avatar";
import { StoredChannel } from "@/lib/vault";
import { BinaryAsset } from "@/lib/binary";

/**
 * The picture shown for a channel in the list and the chat header.
 *
 *  - DM: the peer's own profile avatar (or their initial), so each side sees the
 *    other. DMs cannot set a custom picture -- it always tracks the peer.
 *  - Group with a picture: the locally-set icon.
 *  - Group without one: a neutral folder, never initials -- a group has no single
 *    person to letter.
 */

const BOX: Record<"sm" | "md" | "lg", string> = {
    sm: "h-6 w-6",
    md: "h-8 w-8",
    lg: "h-20 w-20",
};

const GLYPH: Record<"sm" | "md" | "lg", number> = { sm: 13, md: 16, lg: 34 };

export function ChannelIcon({
    channel,
    peerName,
    peerAvatar,
    size = "md",
}: {
    channel: StoredChannel;
    peerName?: string;
    peerAvatar?: BinaryAsset;
    size?: "sm" | "md" | "lg";
}) {
    if (channel.type === "dm") {
        return (
            <Avatar
                asset={peerAvatar}
                name={peerName || "direct message"}
                size={size}
            />
        );
    }

    if (channel.icon) {
        return (
            <Avatar
                asset={channel.icon}
                name={channel.label || "Group"}
                size={size}
            />
        );
    }

    return (
        <div
            className={`${BOX[size]} border-border bg-surface-raised text-muted grid shrink-0 place-items-center rounded-full border`}
            aria-hidden
        >
            <Folder size={GLYPH[size]} />
        </div>
    );
}
