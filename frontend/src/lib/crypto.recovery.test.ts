/**
 * @vitest-environment node
 *
 * Node, not jsdom: libsodium's instanceof checks reject jsdom's typed
 * arrays. The crypto layer touches no DOM. See src/test/setup.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  generateChannelKey,
  generateRecoveryCode,
  parseRecoveryCode,
  sealRecoveryBlob,
  openRecoveryBlob,
  exportKeyBundle,
  importKeyBundle,
} from '@/lib/crypto';

describe('recovery code', () => {
  it('produces 24 words and 256 bits', async () => {
    const { phrase, entropy } = await generateRecoveryCode();
    expect(phrase.split(' ')).toHaveLength(24);
    expect(entropy.length).toBe(32);
  });

  it('is different every time', async () => {
    const a = await generateRecoveryCode();
    const b = await generateRecoveryCode();
    expect(a.phrase).not.toBe(b.phrase);
  });

  it('round-trips a phrase back to the same entropy', async () => {
    const { phrase, entropy } = await generateRecoveryCode();
    const parsed = await parseRecoveryCode(phrase);
    expect(Buffer.from(parsed).equals(Buffer.from(entropy))).toBe(true);
  });

  it('tolerates messy transcription', async () => {
    // People retype these off paper, in whatever case, with stray whitespace.
    const { phrase, entropy } = await generateRecoveryCode();
    const messy = `  ${phrase.toUpperCase().split(' ').join('   ')}  `;
    const parsed = await parseRecoveryCode(messy);
    expect(Buffer.from(parsed).equals(Buffer.from(entropy))).toBe(true);
  });

  it('catches a single mistyped word via the checksum', async () => {
    const { phrase } = await generateRecoveryCode();
    const words = phrase.split(' ');
    words[5] = words[5] === 'zoo' ? 'zone' : 'zoo';
    await expect(parseRecoveryCode(words.join(' '))).rejects.toThrow(/not valid|mistyped/i);
  });

  it('rejects a phrase of the wrong length with a useful message', async () => {
    await expect(parseRecoveryCode('one two three')).rejects.toThrow(/24 words/);
  });

  it('rejects a word outside the wordlist', async () => {
    const { phrase } = await generateRecoveryCode();
    const words = phrase.split(' ');
    words[0] = 'notarealbip39word';
    await expect(parseRecoveryCode(words.join(' '))).rejects.toThrow();
  });
});

describe('recovery blob', () => {
  it('round-trips identity and channel keys', async () => {
    const identity = await generateIdentity();
    const { entropy } = await generateRecoveryCode();
    const channels = [{ channelId: 'c1', code: 'CODE', key: await generateChannelKey() }];

    const blob = await sealRecoveryBlob({ userId: 'u1', identity, channels }, entropy);
    const opened = await openRecoveryBlob(blob, entropy);

    expect(opened.identity.privateKey).toBe(identity.privateKey);
    expect(opened.channels[0].key).toBe(channels[0].key);
  });

  it('is opaque to anyone without the code', async () => {
    // The server holds this. If it can be read without the code, the whole
    // design of storing it server-side is void.
    const identity = await generateIdentity();
    const { entropy } = await generateRecoveryCode();
    const blob = await sealRecoveryBlob({ userId: 'u1', identity, channels: [] }, entropy);

    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain(identity.privateKey);
    expect(serialized).not.toContain(identity.signPrivateKey);
  });

  it('does not open with a different recovery code', async () => {
    const identity = await generateIdentity();
    const { entropy } = await generateRecoveryCode();
    const other = await generateRecoveryCode();

    const blob = await sealRecoveryBlob({ userId: 'u1', identity, channels: [] }, entropy);
    await expect(openRecoveryBlob(blob, other.entropy)).rejects.toThrow(/wrong recovery code/);
  });

  it('uses a fresh salt each time, so two blobs never match', async () => {
    const identity = await generateIdentity();
    const { entropy } = await generateRecoveryCode();

    const a = await sealRecoveryBlob({ userId: 'u1', identity, channels: [] }, entropy);
    const b = await sealRecoveryBlob({ userId: 'u1', identity, channels: [] }, entropy);

    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe('key file export', () => {
  it('round-trips under its passphrase', async () => {
    const identity = await generateIdentity();
    const bundle = await exportKeyBundle({ userId: 'u1', identity, channels: [] }, 'a long passphrase');
    const opened = await importKeyBundle(bundle, 'a long passphrase');
    expect(opened.identity.privateKey).toBe(identity.privateKey);
  });

  it('fails closed on the wrong passphrase', async () => {
    const identity = await generateIdentity();
    const bundle = await exportKeyBundle({ userId: 'u1', identity, channels: [] }, 'a long passphrase');
    await expect(importKeyBundle(bundle, 'the wrong passphrase')).rejects.toThrow(/wrong passphrase/);
  });

  it('refuses a short export passphrase', async () => {
    // The file leaves the device; a weak passphrase on it is a full compromise.
    const identity = await generateIdentity();
    await expect(
      exportKeyBundle({ userId: 'u1', identity, channels: [] }, 'short')
    ).rejects.toThrow(/at least 12/);
  });

  it('refuses a file that is not ours', async () => {
    await expect(
      importKeyBundle({ format: 'something-else' } as never, 'a long passphrase')
    ).rejects.toThrow(/not a CryptChat key file/);
  });
});
