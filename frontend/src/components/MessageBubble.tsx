import { useEffect, useState, Fragment, ReactNode } from "react";
import { LockKeyhole, Timer, ShieldCheck, EyeOff } from "lucide-react";
import { StoredMessage } from "../lib/vault";
import { BinaryAsset, unpackAsset, decodeImage } from "../lib/binary";
import { segmentize } from "../lib/links";
import { looksRenderable } from "../lib/blob";
import { InlineNode, toBlocks } from "../lib/format";
import Avatar from "./Avatar";
import AttachmentCard from "./AttachmentCard";
import MediaViewer from "./MediaViewer";
import LinkPreviewCard from "./LinkPreviewCard";
import ReactionBar from "./ReactionBar";
import Badge from "./Badge";
import { ReplyQuote } from "./ReplyRefCard";

/**
 * Turn a run of plain text into React, promoting URLs to anchors.
 *
 * `segmentize` returns data, never markup, so peer-controlled text can never
 * turn into HTML. Anchors are http/https only and carry noopener/noreferrer,
 * and nothing is prefetched: rendering a message must not cause a network
 * request.
 */
function renderText(text: string): ReactNode {
  return segmentize(text).map((segment, i) =>
    segment.type === "link" ? (
      <a
        key={i}
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-primary underline decoration-primary underline-offset-2
                   hover:decoration-primary-strong"
        onClick={(e) => e.stopPropagation()}
      >
        {segment.value}
      </a>
    ) : (
      <Fragment key={i}>{segment.value}</Fragment>
    ),
  );
}

/**
 * An inline `||spoiler||` run.
 *
 * Covered by a solid box until clicked. The revealed flag lives in component
 * state, so it resets the moment the bubble unmounts -- leaving and reopening
 * the chat hides it again. Once revealed the text keeps a faint tint so it stays
 * legible that these words were hidden. Click is used rather than hover so it
 * works the same by tap on touch, and it stops propagation so revealing a word
 * does not also trigger the whole-message spoiler behind it.
 */
function InlineSpoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);

  if (revealed) {
    return <span className="rounded-sm bg-surface-raised px-0.5">{children}</span>;
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRevealed(true);
        }
      }}
      className="cursor-pointer select-none rounded-sm bg-foreground
                 align-baseline text-transparent transition"
      title="Spoiler — click to reveal"
    >
      {children}
    </span>
  );
}

/** Render a parsed inline node tree, recursing through the formatting marks. */
function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{renderText(node.value)}</Fragment>;
      case "bold":
        return (
          <strong key={i} className="font-semibold">
            {renderInline(node.children)}
          </strong>
        );
      case "italic":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "strike":
        return <s key={i}>{renderInline(node.children)}</s>;
      case "spoiler":
        return <InlineSpoiler key={i}>{renderInline(node.children)}</InlineSpoiler>;
    }
  });
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-base font-semibold",
  2: "text-[15px] font-semibold",
  3: "text-sm font-semibold",
};

/**
 * Render a message body with formatting (**bold**, __italic__, ~~strike~~,
 * ||spoiler||, and `#` headings) plus clickable links.
 */
function Body({ text }: { text: string }) {
  return (
    <div className="wrap-break-word">
      {toBlocks(text).map((block, i) =>
        block.type === "heading" ? (
          <p key={i} className={`${HEADING_CLASS[block.level]} mt-1 first:mt-0`}>
            {renderInline(block.children)}
          </p>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(block.children)}
          </p>
        ),
      )}
    </div>
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
  /** Incognito: render the avatar as this hue instead of an image/initials. */
  avatarColor?: number;
  /** Incognito: show this in place of the (blanked) envelope display name. */
  nameOverride?: string;
  /** Sender's key was verified out of band -- show a trust badge. */
  senderTrusted?: boolean;
  /** Discord-style: lay every message on the left, even your own. */
  leftAligned?: boolean;
  /** Hide the profile picture column, showing names alone. */
  hideAvatars?: boolean;
  /** Show the speech-bubble tail. Only the last message in a grouped run gets one. */
  showTail?: boolean;
}

/**
 * A password-locked message the recipient has not opened yet.
 *
 * Just a placeholder and the optional hint -- unlocking is a context-menu action
 * (right-click / long-press) so the code is entered in a dedicated prompt, and
 * the plaintext only ever lands in the unlocking user's own vault.
 */
function LockedBody({ hint }: { hint?: string }) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <LockKeyhole size={13} aria-hidden="true" />
        Password-protected — open the menu to unlock
      </p>
      {hint && <p className="text-[11px] italic text-muted">hint: {hint}</p>}
    </div>
  );
}

/** Decodes an attached image back to an object URL for the life of the bubble.
 *  `bare` drops the in-bubble framing (margin + border) for an image-only
 *  message, which is rendered as a plain rounded photo with no bubble chrome. */
function Attachment({ asset, bare }: { asset: BinaryAsset; bare?: boolean }) {
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
    <MediaViewer src={url}>
      <img
        src={url}
        alt=""
        className={
          bare
            ? "w-full max-w-full max-h-80 rounded-2xl object-contain"
            : "mt-1 w-full max-w-full max-h-64 rounded border border-border object-contain"
        }
      />
    </MediaViewer>
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
  avatarColor,
  nameOverride,
  senderTrusted,
  leftAligned,
  hideAvatars,
  showTail,
}: MessageBubbleProps) {
  // Whether this bubble sits on the right. Only your own messages do, and only
  // when not in the single-column (Discord-style) layout.
  const rightAligned = isSelf && !leftAligned;
  const shownName = nameOverride ?? message.displayName;
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Whole-message spoiler. Transient by design: state resets when the bubble
  // unmounts, so leaving and reopening the chat covers it again. Only relevant
  // once there is something to cover -- not for a tombstone or a still-locked
  // message.
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const coverSpoiler =
    Boolean(message.spoiler) &&
    !spoilerRevealed &&
    !message.deleted &&
    !message.locked;

  // A message that is nothing but an image gets no bubble chrome -- no fill,
  // border, padding, or tail. Just the rounded photo. Anything extra (a caption,
  // a reply, a second file, a link preview, a lock/burn marker, a spoiler) keeps
  // the bubble, since that content needs the frame.
  //
  // An image arrives one of two ways: a small inline `asset` embedded in the
  // envelope, or a single renderable `attachment` fetched as an encrypted blob.
  const soleImageAttachment =
    message.attachments?.length === 1 && looksRenderable(message.attachments[0])
      ? message.attachments[0]
      : null;
  const imageOnly =
    !message.deleted &&
    !message.locked &&
    !message.body &&
    !message.preview &&
    !message.replyTo &&
    !message.protected &&
    !message.burnTtl &&
    !coverSpoiler &&
    ((Boolean(message.asset) && !message.attachments?.length) ||
      (!message.asset && Boolean(soleImageAttachment)));

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
    lg:gap-2.5
    ${rightAligned ? "flex-row-reverse" : "flex-row"}
    ${grouped ? "mt-0.5" : "mt-3"}`}
    >
      {!hideAvatars && (
        <div
          className="flex-none"
          style={{ width: 'var(--chat-avatar)', height: 'var(--chat-avatar)' }}
        >
          {!grouped && (
            <Avatar
              asset={avatarColor !== undefined ? undefined : avatar}
              name={shownName}
              size="fluid"
              color={avatarColor}
            />
          )}
        </div>
      )}

      <div
        className={`
    flex
    min-w-0
    max-w-[78%]
    flex-col
    ${rightAligned ? "items-end" : "items-start"}
  `}
      >
        {!grouped && (
          <div
            className={`flex items-center gap-1.5 px-1 pb-0.5 ${rightAligned ? "flex-row-reverse" : ""}`}
          >
            {/* The display name comes from inside the signed envelope, not from
                the server -- the server has never seen it. */}
            <span
              className="font-semibold text-foreground"
              style={{ fontSize: 'var(--chat-name)' }}
            >
              {shownName}
            </span>
            {senderTrusted && (
              <span className="inline-flex text-ok" title="Verified — you confirmed this key">
                <ShieldCheck size={11} aria-hidden="true" />
              </span>
            )}
            {supporter && <Badge size="sm" />}
            <span className="text-muted" style={{ fontSize: 'var(--chat-time)' }}>
              {time}
            </span>

            {/* An unverified signature means the claimed author cannot be
                confirmed. Silently rendering the name would be the whole
                spoofing attack, so it is called out. */}
            {!message.verified && (
              <span
                className="tag bg-warn-soft text-warn"
                title="Signature could not be verified"
              >
                unverified
              </span>
            )}
            {keyChanged && (
              <span
                className="tag bg-error-soft text-error"
                title="This contact's signing key changed"
              >
                key changed
              </span>
            )}
          </div>
        )}

        {imageOnly ? (
          // Image-only: no bubble, no border, no tail. A plain rounded photo.
          <div className="w-fit max-w-full">
            {message.asset ? (
              <Attachment asset={message.asset} bare />
            ) : (
              <AttachmentCard attachment={soleImageAttachment!} bare />
            )}
          </div>
        ) : (
        // Wrapper carries the tail. `isolate` keeps the tail's negative z-index
        // local, so it tucks behind the bubble (which hides its inner half) but
        // never slips behind the page.
        <div className="relative isolate w-fit max-w-full">
        <div
          style={{
            fontSize: "var(--chat-body)",
            // Bubble fill + border come from CSS vars so a custom theme can
            // recolour self / other bubbles independently.
            background: isSelf ? "var(--bubble-self-bg)" : "var(--bubble-other-bg)",
            borderColor: isSelf ? "var(--bubble-self-border)" : "var(--bubble-other-border)",
            // Square off the corner the tail grows from (only when there is a
            // tail), so it continues the bubble's straight edges instead of
            // clashing with a rounded corner.
            borderBottomRightRadius: showTail && rightAligned ? 0 : undefined,
            borderBottomLeftRadius: showTail && !rightAligned ? 0 : undefined,
          }}
          className={`
    animate-fade-in
    motion-reduce:animate-none
    w-fit
    max-w-full
    min-w-0
    overflow-hidden
    relative
    rounded-lg
    border
    text-foreground
    px-2
    py-1
    lg:px-3
    lg:py-1.5 ${
      highlighted ? "ring-2 ring-primary transition-shadow" : ""
    }`}
        >
          <div
            className={
              coverSpoiler ? "pointer-events-none select-none blur-md" : undefined
            }
            aria-hidden={coverSpoiler || undefined}
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

          {message.deleted ? (
            // Tombstone. The bytes are already gone from the vault; this is the
            // slot kept so a reply that quoted it still resolves.
            <p className="italic text-muted">message deleted</p>
          ) : message.locked ? (
            <LockedBody hint={message.locked.hint} />
          ) : (
            <>
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

              {message.protected && (
                <span
                  className="ml-1 inline-flex align-baseline text-muted"
                  title="This message was password-protected"
                >
                  <LockKeyhole size={10} aria-hidden="true" />
                </span>
              )}
              {message.burnTtl && (
                <span
                  className="ml-1 inline-flex align-baseline text-muted"
                  title="Disappears after it is read"
                >
                  <Timer size={10} aria-hidden="true" />
                </span>
              )}
              {message.editedAt && (
                <span className="ml-1 align-baseline text-[10px] text-muted">(edited)</span>
              )}
              {/* Once uncovered, keep a marker so it stays clear this message was
                  posted as a spoiler. */}
              {message.spoiler && spoilerRevealed && (
                <span
                  className="ml-1 inline-flex align-baseline text-muted"
                  title="Marked as a spoiler"
                >
                  <EyeOff size={10} aria-hidden="true" />
                </span>
              )}
            </>
          )}

          {message.pending && (
            <p className="mt-1 text-[10px] text-muted">queued — not yet sent</p>
          )}
          </div>

          {/* The cover. Absolutely fills the (blurred) bubble; clicking it
              uncovers this message for as long as the bubble stays mounted. */}
          {coverSpoiler && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSpoilerRevealed(true);
              }}
              className="absolute inset-0 flex items-center justify-center gap-1.5
                         bg-surface-raised text-[11px] font-medium text-muted
                         transition hover:text-foreground"
              title="Spoiler — click to reveal"
            >
              <EyeOff size={13} aria-hidden="true" />
              Spoiler — tap to reveal
            </button>
          )}
        </div>

          {/* Speech-bubble tail. An SVG hook with the bubble's own fill AND border,
              tucked behind the bubble (-z-10) at the squared bottom corner: the
              bubble covers the inner half, only the outward flick shows, and its
              stroke lines up with the bubble border so it reads as one shape.
              SVG (not a CSS mask) because the wallpaper behind can be a video --
              the tail must be a self-contained shape, transparent outside it. */}
          {showTail && (
            <svg
              aria-hidden="true"
              width="9"
              height="10"
              viewBox="0 0 9 10"
              className="pointer-events-none absolute -z-10 -bottom-0.5"
              style={rightAligned ? { right: "-5.5px" } : { left: "-5.5px" }}
            >
              <path
                d={
                  rightAligned
                    ? "M0 0 C0.5 5.5 2.5 9 8.5 9.6 C5 7.5 3.5 4.5 3.5 0 Z"
                    : "M9 0 C8.5 5.5 6.5 9 0.5 9.6 C4 7.5 5.5 4.5 5.5 0 Z"
                }
                fill={isSelf ? "var(--bubble-self-bg)" : "var(--bubble-other-bg)"}
                stroke={isSelf ? "var(--bubble-self-border)" : "var(--bubble-other-border)"}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </div>
        )}

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
