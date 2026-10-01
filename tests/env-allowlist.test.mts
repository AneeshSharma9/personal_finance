import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PLAID_ENV = "sandbox";
process.env.ALLOWED_EMAILS = "me@example.com, second@example.com";
process.env.CRON_SECRET = "test-cron-secret";

const { isAllowedEmail } = await import("@/lib/env");

/**
 * The allowlist is the control that stops strangers from creating accounts and
 * eating the 10-Item Plaid Trial cap, so its matching rules matter.
 */

test("matches the allowlisted address exactly", () => {
  assert.equal(isAllowedEmail("me@example.com"), true);
  assert.equal(isAllowedEmail("second@example.com"), true);
});

test("ignores case and surrounding whitespace", () => {
  assert.equal(isAllowedEmail("ME@example.com"), true);
  assert.equal(isAllowedEmail("  me@EXAMPLE.com  "), true);
});

test("rejects anyone else", () => {
  assert.equal(isAllowedEmail("stranger@example.com"), false);
  assert.equal(isAllowedEmail("attacker@evil.com"), false);
});

test("does not treat the allowlist as a pattern", () => {
  // A substring or wildcard match here would let strangers in.
  assert.equal(isAllowedEmail("me@example.com.attacker.net"), false);
  assert.equal(isAllowedEmail("xme@example.com"), false);
  assert.equal(isAllowedEmail("me@example.com.evil.com"), false);
});

test("an empty ALLOWED_EMAILS denies everyone rather than allowing all", () => {
  const original = process.env.ALLOWED_EMAILS;
  process.env.ALLOWED_EMAILS = "";
  try {
    assert.equal(isAllowedEmail("me@example.com"), false);
    assert.equal(isAllowedEmail("anyone@anywhere.com"), false);
  } finally {
    process.env.ALLOWED_EMAILS = original;
  }
});

test("a missing ALLOWED_EMAILS denies everyone", () => {
  const original = process.env.ALLOWED_EMAILS;
  delete process.env.ALLOWED_EMAILS;
  try {
    assert.equal(isAllowedEmail("me@example.com"), false);
  } finally {
    process.env.ALLOWED_EMAILS = original;
  }
});