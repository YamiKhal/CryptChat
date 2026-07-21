import { useEffect } from 'react';
import { StoredMessage } from '@/lib/vault';
import { BinaryAsset } from '@/lib/binary';
import MessageBubble from '@/components/chat/MessageBubble';
import { useContextMenu } from '@/components/ui/ContextMenu';

/**
 * One message plus its context-menu wiring.
 *
 * Split out because `useContextMenu` is a hook and cannot be called inside the
 * transcript's map(). Each row owns its own press-tracking state, which is also
 * what keeps a long-press on one message from arming another.
 */
export function MessageRow({
  message,
  isSelf,
  grouped,
  avatar,
  keyChanged,
  supporter,
  selfId,
  nameFor,
  messageIds,
  highlighted,
  onToggleReaction,
  onJumpToReply,
  onOpenMenu,
  avatarColor,
  nameOverride,
  senderTrusted,
  leftAligned,
  hideAvatars,
  showTail,
  hour12,
}: {
  message: StoredMessage;
  isSelf: boolean;
  grouped: boolean;
  showTail: boolean;
  avatar?: BinaryAsset;
  keyChanged: boolean;
  supporter: boolean;
  selfId: string;
  nameFor: (userId: string) => string;
  messageIds: Set<string>;
  highlighted: boolean;
  onToggleReaction: (emoji: string) => void;
  onJumpToReply: (id: string) => void;
  onOpenMenu: (x: number, y: number) => void;
  avatarColor?: number;
  nameOverride?: string;
  senderTrusted?: boolean;
  leftAligned?: boolean;
  hideAvatars?: boolean;
  hour12?: boolean;
}) {
  const { handlers, position, close } = useContextMenu();

  // Lift the position up to the page, which owns the single open menu. Two rows
  // must never render menus at once.
  useEffect(() => {
    if (position) {
      onOpenMenu(position.x, position.y);
      close();
    }
  }, [position, onOpenMenu, close]);

  return (
    <MessageBubble
      message={message}
      isSelf={isSelf}
      grouped={grouped}
      avatar={avatar}
      keyChanged={keyChanged}
      supporter={supporter}
      selfId={selfId}
      nameFor={nameFor}
      onToggleReaction={onToggleReaction}
      onJumpToReply={onJumpToReply}
      replyTargetExists={message.replyTo ? messageIds.has(message.replyTo.id) : false}
      contextHandlers={handlers}
      highlighted={highlighted}
      avatarColor={avatarColor}
      nameOverride={nameOverride}
      senderTrusted={senderTrusted}
      leftAligned={leftAligned}
      hideAvatars={hideAvatars}
      showTail={showTail}
      hour12={hour12}
    />
  );
}
