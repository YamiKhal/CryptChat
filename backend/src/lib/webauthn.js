import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * WebAuthn (ROADMAP #5), wrapped around the audited @simplewebauthn/server.
 *
 * Two decisions worth stating:
 *
 * 1. Challenges are held in a short-lived signed token, not a server table. The
 *    ceremony is stateless: we hand the client a JWT carrying the challenge, and
 *    it comes back with the response. No challenge row to store, race, or reap,
 *    and the token's own expiry bounds the ceremony. The JWT is signed with the
 *    same secret as sessions but under a distinct audience so it can never be
 *    replayed as a session token.
 *
 * 2. This is a SECOND factor, not a passkey login. residentKey is discouraged
 *    and the allow-list is explicit, because the password step already
 *    identified the user -- we only need proof of possession, not a discoverable
 *    credential.
 */

const RP = {
  rpName: config.webauthn.rpName,
  rpID: config.webauthn.rpId,
  origin: config.webauthn.origin,
};

const CHALLENGE_AUD = 'CryptChat-webauthn';
const CHALLENGE_TTL = '5m';

export function issueChallengeToken(challenge, { userId, purpose }) {
  return jwt.sign({ challenge, sub: userId, purpose }, config.jwtSecret, {
    expiresIn: CHALLENGE_TTL,
    issuer: 'CryptChat',
    audience: CHALLENGE_AUD,
    algorithm: 'HS256',
  });
}

/** Throws on expiry, wrong audience, or a purpose mismatch. */
export function readChallengeToken(token, expectedPurpose) {
  const claims = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: 'CryptChat',
    audience: CHALLENGE_AUD,
  });
  if (claims.purpose !== expectedPurpose) throw new Error('wrong challenge purpose');
  return claims;
}

/** Enrollment options. `existing` excludes already-registered authenticators. */
export function registrationOptions(userId, existing) {
  return generateRegistrationOptions({
    rpName: RP.rpName,
    rpID: RP.rpID,
    // We hold no username; the authenticator UI gets a neutral, non-identifying
    // label. userID is the account id as bytes.
    userID: Buffer.from(userId),
    userName: 'CryptChat account',
    userDisplayName: 'CryptChat account',
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'discouraged',
      userVerification: 'preferred',
    },
  });
}

export function verifyRegistration(response, expectedChallenge) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP.origin,
    expectedRPID: RP.rpID,
    requireUserVerification: false,
  });
}

/** Authentication options, restricted to this user's enrolled credentials. */
export function authenticationOptions(credentials) {
  return generateAuthenticationOptions({
    rpID: RP.rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    })),
    userVerification: 'preferred',
  });
}

export function verifyAuthentication(response, expectedChallenge, credential) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP.origin,
    expectedRPID: RP.rpID,
    credential: {
      id: credential.id,
      publicKey: credential.public_key,
      counter: Number(credential.counter),
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    },
    requireUserVerification: false,
  });
}
