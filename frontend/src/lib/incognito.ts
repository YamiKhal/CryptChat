/**
 * Per-channel pseudonymous identity for incognito channels (ROADMAP #7).
 *
 * In an incognito channel nobody sends a name or an avatar; members are shown
 * only as a stable colour with a short tag. The mapping is derived from the
 * channel id AND the sender id together, so the same person is a *different*
 * colour in a different channel -- a member cannot use the colour to link you
 * across channels.
 *
 * Honest scope: this is what other members see. The relay still knows the
 * membership it routes for (it has to) and the signed envelope still carries
 * the real sender id for verification -- so this is anonymity from the people in
 * the room, not from the server. The colour is deterministic and local; no
 * secret is involved, so it needs no key.
 */

/** FNV-1a, enough for a stable colour bucket. Not a security primitive. */
function hash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Hue in [0, 360) for a member within one channel. Differs per channel. */
export function incognitoHue(channelId: string, senderId: string): number {
    return hash(`${channelId}|${senderId}`) % 360;
}

// Crockford-ish, minus easily-confused characters, for a legible short tag.
const TAG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short, stable pseudonym like "guest·7QF" so members can tell each other
 * apart within a channel without any real identity. Derived separately from the
 * hue so two members are unlikely to share both.
 */
export function incognitoLabel(channelId: string, senderId: string): string {
    let n = hash(`${channelId}|tag|${senderId}`);
    let tag = "";
    for (let i = 0; i < 3; i++) {
        tag += TAG_ALPHABET[n % TAG_ALPHABET.length];
        n = Math.floor(n / TAG_ALPHABET.length);
    }
    return `guest·${tag}`;
}
