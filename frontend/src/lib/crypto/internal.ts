// The "sumo" build, not the standard one. crypto_pwhash (Argon2id) -- which
// the whole at-rest vault depends on -- is omitted from the standard build,
// though @types declares it either way. Importing 'libsodium-wrappers' here
// compiles cleanly and then throws at runtime on first registration.
import sodium from 'libsodium-wrappers-sumo';
import { Bytes } from '@/lib/binary';

/**
 * Shared sodium primitives for the crypto layer: readiness gating and the
 * base64url helpers every module encodes with. Kept in one place so a single
 * `sodium.ready` promise and one base64 variant are used everywhere.
 */

let readyPromise: Promise<void> | null = null;

export async function ensureReady(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready;
  await readyPromise;
}

const B64 = sodium.base64_variants?.URLSAFE_NO_PADDING ?? 5;

export function toB64(bytes: Bytes): string {
  return sodium.to_base64(bytes, B64);
}

export function fromB64(value: string): Bytes {
  return sodium.from_base64(value, B64);
}

/**
 * The envelope format version. Bumped once per additive field block (see the
 * `env.v >= N` ladder in canonicalBytes); new envelopes are always written at
 * the current value.
 */
export const ENVELOPE_VERSION = 8;
export const SUPPORTED_VERSIONS = new Set([2, 3, 4, 5, 6, 7, 8]);
