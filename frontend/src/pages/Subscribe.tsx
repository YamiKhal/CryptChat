import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crown, Check, Loader2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Buying a subscription, deliberately while logged out.
 *
 * No session is attached to the checkout and no account identifier reaches
 * Stripe -- that is the entire point. The buyer gets a redemption code, and they
 * attach the badge themselves from Settings. See IDENTITY.md §3 and stripe.md.
 */

const PERKS = [
  { free: '20MB', premium: '50MB', label: 'File uploads' },
  { free: '1,000', premium: '4,000', label: 'Characters per message' },
  { free: null, premium: 'yes', label: 'Supporter crown' },
];

export default function Subscribe() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const done = window.location.pathname.endsWith('/done');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (done) return <Done sessionId={sessionId} />;

  async function handleCheckout() {
    setError('');
    setBusy(true);
    try {
      const { url } = await api.startCheckout();
      // Stripe-hosted: no card data ever touches this origin, which is why there
      // is no publishable key and no PCI surface here.
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <header className="space-y-1 text-center">
          <h1 className="flex items-center justify-center gap-2 text-2xl font-bold tracking-tight text-primary">
            <Crown size={22} className="fill-warn/25 text-warn" aria-hidden="true" />
            Supporter
          </h1>
          <p className="text-xs text-muted">keeps the relay running</p>
        </header>

        <section className="card space-y-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted">
                <th className="pb-2 text-left font-normal"> </th>
                <th className="pb-2 text-right font-normal">free</th>
                <th className="pb-2 text-right font-normal text-warn">supporter</th>
              </tr>
            </thead>
            <tbody>
              {PERKS.map((perk) => (
                <tr key={perk.label} className="border-t border-border">
                  <td className="py-2 text-muted">{perk.label}</td>
                  <td className="py-2 text-right tabular-nums">{perk.free ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums text-warn">
                    {perk.premium === 'yes' ? (
                      <Check size={13} className="ml-auto" aria-label="included" />
                    ) : (
                      perk.premium
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-muted">how this works</h2>
          <ol className="space-y-2 text-[11px] text-muted">
            <li>
              <span className="text-foreground">1.</span> You pay without logging in. We never send
              your account to Stripe — we do not send one, because you are not logged in.
            </li>
            <li>
              <span className="text-foreground">2.</span> You get a redemption code, by email and on
              the next screen.
            </li>
            <li>
              <span className="text-foreground">3.</span> You enter the code in Settings. That is
              what turns the badge on.
            </li>
          </ol>
          <p className="rounded border border-info/30 bg-info/10 p-3 text-[11px] text-info">
            We store no payment details, and our database holds no link between your payment and
            your account — only that <em>some</em> account redeemed <em>some</em> code. Stripe still
            knows who paid, as your card issuer does; anyone with access to both sides could match
            them up. We will not claim otherwise.
          </p>
        </section>

        {error && (
          <p className="rounded border border-error/30 bg-error/10 p-4 text-xs text-error">{error}</p>
        )}

        <button onClick={handleCheckout} disabled={busy} className="btn-primary w-full">
          {busy ? 'redirecting…' : 'Subscribe'}
        </button>

        <Link to="/" className="block text-center text-xs text-muted hover:text-foreground">
          back
        </Link>
      </div>
    </div>
  );
}

/**
 * The post-payment screen.
 *
 * The browser redirect and Stripe's webhook race, by design. This polls rather
 * than assuming the entitlement exists: the webhook is the source of truth, and
 * it may land after the redirect.
 */
function Done({ sessionId }: { sessionId: string | null }) {
  const [state, setState] = useState<'waiting' | 'ready' | 'error'>('waiting');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setState('error');
      setMessage('This link is missing its session.');
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await api.redemptionCode(sessionId);

        // `pending` (HTTP 202) means the webhook has not landed yet. It is a
        // success status, so this arrives as a resolved value, not a throw --
        // the payment is already done and the entitlement is coming.
        if (res.pending) {
          if (attempts++ < 15) setTimeout(poll, 2000);
          else if (!cancelled) {
            setState('error');
            setMessage(
              'Your payment went through, but confirmation is taking longer than usual. Your code will still arrive by email.'
            );
          }
          return;
        }

        if (!cancelled) setState('ready');
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setMessage((err as Error).message);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="card space-y-4 text-center">
          {state === 'waiting' && (
            <>
              <Loader2 size={20} className="mx-auto animate-spin text-primary" aria-hidden="true" />
              <p className="text-sm">Confirming your payment…</p>
              <p className="text-[11px] text-muted">
                This can take a few seconds. Your payment already went through — do not pay again.
              </p>
            </>
          )}

          {state === 'ready' && (
            <>
              <Crown size={24} className="mx-auto fill-warn/25 text-warn" aria-hidden="true" />
              <p className="text-sm">Thank you — payment confirmed.</p>
              <p className="rounded border border-info/30 bg-info/10 p-3 text-left text-[11px] text-info">
                Your redemption code has been emailed to you. Log in, then enter it under{' '}
                <span className="font-medium">Settings → Subscription</span> to turn on your badge.
              </p>
              <p className="text-[11px] text-muted">
                We can only show the code once and we store just a hash of it, so nobody — including
                us — can look it up later. Keep the email until you have redeemed it.
              </p>
            </>
          )}

          {state === 'error' && (
            <>
              <p className="text-sm text-error">Something went wrong.</p>
              <p className="text-xs text-muted">{message}</p>
              <p className="text-[11px] text-muted">
                If you were charged, your code is on its way by email regardless — the payment and
                this page are independent.
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
