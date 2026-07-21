import { Link } from 'react-router-dom';
import { Phone, Video, LogOut } from 'lucide-react';
import { StoredChannel, Vault } from '@/lib/vault';
import { Limits } from '@/lib/limits';
import { ChannelIcon } from '@/components/channel/ChannelIcon';

/**
 * The chat's top bar: back link, channel identity (which opens the channel menu
 * on click / long-press), call buttons for an unblocked DM, and leave.
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
  onStartCall: (kind: 'audio' | 'video') => void;
  onLeave: () => void;
}) {
  return (
    <header className="flex h-14.25 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <Link
        to="/channels"
        className="text-muted transition-colors hover:text-primary lg:hidden"
        aria-label="Back to channels"
      >
        ←
      </Link>
      {/* Clicking (or right-click / long-press) the icon or name opens the
          channel menu: copy code, rename, set a picture, block, leave. */}
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onOpenMenu(r.left, r.bottom + 4);
        }}
        {...headerHandlers}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title="Channel options"
      >
        <ChannelIcon
          channel={channel}
          peerName={channel.peerId ? nameFor(channel.peerId) : undefined}
          peerAvatar={channel.peerId ? vault.getContact(channel.peerId)?.avatar : undefined}
          size="md"
        />
        <div className="min-w-0">
          <p className="truncate t-h4 font-medium text-foreground">
            {isDm
              ? channel.peerId
                ? nameFor(channel.peerId)
                : 'direct message'
              : channel.label || 'Group'}
          </p>
          <p className="flex items-center gap-1.5 t-small text-muted">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-warn'}`}
            />
            {connected ? 'encrypted' : 'reconnecting…'}
            {isDm && <span className="tag bg-primary-soft text-primary">direct</span>}
            {channel.incognito && (
              <span className="tag bg-secondary-soft text-secondary">incognito</span>
            )}
          </p>
        </div>
      </button>

      {isDm && channel.hasKey && !dmBlocked && (
        <>
          <button
            onClick={() => onStartCall('audio')}
            className="text-muted transition-colors hover:text-primary cursor-pointer p-2"
            title="Voice call"
            aria-label="Voice call"
          >
            <Phone size={18} />
          </button>
          <button
            onClick={() => onStartCall('video')}
            className="text-muted transition-colors hover:text-primary cursor-pointer p-2"
            title={limits.premium ? 'Video call' : 'Video calling is a supporter feature'}
            aria-label="Video call"
          >
            <Video size={18} />
          </button>
        </>
      )}

      <button
        onClick={onLeave}
        className="text-muted transition-colors hover:text-primary cursor-pointer p-2"
        title="Leave"
        aria-label="Leave channel"
      >
        <LogOut size={18} />
      </button>
    </header>
  );
}
