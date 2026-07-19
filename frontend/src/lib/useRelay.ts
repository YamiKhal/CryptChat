import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import {
  createEnvelope,
  openEnvelope,
  wrapChannelKeyForRecipient,
  unwrapChannelKey,
  generateChannelKey,
  isSingleEmoji,
  sealWithPassword,
  Attachment,
  LinkPreview,
  ReplyRef,
  CallSignal,
} from './crypto';
import { BinaryAsset } from './binary';
import { Vault, StoredMessage } from './vault';

/**
 * Relay socket: delivery, and the key exchange that makes joining work.
 *
 * The server routes ciphertext and never holds a channel key. When someone
 * joins with a code, the server can only announce them; an existing member
 * has to wrap the channel key for the joiner's public key and send it back
 * through the relay. That handshake was the missing piece -- join used to
 * register membership and stop, so a joiner reached a channel it could never
 * decrypt.
 */

interface RelayOptions {
  vault: Vault | null;
  token: string | null;
  userId: string | null;
  onMessage?: (message: StoredMessage) => void;
  onChannelKey?: (channelId: string) => void;
  onKeyChangeWarning?: (userId: string) => void;
  /** Ephemeral "someone is typing" — never stored, never in the transcript. `stop` retracts it. */
  onTyping?: (event: { channelId: string; senderId: string; stop: boolean }) => void;
  /** Anonymous join/leave notice for a channel. Carries no identity. */
  onPresence?: (event: { channelId: string; event: 'joined' | 'left' }) => void;
  /** A verified WebRTC call-control frame for a DM. Never stored. */
  onSignal?: (event: { channelId: string; senderId: string; signal: CallSignal }) => void;
}

export interface SendPayload {
  body: string;
  asset?: BinaryAsset;
  attachments?: Attachment[];
  preview?: LinkPreview;
  replyTo?: ReplyRef;
  /** When set, the body is sealed under this code and sent locked (premium). */
  lock?: { code: string; hint?: string };
  /** Burn-after-read ttl in seconds; the message self-destructs after first view. */
  burn?: number;
  /** Cover the whole message until the reader clicks to reveal it. */
  spoiler?: boolean;
}

interface ParkedReaction {
  channelId: string;
  targetId: string;
  emoji: string;
  senderId: string;
  removed: boolean;
}

/**
 * Apply any parked reactions now that `messageId` exists locally.
 *
 * Mutates the parked list in place, removing what it applied.
 */
async function drainParked(
  parked: { current: ParkedReaction[] },
  vault: Vault,
  channelId: string,
  messageId: string
): Promise<boolean> {
  const ready = parked.current.filter(
    (reaction) => reaction.channelId === channelId && reaction.targetId === messageId
  );
  if (ready.length === 0) return false;

  parked.current = parked.current.filter(
    (reaction) => !(reaction.channelId === channelId && reaction.targetId === messageId)
  );

  for (const reaction of ready) {
    await vault.applyReactionToMessage(
      channelId,
      reaction.targetId,
      reaction.emoji,
      reaction.senderId,
      reaction.removed
    );
  }
  return true;
}

/** An edit or delete whose target message has not arrived yet. */
interface ParkedMutation {
  channelId: string;
  targetId: string;
  kind: 'edit' | 'delete';
  senderId: string;
  body?: string;
  at?: string;
}

/**
 * Apply parked edits/deletes now that `messageId` exists.
 *
 * Ordering usually saves us -- the relay flushes the original (older timestamp)
 * before the edit -- but a member who joined mid-conversation can receive an
 * edit for a message they never had, so these are parked like reactions rather
 * than dropped. The author check lives in the vault, so a parked mutation from
 * the wrong sender simply no-ops when it drains.
 */
async function drainMutations(
  parked: { current: ParkedMutation[] },
  vault: Vault,
  channelId: string,
  messageId: string
): Promise<boolean> {
  const ready = parked.current.filter(
    (mutation) => mutation.channelId === channelId && mutation.targetId === messageId
  );
  if (ready.length === 0) return false;

  parked.current = parked.current.filter(
    (mutation) => !(mutation.channelId === channelId && mutation.targetId === messageId)
  );

  for (const mutation of ready) {
    if (mutation.kind === 'edit') {
      await vault.editMessage(channelId, mutation.targetId, mutation.senderId, mutation.body ?? '', mutation.at);
    } else {
      await vault.deleteMessage(channelId, mutation.targetId, mutation.senderId);
    }
  }
  return true;
}

type Incoming =
  | { type: 'message'; messageId: string; clientId?: string | null; channelId: string; senderId: string; kind: string; ciphertext: string; nonce: string; createdAt: string }
  | { type: 'key-offer'; offerId: string; channelId: string; senderId: string; senderPubkey: string; senderSignPubkey: string; ciphertext: string; nonce: string }
  | { type: 'key-request'; channelId: string; requesterId: string; requesterPubkey: string; requesterSignPubkey: string }
  | { type: 'member-joined'; channelId: string; userId: string; pubkey: string; signPubkey: string }
  | { type: 'member-left'; channelId: string }
  | { type: 'typing'; channelId: string; senderId: string; stop?: boolean }
  | { type: 'signal'; channelId: string; senderId: string; ciphertext: string; nonce: string }
  | { type: 'profile-request'; channelId: string; requesterId: string }
  | { type: 'sent'; clientId: string; channelId: string }
  | { type: 'key-offer-sent'; channelId: string; recipientId: string }
  | { type: 'dm-request'; channelId: string };

export function useRelay({
  vault,
  token,
  userId,
  onMessage,
  onChannelKey,
  onKeyChangeWarning,
  onTyping,
  onPresence,
  onSignal,
}: RelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  // Handlers change every render; the socket must not.
  const handlers = useRef({ onMessage, onChannelKey, onKeyChangeWarning, onTyping, onPresence, onSignal });
  handlers.current = { onMessage, onChannelKey, onKeyChangeWarning, onTyping, onPresence, onSignal };
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  /**
   * Reactions whose target message has not arrived yet.
   *
   * In-memory only, and deliberately: these are worth a few seconds of patience
   * while a queue flushes, not a permanent store. Persisting them would mean
   * carrying reactions for messages that may never arrive (a member who left, a
   * channel we lost the key to) with nothing to ever clear them.
   *
   * Bounded, because it is fed by the network -- a peer that spams reactions for
   * message ids that do not exist would otherwise grow this without limit.
   */
  const parkedReactions = useRef<
    { channelId: string; targetId: string; emoji: string; senderId: string; removed: boolean }[]
  >([]);
  const parkedMutations = useRef<ParkedMutation[]>([]);
  const MAX_PARKED = 200;

  const handleIncomingMessage = useCallback(async (data: Extract<Incoming, { type: 'message' }>) => {
    const v = vaultRef.current;
    if (!v) return false;

    const channel = v.getChannel(data.channelId);
    if (!channel?.hasKey) return false; // no key yet; leave it queued

    const contact = v.getContact(data.senderId);

    const { envelope, verified } = await openEnvelope(
      { ciphertext: data.ciphertext, nonce: data.nonce },
      channel.key,
      {
        senderId: data.senderId,
        channelId: data.channelId,
        signPublicKey: contact?.signPublicKey ?? null,
      }
    );

    if (contact?.keyChangedAt) handlers.current.onKeyChangeWarning?.(data.senderId);

    if (envelope.kind === 'profile') {
      // A profile update carries the peer's display name and avatar. It is
      // only allowed to move the pinned record if the signature checked out --
      // otherwise anyone with the channel key could rename anyone.
      if (verified) {
        await v.updateContactProfile(data.senderId, {
          displayName: envelope.displayName,
          avatar: envelope.avatar,
          bio: envelope.bio,
          background: envelope.background,
        });
        handlers.current.onChannelKey?.(data.channelId);
      }
      return true;
    }

    if (envelope.kind === 'reaction') {
      // Unverified reactions are dropped outright rather than shown with a
      // warning. A message body gets badged "unverified" because the user needs
      // to see what was said before judging it; a reaction is a single glyph
      // whose entire meaning is "this person reacted". If we cannot confirm the
      // person, there is nothing left worth rendering.
      if (!verified || !envelope.reaction) return true;

      const { targetId, emoji, removed } = envelope.reaction;
      const updated = await v.applyReactionToMessage(
        data.channelId,
        targetId,
        emoji,
        data.senderId,
        removed
      );

      // Null means the target has not arrived yet -- normal when a reaction was
      // queued while we were offline, or we joined mid-conversation. Park it so
      // it lands when the message does, instead of silently vanishing.
      if (updated === null) {
        // Drop the oldest rather than growing without bound: a peer can send
        // reactions for ids that will never exist.
        if (parkedReactions.current.length >= MAX_PARKED) parkedReactions.current.shift();
        parkedReactions.current.push({
          channelId: data.channelId,
          targetId,
          emoji,
          senderId: data.senderId,
          removed,
        });
      } else {
        handlers.current.onChannelKey?.(data.channelId);
      }
      return true;
    }

    if (envelope.kind === 'edit') {
      // An unverified edit is dropped, not shown: we cannot confirm who sent it,
      // and applying it would let a forged envelope rewrite someone's words.
      if (!verified || !envelope.edit) return true;
      const { targetId, body } = envelope.edit;
      const at = envelope.sentAt || data.createdAt;
      const updated = await v.editMessage(data.channelId, targetId, data.senderId, body, at);
      if (updated === null) {
        if (parkedMutations.current.length >= MAX_PARKED) parkedMutations.current.shift();
        parkedMutations.current.push({
          channelId: data.channelId,
          targetId,
          kind: 'edit',
          senderId: data.senderId,
          body,
          at,
        });
      } else {
        handlers.current.onChannelKey?.(data.channelId);
      }
      return true;
    }

    if (envelope.kind === 'delete') {
      if (!verified || !envelope.del) return true;
      const { targetId } = envelope.del;
      const updated = await v.deleteMessage(data.channelId, targetId, data.senderId);
      if (updated === null) {
        if (parkedMutations.current.length >= MAX_PARKED) parkedMutations.current.shift();
        parkedMutations.current.push({
          channelId: data.channelId,
          targetId,
          kind: 'delete',
          senderId: data.senderId,
        });
      } else {
        handlers.current.onChannelKey?.(data.channelId);
      }
      return true;
    }

    const message: StoredMessage = {
      // The sender's stable id, so this message matches the sender's own copy
      // (and thus their edits, deletes, and reactions). Falls back to the queue
      // id only for a client that did not send one.
      id: data.clientId ?? data.messageId,
      channelId: data.channelId,
      senderId: data.senderId,
      displayName: envelope.displayName,
      // A locked message arrives with an empty body and its sealed payload; it
      // stays unreadable until the recipient enters the code.
      body: envelope.body,
      asset: envelope.avatar,
      // Attachment keys, the preview, and the reply reference are all inside the
      // signature. If `verified` is false the UI badges the whole message as
      // untrusted, which covers these too -- a forged preview is a phishing
      // surface, and a forged reply target misattributes a conversation.
      attachments: envelope.attachments,
      preview: envelope.preview,
      replyTo: envelope.replyTo,
      locked: envelope.locked,
      protected: Boolean(envelope.locked),
      // The recipient's burn clock starts when the message is first shown, not
      // now -- so firstViewedAt is left unset for processBurns to stamp.
      burnTtl: envelope.burn?.ttl,
      spoiler: envelope.spoiler === true,
      // Only honour the crown on a verified message: an unverified one has no
      // trustworthy sender to attribute a badge to.
      supporterClaimed: verified && envelope.supporter === true,
      createdAt: envelope.sentAt || data.createdAt,
      verified,
    };

    await v.appendMessage(message);

    // A reaction, edit, or delete that arrived before its target can now land.
    await drainParked(parkedReactions, v, data.channelId, message.id);
    await drainMutations(parkedMutations, v, data.channelId, message.id);

    handlers.current.onMessage?.(message);
    return true;
  }, []);

  const handleIncomingSignal = useCallback(async (data: Extract<Incoming, { type: 'signal' }>) => {
    const v = vaultRef.current;
    if (!v) return;

    const channel = v.getChannel(data.channelId);
    if (!channel?.hasKey) return;

    const contact = v.getContact(data.senderId);
    const { envelope, verified } = await openEnvelope(
      { ciphertext: data.ciphertext, nonce: data.nonce },
      channel.key,
      {
        senderId: data.senderId,
        channelId: data.channelId,
        signPublicKey: contact?.signPublicKey ?? null,
      }
    );

    // A call frame is only honoured if the signature checks out. An unverified
    // one could ring a user with a fabricated peer or inject an SDP to steer the
    // media path -- both are dropped rather than surfaced.
    if (!verified || envelope.kind !== 'call' || !envelope.call) return;

    handlers.current.onSignal?.({
      channelId: data.channelId,
      senderId: data.senderId,
      signal: envelope.call,
    });
  }, []);

  const handleKeyOffer = useCallback(async (data: Extract<Incoming, { type: 'key-offer' }>) => {
    const v = vaultRef.current;
    if (!v) return false;

    const existing = v.getChannel(data.channelId);
    if (existing?.hasKey) return true; // already keyed; ack and move on

    // Pin the offering member's keys before trusting the offer. crypto_box is
    // authenticated, so unwrap only succeeds if the sender really holds the
    // private half of senderPubkey.
    await v.pinContact({
      userId: data.senderId,
      publicKey: data.senderPubkey,
      signPublicKey: data.senderSignPubkey,
    });

    const key = await unwrapChannelKey(
      { ciphertext: data.ciphertext, nonce: data.nonce },
      data.senderPubkey,
      v.identity.privateKey
    );

    await v.saveChannel({
      channelId: data.channelId,
      code: existing?.code ?? '',
      key,
      hasKey: true,
      joinedAt: existing?.joinedAt ?? new Date().toISOString(),
      label: existing?.label,
      icon: existing?.icon,
      // Preserve the incognito flag: dropping it here reverted a joiner to a
      // normal channel the moment the key arrived, leaking their real name.
      incognito: existing?.incognito,
      // Preserve DM metadata for the same reason -- for the DM peer this offer
      // arrives before the /channel/list reconcile that first set these, but on
      // a reconnect the fields are already local and must not be dropped.
      type: existing?.type,
      peerId: existing?.peerId,
      blocked: existing?.blocked,
    });

    handlers.current.onChannelKey?.(data.channelId);
    return true;
  }, []);

  // Someone in a channel we hold a key for needs that key. Wrap it for them.
  const offerKeyTo = useCallback(
    async (channelId: string, recipient: { userId: string; pubkey: string; signPubkey: string }) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !ws || ws.readyState !== ws.OPEN) return;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) return;

      await v.pinContact({
        userId: recipient.userId,
        publicKey: recipient.pubkey,
        signPublicKey: recipient.signPubkey,
      });

      const sealed = await wrapChannelKeyForRecipient(
        channel.key,
        recipient.pubkey,
        v.identity.privateKey
      );

      ws.send(JSON.stringify({
        type: 'key-offer',
        channelId,
        recipientId: recipient.userId,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
      }));
    },
    []
  );

  /**
   * Push display name + avatar to a channel, encrypted and signed.
   *
   * This is why the server never learns a username: identity travels inside
   * the same sealed envelope as the message body, addressed only to people who
   * already hold the channel key.
   *
   * Declared above the socket effect on purpose -- the effect's dependency
   * array is evaluated during render, so referencing a `const` declared below
   * it would throw a TDZ ReferenceError.
   */
  const broadcastProfile = useCallback(
    async (channelId: string) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId || !ws || ws.readyState !== ws.OPEN) return;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) return;
      // Incognito channels never receive a profile: no name, no avatar, ever.
      if (channel.incognito) return;

      const profile = v.profile;
      const sealed = await createEnvelope(
        {
          kind: 'profile',
          body: '',
          displayName: profile.displayName,
          avatar: profile.avatar,
          bio: profile.bio,
          background: profile.background,
          sentAt: new Date().toISOString(),
        },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      ws.send(JSON.stringify({
        type: 'send',
        channelId,
        kind: 'profile',
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
      }));
    },
    [userId]
  );

  useEffect(() => {
    if (!token || !userId) return;

    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;

      const ws = new WebSocket(api.wsUrl(), api.wsProtocols(token));
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setConnected(true);

        // Ask for keys for any channel we are a member of but cannot read --
        // new device, cleared storage, or a join whose offer never arrived
        // because nobody was online.
        const v = vaultRef.current;
        if (!v) return;
        for (const channel of v.listChannels()) {
          if (!channel.hasKey) {
            ws.send(JSON.stringify({ type: 'request-key', channelId: channel.channelId }));
          }
        }
      };

      ws.onmessage = async (event) => {
        let data: Incoming;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        try {
          switch (data.type) {
            case 'message': {
              const handled = await handleIncomingMessage(data);
              // Ack only after the plaintext is committed locally. Acking on
              // receipt would drop the server's copy while ours is still in
              // flight, losing the message on a crash.
              if (handled) ws.send(JSON.stringify({ type: 'ack', messageId: data.messageId }));
              break;
            }
            case 'key-offer': {
              const handled = await handleKeyOffer(data);
              if (handled) {
                ws.send(JSON.stringify({ type: 'key-ack', offerId: data.offerId }));
                // We can now read this channel. Publish our profile, and pull
                // the others' -- their earlier broadcasts fanned out before we
                // were a member, so we hold names but no avatars.
                await broadcastProfile(data.channelId);
                ws.send(JSON.stringify({ type: 'request-profile', channelId: data.channelId }));
              }
              break;
            }
            case 'key-request':
              await offerKeyTo(data.channelId, {
                userId: data.requesterId,
                pubkey: data.requesterPubkey,
                signPubkey: data.requesterSignPubkey,
              });
              break;
            case 'member-joined':
              // Anonymous notice first, then the real work: existing members
              // wrap the channel key for the joiner.
              handlers.current.onPresence?.({ channelId: data.channelId, event: 'joined' });
              await offerKeyTo(data.channelId, {
                userId: data.userId,
                pubkey: data.pubkey,
                signPubkey: data.signPubkey,
              });
              break;
            case 'member-left':
              handlers.current.onPresence?.({ channelId: data.channelId, event: 'left' });
              break;
            case 'typing':
              handlers.current.onTyping?.({
                channelId: data.channelId,
                senderId: data.senderId,
                stop: data.stop === true,
              });
              break;
            case 'signal':
              await handleIncomingSignal(data);
              break;
            case 'profile-request':
              // Answer only; never chain another request, or two clients would
              // trade profiles forever.
              await broadcastProfile(data.channelId);
              break;
            case 'dm-request':
              // A DM invitation just gained its first message. Nothing is
              // delivered yet -- just nudge the UI to refetch /channel/list so the
              // request appears. onChannelKey bumps the relay revision, which is
              // what the channel list reloads on.
              handlers.current.onChannelKey?.(data.channelId);
              break;
            default:
              break;
          }
        } catch (err) {
          // A single bad frame -- undecryptable, unpinned, malformed -- must
          // not take down the socket.
          console.warn(`relay ${data.type} failed:`, (err as Error).message);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Capped exponential backoff, so a server restart does not turn every
        // open tab into a reconnect storm.
        const delay = Math.min(30_000, 1000 * 2 ** retry++) + Math.random() * 500;
        timer = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token, userId, handleIncomingMessage, handleKeyOffer, handleIncomingSignal, offerKeyTo, broadcastProfile]);

  const send = useCallback(
    async (channelId: string, payload: SendPayload): Promise<StoredMessage | null> => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId) return null;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) throw new Error('no key for this channel yet');

      const sentAt = new Date().toISOString();
      const profile = v.profile;

      // Password-locked: the body is sealed under the code and the envelope
      // carries the ciphertext instead of plaintext. The channel encryption
      // still wraps the whole thing -- this is a second lock inside it.
      const locked = payload.lock
        ? await sealWithPassword(payload.body, payload.lock.code, payload.lock.hint)
        : undefined;

      const burn = payload.burn ? { ttl: payload.burn } : undefined;
      // Opt-in supporter crown. Never in incognito (it would deanonymise), and
      // omitted entirely when off so it does not sit as a signed 'false'.
      const supporter =
        !channel.incognito && v.preferences.showSupporterBadge ? true : undefined;

      const sealed = await createEnvelope(
        {
          kind: 'message',
          body: locked ? '' : payload.body,
          // Incognito channels carry no name; members are shown as colours only.
          displayName: channel.incognito ? '' : profile.displayName,
          avatar: payload.asset,
          attachments: payload.attachments,
          preview: payload.preview,
          replyTo: payload.replyTo,
          locked,
          burn,
          supporter,
          spoiler: payload.spoiler ? true : undefined,
          sentAt,
        },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      const clientId = crypto.randomUUID();

      if (ws?.readyState === ws?.OPEN) {
        ws?.send(JSON.stringify({
          type: 'send',
          channelId,
          clientId,
          kind: 'message',
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
        }));
      }

      // Our own copy. The relay only fans out to *other* members, so the
      // sender's transcript is written locally and is trivially verified. We
      // authored the locked body, so we keep the plaintext -- just flagged
      // `protected` for the lock indicator; only recipients have to unlock.
      const local: StoredMessage = {
        id: clientId,
        channelId,
        senderId: userId,
        displayName: profile.displayName,
        body: payload.body,
        asset: payload.asset,
        attachments: payload.attachments,
        preview: payload.preview,
        replyTo: payload.replyTo,
        protected: Boolean(locked),
        // Our own copy burns too, clocked from send -- we have already read it.
        burnTtl: payload.burn,
        firstViewedAt: payload.burn ? sentAt : undefined,
        spoiler: payload.spoiler || undefined,
        createdAt: sentAt,
        verified: true,
        pending: ws?.readyState !== WebSocket.OPEN,
      };
      await v.appendMessage(local);
      return local;
    },
    [userId]
  );

  /**
   * Toggle a reaction on a message.
   *
   * Sent as its own signed envelope, not a mutation of the target: the relay has
   * no message to mutate, only ciphertext it is routing, and the reaction has to
   * be attributable to whoever sent it. `removed` is signed too, so a relay
   * cannot replay an old "add" to undo someone's removal.
   *
   * The local copy is applied optimistically. If the socket is down the reaction
   * still shows locally but never reaches anyone -- the same tradeoff pending
   * messages already make, and the UI marks the connection state.
   */
  const sendReaction = useCallback(
    async (channelId: string, targetId: string, emoji: string, removed: boolean) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId) return;

      if (!isSingleEmoji(emoji)) throw new Error('reactions must be a single emoji');

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) throw new Error('no key for this channel yet');

      const sealed = await createEnvelope(
        {
          kind: 'reaction',
          body: '',
          displayName: channel.incognito ? '' : v.profile.displayName,
          reaction: { targetId, emoji, removed },
          sentAt: new Date().toISOString(),
        },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'send',
            channelId,
            clientId: crypto.randomUUID(),
            kind: 'reaction',
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
          })
        );
      }

      await v.applyReactionToMessage(channelId, targetId, emoji, userId, removed);
    },
    [userId]
  );

  /**
   * Tell a channel we're typing. Fire-and-forget presence: no local echo, no
   * persistence. The caller throttles; see Chat's composer. Silently a no-op
   * when the socket is down — a typing hint is never worth queuing.
   */
  const sendTyping = useCallback((channelId: string, stop = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'typing', channelId, stop }));
  }, []);

  /**
   * Edit a message we authored. Sends a signed 'edit' envelope and applies the
   * change locally. The author check lives in the vault on both ends, so this
   * can only ever change our own messages.
   */
  const editMessage = useCallback(
    async (channelId: string, targetId: string, body: string) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId) return;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) throw new Error('no key for this channel yet');

      const sentAt = new Date().toISOString();
      const sealed = await createEnvelope(
        {
          kind: 'edit',
          body: '',
          displayName: channel.incognito ? '' : v.profile.displayName,
          edit: { targetId, body },
          sentAt,
        },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'send',
            channelId,
            clientId: crypto.randomUUID(),
            kind: 'edit',
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
          })
        );
      }

      await v.editMessage(channelId, targetId, userId, body, sentAt);
    },
    [userId]
  );

  /** Delete a message we authored: a signed tombstone, applied locally too. */
  const deleteMessage = useCallback(
    async (channelId: string, targetId: string) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId) return;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) throw new Error('no key for this channel yet');

      const sealed = await createEnvelope(
        {
          kind: 'delete',
          body: '',
          displayName: channel.incognito ? '' : v.profile.displayName,
          del: { targetId },
          sentAt: new Date().toISOString(),
        },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'send',
            channelId,
            clientId: crypto.randomUUID(),
            kind: 'delete',
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
          })
        );
      }

      await v.deleteMessage(channelId, targetId, userId);
    },
    [userId]
  );

  /**
   * Send a WebRTC call-control frame to the DM peer.
   *
   * Wrapped in a signed 'call' envelope and relayed as ciphertext, so the server
   * routes it without seeing the SDP or candidates. Fire-and-forget: a call is
   * realtime, so a signal that cannot be sent (socket down) is simply dropped,
   * never queued.
   */
  const sendSignal = useCallback(
    async (channelId: string, signal: CallSignal) => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId || !ws || ws.readyState !== WebSocket.OPEN) return;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) return;

      const sealed = await createEnvelope(
        { kind: 'call', body: '', displayName: '', call: signal, sentAt: new Date().toISOString() },
        channelId,
        userId,
        v.identity.signPrivateKey,
        channel.key
      );

      ws.send(
        JSON.stringify({
          type: 'signal',
          channelId,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
        })
      );
    },
    [userId]
  );

  /**
   * Open (or re-open) a 1:1 DM with a peer, returning the channel id to navigate
   * to.
   *
   * Three cases, distinguished by what we hold locally and whether any keyed
   * peer exists (`created` = a brand-new room; `peerActive` = the peer is a full
   * member who holds the key):
   *  - already keyed here          -> just tag it as a DM.
   *  - new room, or no active peer  -> mint the channel key and wrap it for the
   *                                    peer. "No active peer" is the both-sides-
   *                                    left case: nobody holds the old key, so
   *                                    asking for it would hang forever ("waiting
   *                                    for the channel key") -- mint a fresh one.
   *  - peer is active, key not here -> new device, or only I left and re-opened:
   *                                    the peer still holds it, so ask them.
   */
  const openDirectMessage = useCallback(
    async (peerId: string): Promise<string | null> => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !token) return null;

      const res = await api.createDm(token, peerId);
      const existing = v.getChannel(res.channelId);

      if (existing?.hasKey) {
        await v.saveChannel({ ...existing, type: 'dm', peerId: res.peer.userId });
      } else if (res.created || !res.peerActive) {
        const key = await generateChannelKey();
        await v.saveChannel({
          channelId: res.channelId,
          code: '',
          key,
          hasKey: true,
          type: 'dm',
          peerId: res.peer.userId,
          joinedAt: new Date().toISOString(),
        });
        await offerKeyTo(res.channelId, {
          userId: res.peer.userId,
          pubkey: res.peer.pubkey,
          signPubkey: res.peer.signPubkey,
        });
      } else {
        await v.saveChannel({
          channelId: res.channelId,
          code: '',
          key: '',
          hasKey: false,
          type: 'dm',
          peerId: res.peer.userId,
          joinedAt: new Date().toISOString(),
        });
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'request-key', channelId: res.channelId }));
        }
      }

      handlers.current.onChannelKey?.(res.channelId);
      return res.channelId;
    },
    [token, offerKeyTo]
  );

  const broadcastProfileEverywhere = useCallback(async () => {
    const v = vaultRef.current;
    if (!v) return;
    for (const channel of v.listChannels()) {
      if (channel.hasKey) await broadcastProfile(channel.channelId);
    }
  }, [broadcastProfile]);

  return {
    connected,
    send,
    sendReaction,
    sendTyping,
    sendSignal,
    openDirectMessage,
    editMessage,
    deleteMessage,
    broadcastProfile,
    broadcastProfileEverywhere,
    offerKeyTo,
  };
}
