import assert from "node:assert/strict";
import { test } from "node:test";

import {
  columnOverBudget,
  columnTone,
  columnValue,
  type ColumnRow,
} from "@/lib/budget-columns";

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

/**
 * The aggregate rule, and the bug it exists because of.
 *
 * The Spending Budget footer hardcoded `spendingActual` while every table above it
 * followed the toggle, so switching to Remaining left the one figure that carries
 * the red/green verdict still reporting Actual. Nothing below would have caught
 * that: the tables were right, and `columnTone` was right — only the footer was
 * outside the shared rule, which is why the fix pulls it *into* `columnOverBudget`
 * rather than adding a second `column === "remaining"` ternary at the call site.
 */
test("the aggregate comparison agrees with the row one in both columns", () => {
  for (const [actual, budgeted] of [
    [620, 500],
    [320, 500],
    [500, 500],
    [0, 0],
  ] as const) {
    const remaining = budgeted - actual;
    for (const column of ["actual", "remaining"] as const) {
      assert.equal(
        columnOverBudget(actual, budgeted, column),
        columnTone(row({ actual, remaining, budgeted, kind: "category" }), column) === "bad",
        `aggregate and row disagree at actual=${actual} budgeted=${budgeted} in ${column}`,
      );
    }
  }
});

test("the aggregate rule has no zero-budget guard, and that is deliberate", () => {
  /*
   * `columnTone` refuses to flag a bucket with no limit set, so a page with half
   * its buckets unallocated does not come back mostly red. That guard is
   * wrong for the month's total: spending money against a budget of nothing is
   * exactly the thing the footer exists to flag, and the footer was already
   * doing so before this was extracted. Hence two entry points rather than one
   * function with a flag.
   */
  assert.equal(columnOverBudget(87.4, 0, "actual"), true);
  assert.equal(columnOverBudget(87.4, 0, "remaining"), true);
  assert.equal(
    columnTone(row({ budgeted: 0, actual: 87.4, remaining: -87.4 }), "actual"),
    "",
    "a single unbudgeted bucket is still never flagged",
  );
});

test("a zero budget with no spending is not flagged either way", () => {
  assert.equal(columnOverBudget(0, 0, "actual"), false);
  assert.equal(columnOverBudget(0, 0, "remaining"), false);
});