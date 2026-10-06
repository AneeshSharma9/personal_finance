import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The remainder bucket is derived, not stored.
 *
 * Every other row's Budgeted figure is something the user typed. This one is the
 * budgeted earnings less everything else they typed — which means the arithmetic
 * that used to be the user's job on every row is now the page's, and the ways to
 * get that wrong are worth defending:
 *
 *  - treating the stored `monthlyLimit` as the answer, which is a number chosen
 *    months ago and now silently contradicts every edit made since; and
 *  - treating "no remainder bucket" as "the remainder is zero", which turns a plan
 *    that simply has no such bucket into one that looks over-allocated by the whole
 *    income.
 *
 * The four views that show the figure — the budget grid, the summary card, a bucket's
 * own page and the dashboard's over-budget marks — all go through this, which is why
 * it is asserted once here rather than per page.
 */

process.loadEnvFile(".env.local");

const { applyRemainderBucket, displayLimit, planFrom } = await import(
  "@/lib/budget-remainder"
);
type Groups = import("@/lib/queries").BudgetGroups;
type Row = import("@/lib/queries").BudgetRowResult;

const row = (over: Partial<Row>): Row => ({
  id: 1,
  kind: "category",
  name: "Bucket",
  categories: [],
  budgeted: 0,
  actual: 0,
  remaining: 0,
  percentUsed: null,
  isCatchAll: false,
  ...over,
});

const groups = (over: Partial<Groups> = {}): Groups => ({
  basic: [],
  category: [],
  earning: [],
  ...over,
});

/** Everything the derivation reads, which is all these rows carry. */
const plan = (rows: Row[]) =>
  planFrom(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      categories: r.categories,
      budgeted: r.budgeted,
    })),
  );

const amount = (rows: Row[], name: string): number =>
  rows.find((r) => r.name === name)!.budgeted;

test("the remainder is budgeted earnings less every other bucket", () => {
  const applied = applyRemainderBucket(
    groups({
      basic: [row({ id: 1, kind: "basic", name: "Rent", budgeted: 1447 })],
      category: [
        row({ id: 2, name: "Groceries", budgeted: 400 }),
        row({ id: 3, name: "Everything Else", budgeted: 12, isCatchAll: true }),
      ],
      earning: [row({ id: 4, kind: "earning", name: "Salary", budgeted: 3000 })],
    }),
  );

  /*
   * The stored 12 is what the user last typed there, possibly long ago. What it must
   * not be is what the page shows.
   */
  assert.equal(amount(applied.category, "Everything Else"), 1153);
});

test("the remainder row's leftover and percentage follow the derived figure", () => {
  const applied = applyRemainderBucket(
    groups({
      basic: [row({ id: 1, kind: "basic", name: "Rent", budgeted: 1000 })],
      category: [
        row({
          id: 2,
          name: "Everything Else",
          budgeted: 9999,
          actual: 100,
          remaining: 9899,
          percentUsed: 0.1,
          isCatchAll: true,
        }),
      ],
      earning: [row({ id: 5, kind: "earning", name: "Salary", budgeted: 1500 })],
    }),
  );

  const remainder = applied.category[0]!;
  assert.equal(remainder.budgeted, 500);
  assert.equal(remainder.remaining, 400);
  assert.equal(remainder.percentUsed, 20);
});

test("a bucket named Everything Else that claims categories is an ordinary bucket", () => {
  /*
   * The name is a heuristic; having no categories is the part that makes a bucket the
   * remainder. One that claims categories is competing for real transactions, so its
   * figure stays whatever the user set.
   */
  const rows = [
    row({
      id: 1,
      name: "Everything Else",
      categories: ["ENTERTAINMENT"],
      budgeted: 75,
    }),
  ];
  assert.equal(plan(rows).limit, null);

  const applied = applyRemainderBucket(groups({ category: rows }));
  assert.equal(amount(applied.category, "Everything Else"), 75);
});

test("no remainder bucket means no remainder, and the rows come back untouched", () => {
  const input = groups({
    category: [row({ id: 1, name: "Groceries", budgeted: 400 })],
    earning: [row({ id: 2, kind: "earning", name: "Salary", budgeted: 3000 })],
  });

  const derived = plan([...input.basic, ...input.category, ...input.earning]);
  assert.equal(derived.limit, null);
  assert.equal(derived.bucketId, null);
  assert.equal(derived.spendingBudgeted, 400);
  assert.equal(applyRemainderBucket(input), input);
});

test("over-allocating shows as a negative remainder rather than a clamped zero", () => {
  const applied = applyRemainderBucket(
    groups({
      basic: [row({ id: 1, kind: "basic", name: "Rent", budgeted: 2000 })],
      category: [row({ id: 2, name: "Everything Else", isCatchAll: true })],
      earning: [row({ id: 3, kind: "earning", name: "Salary", budgeted: 1500 })],
    }),
  );

  assert.equal(amount(applied.category, "Everything Else"), -500);
});

test("no earnings budgeted leaves the remainder negative, not positive", () => {
  /*
   * The tempting version of this is `Math.max(income - allocated, 0)`, which reads as
   * tidier and is wrong: it would report a plan with no income at all as fully
   * allocated, hiding the entire shortfall behind a zero.
   */
  const applied = applyRemainderBucket(
    groups({ category: [row({ id: 2, name: "Everything Else", isCatchAll: true })] }),
  );
  assert.equal(amount(applied.category, "Everything Else"), 0);
});

test("the remainder is rounded to whole cents", () => {
  const applied = applyRemainderBucket(
    groups({
      basic: [
        row({ id: 1, kind: "basic", name: "A", budgeted: 0.1 }),
        row({ id: 2, kind: "basic", name: "B", budgeted: 0.2 }),
      ],
      category: [row({ id: 3, name: "Everything Else", isCatchAll: true })],
      earning: [row({ id: 4, kind: "earning", name: "Salary", budgeted: 1 })],
    }),
  );
  // 1 - 0.1 - 0.2 is 0.7000000000000001 in binary floating point.
  assert.equal(amount(applied.category, "Everything Else"), 0.7);
});

test("the plan foots to the budgeted income exactly", () => {
  const rows = [
    row({ id: 1, kind: "basic", name: "Rent", budgeted: 1447.5 }),
    row({ id: 2, kind: "basic", name: "Car", budgeted: 410 }),
    row({ id: 3, name: "Groceries", budgeted: 450.25 }),
    row({ id: 4, name: "Everything Else", budgeted: 77, isCatchAll: true }),
    row({ id: 5, kind: "earning", name: "Salary", budgeted: 4200 }),
  ];

  const derived = plan(rows);
  assert.equal(derived.limit, 1892.25);
  assert.equal(derived.spendingBudgeted, 4200);
  assert.equal(derived.earningsBudgeted, 4200);
});

test("the stored limit of the remainder bucket does not count towards the base", () => {
  /*
   * Subtracting every stored limit including the remainder's own would make the
   * derived figure depend on the number it replaces, so re-deriving it would move the
   * answer and there would be no fixed point.
   */
  const withLimit = (budgeted: number) =>
    plan([
      row({ id: 1, name: "Rent", budgeted: 100 }),
      row({ id: 2, name: "Everything Else", budgeted, isCatchAll: true }),
      row({ id: 3, kind: "earning", name: "Salary", budgeted: 1000 }),
    ]).limit;

  assert.equal(withLimit(5), 900);
  assert.equal(withLimit(500), 900);
});

test("with two remainder buckets the older one takes it, whichever way round they arrive", () => {
  /*
   * The unique constraint is on (kind, name), so "Everything Else" and "Other" can
   * both qualify. Lowest id is the one `bucketCategoryRules` reaches first when
   * routing, so it is the row whose figure has to be the remainder — and selecting by
   * position would move the figure between two rows every time the display sort did.
   *
   * The second keeps its own limit and is subtracted like any other row, so
   * 1000 - 100 rent - 2 for it. Two remainder buckets is a configuration nobody plans
   * for; what matters is that it resolves the same way every render.
   */
  const older = row({ id: 4, name: "Everything Else", budgeted: 1, isCatchAll: true });
  const newer = row({ id: 9, name: "Other", budgeted: 2, isCatchAll: true });
  const rent = row({ id: 1, name: "Rent", budgeted: 100 });
  const salary = row({ id: 2, kind: "earning", name: "Salary", budgeted: 1000 });

  assert.equal(plan([newer, rent, older, salary]).bucketId, 4);
  assert.equal(plan([older, newer, rent, salary]).bucketId, 4);

  const forwards = applyRemainderBucket(
    groups({ category: [rent, older, newer], earning: [salary] }),
  );
  const backwards = applyRemainderBucket(
    groups({ category: [rent, newer, older], earning: [salary] }),
  );

  assert.equal(amount(forwards.category, "Everything Else"), 898);
  assert.equal(amount(forwards.category, "Other"), 2);
  // Order is passed through untouched, so the two are compared by row, not by slot.
  assert.equal(amount(backwards.category, "Everything Else"), 898);
  assert.equal(amount(backwards.category, "Other"), 2);
});

test("a remainder bucket in Budget Basics is derived there too", () => {
  const applied = applyRemainderBucket(
    groups({
      basic: [row({ id: 7, kind: "basic", name: "Everything Else", isCatchAll: true })],
      category: [row({ id: 2, name: "Groceries", budgeted: 400 })],
      earning: [row({ id: 8, kind: "earning", name: "Salary", budgeted: 1000 })],
    }),
  );
  assert.equal(amount(applied.basic, "Everything Else"), 600);
});

test("earnings are income, never a remainder, even called Other", () => {
  /*
   * "Other Income" matches the name heuristic but is money in. Treating it as a
   * remainder would measure the plan against itself.
   */
  const applied = applyRemainderBucket(
    groups({
      category: [row({ id: 2, name: "Groceries", budgeted: 400 })],
      earning: [row({ id: 8, kind: "earning", name: "Other Income", budgeted: 250 })],
    }),
  );
  assert.equal(amount(applied.earning, "Other Income"), 250);
  assert.equal(plan([...applied.category, ...applied.earning]).limit, null);
});

test("displayLimit swaps only the remainder bucket's stored limit", () => {
  /*
   * The three pages that read a bucket's limit one at a time — the buckets list, a
   * bucket's own page and the cash flow diagram — all go through this, because each
   * of them would otherwise show a stored figure the budgets page no longer shows.
   */
  const derived = plan([
    row({ id: 1, name: "Rent", budgeted: 1447 }),
    row({ id: 2, name: "Everything Else", budgeted: 12, isCatchAll: true }),
    row({ id: 3, kind: "earning", name: "Salary", budgeted: 3000 }),
  ]);

  assert.equal(displayLimit(derived, { id: 1, budgeted: 1447 }), 1447);
  assert.equal(displayLimit(derived, { id: 2, budgeted: 12 }), 1553);
  assert.equal(displayLimit(derived, { id: 3, budgeted: 3000 }), 3000);
});

test("displayLimit leaves every limit alone when there is no remainder bucket", () => {
  const derived = plan([
    row({ id: 1, name: "Rent", budgeted: 1447 }),
    row({ id: 3, kind: "earning", name: "Salary", budgeted: 3000 }),
  ]);

  assert.equal(derived.limit, null);
  assert.equal(displayLimit(derived, { id: 1, budgeted: 1447 }), 1447);
});