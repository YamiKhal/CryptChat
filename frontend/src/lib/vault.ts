import { Bytes, wipe, base64UrlToBytes, bytesToBase64Url, BinaryAsset } from './binary';
import { applyReaction } from './limits';
import {
  Identity,
  Sealed,
  Attachment,
  LinkPreview,
  ReplyRef,
  sealWithKey,
  openWithKey,
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
}

/** A peer's keys, pinned on first sight (TOFU). */
export interface Contact {
  userId: string;
  publicKey: string;
  signPublicKey: string;
  displayName?: string;
  avatar?: BinaryAsset;
  firstSeenAt: string;
  /** Set when the pinned signing key stops matching what the server serves. */
  keyChangedAt?: string;
}

export interface Profile {
  displayName: string;
  avatar?: BinaryAsset;
  updatedAt: string;
}

export interface Preferences {
  /**
   * Build a link preview for every link, not just ones prefixed with "!".
   *
   * Off by default, and deliberately so: generating a preview tells the relay
   * which URL you are sending. Opting in is a choice the user makes knowingly.
   */
  alwaysPreviewLinks: boolean;
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
    profile: { displayName?: string; avatar?: BinaryAsset }
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

  async clearMessages(channelId: string): Promise<void> {
    localStorage.removeItem(messagesKeyName(this.userId, channelId));
  }
}
