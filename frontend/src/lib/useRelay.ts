import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Vault } from '@/lib/vault';
import {
  RelayOptions,
  RelayHandlers,
  RelayRefs,
  Incoming,
  ParkedReaction,
  ParkedMutation,
} from '@/lib/relay/types';
import { useRelayInbound } from '@/lib/relay/useRelayInbound';
import { useRelayOutbound } from '@/lib/relay/useRelayOutbound';

export type { SendPayload } from '@/lib/relay/types';

/**
 * Relay socket: delivery, and the key exchange that makes joining work.
 *
 * The server routes ciphertext and never holds a channel key. When someone
 * joins with a code, the server can only announce them; an existing member
 * has to wrap the channel key for the joiner's public key and send it back
 * through the relay. That handshake was the missing piece -- join used to
 * register membership and stop, so a joiner reached a channel it could never
 * decrypt.
 *
 * The heavy lifting lives in two sub-hooks: `useRelayInbound` (decrypt-and-apply
 * per server frame) and `useRelayOutbound` (sending). This file owns the socket
 * lifecycle and the shared refs both halves read.
 */
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
  const handlers = useRef<RelayHandlers>({ onMessage, onChannelKey, onKeyChangeWarning, onTyping, onPresence, onSignal });
  handlers.current = { onMessage, onChannelKey, onKeyChangeWarning, onTyping, onPresence, onSignal };
  const vaultRef = useRef<Vault | null>(vault);
  vaultRef.current = vault;

  // Reactions/mutations whose target message has not arrived yet. In-memory and
  // bounded, since the network feeds them (see types.ts).
  const parkedReactions = useRef<ParkedReaction[]>([]);
  const parkedMutations = useRef<ParkedMutation[]>([]);

  const refs: RelayRefs = { wsRef, vaultRef, handlers, parkedReactions, parkedMutations };

  const {
    handleIncomingMessage,
    handleIncomingSignal,
    handleKeyOffer,
    offerKeyTo,
    broadcastProfile,
  } = useRelayInbound(refs, userId);

  const outbound = useRelayOutbound(refs, userId, token, offerKeyTo, broadcastProfile);

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

  return {
    connected,
    ...outbound,
    broadcastProfile,
    offerKeyTo,
  };
}
