import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crown, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import InfoBox from '@/components/ui/InfoBox';
import PerksComparison from '@/components/settings/billing/PerksComparison';
import PlanPicker from '@/components/settings/billing/PlanPicker';

/**
 * Buying a subscription, deliberately while logged out.
 *
 * No session is attached to the checkout and no account identifier reaches
 * Stripe -- that is the entire point. The buyer gets a redemption code, and they
 * attach the badge themselves from Settings. See IDENTITY.md §3 and stripe.md.
 *
 * The perks table and the plan picker are the same components Settings uses, so
 * the two surfaces cannot drift. This page adds only the logged-out framing and
 * the post-payment confirmation.
 */

export default function Subscribe() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const done = window.location.pathname.endsWith('/done');

  if (done) return <Done sessionId={sessionId} />;

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4 py-8">
        <header className="space-y-1 text-center">
          <h1 className="flex items-center justify-center gap-2 t-h1 font-bold tracking-tight text-primary">
            <Crown size={22} className="fill-warn-soft text-warn" aria-hidden="true" />
            Supporter
          </h1>
          <p className="t-base text-muted">keeps the relay running</p>
        </header>

        <section className="card">
          <PerksComparison />
        </section>

        <section className="card">
          <PlanPicker />
        </section>

        <section className="card space-y-3">
          <h2 className="t-base uppercase tracking-wider text-muted">how this works</h2>
          <ol className="space-y-2 t-small text-muted">
            <li>
              <span className="text-foreground">1.</span> You pay without logging in. We never send
              your account to Stripe — we do not send one, because you are not logged in.
            </li>
            <li>
              <span className="text-foreground">2.</span> You get a redemption code by email.
            </li>
            <li>
              <span className="text-foreground">3.</span> You (or whoever you gift it to) enter the
              code in Settings. That is what turns the badge on.
            </li>
          </ol>
          <InfoBox>
            We store no payment details, and our database holds no link between your payment and
            your account — only that <em>some</em> account redeemed <em>some</em> code. Stripe still
            knows who paid, as your card issuer does; anyone with access to both sides could match
            them up. We will not claim otherwise.
          </InfoBox>
        </section>

        <Link to="/login" className="block text-center t-base text-muted hover:text-foreground">
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
              <p className="t-h4">Confirming your payment…</p>
              <p className="t-small text-muted">
                This can take a few seconds. Your payment already went through — do not pay again.
              </p>
            </>
          )}

          {state === 'ready' && (
            <>
              <Crown size={24} className="mx-auto fill-warn-soft text-warn" aria-hidden="true" />
              <p className="t-h4">Thank you — payment confirmed.</p>
              <InfoBox className="text-left">
                Your code has been emailed to you. Enter it under{' '}
                <span className="font-medium">Settings → Subscription</span> — or pass it on, if it
                was a gift.
              </InfoBox>
              <p className="t-small text-muted">
                We store only a hash of the code, so nobody — including us — can look it up or
                re-send it. Keep the email until it has been redeemed.
              </p>
            </>
          )}

          {state === 'error' && (
            <>
              <p className="t-h4 text-error">Something went wrong.</p>
              <p className="t-base text-muted">{message}</p>
              <p className="t-small text-muted">
                If you were charged, your code is on its way by email regardless — the payment and
                this page are independent.
              </p>
            </>
          )}

          <Link to="/login" className="btn-ghost w-full text-center t-base">
            continue
          </Link>
        </div>
      </div>
    </div>
  );
}
