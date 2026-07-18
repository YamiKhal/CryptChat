import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { CornerUpLeft, Smile, Copy, Download, Pencil, Trash2, Lock, LockKeyhole, Timer, ShieldCheck, MessageCircle, Phone, Video, Ban, LogOut, Image as ImageIcon, User } from 'lucide-react';
import { incognitoHue, incognitoLabel } from '../lib/incognito';
import TrustPanel from '../components/TrustPanel';
import { useCall } from '../lib/callContext';

/** Disappearing-message durations offered in the composer. */
const BURN_OPTIONS = [
  { ttl: 5, label: '5s' },
  { ttl: 30, label: '30s' },
  { ttl: 60, label: '1m' },
  { ttl: 300, label: '5m' },
  { ttl: 3600, label: '1h' },
] as const;
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { StoredMessage, Vault, Contact, UserProfile } from '../lib/vault';
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
  fileToAsset,
} from '../lib/binary';
import { Attachment, LinkPreview, ReplyRef } from '../lib/crypto';
import { encryptAndUpload, downloadAndDecrypt, TransferProgress } from '../lib/blob';
import { pickPreviewUrl, stripPreviewMarkers } from '../lib/links';
import { Limits, DEFAULT_LIMITS, overCharLimit, buildReplyRef, QUICK_REACTIONS } from '../lib/limits';
import { api } from '../lib/api';
import MessageBubble from '../components/MessageBubble';
import Composer from '../components/Composer';
import { ContextMenu, useContextMenu, MenuItem } from '../components/ContextMenu';
import { ChannelNameModal } from '../components/ChannelNameModal';
import { ChannelIcon } from '../components/ChannelIcon';
import { UserProfileModal } from '../components/UserProfileModal';
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
  avatarColor,
  nameOverride,
  senderTrusted,
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
  avatarColor?: number;
  nameOverride?: string;
  senderTrusted?: boolean;
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
      avatarColor={avatarColor}
      nameOverride={nameOverride}
      senderTrusted={senderTrusted}
    />
  );
}

/**
 * Prompt for a code to unlock a password-protected message.
 *
 * The code is checked by trying to decrypt -- a wrong one fails secretbox
 * authentication and reveals nothing. The plaintext only ever lands in this
 * user's own vault; another member unlocking the same message uses their own
 * copy and their own code.
 */
function UnlockModal({
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <LockKeyhole size={13} aria-hidden="true" />
          Enter the code for this message
        </p>
        {message.locked?.hint && (
          <p className="text-[11px] italic text-muted">hint: {message.locked.hint}</p>
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
        {error && <p className="text-[11px] text-error">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost flex-1 text-xs">
            cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !code.trim()}
            className="btn-primary flex-1 text-xs"
          >
            unlock
          </button>
        </div>
      </div>
    </div>
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
    openDirectMessage,
    broadcastProfile,
    connected,
    revision,
    typingIn,
    lastPresence,
    isVerified,
    setVerified,
  } = useRelayContext();
  const call = useCall();
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
  const [burnTtl, setBurnTtl] = useState<number | null>(null);
  const [spoilerArmed, setSpoilerArmed] = useState(false);
  // The contact whose safety number is open, from a message's context menu.
  const [verifyingContact, setVerifyingContact] = useState<Contact | null>(null);
  const [unlocking, setUnlocking] = useState<StoredMessage | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ message: StoredMessage; x: number; y: number } | null>(null);
  const [reactingTo, setReactingTo] = useState<{ id: string; x: number; y: number } | null>(null);
  // Mirrors channel.blocked so a block/unblock re-renders the composer without a
  // full vault-driven refresh.
  const [dmBlocked, setDmBlocked] = useState(false);
  // The header name's own context menu (copy code / rename / block / leave).
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingChannel, setRenamingChannel] = useState(false);
  // The user profile card currently open, or null.
  const [viewingProfile, setViewingProfile] = useState<UserProfile | null>(null);
  // Bumped after a local channel edit (icon) so the header, which reads `channel`
  // straight from the vault, re-renders once the mutated value is in place.
  const [, bumpChannel] = useReducer((n: number) => n + 1, 0);
  const {
    handlers: headerHandlers,
    position: headerPos,
    close: closeHeaderPress,
  } = useContextMenu();

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const announced = useRef<string | null>(null);

  const channel = channelId && vault ? vault.getChannel(channelId) : undefined;
  const isDm = channel?.type === 'dm';

  // Keep the local block flag in step with the vault (reconciled from the server
  // on the channel list), so opening a DM already shows the right composer state.
  useEffect(() => {
    setDmBlocked(Boolean(channel?.blocked));
  }, [channelId, channel?.blocked]);

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

  // Burn-after-read sweep. While the channel is open, start the clock on any
  // burn message on screen and remove ones whose time is up. Running only while
  // open is the point: "read" means it was shown here.
  useEffect(() => {
    if (!vault || !channelId) return;
    let active = true;
    const tick = async () => {
      const res = await vault.processBurns(channelId);
      if (active && res.changed) setMessages(res.messages);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
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
      if (!channelId) return;
      if (value.trim()) {
        const now = Date.now();
        if (now - lastTypingSent.current > 2500) {
          lastTypingSent.current = now;
          sendTyping(channelId);
        }
      } else {
        // Cleared the box: retract the indicator instead of leaving it to lapse.
        lastTypingSent.current = 0;
        sendTyping(channelId, true);
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
        burn: burnTtl ?? undefined,
        spoiler: spoilerArmed || undefined,
      });

      if (message) setMessages((current) => [...current, message]);
      setText('');
      setPending([]);
      setReplyTo(null);
      setLockArmed(false);
      setLockCode('');
      setLockHint('');
      setBurnTtl(null);
      setSpoilerArmed(false);
      // Retract our typing indicator immediately; recipients also clear it when
      // this message lands, but the stop makes it instant even before delivery.
      lastTypingSent.current = 0;
      sendTyping(channelId, true);
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
    burnTtl,
    spoilerArmed,
    sendTyping,
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
    const prompt = isDm
      ? 'Leave this direct message? It is removed from this device; the other person keeps their copy.'
      : 'Leave this channel? Its key and local messages are deleted from this device.';
    if (!confirm(prompt)) return;
    await api.leaveChannel(token, channelId).catch(() => {});
    await vault.removeChannel(channelId);
    navigate('/channels');
  }

  async function handleToggleBlock() {
    if (!channelId || !vault || !token || !channel) return;
    const next = !dmBlocked;
    try {
      if (next) await api.blockDm(token, channelId);
      else await api.unblockDm(token, channelId);
      setDmBlocked(next);
      await vault.saveChannel({ ...channel, blocked: next });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // A right-click / long-press on the header name arms useContextMenu; lift its
  // position into the page-owned menu, matching how message rows do it.
  useEffect(() => {
    if (headerPos) {
      setHeaderMenu({ x: headerPos.x, y: headerPos.y });
      closeHeaderPress();
    }
  }, [headerPos, closeHeaderPress]);

  async function copyChannelCode() {
    if (!channel) return;
    try {
      await navigator.clipboard.writeText(channel.code);
      setError('');
    } catch {
      // Clipboard blocked (insecure context / denied): surface the code so it
      // can still be copied by hand rather than failing silently.
      setError(`Channel code: ${channel.code}`);
    }
  }

  async function handleRenameChannel(name: string) {
    if (!channel || !vault) return;
    await vault.saveChannel({ ...channel, label: name.trim() || undefined });
    // saveChannel mutates the vault in place; closing the modal re-renders and
    // getChannel returns the new label.
  }

  async function handleIconFile(file: File | undefined) {
    if (iconInput.current) iconInput.current.value = '';
    if (!file || !channel || !vault) return;
    try {
      // Same pipeline as the profile avatar: square, downscaled, re-encoded to
      // WebP (which strips EXIF). Only ever called for a group -- the menu hides
      // this for a DM, whose icon tracks the peer.
      const icon = await fileToAsset(file, {
        maxDimension: 256,
        square: true,
        mime: 'image/webp',
        quality: 0.85,
      });
      await vault.saveChannel({ ...channel, icon });
      setError('');
      bumpChannel();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemoveIcon() {
    if (!channel || !vault) return;
    await vault.saveChannel({ ...channel, icon: undefined });
    bumpChannel();
  }

  function headerMenuItems(): MenuItem[] {
    if (!channel) return [];
    const items: MenuItem[] = [];
    // A DM's header opens the peer's profile; a group has no single person.
    if (isDm && channel.peerId && !channel.incognito && contacts[channel.peerId]) {
      items.push({
        label: 'View profile',
        icon: <User size={14} />,
        onSelect: () => openProfile(channel.peerId!),
      });
    }
    items.push(
      {
        label: 'Copy channel code',
        icon: <Copy size={14} />,
        onSelect: () => copyChannelCode(),
      },
      {
        label: channel.label ? 'Rename' : 'Set a name',
        icon: <Pencil size={14} />,
        onSelect: () => setRenamingChannel(true),
      }
    );
    // A group's picture is settable; a DM's icon always tracks the peer.
    if (!isDm) {
      items.push({
        label: channel.icon ? 'Change picture' : 'Set a picture',
        icon: <ImageIcon size={14} />,
        onSelect: () => iconInput.current?.click(),
      });
      if (channel.icon) {
        items.push({
          label: 'Remove picture',
          icon: <Trash2 size={14} />,
          onSelect: () => handleRemoveIcon(),
        });
      }
    }
    if (isDm) {
      items.push({
        label: dmBlocked ? 'Unblock' : 'Block',
        icon: <Ban size={14} />,
        danger: !dmBlocked,
        onSelect: () => handleToggleBlock(),
      });
    }
    items.push({
      label: isDm ? 'Leave conversation' : 'Leave channel',
      icon: <LogOut size={14} />,
      danger: true,
      onSelect: () => handleLeave(),
    });
    return items;
  }

  /** Open a DM with a member from the message menu, then jump to it. */
  const handleStartDm = useCallback(
    async (userId: string) => {
      try {
        const id = await openDirectMessage(userId);
        if (id) navigate(`/chat/${id}`);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [openDirectMessage, navigate]
  );

  function startCall(kind: 'audio' | 'video') {
    if (!channelId || !channel?.peerId) return;
    void call.startCall(channelId, channel.peerId, kind);
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

  /**
   * Open the profile card for a user. Assembles a UserProfile from your own
   * Profile or the peer's pinned Contact. Never in incognito, where there is no
   * stable identity to show a profile for.
   */
  const openProfile = useCallback(
    (userId: string) => {
      if (channel?.incognito) return;
      if (userId === account?.userId && vault) {
        const p = vault.profile;
        setViewingProfile({
          userId,
          displayName: p.displayName,
          avatar: p.avatar,
          bio: p.bio,
          background: p.background,
        });
        return;
      }
      const c = contacts[userId];
      if (c) {
        setViewingProfile({
          userId,
          displayName: c.displayName ?? 'unknown',
          avatar: c.avatar,
          bio: c.bio,
          background: c.background,
        });
      }
    },
    [contacts, account, vault, channel?.incognito]
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

      // A still-locked message: unlocking is the primary action, so it leads.
      if (message.locked) {
        items.unshift({
          label: 'Unlock',
          icon: <LockKeyhole size={13} />,
          onSelect: () => setUnlocking(message),
        });
      }

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

      // Verify this specific sender: their safety number, scoped to them. Only
      // for others (you don't verify yourself) and never in incognito.
      if (
        message.senderId !== account?.userId &&
        !channel?.incognito &&
        contacts[message.senderId]
      ) {
        items.push({
          label: isVerified(message.senderId) ? 'Safety number ✓' : 'Verify safety number',
          icon: <ShieldCheck size={13} />,
          onSelect: () => setVerifyingContact(contacts[message.senderId]),
        });
      }

      // View this member's profile card. Only for others with a pinned identity,
      // and never in incognito -- there is no profile to show for a colour tag.
      if (
        message.senderId !== account?.userId &&
        !channel?.incognito &&
        contacts[message.senderId]
      ) {
        items.push({
          label: 'View profile',
          icon: <User size={13} />,
          onSelect: () => openProfile(message.senderId),
        });
      }

      // Start a 1:1 DM with this member. Not offered inside a DM (already one) or
      // in incognito (there is no stable identity to open a DM against).
      if (message.senderId !== account?.userId && !channel?.incognito && !isDm) {
        items.push({
          label: 'Direct message',
          icon: <MessageCircle size={13} />,
          onSelect: () => handleStartDm(message.senderId),
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
    [menu, token, account?.userId, handleStartEdit, handleDelete, contacts, channel?.incognito, isVerified, isDm, handleStartDm, openProfile]
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
        {/* Clicking (or right-click / long-press) the icon or name opens the
            channel menu: copy code, rename, set a picture, block, leave. */}
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHeaderMenu({ x: r.left, y: r.bottom + 4 });
          }}
          {...headerHandlers}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          title="Channel options"
        >
          <ChannelIcon
            channel={channel}
            peerName={channel.peerId ? nameFor(channel.peerId) : undefined}
            peerAvatar={channel.peerId ? vault.getContact(channel.peerId)?.avatar : undefined}
            size="md"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {isDm
                ? channel.peerId
                  ? nameFor(channel.peerId)
                  : 'direct message'
                : channel.label || 'Group'}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-warn'}`}
              />
              {connected ? 'encrypted' : 'reconnecting…'}
              {isDm && <span className="tag bg-primary/10 text-primary">direct</span>}
              {channel.incognito && (
                <span className="tag bg-secondary/10 text-secondary">incognito</span>
              )}
            </p>
          </div>
        </button>

        {isDm && channel.hasKey && !dmBlocked && (
          <>
            <button
              onClick={() => startCall('audio')}
              className="text-muted transition-colors hover:text-primary"
              title="Voice call"
              aria-label="Voice call"
            >
              <Phone size={18} />
            </button>
            <button
              onClick={() => startCall('video')}
              className="text-muted transition-colors hover:text-primary"
              title={limits.premium ? 'Video call' : 'Video calling is a supporter feature'}
              aria-label="Video call"
            >
              <Video size={18} />
            </button>
          </>
        )}

        {isDm && (
          <button
            onClick={handleToggleBlock}
            className={`transition-colors ${dmBlocked ? 'text-error' : 'text-muted hover:text-error'}`}
            title={dmBlocked ? 'Unblock' : 'Block'}
            aria-label={dmBlocked ? 'Unblock' : 'Block'}
          >
            <Ban size={17} />
          </button>
        )}

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
                supporter={
                  channel.incognito
                    ? false
                    : isSelf
                      ? Boolean(limits.premium)
                      : Boolean(message.supporterClaimed)
                }
                selfId={account.userId}
                nameFor={nameFor}
                messageIds={messageIds}
                highlighted={highlighted === message.id}
                onToggleReaction={(emoji) => handleToggleReaction(message, emoji)}
                onJumpToReply={jumpToMessage}
                onOpenMenu={(x, y) => setMenu({ message, x, y })}
                avatarColor={
                  channel.incognito ? incognitoHue(channelId!, message.senderId) : undefined
                }
                nameOverride={channel.incognito ? nameFor(message.senderId) : undefined}
                senderTrusted={!channel.incognito && isVerified(message.senderId)}
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

      {burnTtl != null && (
        <div className="space-y-1.5 border-t border-primary/30 bg-primary/5 px-4 py-2">
          <div className="flex items-center gap-2">
            <Timer size={12} className="text-primary" aria-hidden="true" />
            <span className="text-[11px] text-primary">
              Disappears {BURN_OPTIONS.find((o) => o.ttl === burnTtl)?.label ?? ''} after it's read
            </span>
            <button
              onClick={() => setBurnTtl(null)}
              className="ml-auto text-[11px] text-muted hover:text-error"
            >
              cancel
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BURN_OPTIONS.map((o) => (
              <button
                key={o.ttl}
                onClick={() => setBurnTtl(o.ttl)}
                className={`rounded px-2 py-0.5 text-[11px] ${
                  burnTtl === o.ttl
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border text-muted hover:text-foreground'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted">
            Removed from both sides after the timer, on cooperating clients. It cannot stop a
            screenshot or a photo of the screen.
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

      {dmBlocked && (
        <div className="flex items-center justify-between border-t border-error/30 bg-error/10 px-4 py-2 text-[11px] text-error">
          <span>You blocked this person. Their messages won't reach you.</span>
          <button onClick={handleToggleBlock} className="underline hover:no-underline">
            unblock
          </button>
        </div>
      )}

      <Composer
        value={text}
        onChange={handleType}
        onSend={handleSend}
        onAttach={() => fileRef.current?.click()}
        disabled={!channel.hasKey || dmBlocked}
        sending={sending}
        uploading={Boolean(upload)}
        canSend={Boolean(text.trim()) || pending.length > 0}
        limits={limits}
        placeholder={editingId ? 'edit message…' : channel.hasKey ? 'message' : 'waiting for key…'}
        canLock={Boolean(limits.premium) && !editingId}
        lockArmed={lockArmed}
        onToggleLock={() => setLockArmed((a) => !a)}
        canBurn={Boolean(limits.premium)}
        burnArmed={burnTtl != null}
        onToggleBurn={() => setBurnTtl((t) => (t == null ? 30 : null))}
        spoilerArmed={spoilerArmed}
        onToggleSpoiler={editingId ? undefined : () => setSpoilerArmed((s) => !s)}
      />

      {verifyingContact && (
        <TrustPanel
          mySignKey={vault.identity.signPublicKey}
          contacts={[verifyingContact]}
          isVerified={isVerified}
          onClose={() => setVerifyingContact(null)}
          onSetVerified={setVerified}
        />
      )}

      {unlocking && (
        <UnlockModal
          message={unlocking}
          onClose={() => setUnlocking(null)}
          onSubmit={handleUnlock}
        />
      )}

      {menu && (
        <ContextMenu
          items={menuItems(menu.message)}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}

      {headerMenu && (
        <ContextMenu
          items={headerMenuItems()}
          position={{ x: headerMenu.x, y: headerMenu.y }}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {renamingChannel && channel && (
        <ChannelNameModal
          channel={channel}
          onClose={() => setRenamingChannel(false)}
          onSubmit={handleRenameChannel}
        />
      )}

      {viewingProfile && (
        <UserProfileModal profile={viewingProfile} onClose={() => setViewingProfile(null)} />
      )}

      <input
        ref={iconInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleIconFile(e.target.files?.[0])}
      />

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
