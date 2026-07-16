import { useEffect, useState } from 'react';
import { StoredMessage } from '../lib/vault';
import { BinaryAsset, unpackAsset, decodeImage } from '../lib/binary';
import Avatar from './Avatar';

interface MessageBubbleProps {
  message: StoredMessage;
  isSelf: boolean;
  grouped: boolean;
  avatar?: BinaryAsset;
  keyChanged: boolean;
}

/** Decodes an attached image back to an object URL for the life of the bubble. */
function Attachment({ asset }: { asset: BinaryAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let release: (() => void) | null = null;
    try {
      const decoded = unpackAsset(asset);
      const handle = decodeImage(decoded.bytes, decoded.mime);
      release = handle.release;
      setUrl(handle.url);
    } catch {
      setFailed(true);
    }
    return () => release?.();
  }, [asset]);

  if (failed) return <p className="text-xs text-error">unsupported attachment</p>;
  if (!url) return null;

  return <img src={url} alt="" className="mt-1 max-h-64 rounded border border-border object-contain" />;
}

export default function MessageBubble({
  message,
  isSelf,
  grouped,
  avatar,
  keyChanged,
}: MessageBubbleProps) {
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex gap-2 ${isSelf ? 'flex-row-reverse' : 'flex-row'} ${grouped ? 'mt-0.5' : 'mt-3'}`}>
      <div className="w-6 shrink-0">
        {!grouped && <Avatar asset={avatar} name={message.displayName} size="sm" />}
      </div>

      <div className={`flex max-w-[78%] flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
        {!grouped && (
          <div className={`flex items-center gap-1.5 px-1 pb-0.5 ${isSelf ? 'flex-row-reverse' : ''}`}>
            {/* The display name comes from inside the signed envelope, not from
                the server -- the server has never seen it. */}
            <span className="text-[11px] font-medium text-foreground/80">{message.displayName}</span>
            <span className="text-[10px] text-muted">{time}</span>

            {/* An unverified signature means the claimed author cannot be
                confirmed. Silently rendering the name would be the whole
                spoofing attack, so it is called out. */}
            {!message.verified && (
              <span className="tag bg-warn/10 text-warn" title="Signature could not be verified">
                unverified
              </span>
            )}
            {keyChanged && (
              <span className="tag bg-error/10 text-error" title="This contact's signing key changed">
                key changed
              </span>
            )}
          </div>
        )}

        <div
          className={`animate-fade-in rounded-lg px-3 py-2 text-sm ${
            isSelf
              ? 'bg-primary/15 text-foreground border border-primary/30'
              : 'bg-surface-raised text-foreground border border-border'
          } ${message.pending ? 'opacity-60' : ''}`}
        >
          {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
          {message.asset && <Attachment asset={message.asset} />}
          {message.pending && <p className="mt-1 text-[10px] text-muted">queued — not yet sent</p>}
        </div>
      </div>
    </div>
  );
}
