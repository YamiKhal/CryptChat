import { RefObject, type ReactNode } from 'react';
import { incognitoHue } from '@/lib/incognito';
import { StoredMessage, Vault, Contact, StoredChannel, AccountDescriptor } from '@/lib/vault';
import { Limits } from '@/lib/limits';
import { MessageRow } from '@/pages/chat/components/MessageRow';
import { dayKey, dayLabel, GROUP_GAP_MS } from '@/pages/chat/utils';

type PresenceNotice = { id: string; text: string; at: string };
type ChatBackground = { url: string; isVideo: boolean };

/**
 * The scrolling transcript: messages and presence notices merged and ordered by
 * time, with day dividers, author grouping, and the premium chat wallpaper
 * rendered behind opaque bubbles.
 */
export function ChatTranscript({
  messages,
  presenceLog,
  loading,
  channel,
  channelId,
  account,
  vault,
  contacts,
  limits,
  messageIds,
  highlighted,
  chatBackground,
  nameFor,
  isVerified,
  onToggleReaction,
  onJumpToReply,
  onOpenMenu,
  onUnlock,
  bottomRef,
}: {
  messages: StoredMessage[];
  presenceLog: PresenceNotice[];
  loading: boolean;
  channel: StoredChannel;
  channelId: string;
  account: AccountDescriptor;
  vault: Vault;
  contacts: Record<string, Contact>;
  limits: Limits;
  messageIds: Set<string>;
  highlighted: string | null;
  chatBackground?: ChatBackground;
  nameFor: (userId: string) => string;
  isVerified: (userId: string) => boolean;
  onToggleReaction: (message: StoredMessage, emoji: string) => void;
  onJumpToReply: (id: string) => void;
  onOpenMenu: (message: StoredMessage, x: number, y: number) => void;
  onUnlock: (message: StoredMessage) => void;
  bottomRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div className="relative flex-1 min-h-0">
      {/* Video wallpaper: looped, scaled to fill, behind a scrim so the
          transcript stays legible. Image / GIF stays a CSS background on the
          scroll layer below. */}
      {chatBackground?.isVideo && (
        <>
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src={chatBackground.url}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
          />
          <div
            className="absolute inset-0"
            style={{ background: 'var(--wallpaper-scrim)' }}
            aria-hidden="true"
          />
        </>
      )}

      <div
        data-chat-size={vault.preferences.chatTextSize ?? 'normal'}
        data-chat-bubbles={vault.preferences.hideMessageBubbles ? 'hidden' : undefined}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden p-4 space-y-1 bg-cover bg-center"
        style={
          chatBackground && !chatBackground.isVideo
            ? {
                backgroundImage: `linear-gradient(var(--wallpaper-scrim), var(--wallpaper-scrim)), url(${chatBackground.url})`,
              }
            : undefined
        }
      >
        {loading && <p className="text-center t-base text-muted">decrypting…</p>}

        {!loading && messages.length === 0 && channel.hasKey && (
          <p className="text-center t-base text-muted">No messages yet.</p>
        )}

        {(() => {
          // Messages and presence notices, merged and ordered by time, so a
          // "someone left" sits exactly where it happened rather than always at
          // the bottom. A presence line also breaks message grouping, so the
          // next message shows its header again.
          const items = [
            ...messages.map((message) => ({ type: 'msg' as const, at: message.createdAt, message })),
            ...presenceLog.map((notice) => ({
              type: 'presence' as const,
              at: notice.at,
              id: notice.id,
              text: notice.text,
            })),
          ].sort((a, b) => a.at.localeCompare(b.at));

          let prevSenderId: string | null = null;
          let prevAt: string | null = null;
          let prevDay: string | null = null;

          return items.flatMap((item, i) => {
            const nodes: ReactNode[] = [];

            // Day divider at every local-midnight boundary. A new day also resets
            // grouping, so the first message of a day always shows its header.
            const day = dayKey(item.at);
            if (day !== prevDay) {
              prevDay = day;
              prevSenderId = null;
              prevAt = null;
              nodes.push(
                <div key={`day-${day}`} className="my-3 flex items-center gap-3 px-2">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full bg-surface-raised px-3 py-1 t-small font-medium text-muted">
                    {dayLabel(item.at)}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>,
              );
            }

            if (item.type === 'presence') {
              prevSenderId = null;
              prevAt = null;
              nodes.push(
                <div key={`p-${item.id}`} className="my-2 flex justify-center">
                  <span className="rounded-full bg-surface-raised px-3 py-1 t-small text-muted">
                    {item.text}
                  </span>
                </div>,
              );
              return nodes;
            }

            const message = item.message;
            const isSelf = message.senderId === account.userId;
            const contact = contacts[message.senderId];
            // Group with the previous bubble only for the same author AND within
            // the grouping window; a >=2min pause re-shows the name and time.
            const gap = prevAt
              ? new Date(message.createdAt).getTime() - new Date(prevAt).getTime()
              : Infinity;
            const grouped = prevSenderId === message.senderId && gap < GROUP_GAP_MS;
            prevSenderId = message.senderId;
            prevAt = message.createdAt;

            // Tail only on the last bubble of a run: show it unless the NEXT item
            // is another message from the same author, same day, within the window.
            const next = items[i + 1];
            const nextGroups =
              next?.type === 'msg' &&
              next.message.senderId === message.senderId &&
              dayKey(next.at) === dayKey(item.at) &&
              new Date(next.message.createdAt).getTime() - new Date(message.createdAt).getTime() <
                GROUP_GAP_MS;

            nodes.push(
              <MessageRow
                showTail={!nextGroups}
                key={message.id}
                message={message}
                isSelf={isSelf}
                grouped={grouped}
                avatar={isSelf ? vault.profile.avatar : contact?.avatar}
                keyChanged={Boolean(contact?.keyChangedAt)}
                supporter={
                  channel.incognito
                    ? false
                    : isSelf
                      ? Boolean(limits.premium)
                      : Boolean(message.supporterClaimed)
                }
                selfId={account.userId}
                nameFor={nameFor}
                messageIds={messageIds}
                highlighted={highlighted === message.id}
                onToggleReaction={(emoji) => onToggleReaction(message, emoji)}
                onJumpToReply={onJumpToReply}
                onOpenMenu={(x, y) => onOpenMenu(message, x, y)}
                onUnlock={message.locked ? () => onUnlock(message) : undefined}
                avatarColor={
                  channel.incognito ? incognitoHue(channelId, message.senderId) : undefined
                }
                nameOverride={channel.incognito ? nameFor(message.senderId) : undefined}
                senderTrusted={!channel.incognito && isVerified(message.senderId)}
                leftAligned={vault.preferences.messagesLeftAligned}
                hideAvatars={vault.preferences.hideProfileImages}
                hour12={vault.preferences.clock12h}
              />,
            );
            return nodes;
          });
        })()}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
