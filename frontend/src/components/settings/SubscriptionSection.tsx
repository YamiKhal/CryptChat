import { ExternalLink } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import InfoBox from '@/components/ui/InfoBox';
import { SettingsSection, SettingBlock } from '@/components/settings/SettingsUI';
import CreditCounter from '@/components/settings/billing/CreditCounter';
import PerksComparison from '@/components/settings/billing/PerksComparison';
import PlanPicker from '@/components/settings/billing/PlanPicker';
import type { Badge as BadgeState } from '@/lib/api';

/**
 * The whole subscription surface, in Settings.
 *
 * This is the merged home for everything billing: current status, the banked-gift
 * counter, the free-vs-supporter comparison, buying or gifting a plan, and
 * redeeming a code. The standalone /subscribe page still exists for buying while
 * logged out, but a signed-in user never has to leave Settings.
 *
 * Presentational for the parts the parent owns -- the redeem field's code, busy
 * flag, and status message. The perks table, plan picker, and credit counter are
 * self-contained: the picker fetches plans and drives its own anonymous checkout,
 * so nothing about buying is wired through here.
 *
 * The redeem field lives OUTSIDE the badge check, deliberately. It once sat
 * inside the "no badge" branch, which made gift redemption unreachable for a
 * subscriber -- the exact person the parked-credit model exists for.
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
  const active = Boolean(badge);

  return (
    <>
      {/* --- Subscription: status + the banked-gift counter. Always shown, so
          the mechanic is never invisible. --- */}
      <SettingsSection
        title="Subscription"
        info="Your badge is the only record — no payment details are stored."
        infoDetails="Your badge is the only record. We store no payment details and your account is not linked to your payment in our database — the badge and the purchase are connected only by a random code you redeemed."
      >
        <SettingBlock>
          {badge ? (
            <p className="flex items-center gap-2 t-base">
              <Badge since={badge.since} size="md" withLabel />
              <span className="text-muted">
                since {new Date(badge.since).toLocaleDateString()}
              </span>
            </p>
          ) : (
            <p className="t-base text-muted">Free account — no subscription active.</p>
          )}

          <CreditCounter creditMonths={badge?.creditMonths} />

          {badge &&
            (portalUrl ? (
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
              <InfoBox variant="warn">
                Cancellation is not configured on this deployment. Contact support to cancel.
              </InfoBox>
            ))}
        </SettingBlock>
      </SettingsSection>

      {/* --- Plans: what supporter is, and how to buy or gift it. A subscriber
          sees only gifting -- a second recurring plan would double-bill, but
          banking a gift is fine. --- */}
      <SettingsSection title="Plans">
        <SettingBlock>
          <PerksComparison premium={active} />
        </SettingBlock>
        <SettingBlock>
          <PlanPicker giftOnly={active} />
        </SettingBlock>
      </SettingsSection>

      {/* --- Redeem code, for everyone. It sits outside any badge check on
          purpose: see the class comment. --- */}
      <SettingsSection title="Redeem code">
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
    </>
  );
}
