/**
 * @vitest-environment node
 *
 * Node, not jsdom: libsodium's instanceof checks reject jsdom's typed
 * arrays. The crypto layer touches no DOM. See src/test/setup.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  deriveVaultKey,
  generateSalt,
  keyFingerprint,
  safetyNumber,
  Identity,
} from '@/lib/crypto';

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
