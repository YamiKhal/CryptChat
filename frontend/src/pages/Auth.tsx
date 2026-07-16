import { useState, FormEvent, useRef, ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { EncryptedBundle } from '../lib/crypto';
import Avatar from '../components/Avatar';

type Mode = 'login' | 'register';

export default function Auth() {
  const session = useSession();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [bundle, setBundle] = useState<EncryptedBundle | null>(null);
  const [bundlePassphrase, setBundlePassphrase] = useState('');
  const bundleInput = useRef<HTMLInputElement>(null);

  // A locked account means the keys are here but the vault is closed. That is
  // an unlock prompt, not a login form -- asking for a username again would be
  // nonsense.
  const locked = session.status === 'locked' && session.account !== null;

  // Correct credentials, but no vault on this device: the server never had the
  // private keys to return. Only an exported key file can fix this, so offer
  // that instead of a password prompt that cannot succeed.
  const needsImport = session.needsImport;

  function handleBundleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    file
      .text()
      .then((text) => setBundle(JSON.parse(text) as EncryptedBundle))
      .catch(() => setError('not a valid key file'));
  }

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!bundle) throw new Error('choose your key file first');
      await session.importIdentity(bundle, bundlePassphrase, password);
      navigate('/channels');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPassword('');
      setBundlePassphrase('');
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (mode === 'register' && password !== confirm) {
      setError('passwords do not match');
      return;
    }

    setBusy(true);
    try {
      if (locked) {
        await session.unlock(password, remember);
      } else if (mode === 'register') {
        await session.register(username, password);
      } else {
        await session.login(username, password, remember);
      }
      navigate('/channels');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPassword('');
      setConfirm('');
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <header className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-primary">CryptChat</h1>
          <p className="text-xs text-muted">
            end-to-end encrypted &middot; the server never learns your name
          </p>
        </header>

        {needsImport ? (
          <form onSubmit={handleImport} className="card space-y-4">
            <div className="flex items-center gap-3">
              <Avatar name={session.account!.username} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{session.account!.username}</p>
                <p className="text-xs text-warn">no keys on this device</p>
              </div>
            </div>

            <p className="rounded border border-info/30 bg-info/10 p-2 text-xs text-info">
              Your password is correct, but this device has none of your keys — the server never had
              them to give back. Import the key file you exported from your other device.
            </p>

            <input
              ref={bundleInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleBundleFile}
            />
            <button
              type="button"
              onClick={() => bundleInput.current?.click()}
              className="btn-ghost w-full text-xs"
            >
              {bundle ? 'key file loaded ✓' : 'choose key file'}
            </button>

            <label className="block space-y-1">
              <span className="text-xs text-muted">key file passphrase</span>
              <input
                className="field"
                type="password"
                value={bundlePassphrase}
                onChange={(e) => setBundlePassphrase(e.target.value)}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted">your account password</span>
              <input
                className="field"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {error && (
              <p className="rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
                {error}
              </p>
            )}

            <button className="btn-primary w-full" disabled={busy || !bundle}>
              {busy ? 'importing…' : 'Import keys'}
            </button>

            <button
              type="button"
              className="w-full text-xs text-muted hover:text-foreground"
              onClick={() => session.logout()}
            >
              use a different account
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="card space-y-4">
          {locked ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Avatar name={session.account!.username} size="md" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{session.account!.username}</p>
                  <p className="text-xs text-muted">vault locked</p>
                </div>
              </div>
              <p className="text-xs text-muted">
                Your password decrypts this device's keys. It is never sent for this step.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
                {mode === 'login' ? 'Log in' : 'Create identity'}
              </h2>
              <label className="block space-y-1">
                <span className="text-xs text-muted">username</span>
                <input
                  className="field"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="anon"
                />
              </label>
            </>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted">password</span>
            <input
              className="field"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </label>

          {mode === 'register' && !locked && (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-muted">confirm password</span>
                <input
                  className="field"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <p className="rounded border border-warn/30 bg-warn/10 p-2 text-xs text-warn">
                This password also encrypts your keys on this device. There is no reset: if you
                forget it, your channels are unrecoverable. Minimum 12 characters.
              </p>
            </>
          )}

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-primary"
            />
            keep unlocked in this tab
          </label>

          {error && (
            <p className="rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
              {error}
            </p>
          )}

          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'working…' : locked ? 'Unlock' : mode === 'login' ? 'Log in' : 'Register'}
          </button>

          {locked ? (
            <button
              type="button"
              className="w-full text-xs text-muted hover:text-foreground"
              onClick={() => session.logout()}
            >
              use a different account
            </button>
          ) : (
            <button
              type="button"
              className="w-full text-xs text-muted hover:text-foreground"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? 'No identity? Create one' : 'Have an identity? Log in'}
            </button>
          )}
        </form>
        )}

        {!locked && !needsImport && session.accounts.length > 0 && (
          <div className="card space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted">identities on this device</p>
            {session.accounts.map((account) => (
              <button
                key={account.userId}
                onClick={() => {
                  session.selectAccount(account.userId);
                  setUsername(account.username);
                  setMode('login');
                }}
                className="flex w-full items-center gap-3 rounded border border-border p-2 text-left
                           transition-colors hover:border-primary/50"
              >
                <Avatar name={account.username} size="sm" />
                <span className="flex-1 truncate text-sm">{account.username}</span>
                <span className="tag bg-surface-raised text-muted">locked</span>
              </button>
            ))}
            <p className="text-[11px] text-muted">
              Each identity has its own encrypted store. They cannot read each other.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
