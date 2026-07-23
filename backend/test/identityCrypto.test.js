import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
    encryptEmail,
    decryptEmail,
    emailIndex,
    usernameIndex,
    legacyUsernameHash,
    maskEmail,
    issueToken,
    hashToken,
    issueRedemptionCode,
    normalizeRedemptionCode,
    redemptionIndex,
    padTo,
} from "../src/lib/identityCrypto.js";

/**
 * The account layer's crypto.
 *
 * Every assertion here pins a property that would be invisible if it broke: an
 * address readable from a dump, an index that can be ground offline, a mask that
 * leaks what it is meant to hide.
 */

test("email round-trips through envelope encryption", () => {
    const enc = encryptEmail("Person@Example.COM");
    assert.equal(decryptEmail(enc), "person@example.com");
});

test("email is normalized before storage, so case cannot fork an account", () => {
    const a = encryptEmail("  Person@Example.com ");
    const b = encryptEmail("person@example.com");
    assert.equal(decryptEmail(a), decryptEmail(b));
    assert.equal(a.emailHash, b.emailHash);
});

test("stored ciphertext does not contain the address", () => {
    const enc = encryptEmail("secretuser@example.com");
    assert.ok(!enc.emailCt.includes("secretuser"));
    assert.ok(!JSON.stringify(enc).includes("secretuser@example.com"));
});

test("the same address encrypts differently each time", () => {
    // A deterministic ciphertext would let anyone with a dump group users by
    // address without decrypting anything.
    const a = encryptEmail("same@example.com");
    const b = encryptEmail("same@example.com");
    assert.notEqual(a.emailCt, b.emailCt);
    assert.notEqual(a.emailDek, b.emailDek);
});

test("the index is stable, so lookup still works despite random ciphertext", () => {
    const a = encryptEmail("same@example.com");
    const b = encryptEmail("same@example.com");
    assert.equal(a.emailHash, b.emailHash);
});

test("tampered ciphertext throws rather than decrypting to garbage", () => {
    const enc = encryptEmail("person@example.com");
    const tampered = { ...enc, emailCt: enc.emailCt.slice(0, -4) + "AAAA" };
    assert.throws(() => decryptEmail(tampered));
});

test("a tampered wrapped DEK throws", () => {
    const enc = encryptEmail("person@example.com");
    const tampered = { ...enc, emailDek: enc.emailDek.slice(0, -4) + "AAAA" };
    assert.throws(() => decryptEmail(tampered));
});

test("the email index is NOT a bare sha256", () => {
    // A bare hash of a low-entropy value is not protection: anyone with a dump
    // grinds their candidate list offline and confirms who has an account.
    const email = "person@example.com";
    const bare = crypto.createHash("sha256").update(email).digest("hex");
    assert.notEqual(emailIndex(email), bare);
});

test("the username index is NOT a bare sha256", () => {
    const username = "alice";
    assert.notEqual(usernameIndex(username), legacyUsernameHash(username));
});

test("email and username indexes use different peppers", () => {
    // Sharing one pepper would let an index leak in one domain be tested in the
    // other.
    assert.notEqual(emailIndex("x@y.com"), usernameIndex("x@y.com"));
});

test("legacy username hash is case- and whitespace-insensitive", () => {
    assert.equal(legacyUsernameHash(" Alice "), legacyUsernameHash("alice"));
});

test("username index is case- and whitespace-insensitive", () => {
    // Otherwise "Alice" and "alice" are two accounts and login is a coin flip.
    assert.equal(usernameIndex(" Alice "), usernameIndex("alice"));
});

test("mask hides the local part but keeps the domain", () => {
    assert.equal(maskEmail("aboemad1231@outlook.com"), "ab•••••••@outlook.com");
});

test("mask is fixed width, so it does not leak the address length", () => {
    const short = maskEmail("ab@x.com").split("@")[0];
    const long = maskEmail("a-very-long-address-here@x.com").split("@")[0];
    assert.equal(short.length, long.length);
});

test("mask does not contain the address", () => {
    const masked = maskEmail("secretuser@example.com");
    assert.ok(!masked.includes("secretuser"));
    assert.ok(!masked.includes("cretuser"));
});

test("mask handles a garbage address without throwing", () => {
    // Never reached in practice (validation runs first), but a mask that throws
    // takes down a settings page.
    assert.equal(maskEmail("not-an-email"), "•••••••");
    assert.equal(maskEmail("@x.com"), "•••••••");
});

test("token hash matches the issued token", () => {
    const { token, tokenHash } = issueToken();
    assert.equal(hashToken(token), tokenHash);
});

test("the raw token is never the stored value", () => {
    const { token, tokenHash } = issueToken();
    assert.notEqual(token, tokenHash);
});

test("tokens are unique", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(issueToken().token);
    assert.equal(seen.size, 200);
});

test("redemption code uses the Crockford alphabet", () => {
    // No I, L, O, U -- those are the characters people mistype off a receipt.
    for (let i = 0; i < 50; i++) {
        assert.match(issueRedemptionCode(), /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    }
});

test("redemption codes are unique", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(issueRedemptionCode());
    assert.equal(seen.size, 200);
});

test("redemption code normalizes the characters people get wrong", () => {
    assert.equal(normalizeRedemptionCode("OIL"), "011");
    assert.equal(normalizeRedemptionCode("o i l"), "011");
});

test("redemption lookup ignores case, dashes and spaces", () => {
    const code = issueRedemptionCode();
    assert.equal(redemptionIndex(code), redemptionIndex(code.toLowerCase()));
    assert.equal(redemptionIndex(code), redemptionIndex(code.replace(/-/g, "")));
    assert.equal(redemptionIndex(code), redemptionIndex(` ${code} `));
});

test("different redemption codes index differently", () => {
    assert.notEqual(redemptionIndex(issueRedemptionCode()), redemptionIndex(issueRedemptionCode()));
});

test("padTo enforces a wall-clock floor", async () => {
    // This is what stops /recovery/request from being a timing oracle for
    // "does this address have an account".
    const started = Date.now();
    await padTo(started, 200);
    assert.ok(Date.now() - started >= 195, "should have waited out the floor");
});

test("padTo returns immediately when the floor already passed", async () => {
    const started = Date.now() - 500;
    const t0 = Date.now();
    await padTo(started, 200);
    assert.ok(Date.now() - t0 < 50, "should not wait when already past the floor");
});
