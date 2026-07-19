import { describe, it, expect } from 'vitest';
import { incognitoHue, incognitoLabel } from './incognito';

/**
 * Incognito identity (ROADMAP #7).
 *
 * The property that matters for the feature's promise: a member's colour and tag
 * are STABLE within a channel (so people can tell each other apart) but change
 * across channels (so nobody can use the colour to link you). Exact values are
 * not asserted -- only these behaviours -- so the hash can change without
 * churning the tests.
 */

const CHAN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SENDER = '11111111-1111-1111-1111-111111111111';

describe('incognitoHue', () => {
  it('is stable for the same channel and sender', () => {
    expect(incognitoHue(CHAN_A, SENDER)).toBe(incognitoHue(CHAN_A, SENDER));
  });

  it('is a hue in [0, 360)', () => {
    for (let i = 0; i < 50; i++) {
      const h = incognitoHue(CHAN_A, `sender-${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('spreads members across many hues, not all the same', () => {
    const hues = new Set(Array.from({ length: 50 }, (_, i) => incognitoHue(CHAN_A, `sender-${i}`)));
    expect(hues.size).toBeGreaterThan(5);
  });

  it('gives the same sender different colours across channels', () => {
    // A single pair could collide by chance; across many channels it must not
    // be the same colour every time -- that would mean the channel is ignored.
    const hues = new Set(
      Array.from({ length: 30 }, (_, i) => incognitoHue(`channel-${i}`, SENDER))
    );
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe('incognitoLabel', () => {
  it('is stable for the same channel and sender', () => {
    expect(incognitoLabel(CHAN_A, SENDER)).toBe(incognitoLabel(CHAN_A, SENDER));
  });

  it('matches the guest·XXX shape', () => {
    expect(incognitoLabel(CHAN_A, SENDER)).toMatch(/^guest·[0-9A-Z]{3}$/);
  });

  it('differs across channels for the same sender (usually)', () => {
    const labels = new Set(
      Array.from({ length: 30 }, (_, i) => incognitoLabel(`channel-${i}`, SENDER))
    );
    expect(labels.size).toBeGreaterThan(1);
  });

  it('distinguishes different senders in one channel', () => {
    const labels = new Set(
      Array.from({ length: 50 }, (_, i) => incognitoLabel(CHAN_A, `sender-${i}`))
    );
    expect(labels.size).toBeGreaterThan(10);
  });
});
