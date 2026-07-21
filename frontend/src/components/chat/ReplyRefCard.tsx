import { Image as ImageIcon, File as FileIcon, CornerUpLeft, X } from 'lucide-react';
import { ReplyRef } from '@/lib/crypto';

/**
 * The "replying to …" line.
 *
 * The excerpt shown here is the *replier's* signed snapshot of the original, not
 * a live lookup (see ReplyRef in crypto.ts). That means it is a quote attributed
 * to the replier, and it is rendered as one -- muted, clipped, never styled to
 * look like authoritative text from the original author.
 */

function KindIcon({ kind }: { kind: ReplyRef['kind'] }) {
  if (kind === 'image') return <ImageIcon size={11} aria-hidden="true" />;
  if (kind === 'file') return <FileIcon size={11} aria-hidden="true" />;
  return null;
}

function label(reply: ReplyRef): string {
  if (reply.excerpt) return reply.excerpt;
  if (reply.kind === 'image') return 'image';
  if (reply.kind === 'file') return 'file';
  return 'message';
}

interface ReplyRefCardProps {
  reply: ReplyRef;
  /** Fires when the quote is clicked. Undefined = not clickable. */
  onJump?: () => void;
  /** True when the target is not in this device's transcript. */
  missing?: boolean;
}

/** Rendered inside a message bubble, above the body. */
export function ReplyQuote({ reply, onJump, missing }: ReplyRefCardProps) {
  return (
    <button
      type="button"
      onClick={onJump}
      disabled={missing}
      title={missing ? 'The original is not on this device' : 'Jump to message'}
      className={`mb-1 flex w-full items-center gap-1.5 rounded border-l-2 border-primary
                  bg-primary-soft px-2 py-1 text-left t-small transition-colors
                  ${missing ? 'cursor-default' : 'hover:border-primary-strong'}`}
    >
      <span className="flex-none font-medium text-primary">{reply.displayName}</span>
      <KindIcon kind={reply.kind} />
      <span className="truncate text-muted">{label(reply)}</span>
    </button>
  );
}

/** Rendered above the composer while a reply is being written. */
export function ReplyComposing({ reply, onCancel }: { reply: ReplyRef; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-surface px-4 py-2">
      <CornerUpLeft size={12} className="flex-none text-primary" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 t-small">
        <span className="flex-none text-muted">replying to</span>
        <span className="flex-none font-medium text-primary">{reply.displayName}</span>
        <KindIcon kind={reply.kind} />
        <span className="truncate text-muted">{label(reply)}</span>
      </div>
      <button
        onClick={onCancel}
        className="flex-none text-muted transition-colors hover:text-error"
        aria-label="Cancel reply"
      >
        <X size={14} />
      </button>
    </div>
  );
}
