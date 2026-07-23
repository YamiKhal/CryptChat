import { Link } from "react-router-dom";
import { ArrowLeft, Phone, Video, LogOut } from "lucide-react";
import { StoredChannel, Vault } from "@/lib/vault";
import { Limits } from "@/lib/limits";
import { ChannelIcon } from "@/components/channel/ChannelIcon";

/**
 * The chat's top bar: back link, channel identity (which opens the channel menu
 * on click / long-press), call buttons for an unblocked DM and leave.
 */
export function ChatHeader({
    channel,
    vault,
    isDm,
    dmBlocked,
    connected,
    limits,
    nameFor,
    headerHandlers,
    onOpenMenu,
    onStartCall,
    onLeave,
}: {
    channel: StoredChannel;
    vault: Vault;
    isDm: boolean;
    dmBlocked: boolean;
    connected: boolean;
    limits: Limits;
    nameFor: (userId: string) => string;
    headerHandlers: React.HTMLAttributes<HTMLButtonElement>;
    onOpenMenu: (x: number, y: number) => void;
    onStartCall: (kind: "audio" | "video") => void;
    onLeave: () => void;
}) {
    return (
        <header className="border-border bg-surface flex h-14.25 shrink-0 items-center gap-3 border-b px-4">
            <Link
                to="/channels"
                className="text-muted hover:bg-surface-raised hover:text-primary -ml-1 rounded-lg p-1.5 transition-colors lg:hidden"
                aria-label="Back to channels"
            >
                <ArrowLeft size={18} />
            </Link>
            {/* Clicking (or right-click / long-press) the icon or name opens the
          channel menu: copy code, rename, set a picture, block, leave. */}
            <button
                onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onOpenMenu(r.left, r.bottom + 4);
                }}
                {...headerHandlers}
                className="hover:bg-surface-raised -mx-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 py-1 text-left transition-colors"
                title="Channel options"
            >
                <ChannelIcon
                    channel={channel}
                    peerName={
                        channel.peerId ? nameFor(channel.peerId) : undefined
                    }
                    peerAvatar={
                        channel.peerId
                            ? vault.getContact(channel.peerId)?.avatar
                            : undefined
                    }
                    size="md"
                />
                <div className="min-w-0">
                    <p className="t-h4 text-foreground truncate font-medium">
                        {isDm
                            ? channel.peerId
                                ? nameFor(channel.peerId)
                                : "direct message"
                            : channel.label || "Group"}
                    </p>
                    <p className="t-small text-muted flex items-center gap-1.5">
                        <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-primary" : "bg-warn"}`}
                        />
                        {connected ? "encrypted" : "reconnecting…"}
                        {isDm && (
                            <span className="tag bg-primary-soft text-primary">
                                direct
                            </span>
                        )}
                        {channel.incognito && (
                            <span className="tag bg-secondary-soft text-secondary">
                                incognito
                            </span>
                        )}
                    </p>
                </div>
            </button>

            {isDm && channel.hasKey && !dmBlocked && (
                <>
                    <button
                        onClick={() => onStartCall("audio")}
                        className="icon-btn flex-none"
                        title="Voice call"
                        aria-label="Voice call"
                    >
                        <Phone size={18} />
                    </button>
                    <button
                        onClick={() => onStartCall("video")}
                        className="icon-btn flex-none"
                        title={
                            limits.premium
                                ? "Video call"
                                : "Video calling is a supporter feature"
                        }
                        aria-label="Video call"
                    >
                        <Video size={18} />
                    </button>
                </>
            )}

            <button
                onClick={onLeave}
                className="text-muted hover:bg-error-soft hover:text-error flex-none rounded-lg p-2 transition-colors"
                title="Leave"
                aria-label="Leave channel"
            >
                <LogOut size={18} />
            </button>
        </header>
    );
}
