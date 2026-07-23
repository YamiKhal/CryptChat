import {
    Bytes,
    wipe,
    base64UrlToBytes,
    bytesToBase64Url,
    BinaryAsset,
} from "@/lib/binary";
import {
    Identity,
    sealWithKey,
    openWithKey,
    deriveVaultKey,
} from "@/lib/crypto";
import {
    getSealed,
    putSealed,
    delSealed,
    vaultKeyName,
    messagesKeyName,
    sessionKeyName,
} from "@/lib/vault/storage";
import { getAccount } from "@/lib/vault/accounts";
import { emitVaultChange } from "@/lib/vault/events";
import { MessageStore } from "@/lib/vault/messages";
import {
    Contact,
    Preferences,
    Profile,
    StoredChannel,
    StoredMessage,
    VaultData,
    DEFAULT_PREFERENCES,
} from "@/lib/vault/types";

/**
 * Whether two profile images are the same picture. The base64 body is the
 * identity: assets arrive freshly parsed out of an envelope, so the objects are
 * never the same reference even when the bytes have not moved.
 */
function sameAsset(a?: BinaryAsset, b?: BinaryAsset): boolean {
    if (!a || !b) return a === b;
    return a.mime === b.mime && a.data === b.data;
}

/**
 * An unlocked vault. The key lives here in memory for the lifetime of the
 * object and is never written to localStorage.
 */
export class Vault {
    /** Per-channel transcript storage. Shares the vault key; see MessageStore. */
    private readonly messages: MessageStore;

    private constructor(
        readonly userId: string,
        private key: Bytes,
        private data: VaultData,
    ) {
        this.messages = new MessageStore(userId, key);
    }

    static async create(
        userId: string,
        password: string,
        data: VaultData,
    ): Promise<Vault> {
        const key = await deriveVaultKey(password, data.identity.vaultSalt);
        const vault = new Vault(userId, key, data);
        await vault.flush();
        return vault;
    }

    static async unlock(userId: string, password: string): Promise<Vault> {
        const account = getAccount(userId);
        if (!account) throw new Error("no such account on this device");

        const sealed = await getSealed(vaultKeyName(userId));
        if (!sealed) throw new Error("vault missing on this device");

        const key = await deriveVaultKey(password, account.vaultSalt);
        try {
            // A wrong password fails the Poly1305 tag here. There is no separate
            // password check to bypass and no verifier stored locally -- the
            // ciphertext is the check.
            const json = await openWithKey(sealed, key);
            return new Vault(userId, key, JSON.parse(json) as VaultData);
        } catch {
            wipe(key);
            throw new Error("wrong password");
        }
    }

    /**
     * Reopen without re-entering the password, using a tab-scoped key.
     *
     * Tradeoff, stated plainly: the vault key sits in sessionStorage, so script
     * running in this origin can read it and it survives reload. It dies when
     * the tab closes, never touches disk via localStorage and is per-account.
     * The alternative -- memory only -- re-prompts on every refresh. Use
     * `lock()` to drop it immediately.
     */
    static async resume(userId: string): Promise<Vault | null> {
        const stashed = sessionStorage.getItem(sessionKeyName(userId));
        if (!stashed) return null;

        const sealed = await getSealed(vaultKeyName(userId));
        if (!sealed) return null;

        try {
            const key = base64UrlToBytes(stashed);
            const json = await openWithKey(sealed, key);
            return new Vault(userId, key, JSON.parse(json) as VaultData);
        } catch {
            sessionStorage.removeItem(sessionKeyName(userId));
            return null;
        }
    }

    async rememberForSession(): Promise<void> {
        sessionStorage.setItem(
            sessionKeyName(this.userId),
            bytesToBase64Url(this.key),
        );
    }

    lock(): void {
        sessionStorage.removeItem(sessionKeyName(this.userId));
        wipe(this.key);
    }

    private async flush(): Promise<void> {
        const sealed = await sealWithKey(JSON.stringify(this.data), this.key);
        await putSealed(vaultKeyName(this.userId), sealed);
        emitVaultChange(this.userId);
    }

    snapshot(): VaultData {
        return structuredClone(this.data);
    }

    get identity(): Identity {
        return this.data.identity;
    }

    get profile(): Profile {
        return this.data.profile;
    }

    async setProfile(profile: Omit<Profile, "updatedAt">): Promise<void> {
        this.data.profile = { ...profile, updatedAt: new Date().toISOString() };
        await this.flush();
    }

    /** Merged with defaults so a vault written before preferences existed still opens. */
    get preferences(): Preferences {
        return { ...DEFAULT_PREFERENCES, ...(this.data.preferences ?? {}) };
    }

    async setPreferences(patch: Partial<Preferences>): Promise<void> {
        this.data.preferences = { ...this.preferences, ...patch };
        await this.flush();
    }

    /* channels */

    listChannels(): StoredChannel[] {
        return Object.values(this.data.channels).sort((a, b) =>
            b.joinedAt.localeCompare(a.joinedAt),
        );
    }

    getChannel(channelId: string): StoredChannel | undefined {
        return this.data.channels[channelId];
    }

    async saveChannel(channel: StoredChannel): Promise<void> {
        this.data.channels[channel.channelId] = channel;
        await this.flush();
    }

    async removeChannel(channelId: string): Promise<void> {
        delete this.data.channels[channelId];
        await delSealed(messagesKeyName(this.userId, channelId));
        await this.flush();
    }

    /**
     * Mark a channel read up to `at` (default now). No-op if the channel is gone.
     *
     * Returns whether the marker actually advanced, so a caller can skip a
     * re-render / revision bump when nothing changed.
     */
    async markChannelRead(
        channelId: string,
        at: string = new Date().toISOString(),
    ): Promise<boolean> {
        const channel = this.data.channels[channelId];
        if (!channel) return false;
        // Never move the marker backwards: reopening an old channel must not
        // resurrect unread counts.
        if (channel.lastReadAt && channel.lastReadAt >= at) return false;
        channel.lastReadAt = at;
        await this.flush();
        return true;
    }

    /**
     * Count messages newer than the read marker, excluding our own.
     *
     * Own messages never count as unread. you wrote them. Pending (not-yet-sent)
     * copies are ours too, so they are covered by the same senderId check.
     */
    async unreadCount(channelId: string): Promise<number> {
        const channel = this.data.channels[channelId];
        if (!channel) return 0;
        const since = channel.lastReadAt ?? channel.joinedAt;
        const messages = await this.loadMessages(channelId);
        let count = 0;
        for (const m of messages) {
            if (m.senderId !== this.userId && m.createdAt > since) count++;
        }
        return count;
    }

    /* contacts -- trust on first use */

    getContact(userId: string): Contact | undefined {
        return this.data.contacts[userId];
    }

    /**
     * Pin a peer's keys the first time they are seen.
     *
     * On a later mismatch the pinned key is kept and the change is flagged
     * instead of silently accepted. Auto-accepting a new signing key would hand
     * a malicious relay a free impersonation: swap the key, forge the messages.
     * Resolving it is a deliberate user act (`acceptKeyChange`) after comparing
     * fingerprints out of band.
     */
    async pinContact(input: Omit<Contact, "firstSeenAt">): Promise<Contact> {
        const existing = this.data.contacts[input.userId];

        if (!existing) {
            const contact: Contact = {
                ...input,
                firstSeenAt: new Date().toISOString(),
            };
            this.data.contacts[input.userId] = contact;
            await this.flush();
            return contact;
        }

        if (existing.signPublicKey !== input.signPublicKey) {
            this.data.contacts[input.userId] = {
                ...existing,
                keyChangedAt: new Date().toISOString(),
            };
            await this.flush();
            return this.data.contacts[input.userId];
        }

        this.data.contacts[input.userId] = {
            ...existing,
            publicKey: input.publicKey,
            displayName: input.displayName ?? existing.displayName,
            avatar: input.avatar ?? existing.avatar,
        };
        await this.flush();
        return this.data.contacts[input.userId];
    }

    async acceptKeyChange(
        userId: string,
        signPublicKey: string,
        publicKey: string,
    ): Promise<void> {
        const existing = this.data.contacts[userId];
        if (!existing) return;
        this.data.contacts[userId] = {
            ...existing,
            signPublicKey,
            publicKey,
            keyChangedAt: undefined,
            firstSeenAt: new Date().toISOString(),
        };
        await this.flush();
    }

    /**
     * Pin a peer's latest profile. Returns whether anything actually changed.
     *
     * The return value is not a nicety. A peer re-announces their profile every
     * time they open a channel, and the announcement is usually byte-identical to
     * what we already hold. Writing it anyway flushed the vault, woke the backup
     * layer and bumped the relay revision on every member -- so one person
     * switching channels made everyone else reload. Callers use this to stay put
     * when there is no news.
     */
    async updateContactProfile(
        userId: string,
        profile: {
            displayName?: string;
            avatar?: BinaryAsset;
            bio?: string;
            background?: BinaryAsset;
        },
    ): Promise<boolean> {
        const existing = this.data.contacts[userId];
        if (!existing) return false;

        // Compare the merged record, not the incoming fields: a key the caller
        // omitted keeps its old value, while one passed as undefined clears it.
        // Diffing the inputs would call an omitted key a change and then write
        // nothing, reporting news that never happened.
        const merged = { ...existing, ...profile };
        if (
            merged.displayName === existing.displayName &&
            merged.bio === existing.bio &&
            sameAsset(merged.avatar, existing.avatar) &&
            sameAsset(merged.background, existing.background)
        )
            return false;

        this.data.contacts[userId] = merged;
        await this.flush();
        return true;
    }

    /* messages -- kept per channel so a busy channel does not rewrite the vault */

    /**
     * Transcript storage and ordering live in MessageStore; these delegate so the
     * call sites (and the tests) keep the vault as their single entry point.
     */

    loadMessages(channelId: string): Promise<StoredMessage[]> {
        return this.messages.load(channelId);
    }

    saveMessages(channelId: string, messages: StoredMessage[]): Promise<void> {
        return this.messages.save(channelId, messages);
    }

    appendMessage(message: StoredMessage): Promise<StoredMessage[]> {
        return this.messages.append(message);
    }

    replaceMessage(
        channelId: string,
        id: string,
        patch: Partial<StoredMessage>,
    ): Promise<void> {
        return this.messages.replace(channelId, id, patch);
    }

    /** Pin one of our own messages to the relay's timestamp once its ack lands. */
    confirmSentMessage(
        channelId: string,
        id: string,
        createdAt: string | undefined,
    ): Promise<boolean> {
        return this.messages.confirmSent(channelId, id, createdAt);
    }

    applyReactionToMessage(
        channelId: string,
        targetId: string,
        emoji: string,
        senderId: string,
        removed: boolean,
    ): Promise<StoredMessage[] | null> {
        return this.messages.applyReactionTo(
            channelId,
            targetId,
            emoji,
            senderId,
            removed,
        );
    }

    editMessage(
        channelId: string,
        targetId: string,
        editorId: string,
        body: string,
        editedAt?: string,
    ): Promise<StoredMessage[] | null> {
        return this.messages.edit(channelId, targetId, editorId, body, editedAt);
    }

    deleteMessage(
        channelId: string,
        targetId: string,
        deleterId: string,
    ): Promise<StoredMessage[] | null> {
        return this.messages.remove(channelId, targetId, deleterId);
    }

    unlockMessage(
        channelId: string,
        id: string,
        code: string,
    ): Promise<StoredMessage[]> {
        return this.messages.unlock(channelId, id, code);
    }

    processBurns(
        channelId: string,
        now?: number,
    ): Promise<{ messages: StoredMessage[]; changed: boolean }> {
        return this.messages.processBurns(channelId, now);
    }

    clearMessages(channelId: string): Promise<void> {
        return this.messages.clear(channelId);
    }
}
