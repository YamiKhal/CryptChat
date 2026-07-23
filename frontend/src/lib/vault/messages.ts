import { Bytes } from "@/lib/binary";
import { applyReaction } from "@/lib/limits";
import { sealWithKey, openWithKey, openWithPassword } from "@/lib/crypto";
import {
    getSealed,
    putSealed,
    delSealed,
    messagesKeyName,
} from "@/lib/vault/storage";
import { emitVaultChange } from "@/lib/vault/events";
import { withLock } from "@/lib/vault/mutex";
import { StoredMessage } from "@/lib/vault/types";

/**
 * Transcript order.
 *
 * `createdAt` is the relay's stamp, not the sender's: two devices' wall clocks
 * disagree by seconds, so ordering on the sender's own `sentAt` puts a reply
 * above the message it answers whenever the exchange is faster than the skew.
 * The signed `sentAt` is kept on the message for provenance but is never the
 * sort key.
 *
 * The id breaks ties. Two messages can share a stamp (the relay reads its clock
 * once per send, so a coarse clock can repeat), and without a tiebreak sort
 * stability decides the order -- which differs between the device that appended
 * them one at a time and one that loaded them together.
 */
export function compareMessages(a: StoredMessage, b: StoredMessage): number {
    return a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt);
}

/**
 * The per-channel transcript store: one sealed blob per channel, so a busy
 * channel does not rewrite the whole vault.
 *
 * Every mutation is load -> change -> save and each step yields, so they all run
 * under a per-channel lock. Without it our own send and an arriving message
 * interleave and the second write drops the first one's message.
 */
export class MessageStore {
    constructor(
        private readonly userId: string,
        private readonly key: Bytes,
    ) {}

    private storageKey(channelId: string): string {
        return messagesKeyName(this.userId, channelId);
    }

    /** Run `work` with exclusive access to a channel's transcript. */
    private mutate<T>(channelId: string, work: () => Promise<T>): Promise<T> {
        return withLock(this.storageKey(channelId), work);
    }

    async load(channelId: string): Promise<StoredMessage[]> {
        const sealed = await getSealed(this.storageKey(channelId));
        if (!sealed) return [];
        try {
            return JSON.parse(
                await openWithKey(sealed, this.key),
            ) as StoredMessage[];
        } catch {
            return [];
        }
    }

    async save(channelId: string, messages: StoredMessage[]): Promise<void> {
        const sealed = await sealWithKey(JSON.stringify(messages), this.key);
        await putSealed(this.storageKey(channelId), sealed);
        emitVaultChange(this.userId);
    }

    async clear(channelId: string): Promise<void> {
        await delSealed(this.storageKey(channelId));
    }

    async append(message: StoredMessage): Promise<StoredMessage[]> {
        return this.mutate(message.channelId, async () => {
            const messages = await this.load(message.channelId);
            // The relay may replay on reconnect before an ack lands.
            if (messages.some((existing) => existing.id === message.id))
                return messages;

            messages.push(message);
            messages.sort(compareMessages);
            await this.save(message.channelId, messages);
            return messages;
        });
    }

    async replace(
        channelId: string,
        id: string,
        patch: Partial<StoredMessage>,
    ): Promise<void> {
        await this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex((message) => message.id === id);
            if (index === -1) return;
            messages[index] = { ...messages[index], ...patch };
            await this.save(channelId, messages);
        });
    }

    /**
     * Adopt the relay's timestamp for a message we sent, once the ack lands.
     *
     * Until the ack, our own copy carries an estimate of the relay's clock so it
     * renders in roughly the right place; this pins it to the value every other
     * member is ordering on. Returns whether anything changed, so a caller can
     * skip a re-render.
     */
    async confirmSent(
        channelId: string,
        id: string,
        createdAt: string | undefined,
    ): Promise<boolean> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex((message) => message.id === id);
            if (index === -1) return false;

            const message = messages[index];
            // An older relay sends no stamp on the ack. The message is still no
            // longer pending -- it is only its position that stays an estimate.
            const at = createdAt ?? message.createdAt;
            if (!message.pending && message.createdAt === at) return false;

            messages[index] = { ...message, createdAt: at, pending: undefined };
            messages.sort(compareMessages);
            await this.save(channelId, messages);
            return true;
        });
    }

    /**
     * Fold a reaction into its target message.
     *
     * Returns the updated transcript, or null when the target is not here yet.
     *
     * Out-of-order delivery is normal, not exceptional: a reaction to a message
     * you have not received (queued while the sender was offline, or you joined
     * mid-conversation) arrives with nothing to attach to. The caller parks those
     * rather than dropping them, so the reaction appears when the message does.
     */
    async applyReactionTo(
        channelId: string,
        targetId: string,
        emoji: string,
        senderId: string,
        removed: boolean,
    ): Promise<StoredMessage[] | null> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex(
                (message) => message.id === targetId,
            );
            if (index === -1) return null;

            messages[index] = {
                ...messages[index],
                reactions: applyReaction(
                    messages[index].reactions,
                    emoji,
                    senderId,
                    removed,
                ),
            };
            await this.save(channelId, messages);
            return messages;
        });
    }

    /**
     * Apply an edit to a message, but only if `editorId` authored it.
     *
     * The author check is the whole security of the feature: the signature (checked
     * before this is called) proves who sent the edit and this proves they are the
     * one allowed to. A mismatch is ignored, not applied -- one member cannot edit
     * another's words. Returns the updated transcript, or null when the target is
     * not here yet (caller may park it) or the author check failed.
     */
    async edit(
        channelId: string,
        targetId: string,
        editorId: string,
        body: string,
        editedAt: string = new Date().toISOString(),
    ): Promise<StoredMessage[] | null> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex(
                (message) => message.id === targetId,
            );
            if (index === -1) return null;
            // Author-only and never edit a tombstone back to life.
            if (messages[index].senderId !== editorId || messages[index].deleted)
                return null;

            messages[index] = { ...messages[index], body, editedAt };
            await this.save(channelId, messages);
            return messages;
        });
    }

    /**
     * Delete a message the caller authored, leaving a tombstone.
     *
     * Same author check as edit. Body, attachments, asset, preview and reply are
     * dropped so no plaintext outlives the delete; the id and sender stay so a
     * reply that quoted it still resolves to "message deleted".
     */
    async remove(
        channelId: string,
        targetId: string,
        deleterId: string,
    ): Promise<StoredMessage[] | null> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex(
                (message) => message.id === targetId,
            );
            if (index === -1) return null;
            if (messages[index].senderId !== deleterId) return null;

            const {
                id,
                channelId: cid,
                senderId,
                displayName,
                createdAt,
                sentAt,
            } = messages[index];
            messages[index] = {
                id,
                channelId: cid,
                senderId,
                displayName,
                createdAt,
                sentAt,
                body: "",
                verified: messages[index].verified,
                deleted: true,
            };
            await this.save(channelId, messages);
            return messages;
        });
    }

    /**
     * Unlock a password-locked message with `code`, writing the plaintext in.
     *
     * Throws 'wrong code' when the code does not open the sealed body (secretbox
     * authentication fails). On success the plaintext is stored and `locked` is
     * cleared.
     */
    async unlock(
        channelId: string,
        id: string,
        code: string,
    ): Promise<StoredMessage[]> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            const index = messages.findIndex((message) => message.id === id);
            if (index === -1 || !messages[index].locked) return messages;

            const body = await openWithPassword(messages[index].locked!, code);
            messages[index] = {
                ...messages[index],
                body,
                locked: undefined,
            };
            await this.save(channelId, messages);
            return messages;
        });
    }

    /**
     * Burn-after-read bookkeeping for a channel, run on a tick while it is open.
     *
     * Two jobs in one pass so the vault is written at most once:
     *   1. Stamp `firstViewedAt` on any burn message that has been shown but not
     *      yet clocked -- this starts the countdown.
     *   2. Remove any burn message whose countdown has elapsed.
     *
     * Returns the surviving transcript and whether anything changed, so the caller
     * only re-renders when it must.
     */
    async processBurns(
        channelId: string,
        now: number = Date.now(),
    ): Promise<{ messages: StoredMessage[]; changed: boolean }> {
        return this.mutate(channelId, async () => {
            const messages = await this.load(channelId);
            let changed = false;

            const survivors: StoredMessage[] = [];
            for (const m of messages) {
                if (!m.burnTtl) {
                    survivors.push(m);
                    continue;
                }
                // Not yet clocked: start the timer now (it is on screen).
                if (!m.firstViewedAt) {
                    survivors.push({
                        ...m,
                        firstViewedAt: new Date(now).toISOString(),
                    });
                    changed = true;
                    continue;
                }
                // Clocked: drop it once the ttl has elapsed since first view.
                const deadline =
                    new Date(m.firstViewedAt).getTime() + m.burnTtl * 1000;
                if (now >= deadline) {
                    changed = true; // omit from survivors -- it burns
                } else {
                    survivors.push(m);
                }
            }

            if (changed) await this.save(channelId, survivors);
            return { messages: survivors, changed };
        });
    }
}
