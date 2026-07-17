import { useEffect, useState, Fragment } from "react";
import { StoredMessage } from "../lib/vault";
import { BinaryAsset, unpackAsset, decodeImage } from "../lib/binary";
import { segmentize } from "../lib/links";
import Avatar from "./Avatar";
import AttachmentCard from "./AttachmentCard";
import LinkPreviewCard from "./LinkPreviewCard";
import ReactionBar from "./ReactionBar";
import Badge from "./Badge";
import { ReplyQuote } from "./ReplyRefCard";

/**
 * Render a message body with clickable links.
 *
 * `segmentize` returns data, never markup, and each piece becomes a React
 * element -- so peer-controlled text can never turn into HTML. Anchors are
 * http/https only and carry noopener/noreferrer, and nothing is prefetched:
 * rendering a message must not cause a network request.
 */
function Body({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap wrap-break-word">
      {segmentize(text).map((segment, i) =>
        segment.type === "link" ? (
          <a
            key={i}
            href={segment.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline decoration-primary/40 underline-offset-2
                       hover:decoration-primary"
            onClick={(e) => e.stopPropagation()}
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={i}>{segment.value}</Fragment>
        ),
      )}
    </p>
  );
}

interface MessageBubbleProps {
  message: StoredMessage;
  isSelf: boolean;
  grouped: boolean;
  avatar?: BinaryAsset;
  keyChanged: boolean;
  /** Set when the sender holds an active subscription. */
  supporter?: boolean;
  selfId: string;
  nameFor: (userId: string) => string;
  onToggleReaction: (emoji: string) => void;
  onJumpToReply: (messageId: string) => void;
  /** False when the replied-to message is not in this device's transcript. */
  replyTargetExists: boolean;
  /** Spread onto the row to arm right-click / long-press. */
  contextHandlers?: Record<string, unknown>;
  /** Briefly ring the bubble after a reply jump lands on it. */
  highlighted?: boolean;
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

  if (failed)
    return <p className="text-xs text-error">unsupported attachment</p>;
  if (!url) return null;

  return (
    <img
      src={url}
      alt=""
      className="mt-1 w-full max-w-full max-h-64 rounded border border-border object-contain"
    />
  );
}

export default function MessageBubble({
  message,
  isSelf,
  grouped,
  avatar,
  keyChanged,
  supporter,
  selfId,
  nameFor,
  onToggleReaction,
  onJumpToReply,
  replyTargetExists,
  contextHandlers,
  highlighted,
}: MessageBubbleProps) {
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      id={`msg-${message.id}`}
      {...contextHandlers}
      className={`
    flex
    w-full
    min-w-0
    gap-2
    scroll-mt-4
    ${isSelf ? "flex-row-reverse" : "flex-row"}
    ${grouped ? "mt-0.5" : "mt-3"}`}
    >
      <div className="w-6 flex-none">
        {!grouped && (
          <Avatar asset={avatar} name={message.displayName} size="sm" />
        )}
      </div>

      <div
        className={`
    flex
    min-w-0
    max-w-[78%]
    flex-col
    ${isSelf ? "items-end" : "items-start"}
  `}
      >
        {!grouped && (
          <div
            className={`flex items-center gap-1.5 px-1 pb-0.5 ${isSelf ? "flex-row-reverse" : ""}`}
          >
            {/* The display name comes from inside the signed envelope, not from
                the server -- the server has never seen it. */}
            <span className="text-[11px] font-medium text-foreground/80">
              {message.displayName}
            </span>
            {supporter && <Badge size="sm" />}
            <span className="text-[10px] text-muted">{time}</span>

            {/* An unverified signature means the claimed author cannot be
                confirmed. Silently rendering the name would be the whole
                spoofing attack, so it is called out. */}
            {!message.verified && (
              <span
                className="tag bg-warn/10 text-warn"
                title="Signature could not be verified"
              >
                unverified
              </span>
            )}
            {keyChanged && (
              <span
                className="tag bg-error/10 text-error"
                title="This contact's signing key changed"
              >
                key changed
              </span>
            )}
          </div>
        )}

        <div
          className={`
    animate-fade-in
    w-fit
    max-w-full
    min-w-0
    overflow-hidden
    rounded-lg
    px-2
    py-1
    text-sm ${
      isSelf
        ? "bg-primary/15 text-foreground border border-primary/30"
        : "bg-surface-raised text-foreground border border-border"
    } ${message.pending ? "opacity-60" : ""} ${
      highlighted ? "ring-2 ring-primary/70 transition-shadow" : ""
    }`}
        >
          {/* The quote is the replier's signed snapshot, so it belongs inside
              their bubble -- it is something they said, not a live view of the
              original. */}
          {message.replyTo && (
            <ReplyQuote
              reply={message.replyTo}
              missing={!replyTargetExists}
              onJump={() => onJumpToReply(message.replyTo!.id)}
            />
          )}

          {message.body &&
            (!message.preview ||
              (message.preview && message.preview!.kind === "youtube")) && (
              <Body text={message.body} />
            )}
          {message.asset && <Attachment asset={message.asset} />}

          {message.attachments?.map((attachment) => (
            <AttachmentCard key={attachment.blobId} attachment={attachment} />
          ))}

          {message.preview && <LinkPreviewCard preview={message.preview} />}

          {message.pending && (
            <p className="mt-1 text-[10px] text-muted">queued — not yet sent</p>
          )}
        </div>

        {message.reactions && (
          <ReactionBar
            reactions={message.reactions}
            selfId={selfId}
            nameFor={nameFor}
            onToggle={onToggleReaction}
          />
        )}
      </div>
    </div>
  );
}
