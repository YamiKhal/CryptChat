import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { CornerUpLeft, Smile, Copy, Download, Pencil, Trash2, Lock } from 'lucide-react';
import { incognitoHue, incognitoLabel } from '../lib/incognito';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { StoredMessage, Vault } from '../lib/vault';
import {
  formatBytes,
  base64ToBytes,
  bytesToBase64Url,
  encodeImage,
  packAsset,
  sniffImageMime,
  saveBlob,
  BinaryAsset,
  base64UrlToBytes,
  bytesToDataUrl,
} from '../lib/binary';
import { Attachment, LinkPreview, ReplyRef } from '../lib/crypto';
import { encryptAndUpload, downloadAndDecrypt, TransferProgress } from '../lib/blob';
import { pickPreviewUrl, stripPreviewMarkers } from '../lib/links';
import { Limits, DEFAULT_LIMITS, overCharLimit, buildReplyRef, QUICK_REACTIONS } from '../lib/limits';
import { api } from '../lib/api';
import MessageBubble from '../components/MessageBubble';
import Composer from '../components/Composer';
import { ContextMenu, useContextMenu, MenuItem } from '../components/ContextMenu';
import { ReplyComposing } from '../components/ReplyRefCard';

/**
 * Decrypt an attachment and save it.
 *
 * The bytes arrive as ciphertext and the key came inside the signed envelope, so
 * this is the only place the plaintext exists -- the relay stores something it
 * cannot open. saveBlob forces application/octet-stream regardless of the
 * sender's claimed MIME, so a hostile "image" cannot be navigated to as markup.
 */
async function downloadAttachment(attachment: Attachment, token: string): Promise<void> {
  const blob = await downloadAndDecrypt(attachment, token);
  saveBlob(blob, attachment.name);
}

/**
 * Ceiling for embedding an image link's original bytes in the envelope.
 *
 * The envelope caps at 256KB and base64 adds ~33%, so ~150KB of image is the
 * most that fits alongside the message. Anything larger falls back to a
 * canvas-made thumbnail (which loses GIF animation, but fits).
 */
const MAX_INLINE_PREVIEW_BYTES = 150 * 1024;

/**
 * One message plus its context-menu wiring.
 *
 * Split out because `useContextMenu` is a hook and cannot be called inside the
 * transcript's map(). Each row owns its own press-tracking state, which is also
 * what keeps a long-press on one message from arming another.
 */
function MessageRow({
  message,
  isSelf,
  grouped,
  avatar,
  keyChanged,
  supporter,
  selfId,
  nameFor,
  messageIds,
  highlighted,
  onToggleReaction,
  onJumpToReply,
  onOpenMenu,
  onUnlock,
  avatarColor,
  nameOverride,
}: {
  message: StoredMessage;
  isSelf: boolean;
  grouped: boolean;
  avatar?: BinaryAsset;
  keyChanged: boolean;
  supporter: boolean;
  selfId: string;
  nameFor: (userId: string) => string;
  messageIds: Set<string>;
  highlighted: boolean;
  onToggleReaction: (emoji: string) => void;
  onJumpToReply: (id: string) => void;
  onOpenMenu: (x: number, y: number) => void;
  onUnlock: (message: StoredMessage, code: string) => Promise<void>;
  avatarColor?: number;
  nameOverride?: string;
}) {
  const { handlers, position, close } = useContextMenu();

  // Lift the position up to the page, which owns the single open menu. Two rows
  // must never render menus at once.
  useEffect(() => {
    if (position) {
      onOpenMenu(position.x, position.y);
      close();
    }
  }, [position, onOpenMenu, close]);

  return (
    <MessageBubble
      message={message}
      isSelf={isSelf}
      grouped={grouped}
      avatar={avatar}
      keyChanged={keyChanged}
      supporter={supporter}
      selfId={selfId}
      nameFor={nameFor}
      onToggleReaction={onToggleReaction}
      onJumpToReply={onJumpToReply}
      replyTargetExists={message.replyTo ? messageIds.has(message.replyTo.id) : false}
      contextHandlers={handlers}
      highlighted={highlighted}
      onUnlock={(code) => onUnlock(message, code)}
      avatarColor={avatarColor}
      nameOverride={nameOverride}
    />
  );
}

export default function Chat() {
  const { channelId } = useParams<{ channelId: string }>();
  const { vault, token, account } = useSession();
  const {
    send,
    sendReaction,
    sendTyping,
    editMessage,
    deleteMessage,
    broadcastProfile,
    connected,
    revision,
    typingIn,
    lastPresence,
  } = useRelayContext();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [upload, setUpload] = useState<TransferProgress | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lockArmed, setLockArmed] = useState(false);
  const [lockCode, setLockCode] = useState('');
  const [lockHint, setLockHint] = useState('');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ message: StoredMessage; x: number; y: number } | null>(null);
  const [reactingTo, setReactingTo] = useState<{ id: string; x: number; y: number } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const announced = useRef<string | null>(null);

  const channel = channelId && vault ? vault.getChannel(channelId) : undefined;

  // Tier limits come from the server, never hardcoded here: it is the only
  // authority, and a client that believes the wrong cap produces uploads that
  // die at 99% or messages the relay rejects.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .limits(token)
      .then((res) => !cancelled && setLimits(res))
      // Keep the restrictive defaults on failure rather than assuming premium.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, revision]);

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

  // Mark the channel read while it is open: on entry and each time the
  // transcript grows. Clears the unread badge on the channel list. markChannelRead
  // never moves the marker backwards, so this only ever writes when there is
  // genuinely newer material.
  useEffect(() => {
    if (!vault || !channelId) return;
    vault.markChannelRead(channelId).catch(() => {});
  }, [vault, channelId, messages.length]);

  // Anonymous "someone joined / left" as centered system lines in the transcript,
  // so they are actually seen. Session-scoped (never persisted, never signed) and
  // cleared when switching channels.
  const [presenceLog, setPresenceLog] = useState<{ id: string; text: string; at: string }[]>([]);
  useEffect(() => {
    setPresenceLog([]);
  }, [channelId]);
  useEffect(() => {
    if (!lastPresence || lastPresence.channelId !== channelId) return;
    // Stamp it when it happened. The render merges these into the transcript by
    // time, so a leave stays at its moment and later messages fall after it.
    setPresenceLog((log) => [
      ...log,
      {
        id: String(lastPresence.nonce),
        text: lastPresence.event === 'joined' ? 'Someone joined the channel' : 'Someone left the channel',
        at: new Date().toISOString(),
      },
    ]);
  }, [lastPresence, channelId]);

  // Throttled typing ping. Fires at most every few seconds while the user is
  // actually typing something — never on an empty box, never a local echo.
  const lastTypingSent = useRef(0);
  const handleType = useCallback(
    (value: string) => {
      setText(value);
      const now = Date.now();
      if (channelId && value.trim() && now - lastTypingSent.current > 2500) {
        lastTypingSent.current = now;
        sendTyping(channelId);
      }
    },
    [channelId, sendTyping]
  );

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

    // Editing an existing message rather than sending a new one.
    if (editingId) {
      const body = stripPreviewMarkers(text.trim());
      if (!body) return; // an empty edit would be a delete; use delete for that
      if (overCharLimit(text, limits)) {
        setError(`Message is over the ${limits.maxChars.toLocaleString()} character limit.`);
        return;
      }
      setError('');
      setSending(true);
      try {
        await editMessage(channelId, editingId, body);
        setMessages((current) =>
          current.map((m) =>
            m.id === editingId ? { ...m, body, editedAt: new Date().toISOString() } : m
          )
        );
        setText('');
        setEditingId(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
      return;
    }

    if (!text.trim() && pending.length === 0) return;

    // Client-side, and only client-side: the relay sees ciphertext and cannot
    // count characters. See the note on overCharLimit in lib/limits.ts.
    if (overCharLimit(text, limits)) {
      setError(`Message is over the ${limits.maxChars.toLocaleString()} character limit.`);
      return;
    }

    if (lockArmed && !lockCode.trim()) {
      setError('Enter a code to lock this message, or turn the lock off.');
      return;
    }

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
        replyTo: replyTo ?? undefined,
        lock:
          lockArmed && lockCode.trim()
            ? { code: lockCode.trim(), hint: lockHint.trim() || undefined }
            : undefined,
      });

      if (message) setMessages((current) => [...current, message]);
      setText('');
      setPending([]);
      setReplyTo(null);
      setLockArmed(false);
      setLockCode('');
      setLockHint('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    channelId,
    text,
    pending,
    send,
    sending,
    buildPreview,
    replyTo,
    limits,
    editingId,
    editMessage,
    lockArmed,
    lockCode,
    lockHint,
  ]);

  const handleUnlock = useCallback(
    async (message: StoredMessage, code: string) => {
      if (!channelId || !vault) return;
      // Throws 'wrong code' on failure; the bubble surfaces it inline.
      const updated = await vault.unlockMessage(channelId, message.id, code);
      setMessages(updated);
    },
    [channelId, vault]
  );

  const handleStartEdit = useCallback((message: StoredMessage) => {
    setReplyTo(null);
    setEditingId(message.id);
    setText(message.body);
  }, []);

  const handleDelete = useCallback(
    async (message: StoredMessage) => {
      if (!channelId) return;
      if (!confirm('Delete this message for everyone?\n\nThis cannot be undone.')) return;
      try {
        await deleteMessage(channelId, message.id);
        setMessages((current) =>
          current.map((m) =>
            m.id === message.id
              ? { ...m, deleted: true, body: '', asset: undefined, attachments: undefined, preview: undefined, replyTo: undefined }
              : m
          )
        );
        if (editingId === message.id) {
          setEditingId(null);
          setText('');
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [channelId, deleteMessage, editingId]
  );

  /**
   * Scroll to the message a reply points at.
   *
   * The target may not exist here at all -- we joined late, cleared history, or
   * the replier quoted something we never received. The quote is the replier's
   * snapshot, so it still renders; it just is not clickable.
   */
  const jumpToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // A ring that fades: after scrolling, "which one was it" is the next
    // question, and the answer should not require hunting.
    setHighlighted(messageId);
    setTimeout(() => setHighlighted((c) => (c === messageId ? null : c)), 1600);
  }, []);

  const handleToggleReaction = useCallback(
    async (target: StoredMessage, emoji: string) => {
      if (!channelId || !account) return;
      const mine = target.reactions?.[emoji]?.includes(account.userId) ?? false;
      try {
        await sendReaction(channelId, target.id, emoji, mine);
        setMessages(await (vault as Vault).loadMessages(channelId));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [channelId, account, sendReaction, vault]
  );

  /**
   * Encrypt and upload immediately on pick, so the message send itself is
   * instant and the attachment is already in the blob store by then.
   */
  async function handleFile(file: File | undefined) {
    if (!file || !channelId || !token) return;
    setError('');

    // Both of these are re-checked by the server, which is what actually
    // enforces them. Checking here means the user finds out before they wait
    // through an encrypt-and-upload that was always going to be refused.
    if (!limits.canUpload) {
      setError(limits.uploadDenialReason ?? 'Uploads are unavailable on this account.');
      return;
    }

    if (file.size > limits.maxFileBytes) {
      setError(
        `File is too large — ${formatBytes(file.size)}, and the ${limits.tier} limit is ${formatBytes(limits.maxFileBytes)}.` +
          (limits.premium ? '' : ' Supporters can send up to 50MB.')
      );
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

  /** Whether a reply's target is on this device, so the quote knows if it can jump. */
  const messageIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  // Premium chat wallpaper, decoded from the vault to a data URL. Rendered
  // behind opaque message bubbles, so it never costs legibility.
  const chatBackground = useMemo(() => {
    const asset = vault?.preferences.chatBackground;
    if (!asset) return undefined;
    try {
      return bytesToDataUrl(base64UrlToBytes(asset.data), asset.mime);
    } catch {
      return undefined;
    }
  }, [vault]);

  const nameFor = useCallback(
    (userId: string) => {
      // In an incognito channel nobody has a name; everyone is a per-channel tag.
      if (channel?.incognito && channelId) return incognitoLabel(channelId, userId);
      if (userId === account?.userId) return vault?.profile.displayName ?? 'you';
      return contacts[userId]?.displayName ?? 'unknown';
    },
    [contacts, account, vault, channel?.incognito, channelId]
  );

  /** Built per-target so the menu can offer download only where there is a file. */
  const menuItems = useCallback(
    (message: StoredMessage): MenuItem[] => {
      const items: MenuItem[] = [
        {
          label: 'Reply',
          icon: <CornerUpLeft size={13} />,
          onSelect: () => setReplyTo(buildReplyRef(message)),
        },
        {
          label: 'React',
          icon: <Smile size={13} />,
          onSelect: () => setReactingTo({ id: message.id, x: menu?.x ?? 0, y: menu?.y ?? 0 }),
        },
      ];

      if (message.body.trim()) {
        items.push({
          label: 'Copy text',
          icon: <Copy size={13} />,
          onSelect: () => navigator.clipboard?.writeText(message.body),
        });
      }

      for (const attachment of message.attachments ?? []) {
        items.push({
          label: `Download ${attachment.name}`,
          icon: <Download size={13} />,
          // Downloading decrypts locally: the blob store holds ciphertext and
          // the key rides in the envelope, so the server cannot serve the
          // plaintext even if it wanted to.
          onSelect: () => downloadAttachment(attachment, token!).catch((e) => setError(e.message)),
        });
      }

      // Edit and delete are author-only: the vault enforces it on both ends, but
      // there is no reason to offer the action on someone else's message. A
      // tombstone offers neither.
      if (message.senderId === account?.userId && !message.deleted) {
        if (message.body.trim()) {
          items.push({
            label: 'Edit',
            icon: <Pencil size={13} />,
            onSelect: () => handleStartEdit(message),
          });
        }
        items.push({
          label: 'Delete',
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => handleDelete(message),
        });
      }

      return items;
    },
    [menu, token, account?.userId, handleStartEdit, handleDelete]
  );

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
            {channel.incognito && (
              <span className="tag bg-secondary/10 text-secondary">incognito</span>
            )}
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

      <div
        className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1 bg-cover bg-center bg-fixed"
        style={
          chatBackground
            ? {
                backgroundImage: `linear-gradient(var(--wallpaper-scrim), var(--wallpaper-scrim)), url(${chatBackground})`,
              }
            : undefined
        }
      >
        {loading && <p className="text-center text-xs text-muted">decrypting…</p>}

        {!loading && messages.length === 0 && channel.hasKey && (
          <p className="text-center text-xs text-muted">No messages yet.</p>
        )}

        {(() => {
          // Messages and presence notices, merged and ordered by time, so a
          // "someone left" sits exactly where it happened rather than always at
          // the bottom. A presence line also breaks message grouping, so the
          // next message shows its header again.
          const items = [
            ...messages.map((m) => ({ type: 'msg' as const, at: m.createdAt, message: m })),
            ...presenceLog.map((p) => ({ type: 'presence' as const, at: p.at, id: p.id, text: p.text })),
          ].sort((a, b) => a.at.localeCompare(b.at));

          let prevSenderId: string | null = null;

          return items.map((item) => {
            if (item.type === 'presence') {
              prevSenderId = null;
              return (
                <div key={`p-${item.id}`} className="my-2 flex justify-center">
                  <span className="rounded-full bg-surface-raised px-3 py-1 text-[11px] text-muted">
                    {item.text}
                  </span>
                </div>
              );
            }

            const message = item.message;
            const isSelf = message.senderId === account.userId;
            const contact = contacts[message.senderId];
            const grouped = prevSenderId === message.senderId;
            prevSenderId = message.senderId;

            return (
              <MessageRow
                key={message.id}
                message={message}
                isSelf={isSelf}
                grouped={grouped}
                avatar={isSelf ? vault.profile.avatar : contact?.avatar}
                keyChanged={Boolean(contact?.keyChangedAt)}
                supporter={!channel.incognito && isSelf ? Boolean(limits.premium) : false}
                selfId={account.userId}
                nameFor={nameFor}
                messageIds={messageIds}
                highlighted={highlighted === message.id}
                onToggleReaction={(emoji) => handleToggleReaction(message, emoji)}
                onJumpToReply={jumpToMessage}
                onOpenMenu={(x, y) => setMenu({ message, x, y })}
                onUnlock={handleUnlock}
                avatarColor={
                  channel.incognito ? incognitoHue(channelId!, message.senderId) : undefined
                }
                nameOverride={channel.incognito ? nameFor(message.senderId) : undefined}
              />
            );
          });
        })()}

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

      {(() => {
        const typers = channelId ? typingIn(channelId).filter((id) => id !== account.userId) : [];
        if (typers.length === 0) return null;
        const names = typers.map(nameFor).filter((n) => n && n !== 'unknown');
        const typingLabel =
          typers.length === 1
            ? `${names[0] ?? 'Someone'} is typing…`
            : names.length === typers.length
              ? `${names.join(', ')} are typing…`
              : 'Several people are typing…';
        return (
          <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-muted">
            <span className="animate-pulse">{typingLabel}</span>
          </div>
        );
      })()}

      {lockArmed && (
        <div className="space-y-1.5 border-t border-primary/30 bg-primary/5 px-4 py-2">
          <div className="flex items-center gap-2">
            <Lock size={12} className="text-primary" aria-hidden="true" />
            <span className="text-[11px] text-primary">This message will need a code to read</span>
            <button
              onClick={() => {
                setLockArmed(false);
                setLockCode('');
                setLockHint('');
              }}
              className="ml-auto text-[11px] text-muted hover:text-error"
            >
              cancel
            </button>
          </div>
          <input
            className="field text-xs"
            placeholder="code recipients must enter"
            value={lockCode}
            onChange={(e) => setLockCode(e.target.value)}
            autoComplete="off"
          />
          <input
            className="field text-xs"
            placeholder="hint (optional, shown before unlocking)"
            value={lockHint}
            onChange={(e) => setLockHint(e.target.value)}
            maxLength={140}
          />
          <p className="text-[10px] text-muted">
            Share the code another way. It never reaches our servers and cannot be recovered —
            without it, the message stays locked. This guards against a glance over the shoulder, not
            against someone who already has the message.
          </p>
        </div>
      )}

      {editingId && (
        <div className="flex items-center justify-between border-t border-primary/30 bg-primary/5 px-4 py-1.5 text-[11px]">
          <span className="text-primary">Editing message</span>
          <button
            onClick={() => {
              setEditingId(null);
              setText('');
            }}
            className="text-muted hover:text-error"
          >
            cancel
          </button>
        </div>
      )}

      {replyTo && <ReplyComposing reply={replyTo} onCancel={() => setReplyTo(null)} />}

      {/* Any type. The bytes are encrypted client-side before upload, so the
          relay stores something it cannot read or scan. */}
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <Composer
        value={text}
        onChange={handleType}
        onSend={handleSend}
        onAttach={() => fileRef.current?.click()}
        disabled={!channel.hasKey}
        sending={sending}
        uploading={Boolean(upload)}
        canSend={Boolean(text.trim()) || pending.length > 0}
        limits={limits}
        placeholder={editingId ? 'edit message…' : channel.hasKey ? 'message' : 'waiting for key…'}
        canLock={Boolean(limits.premium) && !editingId}
        lockArmed={lockArmed}
        onToggleLock={() => setLockArmed((a) => !a)}
      />

      {menu && (
        <ContextMenu
          items={menuItems(menu.message)}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}

      {/* The quick-reaction strip. A full picker is one tap further in, but the
          common case is one of eight and should not need a search box. */}
      {reactingTo && (
        <QuickReactions
          x={reactingTo.x}
          y={reactingTo.y}
          onPick={(emoji) => {
            const target = messages.find((m) => m.id === reactingTo.id);
            if (target) handleToggleReaction(target, emoji);
            setReactingTo(null);
          }}
          onClose={() => setReactingTo(null)}
        />
      )}
    </div>
  );
}

/** Anchored strip of the eight most-used reactions. */
function QuickReactions({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp inside the viewport: opened near an edge this would otherwise render
  // with half its emoji unreachable.
  const width = 268;
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 56));

  return (
    <div
      ref={ref}
      className="fixed z-50 flex gap-0.5 rounded-full border border-border bg-surface-raised
                 px-1.5 py-1 shadow-xl animate-fade-in"
      style={{ left, top }}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          className="rounded-full p-1 text-lg leading-none transition-transform hover:scale-125"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
