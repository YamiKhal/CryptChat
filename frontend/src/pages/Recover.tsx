import { useState, FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { generateSalt, RECOVERY_CODE_WORDS } from '../lib/crypto';
import { saveAccount, getAccount } from '../lib/vault';

/**
 * Password recovery, in the only shape that is honest.
 *
 * Two factors, and both are required, because each covers what the other cannot:
 *
 *   - the email proves you control the mailbox, which lets the server accept a
 *     new password;
 *   - the recovery code decrypts your keys, which the server has never held and
 *     cannot help with.
 *
 * A reset without the code produces a working login into an account with no
 * channels and no history. That is not a recovery, and presenting it as one is
 * how a user concludes the app ate their data. So the code step is part of this
 * flow rather than an optional extra afterwards.
 */

type Stage = 'request' | 'sent' | 'reset' | 'code' | 'done';

export default function Recover() {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');

  const [stage, setStage] = useState<Stage>(token ? 'reset' : 'request');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.requestReset(email.trim());
      // Always the same screen. The server will not say whether the address is
      // registered, and neither will we -- branching here would rebuild the
      // enumeration oracle the server went out of its way to avoid.
      setStage('sent');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('passwords do not match');
      return;
    }
    setBusy(true);
    try {
      // A fresh salt: the old vault is sealed under the old password and is not
      // coming back, so carrying its salt forward would imply a continuity that
      // does not exist.
      const vaultSalt = await generateSalt();
      const res = await api.resetPassword(token!, password, vaultSalt);

      // Park enough for the code step to run. The vault itself does not exist
      // yet -- it gets built from the recovery blob in the next stage.
      const existing = getAccount(res.userId);
      saveAccount({
        userId: res.userId,
        username: existing?.username ?? username.trim() ?? 'recovered',
        publicKey: res.pubkey,
        signPublicKey: res.signPubkey,
        vaultSalt: res.vaultSalt,
        lastUsedAt: new Date().toISOString(),
      });
      sessionStorage.setItem(`darkchat:tok:${res.userId}`, res.token);
      localStorage.setItem('darkchat:active', res.userId);

      session.selectAccount(res.userId);
      setStage('code');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCode(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await session.recoverWithCode(phrase, password);
      setStage('done');
      navigate('/channels');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const errorBox = error && (
    <p className="rounded border border-error/30 bg-error/10 p-4 text-xs text-error">{error}</p>
  );

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <header className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-primary">CryptChat</h1>
          <p className="text-xs text-muted">account recovery</p>
        </header>

        {stage === 'request' && (
          <form onSubmit={handleRequest} className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              Reset your password
            </h2>

            <label className="block space-y-1">
              <span className="text-xs text-muted">the email on your account</span>
              <input
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <p className="rounded border border-warn/30 bg-warn/10 p-4 text-xs text-warn">
              You will also need your 24-word recovery code. The email gets you back into the
              account; only the recovery code can decrypt your channels. Without it, the account
              comes back empty.
            </p>

            {errorBox}

            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'working…' : 'Send reset link'}
            </button>

            <Link to="/" className="block w-full text-center text-xs text-muted hover:text-foreground">
              back to log in
            </Link>
          </form>
        )}

        {stage === 'sent' && (
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Check your mail</h2>
            <p className="text-xs text-muted">
              If that address is attached to a verified account, a reset link is on its way. It
              expires in 30 minutes.
            </p>
            <p className="text-[11px] text-muted">
              We do not confirm whether an address has an account here — that would let anyone test
              who is registered.
            </p>
            <Link to="/" className="btn-ghost w-full text-center text-xs">
              back to log in
            </Link>
          </div>
        )}

        {stage === 'reset' && (
          <form onSubmit={handleReset} className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              Choose a new password
            </h2>

            <label className="block space-y-1">
              <span className="text-xs text-muted">new password</span>
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </label>

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

            <p className="text-xs text-muted">Minimum 12 characters. Next you will enter your recovery code.</p>

            {errorBox}

            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'working…' : 'Set password'}
            </button>
          </form>
        )}

        {stage === 'code' && (
          <form onSubmit={handleCode} className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              Your recovery code
            </h2>

            <p className="rounded border border-info/30 bg-info/10 p-4 text-xs text-info">
              Your password is reset. Enter the {RECOVERY_CODE_WORDS} words you saved when you
              registered to decrypt your channels. Your keys were never on our server — this code is
              the only thing that can unlock them.
            </p>

            <label className="block space-y-1">
              <span className="text-xs text-muted">{RECOVERY_CODE_WORDS} words, in order</span>
              <textarea
                className="field h-28 resize-none font-mono text-xs"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder="witch collapse practice feed shame open despair creek road again ice least"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            {errorBox}

            <button className="btn-primary w-full" disabled={busy || !phrase.trim()}>
              {busy ? 'decrypting…' : 'Restore my channels'}
            </button>

            <button
              type="button"
              className="w-full text-xs text-muted hover:text-foreground"
              onClick={() => navigate('/channels')}
            >
              I do not have my recovery code
            </button>

            <p className="text-[11px] text-muted">
              Continuing without it leaves you logged in with no channels and no history. Nothing
              can restore them later — not us, not a support ticket.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
