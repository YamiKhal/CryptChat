export type IconName =
    | "ShieldCheck"
    | "Flame"
    | "Lock"
    | "Database"
    | "KeyRound"
    | "Phone"
    | "Palette"
    | "WifiOff"
    | "EyeOff"
    | "HardDriveDownload";

/** The three-word identity shown in the hero and the browser tab. */
export const BRAND = "CryptChat";
export const TAGLINE = "end-to-end encrypted chat";
export const HERO_LINE = "Your own chats, stored on your device.";
export const HERO_SUB =
    "Chats encrypted on your device, sealed in a vault only your password opens. No plaintext ever leaves. No server ever reads it.";

/** Ticker strip under the hero. short claims, looped forever. */
export const MARQUEE = [
    "End-to-end encrypted",
    "Burn on read",
    "Passphrase locks",
    "Local vault",
    "Encrypted calls",
    "Keyed accounts",
    "Sealed backups",
];

/** Landing feature grid. the load-bearing claims, one line each. */
export interface Feature {
    icon: IconName;
    title: string;
    body: string;
}

export const FEATURES: Feature[] = [
    {
        icon: "ShieldCheck",
        title: "End-to-end encrypted",
        body: "Every message is encrypted before it leaves your device. The relay moves ciphertext it cannot read.",
    },
    {
        icon: "Flame",
        title: "Burn on read",
        body: "Send a message that self-destructs. It leaves both sides the moment it is seen.",
    },
    {
        icon: "Lock",
        title: "Lock a message",
        body: "Seal a message behind its own passphrase. Only the person with the word sees inside.",
    },
    {
        icon: "Database",
        title: "Local vault",
        body: "Your identity, keys and history live sealed in your browser, never as plaintext on a server.",
    },
    {
        icon: "KeyRound",
        title: "Your security",
        body: "A recovery phrase you hold is the only way back in. Lose the password, keep the phrase.",
    },
    {
        icon: "Phone",
        title: "Encrypted calls",
        body: "Voice that connects peer-to-peer and stays between the two of you.",
    },
];

/** Showcase. a walked product tour. Each panel alternates side on the page. */
export interface ShowcasePanel {
    kicker: string;
    title: string;
    body: string;
    points: string[];
}

export const SHOWCASE: ShowcasePanel[] = [
    {
        kicker: "Identity",
        title: "An account only you can open",
        body: "Sign up and a keypair is generated on your device. Your password seals it; a recovery phrase is your one backup key. Nothing about your identity sits readable on a server.",
        points: [
            "Keys generated locally, never uploaded",
            "Password-sealed vault in your browser",
            "One recovery phrase, held only by you",
        ],
    },
    {
        kicker: "Conversations",
        title: "Channels that carry ciphertext",
        body: "Start a channel with a code, invite who you trust. Messages encrypt before they send and decrypt only on the far end. The relay is a courier that never opens the envelope.",
        points: [
            "Per-message end-to-end encryption",
            "Replies, reactions, attachments, link previews",
            "Trust panel to verify who you are talking to",
        ],
    },
    {
        kicker: "Control",
        title: "Messages with an expiry",
        body: "Not everything should live forever. Burn a message so it vanishes on read, or lock one behind a passphrase so only the right person opens it.",
        points: [
            "Burn-on-read self-destruct",
            "Per-message passphrase lock",
            "Nothing recoverable once it is gone",
        ],
    },
    {
        kicker: "Yours",
        title: "Portable, themeable, offline-safe",
        body: "Export your whole vault as one sealed file and carry it anywhere. Make it yours with themes and a custom accent. Your data is a file you own, not a row in someone's table.",
        points: [
            "Full-vault encrypted backup, sealed under your password",
            "Light and dark, custom accent for premium",
            "Everything readable only after you unlock",
        ],
    },
];

/** Knowledge base. grouped articles. Bodies are short, plain answers. */
export interface KbArticle {
    q: string;
    a: string;
}

export interface KbSection {
    icon: IconName;
    title: string;
    articles: KbArticle[];
}

export const KB: KbSection[] = [
    {
        icon: "KeyRound",
        title: "Getting started",
        articles: [
            {
                q: "How do I create an account?",
                a: "Open the app and register with a username and password. A keypair is generated on your device and sealed under your password. Write down the recovery phrase you are shown. it is the only way back in if you forget the password.",
            },
            {
                q: "What is the recovery phrase for?",
                a: "It is a backup key held only by you. If you lose your password, the phrase unlocks your account. If you lose both, no one. including us. can recover the vault. That is the point.",
            },
            {
                q: "Can I use CryptChat on more than one device?",
                a: "Yes. Export your vault as a sealed backup file on one device and import it on another. The backup is encrypted under your password, so the file is useless to anyone who does not know it.",
            },
        ],
    },
    {
        icon: "ShieldCheck",
        title: "Security",
        articles: [
            {
                q: "What does end-to-end encrypted mean here?",
                a: "Messages are encrypted on your device and decrypted only on the recipient's. The relay that carries them handles ciphertext and never holds the keys to read it.",
            },
            {
                q: "Can the server read my messages?",
                a: "No. The server stores and forwards sealed data. Your keys live in your local vault and never leave it in readable form.",
            },
            {
                q: "What is a locked message?",
                a: "A message sealed behind its own passphrase, separate from your account password. The recipient needs that word to open it, so even a shared device stays private.",
            },
        ],
    },
    {
        icon: "Flame",
        title: "Messages",
        articles: [
            {
                q: "How does burn-on-read work?",
                a: "Compose a burn message and it self-destructs the moment it is read. It is removed from both sides. there is no saved copy to recover.",
            },
            {
                q: "Can I edit or delete a message after sending?",
                a: "You control your own messages. Deletion removes them from the conversation; burn messages remove themselves automatically on read.",
            },
        ],
    },
    {
        icon: "HardDriveDownload",
        title: "Backup & data",
        articles: [
            {
                q: "How do backups work?",
                a: "A backup is your entire vault sealed into one encrypted file under your login password. You can export it any time and re-import it to restore or move devices.",
            },
            {
                q: "What is automatic backup?",
                a: "A premium option that silently keeps your vault backed up in the background. It is available on Chromium-based browsers, which grant the storage access it needs.",
            },
            {
                q: "Where is my data stored?",
                a: "Sealed in your browser's local storage. Your account registry is on the device; the encrypted blobs are too. The server only ever sees ciphertext in transit.",
            },
        ],
    },
];
