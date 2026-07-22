/**
 * A minimal notifier for "this account's at-rest data just changed".
 *
 * The Vault fires this after every write (a channel/contact/profile/preference
 * flush, or a message save). The premium auto-backup layer subscribes so it can
 * debounce a fresh copy to disk. Kept out of the Vault itself so the vault has
 * no dependency on the backup feature -- it only announces that it changed.
 *
 * Deliberately NOT emitted by the low-level storage writes: a restore/import
 * writes sealed bytes too, and re-backing-up mid-restore would be pointless
 * churn. Only user-driven vault mutations emit.
 */

type Listener = (userId: string) => void;

const listeners = new Set<Listener>();

export function onVaultChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function emitVaultChange(userId: string): void {
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      // A misbehaving subscriber must not break the write that triggered it.
    }
  }
}
