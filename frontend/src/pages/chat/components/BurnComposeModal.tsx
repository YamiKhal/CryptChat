import { useState } from 'react';
import { Timer } from 'lucide-react';
import { BURN_OPTIONS } from '@/pages/chat/utils';

/**
 * Configure the disappearing-message timer for the next message.
 *
 * Like the lock modal, the pick is a draft: choosing a duration highlights it but
 * does not arm the timer until "Set timer" is pressed. Backdrop / "Cancel"
 * discards, so an accidental open leaves the message untouched.
 */
export function BurnComposeModal({
  initialTtl,
  armed,
  onConfirm,
  onDisable,
  onClose,
}: {
  initialTtl: number | null;
  /** Whether a timer is already armed (so the modal was opened to edit it). */
  armed: boolean;
  onConfirm: (ttl: number) => void;
  onDisable: () => void;
  onClose: () => void;
}) {
  const [ttl, setTtl] = useState<number>(initialTtl ?? 30);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="flex items-center gap-1.5 t-h4 font-medium">
          <Timer size={14} className="text-primary" aria-hidden="true" />
          Disappearing message
        </p>
        <div className="flex flex-wrap gap-1.5">
          {BURN_OPTIONS.map((o) => (
            <button
              key={o.ttl}
              onClick={() => setTtl(o.ttl)}
              className={`rounded px-3 py-1 t-base ${
                ttl === o.ttl
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="t-small text-muted">
          Removed from both sides after the timer, on cooperating clients. It cannot stop a
          screenshot or a photo of the screen.
        </p>
        <div className="flex gap-2">
          <button onClick={armed ? onDisable : onClose} className="btn-ghost flex-1 t-base">
            {armed ? 'Turn off' : 'Cancel'}
          </button>
          <button onClick={() => onConfirm(ttl)} className="btn-primary flex-1 t-base">
            Set timer
          </button>
        </div>
      </div>
    </div>
  );
}
