import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import {
  createEnvelope,
  openEnvelope,
  wrapChannelKeyForRecipient,
  unwrapChannelKey,
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
}

export interface SendPayload {
  body: string;
  asset?: BinaryAsset;
}

type Incoming =
  | { type: 'message'; messageId: string; channelId: string; senderId: string; kind: 'message' | 'profile'; ciphertext: string; nonce: string; createdAt: string }
  | { type: 'key-offer'; offerId: string; channelId: string; senderId: string; senderPubkey: string; senderSignPubkey: string; ciphertext: string; nonce: string }
  | { type: 'key-request'; channelId: string; requesterId: string; requesterPubkey: string; requesterSignPubkey: string }
  | { type: 'member-joined'; channelId: string; userId: string; pubkey: string; signPubkey: string }
  | { type: 'profile-request'; channelId: string; requesterId: string }
  | { type: 'sent'; clientId: string; channelId: string }
  | { type: 'key-offer-sent'; channelId: string; recipientId: string };

export function useRelay({
  vault,
  token,
  userId,
  onMessage,
  onChannelKey,
  onKeyChangeWarning,
}: RelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  // Handlers change every render; the socket must not.
  const handlers = useRef({ onMessage, onChannelKey, onKeyChangeWarning });
  handlers.current = { onMessage, onChannelKey, onKeyChangeWarning };
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

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
        });
        handlers.current.onChannelKey?.(data.channelId);
      }
      return true;
    }

    const message: StoredMessage = {
      id: data.messageId,
      channelId: data.channelId,
      senderId: data.senderId,
      displayName: envelope.displayName,
      body: envelope.body,
      asset: envelope.avatar,
      createdAt: envelope.sentAt || data.createdAt,
      verified,
    };

    await v.appendMessage(message);
    handlers.current.onMessage?.(message);
    return true;
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

      const profile = v.profile;
      const sealed = await createEnvelope(
        {
          kind: 'profile',
          body: '',
          displayName: profile.displayName,
          avatar: profile.avatar,
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
              await offerKeyTo(data.channelId, {
                userId: data.userId,
                pubkey: data.pubkey,
                signPubkey: data.signPubkey,
              });
              break;
            case 'profile-request':
              // Answer only; never chain another request, or two clients would
              // trade profiles forever.
              await broadcastProfile(data.channelId);
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
  }, [token, userId, handleIncomingMessage, handleKeyOffer, offerKeyTo, broadcastProfile]);

  const send = useCallback(
    async (channelId: string, payload: SendPayload): Promise<StoredMessage | null> => {
      const v = vaultRef.current;
      const ws = wsRef.current;
      if (!v || !userId) return null;

      const channel = v.getChannel(channelId);
      if (!channel?.hasKey) throw new Error('no key for this channel yet');

      const sentAt = new Date().toISOString();
      const profile = v.profile;

      const sealed = await createEnvelope(
        {
          kind: 'message',
          body: payload.body,
          displayName: profile.displayName,
          avatar: payload.asset,
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
      // sender's transcript is written locally and is trivially verified.
      const local: StoredMessage = {
        id: clientId,
        channelId,
        senderId: userId,
        displayName: profile.displayName,
        body: payload.body,
        asset: payload.asset,
        createdAt: sentAt,
        verified: true,
        pending: ws?.readyState !== WebSocket.OPEN,
      };
      await v.appendMessage(local);
      return local;
    },
    [userId]
  );

  const broadcastProfileEverywhere = useCallback(async () => {
    const v = vaultRef.current;
    if (!v) return;
    for (const channel of v.listChannels()) {
      if (channel.hasKey) await broadcastProfile(channel.channelId);
    }
  }, [broadcastProfile]);

  return { connected, send, broadcastProfile, broadcastProfileEverywhere, offerKeyTo };
}
