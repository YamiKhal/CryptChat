import { isBase64Url } from "@/lib/binary";
import {
    ReplyRef,
    ReactionRef,
    EditRef,
    DeleteRef,
    CallSignal,
    BurnRef,
} from "@/lib/crypto/envelopeTypes";
import { LockedPayload } from "@/lib/crypto/keys";

/**
 * Bound on a quoted excerpt. A reply carries the replier's snapshot of the
 * original and without a cap that field is an arbitrary-length string a peer
 * can push into every recipient's vault.
 */
export const MAX_REPLY_EXCERPT = 140;

/**
 * Bound on a profile bio. A peer picks this and it lands in every recipient's
 * vault, so it is capped rather than trusted to be reasonable.
 */
export const MAX_BIO = 500;

/**
 * One emoji. Not "a short string" -- a peer picks this and it is rendered
 * verbatim next to a message, so anything that is not a single pictograph is
 * refused rather than displayed.
 *
 * Uses Intl.Segmenter where available: an emoji like a flag or a skin-toned
 * family is several code points joined by ZWJ, so counting `.length` or even
 * [...spread] rejects perfectly ordinary emoji. Falls back to a code-point cap
 * on engines without it (bounded, if slightly permissive).
 */
export function isSingleEmoji(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 40)
        return false;

    // No control characters and no bidi overrides -- a U+202E inside a reaction
    // would reorder the text rendered around it. This field is a pictograph, not
    // a text channel, so anything structural is refused outright.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(value))
        return false;

    if (typeof Intl.Segmenter !== "undefined") {
        const graphemes = [
            ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
                value,
            ),
        ];
        if (graphemes.length !== 1) return false;
    } else if ([...value].length > 8) {
        // No Segmenter: fall back to a code-point cap. Bounded, if permissive -- a
        // ZWJ sequence like a family emoji is legitimately several code points.
        return false;
    }

    return /\p{Extended_Pictographic}/u.test(value);
}

export function isValidReplyRef(value: unknown): value is ReplyRef {
    const r = value as ReplyRef;
    return (
        typeof r === "object" &&
        r !== null &&
        typeof r.id === "string" &&
        r.id.length > 0 &&
        r.id.length <= 64 &&
        typeof r.senderId === "string" &&
        r.senderId.length <= 64 &&
        typeof r.displayName === "string" &&
        r.displayName.length <= 64 &&
        typeof r.excerpt === "string" &&
        r.excerpt.length <= MAX_REPLY_EXCERPT &&
        (r.kind === "text" || r.kind === "image" || r.kind === "file")
    );
}

export function isValidReactionRef(value: unknown): value is ReactionRef {
    const r = value as ReactionRef;
    return (
        typeof r === "object" &&
        r !== null &&
        typeof r.targetId === "string" &&
        r.targetId.length > 0 &&
        r.targetId.length <= 64 &&
        typeof r.removed === "boolean" &&
        isSingleEmoji(r.emoji)
    );
}

/**
 * A generous cap on an edited body -- above the premium message limit, since the
 * UI enforces the tier cap and this is only the outer bound that keeps a hostile
 * peer from pushing an unbounded string into every recipient's vault.
 */
export const MAX_EDIT_BODY = 8192;

export function isValidTargetId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function isValidEditRef(value: unknown): value is EditRef {
    const e = value as EditRef;
    return (
        typeof e === "object" &&
        e !== null &&
        isValidTargetId(e.targetId) &&
        typeof e.body === "string" &&
        e.body.length <= MAX_EDIT_BODY
    );
}

export function isValidDeleteRef(value: unknown): value is DeleteRef {
    const d = value as DeleteRef;
    return typeof d === "object" && d !== null && isValidTargetId(d.targetId);
}

/** Bound on an SDP blob. Real offers are a few KB; this only fences the outer size. */
export const MAX_SDP = 64 * 1024;
const CALL_KINDS = new Set([
    "ringing",
    "offer",
    "answer",
    "ice",
    "hangup",
    "decline",
    "video",
]);

export function isValidCallSignal(value: unknown): value is CallSignal {
    const c = value as CallSignal;
    return (
        typeof c === "object" &&
        c !== null &&
        typeof c.kind === "string" &&
        CALL_KINDS.has(c.kind) &&
        typeof c.callId === "string" &&
        c.callId.length > 0 &&
        c.callId.length <= 64 &&
        (c.media === undefined || c.media === "audio" || c.media === "video") &&
        (c.screen === undefined || typeof c.screen === "boolean") &&
        (c.sdp === undefined ||
            (typeof c.sdp === "string" && c.sdp.length <= MAX_SDP)) &&
        (c.candidate === undefined ||
            (typeof c.candidate === "string" && c.candidate.length <= 4096)) &&
        (c.on === undefined || typeof c.on === "boolean")
    );
}

/** Bound on the sealed body, matching the envelope's overall generosity. */
export const MAX_LOCKED_CT = 16384;
export const MAX_LOCK_HINT = 140;

/** One second to one week. Bounds a peer-supplied timer to something sane. */
export const MAX_BURN_TTL = 7 * 24 * 3600;

export function isValidBurnRef(value: unknown): value is BurnRef {
    const b = value as BurnRef;
    return (
        typeof b === "object" &&
        b !== null &&
        typeof b.ttl === "number" &&
        Number.isFinite(b.ttl) &&
        b.ttl >= 1 &&
        b.ttl <= MAX_BURN_TTL
    );
}

export function isValidLockedPayload(value: unknown): value is LockedPayload {
    const l = value as LockedPayload;
    return (
        typeof l === "object" &&
        l !== null &&
        isBase64Url(l.salt) &&
        isBase64Url(l.nonce) &&
        isBase64Url(l.ct) &&
        l.ct.length <= MAX_LOCKED_CT &&
        (l.hint === undefined ||
            (typeof l.hint === "string" && l.hint.length <= MAX_LOCK_HINT))
    );
}
