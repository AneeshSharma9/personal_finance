import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesStoredRule, type StoredRule } from "@/lib/rules";

// ---------------------------------------------------------------------------
// Merchant matching
// ---------------------------------------------------------------------------

const merchantRule = (value: string): StoredRule => ({
  id: 1,
  matchType: "merchant",
  matchValue: value,
  budgetId: 10,
  loanId: null,
});

test("a merchant rule matches on a substring, not a prefix", () => {
  const rule = merchantRule("kfc");
  // This is the case the user hit: the rule is saved but nothing moves.
  assert.equal(
    matchesStoredRule({ merchantName: "KFC 1234", name: "KFC", amount: 12.5 }, rule),
    true,
  );
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "POS KFC DRIVE THRU", amount: 20 }, rule),
    true,
  );
});

test("merchant matching ignores case and surrounding whitespace in the rule", () => {
  assert.equal(
    matchesStoredRule({ merchantName: "Kfc", name: null, amount: 5 }, merchantRule("  KFC  ")),
    true,
  );
});

test("a merchant rule does not match unrelated merchants", () => {
  assert.equal(
    matchesStoredRule({ merchantName: "Safeway", name: "GROCERIES", amount: 40 }, merchantRule("kfc")),
    false,
  );
});

test("an empty merchant rule never matches everything", () => {
  // Guards the substring-of-empty-string case, which would otherwise swallow the
  // whole ledger.
  assert.equal(
    matchesStoredRule({ merchantName: "Anything", name: "At all", amount: 1 }, merchantRule("   ")),
    false,
  );
});

// ---------------------------------------------------------------------------
// Amount matching
// ---------------------------------------------------------------------------

const amountRule = (value: string): StoredRule => ({
  id: 2,
  matchType: "amount",
  matchValue: value,
  budgetId: 20,
  loanId: null,
});

test("an exact amount rule matches that figure", () => {
  assert.equal(
    matchesStoredRule({ merchantName: "Honda Financial", name: null, amount: 600 }, amountRule("600")),
    true,
  );
});

test("an amount rule treats 600 and 600.00 as the same figure", () => {
  // Stored as text, compared as a number, so these do not become two rules.
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "PAYMENT", amount: 600 }, amountRule("600.00")),
    true,
  );
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "PAYMENT", amount: 600.004 }, amountRule("600.00")),
    true,
  );
});

test("an amount rule matches the magnitude, so direction does not matter", () => {
  // Plaid is positive for money out; a bucket rule should not care which way.
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "REFUND", amount: -600 }, amountRule("600")),
    true,
  );
});

test("an amount rule does not match a different figure", () => {
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "PAYMENT", amount: 599.99 }, amountRule("600")),
    false,
  );
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "PAYMENT", amount: 1200 }, amountRule("600")),
    false,
  );
});

test("an unparseable amount rule matches nothing rather than everything", () => {
  assert.equal(
    matchesStoredRule({ merchantName: null, name: "PAYMENT", amount: 600 }, amountRule("abc")),
    false,
  );
});

// ---------------------------------------------------------------------------
// Category matching
// ---------------------------------------------------------------------------

const categoryRule = (value: string): StoredRule => ({
  id: 3,
  matchType: "category",
  matchValue: value,
  budgetId: 30,
  loanId: null,
});

test("a category rule matches Plaid's category and its detailed children", () => {
  const row = {
    merchantName: null,
    name: "COFFEE",
    amount: 4,
    categoryOverride: null,
    plaidCategoryPrimary: "FOOD_AND_DRINK",
    plaidCategoryDetailed: "FOOD_AND_DRINK_COFFEE",
  };
  assert.equal(matchesStoredRule(row, categoryRule("food_and_drink")), true);
});

test("category matching is boundary-aware, so it is not a plain substring", () => {
  const row = {
    merchantName: null,
    name: null,
    amount: 4,
    categoryOverride: null,
    plaidCategoryPrimary: "FASTFOOD_RESTAURANT",
    plaidCategoryDetailed: null,
  };
  // "FOOD" is a raw substring of "FASTFOOD_RESTAURANT" but does not end on an
  // underscore boundary, so it must not claim it.
  assert.equal(matchesStoredRule(row, categoryRule("FOOD")), false);
  // A genuine prefix child is still claimed.
  assert.equal(
    matchesStoredRule(row, categoryRule("FASTFOOD")),
    true,
  );
});

test("a user's category override is what a category rule sees", () => {
  const row = {
    merchantName: null,
    name: null,
    amount: 12,
    categoryOverride: "TRANSPORTATION",
    plaidCategoryPrimary: "FOOD_AND_DRINK",
    plaidCategoryDetailed: null,
  };
  assert.equal(matchesStoredRule(row, categoryRule("TRANSPORTATION")), true);
  assert.equal(matchesStoredRule(row, categoryRule("FOOD_AND_DRINK")), false);
});

// ---------------------------------------------------------------------------

test("a loan-targeted rule matches on the same terms as a bucket one", () => {
  const loanRule: StoredRule = {
    id: 4,
    matchType: "merchant",
    matchValue: "honda",
    budgetId: null,
    loanId: 7,
  };
  assert.equal(
    matchesStoredRule({ merchantName: "HONDA FINANCIAL", name: null, amount: 600 }, loanRule),
    true,
  );
});