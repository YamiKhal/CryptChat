import { createContext, useContext, ReactNode, useCallback, useState } from 'react';
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

type RelayValue = ReturnType<typeof useRelay> & {
  /** Bumped whenever vault-backed state changes, so screens can re-read. */
  revision: number;
  lastMessage: StoredMessage | null;
  keyChangeWarnings: string[];
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

  const relay = useRelay({
    vault,
    token,
    userId: account?.userId ?? null,
    onMessage,
    onChannelKey: bump,
    onKeyChangeWarning,
  });

  return (
    <RelayContext.Provider value={{ ...relay, revision, lastMessage, keyChangeWarnings }}>
      {children}
    </RelayContext.Provider>
  );
}

export function useRelayContext(): RelayValue {
  const ctx = useContext(RelayContext);
  if (!ctx) throw new Error('useRelayContext must be used inside RelayProvider');
  return ctx;
}
