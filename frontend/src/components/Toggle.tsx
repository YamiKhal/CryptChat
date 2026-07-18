/**
 * An animated on/off switch.
 *
 * A styled `role="switch"` button rather than a bare checkbox: the sliding knob
 * reads at a glance and the whole control is one tap target. The slide is
 * dropped under prefers-reduced-motion, leaving an instant state change.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full border
                  transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50
                  motion-reduce:transition-none ${
                    checked ? 'border-primary bg-primary' : 'border-border bg-surface-raised'
                  }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-200
                    motion-reduce:transition-none ${
                      checked ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-muted'
                    }`}
      />
    </button>
  );
}
