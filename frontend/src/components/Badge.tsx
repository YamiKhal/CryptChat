import { Crown } from 'lucide-react';

/**
 * The supporter badge.
 *
 * This is the *only* thing the app knows about someone's subscription. It is not
 * derived from a payment record, a customer id, or an invoice -- the badge and
 * the purchase are joined only by a random code the user redeemed themselves.
 * See IDENTITY.md §3.
 */

interface BadgeProps {
  /** Grant date, shown in the tooltip -- the record of when they subscribed. */
  since?: string;
  size?: 'sm' | 'md';
  withLabel?: boolean;
}

export default function Badge({ since, size = 'sm', withLabel = false }: BadgeProps) {
  const px = size === 'sm' ? 12 : 16;

  const title = since
    ? `Supporter since ${new Date(since).toLocaleDateString()}`
    : 'Supporter';

  return (
    <span
      className="inline-flex items-center gap-1 align-middle text-warn"
      title={title}
      aria-label={title}
    >
      {/* fill + stroke: at 12px an outline-only crown reads as noise. */}
      <Crown size={px} strokeWidth={2} className="fill-warn/25" aria-hidden="true" />
      {withLabel && <span className="text-[11px] font-medium">supporter</span>}
    </span>
  );
}
