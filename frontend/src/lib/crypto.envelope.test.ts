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
  createEnvelope,
  openEnvelope,
  ENVELOPE_VERSION,
  MAX_REPLY_EXCERPT,
  Identity,
} from '@/lib/crypto';

async function twoIdentities(): Promise<[Identity, Identity]> {
  return [await generateIdentity(), await generateIdentity()];
}

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
    const { openWithKey, sealWithKey } = await import('@/lib/crypto');
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

  it('round-trips a v6 call signal and verifies it', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const call = {
      kind: 'offer' as const,
      callId: 'call-1',
      media: 'video' as const,
      sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
    };

    const sealed = await createEnvelope(
      { kind: 'call', body: '', displayName: '', sentAt: '', call },
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
    expect(envelope.kind).toBe('call');
    expect(envelope.call).toEqual(call);
  });

  it('does not verify a call signal whose SDP was swapped by the relay', async () => {
    // The relay holds the channel key in this scenario (worst case), so it can
    // re-encrypt -- but it cannot re-sign. A swapped SDP must fail verification,
    // or a man-in-the-middle could steer the media path.
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'call',
        body: '',
        displayName: '',
        sentAt: '',
        call: { kind: 'offer', callId: 'c', media: 'audio', sdp: 'good-sdp' },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    // Tamper: open, rewrite the SDP, re-seal under the same channel key.
    const { openWithKey, sealWithKey } = await import('@/lib/crypto');
    const opened = JSON.parse(await openWithKey(sealed, key));
    opened.call.sdp = 'attacker-sdp';
    const reSealed = await sealWithKey(JSON.stringify(opened), key);

    const { verified } = await openEnvelope(reSealed, key, {
      senderId,
      channelId,
      signPublicKey: id.signPublicKey,
    });
    expect(verified).toBe(false);
  });

  it('rejects a call signal with an unknown kind', async () => {
    const id = await generateIdentity();
    const key = await generateChannelKey();

    const sealed = await createEnvelope(
      {
        kind: 'call',
        body: '',
        displayName: '',
        sentAt: '',
        // Not one of the allowed control kinds.
        call: { kind: 'evil' as unknown as 'offer', callId: 'c' },
      },
      channelId,
      senderId,
      id.signPrivateKey,
      key
    );

    await expect(
      openEnvelope(sealed, key, { senderId, channelId, signPublicKey: id.signPublicKey })
    ).rejects.toThrow(/malformed call signal/);
  });
});
