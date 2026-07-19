import { Link } from 'react-router-dom';
import { Crown, ExternalLink } from 'lucide-react';
import Badge from './Badge';
import { SettingsSection, SettingBlock } from './SettingsUI';
import type { Badge as BadgeState } from '../lib/api';

/**
 * The Subscription panel in Settings.
 *
 * Extracted from Settings so it can be tested without standing up a vault, a
 * session, and a relay socket — none of which it touches. That mattered
 * immediately: the redeem field originally lived inside the "no badge" branch,
 * which silently made gift redemption unreachable for anyone who already had a
 * subscription. Nothing caught it, because there was nothing that could.
 *
 * Purely presentational. The parent owns the code, the busy flag, and the
 * status message.
 */

interface SubscriptionSectionProps {
  badge: BadgeState | null;
  /** Stripe's hosted portal login page; null when the deployment has not set it. */
  portalUrl: string | null;
  redeemCode: string;
  onCodeChange: (code: string) => void;
  onRedeem: () => void;
  busy: boolean;
}

export default function SubscriptionSection({
  badge,
  portalUrl,
  redeemCode,
  onCodeChange,
  onRedeem,
  busy,
}: SubscriptionSectionProps) {
  return (
    <SettingsSection
      title="Subscription"
      info="Your badge is the only record — no payment details are stored."
      infoDetails="Your badge is the only record. We store no payment details and your account is not linked to your payment in our database — the badge and the purchase are connected only by a random code you redeemed."
    >
      <SettingBlock>
        {badge ? (
          <>
            <p className="flex items-center gap-2 t-base">
              <Badge since={badge.since} size="md" withLabel />
              <span className="text-muted">
                since {new Date(badge.since).toLocaleDateString()}
              </span>
            </p>

            {badge.creditMonths ? (
              <p className="rounded border border-info-line bg-info-soft p-3 t-small text-info">
                <span className="font-medium">
                  {badge.creditMonths} gifted {badge.creditMonths === 1 ? 'month' : 'months'} in
                  reserve.
                </span>{' '}
                They are not counting down. They start automatically once nothing else is covering
                your account — so you never pay for time you were given.
              </p>
            ) : null}

            {portalUrl ? (
              <>
                <a
                  href={portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost block w-full text-center t-base"
                >
                  <span className="inline-flex items-center gap-1.5">
                    Manage or cancel
                    <ExternalLink size={11} aria-hidden="true" />
                  </span>
                </a>
                <p className="t-small text-muted">
                  Cancelling happens on Stripe, not here — enter the email you paid with and they
                  will send you a link. We cannot do it for you: we never stored who paid, which is
                  the point. Your badge stays until {new Date(badge.until).toLocaleDateString()}{' '}
                  either way — you paid for that time.
                </p>
              </>
            ) : (
              <p className="rounded border border-warn-line bg-warn-soft p-3 t-small text-warn">
                Cancellation is not configured on this deployment. Contact support to cancel.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="t-base text-muted">No subscription on this account.</p>

            <Link to="/subscribe" className="btn-primary block w-full text-center t-base">
              <span className="inline-flex items-center gap-1.5">
                <Crown size={13} className="fill-warn-soft" aria-hidden="true" />
                Become a supporter
              </span>
            </Link>

            <Link
              to="/subscribe"
              className="block w-full text-center t-small text-muted hover:text-foreground"
            >
              …or buy a gift code for someone
            </Link>
          </>
        )}
      </SettingBlock>

      {/*
        Outside the badge check, deliberately.
        Having a subscription is not a reason to be unable to redeem a code --
        being gifted months while subscribed is exactly the case the parked
        credit model exists for.
      */}
      <SettingBlock>
        <label className="block space-y-1">
          <span className="t-base text-muted">
            {badge ? 'Redeem another code' : 'Redemption code'}
          </span>
          <input
            className="field font-mono"
            value={redeemCode}
            onChange={(e) => onCodeChange(e.target.value)}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <button
          className="btn-ghost w-full t-base"
          disabled={busy || !redeemCode.trim()}
          onClick={onRedeem}
        >
          redeem
        </button>
        <p className="t-small text-muted">
          {badge
            ? 'Gifted months are held in reserve and start once nothing else is covering your account — you will not pay for time you were given.'
            : 'Subscriptions and gifts are bought logged out and redeemed with a code, so the payment is never tied to this account on our side.'}
        </p>
      </SettingBlock>
    </SettingsSection>
  );
}
