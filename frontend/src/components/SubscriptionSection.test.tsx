import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionSection from './SubscriptionSection';
import type { Badge } from '../lib/api';

/**
 * The Subscription panel.
 *
 * The first test here is a regression: the redeem field used to live inside the
 * "no badge" branch, so a subscriber could not redeem a gift code at all -- the
 * one group the parked-credit model was built for. The backend supported it
 * perfectly; the UI simply never showed the input.
 */

const active: Badge = {
  active: true,
  since: '2026-01-15T00:00:00.000Z',
  until: '2026-12-15T00:00:00.000Z',
};

function renderSection(props: Partial<React.ComponentProps<typeof SubscriptionSection>> = {}) {
  const onRedeem = vi.fn();
  const onCodeChange = vi.fn();

  render(
    <MemoryRouter>
      <SubscriptionSection
        badge={null}
        portalUrl="https://billing.stripe.com/p/login/test"
        redeemCode=""
        onCodeChange={onCodeChange}
        onRedeem={onRedeem}
        busy={false}
        {...props}
      />
    </MemoryRouter>
  );

  return { onRedeem, onCodeChange };
}

describe('SubscriptionSection', () => {
  describe('redeeming', () => {
    it('offers the redeem field to a SUBSCRIBER (regression)', () => {
      // The bug: this input was nested in the "no badge" branch, which made gift
      // redemption unreachable for exactly the people the credit model exists
      // for.
      renderSection({ badge: active });
      expect(screen.getByPlaceholderText('XXXXX-XXXXX-XXXXX-XXXXX')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'redeem' })).toBeInTheDocument();
    });

    it('offers the redeem field with no subscription', () => {
      renderSection({ badge: null });
      expect(screen.getByPlaceholderText('XXXXX-XXXXX-XXXXX-XXXXX')).toBeInTheDocument();
    });

    it('tells a subscriber their gifted months will be held, not burned', () => {
      renderSection({ badge: active });
      expect(screen.getByText(/held in reserve/i)).toBeInTheDocument();
      expect(screen.getByText(/will not pay for time you were given/i)).toBeInTheDocument();
    });

    it('fires onRedeem with a code entered', async () => {
      const user = userEvent.setup();
      const { onRedeem } = renderSection({ badge: active, redeemCode: 'ABCDE-FGHJK-MNPQR-STVWX' });

      await user.click(screen.getByRole('button', { name: 'redeem' }));
      expect(onRedeem).toHaveBeenCalledOnce();
    });

    it('disables redeem with an empty code', () => {
      renderSection({ redeemCode: '' });
      expect(screen.getByRole('button', { name: 'redeem' })).toBeDisabled();
    });

    it('disables redeem on whitespace only', () => {
      renderSection({ redeemCode: '   ' });
      expect(screen.getByRole('button', { name: 'redeem' })).toBeDisabled();
    });

    it('disables redeem while busy', () => {
      renderSection({ redeemCode: 'ABCDE-FGHJK-MNPQR-STVWX', busy: true });
      expect(screen.getByRole('button', { name: 'redeem' })).toBeDisabled();
    });

    it('reports typing back to the parent', async () => {
      const user = userEvent.setup();
      const { onCodeChange } = renderSection();

      await user.type(screen.getByPlaceholderText('XXXXX-XXXXX-XXXXX-XXXXX'), 'A');
      expect(onCodeChange).toHaveBeenCalledWith('A');
    });
  });

  describe('with a subscription', () => {
    it('shows the badge and a cancel route', () => {
      renderSection({ badge: active });
      expect(screen.getByText('supporter')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /manage or cancel/i })).toHaveAttribute(
        'href',
        'https://billing.stripe.com/p/login/test'
      );
    });

    it('says cancellation happens at Stripe and why', () => {
      renderSection({ badge: active });
      // We hold no customer id, so we genuinely cannot cancel for them. The copy
      // has to explain that rather than look like a missing feature.
      expect(screen.getByText(/we never stored who paid/i)).toBeInTheDocument();
    });

    it('warns when no portal is configured, instead of hiding cancellation', () => {
      // Silently offering no way out is the worst version of this.
      renderSection({ badge: active, portalUrl: null });
      expect(screen.getByText(/cancellation is not configured/i)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /manage or cancel/i })).not.toBeInTheDocument();
    });

    it('shows banked gift months when there are some', () => {
      renderSection({ badge: { ...active, creditMonths: 3 } });
      expect(screen.getByText(/3 gifted months in reserve/i)).toBeInTheDocument();
      expect(screen.getByText(/not counting down/i)).toBeInTheDocument();
    });

    it('says "month" not "months" for a single banked month', () => {
      renderSection({ badge: { ...active, creditMonths: 1 } });
      expect(screen.getByText(/1 gifted month in reserve/i)).toBeInTheDocument();
    });

    it('says nothing about banked months when there are none', () => {
      renderSection({ badge: { ...active, creditMonths: 0 } });
      // Anchored on the leading count: the redeem hint below also mentions
      // months held in reserve, and a loose /in reserve/ matches that instead.
      expect(screen.queryByText(/\d+ gifted months? in reserve/i)).not.toBeInTheDocument();
    });

    it('does not offer a subscribe button to someone already subscribed', () => {
      renderSection({ badge: active });
      expect(screen.queryByRole('link', { name: /become a supporter/i })).not.toBeInTheDocument();
    });
  });

  describe('without a subscription', () => {
    it('offers subscribing and gifting', () => {
      renderSection({ badge: null });
      expect(screen.getByRole('link', { name: /become a supporter/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /buy a gift code/i })).toBeInTheDocument();
    });

    it('does not show a cancel link with nothing to cancel', () => {
      renderSection({ badge: null });
      expect(screen.queryByRole('link', { name: /manage or cancel/i })).not.toBeInTheDocument();
    });
  });
});
