import { MutableRefObject } from "react";
import { Attachment, LinkPreview, ReplyRef, CallSignal } from "@/lib/crypto";
import { BinaryAsset } from "@/lib/binary";
import { Vault, StoredMessage } from "@/lib/vault";

/** Cap on the parked reaction/mutation buffers, which the network feeds. */
export const MAX_PARKED = 200;

/** The event callbacks the relay fires up into React state. */
export interface RelayHandlers {
    onMessage?: (message: StoredMessage) => void;
    onChannelKey?: (channelId: string) => void;
    onKeyChangeWarning?: (userId: string) => void;
    /** Ephemeral "someone is typing". never stored, never in the transcript. `stop` retracts it. */
    onTyping?: (event: {
        channelId: string;
        senderId: string;
        stop: boolean;
    }) => void;
    /** Anonymous join/leave notice for a channel. Carries no identity. */
    onPresence?: (event: {
        channelId: string;
        event: "joined" | "left";
    }) => void;
    /** A verified WebRTC call-control frame for a DM. Never stored. */
    onSignal?: (event: {
        channelId: string;
        senderId: string;
        signal: CallSignal;
    }) => void;
}

export interface RelayOptions extends RelayHandlers {
    vault: Vault | null;
    token: string | null;
    userId: string | null;
}

export interface SendPayload {
    body: string;
    asset?: BinaryAsset;
    attachments?: Attachment[];
    preview?: LinkPreview;
    replyTo?: ReplyRef;
    /** When set, the body is sealed under this code and sent locked (premium). */
    lock?: { code: string; hint?: string };
    /** Burn-after-read ttl in seconds; the message self-destructs after first view. */
    burn?: number;
    /** Cover the whole message until the reader clicks to reveal it. */
    spoiler?: boolean;
}

/**
 * The stable refs shared across the relay's inbound and outbound hooks: the live
 * socket, the current vault, the up-to-date event handlers and the parked
 * reaction/mutation buffers. Created once by `useRelay` and threaded down.
 */
export interface RelayRefs {
    wsRef: MutableRefObject<WebSocket | null>;
    vaultRef: MutableRefObject<Vault | null>;
    handlers: MutableRefObject<RelayHandlers>;
    parkedReactions: MutableRefObject<ParkedReaction[]>;
    parkedMutations: MutableRefObject<ParkedMutation[]>;
}

export interface ParkedReaction {
    channelId: string;
    targetId: string;
    emoji: string;
    senderId: string;
    removed: boolean;
}

/**
 * Apply any parked reactions now that `messageId` exists locally.
 *
 * Mutates the parked list in place, removing what it applied.
 */
export async function drainParked(
    parked: { current: ParkedReaction[] },
    vault: Vault,
    channelId: string,
    messageId: string,
): Promise<boolean> {
    const ready = parked.current.filter(
        (reaction) =>
            reaction.channelId === channelId && reaction.targetId === messageId,
    );
    if (ready.length === 0) return false;

    parked.current = parked.current.filter(
        (reaction) =>
            !(
                reaction.channelId === channelId &&
                reaction.targetId === messageId
            ),
    );

    for (const reaction of ready) {
        await vault.applyReactionToMessage(
            channelId,
            reaction.targetId,
            reaction.emoji,
            reaction.senderId,
            reaction.removed,
        );
    }
    return true;
}

/** An edit or delete whose target message has not arrived yet. */
export interface ParkedMutation {
    channelId: string;
    targetId: string;
    kind: "edit" | "delete";
    senderId: string;
    body?: string;
    at?: string;
}

/**
 * Apply parked edits/deletes now that `messageId` exists.
 *
 * Ordering usually saves us -- the relay flushes the original (older timestamp)
 * before the edit -- but a member who joined mid-conversation can receive an
 * edit for a message they never had, so these are parked like reactions rather
 * than dropped. The author check lives in the vault, so a parked mutation from
 * the wrong sender simply no-ops when it drains.
 */
export async function drainMutations(
    parked: { current: ParkedMutation[] },
    vault: Vault,
    channelId: string,
    messageId: string,
): Promise<boolean> {
    const ready = parked.current.filter(
        (mutation) =>
            mutation.channelId === channelId && mutation.targetId === messageId,
    );
    if (ready.length === 0) return false;

    parked.current = parked.current.filter(
        (mutation) =>
            !(
                mutation.channelId === channelId &&
                mutation.targetId === messageId
            ),
    );

    for (const mutation of ready) {
        if (mutation.kind === "edit") {
            await vault.editMessage(
                channelId,
                mutation.targetId,
                mutation.senderId,
                mutation.body ?? "",
                mutation.at,
            );
        } else {
            await vault.deleteMessage(
                channelId,
                mutation.targetId,
                mutation.senderId,
            );
        }
    }
    return true;
}

export type Incoming =
    | {
          type: "message";
          messageId: string;
          clientId?: string | null;
          channelId: string;
          senderId: string;
          kind: string;
          ciphertext: string;
          nonce: string;
          createdAt: string;
      }
    | {
          type: "key-offer";
          offerId: string;
          channelId: string;
          senderId: string;
          senderPubkey: string;
          senderSignPubkey: string;
          ciphertext: string;
          nonce: string;
      }
    | {
          type: "key-request";
          channelId: string;
          requesterId: string;
          requesterPubkey: string;
          requesterSignPubkey: string;
      }
    | {
          type: "member-joined";
          channelId: string;
          userId: string;
          pubkey: string;
          signPubkey: string;
      }
    | { type: "member-left"; channelId: string }
    | { type: "typing"; channelId: string; senderId: string; stop?: boolean }
    | {
          type: "signal";
          channelId: string;
          senderId: string;
          ciphertext: string;
          nonce: string;
      }
    | { type: "profile-request"; channelId: string; requesterId: string }
    | { type: "sent"; clientId: string; channelId: string }
    | { type: "key-offer-sent"; channelId: string; recipientId: string }
    | { type: "dm-request"; channelId: string };
