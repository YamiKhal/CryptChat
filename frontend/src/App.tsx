import { Routes, Route, Navigate } from 'react-router-dom';
import { ReactNode } from 'react';
import Auth from './pages/Auth';
import Channels from './pages/Channels';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import { useSession } from './lib/session';
import { RelayProvider } from './lib/relayContext';

function Restoring() {
  return (
    <div className="min-h-screen grid place-items-center">
      <p className="animate-pulse text-xs text-muted">unlocking…</p>
    </div>
  );
}

/**
 * Guards on `unlocked`, not on "has a token".
 *
 * A valid session token is not enough to render these screens: without an
 * unlocked vault there are no keys, so every channel would be an empty shell.
 * Anything short of unlocked goes back to the auth screen, which knows to show
 * an unlock prompt rather than a login form.
 *
 * `restoring` must not redirect. Session restore is async, so redirecting on
 * the first render would throw away the requested route on every refresh and
 * deep link.
 */
function RequireUnlocked({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === 'restoring') return <Restoring />;
  if (status !== 'unlocked') return <Navigate to="/" replace />;
  return <RelayProvider>{children}</RelayProvider>;
}

export default function App() {
  const { status } = useSession();

  if (status === 'restoring') return <Restoring />;

  return (
    <Routes>
      <Route path="/" element={status === 'unlocked' ? <Navigate to="/channels" replace /> : <Auth />} />
      <Route
        path="/channels"
        element={
          <RequireUnlocked>
            <Channels />
          </RequireUnlocked>
        }
      />
      <Route
        path="/chat/:channelId"
        element={
          <RequireUnlocked>
            <Chat />
          </RequireUnlocked>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireUnlocked>
            <Settings />
          </RequireUnlocked>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
