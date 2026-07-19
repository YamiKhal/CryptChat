import { useEffect, useState, Fragment, ReactNode } from 'react';
import { UserProfile } from '../lib/vault';
import { unpackAsset, decodeImage } from '../lib/binary';
import { isSafeUrl } from '../lib/links';
import Avatar from './Avatar';

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
    <div className="h-24 w-full bg-surface-raised">
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs overflow-hidden rounded-lg border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <Banner profile={profile} />

        <div className="space-y-3 p-4">
          <div className="-mt-10 flex items-end gap-3">
            <div className="rounded-full ring-2 ring-surface">
              <Avatar asset={profile.avatar} name={profile.displayName} size="lg" />
            </div>
          </div>

          <p className="text-base font-semibold text-foreground">{profile.displayName}</p>

          {profile.bio ? (
            <p className="whitespace-pre-wrap wrap-break-word text-sm text-foreground">
              {renderBio(profile.bio)}
            </p>
          ) : (
            <p className="text-xs italic text-muted">No bio.</p>
          )}
        </div>

        <div className="flex justify-end border-t border-border p-3">
          <button onClick={onClose} className="btn-ghost text-xs">
            close
          </button>
        </div>
      </div>
    </div>
  );
}
