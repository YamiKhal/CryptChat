import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { StoredMessage } from '@/lib/vault';

/**
 * Prompt for a code to unlock a password-protected message.
 *
 * The code is checked by trying to decrypt -- a wrong one fails secretbox
 * authentication and reveals nothing. The plaintext only ever lands in this
 * user's own vault; another member unlocking the same message uses their own
 * copy and their own code.
 */
export function UnlockModal({
  message,
  onClose,
  onSubmit,
}: {
  message: StoredMessage;
  onClose: () => void;
  onSubmit: (message: StoredMessage, code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(message, code.trim());
      onClose();
    } catch {
      setError('wrong code');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="flex items-center gap-1.5 t-base text-muted">
          <LockKeyhole size={13} aria-hidden="true" />
          Enter the code for this message
        </p>
        {message.locked?.hint && (
          <p className="t-small italic text-muted">hint: {message.locked.hint}</p>
        )}
        <input
          className="field"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="code"
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus
        />
        {error && <p className="t-small text-error">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost flex-1 t-base">
            cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !code.trim()}
            className="btn-primary flex-1 t-base"
          >
            unlock
          </button>
        </div>
      </div>
    </div>
  );
}
