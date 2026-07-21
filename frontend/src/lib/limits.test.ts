/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  countChars,
  overCharLimit,
  applyReaction,
  buildReplyRef,
  DEFAULT_LIMITS,
  Limits,
} from '@/lib/limits';
import { MAX_REPLY_EXCERPT } from '@/lib/crypto';
import type { StoredMessage } from '@/lib/vault';

const free: Limits = { ...DEFAULT_LIMITS, tier: 'free', maxChars: 1000 };
const premium: Limits = { ...DEFAULT_LIMITS, tier: 'premium', premium: true, maxChars: 4000 };

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    channelId: 'c1',
    senderId: 'u1',
    displayName: 'alice',
    body: 'hello',
    createdAt: new Date().toISOString(),
    verified: true,
    ...overrides,
  };
}

describe('countChars', () => {
  it('counts plain text', () => {
    expect(countChars('hello')).toBe(5);
  });

  it('counts an emoji as one character, not two', () => {
    // .length would say 2: an emoji is a surrogate pair in UTF-16. Charging
    // someone double for typing 👍 would be visibly wrong.
    expect(countChars('👍')).toBe(1);
  });

  it('counts a ZWJ family emoji as one character', () => {
    // .length says 11 for this one.
    expect(countChars('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('counts a skin-toned emoji as one character', () => {
    expect(countChars('👍🏽')).toBe(1);
  });

  it('counts combining accents as one character each', () => {
    expect(countChars('café')).toBe(4);
    // e + combining acute: two code points, one grapheme.
    expect(countChars('café')).toBe(4);
  });

  it('handles empty input', () => {
    expect(countChars('')).toBe(0);
  });
});

describe('overCharLimit', () => {
  it('permits a message at exactly the limit', () => {
    expect(overCharLimit('x'.repeat(1000), free)).toBe(false);
  });

  it('rejects one character past the limit', () => {
    expect(overCharLimit('x'.repeat(1001), free)).toBe(true);
  });

  it('gives premium the higher ceiling', () => {
    const text = 'x'.repeat(3000);
    expect(overCharLimit(text, free)).toBe(true);
    expect(overCharLimit(text, premium)).toBe(false);
  });

  it('rejects past the premium limit too', () => {
    expect(overCharLimit('x'.repeat(4001), premium)).toBe(true);
  });

  it('measures emoji by grapheme, so an emoji-heavy message is not double-charged', () => {
    // 600 emoji = 1200 UTF-16 code units, but only 600 characters.
    expect(overCharLimit('👍'.repeat(600), free)).toBe(false);
  });
});

describe('applyReaction', () => {
  it('adds a reaction', () => {
    expect(applyReaction(undefined, '👍', 'u1', false)).toEqual({ '👍': ['u1'] });
  });

  it('is idempotent -- one person cannot stack the same reaction', () => {
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '👍', 'u1', false);
    expect(r['👍']).toEqual(['u1']);
  });

  it('accumulates distinct senders', () => {
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '👍', 'u2', false);
    expect(r['👍']).toHaveLength(2);
  });

  it('removes only the sender who removed it', () => {
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '👍', 'u2', false);
    r = applyReaction(r, '👍', 'u1', true);
    expect(r['👍']).toEqual(['u2']);
  });

  it('drops the emoji entirely when the last sender removes it', () => {
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '👍', 'u1', true);
    // An empty pill would render as a ghost "0".
    expect(r['👍']).toBeUndefined();
    expect(Object.keys(r)).toHaveLength(0);
  });

  it('ignores a removal for someone who never reacted', () => {
    const r = applyReaction({ '👍': ['u1'] }, '👍', 'u2', true);
    expect(r['👍']).toEqual(['u1']);
  });

  it('keeps different emoji independent', () => {
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '❤️', 'u1', false);
    expect(Object.keys(r).sort()).toEqual(['❤️', '👍']);
  });

  it('does not mutate its input', () => {
    const original = { '👍': ['u1'] };
    applyReaction(original, '👍', 'u2', false);
    expect(original['👍']).toEqual(['u1']);
  });

  it('a replayed add after a remove does not resurrect a stale reaction', () => {
    // The relay can replay frames. `removed` is signed, so an old add cannot
    // undo a newer remove -- but the fold itself must also be sane.
    let r = applyReaction(undefined, '👍', 'u1', false);
    r = applyReaction(r, '👍', 'u1', true);
    r = applyReaction(r, '👍', 'u1', false);
    expect(r['👍']).toEqual(['u1']);
  });
});

describe('buildReplyRef', () => {
  it('snapshots the text', () => {
    const ref = buildReplyRef(message({ body: 'the original message' }));
    expect(ref.excerpt).toBe('the original message');
    expect(ref.kind).toBe('text');
    expect(ref.id).toBe('m1');
  });

  it('clips a long excerpt to the cap', () => {
    // Unbounded, this field is an arbitrary string pushed into every
    // recipient's vault.
    const ref = buildReplyRef(message({ body: 'x'.repeat(500) }));
    expect(ref.excerpt).toHaveLength(MAX_REPLY_EXCERPT);
  });

  it('marks a bare image reply as an image', () => {
    const ref = buildReplyRef(
      message({
        body: '',
        attachments: [{ mime: 'image/png', name: 'x.png' } as never],
      })
    );
    expect(ref.kind).toBe('image');
    expect(ref.excerpt).toBe('');
  });

  it('marks a bare file reply as a file', () => {
    const ref = buildReplyRef(
      message({
        body: '',
        attachments: [{ mime: 'application/zip', name: 'x.zip' } as never],
      })
    );
    expect(ref.kind).toBe('file');
  });

  it('prefers the text when a message has both text and an image', () => {
    const ref = buildReplyRef(
      message({ body: 'look at this', attachments: [{ mime: 'image/png' } as never] })
    );
    expect(ref.kind).toBe('text');
    expect(ref.excerpt).toBe('look at this');
  });

  it('clips an over-long display name', () => {
    const ref = buildReplyRef(message({ displayName: 'n'.repeat(200) }));
    expect(ref.displayName.length).toBeLessThanOrEqual(64);
  });
});

describe('DEFAULT_LIMITS', () => {
  it('assumes the restrictive answer before the server replies', () => {
    // Rendering an enabled upload button that then 403s is worse than briefly
    // disabling one.
    expect(DEFAULT_LIMITS.canUpload).toBe(false);
    expect(DEFAULT_LIMITS.premium).toBe(false);
    expect(DEFAULT_LIMITS.tier).toBe('free');
  });
});
