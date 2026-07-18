import { Routes, Route, Navigate } from 'react-router-dom';
import { ReactNode } from 'react';
import Auth from './pages/Auth';
import Channels from './pages/Channels';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import Recover from './pages/Recover';
import VerifyEmail from './pages/VerifyEmail';
import Subscribe from './pages/Subscribe';
import { useSession } from './lib/session';
import { RelayProvider } from './lib/relayContext';
import { CallProvider } from './lib/callContext';
import CallOverlay from './components/CallOverlay';

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
 *
 * The relay socket and call layer live above the router (see App), not here, so
 * navigating between the channel list and a DM does not tear down the socket --
 * which would drop an in-progress call and re-request every channel key.
 */
function RequireUnlocked({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === 'restoring') return <Restoring />;
  if (status !== 'unlocked') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { status } = useSession();

  if (status === 'restoring') return <Restoring />;

  const routes = (
    <Routes>
      <Route path="/" element={status === 'unlocked' ? <Navigate to="/channels" replace /> : <Auth />} />

      {/*
        Both are reachable logged out, and must stay that way. Recovery is for
        people who cannot log in -- guarding it behind a session would make it
        unreachable exactly when it is needed. Confirmation links routinely open
        in a different browser than the one holding the vault.
      */}
      <Route path="/reset-password" element={<Recover />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="/verify-email" element={<VerifyEmail />} />

      {/*
        Checkout is reachable logged out, and must be: attaching a session to a
        purchase is exactly the payment-to-account link the design avoids. The
        buyer redeems a code afterwards instead.
      */}
      <Route path="/subscribe" element={<Subscribe />} />
      <Route path="/subscribe/done" element={<Subscribe />} />

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

  // One relay socket and one call layer for the whole authenticated session,
  // mounted above the router so they survive navigation. RelayProvider tolerates
  // a logged-out render (it just does not connect), but there is no reason to pay
  // for it until the vault is unlocked.
  if (status === 'unlocked') {
    return (
      <RelayProvider>
        <CallProvider>
          {routes}
          <CallOverlay />
        </CallProvider>
      </RelayProvider>
    );
  }

  return routes;
}
