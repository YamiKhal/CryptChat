import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crown, Check, Loader2, Gift } from 'lucide-react';
import { api, Plan } from '../lib/api';

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

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [mode, setMode] = useState<'subscription' | 'gift'>('subscription');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (done) return;
    let cancelled = false;
    api
      .plans()
      .then((res) => {
        if (cancelled) return;
        setPlans(res.plans);
        // Default to the first subscription plan, so the button is never dead.
        setSelected(res.plans.find((p) => p.kind === 'subscription')?.slug ?? null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [done]);

  if (done) return <Done sessionId={sessionId} />;

  const shown = (plans ?? []).filter((p) => p.kind === mode);

  function pickMode(next: 'subscription' | 'gift') {
    setMode(next);
    // Carry the selection across tabs by duration where possible -- someone
    // eyeing a 3-month plan who switches to gifting most likely wants 3 months.
    const current = plans?.find((p) => p.slug === selected);
    const match = plans?.find((p) => p.kind === next && p.months === current?.months);
    setSelected(match?.slug ?? plans?.find((p) => p.kind === next)?.slug ?? null);
  }

  async function handleCheckout() {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      // A slug, never a price id. The server maps it.
      const { url } = await api.startCheckout(selected);
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
      <div className="w-full max-w-sm space-y-4 py-8">
        <header className="space-y-1 text-center">
          <h1 className="flex items-center justify-center gap-2 text-2xl font-bold tracking-tight text-primary">
            <Crown size={22} className="fill-warn-soft text-warn" aria-hidden="true" />
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
          {/* Subscribe vs gift. Different Stripe products, and genuinely
              different things: one renews, the other is a code you hand over. */}
          <div className="grid grid-cols-2 gap-1 rounded border border-border p-0.5">
            {(['subscription', 'gift'] as const).map((m) => (
              <button
                key={m}
                onClick={() => pickMode(m)}
                className={`rounded px-2 py-1.5 text-xs transition-colors ${
                  mode === m ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {m === 'gift' && <Gift size={12} aria-hidden="true" />}
                  {m === 'subscription' ? 'Subscribe' : 'Gift a code'}
                </span>
              </button>
            ))}
          </div>

          {plans === null && <p className="py-4 text-center text-xs text-muted">loading…</p>}

          {plans !== null && shown.length === 0 && (
            <p className="py-4 text-center text-xs text-muted">
              {mode === 'gift' ? 'Gift codes are not available yet.' : 'Nothing is on sale yet.'}
            </p>
          )}

          <div className="space-y-1.5">
            {shown.map((plan) => (
              <button
                key={plan.slug}
                onClick={() => setSelected(plan.slug)}
                className={`flex w-full items-center justify-between rounded border px-3 py-2.5
                  text-left transition-colors ${
                    selected === plan.slug
                      ? 'border-primary bg-primary-soft'
                      : 'border-border hover:border-primary-line'
                  }`}
              >
                <span className="text-sm">{plan.label}</span>
                <span className="text-[11px] text-muted">{plan.blurb}</span>
              </button>
            ))}
          </div>

          {mode === 'gift' && shown.length > 0 && (
            <p className="rounded border border-info-line bg-info-soft p-3 text-[11px] text-info">
              A gift is a code, not a subscription — nothing renews and there is nothing to cancel.
              The months start when it is <em>redeemed</em>, not today, so it keeps indefinitely. If
              whoever redeems it already has a subscription, the months are held in reserve and
              start once that subscription stops renewing. Nobody pays for time they were given.
            </p>
          )}
        </section>

        <section className="card space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-muted">how this works</h2>
          <ol className="space-y-2 text-[11px] text-muted">
            <li>
              <span className="text-foreground">1.</span> You pay without logging in. We never send
              your account to Stripe — we do not send one, because you are not logged in.
            </li>
            <li>
              <span className="text-foreground">2.</span> You get a redemption code by email.
            </li>
            <li>
              <span className="text-foreground">3.</span> {mode === 'gift' ? 'Whoever you give it to enters' : 'You enter'} the
              code in Settings. That is what turns the badge on.
            </li>
          </ol>
          <p className="rounded border border-info-line bg-info-soft p-3 text-[11px] text-info">
            We store no payment details, and our database holds no link between your payment and
            your account — only that <em>some</em> account redeemed <em>some</em> code. Stripe still
            knows who paid, as your card issuer does; anyone with access to both sides could match
            them up. We will not claim otherwise.
          </p>
        </section>

        {error && (
          <p className="rounded border border-error-line bg-error-soft p-4 text-xs text-error">{error}</p>
        )}

        <button
          onClick={handleCheckout}
          disabled={busy || !selected}
          className="btn-primary w-full"
        >
          {busy ? 'redirecting…' : mode === 'gift' ? 'Buy gift code' : 'Subscribe'}
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
              <Crown size={24} className="mx-auto fill-warn-soft text-warn" aria-hidden="true" />
              <p className="text-sm">Thank you — payment confirmed.</p>
              <p className="rounded border border-info-line bg-info-soft p-3 text-left text-[11px] text-info">
                Your code has been emailed to you. Enter it under{' '}
                <span className="font-medium">Settings → Subscription</span> — or pass it on, if it
                was a gift.
              </p>
              <p className="text-[11px] text-muted">
                We store only a hash of the code, so nobody — including us — can look it up or
                re-send it. Keep the email until it has been redeemed.
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
