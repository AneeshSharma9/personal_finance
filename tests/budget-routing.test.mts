import assert from "node:assert/strict";
import { test } from "node:test";

process.loadEnvFile(".env.local");

const { resolveBucket } = await import("@/lib/budget-engine");
type RuleSet = import("@/lib/budget-engine").RuleSet;

/** Bucket ids used across these tests. */
const B = { dining: 1, groceries: 2, transport: 3, catchAll: 4, income: 5 };

function rules(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    amountRules: [],
    merchantRules: [],
    categoryRules: [],
    bucketCategories: [],
    catchAllBudgetId: B.catchAll,
    earningBudgetIds: [],
    loanRules: [],
    ...overrides,
  };
}

const txn = (over: Record<string, string | number | null> = {}) => ({
  merchantName: null,
  name: null,
  categoryOverride: null,
  plaidCategoryPrimary: null,
  plaidCategoryDetailed: null,
  ...over,
});

test("a bucket's category routes matching transactions", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.groceries, value: "FOOD_AND_DRINK_GROCERIES", name: "Groceries" }],
  });
  const result = resolveBucket(
    txn({ plaidCategoryPrimary: "FOOD_AND_DRINK_GROCERIES" }),
    set,
  );
  assert.equal(result, B.groceries);
});

test("prefix matching absorbs a detailed child category", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOOD_AND_DRINK", name: "Food & Drink" }],
  });
  assert.equal(
    resolveBucket(txn({ plaidCategoryDetailed: "FOOD_AND_DRINK_GROCERIES" }), set),
    B.dining,
  );
  assert.equal(
    resolveBucket(txn({ plaidCategoryDetailed: "FOOD_AND_DRINK_RESTAURANT" }), set),
    B.dining,
  );
});

test("category matching is boundary-aware, not substring", () => {
  // A bucket on "FOOD" legitimately absorbs FOOD_AND_DRINK, because they meet on
  // an underscore boundary. What must NOT match is a value that merely starts
  // with the same letters - otherwise a typo'd or truncated rule would swallow
  // unrelated spending.
  const set = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOO", name: "Foo" }],
    catchAllBudgetId: null,
  });
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "FOOD_AND_DRINK" }), set),
    null,
    "FOO must not match FOOD_AND_DRINK",
  );

  const boundarySet = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOOD", name: "Food" }],
    catchAllBudgetId: null,
  });
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "FOOD_AND_DRINK" }), boundarySet),
    B.dining,
    "FOOD should match FOOD_AND_DRINK on the underscore boundary",
  );
});

test("a merchant rule overrides the transaction's own category", () => {
  const set = rules({
    bucketCategories: [
      { budgetId: B.groceries, value: "FOOD_AND_DRINK", name: "Groceries" },
    ],
    merchantRules: [{ budgetId: B.dining, value: "starbucks" }],
  });
  // Plaid categorises coffee shops under FOOD_AND_DRINK, but the rule wins.
  assert.equal(
    resolveBucket(
      txn({ merchantName: "Starbucks", plaidCategoryPrimary: "FOOD_AND_DRINK" }),
      set,
    ),
    B.dining,
  );
});

test("merchant matching is case-insensitive", () => {
  const set = rules({ merchantRules: [{ budgetId: B.dining, value: "chipotle" }] });
  assert.equal(resolveBucket(txn({ merchantName: "CHIPOTLE" }), set), B.dining);
});

test("merchant rules fall back to the raw description when merchant is null", () => {
  const set = rules({ merchantRules: [{ budgetId: B.transport, value: "shell" }] });
  assert.equal(
    resolveBucket(txn({ merchantName: null, name: "SHELL OIL 5748" }), set),
    B.transport,
  );
});

test("an explicit category rule beats a bucket's own category", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOOD_AND_DRINK", name: "Dining" }],
    categoryRules: [{ budgetId: B.groceries, value: "FOOD_AND_DRINK" }],
  });
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "FOOD_AND_DRINK" }), set),
    B.groceries,
  );
});

test("a deposit is income even when Plaid calls it a transfer", () => {
  // The reported problem: Plaid files a payroll deposit as TRANSFER_IN, which
  // matches no income keyword, so it landed in a spending bucket and Earnings
  // stayed empty.
  const row = txn({
    merchantName: "ACME PAYROLL",
    plaidCategoryPrimary: "TRANSFER_IN",
    amount: "-2500",
  });
  assert.equal(
    resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
    B.income,
  );
});

test("any money coming in is income, whatever the category", () => {
  for (const category of ["TRANSFER_IN", "GENERAL_MERCHANDISE", "FOOD_AND_DRINK"]) {
    const row = txn({ plaidCategoryPrimary: category, amount: "-100" });
    assert.equal(
      resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
      B.income,
      `${category} inflow should be income`,
    );
  }
});

test("an outflow is not income, so spending never lands in earnings", () => {
  // The invariant that matters: direction, not category, is what makes money
  // income. An outflow stays in a spending bucket.
  for (const category of ["TRANSFER_OUT", "FOOD_AND_DRINK", "GENERAL_MERCHANDISE"]) {
    const row = txn({ plaidCategoryPrimary: category, amount: "40" });
    assert.notEqual(
      resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
      B.income,
      `${category} outflow should not be income`,
    );
  }
});

test("a deposit beats a merchant rule, the same way income does", () => {
  const row = txn({
    merchantName: "Starbucks",
    plaidCategoryPrimary: "TRANSFER_IN",
    amount: "-25",
  });
  const withMerchant = rules({
    merchantRules: [{ budgetId: B.dining, value: "starbucks" }],
    earningBudgetIds: [B.income],
  });
  assert.equal(resolveBucket(row, withMerchant), B.income);
});

test("with no earnings bucket a deposit is left unassigned, not misfiled", () => {
  const row = txn({ plaidCategoryPrimary: "TRANSFER_IN", amount: "-500" });
  assert.equal(resolveBucket(row, rules({ earningBudgetIds: [] })), null);
});

test("income goes to the earnings bucket, never to spending", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOOD_AND_DRINK", name: "Dining" }],
    earningBudgetIds: [B.income],
  });
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "INCOME_PAYROLL" }), set),
    B.income,
  );
  // Even if a merchant rule would otherwise claim it.
  const withMerchant = rules({
    merchantRules: [{ budgetId: B.dining, value: "acme" }],
    earningBudgetIds: [B.income],
  });
  assert.equal(
    resolveBucket(txn({ merchantName: "ACME PAYROLL", plaidCategoryPrimary: "INCOME_PAYROLL" }), withMerchant),
    B.income,
  );
});

test("a user's category override takes precedence over Plaid's", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.groceries, value: "TRANSPORTATION", name: "Transport" }],
  });
  // Overridden to Transportation, so it must follow the override.
  assert.equal(
    resolveBucket(
      txn({
        categoryOverride: "TRANSPORTATION",
        plaidCategoryPrimary: "FOOD_AND_DRINK_GROCERIES",
      }),
      set,
    ),
    B.groceries,
  );
});

test("unmatched spending lands in the catch-all", () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.dining, value: "FOOD_AND_DRINK", name: "Dining" }],
    catchAllBudgetId: B.catchAll,
  });
  assert.equal(resolveBucket(txn({ plaidCategoryPrimary: "OTHER" }), set), B.catchAll);
});

test("nothing is assigned when no buckets and no rules exist", () => {
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "OTHER" }), rules({ catchAllBudgetId: null })),
    null,
  );
});
test("a category override outranks Plaid's own category", async () => {
  // Regression: overriding a McDonald's charge (Plaid: FOOD_AND_DRINK) to
  // TRANSPORTATION used to leave it in the Food & Drink bucket, because buckets
  // are checked in display order and Plaid's category matched first.
  const set = rules({
    bucketCategories: [
      // Deliberately ordered so the Plaid-matching bucket is checked first.
      { budgetId: B.groceries, value: "FOOD_AND_DRINK", name: "Food & Drink" },
      { budgetId: B.transport, value: "TRANSPORTATION", name: "Transportation" },
    ],
    catchAllBudgetId: null,
  });

  assert.equal(
    resolveBucket(
      txn({
        categoryOverride: "TRANSPORTATION",
        plaidCategoryPrimary: "FOOD_AND_DRINK",
      }),
      set,
    ),
    B.transport,
  );
});

test("an override with no matching bucket falls to the catch-all, not a Plaid bucket", async () => {
  const set = rules({
    bucketCategories: [{ budgetId: B.groceries, value: "FOOD_AND_DRINK", name: "Food" }],
    catchAllBudgetId: B.catchAll,
  });

  // "ENTERTAINMENT" has no bucket. It must not be swallowed by Food & Drink.
  assert.equal(
    resolveBucket(
      txn({
        categoryOverride: "ENTERTAINMENT",
        plaidCategoryPrimary: "FOOD_AND_DRINK",
      }),
      set,
    ),
    B.catchAll,
  );
});

test("a merchant rule still outranks a category override", () => {
  const set = rules({
    merchantRules: [{ budgetId: B.dining, value: "starbucks" }],
    bucketCategories: [{ budgetId: B.transport, value: "TRANSPORTATION", name: "Transport" }],
  });

  assert.equal(
    resolveBucket(
      txn({
        merchantName: "Starbucks",
        categoryOverride: "TRANSPORTATION",
        plaidCategoryPrimary: "FOOD_AND_DRINK",
      }),
      set,
    ),
    B.dining,
  );
});
