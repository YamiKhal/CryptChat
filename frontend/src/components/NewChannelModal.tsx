import { useState } from 'react';
import { Plus, LogIn, ArrowLeft } from 'lucide-react';
import { MAX_CHANNEL_NAME } from './ChannelNameModal';

type Mode = 'choice' | 'create' | 'join';

/**
 * Start a channel: create a new one or join an existing one by code.
 *
 * A single entry point behind the "+" on the channel list. It opens on a
 * two-way choice; picking one swaps the body to that form, and a back arrow
 * returns to the choice. Clicking the backdrop closes the whole thing.
 *
 * The actual work (mint a key, call the API) stays in the Channels page -- this
 * only gathers input and hands it back, so the page keeps owning busy/error and
 * the navigation that follows a success.
 */
export function NewChannelModal({
  premium,
  busy,
  error,
  onCreate,
  onJoin,
  onClose,
}: {
  premium: boolean;
  busy: boolean;
  error: string;
  onCreate: (name: string, incognito: boolean) => void;
  onJoin: (code: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('choice');
  const [name, setName] = useState('');
  const [incognito, setIncognito] = useState(false);
  const [code, setCode] = useState('');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          {mode !== 'choice' && (
            <button
              onClick={() => setMode('choice')}
              className="text-muted transition-colors hover:text-primary"
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <p className="text-sm font-medium">
            {mode === 'choice' ? 'New channel' : mode === 'create' ? 'Create a channel' : 'Join a channel'}
          </p>
        </div>

        {mode === 'choice' && (
          <div className="space-y-2">
            <button onClick={() => setMode('create')} className="btn-ghost w-full justify-start">
              <Plus size={16} />
              Create a channel
            </button>
            <button onClick={() => setMode('join')} className="btn-ghost w-full justify-start">
              <LogIn size={16} />
              Join with a code
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="space-y-3">
            <input
              className="field w-full"
              placeholder="channel name (optional)"
              maxLength={MAX_CHANNEL_NAME}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && onCreate(name, incognito)}
            />

            {premium && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={incognito}
                  onChange={(e) => setIncognito(e.target.checked)}
                />
                <span className="text-[11px]">
                  Incognito
                  <span className="mt-0.5 block text-muted">
                    Members appear as colours only — no names or avatars are shown or sent, and
                    colours are per-channel. This hides who's who in the interface; the server still
                    routes by membership, so it is not anonymity from a determined member.
                  </span>
                </span>
              </label>
            )}

            <button
              onClick={() => onCreate(name, incognito)}
              disabled={busy}
              className="btn-primary w-full"
            >
              Create {incognito ? 'incognito ' : ''}channel
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="space-y-3">
            <input
              className="field w-full font-mono uppercase tracking-widest"
              placeholder="XXXXXXXX"
              maxLength={8}
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && !busy && code.trim() && onJoin(code)}
            />
            <button
              onClick={() => onJoin(code)}
              disabled={busy || !code.trim()}
              className="btn-primary w-full"
            >
              Join channel
            </button>
          </div>
        )}

        {error && <p className="text-[11px] text-error">{error}</p>}
      </div>
    </div>
  );
}
