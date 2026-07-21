import { useEffect } from 'react';
import { LogOut } from 'lucide-react';

/**
 * Confirmation before logging out.
 *
 * Logging out is reversible -- keys stay on the device -- but it drops the
 * session and sends you back to the unlock screen, so it should never fire from
 * a single stray click. Escape or a backdrop click cancels; only the explicit
 * button confirms.
 */
export function LogoutConfirmModal({
  onConfirm,
  onClose,
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="logout-title"
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 flex-none place-items-center rounded-full bg-error-soft text-error">
            <LogOut size={18} />
          </div>
          <div className="min-w-0">
            <h2 id="logout-title" className="t-h4 font-semibold">
              Log out?
            </h2>
            <p className="t-base text-muted">You'll sign back in with your password.</p>
          </div>
        </div>

        <p className="t-base text-muted">
          Your keys stay on this device — logging out does not erase them. To wipe this identity
          entirely, use the danger zone instead.
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost t-base">
            Cancel
          </button>
          <button onClick={onConfirm} className="btn-danger t-base" autoFocus>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
