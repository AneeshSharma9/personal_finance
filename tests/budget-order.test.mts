import assert from "node:assert/strict";
import { test } from "node:test";

process.loadEnvFile(".env.local");

const { sortBudgetRows } = await import("@/lib/queries");
type Row = import("@/lib/queries").BudgetRowResult;

const row = (over: Partial<Row>): Row => ({
  id: 1,
  kind: "basic",
  name: "Bucket",
  categories: [],
  budgeted: 0,
  actual: 0,
  remaining: 0,
  percentUsed: null,
  isCatchAll: false,
  ...over,
});

const names = (rows: Row[]) => rows.map((r) => r.name);

test("buckets are ordered by budgeted amount, biggest first", () => {
  const sorted = sortBudgetRows([
    row({ name: "Small", budgeted: 50 }),
    row({ name: "Big", budgeted: 2000 }),
    row({ name: "Middle", budgeted: 400 }),
  ]);
  assert.deepEqual(names(sorted), ["Big", "Middle", "Small"]);
});

test("the remainder bucket is last however big it is", () => {
  /*
   * Its size is an output, not a decision. Sorting it into the middle because it
   * happened to be large would read as though it were a peer of the rows above it.
   */
  const sorted = sortBudgetRows([
    row({ name: "Everything Else", budgeted: 5000, isCatchAll: true }),
    row({ name: "Rent", budgeted: 1447 }),
    row({ name: "Insurance", budgeted: 200 }),
  ]);
  assert.deepEqual(names(sorted), ["Rent", "Insurance", "Everything Else"]);
});

test("a zero-budget remainder bucket is still last, not first", () => {
  const sorted = sortBudgetRows([
    row({ name: "Everything Else", budgeted: 0, isCatchAll: true }),
    row({ name: "Rent", budgeted: 1447 }),
  ]);
  assert.deepEqual(names(sorted), ["Rent", "Everything Else"]);
});

test("equal amounts break on name, so the order cannot shuffle between renders", () => {
  const a = row({ name: "Alpha", budgeted: 100, id: 1 });
  const b = row({ name: "Zulu", budgeted: 100, id: 2 });
  assert.deepEqual(names(sortBudgetRows([a, b])), ["Alpha", "Zulu"]);
  assert.deepEqual(names(sortBudgetRows([b, a])), ["Alpha", "Zulu"]);
});

test("a negative or odd budget still sorts by value", () => {
  const sorted = sortBudgetRows([
    row({ name: "Overdrawn", budgeted: -50 }),
    row({ name: "Fine", budgeted: 10 }),
  ]);
  assert.deepEqual(names(sorted), ["Fine", "Overdrawn"]);
});

test("ordering is per group, and earnings are unaffected by the catch-all rule", () => {
  /*
   * isCatchAll is false for every earnings row by construction, so an earnings
   * group is simply biggest-first with no row held back.
   */
  const earnings = sortBudgetRows([
    row({ name: "Side income", kind: "earning", budgeted: 200 }),
    row({ name: "Salary", kind: "earning", budgeted: 5000 }),
    row({ name: "None", kind: "earning", budgeted: 0 }),
  ]);
  assert.deepEqual(names(earnings), ["Salary", "Side income", "None"]);
});
