import sodium from "libsodium-wrappers-sumo";
import { Bytes, bytesToBase64Url, wipe } from "@/lib/binary";
import { ensureReady, fromB64 } from "@/lib/crypto/internal";
import {
    Identity,
    deriveVaultKey,
    generateSalt,
    sealWithKey,
    openWithKey,
} from "@/lib/crypto/keys";

/* ------------------------------------------------------------------ */
/* key export / import                                                 */
/* ------------------------------------------------------------------ */

export interface KeyBundle {
    v: number;
    userId: string;
    identity: Identity;
    channels: { channelId: string; code: string; key: string }[];
    exportedAt: string;
}

export interface EncryptedBundle {
    format: "darkchat-keys";
    v: number;
    kdf: "argon2id";
    salt: string;
    ciphertext: string;
    nonce: string;
}

/**
 * Export keys under a passphrase chosen for the export itself.
 *
 * Not the login password: the export file leaves the device, so wrapping it
 * with the same secret that guards the account means one leaked file is a full
 * account compromise. A separate passphrase and a fresh salt keep the two
 * blast radii apart.
 */
export async function exportKeyBundle(
    bundle: Omit<KeyBundle, "v" | "exportedAt">,
    passphrase: string,
): Promise<EncryptedBundle> {
    await ensureReady();
    if (passphrase.length < 12)
        throw new Error("export passphrase must be at least 12 characters");

    const salt = await generateSalt();
    const key = await deriveVaultKey(passphrase, salt);
    try {
        const payload: KeyBundle = {
            ...bundle,
            v: 1,
            exportedAt: new Date().toISOString(),
        };
        const sealed = await sealWithKey(JSON.stringify(payload), key);
        return {
            format: "darkchat-keys",
            v: 1,
            kdf: "argon2id",
            salt,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
        };
    } finally {
        wipe(key);
    }
}

export async function importKeyBundle(
    encrypted: EncryptedBundle,
    passphrase: string,
): Promise<KeyBundle> {
    await ensureReady();
    if (encrypted?.format !== "darkchat-keys")
        throw new Error("not a CryptChat key file");
    if (encrypted.v !== 1)
        throw new Error(`unsupported key file version ${encrypted.v}`);

    const key = await deriveVaultKey(passphrase, encrypted.salt);
    try {
        // A wrong passphrase surfaces as a Poly1305 auth failure, which is what
        // makes this file safe to carry on a USB stick.
        const json = await openWithKey(
            { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce },
            key,
        ).catch(() => {
            throw new Error("wrong passphrase or corrupted key file");
        });
        return JSON.parse(json) as KeyBundle;
    } finally {
        wipe(key);
    }
}

/* ------------------------------------------------------------------ */
/* recovery code                                                       */
/* ------------------------------------------------------------------ */

/**
 * The recovery code: 256 bits of CSPRNG output, rendered as 24 words.
 *
 * This is what makes recovery possible at all. The vault lives only in this
 * browser's localStorage and the server has never held a private key, so a
 * device that has never seen the account has nothing to unlock -- no password
 * can fix that, because the ciphertext simply is not there. The recovery blob
 * (a KeyBundle sealed under this code, parked on the server) is the only copy it
 * can reach.
 *
 * Why the server may hold that blob when it may not hold the vault: the vault is
 * sealed under a human-chosen password, so a server holding it holds an offline
 * cracking target worth grinding. This is sealed under 256 random bits. There is
 * no dictionary, no wordlist and no amount of GPU that makes 2^256 approachable
 * -- the server holds ciphertext it cannot attack, exactly the standard it
 * already meets for every message it relays.
 *
 * Words, not hex: this gets written on paper and typed back months later and
 * people transcribe words correctly far more often than 64 hex characters.
 */
export const RECOVERY_CODE_WORDS = 24;

/**
 * BIP39, via @scure/bip39 rather than hand-rolled.
 *
 * The encoding is not the interesting part of this feature and getting it subtly
 * wrong is entirely possible -- the checksum, the bit packing and NFKD
 * normalization of typed input all have edge cases. @scure/bip39 is audited and
 * its English wordlist is chosen so the first four letters of every word are
 * unique, which is what makes a handwritten phrase survive bad handwriting.
 *
 * Using BIP39 here does NOT mean this is a crypto wallet. It is a well-specified
 * way to render 256 bits as words and read them back, nothing more.
 *
 * Lazily imported: the wordlist is ~13KB and users who never register or recover
 * should not pay for it in the main bundle.
 */
async function bip39() {
    // The `.js` suffix is required: the package's export map lists
    // "./wordlists/english.js" and nothing resolves without it.
    const [core, english] = await Promise.all([
        import("@scure/bip39"),
        import("@scure/bip39/wordlists/english.js"),
    ]);
    return { core, wordlist: english.wordlist };
}

export interface RecoveryCode {
    /** The 24 words, space-separated. Shown once, never stored, never sent. */
    phrase: string;
    /** Raw entropy, for immediate use in deriving the wrap key. */
    entropy: Bytes;
}

export async function generateRecoveryCode(): Promise<RecoveryCode> {
    const { core, wordlist } = await bip39();
    // 256 bits -> 24 words.
    const phrase = core.generateMnemonic(wordlist, 256);
    return { phrase, entropy: core.mnemonicToEntropy(phrase, wordlist) };
}

/**
 * Parse a typed-back phrase into entropy.
 *
 * A mistyped word fails the BIP39 checksum here, which matters for the error
 * message: without it the user would see "wrong recovery code" from a failed
 * Poly1305 tag, indistinguishable from "the server handed you a corrupt blob".
 */
export async function parseRecoveryCode(phrase: string): Promise<Bytes> {
    const { core, wordlist } = await bip39();
    const normalized = phrase
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .join(" ");

    const count = normalized ? normalized.split(" ").length : 0;
    if (count !== RECOVERY_CODE_WORDS) {
        throw new Error(
            `recovery code must be ${RECOVERY_CODE_WORDS} words (got ${count})`,
        );
    }

    try {
        return core.mnemonicToEntropy(normalized, wordlist);
    } catch {
        throw new Error(
            "recovery code is not valid -- check for a mistyped word",
        );
    }
}

/**
 * The blob the server parks. Same shape as an exported key file, but wrapped
 * under the recovery code instead of a chosen passphrase.
 */
export interface RecoveryBlob {
    ciphertext: string;
    nonce: string;
    salt: string;
}

async function deriveRecoveryKey(
    entropy: Bytes,
    saltB64: string,
): Promise<Bytes> {
    await ensureReady();
    const salt = fromB64(saltB64);
    if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
        throw new Error("invalid recovery salt");
    }

    // The entropy goes in as base64 text, not as raw bytes reinterpreted as a
    // string. Random bytes are not valid UTF-8, so decoding them would either
    // throw (our decoder is fatal:true) or -- with a lenient decoder -- silently
    // map whole byte ranges onto U+FFFD and collapse the entropy. base64 is a
    // lossless, injective rendering, so distinct codes stay distinct keys.
    //
    // Argon2id over already-uniform 256-bit input is not doing the work it does
    // over a password: there is nothing to slow down, because there is nothing to
    // guess. It is here so the blob's format matches the export path and so that
    // if product ever shortens the code, the derivation is already hardened rather
    // than needing to be remembered. INTERACTIVE limits keep it off the critical
    // path.
    return sodium.crypto_pwhash(
        sodium.crypto_secretbox_KEYBYTES,
        bytesToBase64Url(entropy),
        salt,
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
}

export async function sealRecoveryBlob(
    bundle: Omit<KeyBundle, "v" | "exportedAt">,
    entropy: Bytes,
): Promise<RecoveryBlob> {
    await ensureReady();
    const salt = await generateSalt();
    const key = await deriveRecoveryKey(entropy, salt);
    try {
        const payload: KeyBundle = {
            ...bundle,
            v: 1,
            exportedAt: new Date().toISOString(),
        };
        const sealed = await sealWithKey(JSON.stringify(payload), key);
        return { ciphertext: sealed.ciphertext, nonce: sealed.nonce, salt };
    } finally {
        wipe(key);
    }
}

export async function openRecoveryBlob(
    blob: RecoveryBlob,
    entropy: Bytes,
): Promise<KeyBundle> {
    await ensureReady();
    const key = await deriveRecoveryKey(entropy, blob.salt);
    try {
        const json = await openWithKey(
            { ciphertext: blob.ciphertext, nonce: blob.nonce },
            key,
        ).catch(() => {
            throw new Error("wrong recovery code");
        });
        return JSON.parse(json) as KeyBundle;
    } finally {
        wipe(key);
    }
}
