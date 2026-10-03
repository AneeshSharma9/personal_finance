import "server-only";

import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { categoryCandidates, isCatchAll, isEarningCategory } from "@/lib/categories";

/**
 * Automatic routing of transactions into budget buckets.
 *
 * Precedence, highest first - first match wins:
 *   1. Explicit merchant rules ("Starbucks" -> Dining). A deliberate override.
 *   2. Explicit category rules stored in budget_rules.
 *   3. Each budget row's own `category`, which is an implicit category rule.
 *   4. The "Everything Else" bucket, which absorbs spending nothing claimed.
 *   5. An earnings bucket, for money in.
 *
 * Only transactions with no assignment are touched. A manual assignment is
 * therefore durable: re-running the engine never overwrites a decision the user
 * made, and never re-routes a transaction a rule already placed. Deleting the
 * engine's input (rules or buckets) is what makes it reconsider.
 */

export type AssignmentResult = {
  scanned: number;
  assigned: number;
  /** Rows marked excluded rather than bucketed (card payments, and so on). */
  excluded?: number;
  byBucket: Record<string, number>;
};

/** Cached per request; the engine runs after a sync on every webhook. */
export type RuleSet = {
  /** Exact-figure rules, evaluated before everything else. */
  amountRules: { budgetId: number; value: number }[];
  merchantRules: { budgetId: number; value: string }[];
  categoryRules: { budgetId: number; value: string }[];
  /** Implicit per-bucket category rules, in display order. */
  bucketCategories: { budgetId: number; value: string; name: string }[];
  catchAllBudgetId: number | null;
  earningBudgetIds: number[];
  /**
   * Rules that pay down a loan rather than fill a bucket.
   *
   * Held apart from the bucket rules because the two targets are different kinds
   * of thing: a bucket assignment moves money between spending categories, while
   * a loan rule mints a payment record and moves a debt balance.
   */
  loanRules: { loanId: number; matchType: string; value: string }[];
};

/**
 * Turn budget rows into implicit category rules.
 *
 * Pure, and extracted from loadRuleSet so it can be tested without a database -
 * this is the part that decides which transactions a bucket claims, and it is
 * where a bucket stops being one category and becomes several.
 *
 * One entry per (bucket, category) pair, not per bucket. "Weekend" holding
 * [DINING_AND_DRINK, ENTERTAINMENT] has to match both, and they are independent:
 * matching dining must not stop it matching entertainment.
 */
export function bucketCategoryRules(
  budgets: {
    id: number;
    name: string;
    budgetKind: "basic" | "category" | "earning";
    categories: string[];
  }[],
): {
  bucketCategories: { budgetId: number; value: string; name: string }[];
  catchAllBudgetId: number | null;
} {
  const spending = budgets.filter((budget) => budget.budgetKind !== "earning");

  /*
   * Categories are honoured on any spending bucket, including one whose name
   * looks like the remainder bucket. The name is a heuristic; an explicit category
   * is a decision, and the two are orthogonal - so "Everything Else" plus
   * [ENTERTAINMENT] claims entertainment and is simply no longer the catch-all.
   *
   * Ignoring the category because of the name was strictly worse: such a bucket
   * produced no rule AND no catch-all, so it matched nothing at all and displayed
   * a plausible-looking $0 actual with nothing to explain it.
   */
  const bucketCategories = spending
    .filter((budget) => budget.categories.length > 0)
    .flatMap((budget) =>
      budget.categories.map((value) => ({
        budgetId: budget.id,
        value: value.toUpperCase(),
        name: budget.name,
      })),
    );

  /*
   * The catch-all means "spending nothing else claimed", so it is identified by
   * having no categories at all. Giving it one would make it compete with a real
   * bucket and take that bucket's transactions, which is the opposite of what a
   * remainder bucket is for.
   */
  const catchAll = spending.find(
    (budget) => budget.categories.length === 0 && isCatchAll(budget.name),
  );

  return { bucketCategories, catchAllBudgetId: catchAll?.id ?? null };
}

export async function loadRuleSet(userId: string): Promise<RuleSet> {
  const [rules, budgets] = await Promise.all([
    db.query.budgetRules.findMany({
      where: and(
        eq(tables.budgetRules.userId, userId),
        eq(tables.budgetRules.active, true),
      ),
      orderBy: [
        asc(tables.budgetRules.priority),
        asc(tables.budgetRules.id),
      ],
    }),
    db.query.budgets.findMany({
      where: eq(tables.budgets.userId, userId),
      orderBy: [
        asc(tables.budgets.budgetKind),
        asc(tables.budgets.sortOrder),
        asc(tables.budgets.id),
      ],
    }),
  ]);

  // A loan rule has no bucket, and a bucket rule has no loan. The CHECK
  // constraint guarantees exactly one is set, so the nulls here are expected and
  // are filtered rather than coerced.
  const bucketRules = rules.filter((rule) => rule.budgetId !== null);
  const loanRules = rules
    .filter((rule) => rule.loanId !== null)
    .map((rule) => ({
      loanId: rule.loanId!,
      matchType: rule.matchType,
      value: rule.matchType === "merchant" ? rule.matchValue.toLowerCase() : rule.matchValue,
    }));

  const amountRules = bucketRules
    .filter((rule) => rule.matchType === "amount")
    .map((rule) => ({
      budgetId: rule.budgetId!,
      // Stored as text but compared as a number, so "600" and "600.00" are one
      // rule rather than two that never both fire.
      value: Number(rule.matchValue),
    }))
    .filter((rule) => Number.isFinite(rule.value));

  const merchantRules = bucketRules
    .filter((rule) => rule.matchType === "merchant")
    .map((rule) => ({
      budgetId: rule.budgetId!,
      value: rule.matchValue.toLowerCase(),
    }));

  const categoryRules = bucketRules
    .filter((rule) => rule.matchType === "category")
    .map((rule) => ({
      budgetId: rule.budgetId!,
      value: rule.matchValue.toUpperCase(),
    }));

  const { bucketCategories, catchAllBudgetId } = bucketCategoryRules(budgets);

  return {
    amountRules,
    merchantRules,
    categoryRules,
    bucketCategories,
    catchAllBudgetId,
    earningBudgetIds: budgets
      .filter((budget) => budget.budgetKind === "earning")
      .map((budget) => budget.id),
    loanRules,
  };
}

/**
 * Is this row a movement of a liability's balance rather than real income?
 *
 * Plaid records a credit card payment as a NEGATIVE amount on the card account,
 * because paying a card reduces the balance owed. Read naively that looks
 * exactly like a deposit, which is how "CAPITAL ONE MOBILE PYMT -487.14" ended
 * up counted as earnings.
 *
 * The account type is what disambiguates it: money arriving at a depository,
 * investment or other *asset* account is income; money arriving at a credit or
 * loan account is a payment against a debt, which is neither income nor
 * spending.
 */
export function isBalanceMovement(row: {
  amount: number;
  accountType: string;
}): boolean {
  if (row.amount >= 0) return false;
  return row.accountType === "credit" || row.accountType === "loan";
}

/** Money arriving at an asset account. The opposite of the above. */
function isDeposit(row: { amount?: number; accountType?: string }): boolean {
  if (row.amount === undefined) return false;
  if (row.amount >= 0) return false;
  if (row.accountType === undefined) return true;
  return row.accountType !== "credit" && row.accountType !== "loan";
}

/** Decide which bucket a transaction belongs in, or null to leave it alone. */
export function resolveBucket(
  row: {
    merchantName: string | null;
    name: string | null;
    categoryOverride: string | null;
    plaidCategoryPrimary: string | null;
    plaidCategoryDetailed: string | null;
    /** Plaid sign: positive for money out. Amount rules compare the magnitude. */
    amount?: number;
    /**
     * Needed to tell a real deposit from a card payment. Optional so the pure
     * matcher stays usable without it, at the cost of the account-type check.
     */
    accountType?: string;
  },
  rules: RuleSet,
): number | null {
  /*
   * Exact-amount rules come first, ahead of the income short-circuit below.
   * An exact figure is the most specific statement a user can make about a
   * transaction, so it outranks both a merchant heuristic and Plaid's guess that
   * the money was income.
   */
  if (row.amount !== undefined) {
    const magnitude = Math.abs(row.amount);
    for (const rule of rules.amountRules) {
      if (Math.abs(rule.value - magnitude) < 0.005) {
        return rule.budgetId;
      }
    }
  }

  const candidates = categoryCandidates(row);
  const isIncome = candidates.some(isEarningCategory);

  /*
   * A deposit is income even when Plaid does not call it income.
   *
   * Category keywords alone miss most real deposits: Plaid files a payment from
   * an employer as TRANSFER_IN, not PAYROLL, so a payroll deposit would land in
   * a spending bucket and never appear under earnings at all.
   *
   * Scoped to asset accounts on purpose. Plaid's sign convention is positive for
   * money out, so negative is an inflow - but on a credit or loan account an
   * inflow is a payment reducing a balance, not earnings. See
   * isBalanceMovement.
   */
  const deposited = row.amount !== undefined && isDeposit(row);

  // Income goes to an earnings bucket and never to a spending one.
  if (isIncome || deposited) {
    return rules.earningBudgetIds[0] ?? null;
  }

  // 1. Merchant rules, matched against the merchant and the raw description so
  //    a rule still catches a transaction whose merchant_name is null. Merchant
  //    rules stay above everything because they are the most explicit intent
  //    the user can express.
  const haystack = `${row.merchantName ?? ""} ${row.name ?? ""}`.toLowerCase();
  if (haystack.trim().length > 0) {
    for (const rule of rules.merchantRules) {
      if (rule.value.length > 0 && haystack.includes(rule.value)) {
        return rule.budgetId;
      }
    }
  }

  /*
   * A category override is the user's own decision, so it is AUTHORITATIVE.
   *
   * Only the override is matched when one exists. Plaid's own categories are
   * deliberately not consulted: otherwise a bucket whose category happens to match
   * Plaid's value can claim the transaction before the override is ever reached,
   * because buckets are evaluated in display order. That made re-categorising a
   * McDonald's charge to TRANSPORTATION leave it sitting in the Food & Drink
   * bucket.
   *
   * If no bucket matches the override the transaction falls to the catch-all,
   * which surfaces it as unbucketed rather than quietly misfiled.
   */
  if (row.categoryOverride) {
    const overridden = [row.categoryOverride.trim().toUpperCase()];

    for (const rule of rules.categoryRules) {
      if (matchesAny(overridden, rule.value)) return rule.budgetId;
    }
    for (const bucket of rules.bucketCategories) {
      const matched = matchesAny(overridden, bucket.value);
      if (matched) return bucket.budgetId;
    }

    return rules.catchAllBudgetId;
  }

  // 2. Explicit category rules, then 3. each bucket's own category.
  for (const rule of rules.categoryRules) {
    if (matchesAny(candidates, rule.value)) return rule.budgetId;
  }
  for (const bucket of rules.bucketCategories) {
    if (matchesAny(candidates, bucket.value)) return bucket.budgetId;
  }

  // 4. Leftover spending.
  return rules.catchAllBudgetId;
}

/**
 * Category match with prefix semantics.
 *
 * Exact match, or either side is a prefix of the other on an underscore
 * boundary, so `FOOD_AND_DRINK` absorbs `FOOD_AND_DRINK_GROCERIES` and vice
 * versa. Deliberately not a bare `startsWith`: `FOOD` must not match
 * `FOOD_AND_DRINK`.
 */
function matchesAny(candidates: string[], value: string): boolean {
  if (!value) return false;
  return candidates.some((candidate) => {
    if (candidate === value) return true;
    return (
      candidate.startsWith(`${value}_`) || value.startsWith(`${candidate}_`)
    );
  });
}

/**
 * Assign every unassigned transaction to a bucket.
 *
 * Called after a transaction sync and from the manual "Apply rules" action. Safe
 * to run repeatedly: it only ever fills in null assignments.
 */
export async function applyBudgetRules(userId: string): Promise<AssignmentResult> {
  const rules = await loadRuleSet(userId);

  // Nothing to route into, so don't churn rows.
  if (
    rules.merchantRules.length === 0 &&
    rules.categoryRules.length === 0 &&
    rules.bucketCategories.length === 0 &&
    rules.catchAllBudgetId === null &&
    rules.earningBudgetIds.length === 0
  ) {
    return { scanned: 0, assigned: 0, byBucket: {} };
  }

  const accountIds = await userAccountIds(userId);
  if (accountIds.length === 0) {
    return { scanned: 0, assigned: 0, byBucket: {} };
  }

  const pending = await db.query.transactions.findMany({
    where: and(
      inArray(tables.transactions.accountId, accountIds),
      isNull(tables.transactions.budgetId),
      eq(tables.transactions.pending, false),
      // Excluded rows are neither income nor spending. Leave them alone even if
      // their budgetId is cleared, or they would drift back into a bucket.
      eq(tables.transactions.excluded, false),
    ),
    columns: {
      id: true,
      plaidTransactionId: true,
      merchantName: true,
      name: true,
      categoryOverride: true,
      plaidCategoryPrimary: true,
      plaidCategoryDetailed: true,
      amount: true,
      accountId: true,
    },
  });

  const accountTypes = await accountTypeMap(accountIds);

  if (pending.length === 0) {
    return { scanned: 0, assigned: 0, byBucket: {} };
  }

  const updates: { id: number; budgetId: number }[] = [];
  const byBucket: Record<string, number> = {};

  const exclusions: number[] = [];
  let excludedCount = 0;

  for (const row of pending) {
    const amount = toNumber(row.amount);
    const accountType = accountTypes.get(String(row.accountId)) ?? "other";

    // A card payment reduces a balance; it is neither income nor spending, so it
    // is recorded as excluded rather than given a bucket that would distort one.
    if (isBalanceMovement({ amount, accountType })) {
      exclusions.push(row.id);
      continue;
    }

    const budgetId = resolveBucket({ ...row, amount, accountType }, rules);
    if (budgetId === null) continue;
    updates.push({ id: row.id, budgetId });
    byBucket[String(budgetId)] = (byBucket[String(budgetId)] ?? 0) + 1;
  }

  if (exclusions.length > 0) {
    await db
      .update(tables.transactions)
      .set({ excluded: true, updatedAt: new Date() })
      .where(inArray(tables.transactions.id, exclusions));
    excludedCount = exclusions.length;
  }

  if (updates.length === 0) {
    return { scanned: pending.length, assigned: 0, byBucket: {} };
  }

  // One UPDATE ... FROM (VALUES ...) rather than N round trips.
  await db.execute(sql`
    update transactions t
    set budget_id = v.budget_id, updated_at = now()
    from (values ${sql.join(
      updates.map(
        (u) => sql`(${u.id}::integer, ${u.budgetId}::integer)`,
      ),
      sql`, `,
    )}) as v(id, budget_id)
    where t.id = v.id
  `);

  return {
    scanned: pending.length,
    assigned: updates.length,
    excluded: excludedCount,
    byBucket,
  };
}

/**
 * Per-bucket month-to-date actuals, derived from assignments.
 *
 * Sign-aware, which matters a lot in practice. Plaid is positive for money out
 * and negative for money in, so:
 *
 *  - a spending bucket sums only OUTGOING amounts (`amount > 0`). Summing
 *    `abs(amount)` instead would double-count any category holding both
 *    directions - one real case in this dataset: a TRAVEL category whose
 *    transactions net to $500 but whose absolute values total $24,500.
 *  - an earnings bucket sums the absolute value of INCOMING amounts
 *    (`amount < 0`), so income reads as a positive figure.
 */
export async function getActualsByBucket(
  userId: string,
  from: string,
  to: string,
): Promise<Map<number, number>> {
  const actuals = new Map<number, number>();
  const accountIds = await userAccountIds(userId);
  if (accountIds.length === 0) return actuals;

  const buckets = await db.query.budgets.findMany({
    where: eq(tables.budgets.userId, userId),
    columns: { id: true, budgetKind: true },
  });
  if (buckets.length === 0) return actuals;

  const spendingIds = buckets
    .filter((b) => b.budgetKind !== "earning")
    .map((b) => b.id);
  const earningIds = buckets
    .filter((b) => b.budgetKind === "earning")
    .map((b) => b.id);

  // Two aggregates rather than one, because the sign filter differs by kind.
  const readSide = async (ids: number[], incoming: boolean) => {
    if (ids.length === 0) return;
    const rows = await db.execute<{ budget_id: number; total: string }>(sql`
      select budget_id, coalesce(sum(abs(amount)), 0)::text as total
      from transactions
      where account_id in ${accountIds}
        and budget_id in ${ids}
        and date >= ${from}
        and date <= ${to}
        and pending = false
        -- Ignored rows keep their bucket for context but must not inflate it.
        and excluded = false
        and amount ${incoming ? sql`< 0` : sql`> 0`}
      group by budget_id
    `);
    for (const row of rows) {
      actuals.set(
        Number(row.budget_id),
        (actuals.get(Number(row.budget_id)) ?? 0) + toNumber(row.total),
      );
    }
  };

  await readSide(spendingIds, false);
  await readSide(earningIds, true);

  return actuals;
}

/**
 * The one definition of "spending that still needs a bucket".
 *
 * Three separate places used to answer this question and each filtered
 * differently, so the numbers could not all be right:
 *
 *   - getUnassignedTransactions filtered `amount > 0` but NOT `excluded`, so it
 *     listed rows the engine had deliberately ignored.
 *   - applyBudgetRules filtered `excluded = false`, so "Assign unassigned"
 *     structurally could not touch anything that page displayed.
 *   - countUnassigned filtered neither, so the badge counted rows neither of the
 *     other two could see.
 *
 * The visible symptom was thirteen DISCOVER card payments sitting in the queue
 * with an Assign control that did nothing: they are `excluded = true` (correct -
 * paying a card is not spending), so the engine skipped them, and pressing assign
 * appeared broken because no amount of pressing could have worked.
 *
 * `excluded = false` is the important clause and it is not cosmetic. Excluded
 * means the user has already answered "this is not spending" by ignoring it, so
 * re-surfacing it as an open question contradicts a decision they made.
 *
 * Interchangeable with the raw-SQL callers: `and(...)` returns a SQL fragment, so
 * `sql`where ${unassignedSpend(ids)}`` embeds the same predicates.
 */
export function unassignedSpend(accountIds: number[]) {
  return and(
    inArray(tables.transactions.accountId, accountIds),
    isNull(tables.transactions.budgetId),
    eq(tables.transactions.pending, false),
    /*
     * Not a display filter. An ignored row is neither income nor spending, so
     * including it here would put it back in the queue with no way to clear it
     * from the queue itself.
     */
    eq(tables.transactions.excluded, false),
    // numeric column, so the bound is a string; Postgres casts for the compare.
    gt(tables.transactions.amount, "0"),
  );
}

/**
 * Account type per accountId.
 *
 * Its own query because the schema declares no Drizzle relations for the
 * relational `with` join.
 */
async function accountTypeMap(accountIds: number[]): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  return new Map(
    (
      await db.query.accounts.findMany({
        where: inArray(tables.accounts.id, accountIds),
        columns: { id: true, type: true },
      })
    ).map((account) => [String(account.id), account.type]),
  );
}

/**
 * Where each transaction WOULD go, without writing anything.
 *
 * The unassigned queue used to make the user guess: the only way to find out where
 * a transaction belonged was to assign it and see. That is a bad way to learn
 * whether your rules are right, because a wrong guess becomes a manual assignment
 * - which applyBudgetRules will then never revisit, since it only ever touches
 * rows with no bucket. One misfiled row and the engine stops being the answer.
 *
 * So this runs the exact same pure matcher the engine runs, over rows that are
 * still unassigned, and reports what it would decide. Same `resolveBucket`, same
 * RuleSet, same precedence - so the preview cannot disagree with what a later
 * "Assign unassigned" would do. It only ever reads.
 *
 * A missing entry means resolveBucket returned null: nothing would claim this
 * row, which is worth showing as "no match" rather than hiding.
 */
export async function suggestBucketAssignments(
  userId: string,
  rows: {
    id: number;
    merchantName: string | null;
    name: string | null;
    categoryOverride: string | null;
    plaidCategoryPrimary: string | null;
    plaidCategoryDetailed: string | null;
    amount: number;
    accountId: number;
  }[],
): Promise<Map<number, number>> {
  const suggestions = new Map<number, number>();
  if (rows.length === 0) return suggestions;

  const [rules, accountIds] = await Promise.all([
    loadRuleSet(userId),
    userAccountIds(userId),
  ]);
  const accountTypes = await accountTypeMap(accountIds);

  for (const row of rows) {
    const budgetId = resolveBucket(
      {
        merchantName: row.merchantName,
        name: row.name,
        categoryOverride: row.categoryOverride,
        plaidCategoryPrimary: row.plaidCategoryPrimary,
        plaidCategoryDetailed: row.plaidCategoryDetailed,
        amount: row.amount,
        accountType: accountTypes.get(String(row.accountId)) ?? "other",
      },
      rules,
    );
    if (budgetId !== null) suggestions.set(row.id, budgetId);
  }

  return suggestions;
}

/** Count of transactions still waiting for a bucket, for the UI. */
export async function countUnassigned(userId: string): Promise<number> {
  const accountIds = await userAccountIds(userId);
  if (accountIds.length === 0) return 0;

  // Same predicate as the queue page, so the badge cannot outnumber the list.
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from transactions
    where ${unassignedSpend(accountIds)}
  `);
  return row?.n ?? 0;
}

async function userAccountIds(userId: string): Promise<number[]> {
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  if (items.length === 0) return [];

  const accounts = await db.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((i) => i.id),
    ),
    columns: { id: true },
  });
  return accounts.map((a) => a.id);
}
