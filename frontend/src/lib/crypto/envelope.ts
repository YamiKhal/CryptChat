import sodium from "libsodium-wrappers-sumo";
import { Bytes, stringToBytes, concatBytes, BinaryAsset } from "@/lib/binary";
import {
    ensureReady,
    toB64,
    fromB64,
    ENVELOPE_VERSION,
    SUPPORTED_VERSIONS,
} from "@/lib/crypto/internal";
import { Sealed, sealWithKey, openWithKey } from "@/lib/crypto/keys";
import { EnvelopeContent, SignedEnvelope } from "@/lib/crypto/envelopeTypes";
import {
    isValidReplyRef,
    isValidReactionRef,
    isValidEditRef,
    isValidDeleteRef,
    isValidCallSignal,
    isValidBurnRef,
    isValidLockedPayload,
    MAX_BIO,
} from "@/lib/crypto/validators";

/**
 * Canonical byte encoding of everything the signature commits to.
 *
 * Length-prefixed rather than concatenated or JSON-stringified. Plain
 * concatenation is ambiguous -- ("ab","c") and ("a","bc") would produce
 * identical signed bytes, letting a member shift a boundary to reattribute
 * text. JSON.stringify is unusable here because key order is not guaranteed
 * stable across engines, so a valid signature could fail to verify elsewhere.
 *
 * channelId and senderId are inside the signature so a captured envelope
 * cannot be replayed into a different channel or reattributed to another
 * member by a relay that rewrites the outer senderId field.
 */
function assetField(asset?: BinaryAsset): string {
    return asset ? `${asset.mime}:${asset.data}` : "";
}

function canonicalBytes(env: Omit<SignedEnvelope, "sig">): Bytes {
    const fields = [
        String(env.v),
        env.kind,
        env.channelId,
        env.senderId,
        env.sentAt,
        env.displayName,
        env.body,
        assetField(env.avatar),
    ];

    // Attachments are signed field-by-field, including the key and the content
    // hash. Signing only the blobId would let another member (or a relay holding
    // the channel key) repoint a message at different bytes, or swap the key so
    // the file silently fails to open. The count is signed too, so an attachment
    // cannot be appended or dropped.
    const attachments = env.attachments ?? [];
    fields.push(String(attachments.length));
    for (const a of attachments) {
        fields.push(
            a.blobId,
            a.key,
            a.header,
            a.name,
            a.mime,
            String(a.size),
            a.hash,
            String(a.chunkSize),
            assetField(a.thumb),
        );
    }

    // The preview is sender-asserted text rendered next to their name, so it has
    // to be signed like anything else they say.
    fields.push(env.preview ? "1" : "0");
    if (env.preview) {
        fields.push(
            env.preview.url,
            env.preview.kind,
            env.preview.title ?? "",
            env.preview.description ?? "",
            env.preview.siteName ?? "",
            env.preview.videoId ?? "",
            assetField(env.preview.image),
        );
    }

    // v3 fields are appended, never interleaved and the domain string changes
    // with the version. Both matter: a v2 envelope must produce byte-identical
    // input to what it was signed over, or every message already in a vault stops
    // verifying and the UI marks the entire history "unverified".
    if (env.v >= 3) {
        // Reply metadata is signed. Without this a relay could repoint a reply at a
        // different message, or forge one and make someone appear to be answering
        // something they never saw.
        fields.push(env.replyTo ? "1" : "0");
        if (env.replyTo) {
            fields.push(
                env.replyTo.id,
                env.replyTo.senderId,
                env.replyTo.displayName,
                env.replyTo.excerpt,
                env.replyTo.kind,
            );
        }

        // Same for reactions: the target and the toggle state are both signed, so a
        // relay can neither move a reaction onto another message nor replay an old
        // "add" to undo someone's removal.
        fields.push(env.reaction ? "1" : "0");
        if (env.reaction) {
            fields.push(
                env.reaction.targetId,
                env.reaction.emoji,
                env.reaction.removed ? "1" : "0",
            );
        }
    }

    // v4 adds edit and delete, both signed acts pointing at a target message.
    // Appended after the v3 block for the same reason v3 was appended after v2:
    // an existing v3 envelope must still hash to exactly what it was signed over.
    if (env.v >= 4) {
        fields.push(env.edit ? "1" : "0");
        if (env.edit) fields.push(env.edit.targetId, env.edit.body);

        fields.push(env.del ? "1" : "0");
        if (env.del) fields.push(env.del.targetId);

        // The locked payload is signed too: the ciphertext, salt, nonce and hint
        // are all part of what the sender committed to, so a relay cannot swap the
        // sealed body or rewrite the hint.
        fields.push(env.locked ? "1" : "0");
        if (env.locked) {
            fields.push(
                env.locked.salt,
                env.locked.nonce,
                env.locked.ct,
                env.locked.hint ?? "",
            );
        }

        // The burn timer is signed so a relay cannot strip it (keeping a message
        // that was meant to vanish) or lengthen it.
        fields.push(env.burn ? "1" : "0");
        if (env.burn) fields.push(String(env.burn.ttl));
    }

    // v5 adds the opt-in supporter flag. New version rather than another append to
    // v4, so every v4 message already in a vault still verifies unchanged.
    if (env.v >= 5) {
        fields.push(env.supporter ? "1" : "0");
    }

    // v6 adds call signaling. Appended after v5 so every v5 message already in a
    // vault verifies unchanged. The whole signal is signed -- kind, callId, media,
    // and the SDP/candidate -- so a relay cannot forge a ring, swap an SDP (which
    // would let it man-in-the-middle the media path), or spoof a hangup.
    if (env.v >= 6) {
        fields.push(env.call ? "1" : "0");
        if (env.call) {
            fields.push(
                env.call.kind,
                env.call.callId,
                env.call.media ?? "",
                env.call.screen ? "1" : "0",
                env.call.sdp ?? "",
                env.call.candidate ?? "",
                env.call.on ? "1" : "0",
            );
        }
    }

    // v7 adds the whole-message spoiler flag. Appended after v6 so every v6
    // message already in a vault verifies unchanged.
    if (env.v >= 7) {
        fields.push(env.spoiler ? "1" : "0");
    }

    // v8 adds the profile bio and banner. Signed even on message envelopes (as
    // empty strings) so the encoding stays fixed; only profile envelopes ever set
    // them. Appended after v7 so every v7 message already in a vault verifies
    // unchanged.
    if (env.v >= 8) {
        fields.push(env.bio ?? "");
        fields.push(assetField(env.background));
    }

    const parts: Bytes[] = [stringToBytes(`darkchat-envelope-v${env.v}`)];
    for (const field of fields) {
        const bytes = stringToBytes(field);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length, false);
        parts.push(len, bytes);
    }
    return concatBytes(...parts);
}

export async function createEnvelope(
    content: Omit<EnvelopeContent, "v">,
    channelId: string,
    senderId: string,
    signPrivKeyB64: string,
    channelKeyB64: string,
): Promise<Sealed> {
    await ensureReady();

    const unsigned: Omit<SignedEnvelope, "sig"> = {
        ...content,
        v: ENVELOPE_VERSION,
        channelId,
        senderId,
    };

    const sig = sodium.crypto_sign_detached(
        canonicalBytes(unsigned),
        fromB64(signPrivKeyB64),
    );
    const envelope: SignedEnvelope = { ...unsigned, sig: toB64(sig) };

    return sealWithKey(JSON.stringify(envelope), channelKeyB64);
}

export interface OpenedEnvelope {
    envelope: SignedEnvelope;
    verified: boolean;
}

/**
 * Open and verify.
 *
 * Decryption alone proves only that the author held the channel key -- which
 * every member does. Without the signature check, any member (or a relay that
 * obtained the key) could forge a message attributed to anyone else. The
 * caller supplies the *pinned* signing key for the claimed sender; a mismatch
 * is reported rather than thrown so the UI can surface it.
 */
export async function openEnvelope(
    sealed: Sealed,
    channelKeyB64: string,
    expected: {
        senderId: string;
        channelId: string;
        signPublicKey: string | null;
    },
): Promise<OpenedEnvelope> {
    await ensureReady();

    const json = await openWithKey(sealed, channelKeyB64);
    const envelope = JSON.parse(json) as SignedEnvelope;

    if (typeof envelope !== "object" || envelope === null)
        throw new Error("malformed envelope");
    // Older versions are still accepted for reading: they are what messages
    // already in a vault were signed under. Only ENVELOPE_VERSION is ever written.
    if (!SUPPORTED_VERSIONS.has(envelope.v)) {
        throw new Error(`unsupported envelope version ${envelope.v}`);
    }
    if (
        typeof envelope.body !== "string" ||
        typeof envelope.displayName !== "string"
    ) {
        throw new Error("malformed envelope");
    }

    // A peer controls these. Validating shape here keeps malformed or hostile
    // structures out of the UI, which would otherwise render whatever it was
    // handed.
    if (envelope.replyTo && !isValidReplyRef(envelope.replyTo)) {
        throw new Error("malformed reply reference");
    }
    if (envelope.reaction && !isValidReactionRef(envelope.reaction)) {
        throw new Error("malformed reaction");
    }
    if (envelope.edit && !isValidEditRef(envelope.edit)) {
        throw new Error("malformed edit");
    }
    if (envelope.del && !isValidDeleteRef(envelope.del)) {
        throw new Error("malformed delete");
    }
    if (envelope.locked && !isValidLockedPayload(envelope.locked)) {
        throw new Error("malformed locked payload");
    }
    if (envelope.burn && !isValidBurnRef(envelope.burn)) {
        throw new Error("malformed burn timer");
    }
    if (envelope.call && !isValidCallSignal(envelope.call)) {
        throw new Error("malformed call signal");
    }
    // A peer controls the bio. Cap it so a hostile profile cannot push an
    // unbounded string into every recipient's vault. The banner is validated on
    // render (unpackAsset enforces the image allowlist), like any other asset.
    if (
        envelope.bio !== undefined &&
        (typeof envelope.bio !== "string" || envelope.bio.length > MAX_BIO)
    ) {
        throw new Error("malformed bio");
    }

    // The transport's claim about the sender and channel must match what the
    // signature covers, or attribution can be swapped at the relay.
    if (envelope.senderId !== expected.senderId)
        throw new Error("sender mismatch");
    if (envelope.channelId !== expected.channelId)
        throw new Error("channel mismatch");

    if (!expected.signPublicKey) return { envelope, verified: false };

    const { sig, ...unsigned } = envelope;
    const verified = sodium.crypto_sign_verify_detached(
        fromB64(sig),
        canonicalBytes(unsigned),
        fromB64(expected.signPublicKey),
    );

    return { envelope, verified };
}
