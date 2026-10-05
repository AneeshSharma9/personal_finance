import assert from "node:assert/strict";
import { test } from "node:test";

import {
  externalHttpUrl,
  externalImageUrl,
  transactionDetailStatus,
} from "@/lib/transaction-details";

test("an ignored row stays ignored even while pending", () => {
  // Both flags can be true. Budgeting treats it as ignored, so the dialog must too.
  assert.equal(
    transactionDetailStatus({ pending: true, excluded: true }),
    "Ignored",
  );
});

test("posting status follows the row rather than the amount", () => {
  assert.equal(
    transactionDetailStatus({ pending: true, excluded: false }),
    "Pending",
  );
  assert.equal(
    transactionDetailStatus({ pending: false, excluded: false }),
    "Posted",
  );
});

test("a bare hostname becomes an HTTPS link", () => {
  assert.deepEqual(externalHttpUrl("venmo.com"), {
    href: "https://venmo.com/",
    host: "venmo.com",
  });
});

test("an explicit HTTP address is preserved", () => {
  const link = externalHttpUrl("http://example.com/receipt?id=1");
  assert.equal(link?.host, "example.com");
  assert.equal(link?.href, "http://example.com/receipt?id=1");
});

test("unsafe and malformed website values never become links", () => {
  for (const value of [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,hello",
    "ht!tp://[invalid",
    "https://",
  ]) {
    assert.equal(externalHttpUrl(value), null, JSON.stringify(value));
  }
});

test("HTTP logos are rejected because browsers block them on HTTPS pages", () => {
  assert.equal(externalImageUrl("http://example.com/logo.png"), null);
  assert.deepEqual(externalImageUrl("https://example.com/logo.png"), {
    href: "https://example.com/logo.png",
  });
});
