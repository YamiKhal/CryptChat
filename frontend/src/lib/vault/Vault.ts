import { Bytes, wipe, base64UrlToBytes, bytesToBase64Url, BinaryAsset } from '@/lib/binary';
import { applyReaction } from '@/lib/limits';
import {
  Identity,
  Sealed,
  sealWithKey,
  openWithKey,
  openWithPassword,
  deriveVaultKey,
} from '@/lib/crypto';
import { readJson, vaultKeyName, messagesKeyName, sessionKeyName } from '@/lib/vault/storage';
import { getAccount } from '@/lib/vault/accounts';
import {
  Contact,
  Preferences,
  Profile,
  StoredChannel,
  StoredMessage,
  VaultData,
  DEFAULT_PREFERENCES,
} from '@/lib/vault/types';

/**
 * An unlocked vault. The key lives here in memory for the lifetime of the
 * object and is never written to localStorage.
 */
export class Vault {
  private constructor(
    readonly userId: string,
    private key: Bytes,
    private data: VaultData
  ) {}

  static async create(userId: string, password: string, data: VaultData): Promise<Vault> {
    const key = await deriveVaultKey(password, data.identity.vaultSalt);
    const vault = new Vault(userId, key, data);
    await vault.flush();
    return vault;
  }

  static async unlock(userId: string, password: string): Promise<Vault> {
    const account = getAccount(userId);
    if (!account) throw new Error('no such account on this device');

    const sealed = readJson<Sealed | null>(localStorage, vaultKeyName(userId), null);
    if (!sealed) throw new Error('vault missing on this device');

    const key = await deriveVaultKey(password, account.vaultSalt);
    try {
      // A wrong password fails the Poly1305 tag here. There is no separate
      // password check to bypass and no verifier stored locally -- the
      // ciphertext is the check.
      const json = await openWithKey(sealed, key);
      return new Vault(userId, key, JSON.parse(json) as VaultData);
    } catch {
      wipe(key);
      throw new Error('wrong password');
    }
  }

  /**
   * Reopen without re-entering the password, using a tab-scoped key.
   *
   * Tradeoff, stated plainly: the vault key sits in sessionStorage, so script
   * running in this origin can read it, and it survives reload. It dies when
   * the tab closes, never touches disk via localStorage, and is per-account.
   * The alternative -- memory only -- re-prompts on every refresh. Use
   * `lock()` to drop it immediately.
   */
  static async resume(userId: string): Promise<Vault | null> {
    const stashed = sessionStorage.getItem(sessionKeyName(userId));
    if (!stashed) return null;

    const sealed = readJson<Sealed | null>(localStorage, vaultKeyName(userId), null);
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
    sessionStorage.setItem(sessionKeyName(this.userId), bytesToBase64Url(this.key));
  }

  lock(): void {
    sessionStorage.removeItem(sessionKeyName(this.userId));
    wipe(this.key);
  }

  private async flush(): Promise<void> {
    const sealed = await sealWithKey(JSON.stringify(this.data), this.key);
    localStorage.setItem(vaultKeyName(this.userId), JSON.stringify(sealed));
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

  async setProfile(profile: Omit<Profile, 'updatedAt'>): Promise<void> {
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
    return Object.values(this.data.channels).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
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
    localStorage.removeItem(messagesKeyName(this.userId, channelId));
    await this.flush();
  }

  /**
   * Mark a channel read up to `at` (default now). No-op if the channel is gone.
   *
   * Returns whether the marker actually advanced, so a caller can skip a
   * re-render / revision bump when nothing changed.
   */
  async markChannelRead(channelId: string, at: string = new Date().toISOString()): Promise<boolean> {
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
   * Own messages never count as unread — you wrote them. Pending (not-yet-sent)
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
  async pinContact(input: Omit<Contact, 'firstSeenAt'>): Promise<Contact> {
    const existing = this.data.contacts[input.userId];

    if (!existing) {
      const contact: Contact = { ...input, firstSeenAt: new Date().toISOString() };
      this.data.contacts[input.userId] = contact;
      await this.flush();
      return contact;
    }

    if (existing.signPublicKey !== input.signPublicKey) {
      this.data.contacts[input.userId] = { ...existing, keyChangedAt: new Date().toISOString() };
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

  async acceptKeyChange(userId: string, signPublicKey: string, publicKey: string): Promise<void> {
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

  async updateContactProfile(
    userId: string,
    profile: {
      displayName?: string;
      avatar?: BinaryAsset;
      bio?: string;
      background?: BinaryAsset;
    }
  ): Promise<void> {
    const existing = this.data.contacts[userId];
    if (!existing) return;
    this.data.contacts[userId] = { ...existing, ...profile };
    await this.flush();
  }

  /* messages -- kept per channel so a busy channel does not rewrite the vault */

  async loadMessages(channelId: string): Promise<StoredMessage[]> {
    const sealed = readJson<Sealed | null>(localStorage, messagesKeyName(this.userId, channelId), null);
    if (!sealed) return [];
    try {
      return JSON.parse(await openWithKey(sealed, this.key)) as StoredMessage[];
    } catch {
      return [];
    }
  }

  async saveMessages(channelId: string, messages: StoredMessage[]): Promise<void> {
    const sealed = await sealWithKey(JSON.stringify(messages), this.key);
    localStorage.setItem(messagesKeyName(this.userId, channelId), JSON.stringify(sealed));
  }

  async appendMessage(message: StoredMessage): Promise<StoredMessage[]> {
    const messages = await this.loadMessages(message.channelId);
    // The relay may replay on reconnect before an ack lands.
    if (messages.some((existing) => existing.id === message.id)) return messages;

    messages.push(message);
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await this.saveMessages(message.channelId, messages);
    return messages;
  }

  async replaceMessage(channelId: string, id: string, patch: Partial<StoredMessage>): Promise<void> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((message) => message.id === id);
    if (index === -1) return;
    messages[index] = { ...messages[index], ...patch };
    await this.saveMessages(channelId, messages);
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
  async applyReactionToMessage(
    channelId: string,
    targetId: string,
    emoji: string,
    senderId: string,
    removed: boolean
  ): Promise<StoredMessage[] | null> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((message) => message.id === targetId);
    if (index === -1) return null;

    messages[index] = {
      ...messages[index],
      reactions: applyReaction(messages[index].reactions, emoji, senderId, removed),
    };
    await this.saveMessages(channelId, messages);
    return messages;
  }

  /**
   * Apply an edit to a message, but only if `editorId` authored it.
   *
   * The author check is the whole security of the feature: the signature (checked
   * before this is called) proves who sent the edit, and this proves they are the
   * one allowed to. A mismatch is ignored, not applied -- one member cannot edit
   * another's words. Returns the updated transcript, or null when the target is
   * not here yet (caller may park it) or the author check failed.
   */
  async editMessage(
    channelId: string,
    targetId: string,
    editorId: string,
    body: string,
    editedAt: string = new Date().toISOString()
  ): Promise<StoredMessage[] | null> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((message) => message.id === targetId);
    if (index === -1) return null;
    // Author-only, and never edit a tombstone back to life.
    if (messages[index].senderId !== editorId || messages[index].deleted) return null;

    messages[index] = { ...messages[index], body, editedAt };
    await this.saveMessages(channelId, messages);
    return messages;
  }

  /**
   * Delete a message the caller authored, leaving a tombstone.
   *
   * Same author check as editMessage. Body, attachments, asset, preview, and
   * reply are dropped so no plaintext outlives the delete; the id and sender
   * stay so a reply that quoted it still resolves to "message deleted".
   */
  async deleteMessage(
    channelId: string,
    targetId: string,
    deleterId: string
  ): Promise<StoredMessage[] | null> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((message) => message.id === targetId);
    if (index === -1) return null;
    if (messages[index].senderId !== deleterId) return null;

    const { id, channelId: cid, senderId, displayName, createdAt } = messages[index];
    messages[index] = {
      id,
      channelId: cid,
      senderId,
      displayName,
      createdAt,
      body: '',
      verified: messages[index].verified,
      deleted: true,
    };
    await this.saveMessages(channelId, messages);
    return messages;
  }

  /**
   * Unlock a password-locked message with `code`, writing the plaintext in.
   *
   * Throws 'wrong code' when the code does not open the sealed body (secretbox
   * authentication fails). On success the plaintext is stored and `locked` is
   * cleared, so the message reads normally from then on -- the code is not kept.
   */
  async unlockMessage(channelId: string, id: string, code: string): Promise<StoredMessage[]> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((message) => message.id === id);
    if (index === -1 || !messages[index].locked) return messages;

    const body = await openWithPassword(messages[index].locked!, code);
    messages[index] = { ...messages[index], body, locked: undefined };
    await this.saveMessages(channelId, messages);
    return messages;
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
  async processBurns(channelId: string, now: number = Date.now()): Promise<{
    messages: StoredMessage[];
    changed: boolean;
  }> {
    const messages = await this.loadMessages(channelId);
    let changed = false;

    const survivors: StoredMessage[] = [];
    for (const m of messages) {
      if (!m.burnTtl) {
        survivors.push(m);
        continue;
      }
      // Not yet clocked: start the timer now (it is on screen).
      if (!m.firstViewedAt) {
        survivors.push({ ...m, firstViewedAt: new Date(now).toISOString() });
        changed = true;
        continue;
      }
      // Clocked: drop it once the ttl has elapsed since first view.
      const deadline = new Date(m.firstViewedAt).getTime() + m.burnTtl * 1000;
      if (now >= deadline) {
        changed = true; // omit from survivors -- it burns
      } else {
        survivors.push(m);
      }
    }

    if (changed) await this.saveMessages(channelId, survivors);
    return { messages: survivors, changed };
  }

  async clearMessages(channelId: string): Promise<void> {
    localStorage.removeItem(messagesKeyName(this.userId, channelId));
  }
}
