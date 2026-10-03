import assert from "node:assert/strict";
import { test } from "node:test";

import { transactionsForRule } from "@/lib/rule-matches";
import { summariseMatches } from "@/lib/rule-match-summary";
import {
  MATCH_PREVIEW_LIMIT,
  type RuleCandidate,
} from "@/lib/rule-match-types";

/**
 * Which transactions a rule affects.
 *
 * The one thing that must not break here is agreement with the engine: this calls
 * the same `matchesStoredRule` that routing uses, so a disagreement is impossible
 * by construction rather than by a test that has to be kept in sync.
 */

const tx = (over: Partial<RuleCandidate> = {}): RuleCandidate => ({
  id: 1,
  date: "2026-03-01",
  amount: -12.5,
  merchantName: "Blue Bottle Coffee",
  name: "BLUE BOTTLE #123",
  categoryOverride: null,
  plaidCategoryPrimary: "FOOD_AND_DRINK",
  plaidCategoryDetailed: "FOOD_AND_DRINK_COFFEE",
  budgetId: null,
  excluded: false,
  ...over,
});

const merchant = { matchType: "merchant" as const, matchValue: "blue bottle" };
const amount = { matchType: "amount" as const, matchValue: "12.5" };
const category = { matchType: "category" as const, matchValue: "FOOD_AND_DRINK" };

test("a merchant rule matches on merchant or description", () => {
  const byMerchant = transactionsForRule([tx()], merchant);
  assert.equal(byMerchant.total, 1);

  // The description alone is enough, because Plaid often has no merchant.
  const noMerchant = transactionsForRule(
    [tx({ merchantName: null, name: "SQ *BLUE BOTTLE 44" })],
    merchant,
  );
  assert.equal(noMerchant.total, 1);

  assert.equal(transactionsForRule([tx()], { ...merchant, matchValue: "kfc" }).total, 0);
});

test("an amount rule matches on magnitude, so either sign hits", () => {
  assert.equal(transactionsForRule([tx({ amount: 12.5 })], amount).total, 1);
  assert.equal(transactionsForRule([tx({ amount: -12.5 })], amount).total, 1);
  assert.equal(transactionsForRule([tx({ amount: 12.6 })], amount).total, 0);
});

test("a category rule respects an override over Plaid's suggestion", () => {
  // Plaid says food, the user says travel, and the user wins.
  const overridden = transactionsForRule(
    [tx({ categoryOverride: "TRAVEL" })],
    category,
  );
  assert.equal(overridden.total, 0, "the override is authoritative");

  const untouched = transactionsForRule([tx()], category);
  assert.equal(untouched.total, 1);
});

test("matches come back newest first, with a stable tiebreak", () => {
  const rows = [
    tx({ id: 1, date: "2026-01-05" }),
    tx({ id: 2, date: "2026-06-01" }),
    tx({ id: 3, date: "2026-03-01" }),
    // Same day as id 2: higher id first, so the order cannot change between loads.
    tx({ id: 4, date: "2026-06-01" }),
  ];
  const { matches } = transactionsForRule(rows, merchant);
  assert.deepEqual(matches.map((m) => m.id), [4, 2, 3, 1]);
});

test("the list is capped but the total is not", () => {
  const many = Array.from({ length: MATCH_PREVIEW_LIMIT + 17 }, (_, i) =>
    tx({ id: i + 1, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` }),
  );
  const result = transactionsForRule(many, merchant);

  assert.equal(result.matches.length, MATCH_PREVIEW_LIMIT, "the preview is capped");
  assert.equal(result.shown, MATCH_PREVIEW_LIMIT);
  assert.equal(result.total, MATCH_PREVIEW_LIMIT + 17, "but the count is honest");
});

test("the cap is the most recent rows, not the first ones found", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) =>
      tx({ id: i + 1, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` }),
    ),
    tx({ id: 999, date: "2026-12-25" }),
  ];
  const { matches } = transactionsForRule(rows, merchant);
  assert.equal(matches[0]!.id, 999, "the newest row is shown");
});

test("a transaction is marked as already in the rule's bucket or not", () => {
  const rows = [
    tx({ id: 1, budgetId: 7 }),
    tx({ id: 2, budgetId: 8 }),
    tx({ id: 3, budgetId: null }),
  ];
  const { matches } = transactionsForRule(rows, merchant, 7);
  const byId = new Map(matches.map((m) => [m.id, m.inTarget]));

  assert.equal(byId.get(1), true, "already routed there");
  assert.equal(byId.get(2), false, "would be moved");
  assert.equal(byId.get(3), false, "unassigned, so the rule would claim it");
});

test("a rule with no bucket step marks nothing as in-target", () => {
  // Loan steps have no bucket, so "already applied" is not a question about them.
  const { matches } = transactionsForRule([tx()], merchant, null);
  assert.equal(matches[0]!.inTarget, null);
});

test("excluded rows are listed, and labelled as such", () => {
  // A rule matching only ignored rows looks broken; this is the explanation.
  const result = transactionsForRule([tx({ excluded: true })], merchant);
  assert.equal(result.total, 1, "still counted");
  assert.equal(result.matches[0]!.excluded, true, "and flagged");
});

test("a missing description reads as one, not as a blank", () => {
  // Matched by amount, so it has nothing to describe itself with: Plaid can send a
  // row with neither a merchant nor a name, and a blank cell reads as a bug.
  const result = transactionsForRule(
    [tx({ merchantName: null, name: null, amount: 12.5 })],
    amount,
  );
  assert.equal(result.total, 1);
  assert.equal(result.matches[0]!.label, "(no description)");
});

test("the summary agrees with the count in every case", () => {
  const none = summariseMatches(transactionsForRule([], merchant));
  const one = summariseMatches(transactionsForRule([tx()], merchant));
  const many = summariseMatches(
    transactionsForRule([tx({ id: 1 }), tx({ id: 2 })], merchant),
  );

  assert.equal(none, "No matching transactions");
  assert.equal(one, "1 matching transaction");
  assert.equal(many, "2 matching transactions");
});

test("a rule that matches nothing says so, which is the common failure", () => {
  const result = transactionsForRule([tx()], { ...merchant, matchValue: "kfc" });
  assert.equal(result.total, 0);
  assert.equal(summariseMatches(result), "No matching transactions");
});