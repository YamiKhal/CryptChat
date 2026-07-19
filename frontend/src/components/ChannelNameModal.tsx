import { useState } from 'react';
import { StoredChannel } from '../lib/vault';

/** A channel name is a personal label -- it never leaves the device. */
export const MAX_CHANNEL_NAME = 60;

/**
 * Prompt for a channel name.
 *
 * Empty clears the label, reverting the channel to its default name ("Group", or
 * the peer's name for a DM). The name is local only: it lives in the encrypted
 * vault and is never sent to the server, so naming a channel tells no one else
 * anything.
 */
export function ChannelNameModal({
  channel,
  onClose,
  onSubmit,
}: {
  channel: StoredChannel;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(channel.label ?? '');

  function submit() {
    onSubmit(name);
    onClose();
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
        <p className="t-base text-muted">Name this channel</p>
        <input
          className="field"
          value={name}
          maxLength={MAX_CHANNEL_NAME}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="channel name"
          autoFocus
        />
        <p className="t-small text-muted">
          Only you see this name — it stays on this device and never reaches the server. Leave it
          empty to use the default name.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost t-base">
            cancel
          </button>
          <button onClick={submit} className="btn-primary t-base">
            save
          </button>
        </div>
      </div>
    </div>
  );
}
