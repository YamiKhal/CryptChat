import { useEffect, useState, Fragment, ReactNode } from 'react';
import { X } from 'lucide-react';
import { UserProfile } from '@/lib/vault';
import { unpackAsset, decodeImage } from '@/lib/binary';
import { isSafeUrl } from '@/lib/links';
import Avatar from '@/components/ui/Avatar';

/**
 * The profile card for a user -- your own or a peer's.
 *
 * Everything shown here rode in over the same signed, encrypted profile envelope
 * as the display name and avatar, so a relay could not forge any of it. Nothing
 * is fetched: the banner is decoded from vault bytes, and bio links are inert
 * anchors (http/https only, noopener/noreferrer, no prefetch) -- opening the card
 * makes no network request.
 */

// [label](url). The url stops at whitespace or the closing paren; the label is
// anything up to the first ']'. Deliberately small -- this is not markdown, just
// a way to put a named link in a bio.
const BIO_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Render a bio, turning [label](url) into safe anchors and leaving the rest text. */
function renderBio(bio: string): ReactNode {
  const out: ReactNode[] = [];
  let cursor = 0;
  let i = 0;

  for (const match of bio.matchAll(BIO_LINK)) {
    const start = match.index ?? 0;
    const [whole, label, url] = match;

    if (!isSafeUrl(url)) continue; // leave a javascript:/other-scheme link as literal text

    if (start > cursor) out.push(<Fragment key={i++}>{bio.slice(cursor, start)}</Fragment>);
    out.push(
      <a
        key={i++}
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-primary underline decoration-primary underline-offset-2 hover:decoration-primary-strong"
      >
        {label}
      </a>,
    );
    cursor = start + whole.length;
  }

  if (cursor < bio.length) out.push(<Fragment key={i++}>{bio.slice(cursor)}</Fragment>);
  return out;
}

/** Decodes the banner to an object URL for the life of the card. */
function Banner({ profile }: { profile: UserProfile }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!profile.background) {
      setUrl(null);
      return;
    }
    let release: (() => void) | null = null;
    try {
      const decoded = unpackAsset(profile.background);
      const handle = decodeImage(decoded.bytes, decoded.mime);
      release = handle.release;
      setUrl(handle.url);
    } catch {
      setUrl(null);
    }
    return () => release?.();
  }, [profile.background]);

  return (
    <div className="h-28 w-full bg-primary-soft">
      {url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

export function UserProfileModal({
  profile,
  onClose,
}: {
  profile: UserProfile;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
    >
      <div
        className="modal-panel relative max-w-sm overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close floats over the banner, Discord-style — no footer needed. */}
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2.5 right-2.5 z-10 grid size-8 place-items-center rounded-full
                     bg-surface text-muted transition-colors hover:text-foreground"
        >
          <X size={16} />
        </button>

        <Banner profile={profile} />

        <div className="space-y-2 px-4 pt-0 pb-4">
          <div className="-mt-10 w-fit rounded-full ring-4 ring-surface">
            <Avatar asset={profile.avatar} name={profile.displayName} size="lg" />
          </div>

          <p className="t-h3 font-bold text-foreground">{profile.displayName}</p>

          {profile.bio && (
            <div className="rounded-lg bg-surface-raised p-3">
              <p className="t-base whitespace-pre-wrap wrap-break-word text-foreground">
                {renderBio(profile.bio)}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
