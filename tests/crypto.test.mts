import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

// The modules under test read env at call time, so set it before importing.
const KEY = randomBytes(32).toString("base64");
process.env.TOKEN_ENCRYPTION_KEY = KEY;
process.env.PLAID_ENV = "sandbox";
process.env.ALLOWED_EMAILS = "me@example.com";

// tsx resolves the "@/" path alias from tsconfig.json, so this imports the
// same way the app does.
const { encryptToken, decryptToken, canDecryptToken } = await import(
  "@/lib/crypto"
);

test("encrypt/decrypt round-trips an access token", () => {
  const token = "access-sandbox-abc123def456";
  const encrypted = encryptToken(token);

  assert.notEqual(encrypted, token, "ciphertext must differ from plaintext");
  assert.ok(!encrypted.includes(token), "token must not appear in ciphertext");
  assert.equal(decryptToken(encrypted), token);
});

test("ciphertext is nondeterministic (fresh IV per call)", () => {
  const token = "access-sandbox-abc123def456";
  assert.notEqual(encryptToken(token), encryptToken(token));
});

test("unicode and long values survive a round trip", () => {
  for (const value of ["ünïcødé 🔐", "a".repeat(5000)]) {
    assert.equal(decryptToken(encryptToken(value)), value);
  }
});

test("an empty token is refused rather than encrypted", () => {
  // An empty value would produce a payload the same length as a truncated one,
  // which would make the length check ambiguous.
  assert.throws(() => encryptToken(""), /empty Plaid access token/);
});

test("tampered ciphertext fails authentication instead of returning garbage", () => {
  const encrypted = encryptToken("access-sandbox-abc123def456");
  const raw = Buffer.from(encrypted, "base64url");

  // Flip a bit in the ciphertext body (past the 12-byte IV and 16-byte tag).
  raw[raw.length - 1] ^= 0xff;

  assert.throws(
    () => decryptToken(raw.toString("base64url")),
    /Failed to decrypt|malformed/,
  );
});

test("a different key cannot decrypt", () => {
  const encrypted = encryptToken("access-sandbox-abc123def456");

  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.equal(canDecryptToken(encrypted), false);

  // Restore so later tests keep working.
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  assert.equal(canDecryptToken(encrypted), true);
});

test("truncated ciphertext is rejected as malformed", () => {
  const short = Buffer.from("tiny").toString("base64url");
  assert.throws(() => decryptToken(short), /malformed/);
  assert.equal(canDecryptToken(short), false);
});