/**
 * @vitest-environment node
 *
 * Not jsdom: under jsdom, TextEncoder returns typed arrays from Node's realm
 * while the Uint8Array global is jsdom's, so libsodium's `instanceof` check
 * rejects every input. The crypto layer touches no DOM, so node is both correct
 * and faster. See src/test/setup.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  generateChannelKey,
  createEnvelope,
  openEnvelope,
  wrapChannelKeyForRecipient,
  unwrapChannelKey,
  generateRecoveryCode,
  parseRecoveryCode,
  sealRecoveryBlob,
  openRecoveryBlob,
  exportKeyBundle,
  importKeyBundle,
  isSingleEmoji,
  deriveVaultKey,
  generateSalt,
  keyFingerprint,
  safetyNumber,
  sealWithPassword,
  openWithPassword,
  ENVELOPE_VERSION,
  MAX_REPLY_EXCERPT,
  Identity,
} from './crypto';

/**
 * The crypto layer's security properties, asserted.
 *
 * These are not "does it round-trip" tests. Each one pins a property that, if it
 * silently broke, would be invisible in the UI and catastrophic in the field:
 * forged attribution, a readable envelope, an unrecoverable vault.
 */

async function twoIdentities(): Promise<[Identity, Identity]> {
  return [await generateIdentity(), await generateIdentity()];
}

describe('identity', () => {
  it('never reuses one keypair for both agreement and signing', async () => {
    const id = await generateIdentity();
    // Sharing a keypair between crypto_box and crypto_sign is a known footgun.
    expect(id.publicKey).not.toBe(id.signPublicKey);
    expect(id.privateKey).not.toBe(id.signPrivateKey);
  });

  it('generates a distinct identity every time', async () => {
    const [a, b] = await twoIdentities();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.vaultSalt).not.toBe(b.vaultSalt);
  });

  it('produces a stable fingerprint for a given key', async () => {
    const id = await generateIdentity();
    expect(await keyFingerprint(id.signPublicKey)).toBe(await keyFingerprint(id.signPublicKey));
  });

  it('produces different fingerprints for different keys', async () => {
    const [a, b] = await twoIdentities();
    expect(await keyFingerprint(a.signPublicKey)).not.toBe(await keyFingerprint(b.signPublicKey));
  });
});

describe('safety number (E2E trust verification)', () => {
  it('is identical regardless of argument order -- both parties compute the same', async () => {
    const [a, b] = await twoIdentities();
    const fromA = await safetyNumber(a.signPublicKey, b.signPublicKey);
    const fromB = await safetyNumber(b.signPublicKey, a.signPublicKey);
    expect(fromA).toBe(fromB);
  });

  it('differs for a different pair -- a substituted key changes the number', async () => {
    const [a, b] = await twoIdentities();
    const c = await generateIdentity();
    const real = await safetyNumber(a.signPublicKey, b.signPublicKey);
    // A relay swapping b's key for one it controls (c) yields a different number,
    // which is exactly what the out-of-band comparison catches.
    const mitm = await safetyNumber(a.signPublicKey, c.signPublicKey);
    expect(real).not.toBe(mitm);
  });

  it('is decimal groups, readable over a phone', async () => {
    const [a, b] = await twoIdentities();
    expect(await safetyNumber(a.signPublicKey, b.signPublicKey)).toMatch(/^(\d{5} ){11}\d{5}$/);
  });

  it('is stable for the same pair', async () => {
    const [a, b] = await twoIdentities();
    expect(await safetyNumber(a.signPublicKey, b.signPublicKey)).toBe(
      await safetyNumber(a.signPublicKey, b.signPublicKey)
    );
  });
});

describe('vault key derivation', () => {
  it('derives the same key from the same password and salt', async () => {
    const salt = await generateSalt();
    const a = await deriveVaultKey('correct horse battery', salt);
    const b = await deriveVaultKey('correct horse battery', salt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('derives a different key for a different password', async () => {
    const salt = await generateSalt();
    const a = await deriveVaultKey('password one here', salt);
    const b = await deriveVaultKey('password two here', salt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('derives a different key for the same password under a different salt', async () => {
    // This is what stops one cracked password from unlocking every account.
    const password = 'same password twice';
    const a = await deriveVaultKey(password, await generateSalt());
    const b = await deriveVaultKey(password, await generateSalt());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a wrong-length salt rather than deriving something useless', async () => {
    // Valid base64url, but decodes to fewer bytes than crypto_pwhash requires.
    // A silent truncate-or-pad here would produce a key that "works" until it
    // meets a real implementation.
    await expect(deriveVaultKey('a password here', 'AAAA')).rejects.toThrow(/salt/i);
  });
});

describe('envelopes', () => {
  const channelId = '11111111-1111-1111-1111-111111111111';
  const senderId = '22222222-2222-2222-2222-222222222222';

  it('round-trips a message and verifies its signature', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'hello', displayName: 'alice', sentAt: new Date().toISOString() },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.body).toBe('hello');
    expect(envelope.v).toBe(ENVELOPE_VERSION);
  });

  it('does not decrypt with the wrong channel key', async () => {
    const id = await generateIdentity();
    const sealed = await createEnvelope(
      { kind: 'message', body: 'secret', displayName: 'a', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      await generateChannelKey()
    );

    await expect(
      openEnvelope(sealed, await generateChannelKey(), {
        senderId,
        channelId,
        signPublicKey: id.signPublicKey,
      })
    ).rejects.toThrow();
  });

  it('reports verified:false when signed by someone else', async () => {
    // The forgery that matters: a channel member (or a relay holding the key)
    // signing a message and attributing it to another member.
    const [alice, mallory] = await twoIdentities();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'alice would never say this', displayName: 'alice', sentAt: '' },
      channelId,
      senderId,
      mallory.signPrivateKey,
      key
    );

    const { verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: alice.signPublicKey,
    });

    expect(verified).toBe(false);
  });

  it('rejects an envelope replayed into another channel', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();
    const sealed = await createEnvelope(
      { kind: 'message', body: 'x', displayName: 'a', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, {
        senderId,
        channelId: '99999999-9999-9999-9999-999999999999',
        signPublicKey: id.signPublicKey,
      })
    ).rejects.toThrow(/channel mismatch/);
  });

  it('rejects an envelope reattributed to another sender', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();
    const sealed = await createEnvelope(
      { kind: 'message', body: 'x', displayName: 'a', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, {
        senderId: '99999999-9999-9999-9999-999999999999',
        channelId,
        signPublicKey: id.signPublicKey,
      })
    ).rejects.toThrow(/sender mismatch/);
  });

  it('signs the reply reference, so a relay cannot repoint a reply', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'message',
        body: 'agreed',
        displayName: 'alice',
        sentAt: '',
        replyTo: {
          id: 'msg-1',
          senderId: 'bob',
          displayName: 'bob',
          excerpt: 'the original',
          kind: 'text',
        },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.replyTo?.id).toBe('msg-1');
    expect(envelope.replyTo?.excerpt).toBe('the original');
  });

  it('signs the reaction target and toggle state', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'reaction',
        body: '',
        displayName: 'alice',
        sentAt: '',
        reaction: { targetId: 'msg-1', emoji: '👍', removed: false },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.kind).toBe('reaction');
    expect(envelope.reaction).toEqual({ targetId: 'msg-1', emoji: '👍', removed: false });
  });

  it('signs an edit target and its new body (v4)', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'edit',
        body: '',
        displayName: 'alice',
        sentAt: '',
        edit: { targetId: 'msg-1', body: 'the corrected text' },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.kind).toBe('edit');
    expect(envelope.edit).toEqual({ targetId: 'msg-1', body: 'the corrected text' });
  });

  it('a tampered edit body fails verification', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'edit',
        body: '',
        displayName: 'alice',
        sentAt: '',
        edit: { targetId: 'msg-1', body: 'honest' },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    // Open, rewrite the edited body, reseal under the channel key (which any
    // member holds) -- the signature must no longer verify.
    const { openWithKey, sealWithKey } = await import('./crypto');
    const opened = JSON.parse(await openWithKey(sealed, key));
    opened.edit.body = 'forged replacement';
    const reSealed = await sealWithKey(JSON.stringify(opened), key);

    const { verified } = await openEnvelope(reSealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(verified).toBe(false);
  });

  it('signs a delete tombstone target (v4)', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'delete',
        body: '',
        displayName: 'alice',
        sentAt: '',
        del: { targetId: 'msg-7' },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.kind).toBe('delete');
    expect(envelope.del).toEqual({ targetId: 'msg-7' });
  });

  it('rejects an edit body past the outer cap', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'edit',
        body: '',
        displayName: 'a',
        sentAt: '',
        edit: { targetId: 'msg-1', body: 'x'.repeat(9000) },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, { senderId, channelId, signPublicKey: id.signPublicKey })
    ).rejects.toThrow(/malformed edit/);
  });

  it('rejects a reply excerpt past the cap', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'message',
        body: 'x',
        displayName: 'a',
        sentAt: '',
        replyTo: {
          id: 'm',
          senderId: 's',
          displayName: 'd',
          excerpt: 'x'.repeat(MAX_REPLY_EXCERPT + 1),
          kind: 'text',
        },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, { senderId, channelId, signPublicKey: id.signPublicKey })
    ).rejects.toThrow(/malformed reply/);
  });

  it('rejects a reaction whose emoji is not a single emoji', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'reaction',
        body: '',
        displayName: 'a',
        sentAt: '',
        // A peer controls this and it is rendered verbatim.
        reaction: { targetId: 'm', emoji: 'not an emoji', removed: false },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, { senderId, channelId, signPublicKey: id.signPublicKey })
    ).rejects.toThrow(/malformed reaction/);
  });

  it('reports verified:false rather than throwing when no key is pinned', async () => {
    // TOFU: the first message from someone arrives before their key is pinned.
    // It must render, badged, not blow up the transcript.
    const id = await generateIdentity();
    const key = await generateChannelKey();
    const sealed = await createEnvelope(
      { kind: 'message', body: 'hi', displayName: 'new', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: null,
    });
    expect(verified).toBe(false);
  });
});

describe('channel key wrapping', () => {
  it('lets the intended recipient unwrap and nobody else', async () => {
    const [alice, bob] = await twoIdentities();
    const carol = await generateIdentity();
    const channelKey = await generateChannelKey();

    const wrapped = await wrapChannelKeyForRecipient(channelKey, bob.publicKey, alice.privateKey);

    expect(await unwrapChannelKey(wrapped, alice.publicKey, bob.privateKey)).toBe(channelKey);

    // Carol holds the ciphertext but not the key it was addressed to.
    await expect(unwrapChannelKey(wrapped, alice.publicKey, carol.privateKey)).rejects.toThrow();
  });

  it('is authenticated, so a key from an impostor is rejected', async () => {
    // crypto_box, not crypto_box_seal: the joiner must learn *who* offered the
    // key, or anyone could inject one during a join.
    const [alice, bob] = await twoIdentities();
    const mallory = await generateIdentity();
    const channelKey = await generateChannelKey();

    const wrapped = await wrapChannelKeyForRecipient(channelKey, bob.publicKey, mallory.privateKey);

    // Bob expects it from Alice; it was really from Mallory.
    await expect(unwrapChannelKey(wrapped, alice.publicKey, bob.privateKey)).rejects.toThrow();
  });
});

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

describe('isSingleEmoji', () => {
  it('accepts ordinary emoji', () => {
    for (const e of ['👍', '❤️', '😂', '🔥', '🎉']) {
      expect(isSingleEmoji(e), e).toBe(true);
    }
  });

  it('accepts ZWJ sequences and skin tones as one emoji', () => {
    // These are several code points. Counting .length or code points would
    // reject perfectly ordinary emoji.
    for (const e of ['👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈']) {
      expect(isSingleEmoji(e), e).toBe(true);
    }
  });

  it('rejects text', () => {
    for (const v of ['hello', 'a', '123', '']) {
      expect(isSingleEmoji(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('rejects several emoji at once', () => {
    expect(isSingleEmoji('👍👍')).toBe(false);
    expect(isSingleEmoji('👍 ❤️')).toBe(false);
  });

  it('rejects emoji smuggling text alongside', () => {
    expect(isSingleEmoji('👍 you are hacked')).toBe(false);
  });

  it('rejects control characters and bidi overrides', () => {
    // U+202E would reorder the text rendered around the reaction.
    expect(isSingleEmoji('‮👍')).toBe(false);
    expect(isSingleEmoji(' 👍')).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(isSingleEmoji(v)).toBe(false);
    }
  });

  it('rejects an absurdly long string outright', () => {
    expect(isSingleEmoji('👍'.repeat(100))).toBe(false);
  });
});

describe('password-locked body', () => {
  const channelId = '11111111-1111-1111-1111-111111111111';
  const senderId = '22222222-2222-2222-2222-222222222222';

  it('round-trips a body sealed under a code', async () => {
    const locked = await sealWithPassword('the secret text', 'hunter2');
    expect(await openWithPassword(locked, 'hunter2')).toBe('the secret text');
  });

  it('a wrong code fails authentication rather than returning garbage', async () => {
    const locked = await sealWithPassword('the secret text', 'hunter2');
    await expect(openWithPassword(locked, 'wrong')).rejects.toThrow(/wrong code/);
  });

  it('carries an optional hint without exposing the body', async () => {
    const locked = await sealWithPassword('answer: 42', 'code', 'the meaning of life');
    expect(locked.hint).toBe('the meaning of life');
    // The ciphertext must not contain the plaintext.
    expect(locked.ct).not.toContain('42');
  });

  it('a locked envelope signs and hides its body', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();
    const locked = await sealWithPassword('classified', 'sesame');

    const sealed = await createEnvelope(
      { kind: 'message', body: '', displayName: 'alice', sentAt: '', locked },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.body).toBe(''); // no plaintext in the envelope
    expect(envelope.locked).toBeTruthy();
    expect(await openWithPassword(envelope.locked!, 'sesame')).toBe('classified');
  });

  it('a tampered locked ciphertext fails the envelope signature', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();
    const locked = await sealWithPassword('classified', 'sesame');

    const sealed = await createEnvelope(
      { kind: 'message', body: '', displayName: 'alice', sentAt: '', locked },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { openWithKey, sealWithKey } = await import('./crypto');
    const opened = JSON.parse(await openWithKey(sealed, key));
    // Swap the sealed body for a different one -- the signature covers it.
    const other = await sealWithPassword('substituted', 'sesame');
    opened.locked = other;
    const reSealed = await sealWithKey(JSON.stringify(opened), key);

    const { verified } = await openEnvelope(reSealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(verified).toBe(false);
  });
});

describe('burn-after-read', () => {
  const channelId = '11111111-1111-1111-1111-111111111111';
  const senderId = '22222222-2222-2222-2222-222222222222';

  it('signs and carries a burn timer', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'gone soon', displayName: 'a', sentAt: '', burn: { ttl: 30 } },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.burn).toEqual({ ttl: 30 });
  });

  it('a relay cannot strip the burn timer without breaking the signature', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'gone soon', displayName: 'a', sentAt: '', burn: { ttl: 30 } },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { openWithKey, sealWithKey } = await import('./crypto');
    const opened = JSON.parse(await openWithKey(sealed, key));
    delete opened.burn; // try to keep a message that was meant to vanish
    const reSealed = await sealWithKey(JSON.stringify(opened), key);

    const { verified } = await openEnvelope(reSealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(verified).toBe(false);
  });

  it('rejects an out-of-range ttl', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'x', displayName: 'a', sentAt: '', burn: { ttl: 999999999 } },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, { senderId, channelId, signPublicKey: id.signPublicKey })
    ).rejects.toThrow(/malformed burn/);
  });
});

describe('opt-in supporter badge (v5)', () => {
  const channelId = '11111111-1111-1111-1111-111111111111';
  const senderId = '22222222-2222-2222-2222-222222222222';

  it('carries and signs the flag when set', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'hi', displayName: 'a', sentAt: '', supporter: true },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope, verified } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });

    expect(verified).toBe(true);
    expect(envelope.v).toBe(5);
    expect(envelope.supporter).toBe(true);
  });

  it('is absent by default', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'hi', displayName: 'a', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { envelope } = await openEnvelope(sealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(envelope.supporter).toBeFalsy();
  });

  it('cannot be forged onto a message that was not signed with it', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      { kind: 'message', body: 'hi', displayName: 'a', sentAt: '' },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    const { openWithKey, sealWithKey } = await import('./crypto');
    const opened = JSON.parse(await openWithKey(sealed, key));
    opened.supporter = true; // relay/member tries to add a crown
    const reSealed = await sealWithKey(JSON.stringify(opened), key);

    const { verified } = await openEnvelope(reSealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(verified).toBe(false);
  });
});
