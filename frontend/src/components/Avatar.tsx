import { useEffect, useState, useMemo } from 'react';
import { BinaryAsset, unpackAsset, decodeImage } from '../lib/binary';

/**
 * Renders a stored avatar.
 *
 * Avatars live in the vault as bytes, not as data URLs, so they have to be
 * decoded on every mount. `decodeImage` hands back an object URL plus a
 * release handle -- object URLs pin their blob in memory until revoked, and a
 * chat scrolling through hundreds of messages would otherwise leak one blob
 * per render.
 */

const SIZES = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-20 w-20 text-2xl',
} as const;

interface AvatarProps {
  asset?: BinaryAsset;
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
  /**
   * Incognito mode: a solid colour swatch instead of an image or initials.
   * A hue in [0, 360). When set, `asset` and `name` are ignored for rendering,
   * since an incognito member has neither to show.
   */
  color?: number;
}

/** Deterministic hue from the name, so a person keeps the same colour. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export default function Avatar({ asset, name, size = 'md', className = '', color }: AvatarProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!asset || color !== undefined) {
      setUrl(null);
      return;
    }

    let release: (() => void) | null = null;
    try {
      // unpackAsset rejects any MIME outside the image allowlist. A peer
      // controls this field, and a blob URL with a text/html MIME opened in a
      // tab would run as same-origin script.
      const decoded = unpackAsset(asset);
      const handle = decodeImage(decoded.bytes, decoded.mime);
      release = handle.release;
      setUrl(handle.url);
    } catch {
      setUrl(null);
    }

    return () => {
      release?.();
      setUrl(null);
    };
  }, [asset, color]);

  const initials = useMemo(
    () =>
      name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || '?',
    [name]
  );

  const base = `${SIZES[size]} shrink-0 rounded-full overflow-hidden ${className}`;

  // Incognito: a solid colour, no image and no initials to reveal.
  if (color !== undefined) {
    return (
      <div
        className={`${base} border border-border`}
        style={{ backgroundColor: `hsl(${color} 55% 45%)` }}
        aria-hidden
      />
    );
  }

  if (url) {
    return <img src={url} alt="" className={`${base} object-cover border border-border`} />;
  }

  return (
    <div
      className={`${base} grid place-items-center border border-border font-semibold`}
      style={{
        backgroundColor: `hsl(${hueFor(name)} 45% 18%)`,
        color: `hsl(${hueFor(name)} 80% 70%)`,
      }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
