import { useCallback } from "react";
import {
    createEnvelope,
    openEnvelope,
    wrapChannelKeyForRecipient,
    unwrapChannelKey,
} from "@/lib/crypto";
import { StoredMessage } from "@/lib/vault";
import {
    RelayRefs,
    Incoming,
    MAX_PARKED,
    drainParked,
    drainMutations,
} from "@/lib/relay/types";

/**
 * The relay's inbound half: decrypt-and-apply handlers for every server frame,
 * plus the two outbound helpers (`offerKeyTo`, `broadcastProfile`) that the
 * socket effect and the outbound hook both drive. Split from `useRelay` so the
 * message-handling logic reads on its own.
 */
export function useRelayInbound(refs: RelayRefs, userId: string | null) {
    const { vaultRef, wsRef, handlers, parkedReactions, parkedMutations } =
        refs;

    const handleIncomingMessage = useCallback(
        async (data: Extract<Incoming, { type: "message" }>) => {
            const v = vaultRef.current;
            if (!v) return false;

            const channel = v.getChannel(data.channelId);
            if (!channel?.hasKey) return false; // no key yet; leave it queued

            const contact = v.getContact(data.senderId);

            const { envelope, verified } = await openEnvelope(
                { ciphertext: data.ciphertext, nonce: data.nonce },
                channel.key,
                {
                    senderId: data.senderId,
                    channelId: data.channelId,
                    signPublicKey: contact?.signPublicKey ?? null,
                },
            );

            if (contact?.keyChangedAt)
                handlers.current.onKeyChangeWarning?.(data.senderId);

            if (envelope.kind === "profile") {
                // A profile update carries the peer's display name and avatar. It is
                // only allowed to move the pinned record if the signature checked out --
                // otherwise anyone with the channel key could rename anyone.
                if (verified) {
                    await v.updateContactProfile(data.senderId, {
                        displayName: envelope.displayName,
                        avatar: envelope.avatar,
                        bio: envelope.bio,
                        background: envelope.background,
                    });
                    handlers.current.onChannelKey?.(data.channelId);
                }
                return true;
            }

            if (envelope.kind === "reaction") {
                // Unverified reactions are dropped outright rather than shown with a
                // warning. A message body gets badged "unverified" because the user needs
                // to see what was said before judging it; a reaction is a single glyph
                // whose entire meaning is "this person reacted". If we cannot confirm the
                // person, there is nothing left worth rendering.
                if (!verified || !envelope.reaction) return true;

                const { targetId, emoji, removed } = envelope.reaction;
                const updated = await v.applyReactionToMessage(
                    data.channelId,
                    targetId,
                    emoji,
                    data.senderId,
                    removed,
                );

                // Null means the target has not arrived yet -- normal when a reaction was
                // queued while we were offline, or we joined mid-conversation. Park it so
                // it lands when the message does, instead of silently vanishing.
                if (updated === null) {
                    // Drop the oldest rather than growing without bound: a peer can send
                    // reactions for ids that will never exist.
                    if (parkedReactions.current.length >= MAX_PARKED)
                        parkedReactions.current.shift();
                    parkedReactions.current.push({
                        channelId: data.channelId,
                        targetId,
                        emoji,
                        senderId: data.senderId,
                        removed,
                    });
                } else {
                    handlers.current.onChannelKey?.(data.channelId);
                }
                return true;
            }

            if (envelope.kind === "edit") {
                // An unverified edit is dropped, not shown: we cannot confirm who sent it,
                // and applying it would let a forged envelope rewrite someone's words.
                if (!verified || !envelope.edit) return true;
                const { targetId, body } = envelope.edit;
                const at = envelope.sentAt || data.createdAt;
                const updated = await v.editMessage(
                    data.channelId,
                    targetId,
                    data.senderId,
                    body,
                    at,
                );
                if (updated === null) {
                    if (parkedMutations.current.length >= MAX_PARKED)
                        parkedMutations.current.shift();
                    parkedMutations.current.push({
                        channelId: data.channelId,
                        targetId,
                        kind: "edit",
                        senderId: data.senderId,
                        body,
                        at,
                    });
                } else {
                    handlers.current.onChannelKey?.(data.channelId);
                }
                return true;
            }

            if (envelope.kind === "delete") {
                if (!verified || !envelope.del) return true;
                const { targetId } = envelope.del;
                const updated = await v.deleteMessage(
                    data.channelId,
                    targetId,
                    data.senderId,
                );
                if (updated === null) {
                    if (parkedMutations.current.length >= MAX_PARKED)
                        parkedMutations.current.shift();
                    parkedMutations.current.push({
                        channelId: data.channelId,
                        targetId,
                        kind: "delete",
                        senderId: data.senderId,
                    });
                } else {
                    handlers.current.onChannelKey?.(data.channelId);
                }
                return true;
            }

            const message: StoredMessage = {
                // The sender's stable id, so this message matches the sender's own copy
                // (and thus their edits, deletes and reactions). Falls back to the queue
                // id only for a client that did not send one.
                id: data.clientId ?? data.messageId,
                channelId: data.channelId,
                senderId: data.senderId,
                displayName: envelope.displayName,
                // A locked message arrives with an empty body and its sealed payload; it
                // stays unreadable until the recipient enters the code.
                body: envelope.body,
                asset: envelope.avatar,
                // Attachment keys, the preview and the reply reference are all inside the
                // signature. If `verified` is false the UI badges the whole message as
                // untrusted, which covers these too -- a forged preview is a phishing
                // surface and a forged reply target misattributes a conversation.
                attachments: envelope.attachments,
                preview: envelope.preview,
                replyTo: envelope.replyTo,
                locked: envelope.locked,
                protected: Boolean(envelope.locked),
                // The recipient's burn clock starts when the message is first shown, not
                // now -- so firstViewedAt is left unset for processBurns to stamp.
                burnTtl: envelope.burn?.ttl,
                spoiler: envelope.spoiler === true,
                // Only honour the crown on a verified message: an unverified one has no
                // trustworthy sender to attribute a badge to.
                supporterClaimed: verified && envelope.supporter === true,
                createdAt: envelope.sentAt || data.createdAt,
                verified,
            };

            await v.appendMessage(message);

            // A reaction, edit, or delete that arrived before its target can now land.
            await drainParked(parkedReactions, v, data.channelId, message.id);
            await drainMutations(
                parkedMutations,
                v,
                data.channelId,
                message.id,
            );

            handlers.current.onMessage?.(message);
            return true;
        },
        [],
    );

    const handleIncomingSignal = useCallback(
        async (data: Extract<Incoming, { type: "signal" }>) => {
            const v = vaultRef.current;
            if (!v) return;

            const channel = v.getChannel(data.channelId);
            if (!channel?.hasKey) return;

            const contact = v.getContact(data.senderId);
            const { envelope, verified } = await openEnvelope(
                { ciphertext: data.ciphertext, nonce: data.nonce },
                channel.key,
                {
                    senderId: data.senderId,
                    channelId: data.channelId,
                    signPublicKey: contact?.signPublicKey ?? null,
                },
            );

            // A call frame is only honoured if the signature checks out. An unverified
            // one could ring a user with a fabricated peer or inject an SDP to steer the
            // media path -- both are dropped rather than surfaced.
            if (!verified || envelope.kind !== "call" || !envelope.call) return;

            handlers.current.onSignal?.({
                channelId: data.channelId,
                senderId: data.senderId,
                signal: envelope.call,
            });
        },
        [],
    );

    const handleKeyOffer = useCallback(
        async (data: Extract<Incoming, { type: "key-offer" }>) => {
            const v = vaultRef.current;
            if (!v) return false;

            const existing = v.getChannel(data.channelId);
            if (existing?.hasKey) return true; // already keyed; ack and move on

            // Pin the offering member's keys before trusting the offer. crypto_box is
            // authenticated, so unwrap only succeeds if the sender really holds the
            // private half of senderPubkey.
            await v.pinContact({
                userId: data.senderId,
                publicKey: data.senderPubkey,
                signPublicKey: data.senderSignPubkey,
            });

            const key = await unwrapChannelKey(
                { ciphertext: data.ciphertext, nonce: data.nonce },
                data.senderPubkey,
                v.identity.privateKey,
            );

            await v.saveChannel({
                channelId: data.channelId,
                code: existing?.code ?? "",
                key,
                hasKey: true,
                joinedAt: existing?.joinedAt ?? new Date().toISOString(),
                label: existing?.label,
                icon: existing?.icon,
                // Preserve the incognito flag: dropping it here reverted a joiner to a
                // normal channel the moment the key arrived, leaking their real name.
                incognito: existing?.incognito,
                // Preserve DM metadata for the same reason -- for the DM peer this offer
                // arrives before the /channel/list reconcile that first set these, but on
                // a reconnect the fields are already local and must not be dropped.
                type: existing?.type,
                peerId: existing?.peerId,
                blocked: existing?.blocked,
            });

            handlers.current.onChannelKey?.(data.channelId);
            return true;
        },
        [],
    );

    // Someone in a channel we hold a key for needs that key. Wrap it for them.
    const offerKeyTo = useCallback(
        async (
            channelId: string,
            recipient: { userId: string; pubkey: string; signPubkey: string },
        ) => {
            const v = vaultRef.current;
            const ws = wsRef.current;
            if (!v || !ws || ws.readyState !== ws.OPEN) return;

            const channel = v.getChannel(channelId);
            if (!channel?.hasKey) return;

            await v.pinContact({
                userId: recipient.userId,
                publicKey: recipient.pubkey,
                signPublicKey: recipient.signPubkey,
            });

            const sealed = await wrapChannelKeyForRecipient(
                channel.key,
                recipient.pubkey,
                v.identity.privateKey,
            );

            ws.send(
                JSON.stringify({
                    type: "key-offer",
                    channelId,
                    recipientId: recipient.userId,
                    ciphertext: sealed.ciphertext,
                    nonce: sealed.nonce,
                }),
            );
        },
        [],
    );

    /**
     * Push display name + avatar to a channel, encrypted and signed.
     *
     * This is why the server never learns a username: identity travels inside
     * the same sealed envelope as the message body, addressed only to people who
     * already hold the channel key.
     *
     * Declared above the socket effect on purpose -- the effect's dependency
     * array is evaluated during render, so referencing a `const` declared below
     * it would throw a TDZ ReferenceError.
     */
    const broadcastProfile = useCallback(
        async (channelId: string) => {
            const v = vaultRef.current;
            const ws = wsRef.current;
            if (!v || !userId || !ws || ws.readyState !== ws.OPEN) return;

            const channel = v.getChannel(channelId);
            if (!channel?.hasKey) return;
            // Incognito channels never receive a profile: no name, no avatar, ever.
            if (channel.incognito) return;

            const profile = v.profile;
            const sealed = await createEnvelope(
                {
                    kind: "profile",
                    body: "",
                    displayName: profile.displayName,
                    avatar: profile.avatar,
                    bio: profile.bio,
                    background: profile.background,
                    sentAt: new Date().toISOString(),
                },
                channelId,
                userId,
                v.identity.signPrivateKey,
                channel.key,
            );

            ws.send(
                JSON.stringify({
                    type: "send",
                    channelId,
                    kind: "profile",
                    ciphertext: sealed.ciphertext,
                    nonce: sealed.nonce,
                }),
            );
        },
        [userId],
    );

    return {
        handleIncomingMessage,
        handleIncomingSignal,
        handleKeyOffer,
        offerKeyTo,
        broadcastProfile,
    };
}
