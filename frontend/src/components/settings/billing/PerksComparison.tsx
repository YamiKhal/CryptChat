import { Check, Crown } from 'lucide-react';
import { PERKS } from '@/components/settings/billing/perks';

/**
 * Free vs supporter, side by side.
 *
 * A table, not prose: the mechanics are numbers and yes/no, and a wall of
 * sentences would bury them. `premium` tints the column the reader is actually
 * on, so a supporter sees "this is mine" and a free user sees the gap.
 */
export default function PerksComparison({ premium = false }: { premium?: boolean }) {
  return (
    <table className="w-full t-base">
      <thead>
        <tr className="text-muted">
          <th className="pb-2 text-left font-normal"> </th>
          <th className={`pb-2 text-right font-normal ${premium ? '' : 'text-foreground'}`}>Free</th>
          <th className="pb-2 text-right font-normal text-warn">
            <span className="inline-flex items-center gap-1">
              <Crown size={12} className="fill-warn-soft" aria-hidden="true" />
              Supporter
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {PERKS.map((perk) => (
          <tr key={perk.label} className="border-t border-border">
            <td className="py-2 text-muted">{perk.label}</td>
            <td className="py-2 text-right tabular-nums text-muted">{perk.free ?? '—'}</td>
            <td className="py-2 text-right tabular-nums text-warn">
              {perk.supporter === 'yes' ? (
                <Check size={13} className="ml-auto" aria-label="included" />
              ) : (
                perk.supporter
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
