import { useEffect, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

/**
 * Consumes an email confirmation link.
 *
 * Deliberately works without a session: the link often opens in a different
 * browser (a phone, a mail client's webview) than the one holding the vault, and
 * demanding a login here would strand the user. The token is the credential.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('');
  const [mask, setMask] = useState('');

  // The token is single-use, so React 18's double-invoked effect in StrictMode
  // would consume it on the first pass and report "invalid link" on the second.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    if (!token) {
      setState('error');
      setMessage('This link is missing its token.');
      return;
    }

    api
      .verifyEmail(token)
      .then((res) => {
        setMask(res.mask);
        setState('ok');
      })
      .catch((err) => {
        setState('error');
        setMessage((err as Error).message);
      });
  }, [token]);

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <header className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-primary">CryptChat</h1>
        </header>

        <div className="card space-y-4 text-center">
          {state === 'working' && <p className="animate-pulse text-xs text-muted">confirming…</p>}

          {state === 'ok' && (
            <>
              <p className="text-sm">Address confirmed.</p>
              <p className="font-mono text-xs text-muted">{mask}</p>
              <p className="text-[11px] text-muted">
                You can now reset your password by mail if you forget it. You will still need your
                recovery code to decrypt your channels.
              </p>
            </>
          )}

          {state === 'error' && (
            <>
              <p className="text-sm text-error">Could not confirm this address.</p>
              <p className="text-xs text-muted">{message}</p>
              <p className="text-[11px] text-muted">
                Links expire after 24 hours and work once. Request a new one from Settings.
              </p>
            </>
          )}

          <Link to="/" className="btn-ghost w-full text-center text-xs">
            continue
          </Link>
        </div>
      </div>
    </div>
  );
}
