import { ReactNode } from 'react';
import { InfoTip } from './InfoTip';

/**
 * Building blocks for a settings page.
 *
 * Discord-style: content sits directly on the page background rather than inside
 * bordered cards. A `SettingsSection` is an uppercase header plus its rows,
 * separated from each other by hairline dividers only — no surrounding box, no
 * panel fill. A `SettingRow` is a labelled line with its control on the right and
 * the long explanation tucked behind an `InfoTip`. Kept here so every tab shares
 * the same rhythm and sizing.
 *
 * Each section carries a stable `id` derived from its title plus a
 * `data-settings-section` marker, so the sidebar can enumerate the visible
 * sections of a tab and jump to one.
 */

/** Stable anchor id for a section, derived from its title. */
export function sectionId(title: string): string {
  return (
    'set-' +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

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
  /** Tint the heading for a destructive group. */
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={sectionId(title)}
      data-settings-section
      data-title={title}
      className="scroll-mt-4 space-y-3"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <h2
            className={`t-base font-semibold uppercase tracking-wider ${
              danger ? 'text-error' : 'text-muted'
            }`}
          >
            {title}
          </h2>
          {info && <InfoTip tip={info} details={infoDetails} title={title} />}
        </div>
        {description && <p className="t-base leading-snug text-muted">{description}</p>}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/**
 * A block inside a SettingsSection, for content that is not a simple
 * label+control row -- inputs, file pickers, a fingerprint readout. Shares the
 * row's vertical rhythm so the divided group stays even.
 */
export function SettingBlock({ children }: { children: ReactNode }) {
  return <div className="space-y-2 py-3.5">{children}</div>;
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
    <div className="flex items-start justify-between gap-4 py-3.5">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="t-h3 font-medium text-foreground">{title}</span>
          {info && <InfoTip tip={info} details={infoDetails} title={title} />}
        </div>
        {description && <p className="t-base leading-snug text-muted">{description}</p>}
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
          className={`rounded-md px-2.5 py-1 t-base transition-colors motion-reduce:transition-none ${
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
