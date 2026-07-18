import { Bytes, wipe, base64UrlToBytes, bytesToBase64Url, BinaryAsset } from './binary';
import { applyReaction } from './limits';
import {
  Identity,
  Sealed,
  Attachment,
  LinkPreview,
  ReplyRef,
  LockedPayload,
  sealWithKey,
  openWithKey,
  openWithPassword,
  deriveVaultKey,
} from './crypto';

/**
 * Encrypted, per-account local storage.
 *
 * Every account in this browser gets its own namespace *and* its own vault key
 * derived from its own password. Two usernames sharing a browser profile can
 * neither see nor decrypt each other's channels, messages, or private keys --
 * previously all state lived under three global `darkchat:*` keys, so the
 * second login simply overwrote the first.
 *
 * At rest, only the account descriptor is plaintext (it has to be: the client
 * needs the salt before it can derive the key that opens anything else).
 * Private keys, channel keys, messages, profiles, and contacts are all inside
 * a secretbox.
 */

const NS = 'darkchat';
const ACCOUNT_INDEX = `${NS}:accounts`;
const accountKey = (userId: string) => `${NS}:acct:${userId}`;
const vaultKeyName = (userId: string) => `${NS}:vault:${userId}`;
const messagesKeyName = (userId: string, channelId: string) => `${NS}:msgs:${userId}:${channelId}`;
const sessionKeyName = (userId: string) => `${NS}:sk:${userId}`;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

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
  type?: 'dm';
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
}

export interface Preferences {
  /**
   * Build a link preview for every link, not just ones prefixed with "!".
   *
   * Off by default, and deliberately so: generating a preview tells the relay
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
}

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

function readJson<T>(store: Storage, key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function listAccounts(): AccountDescriptor[] {
  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  return ids
    .map((id) => readJson<AccountDescriptor | null>(localStorage, accountKey(id), null))
    .filter((a): a is AccountDescriptor => a !== null)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export function getAccount(userId: string): AccountDescriptor | null {
  return readJson<AccountDescriptor | null>(localStorage, accountKey(userId), null);
}

/**
 * Whether this device holds an encrypted vault for the account.
 *
 * False after a correct login on a new device: credentials are valid, but the
 * private keys were never on the server to send back. That state needs an
 * import prompt, not a password prompt -- no password can unlock a vault that
 * does not exist here.
 */
export function hasVault(userId: string): boolean {
  return localStorage.getItem(vaultKeyName(userId)) !== null;
}

export function saveAccount(account: AccountDescriptor): void {
  localStorage.setItem(accountKey(account.userId), JSON.stringify(account));
  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  if (!ids.includes(account.userId)) {
    localStorage.setItem(ACCOUNT_INDEX, JSON.stringify([...ids, account.userId]));
  }
}

export function touchAccount(userId: string): void {
  const account = getAccount(userId);
  if (account) saveAccount({ ...account, lastUsedAt: new Date().toISOString() });
}

/** Removes the account, its vault, and every message namespace it owns. */
export function forgetAccount(userId: string): void {
  localStorage.removeItem(accountKey(userId));
  localStorage.removeItem(vaultKeyName(userId));
  sessionStorage.removeItem(sessionKeyName(userId));

  const prefix = `${NS}:msgs:${userId}:`;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key);
  }

  const ids = readJson<string[]>(localStorage, ACCOUNT_INDEX, []);
  localStorage.setItem(ACCOUNT_INDEX, JSON.stringify(ids.filter((id) => id !== userId)));
}

/* ------------------------------------------------------------------ */
/* the vault                                                           */
/* ------------------------------------------------------------------ */

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

  /** Mark a channel read up to `at` (default now). No-op if the channel is gone. */
  async markChannelRead(channelId: string, at: string = new Date().toISOString()): Promise<void> {
    const channel = this.data.channels[channelId];
    if (!channel) return;
    // Never move the marker backwards: reopening an old channel must not
    // resurrect unread counts.
    if (channel.lastReadAt && channel.lastReadAt >= at) return;
    channel.lastReadAt = at;
    await this.flush();
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
    if (messages.some((m) => m.id === message.id)) return messages;

    messages.push(message);
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await this.saveMessages(message.channelId, messages);
    return messages;
  }

  async replaceMessage(channelId: string, id: string, patch: Partial<StoredMessage>): Promise<void> {
    const messages = await this.loadMessages(channelId);
    const index = messages.findIndex((m) => m.id === id);
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
    const index = messages.findIndex((m) => m.id === targetId);
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
    const index = messages.findIndex((m) => m.id === targetId);
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
    const index = messages.findIndex((m) => m.id === targetId);
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
    const index = messages.findIndex((m) => m.id === id);
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
