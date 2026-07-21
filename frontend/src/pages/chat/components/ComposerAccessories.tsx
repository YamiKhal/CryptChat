import { Lock, Timer, EyeOff } from 'lucide-react';
import { Attachment } from '@/lib/crypto';
import { TransferProgress } from '@/lib/blob';
import { formatBytes } from '@/lib/binary';
import { BURN_OPTIONS } from '@/pages/chat/utils';

/**
 * The stack of status bars between the transcript and the composer: upload
 * progress, pending attachments, a typing indicator, the armed-modifier chips
 * (lock / burn / spoiler), and the editing banner. Each is conditional; the
 * whole stack collapses to nothing on an idle composer.
 */
export function ComposerAccessories({
  upload,
  pending,
  onRemovePending,
  typingLabel,
  lockArmed,
  lockCode,
  burnTtl,
  spoilerArmed,
  editingId,
  onEditLock,
  onClearLock,
  onEditBurn,
  onClearBurn,
  onClearSpoiler,
  onCancelEdit,
}: {
  upload: TransferProgress | null;
  pending: Attachment[];
  onRemovePending: (blobId: string) => void;
  typingLabel: string | null;
  lockArmed: boolean;
  lockCode: string;
  burnTtl: number | null;
  spoilerArmed: boolean;
  editingId: string | null;
  onEditLock: () => void;
  onClearLock: () => void;
  onEditBurn: () => void;
  onClearBurn: () => void;
  onClearSpoiler: () => void;
  onCancelEdit: () => void;
}) {
  const uploadPct = upload
    ? Math.round((upload.loaded / Math.max(1, upload.total)) * 100)
    : 0;

  return (
    <>
      {upload && (
        <div className="border-t border-border px-4 py-2">
          <div className="flex items-center justify-between t-small text-muted">
            <span>encrypting &amp; uploading…</span>
            <span>{uploadPct}%</span>
          </div>
          <div className="mt-1 h-0.5 w-full bg-border">
            <div className="h-full bg-primary transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2 t-base">
          {pending.map((attachment) => (
            <span
              key={attachment.blobId}
              className="inline-flex items-center gap-1.5 rounded border border-primary-line
                         bg-primary-soft px-2 py-1"
            >
              <span className="max-w-40 truncate text-primary">{attachment.name}</span>
              <span className="text-muted">{formatBytes(attachment.size)}</span>
              <button
                onClick={() => onRemovePending(attachment.blobId)}
                className="text-muted hover:text-error"
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {typingLabel && (
        <div className="flex items-center gap-2 px-4 py-1 t-small text-muted">
          <span className="animate-pulse">{typingLabel}</span>
        </div>
      )}

      {/* Compact indicators for armed modifiers. Each opens its config again
          (lock / burn) and carries an ✕ to turn it off. The full configuration
          lives in the modals. */}
      {(lockArmed || burnTtl != null || spoilerArmed) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-primary-line bg-primary-soft px-4 py-1.5">
          {lockArmed && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2 py-0.5 t-small text-primary">
              <button onClick={onEditLock} className="inline-flex items-center gap-1" title="Edit lock">
                <Lock size={11} aria-hidden="true" />
                {lockCode.trim() ? 'Locked' : 'Lock — set a code'}
              </button>
              <button
                onClick={onClearLock}
                className="text-muted hover:text-error"
                aria-label="Turn off lock"
              >
                ×
              </button>
            </span>
          )}
          {burnTtl != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2 py-0.5 t-small text-primary">
              <button onClick={onEditBurn} className="inline-flex items-center gap-1" title="Edit timer">
                <Timer size={11} aria-hidden="true" />
                Disappears {BURN_OPTIONS.find((o) => o.ttl === burnTtl)?.label ?? ''}
              </button>
              <button
                onClick={onClearBurn}
                className="text-muted hover:text-error"
                aria-label="Turn off disappearing"
              >
                ×
              </button>
            </span>
          )}
          {spoilerArmed && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2 py-0.5 t-small text-primary">
              <EyeOff size={11} aria-hidden="true" />
              Spoiler
              <button
                onClick={onClearSpoiler}
                className="text-muted hover:text-error"
                aria-label="Turn off spoiler"
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}

      {editingId && (
        <div className="flex items-center justify-between border-t border-primary-line bg-primary-soft px-4 py-1.5 t-small">
          <span className="text-primary">Editing message</span>
          <button onClick={onCancelEdit} className="text-muted hover:text-error">
            cancel
          </button>
        </div>
      )}
    </>
  );
}
