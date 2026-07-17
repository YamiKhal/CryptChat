import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { StoredMessage } from '../lib/vault';
import {
  formatBytes,
  base64ToBytes,
  bytesToBase64Url,
  encodeImage,
  packAsset,
  sniffImageMime,
} from '../lib/binary';
import { Attachment, LinkPreview } from '../lib/crypto';
import { encryptAndUpload, MAX_FILE_BYTES, TransferProgress } from '../lib/blob';
import { pickPreviewUrl, stripPreviewMarkers } from '../lib/links';
import { api } from '../lib/api';
import MessageBubble from '../components/MessageBubble';

/**
 * Ceiling for embedding an image link's original bytes in the envelope.
 *
 * The envelope caps at 256KB and base64 adds ~33%, so ~150KB of image is the
 * most that fits alongside the message. Anything larger falls back to a
 * canvas-made thumbnail (which loses GIF animation, but fits).
 */
const MAX_INLINE_PREVIEW_BYTES = 150 * 1024;

export default function Chat() {
  const { channelId } = useParams<{ channelId: string }>();
  const { vault, token, account } = useSession();
  const { send, broadcastProfile, connected, revision } = useRelayContext();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [upload, setUpload] = useState<TransferProgress | null>(null);
  const [sending, setSending] = useState(false);
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

  /**
   * Build a preview for one link, if the user asked for one.
   *
   * "!https://…" marks a single link; the settings toggle makes it the default
   * for the first link in a message. Either way it is a deliberate act: this
   * call tells the relay the URL, which is the one place the server learns
   * message content.
   */
  const buildPreview = useCallback(
    async (body: string): Promise<LinkPreview | undefined> => {
      if (!token || !vault) return undefined;

      const url = pickPreviewUrl(body, vault.preferences.alwaysPreviewLinks);
      if (!url) return undefined;

      try {
        const meta = await api.unfurl(token, url);

        let image;
        if (meta.image) {
          const raw = base64ToBytes(meta.image.data);
          const sniffed = sniffImageMime(raw);

          // A link that *is* an image gets embedded whole when it fits, so an
          // animated GIF keeps its frames. Running it through the canvas would
          // flatten it to the first frame -- correct for a thumbnail, wrong for
          // the thing itself.
          if (meta.kind === 'image' && sniffed && raw.length <= MAX_INLINE_PREVIEW_BYTES) {
            image = { mime: sniffed, data: bytesToBase64Url(raw) };
          } else {
            // Anything else is a thumbnail: re-encode through canvas, which
            // strips EXIF and bounds it so the envelope stays under its cap.
            try {
              image = packAsset(
                await encodeImage(raw, {
                  maxDimension: 400,
                  mime: 'image/webp',
                  quality: 0.7,
                })
              );
            } catch {
              image = undefined;
            }
          }
        }

        return {
          url: meta.url,
          kind: meta.kind,
          title: meta.title,
          description: meta.description,
          siteName: meta.siteName,
          videoId: meta.videoId,
          image,
        };
      } catch {
        // A preview is a nicety. Send the message regardless.
        return undefined;
      }
    },
    [token, vault]
  );

  const handleSend = useCallback(async () => {
    if (!channelId || sending) return;
    if (!text.trim() && pending.length === 0) return;

    setError('');
    setSending(true);
    try {
      // The "!" is a marker for us, not part of what anyone reads.
      const body = stripPreviewMarkers(text.trim());
      const preview = await buildPreview(text.trim());

      const message = await send(channelId, {
        body,
        attachments: pending.length > 0 ? pending : undefined,
        preview,
      });

      if (message) setMessages((current) => [...current, message]);
      setText('');
      setPending([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [channelId, text, pending, send, sending, buildPreview]);

  /**
   * Encrypt and upload immediately on pick, so the message send itself is
   * instant and the attachment is already in the blob store by then.
   */
  async function handleFile(file: File | undefined) {
    if (!file || !channelId || !token) return;
    setError('');

    if (file.size > MAX_FILE_BYTES) {
      setError(`file too large (max ${formatBytes(MAX_FILE_BYTES)})`);
      return;
    }

    try {
      const attachment = await encryptAndUpload(file, channelId, token, setUpload);
      setPending((current) => [...current, attachment]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUpload(null);
      if (fileRef.current) fileRef.current.value = '';
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

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1">
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

      {upload && (
        <div className="border-t border-border px-4 py-2">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>encrypting &amp; uploading…</span>
            <span>{Math.round((upload.loaded / Math.max(1, upload.total)) * 100)}%</span>
          </div>
          <div className="mt-1 h-0.5 w-full bg-border">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round((upload.loaded / Math.max(1, upload.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2 text-xs">
          {pending.map((attachment) => (
            <span
              key={attachment.blobId}
              className="inline-flex items-center gap-1.5 rounded border border-primary/30
                         bg-primary/10 px-2 py-1"
            >
              <span className="max-w-40 truncate text-primary">{attachment.name}</span>
              <span className="text-muted">{formatBytes(attachment.size)}</span>
              <button
                onClick={() => setPending((c) => c.filter((a) => a.blobId !== attachment.blobId))}
                className="text-muted hover:text-error"
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-t border-border bg-surface p-3">
        {/* Any type. The bytes are encrypted client-side before upload, so the
            relay stores something it cannot read or scan. */}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!channel.hasKey || Boolean(upload)}
          className="btn-ghost px-3"
          title={`Attach a file (max ${formatBytes(MAX_FILE_BYTES)})`}
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
          disabled={!channel.hasKey || sending || (!text.trim() && pending.length === 0)}
          className="btn-primary"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
