import { useState } from 'react';
import { Lock } from 'lucide-react';

/**
 * Configure the password lock for the next message.
 *
 * Nothing is armed until "Lock message" is pressed: the code and hint are draft
 * state held here, seeded from any existing armed lock so the chip can reopen and
 * edit it. Backdrop click or "Cancel" discards the draft and leaves the message
 * as it was -- opening this by mistake never locks anything. "Turn off lock"
 * (shown only when a lock is already armed) clears it. The code never leaves the
 * device -- it is what recipients type to decrypt this one message.
 */
export function LockComposeModal({
  initialCode,
  initialHint,
  armed,
  onConfirm,
  onDisable,
  onClose,
}: {
  initialCode: string;
  initialHint: string;
  /** Whether a lock is already armed (so the modal was opened to edit it). */
  armed: boolean;
  onConfirm: (code: string, hint: string) => void;
  onDisable: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [hint, setHint] = useState(initialHint);

  function confirm() {
    if (!code.trim()) return;
    onConfirm(code.trim(), hint.trim());
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
    >
      <div
        className="modal-panel max-w-xs space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="flex items-center gap-1.5 t-h4 font-medium">
          <Lock size={14} className="text-primary" aria-hidden="true" />
          Password-protect message
        </p>
        <input
          className="field t-h4"
          placeholder="code recipients must enter"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
          autoComplete="off"
          autoFocus
        />
        <input
          className="field t-h4"
          placeholder="hint (optional, shown before unlocking)"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          maxLength={140}
          autoComplete="off"
        />
        <p className="t-small text-muted">
          Share the code another way. It never reaches our servers and cannot be recovered — without
          it, the message stays locked. This guards against a glance over the shoulder, not against
          someone who already has the message.
        </p>
        <div className="flex gap-2">
          <button onClick={armed ? onDisable : onClose} className="btn-ghost flex-1 t-base">
            {armed ? 'Turn off lock' : 'Cancel'}
          </button>
          <button onClick={confirm} disabled={!code.trim()} className="btn-primary flex-1 t-base">
            Lock message
          </button>
        </div>
      </div>
    </div>
  );
}
