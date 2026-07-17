// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { Vault, StoredMessage } from './vault';
import { generateIdentity } from './crypto';

/**
 * Unread counting and the read marker (ROADMAP #3c).
 *
 * Exercised through a real Vault — real Argon2id key derivation, real secretbox
 * storage — because the count is computed over the decrypted transcript. Node
 * environment: libsodium wants Node's typed arrays (see crypto.test.ts), and the
 * vault only needs storage, which the mock below provides.
 */

function installStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
}

const SELF = 'self-user';
const OTHER = 'other-user';
const CHAN = 'chan-1';

function msg(id: string, senderId: string, createdAt: string): StoredMessage {
  return {
    id,
    channelId: CHAN,
    senderId,
    displayName: senderId,
    body: 'hi',
    createdAt,
    verified: true,
  };
}

async function freshVault() {
  const identity = await generateIdentity();
  const vault = await Vault.create(SELF, 'a-perfectly-fine-password', {
    identity,
    channels: {},
    contacts: {},
    profile: { displayName: 'me', updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  await vault.saveChannel({
    channelId: CHAN,
    code: 'ABCDEFGH',
    key: identity.vaultSalt, // any base64 stand-in; unread never opens envelopes
    hasKey: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
  });
  return vault;
}

describe('unread', () => {
  beforeEach(installStorage);

  it('counts peer messages newer than the read marker', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', OTHER, '2026-01-02T00:00:00.000Z'));
    await vault.appendMessage(msg('m2', OTHER, '2026-01-03T00:00:00.000Z'));
    expect(await vault.unreadCount(CHAN)).toBe(2);
  });

  it('never counts our own messages', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', SELF, '2026-01-02T00:00:00.000Z'));
    await vault.appendMessage(msg('m2', OTHER, '2026-01-03T00:00:00.000Z'));
    expect(await vault.unreadCount(CHAN)).toBe(1);
  });

  it('markChannelRead clears the count', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', OTHER, '2026-01-02T00:00:00.000Z'));
    await vault.markChannelRead(CHAN, '2026-01-02T00:00:01.000Z');
    expect(await vault.unreadCount(CHAN)).toBe(0);
  });

  it('a message after the marker is unread again', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', OTHER, '2026-01-02T00:00:00.000Z'));
    await vault.markChannelRead(CHAN, '2026-01-02T00:00:01.000Z');
    await vault.appendMessage(msg('m2', OTHER, '2026-01-03T00:00:00.000Z'));
    expect(await vault.unreadCount(CHAN)).toBe(1);
  });

  it('never moves the read marker backwards', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', OTHER, '2026-01-05T00:00:00.000Z'));
    await vault.markChannelRead(CHAN, '2026-01-06T00:00:00.000Z');
    // An older mark must not resurrect the unread.
    await vault.markChannelRead(CHAN, '2026-01-01T00:00:00.000Z');
    expect(await vault.unreadCount(CHAN)).toBe(0);
  });

  it('everything since joining counts before the channel is ever opened', async () => {
    const vault = await freshVault();
    await vault.appendMessage(msg('m1', OTHER, '2026-01-02T00:00:00.000Z'));
    await vault.appendMessage(msg('m2', OTHER, '2026-01-03T00:00:00.000Z'));
    // No markChannelRead has run: falls back to joinedAt.
    expect(await vault.unreadCount(CHAN)).toBe(2);
  });
});
