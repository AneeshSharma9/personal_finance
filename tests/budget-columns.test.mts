import assert from "node:assert/strict";
import { test } from "node:test";

import { columnTone, columnValue, type ColumnRow } from "@/lib/budget-columns";

/**
 * The Actual / Remaining toggle.
 *
 * The invariant is that these are one piece of information read from opposite ends,
 * so the two columns must never disagree about which rows are in trouble. Written
 * twice — once as "actual > budgeted" and once as "remaining < 0" — they agree
 * today and would drift the first time either was edited.
 */

const row = (over: Partial<ColumnRow>): ColumnRow => ({
  actual: 0,
  remaining: 0,
  budgeted: 0,
  kind: "category",
  ...over,
});

test("the two columns show the two ends of the same subtraction", () => {
  const r = row({ budgeted: 500, actual: 320, remaining: 180 });
  assert.equal(columnValue(r, "actual"), 320);
  assert.equal(columnValue(r, "remaining"), 180);
});

test("overspending is flagged in both columns, not just one", () => {
  const over = row({ budgeted: 500, actual: 620, remaining: -120 });

  assert.equal(columnTone(over, "actual"), "bad");
  assert.equal(columnTone(over, "remaining"), "bad");
});

test("money left is not flagged in either column", () => {
  const under = row({ budgeted: 500, actual: 320, remaining: 180 });

  assert.equal(columnTone(under, "actual"), "");
  assert.equal(columnTone(under, "remaining"), "");
});

test("spending exactly to budget is not flagged", () => {
  const exact = row({ budgeted: 500, actual: 500, remaining: 0 });
  assert.equal(columnTone(exact, "actual"), "");
  assert.equal(columnTone(exact, "remaining"), "");
});

/**
 * The reason `budgeted > 0` guards the whole comparison.
 *
 * Without it, every unbudgeted row would be flagged the moment a transaction landed
 * in it — overspent against a budget of zero — and a page with half its buckets
 * unallocated would come back mostly red.
 */
test("a bucket with no budget set is never flagged for exceeding zero", () => {
  const unbudgeted = row({ budgeted: 0, actual: 87.4, remaining: -87.4 });

  assert.equal(columnTone(unbudgeted, "actual"), "");
  assert.equal(columnTone(unbudgeted, "remaining"), "");
});

test("earnings read the right way round in both columns", () => {
  /*
   * Coming in over target is good news for income. Under Actual that is a figure
   * above the budget; under Remaining it is a positive number. Getting this wrong
   * would show a good month as a red overspend.
   */
  const ahead = row({ kind: "earning", budgeted: 4000, actual: 4255, remaining: -255 });
  assert.equal(columnTone(ahead, "actual"), "good");
  // In Remaining mode the sign has flipped, so the comparison has to flip with it:
  // a *negative* remaining here still means "beat the target".
  assert.equal(columnTone(ahead, "remaining"), "good");

  const behind = row({ kind: "earning", budgeted: 4000, actual: 3200, remaining: 800 });
  assert.equal(columnTone(behind, "actual"), "");
  assert.equal(columnTone(behind, "remaining"), "");
});

test("the earnings sign flip is the spending one, not a special case", () => {
  /*
   * Pinned deliberately, because "remaining < 0 means over budget" and "negative
   * remaining means beat the target" are the same arithmetic read two ways. Writing
   * one branch without the other is how an income row ends up flagged as overspent
   * for having a good month.
   */
  const spending = row({ kind: "category", budgeted: 500, actual: 620, remaining: -120 });
  const earning = row({ kind: "earning", budgeted: 500, actual: 620, remaining: -120 });

  assert.equal(columnTone(spending, "remaining"), "bad");
  assert.equal(columnTone(earning, "remaining"), "good");
  assert.equal(
    Math.sign(spending.remaining),
    Math.sign(earning.remaining),
    "identical arithmetic, opposite verdict, by row kind",
  );
});

test("negative remaining is shown signed, so it is legible without colour", () => {
  const over = row({ budgeted: 500, actual: 620, remaining: -120 });
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    signDisplay: "auto",
  }).format(columnValue(over, "remaining"));

  assert.ok(formatted.startsWith("-"), `expected a leading minus, got ${formatted}`);
});