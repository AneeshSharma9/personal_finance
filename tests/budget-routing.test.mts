import assert from "node:assert/strict";
import { test } from "node:test";

process.loadEnvFile(".env.local");

const { bucketCategoryRules, isBalanceMovement, matchesExclusion, resolveBucket } =
  await import("@/lib/budget-engine");
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
    exclusionRules: [],
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

test("a credit card payment is not income", () => {
  // The reported bug: "CAPITAL ONE MOBILE PYMT -487.14" on a Savor card landed in
  // Income, because a negative amount on a credit account looks like a deposit.
  const row = txn({
    merchantName: "CAPITAL ONE MOBILE PYMT",
    plaidCategoryPrimary: "LOAN_PAYMENTS",
    amount: "-487.14",
    accountType: "credit",
  });
  assert.notEqual(
    resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
    B.income,
  );
});

test("a payment on a loan account is not income either", () => {
  const row = txn({
    plaidCategoryPrimary: "LOAN_PAYMENTS",
    amount: "-600",
    accountType: "loan",
  });
  assert.notEqual(
    resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
    B.income,
  );
});

test("a real deposit to a checking account is still income", () => {
  // The fix must not break the case the deposit rule was added for.
  for (const accountType of ["depository", "investment"]) {
    const row = txn({
      plaidCategoryPrimary: "TRANSFER_IN",
      amount: "-2500",
      accountType,
    });
    assert.equal(
      resolveBucket(row, rules({ earningBudgetIds: [B.income] })),
      B.income,
      `${accountType} inflow should be income`,
    );
  }
});

test("isBalanceMovement only flags liability-side inflows", () => {
  // The pure predicate behind the exclusion.
  assert.equal(isBalanceMovement({ amount: -487.14, accountType: "credit" }), true);
  assert.equal(isBalanceMovement({ amount: -600, accountType: "loan" }), true);
  assert.equal(isBalanceMovement({ amount: -2500, accountType: "depository" }), false);
  assert.equal(isBalanceMovement({ amount: -50, accountType: "investment" }), false);
  // Outflows are never movements of a balance in this sense.
  assert.equal(isBalanceMovement({ amount: 40, accountType: "credit" }), false);
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

/*
 * A bucket holding several categories.
 *
 * The user could only ever pick one Plaid category per bucket, so a real spending
 * group had to be called something vague ("Fun") or split into several buckets
 * that then competed for the same transactions. These cover the array form.
 */
const budget = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "Bucket",
  budgetKind: "category" as const,
  categories: [] as string[],
  ...over,
});

test("a bucket emits one rule per category it holds", () => {
  const { bucketCategories } = bucketCategoryRules([
    budget({ id: 7, name: "Weekend", categories: ["DINING_AND_DRINK", "ENTERTAINMENT"] }),
  ]);

  assert.deepEqual(bucketCategories, [
    { budgetId: 7, value: "DINING_AND_DRINK", name: "Weekend" },
    { budgetId: 7, value: "ENTERTAINMENT", name: "Weekend" },
  ]);
});

test("a bucket matches every category it holds, not just the first", () => {
  const { bucketCategories } = bucketCategoryRules([
    budget({ id: 7, name: "Weekend", categories: ["DINING_AND_DRINK", "ENTERTAINMENT"] }),
  ]);

  for (const category of ["DINING_AND_DRINK", "ENTERTAINMENT"]) {
    assert.equal(
      resolveBucket(txn({ plaidCategoryPrimary: category }), rules({ bucketCategories })),
      7,
      `${category} should reach Weekend`,
    );
  }
  // and it still does not claim anything else
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "RENT_AND_UTILITIES_RENT" }), rules({ bucketCategories })),
    B.catchAll,
  );
});

test("category values are uppercased on the way in", () => {
  const { bucketCategories } = bucketCategoryRules([
    budget({ id: 7, name: "Weekend", categories: ["dining_and_drink"] }),
  ]);
  assert.equal(bucketCategories[0]?.value, "DINING_AND_DRINK");
});

test("the catch-all is the bucket with no categories", () => {
  const { catchAllBudgetId } = bucketCategoryRules([
    budget({ id: 7, name: "Weekend", categories: ["ENTERTAINMENT"] }),
    budget({ id: 9, name: "Everything Else", categories: [] }),
  ]);
  assert.equal(catchAllBudgetId, 9);
});

test("a catch-all given a category stops being the catch-all", () => {
  /*
   * Otherwise it would compete with a real bucket and take its transactions -
   * the opposite of what a remainder bucket is for. Losing the remainder is the
   * correct outcome, and the editor greys the option out so it is hard to do by
   * accident.
   */
  const { catchAllBudgetId, bucketCategories } = bucketCategoryRules([
    budget({ id: 9, name: "Everything Else", categories: ["ENTERTAINMENT"] }),
  ]);
  assert.equal(catchAllBudgetId, null);
  assert.equal(bucketCategories.length, 1);
});

test("two buckets claiming one category: the first wins and the second gets nothing", () => {
  /*
   * Not rejected anywhere - the editor greys the option out, but a direct PUT
   * still allows it. Documented here because the failure is silent and total: the
   * second bucket reads $0 forever with no error, which is what made two buckets
   * created from the same template look like a broken import.
   */
  const { bucketCategories } = bucketCategoryRules([
    budget({ id: 7, name: "First", categories: ["ENTERTAINMENT"] }),
    budget({ id: 8, name: "Second", categories: ["ENTERTAINMENT"] }),
  ]);

  assert.equal(bucketCategories.length, 2, "both rules are built");
  assert.equal(
    resolveBucket(txn({ plaidCategoryPrimary: "ENTERTAINMENT" }), rules({ bucketCategories })),
    7,
    "only the first ever matches",
  );
});

test("earnings buckets never claim spending categories", () => {
  const { bucketCategories, catchAllBudgetId } = bucketCategoryRules([
    budget({ id: 7, name: "Paycheck", budgetKind: "earning", categories: ["INCOME"] }),
  ]);
  assert.deepEqual(bucketCategories, []);
  assert.equal(catchAllBudgetId, null);
});

/*
 * Ignore rules on the sync path.
 *
 * These are the rules that were silently invisible here. `loadRuleSet` builds
 * `bucketRules` with `rule.budgetId !== null`, which is right for routing — an
 * ignore step has no bucket to route into — and wrong for exclusion. So this engine,
 * the one that runs after every Plaid sync and webhook, never saw them: an ignore
 * rule only worked on transactions that already existed when the rule was saved,
 * and anything arriving afterwards was routed past it into the catch-all.
 */
const ignore = (value: string) => [
  { matchType: "merchant" as const, value, numericValue: 0 },
];

test("an ignore rule claims a matching transaction", () => {
  const r = rules({ exclusionRules: ignore("crcardpmt") });
  assert.equal(
    matchesExclusion(
      txn({ name: "ACH HOLD CAPITAL ONE DES:CRCARDPMT ID:CA07", amount: 807.55 }),
      r,
    ),
    true,
  );
});

test("merchant matching is a substring and case-insensitive, like routing", () => {
  const r = rules({ exclusionRules: ignore("capital one des:crcardpmt") });
  assert.equal(
    matchesExclusion(txn({ name: "CAPITAL ONE DES:CRCARDPMT ON 10/02" }), r),
    true,
    "the rule is lower-cased and the haystack is too",
  );
  assert.equal(matchesExclusion(txn({ name: "SOMETHING ELSE" }), r), false);
});

test("an ignore rule does not claim an unrelated transaction", () => {
  const r = rules({ exclusionRules: ignore("crcardpmt") });
  assert.equal(matchesExclusion(txn({ name: "EAGLE VILLA" }), r), false);
});

test("no ignore rules means nothing is excluded", () => {
  assert.equal(matchesExclusion(txn({ name: "ANYTHING" }), rules()), false);
});

test("category ignore rules match the way category routing does", () => {
  const r = rules({
    exclusionRules: [
      { matchType: "category", value: "LOAN_PAYMENTS", numericValue: 0 },
    ],
  });
  assert.equal(
    matchesExclusion(txn({ plaidCategoryPrimary: "LOAN_PAYMENTS" }), r),
    true,
  );
  // Boundary-aware, so a partial category does not match.
  assert.equal(matchesExclusion(txn({ plaidCategoryPrimary: "GENERAL" }), r), false);
});

test("an amount ignore rule matches a magnitude, not a sign", () => {
  const r = rules({
    exclusionRules: [{ matchType: "amount", value: "600", numericValue: 600 }],
  });
  assert.equal(matchesExclusion(txn({ amount: 600 }), r), true);
  assert.equal(matchesExclusion(txn({ amount: -600 }), r), true);
  assert.equal(matchesExclusion(txn({ amount: 599 }), r), false);
});

test("an unparseable amount rule cannot match anything", () => {
  /*
   * The stand-in for an unparseable value has to be unreachable rather than merely
   * unlikely, and the obvious choice of 0 is not: `Math.abs(0 - 0) < 0.005` is true,
   * so it would match every zero-value transaction. `Number("")` is also 0, which is
   * how an empty match value gets in. NaN is the only value that cannot equal
   * anything under subtraction.
   */
  for (const bad of ["NOT_A_NUMBER", ""]) {
    const r = rules({
      exclusionRules: [
        { matchType: "amount", value: bad, numericValue: Number.NaN },
      ],
    });
    for (const amount of [0, 0.01, -600, 807.55]) {
      assert.equal(
        matchesExclusion(txn({ amount }), r),
        false,
        `"${bad}" must not match ${amount}`,
      );
    }
  }
});


test("a user's category override is what an ignore rule sees", () => {
  const r = rules({
    exclusionRules: [{ matchType: "category", value: "INCOME", numericValue: 0 }],
  });
  assert.equal(
    matchesExclusion(
      txn({ categoryOverride: "INCOME", plaidCategoryPrimary: "TRANSFER_IN" }),
      r,
    ),
    true,
  );
});

/**
 * The case that decided the shape of the fix.
 *
 * Two of the user's rules match "uas": one ignoring it, one filing it into
 * Savings/Debt. The row needs to end up **both** — excluded so it counts as neither
 * income nor spending, bucketed so it stays visible where it was put rather than
 * disappearing. An early `continue` on the ignore would have quietly broken the
 * second rule for every future transaction.
 */
test("a transaction can be ignored and bucketed at the same time", () => {
  const r = rules({
    exclusionRules: ignore("uas"),
    merchantRules: [{ budgetId: 69, value: "uas" }],
    catchAllBudgetId: null,
  });
  const row = txn({ name: "UAS PAYMENT", amount: 1000 });

  assert.equal(matchesExclusion(row, r), true, "the ignore rule claims it");
  assert.equal(
    resolveBucket(row, r),
    69,
    "and the bucket rule still files it, which is why the loop must not `continue`",
  );
});

test("an ignore rule that matches leaves the catch-all free to catch everything else", () => {
  const r = rules({ exclusionRules: ignore("crcardpmt") });
  // This is the actual bug: the ignored card payment was landing in Everything Else.
  assert.equal(
    resolveBucket(txn({ name: "CAPITAL ONE DES:CRCARDPMT" }), r),
    B.catchAll,
    "routing is unchanged - exclusion is a separate question, asked separately",
  );
});
