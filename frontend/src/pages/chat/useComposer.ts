import { useState, useCallback, useRef } from 'react';
import { StoredMessage, Vault, AccountDescriptor } from '@/lib/vault';
import {
  formatBytes,
  base64ToBytes,
  bytesToBase64Url,
  encodeImage,
  packAsset,
  sniffImageMime,
} from '@/lib/binary';
import { Attachment, LinkPreview, ReplyRef } from '@/lib/crypto';
import { encryptAndUpload, TransferProgress } from '@/lib/blob';
import { pickPreviewUrl, stripPreviewMarkers } from '@/lib/links';
import { Limits, overCharLimit } from '@/lib/limits';
import { playSound } from '@/lib/sounds';
import { api } from '@/lib/api';
import { MAX_INLINE_PREVIEW_BYTES } from '@/pages/chat/utils';
import type { useRelayContext } from '@/lib/relayContext';

type Relay = ReturnType<typeof useRelayContext>;

/**
 * All composer state (draft text, pending attachments, armed lock/burn/spoiler,
 * the message being edited) and every action that mutates the transcript from the
 * composer side: send, edit, delete, react, unlock, attach, and jump-to-reply.
 */
export function useComposer({
  vault,
  channelId,
  token,
  account,
  limits,
  setMessages,
  send,
  editMessage,
  deleteMessage,
  sendReaction,
  sendTyping,
}: {
  vault: Vault;
  channelId: string | undefined;
  token: string | null;
  account: AccountDescriptor;
  limits: Limits;
  setMessages: React.Dispatch<React.SetStateAction<StoredMessage[]>>;
  send: Relay['send'];
  editMessage: Relay['editMessage'];
  deleteMessage: Relay['deleteMessage'];
  sendReaction: Relay['sendReaction'];
  sendTyping: Relay['sendTyping'];
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [upload, setUpload] = useState<TransferProgress | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lockArmed, setLockArmed] = useState(false);
  const [lockCode, setLockCode] = useState('');
  const [lockHint, setLockHint] = useState('');
  const [burnTtl, setBurnTtl] = useState<number | null>(null);
  const [spoilerArmed, setSpoilerArmed] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);

  // Throttled typing ping. Fires at most every few seconds while the user is
  // actually typing something — never on an empty box, never a local echo.
  const handleType = useCallback(
    (value: string) => {
      // Optional keystroke click (off by default). Only on insertion, so a
      // backspace-and-retype does not double-tick.
      if (value.length > text.length) playSound('typing');
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
    [channelId, sendTyping, text.length],
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
      if (!token) return undefined;

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
                }),
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
    [token, vault],
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
          current.map((message) =>
            message.id === editingId
              ? { ...message, body, editedAt: new Date().toISOString() }
              : message,
          ),
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
      playSound('message-sent');
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
    setMessages,
  ]);

  const handleUnlock = useCallback(
    async (message: StoredMessage, code: string) => {
      if (!channelId) return;
      // Throws 'wrong code' on failure; the bubble surfaces it inline.
      const updated = await vault.unlockMessage(channelId, message.id, code);
      setMessages(updated);
    },
    [channelId, vault, setMessages],
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
          current.map((existing) =>
            existing.id === message.id
              ? {
                  ...existing,
                  deleted: true,
                  body: '',
                  asset: undefined,
                  attachments: undefined,
                  preview: undefined,
                  replyTo: undefined,
                }
              : existing,
          ),
        );
        if (editingId === message.id) {
          setEditingId(null);
          setText('');
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [channelId, deleteMessage, editingId, setMessages],
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
      if (!channelId) return;
      const mine = target.reactions?.[emoji]?.includes(account.userId) ?? false;
      try {
        await sendReaction(channelId, target.id, emoji, mine);
        setMessages(await vault.loadMessages(channelId));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [channelId, account, sendReaction, vault, setMessages],
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
          (limits.premium ? '' : ' Supporters can send up to 50MB.'),
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

  return {
    text,
    setText,
    pending,
    setPending,
    upload,
    sending,
    error,
    setError,
    replyTo,
    setReplyTo,
    editingId,
    setEditingId,
    lockArmed,
    setLockArmed,
    lockCode,
    setLockCode,
    lockHint,
    setLockHint,
    burnTtl,
    setBurnTtl,
    spoilerArmed,
    setSpoilerArmed,
    highlighted,
    fileRef,
    handleType,
    handleSend,
    handleUnlock,
    handleStartEdit,
    handleDelete,
    jumpToMessage,
    handleToggleReaction,
    handleFile,
  };
}
