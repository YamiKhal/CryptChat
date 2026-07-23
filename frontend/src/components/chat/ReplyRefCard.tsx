import { CSSProperties } from "react";
import {
    Image as ImageIcon,
    File as FileIcon,
    CornerUpLeft,
    X,
} from "lucide-react";
import { ReplyRef } from "@/lib/crypto";

/**
 * The "replying to …" line.
 *
 * The excerpt shown here is the *replier's* signed snapshot of the original, not
 * a live lookup (see ReplyRef in crypto.ts). That means it is a quote attributed
 * to the replier and it is rendered as one -- muted, clipped, never styled to
 * look like authoritative text from the original author.
 */

function KindIcon({ kind }: { kind: ReplyRef["kind"] }) {
    if (kind === "image") return <ImageIcon size={11} aria-hidden="true" />;
    if (kind === "file") return <FileIcon size={11} aria-hidden="true" />;
    return null;
}

function label(reply: ReplyRef): string {
    if (reply.excerpt) return reply.excerpt;
    if (reply.kind === "image") return "image";
    if (reply.kind === "file") return "file";
    return "message";
}

/** How much of the quoted text the preview shows before trailing off. The stored
 *  excerpt runs up to MAX_REPLY_EXCERPT (140); the preview is deliberately curter
 *  so it reads as a pointer, not the message. */
const PREVIEW_CHARS = 48;

/** Preview text, cut short with a trailing ellipsis so it is clear the quote is
 *  only the head of the original -- never the whole thing. */
function previewLabel(reply: ReplyRef): string {
    const text = label(reply);
    return text.length > PREVIEW_CHARS
        ? text.slice(0, PREVIEW_CHARS).trimEnd() + "…"
        : text;
}

interface ReplyRefCardProps {
    reply: ReplyRef;
    /** Fires when the quote is clicked. Undefined = not clickable. */
    onJump?: () => void;
    /** True when the target is not in this device's transcript. */
    missing?: boolean;
    /** Right-aligned bubble: mirror the elbow so it hooks toward the right avatar. */
    mirror?: boolean;
    /** False when there is no avatar column -- draw a short spur instead of a long
     *  one reaching back to a picture that is not there. */
    reach?: boolean;
}

/**
 * Discord-style reply reference: a single clamped line of small text sitting
 * ABOVE the message, joined to the avatar by an elbow that runs up out of the
 * picture and across into the quote.
 *
 * Rendered as the first row of the message's content column (above the name),
 * not inside the bubble.
 */
export function ReplyQuote({
    reply,
    onJump,
    missing,
    mirror,
    reach = true,
}: ReplyRefCardProps) {
    // How far the horizontal run travels back toward the avatar's centre: half the
    // picture plus the row gap (gap-1.5 = 0.375rem). With no avatar it collapses to
    // a stub. Kept in step with the row gap so the drop lands on the avatar's middle.
    const back = reach ? "calc(var(--chat-avatar) / 2 + 0.375rem)" : "0px";

    // The elbow: a border-drawn corner. Top edge meets the text midline; the side
    // edge drops below the row toward the avatar. Mirror flips it for the right.
    const elbow: CSSProperties = {
        position: "absolute",
        top: "50%",
        // Stop the drop just shy of the row below so the corner meets the top of the
        // avatar rather than running down through the picture.
        bottom: "-0.2rem",
        width: `calc(${back} + 0.5rem)`,
        ...(mirror
            ? { right: `calc(-1 * (${back}))`, borderTopRightRadius: "0.5rem" }
            : { left: `calc(-1 * (${back}))`, borderTopLeftRadius: "0.5rem" }),
    };

    return (
        <button
            type="button"
            onClick={onJump}
            disabled={missing}
            title={
                missing
                    ? "The original is not on this device"
                    : "Jump to message"
            }
            className={`group/reply t-small relative mb-0.5 flex max-w-full min-w-0 items-center gap-1 ${mirror ? "flex-row-reverse pr-2.5 text-right" : "pl-2.5 text-left"} ${missing ? "cursor-default" : ""}`}
        >
            <span
                aria-hidden="true"
                style={elbow}
                className={`border-border pointer-events-none border-t-2 ${mirror ? "border-r-2" : "border-l-2"} ${missing ? "" : "group-hover/reply:border-muted transition-colors"}`}
            />
            <span className="text-primary/90 flex-none font-medium">
                {reply.displayName}
            </span>
            <KindIcon kind={reply.kind} />
            <span className="text-muted group-hover/reply:text-foreground max-w-[22ch] truncate transition-colors">
                {previewLabel(reply)}
            </span>
        </button>
    );
}

/** Rendered above the composer while a reply is being written. */
export function ReplyComposing({
    reply,
    onCancel,
}: {
    reply: ReplyRef;
    onCancel: () => void;
}) {
    return (
        <div className="border-border bg-surface flex items-center gap-2 border-t px-4 py-2">
            <CornerUpLeft
                size={12}
                className="text-primary flex-none"
                aria-hidden="true"
            />
            <div className="t-small flex min-w-0 flex-1 items-center gap-1.5">
                <span className="text-muted flex-none">replying to</span>
                <span className="text-primary flex-none font-medium">
                    {reply.displayName}
                </span>
                <KindIcon kind={reply.kind} />
                <span className="text-muted truncate">{label(reply)}</span>
            </div>
            <button
                onClick={onCancel}
                className="text-muted hover:text-error flex-none transition-colors"
                aria-label="Cancel reply"
            >
                <X size={14} />
            </button>
        </div>
    );
}
