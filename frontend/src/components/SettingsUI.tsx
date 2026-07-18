import { ReactNode } from 'react';
import { InfoTip } from './InfoTip';

/**
 * Building blocks for a settings page that reads as one grouped surface rather
 * than a stack of separate boxes.
 *
 * A `SettingsSection` is a heading plus one bordered card whose rows are split
 * by dividers; a `SettingRow` is a labelled line with its control on the right
 * and the long explanation tucked behind an `InfoTip`. Kept here so every tab
 * can share the same rhythm.
 */

export function SettingsSection({
  title,
  description,
  info,
  infoDetails,
  danger,
  children,
}: {
  title: string;
  description?: string;
  /** Short hover text on a "?" beside the heading. */
  info?: string;
  /** Longer text for that "?" dialog. */
  infoDetails?: string;
  /** Tint the heading and border for a destructive group. */
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-0.5 px-1">
        <div className="flex items-center gap-1.5">
          <h2 className={`text-sm font-semibold ${danger ? 'text-error' : 'text-foreground'}`}>
            {title}
          </h2>
          {info && <InfoTip tip={info} details={infoDetails} title={title} />}
        </div>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <div
        className={`divide-y divide-border overflow-hidden rounded-lg border bg-surface ${
          danger ? 'border-error/40' : 'border-border'
        }`}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A padded block inside a SettingsSection, for content that is not a simple
 * label+control row -- inputs, file pickers, a fingerprint readout. Shares the
 * row padding so the divided card stays even.
 */
export function SettingBlock({ children }: { children: ReactNode }) {
  return <div className="space-y-2 p-3">{children}</div>;
}

export function SettingRow({
  title,
  info,
  infoDetails,
  description,
  control,
  children,
}: {
  title: string;
  /** Short hover text; also the dialog body when infoDetails is absent. */
  info?: string;
  /** Longer text shown in the InfoTip dialog. */
  infoDetails?: string;
  description?: string;
  /** Rendered on the right (a Toggle, a control). */
  control?: ReactNode;
  /** Rendered under the title (a segmented control, a preview). */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-foreground">{title}</span>
          {info && <InfoTip tip={info} details={infoDetails} title={title} />}
        </div>
        {description && <p className="text-[11px] leading-snug text-muted">{description}</p>}
        {children}
      </div>
      {control && <div className="flex-none pt-0.5">{control}</div>}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors motion-reduce:transition-none ${
            value === o.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
