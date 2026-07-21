import { useCallback } from 'react';
import { api } from '@/lib/api';
import {
  createEnvelope,
  generateChannelKey,
  isSingleEmoji,
  sealWithPassword,
  CallSignal,
} from '@/lib/crypto';
import { StoredMessage } from '@/lib/vault';
import { RelayRefs, SendPayload } from '@/lib/relay/types';

type OfferKeyTo = (
  channelId: string,
  recipient: { userId: string; pubkey: string; signPubkey: string },
) => Promise<void>;
type BroadcastProfile = (channelId: string) => Promise<void>;

/**
 * The relay's outbound half: sending messages, reactions, edits, deletes, typing
 * pings, call signals, and opening DMs. Takes the socket refs plus the two
 * inbound helpers it composes with (`offerKeyTo`, `broadcastProfile`).
 */
export function useRelayOutbound(
  refs: RelayRefs,
  userId: string | null,
  token: string | null,
  offerKeyTo: OfferKeyTo,
  broadcastProfile: BroadcastProfile,
) {
  const { vaultRef, wsRef, handlers } = refs;

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
    send,
    sendReaction,
    sendTyping,
    editMessage,
    deleteMessage,
    sendSignal,
    openDirectMessage,
    broadcastProfileEverywhere,
  };
}
