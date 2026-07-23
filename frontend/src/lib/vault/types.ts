import { BinaryAsset } from "@/lib/binary";
import {
    Identity,
    Attachment,
    LinkPreview,
    ReplyRef,
    LockedPayload,
} from "@/lib/crypto";
import type { SoundSettings, SoundEvent } from "@/lib/sounds";
import type { BubbleTheme } from "@/lib/theme";

/** Plaintext. Enough to list accounts and derive a vault key -- nothing more. */
export interface AccountDescriptor {
    userId: string;
    /** For the account switcher. Never sent to the server, which only holds sha256(username). */
    username: string;
    publicKey: string;
    signPublicKey: string;
    vaultSalt: string;
    lastUsedAt: string;
}

export interface StoredChannel {
    channelId: string;
    code: string;
    key: string;
    joinedAt: string;
    /** False until a member has wrapped and delivered the channel key. */
    hasKey: boolean;
    label?: string;
    /**
     * A group channel's picture, set locally from the context menu. Like `label`,
     * it lives only in this vault and is never sent -- naming or picturing a
     * channel is a personal, device-local choice. Not used for DMs, which show the
     * peer's own profile avatar instead.
     */
    icon?: BinaryAsset;
    /** Incognito mode: members shown as colours only, no names or avatars sent. */
    incognito?: boolean;
    /** 'dm' for a 1:1 direct message; absent/undefined for a normal group channel. */
    type?: "dm";
    /** For a DM: the other member's userId. Drives the header name and call target. */
    peerId?: string;
    /**
     * For a DM: whether I have blocked the peer. Mirrors the server (dm_blocks) so
     * the composer can be disabled locally; the server is what actually stops
     * delivery. Reconciled from /channel/list.
     */
    blocked?: boolean;
    /**
     * For a DM: an invitation to this user that they have not accepted. While set,
     * the relay withholds the channel key and messages; the list shows accept /
     * decline instead of opening the chat. Cleared on accept. Mirrors the server.
     */
    request?: boolean;
    /**
     * When this channel was last opened. Drives the unread badge on the channel
     * list: messages newer than this (and not our own) are unread. Absent means
     * never opened, so everything since joining counts.
     */
    lastReadAt?: string;
}

/** A peer's keys, pinned on first sight (TOFU). */
export interface Contact {
    userId: string;
    publicKey: string;
    signPublicKey: string;
    displayName?: string;
    avatar?: BinaryAsset;
    /** Free-text bio, may contain [label](url) links. Carried in profile updates. */
    bio?: string;
    /** A profile banner image, broadcast alongside the avatar. */
    background?: BinaryAsset;
    firstSeenAt: string;
    /** Set when the pinned signing key stops matching what the server serves. */
    keyChangedAt?: string;
}

export interface Profile {
    displayName: string;
    avatar?: BinaryAsset;
    /** Free-text bio, may contain [label](url) links. Broadcast to your channels. */
    bio?: string;
    /** A profile banner image, shown behind the profile card. */
    background?: BinaryAsset;
    updatedAt: string;
}

/**
 * The public face of a user, assembled for the profile card. Yours comes from
 * `Profile`, a peer's from their pinned `Contact`. Same shape either way, so one
 * viewer renders both.
 */
export interface UserProfile {
    userId: string;
    displayName: string;
    avatar?: BinaryAsset;
    bio?: string;
    background?: BinaryAsset;
}

/**
 * A premium custom palette, layered on top of the base dark/light theme.
 *
 * Purely cosmetic and purely local: it rides in the vault so it syncs across a
 * user's own devices and stays private, but it is never a security boundary.
 * "Premium only" is a product perk enforced in the UI, not a secret -- a user
 * editing their own client to recolour their own screen harms no one, so there
 * is nothing here to defend server-side.
 *
 * `colors` maps a token slug (see CUSTOMIZABLE_TOKENS in theme.ts) to an
 * #rrggbb value; anything absent falls through to the base theme.
 */
export interface CustomTheme {
    enabled: boolean;
    colors: Record<string, string>;
    /** Optional per-message-bubble colour + opacity overrides. */
    bubbles?: BubbleTheme;
}

export interface Preferences {
    /**
     * Build a link preview for every link, not just ones prefixed with "!".
     *
     * Off by default and deliberately so: generating a preview tells the relay
     * which URL you are sending. Opting in is a choice the user makes knowingly.
     */
    alwaysPreviewLinks: boolean;

    /** Premium palette override. Absent or disabled = base theme only. */
    customTheme?: CustomTheme;

    /**
     * Show a supporter crown on your messages to other members. Off by default:
     * paid status is a correlation handle, so broadcasting it is a deliberate,
     * opt-in choice. Never sent in incognito channels regardless.
     */
    showSupporterBadge?: boolean;

    /**
     * Premium chat wallpaper, held as a re-encoded asset (EXIF stripped like any
     * other image here). Rendered behind opaque message bubbles so text stays
     * legible whatever the image.
     */
    chatBackground?: BinaryAsset;

    /**
     * Lay every message out in a single left column (Discord-style), rather than
     * the default of your own messages on the right and everyone else's on the
     * left. Purely local presentation -- it changes nothing about what is sent.
     */
    messagesLeftAligned?: boolean;

    /**
     * Chat text scale. Drives CSS variables on the transcript, which resolve to
     * different sizes on mobile and desktop. Absent = 'normal'. Local only.
     */
    chatTextSize?: "tiny" | "small" | "normal" | "large";

    /**
     * Message timestamps in 12-hour (3:05 PM) rather than 24-hour (15:05). Absent
     * = follow the device locale's own convention. Local only, display-only.
     */
    clock12h?: boolean;

    /**
     * Hide profile pictures in the transcript, showing names alone. Local only,
     * and does not affect what avatars are sent or received.
     */
    hideProfileImages?: boolean;

    /**
     * Drop the message bubble entirely: text sits directly on the chat background
     * with no fill, border, or tail, IRC-style. The bubble element and its layout
     * are kept -- only its paint goes transparent -- so spacing and alignment stay
     * identical to the bubbled view. Local only.
     */
    hideMessageBubbles?: boolean;

    /**
     * Per-device sound cues (a new message elsewhere, a ringing call and the
     * noisier opt-ins). Partial: any missing key falls back to
     * DEFAULT_SOUND_SETTINGS in the sound engine. Local only, never sent.
     */
    sound?: Partial<SoundSettings>;

    /**
     * Per-event custom sound files, chosen from local disk. Each is a small audio
     * asset (mime + base64) played in place of the synthesized cue. Local only,
     * never sent -- purely a personal customization.
     */
    customSounds?: Partial<Record<SoundEvent, BinaryAsset>>;
}

export type ChatTextSize = NonNullable<Preferences["chatTextSize"]>;

export const DEFAULT_PREFERENCES: Preferences = {
    alwaysPreviewLinks: false,
};

export interface VaultData {
    identity: Identity;
    channels: Record<string, StoredChannel>;
    contacts: Record<string, Contact>;
    profile: Profile;
    /** Optional on disk: vaults created before preferences existed lack it. */
    preferences?: Preferences;
}

export interface StoredMessage {
    id: string;
    channelId: string;
    senderId: string;
    displayName: string;
    body: string;
    asset?: BinaryAsset;
    /** Pointers + keys for files in the blob store. Never the file bytes. */
    attachments?: Attachment[];
    /** Sender-built preview. Rendering it makes no network request. */
    preview?: LinkPreview;
    /** The replier's signed snapshot of what they answered. */
    replyTo?: ReplyRef;
    /**
     * emoji -> senderIds who reacted with it.
     *
     * Derived state: rebuilt by folding in 'reaction' envelopes as they arrive.
     * A reaction can land before the message it targets (queued while offline, or
     * delivered out of order), so orphans are parked in `pendingReactions` on the
     * channel rather than dropped.
     */
    reactions?: Record<string, string[]>;
    createdAt: string;
    /** Signature checked against the pinned key. False means "do not trust attribution". */
    verified: boolean;
    pending?: boolean;
    /** Set when the author edited the message. Rendered as an "(edited)" marker. */
    editedAt?: string;
    /**
     * Present on a password-locked message that this device has not unlocked. While
     * set, `body` is empty and the UI shows a locked placeholder. Cleared once the
     * recipient enters the code and the plaintext is written into `body`.
     */
    locked?: LockedPayload;
    /** True if the message is (or was) password-locked, for a lock indicator. */
    protected?: boolean;
    /** The sender opted to show a supporter crown on this message (self-asserted). */
    supporterClaimed?: boolean;
    /** Burn-after-read: seconds to keep the message after it is first seen. */
    burnTtl?: number;
    /** Whole-message spoiler: the UI covers the bubble until the reader clicks it. */
    spoiler?: boolean;
    /** When this device first displayed the message; the burn clock starts here. */
    firstViewedAt?: string;
    /**
     * Set when the author deleted the message. The row is kept as a tombstone --
     * body and attachments are cleared, so nothing decrypted survives, but the
     * slot stays so replies pointing at it still resolve.
     */
    deleted?: boolean;
}

/* ------------------------------------------------------------------ */
/* account registry (plaintext)                                        */
/* ------------------------------------------------------------------ */
