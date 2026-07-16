import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { StoredMessage } from '../lib/vault';
import { fileToAsset, BinaryAsset } from '../lib/binary';
import { api } from '../lib/api';
import MessageBubble from '../components/MessageBubble';

export default function Chat() {
  const { channelId } = useParams<{ channelId: string }>();
  const { vault, token, account } = useSession();
  const { send, broadcastProfile, connected, revision } = useRelayContext();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [pendingAsset, setPendingAsset] = useState<BinaryAsset | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const announced = useRef<string | null>(null);

  const channel = channelId && vault ? vault.getChannel(channelId) : undefined;

  // Load the decrypted transcript for this channel. Messages are stored per
  // channel inside the vault, so opening a channel is one secretbox open.
  useEffect(() => {
    if (!vault || !channelId) return;
    let cancelled = false;

    setLoading(true);
    vault.loadMessages(channelId).then((loaded) => {
      if (cancelled) return;
      setMessages(loaded);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [vault, channelId, revision]);

  // Announce our display name and avatar once per channel, once we hold a key.
  // Peers cannot render a name they were never sent -- the server has none to
  // give them.
  useEffect(() => {
    if (!channelId || !channel?.hasKey || !connected) return;
    if (announced.current === channelId) return;
    announced.current = channelId;
    broadcastProfile(channelId).catch(() => {});
  }, [channelId, channel?.hasKey, connected, broadcastProfile]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    if (!channelId || (!text.trim() && !pendingAsset)) return;
    setError('');
    try {
      const message = await send(channelId, {
        body: text.trim(),
        asset: pendingAsset ?? undefined,
      });
      if (message) setMessages((current) => [...current, message]);
      setText('');
      setPendingAsset(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [channelId, text, pendingAsset, send]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      // Re-encoded through a canvas: strips EXIF (GPS, device serial) and
      // normalises the bytes before they are sealed into the envelope.
      setPendingAsset(await fileToAsset(file, { maxDimension: 1024, mime: 'image/webp' }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleLeave() {
    if (!channelId || !vault || !token) return;
    if (!confirm('Leave this channel? Its key and local messages are deleted from this device.')) {
      return;
    }
    await api.leaveChannel(token, channelId).catch(() => {});
    await vault.removeChannel(channelId);
    navigate('/channels');
  }

  const contacts = useMemo(() => {
    if (!vault) return {};
    return vault.snapshot().contacts;
  }, [vault, revision]);

  if (!vault || !account) return null;

  if (!channel) {
    return (
      <div className="min-h-screen grid place-items-center p-4 text-center">
        <div className="card max-w-sm space-y-3">
          <p className="text-sm">This channel is not on this device.</p>
          <Link to="/channels" className="btn-ghost">
            Back to channels
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-screen max-w-md flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <Link to="/channels" className="text-muted transition-colors hover:text-primary">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm tracking-widest text-primary">{channel.code || '········'}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-warn'}`}
            />
            {connected ? 'encrypted' : 'reconnecting…'}
          </p>
        </div>
        <button onClick={handleLeave} className="btn-ghost px-2 py-1 text-[11px]">
          leave
        </button>
      </header>

      {!channel.hasKey && (
        <div className="border-b border-warn/30 bg-warn/10 px-4 py-3 text-xs text-warn">
          <p className="font-medium">Waiting for the channel key</p>
          <p className="mt-1 text-warn/80">
            Nobody has sent it yet. A member who is online will pass it to you automatically — the
            server cannot, because it has never held it. Messages sent meanwhile stay queued and
            unreadable until the key arrives.
          </p>
        </div>
      )}

      <div className="flex-1 space-y-1 overflow-y-auto p-4">
        {loading && <p className="text-center text-xs text-muted">decrypting…</p>}

        {!loading && messages.length === 0 && channel.hasKey && (
          <p className="text-center text-xs text-muted">No messages yet.</p>
        )}

        {messages.map((message, index) => {
          const isSelf = message.senderId === account.userId;
          const contact = contacts[message.senderId];
          const previous = messages[index - 1];
          // Collapse the header on consecutive messages from the same person.
          const grouped = previous?.senderId === message.senderId;

          return (
            <MessageBubble
              key={message.id}
              message={message}
              isSelf={isSelf}
              grouped={grouped}
              avatar={isSelf ? vault.profile.avatar : contact?.avatar}
              keyChanged={Boolean(contact?.keyChangedAt)}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="border-t border-error/30 bg-error/10 px-4 py-2 text-xs text-error">{error}</p>}

      {pendingAsset && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs">
          <span className="tag bg-secondary/10 text-secondary">image ready</span>
          <button onClick={() => setPendingAsset(null)} className="text-muted hover:text-error">
            remove
          </button>
        </div>
      )}

      <div className="flex gap-2 border-t border-border bg-surface p-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!channel.hasKey}
          className="btn-ghost px-3"
          title="Attach image"
        >
          +
        </button>
        <input
          className="field flex-1"
          value={text}
          disabled={!channel.hasKey}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder={channel.hasKey ? 'message' : 'waiting for key…'}
        />
        <button
          onClick={handleSend}
          disabled={!channel.hasKey || (!text.trim() && !pendingAsset)}
          className="btn-primary"
        >
          Send
        </button>
      </div>
    </div>
  );
}
