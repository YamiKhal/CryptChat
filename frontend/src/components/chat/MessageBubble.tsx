import { useState } from "react";
import { LockKeyhole, Timer, ShieldCheck, EyeOff } from "lucide-react";
import { StoredMessage } from "@/lib/vault";
import { BinaryAsset } from "@/lib/binary";
import { looksRenderable } from "@/lib/blob";
import Avatar from "@/components/ui/Avatar";
import AttachmentCard from "@/components/chat/AttachmentCard";
import LinkPreviewCard from "@/components/chat/LinkPreviewCard";
import ReactionBar from "@/components/chat/ReactionBar";
import Badge from "@/components/ui/Badge";
import { ReplyQuote } from "@/components/chat/ReplyRefCard";
import { Body, LockedBody, Attachment } from "@/components/chat/messageContent";

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
  /** Opens the password prompt for a locked message. */
  onUnlock?: () => void;
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
  /** Timestamps in 12-hour form; undefined follows the device locale. */
  hour12?: boolean;
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
  onUnlock,
  replyTargetExists,
  contextHandlers,
  highlighted,
  avatarColor,
  nameOverride,
  senderTrusted,
  leftAligned,
  hideAvatars,
  showTail,
  hour12,
}: MessageBubbleProps) {
  // Whether this bubble sits on the right. Only your own messages do, and only
  // when not in the single-column (Discord-style) layout.
  const rightAligned = isSelf && !leftAligned;
  const shownName = nameOverride ?? message.displayName;
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    // undefined lets the locale pick; the preference overrides it either way.
    hour12,
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
          // On grouped rows the slot is empty and only reserves the avatar's
          // WIDTH for indent alignment; its reserved height is dead space. With
          // bubbles hidden the message line is short, so that height would force
          // the row taller than the text and open an uneven gap below each
          // grouped line -- the "no bubbles" CSS collapses it via this marker.
          data-av-spacer={grouped ? '' : undefined}
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
          data-bubble
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
            <LockedBody hint={message.locked.hint} onUnlock={onUnlock} />
          ) : (
            <>
              {message.body &&
                (!message.preview || message.preview.kind === "youtube") && (
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
                <span className="ml-1 align-baseline t-small text-muted">(edited)</span>
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
            <p className="mt-0.5 t-small italic text-muted">queued</p>
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
              className="group/spoiler absolute inset-0 flex items-center justify-center
                         bg-surface-raised"
              title="Reveal spoiler"
            >
              <span
                className="tag border border-border bg-surface text-muted transition-colors
                           group-hover/spoiler:border-primary-line group-hover/spoiler:text-foreground"
              >
                <EyeOff size={11} aria-hidden="true" />
                spoiler
              </span>
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
