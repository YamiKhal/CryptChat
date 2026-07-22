import { useEffect, useRef } from "react";
import { Check, X, Key } from "lucide-react";
import { StoredChannel } from "@/lib/vault";
import { BinaryAsset } from "@/lib/binary";
import { useContextMenu } from "@/components/ui/ContextMenu";
import { ChannelIcon } from "@/components/channel/ChannelIcon";

export function ChannelRow({
    channel,
    peerName,
    peerAvatar,
    unread,
    active,
    onOpen,
    onOpenMenu,
    onAccept,
    onDecline,
}: {
    channel: StoredChannel;
    peerName?: string;
    peerAvatar?: BinaryAsset;
    unread: number;
    active?: boolean;
    onOpen: () => void;
    onOpenMenu: (x: number, y: number) => void;
    onAccept: () => void;
    onDecline: () => void;
}) {
    const { handlers, position, close } = useContextMenu();
    const pointerType = useRef("mouse");
    const swallowClick = useRef(false);

    useEffect(() => {
        if (position) {
            if (pointerType.current !== "mouse") swallowClick.current = true;
            onOpenMenu(position.x, position.y);
            close();
        }
    }, [position, onOpenMenu, close]);

    const isDm = channel.type === "dm";
    const title = isDm
        ? peerName || "direct message"
        : channel.label || "Group";
    const request = Boolean(channel.request);

    return (
        // Discord-style row: no card border, just a rounded fill that lights on
        // hover. The active channel gets a solid tinted fill plus a pill on the
        // left edge (the parent list is relative-positioned rail via px-2).
        <div
            className={`group relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150 ${
                active
                    ? "bg-primary-soft"
                    : "hover:bg-surface-raised"
            }`}
        >
            <span
                aria-hidden="true"
                className={`absolute top-1/2 -left-2 h-0 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 ${
                    active
                        ? "h-8"
                        : "group-hover:h-4"
                }`}
            />
            <button
                onPointerDownCapture={(e) => {
                    pointerType.current = e.pointerType;
                }}
                onClick={() => {
                    if (swallowClick.current) {
                        swallowClick.current = false;
                        return;
                    }
                    if (request) return; // nothing to open until accepted
                    onOpen();
                }}
                {...handlers}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
            >
                <div className="relative">
                    <ChannelIcon
                        channel={channel}
                        peerName={peerName}
                        peerAvatar={peerAvatar}
                        size="md"
                    />
                    {unread > 0 && (
                        <span
                            className="bg-error t-small absolute -bottom-1 left-4 inline-flex min-w-5 flex-none items-center justify-center rounded-full px-0.5 py-0.5 font-semibold text-white"
                            aria-label={`${unread} unread`}
                        >
                            {unread > 99 ? "99+" : unread}
                        </span>
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="t-h4 text-foreground truncate font-medium">
                        {title}
                    </p>
                    {request ? (
                        <p className="t-small text-primary">
                            wants to message you
                        </p>
                    ) : (
                        <p className="t-small text-muted flex items-center gap-1.5">
                            joined{" "}
                            {new Date(channel.joinedAt).toLocaleDateString()}
                        </p>
                    )}
                </div>
            </button>

            {request ? (
                <div className="flex flex-none items-center gap-1.5">
                    <button
                        onClick={onAccept}
                        title="Accept"
                        aria-label="Accept message request"
                        className="text-ok hover:bg-ok-soft rounded-full p-1.5 transition-colors"
                    >
                        <Check size={18} />
                    </button>
                    <button
                        onClick={onDecline}
                        title="Decline"
                        aria-label="Decline message request"
                        className="text-error hover:bg-error-soft rounded-full p-1.5 transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>
            ) : (
                <>
                    {isDm && (
                        <span className="tag bg-primary-soft text-primary">
                            direct
                        </span>
                    )}
                    {channel.blocked && (
                        <span className="tag bg-error-soft text-error">
                            blocked
                        </span>
                    )}
                    {channel.incognito && (
                        <span className="tag bg-secondary-soft text-secondary">
                            incognito
                        </span>
                    )}
                    {!channel.hasKey && (
                        <span
                            className="tag bg-warn-soft text-warn flex-none animate-pulse"
                            title="Waiting for the channel key"
                        >
                            <Key size={14} />
                        </span>
                    )}
                </>
            )}
        </div>
    );
}
