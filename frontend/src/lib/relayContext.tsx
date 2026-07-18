import { createContext, useContext, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useRelay } from './useRelay';
import { useSession } from './session';
import { StoredMessage } from './vault';
import type { CallSignal } from './crypto';

/** A decrypted, verified call-control frame for a DM, handed to the call layer. */
export interface IncomingSignal {
  channelId: string;
  senderId: string;
  signal: CallSignal;
}

/**
 * One relay socket for the whole app.
 *
 * Mounting useRelay per page would open a socket per route and tear it down on
 * every navigation -- dropping key offers that arrive while the user is on the
 * channel list, and losing the flushed queue each time.
 */

/**
 * Fallback lapse for a "typing" ping if no stop and no message arrives. Kept
 * just above the ~2.5s client send interval so a still-typing person does not
 * flicker, but short enough that a dropped stop clears quickly.
 */
const TYPING_TTL_MS = 4000;

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
  /**
   * Whether a contact is verified in THIS session. Deliberately ephemeral: it is
   * wiped when the socket drops, on relogin, and on any key change, so a stale
   * "verified" can never outlive the trust context it was established in.
   */
  isVerified: (userId: string) => boolean;
  setVerified: (userId: string, verified: boolean) => void;
  /**
   * Subscribe to incoming DM call frames. A subscription (not a `lastSignal`
   * state) so the call layer never misses a frame when an offer and its ICE
   * candidates arrive back-to-back. Returns an unsubscribe.
   */
  subscribeSignals: (fn: (event: IncomingSignal) => void) => () => void;
};

const RelayContext = createContext<RelayValue | null>(null);

export function RelayProvider({ children }: { children: ReactNode }) {
  const { vault, token, account } = useSession();
  const [revision, setRevision] = useState(0);
  const [lastMessage, setLastMessage] = useState<StoredMessage | null>(null);
  const [keyChangeWarnings, setKeyChangeWarnings] = useState<string[]>([]);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  // Lets onMessage clear a typing indicator without depending on dropTyping,
  // which is declared below it. Assigned once dropTyping exists.
  const dropTypingRef = useRef<((channelId: string, senderId: string) => void) | null>(null);

  const onMessage = useCallback(
    (message: StoredMessage) => {
      setLastMessage(message);
      // A message from someone is proof they stopped typing -- clear their
      // indicator now rather than waiting for the TTL or a separate stop frame.
      dropTypingRef.current?.(message.channelId, message.senderId);
      bump();
    },
    [bump]
  );

  // Ephemeral, session-scoped verification. Not the vault: verification is a
  // statement about the current connection's trust, and must not persist.
  const [verifiedContacts, setVerifiedContacts] = useState<Set<string>>(new Set());

  const setVerified = useCallback((userId: string, verified: boolean) => {
    setVerifiedContacts((cur) => {
      const next = new Set(cur);
      if (verified) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  const isVerified = useCallback((userId: string) => verifiedContacts.has(userId), [verifiedContacts]);

  const onKeyChangeWarning = useCallback((userId: string) => {
    setKeyChangeWarnings((current) => (current.includes(userId) ? current : [...current, userId]));
    // A changed key invalidates any verification for that contact immediately.
    setVerifiedContacts((cur) => {
      if (!cur.has(userId)) return cur;
      const next = new Set(cur);
      next.delete(userId);
      return next;
    });
  }, []);

  // channelId -> senderId -> expiry timer. A ref, not state: the timers are
  // bookkeeping, and only the derived list below drives rendering.
  const typingTimers = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());
  const [typing, setTyping] = useState<Record<string, string[]>>({});

  const dropTyping = useCallback((channelId: string, senderId: string) => {
    const timer = typingTimers.current.get(channelId)?.get(senderId);
    if (timer) clearTimeout(timer);
    typingTimers.current.get(channelId)?.delete(senderId);
    setTyping((cur) => {
      const list = (cur[channelId] ?? []).filter((id) => id !== senderId);
      return { ...cur, [channelId]: list };
    });
  }, []);
  dropTypingRef.current = dropTyping;

  const onTyping = useCallback(
    ({ channelId, senderId, stop }: { channelId: string; senderId: string; stop: boolean }) => {
      // An explicit stop retracts the indicator at once.
      if (stop) {
        dropTyping(channelId, senderId);
        return;
      }
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

  // Fan incoming call frames out to the call layer. A listener set, so no frame
  // is lost to React batching the way a single state value could be.
  const signalListeners = useRef<Set<(event: IncomingSignal) => void>>(new Set());
  const onSignal = useCallback((event: IncomingSignal) => {
    for (const listener of signalListeners.current) listener(event);
  }, []);
  const subscribeSignals = useCallback((fn: (event: IncomingSignal) => void) => {
    signalListeners.current.add(fn);
    return () => {
      signalListeners.current.delete(fn);
    };
  }, []);

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
    onSignal,
  });

  const typingIn = useCallback((channelId: string) => typing[channelId] ?? [], [typing]);

  // Wipe verification the moment the socket is not connected: a dropped
  // connection ends the session's trust context. On relogin, lock, or account
  // switch the whole provider unmounts, which clears this state anyway.
  useEffect(() => {
    if (!relay.connected) setVerifiedContacts(new Set());
  }, [relay.connected]);

  return (
    <RelayContext.Provider
      value={{
        ...relay,
        revision,
        lastMessage,
        keyChangeWarnings,
        typingIn,
        lastPresence,
        isVerified,
        setVerified,
        subscribeSignals,
      }}
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
