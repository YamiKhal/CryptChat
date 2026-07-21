import { ReactNode } from 'react';

/**
 * A tinted callout box.
 *
 * The one shape repeated across the app -- a rounded, soft-filled panel that
 * carries a short aside without stealing the eye. It existed inline in a dozen
 * places as the same `border-*-line bg-*-soft text-*` string; drift between
 * copies was inevitable, so it lives here once.
 *
 * `info` is the neutral note, `warn` a caution, `error` a failure. Solid fills
 * only -- translucency lets a video wallpaper bleed through, which this app
 * never does.
 */

type Variant = 'info' | 'warn' | 'error';

const STYLES: Record<Variant, string> = {
  info: 'border-info-line bg-info-soft text-info',
  warn: 'border-warn-line bg-warn-soft text-warn',
  error: 'border-error-line bg-error-soft text-error',
};

export default function InfoBox({
  variant = 'info',
  className = '',
  children,
}: {
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded border p-3 t-small ${STYLES[variant]} ${className}`}>{children}</div>
  );
}
