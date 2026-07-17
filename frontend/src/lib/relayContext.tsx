import { createContext, useContext, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useRelay } from './useRelay';
import { useSession } from './session';
import { StoredMessage } from './vault';

/**
 * One relay socket for the whole app.
 *
 * Mounting useRelay per page would open a socket per route and tear it down on
 * every navigation -- dropping key offers that arrive while the user is on the
 * channel list, and losing the flushed queue each time.
 */

/** How long a "typing" ping keeps someone in the list before it lapses. */
const TYPING_TTL_MS = 6000;

export interface PresenceEvent {
  channelId: string;
  event: 'joined' | 'left';
  /** Bumped every event so a repeat of the same kind still retriggers a subscriber. */
  nonce: number;
}

type RelayValue = ReturnType<typeof useRelay> & {
  /** Bumped whenever vault-backed state changes, so screens can re-read. */
  revision: number;
  lastMessage: StoredMessage | null;
  keyChangeWarnings: string[];
  /** senderIds currently shown as typing in a channel. Ephemeral. */
  typingIn: (channelId: string) => string[];
  /** The most recent anonymous join/leave notice, for whichever channel is open. */
  lastPresence: PresenceEvent | null;
};

const RelayContext = createContext<RelayValue | null>(null);

export function RelayProvider({ children }: { children: ReactNode }) {
  const { vault, token, account } = useSession();
  const [revision, setRevision] = useState(0);
  const [lastMessage, setLastMessage] = useState<StoredMessage | null>(null);
  const [keyChangeWarnings, setKeyChangeWarnings] = useState<string[]>([]);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  const onMessage = useCallback(
    (message: StoredMessage) => {
      setLastMessage(message);
      bump();
    },
    [bump]
  );

  const onKeyChangeWarning = useCallback((userId: string) => {
    setKeyChangeWarnings((current) => (current.includes(userId) ? current : [...current, userId]));
  }, []);

  // channelId -> senderId -> expiry timer. A ref, not state: the timers are
  // bookkeeping, and only the derived list below drives rendering.
  const typingTimers = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());
  const [typing, setTyping] = useState<Record<string, string[]>>({});

  const dropTyping = useCallback((channelId: string, senderId: string) => {
    typingTimers.current.get(channelId)?.delete(senderId);
    setTyping((cur) => {
      const list = (cur[channelId] ?? []).filter((id) => id !== senderId);
      return { ...cur, [channelId]: list };
    });
  }, []);

  const onTyping = useCallback(
    ({ channelId, senderId }: { channelId: string; senderId: string }) => {
      let chan = typingTimers.current.get(channelId);
      if (!chan) {
        chan = new Map();
        typingTimers.current.set(channelId, chan);
      }
      const existing = chan.get(senderId);
      if (existing) clearTimeout(existing);
      chan.set(
        senderId,
        setTimeout(() => dropTyping(channelId, senderId), TYPING_TTL_MS)
      );
      setTyping((cur) => {
        const list = cur[channelId] ?? [];
        return list.includes(senderId) ? cur : { ...cur, [channelId]: [...list, senderId] };
      });
    },
    [dropTyping]
  );

  const [lastPresence, setLastPresence] = useState<PresenceEvent | null>(null);
  const presenceNonce = useRef(0);

  const onPresence = useCallback(
    ({ channelId, event }: { channelId: string; event: 'joined' | 'left' }) => {
      setLastPresence({ channelId, event, nonce: ++presenceNonce.current });
    },
    []
  );

  // Clear every pending timer if the provider unmounts (lock/logout), so a
  // stale timer never fires against an unmounted tree.
  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const chan of timers.values()) for (const t of chan.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const relay = useRelay({
    vault,
    token,
    userId: account?.userId ?? null,
    onMessage,
    onChannelKey: bump,
    onKeyChangeWarning,
    onTyping,
    onPresence,
  });

  const typingIn = useCallback((channelId: string) => typing[channelId] ?? [], [typing]);

  return (
    <RelayContext.Provider
      value={{ ...relay, revision, lastMessage, keyChangeWarnings, typingIn, lastPresence }}
    >
      {children}
    </RelayContext.Provider>
  );
}

export function useRelayContext(): RelayValue {
  const ctx = useContext(RelayContext);
  if (!ctx) throw new Error('useRelayContext must be used inside RelayProvider');
  return ctx;
}
