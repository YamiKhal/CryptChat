interface ReactionBarProps {
  /** emoji -> senderIds. */
  reactions: Record<string, string[]>;
  selfId: string;
  /** Resolves a sender id to a display name for the tooltip. */
  nameFor: (userId: string) => string;
  onToggle: (emoji: string) => void;
}

/**
 * Reaction pills under a message.
 *
 * Each pill shows whether *you* reacted, because that is what makes it a toggle
 * rather than a counter -- without the distinction, clicking is a guess.
 */
export default function ReactionBar({ reactions, selfId, nameFor, onToggle }: ReactionBarProps) {
  const entries = Object.entries(reactions).filter(([, senders]) => senders.length > 0);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([emoji, senders]) => {
        const mine = senders.includes(selfId);
        // Names come from pinned contacts, so this is who we believe reacted --
        // and every reaction that got here had a verified signature.
        const who = senders.map(nameFor).join(', ');

        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            title={who}
            aria-label={`${emoji} from ${who}`}
            aria-pressed={mine}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]
              leading-none transition-colors
              ${
                mine
                  ? 'border-primary/50 bg-primary/15 text-primary'
                  : 'border-border bg-surface-raised text-muted hover:border-primary/30'
              }`}
          >
            <span className="text-xs leading-none">{emoji}</span>
            <span className="tabular-nums">{senders.length}</span>
          </button>
        );
      })}
    </div>
  );
}
