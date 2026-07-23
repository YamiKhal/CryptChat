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
    grouped: groupedRaw,
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
    // A reply always breaks the run: it needs the avatar to hang its elbow on and
    // the name/time header for context, so never fold it into the message above.
    const grouped = groupedRaw && !message.replyTo;

    // Whether this bubble sits on the right. Only your own messages do and only
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
        message.attachments?.length === 1 &&
        looksRenderable(message.attachments[0])
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
            className={`flex w-full min-w-0 scroll-mt-4 flex-col ${grouped ? "mt-0.5" : "mt-3"}`}
        >
            {/* Discord-style reply: a clamped quote on its OWN row above the
            message, indented past the avatar so it lines up with the body. The
            avatar below sits at name height and the elbow hooks down into it. */}
            {message.replyTo && (
                <div
                    className={`flex w-full min-w-0 gap-1.5 ${rightAligned ? "flex-row-reverse" : "flex-row"}`}
                >
                    {!hideAvatars && (
                        <div
                            className="flex-none"
                            style={{ width: "var(--chat-avatar)" }}
                            aria-hidden="true"
                        />
                    )}
                    <div
                        className={`flex max-w-[78%] min-w-0 ${rightAligned ? "justify-end" : ""}`}
                    >
                        <ReplyQuote
                            reply={message.replyTo}
                            missing={!replyTargetExists}
                            mirror={rightAligned}
                            reach={!hideAvatars}
                            onJump={() => onJumpToReply(message.replyTo!.id)}
                        />
                    </div>
                </div>
            )}

            <div
                className={`flex w-full min-w-0 gap-1.5 ${rightAligned ? "flex-row-reverse" : "flex-row"}`}
            >
                {!hideAvatars && (
                    <div
                        // On grouped rows the slot is empty and only reserves the avatar's
                        // WIDTH for indent alignment; its reserved height is dead space. With
                        // bubbles hidden the message line is short, so that height would force
                        // the row taller than the text and open an uneven gap below each
                        // grouped line -- the "no bubbles" CSS collapses it via this marker.
                        data-av-spacer={grouped ? "" : undefined}
                        className="flex-none"
                        style={{
                            width: "var(--chat-avatar)",
                            height: "var(--chat-avatar)",
                            // Drop the picture by the name line's leading so its TOP edge
                            // meets the top of the name glyphs, not the taller line box.
                            marginTop: grouped
                                ? undefined
                                : "calc(var(--chat-name) * 0.35)",
                        }}
                    >
                        {!grouped && (
                            <Avatar
                                asset={
                                    avatarColor !== undefined
                                        ? undefined
                                        : avatar
                                }
                                name={shownName}
                                size="fluid"
                                color={avatarColor}
                            />
                        )}
                    </div>
                )}

                <div
                    className={`flex max-w-[78%] min-w-0 flex-col ${rightAligned ? "items-end" : "items-start"} `}
                >
                    {!grouped && (
                        <div
                            className={`flex items-center gap-1.5 px-1 pb-0.5 ${rightAligned ? "flex-row-reverse" : ""}`}
                        >
                            {/* The display name comes from inside the signed envelope, not from
                the server -- the server has never seen it. */}
                            <span
                                className="text-foreground font-semibold"
                                style={{ fontSize: "var(--chat-name)" }}
                            >
                                {shownName}
                            </span>
                            {senderTrusted && (
                                <span
                                    className="text-ok inline-flex"
                                    title="Verified. you confirmed this key"
                                >
                                    <ShieldCheck size={11} aria-hidden="true" />
                                </span>
                            )}
                            {supporter && <Badge size="sm" />}
                            <span
                                className="text-muted"
                                style={{ fontSize: "var(--chat-time)" }}
                            >
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
                                <AttachmentCard
                                    attachment={soleImageAttachment!}
                                    bare
                                />
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
                                    background: isSelf
                                        ? "var(--bubble-self-bg)"
                                        : "var(--bubble-other-bg)",
                                    borderColor: isSelf
                                        ? "var(--bubble-self-border)"
                                        : "var(--bubble-other-border)",
                                    // Square off the corner the tail grows from (only when there is a
                                    // tail), so it continues the bubble's straight edges instead of
                                    // clashing with a rounded corner.
                                    borderBottomRightRadius:
                                        showTail && rightAligned
                                            ? 0
                                            : undefined,
                                    borderBottomLeftRadius:
                                        showTail && !rightAligned
                                            ? 0
                                            : undefined,
                                }}
                                className={`animate-fade-in text-foreground relative w-fit max-w-full min-w-0 overflow-hidden rounded-xl border px-2 py-1 motion-reduce:animate-none lg:px-3 lg:py-1.5 ${
                                    highlighted
                                        ? "ring-primary ring-2 transition-shadow"
                                        : ""
                                }`}
                            >
                                <div
                                    className={
                                        coverSpoiler
                                            ? "pointer-events-none blur-md select-none"
                                            : undefined
                                    }
                                    aria-hidden={coverSpoiler || undefined}
                                >
                                    {message.deleted ? (
                                        // Tombstone. The bytes are already gone from the vault; this is the
                                        // slot kept so a reply that quoted it still resolves.
                                        <p className="text-muted italic">
                                            message deleted
                                        </p>
                                    ) : message.locked ? (
                                        <LockedBody
                                            hint={message.locked.hint}
                                            onUnlock={onUnlock}
                                        />
                                    ) : (
                                        (() => {
                                            const showBody =
                                                Boolean(message.body) &&
                                                (!message.preview ||
                                                    message.preview.kind ===
                                                        "youtube");

                                            // Inline chrome that trails the text: a
                                            // password/burn glyph or an (edited) tag.
                                            // Ride the end of the last line rather than
                                            // dropping to a new one.
                                            const trailing = (
                                                <>
                                                    {message.protected && (
                                                        <span
                                                            className="text-muted ml-1 inline-flex align-baseline"
                                                            title="This message was password-protected"
                                                        >
                                                            <LockKeyhole
                                                                size={10}
                                                                aria-hidden="true"
                                                            />
                                                        </span>
                                                    )}
                                                    {message.burnTtl && (
                                                        <span
                                                            className="text-muted ml-1 inline-flex align-baseline"
                                                            title="Disappears after it is read"
                                                        >
                                                            <Timer
                                                                size={10}
                                                                aria-hidden="true"
                                                            />
                                                        </span>
                                                    )}
                                                    {message.editedAt && (
                                                        <span className="t-small text-muted ml-1 align-baseline">
                                                            (edited)
                                                        </span>
                                                    )}
                                                </>
                                            );

                                            return (
                                                <>
                                                    {showBody && (
                                                        <Body
                                                            text={message.body!}
                                                            trailing={trailing}
                                                        />
                                                    )}
                                                    {message.asset && (
                                                        <Attachment
                                                            asset={
                                                                message.asset
                                                            }
                                                        />
                                                    )}

                                                    {message.attachments?.map(
                                                        (attachment) => (
                                                            <AttachmentCard
                                                                key={
                                                                    attachment.blobId
                                                                }
                                                                attachment={
                                                                    attachment
                                                                }
                                                            />
                                                        ),
                                                    )}

                                                    {message.preview && (
                                                        <LinkPreviewCard
                                                            preview={
                                                                message.preview
                                                            }
                                                        />
                                                    )}

                                                    {/* No text to trail: hang the
                                                markers on their own line below. */}
                                                    {!showBody && trailing}
                                                </>
                                            );
                                        })()
                                    )}

                                    {message.pending && (
                                        <p className="t-small text-muted mt-0.5 italic">
                                            queued
                                        </p>
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
                                        className="group/spoiler bg-surface-raised absolute inset-0 flex items-center justify-center"
                                        title="Reveal spoiler"
                                    >
                                        <span className="tag text-muted group-hover/spoiler:border-primary-line group-hover/spoiler:text-foreground transition-colors">
                                            <EyeOff
                                                size={16}
                                                aria-hidden="true"
                                            />
                                        </span>
                                    </button>
                                )}
                            </div>
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
        </div>
    );
}
