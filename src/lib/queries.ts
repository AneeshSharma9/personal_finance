import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { cache } from "react";

import { db, tables, toNumber } from "@/db";
import { isCatchAll } from "@/lib/categories";
import {
  getActualsByBucket,
  suggestBucketAssignments,
  unassignedSpend,
} from "@/lib/budget-engine";
import {
  WORKSHEET_NUMBER_FIELDS,
  type WorksheetInput,
} from "@/lib/budget-worksheet";
import { loanBalanceSeries } from "@/lib/loan-math";
import type { SeriesPoint } from "@/lib/series";

/**
 * Read-side queries.
 *
 * Every function here takes a `userId` and scopes through it. That is the
 * primary security control: the app has one user, but the scoping means a bug
 * in a caller can't leak another user's rows.
 *
 * These render in Server Components, so they return plain data - never a
 * database client or an access token.
 */

/** Ids of every Plaid Item belonging to a user. */
export const getItemIds = cache(async (userId: string): Promise<number[]> => {
  const rows = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
});

/** Ids of every account belonging to a user, optionally filtered by type. */
export const getAccountIds = cache(
  async (userId: string): Promise<number[]> => {
    const itemIds = await getItemIds(userId);
    if (itemIds.length === 0) return [];

    const rows = await db.query.accounts.findMany({
      where: inArray(tables.accounts.itemId, itemIds),
      columns: { id: true },
    });
    return rows.map((r) => r.id);
  },
);

export type AccountWithItem = tables.Account & {
  institutionName: string | null;
};

/** All accounts with balances, grouped-ready for the accounts page. */
export async function getAccounts(userId: string): Promise<AccountWithItem[]> {
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true, institutionName: true },
  });
  if (items.length === 0) return [];

  const institutionByItemId = new Map(
    items.map((i) => [i.id, i.institutionName]),
  );

  const rows = await db.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((i) => i.id),
    ),
    orderBy: [
      asc(tables.accounts.type),
      asc(tables.accounts.name),
      asc(tables.accounts.id),
    ],
  });

  return rows.map((row) => ({
    ...row,
    institutionName: institutionByItemId.get(row.itemId) ?? null,
  }));
}

/** Items with their sync health, for the accounts page and the dashboard. */
export async function getItems(userId: string): Promise<tables.Item[]> {
  return db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    orderBy: (i, { asc }) => [asc(i.createdAt)],
  });
}

export type TransactionFilters = {
  from?: string;
  to?: string;
  accountId?: number;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  includePending?: boolean;
};

export type TransactionRow = {
  id: number;
  date: string;
  authorizedDate: string | null;
  /** Plaid sign: positive for money out. */
  amount: number;
  /** Same number from the perspective of your balance: negative for spending. */
  signedAmount: number;
  merchantName: string | null;
  name: string | null;
  displayCategory: string;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  pending: boolean;
  excluded: boolean;
  notes: string | null;
  website: string | null;
  logoUrl: string | null;
  isoCurrencyCode: string | null;
  accountName: string;
  budgetId: number | null;
  budgetName: string | null;
  /** Set when this transaction is tagged as a loan payment. */
  loanId: number | null;
};

export async function getTransactions(
  userId: string,
  filters: TransactionFilters = {},
): Promise<{ rows: TransactionRow[]; total: number }> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return { rows: [], total: 0 };

  const conditions = [inArray(tables.transactions.accountId, accountIds)];

  if (filters.accountId) {
    // Re-check ownership so a crafted accountId cannot widen the scope.
    if (!accountIds.includes(filters.accountId)) {
      return { rows: [], total: 0 };
    }
    conditions.push(eq(tables.transactions.accountId, filters.accountId));
  }
  if (filters.from) {
    conditions.push(gte(tables.transactions.date, filters.from));
  }
  if (filters.to) {
    conditions.push(lte(tables.transactions.date, filters.to));
  }
  if (filters.category) {
    conditions.push(
      sql`coalesce(${tables.transactions.categoryOverride}, ${tables.transactions.plaidCategoryPrimary}) = ${filters.category}`,
    );
  }
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      sql`(${tables.transactions.merchantName} ilike ${pattern} or ${tables.transactions.name} ilike ${pattern})`,
    );
  }
  if (!filters.includePending) {
    conditions.push(eq(tables.transactions.pending, false));
  }

  const where = and(...conditions);

  const [txns, accounts, tagged, [{ count }], budgets] = await Promise.all([
    db.query.transactions.findMany({
      where,
      orderBy: [
        desc(tables.transactions.date),
        desc(tables.transactions.id),
      ],
      limit: filters.limit ?? 100,
      offset: filters.offset ?? 0,
    }),
    db.query.accounts.findMany({
      where: inArray(tables.accounts.id, accountIds),
      columns: { id: true, name: true },
    }),
    // Which of these transactions are tagged as loan payments. One query for the
    // page rather than a lookup per row, joined back to transactions so it is
    // scoped to this user's accounts rather than the whole table.
    db
      .select({
        transactionId: tables.loanPayments.transactionId,
        loanId: tables.loanPayments.loanId,
      })
      .from(tables.loanPayments)
      .innerJoin(
        tables.transactions,
        eq(tables.transactions.id, tables.loanPayments.transactionId),
      )
      .where(inArray(tables.transactions.accountId, accountIds)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.transactions)
      .where(where),
    db.query.budgets.findMany({
      where: eq(tables.budgets.userId, userId),
      columns: { id: true, name: true },
    }),
  ]);

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
  const budgetNameById = new Map(budgets.map((b) => [b.id, b.name]));
  const loanByTransaction = new Map(
    tagged.map((row) => [row.transactionId, row.loanId]),
  );

  return {
    rows: txns.map((t) => {
      const amount = toNumber(t.amount);
      return {
        id: t.id,
        date: t.date,
        authorizedDate: t.authorizedDate,
        amount,
        // Plaid stores positive for money out, so negate for display.
        signedAmount: -amount,
        merchantName: t.merchantName,
        name: t.name,
        displayCategory: t.categoryOverride ?? t.plaidCategoryPrimary ?? "Uncategorized",
        categoryOverride: t.categoryOverride,
        plaidCategoryPrimary: t.plaidCategoryPrimary,
        plaidCategoryDetailed: t.plaidCategoryDetailed,
        pending: t.pending,
        excluded: t.excluded,
        notes: t.notes,
        website: t.website,
        logoUrl: t.logoUrl,
        isoCurrencyCode: t.isoCurrencyCode,
        accountName: accountNameById.get(t.accountId) ?? "Unknown account",
        budgetId: t.budgetId,
        budgetName:
          t.budgetId === null ? null : (budgetNameById.get(t.budgetId) ?? null),
        loanId: loanByTransaction.get(t.id) ?? null,
      };
    }),
    total: count,
  };
}

/** Distinct categories in use, for filter dropdowns. */
export async function getCategories(userId: string): Promise<string[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return [];

  const rows = await db
    .selectDistinct({
      category: sql<string>`coalesce(${tables.transactions.categoryOverride}, ${tables.transactions.plaidCategoryPrimary})`,
    })
    .from(tables.transactions)
    .where(inArray(tables.transactions.accountId, accountIds))
    .orderBy(sql`1`);

  return rows
    .map((r) => r.category)
    .filter((c): c is string => Boolean(c) && c !== "Uncategorized");
}

export type CategorySpend = {
  category: string;
  /** Total spent, as a positive number. */
  total: number;
  count: number;
};

/**
 * Spend by category over a date range.
 *
 * Only positive Plaid amounts count as spending: negative amounts are money
 * coming in (refunds, paycheques) and would otherwise cancel out a category's
 * total.
 */
export async function getSpendByCategory(
  userId: string,
  from: string,
  to: string,
): Promise<CategorySpend[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return [];

  const rows = await db
    .select({
      category: sql<string>`coalesce(${tables.transactions.categoryOverride}, ${tables.transactions.plaidCategoryPrimary}, 'Uncategorized')`,
      total: sql<string>`coalesce(sum(${tables.transactions.amount}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(tables.transactions)
    .where(
      and(
        inArray(tables.transactions.accountId, accountIds),
        gte(tables.transactions.date, from),
        lte(tables.transactions.date, to),
        eq(tables.transactions.pending, false),
        sql`${tables.transactions.amount} > 0`,
      ),
    )
    .groupBy(
      sql`coalesce(${tables.transactions.categoryOverride}, ${tables.transactions.plaidCategoryPrimary}, 'Uncategorized')`,
    )
    .orderBy(desc(sql`sum(${tables.transactions.amount})`));

  return rows.map((r) => ({
    category: r.category,
    total: toNumber(r.total),
    count: r.count,
  }));
}

/**
 * Budget rows for the page, in the two-group layout the UI renders.
 *
 * Actuals come from `transactions.budget_id` assignments, not from re-deriving
 * a category match here. Assignments are produced by lib/budget-engine.ts, which
 * also honours merchant rules and manual per-transaction choices - so the
 * number shown is always the one the engine agreed on, and the page and the
 * transactions list can never disagree.
 */
export async function getBudgetsWithActuals(
  userId: string,
  from: string,
  to: string,
): Promise<BudgetGroups> {
  const [budgets, actualsByBucket] = await Promise.all([
    db.query.budgets.findMany({
      where: eq(tables.budgets.userId, userId),
      orderBy: [
        asc(tables.budgets.budgetKind),
        asc(tables.budgets.sortOrder),
        asc(tables.budgets.name),
      ],
    }),
    getActualsByBucket(userId, from, to),
  ]);

  const groups: BudgetGroups = {
    basic: [],
    category: [],
    earning: [],
  };

  for (const budget of budgets) {
    const budgeted = toNumber(budget.monthlyLimit);
    const actual = actualsByBucket.get(budget.id) ?? 0;

    groups[budget.budgetKind].push({
      id: budget.id,
      kind: budget.budgetKind,
      name: budget.name,
      categories: budget.categories,
      budgeted,
      actual,
      remaining: budgeted - actual,
      percentUsed: budgeted > 0 ? (actual / budgeted) * 100 : null,
      isCatchAll:
        budget.budgetKind !== "earning" &&
        budget.categories.length === 0 &&
        isCatchAll(budget.name),
    });
  }

  for (const rows of Object.values(groups)) {
    sortBudgetRows(rows);
  }

  return groups;
}

/**
 * Display order for a budget group: the remainder bucket last, then biggest first.
 *
 * The remainder bucket is pinned rather than sorted, because its whole purpose is
 * to be what is left over. Sorting it by size would put a $30 "Everything Else"
 * between Rent and Insurance and read as though it were a peer of them - it is the
 * one row on the page whose size is an output rather than a decision.
 *
 * The rest sort by budgeted amount descending, so the rows you decided about are
 * at the top and the small ones you set once and forgot are at the bottom. Ordering
 * used to come from `sortOrder`, which is a manual arrangement made at creation
 * time and never revisited - fine when a bucket's figure changed, wrong once it did.
 *
 * Ties break on name rather than leaving insertion order to decide, so the page
 * cannot reshuffle between two renders that mean the same thing.
 *
 * This is display order only. Which bucket wins a category both have claimed is
 * still `sortOrder`, in `loadRuleSet`, and is deliberately not changed here: that is
 * a routing decision, not a presentation one, and following the display order would
 * silently re-route transactions.
 */
export function sortBudgetRows(rows: BudgetRowResult[]): BudgetRowResult[] {
  return rows.sort((a, b) => {
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
    if (a.budgeted !== b.budgeted) return b.budgeted - a.budgeted;
    return a.name.localeCompare(b.name);
  });
}

export type BudgetRowResult = {
  id: number;
  kind: tables.BudgetKind;
  name: string;
  /** Plaid categories this bucket claims. Empty means display-only. */
  categories: string[];
  budgeted: number;
  actual: number;
  remaining: number;
  percentUsed: number | null;
  /** True for the "Everything Else" remainder bucket. */
  isCatchAll: boolean;
};

export type BudgetGroups = Record<tables.BudgetKind, BudgetRowResult[]>;

export type SpendSummary = {
  /** Transactions with no budget bucket yet. */
  unassigned: number;
  /** Money sitting in unassigned transactions, for the prompt to fix it. */
  unassignedTotal: number;
};

/**
 * How much of the month's spending is not yet in a bucket.
 *
 * Surfaced in the UI so a large unassigned total is visible rather than silently
 * making every Actual look low.
 */
export async function getSpendSummary(
  userId: string,
  from: string,
  to: string,
): Promise<SpendSummary> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) {
    return { unassigned: 0, unassignedTotal: 0 };
  }

  const [row] = await db.execute<{ n: number; total: string }>(sql`
    select count(*)::int as n,
           coalesce(sum(amount), 0)::text as total
    from transactions
    where ${unassignedSpend(accountIds)}
      and date >= ${from}
      and date <= ${to}
  `);

  return {
    unassigned: row?.n ?? 0,
    unassignedTotal: toNumber(row?.total ?? 0),
  };
}

export type UnassignedTransaction = {
  id: number;
  date: string;
  authorizedDate: string | null;
  amount: number;
  signedAmount: number;
  merchantName: string | null;
  name: string | null;
  accountName: string;
  /**
   * What Plaid thinks it is, or the user's own override when they set one.
   * Shown so the routing decision can be made against something rather than a
   * merchant name alone.
   */
  displayCategory: string;
  notes: string | null;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  website: string | null;
  logoUrl: string | null;
  isoCurrencyCode: string | null;
  /**
   * The bucket the engine would file this in, or null when nothing would claim
   * it. Purely a preview - computed with the same matcher applyBudgetRules uses,
   * and never written.
   */
  suggestedBudgetId: number | null;
};

/**
 * The month's spending that is not in a bucket yet, newest first.
 *
 * The predicates are deliberately identical to getSpendSummary's, because the
 * count on the budgets page links here and the two must not disagree: a link
 * that says "14 unassigned" and lists 40 is worse than no link.
 *
 * `amount > 0` and `excluded = false` are not display choices. Money in is routed
 * to an earnings bucket automatically, and a user who has ignored a row has
 * already decided it is not spending. Both are expressed once, in
 * `unassignedSpend`, and shared with the engine and the badge so this list, the
 * "Assign unassigned" button and the count cannot disagree about what is left.
 */
export async function getUnassignedTransactions(
  userId: string,
  from: string,
  to: string,
): Promise<UnassignedTransaction[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return [];

  const rows = await db.query.transactions.findMany({
    where: and(
      unassignedSpend(accountIds),
      gte(tables.transactions.date, from),
      lte(tables.transactions.date, to),
    ),
    orderBy: (t, { desc }) => [desc(t.date), desc(t.id)],
    limit: 500,
    columns: {
      id: true,
      date: true,
      authorizedDate: true,
      amount: true,
      merchantName: true,
      name: true,
      accountId: true,
      categoryOverride: true,
      plaidCategoryPrimary: true,
      // resolveBucket matches on the detailed category too, so the preview has to
      // carry it or it would suggest a different bucket than the engine picks.
      plaidCategoryDetailed: true,
      website: true,
      logoUrl: true,
      isoCurrencyCode: true,
      notes: true,
    },
  });

  const detailAccountIds = [...new Set(rows.map((row) => row.accountId))];
  const accountNameById =
    detailAccountIds.length === 0
      ? new Map<number, string>()
      : new Map(
          (
            await db.query.accounts.findMany({
              where: inArray(tables.accounts.id, detailAccountIds),
              columns: { id: true, name: true },
            })
          ).map((account) => [account.id, account.name]),
        );

  const suggestions = await suggestBucketAssignments(
    userId,
    rows.map((row) => ({
      id: row.id,
      merchantName: row.merchantName,
      name: row.name,
      categoryOverride: row.categoryOverride,
      plaidCategoryPrimary: row.plaidCategoryPrimary,
      plaidCategoryDetailed: row.plaidCategoryDetailed,
      amount: toNumber(row.amount),
      accountId: row.accountId,
    })),
  );

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    authorizedDate: row.authorizedDate,
    amount: toNumber(row.amount),
    signedAmount: -toNumber(row.amount),
    merchantName: row.merchantName,
    name: row.name,
    accountName: accountNameById.get(row.accountId) ?? "Unknown account",
    displayCategory:
      row.categoryOverride ??
      row.plaidCategoryPrimary ??
      "Uncategorized",
    notes: row.notes,
    categoryOverride: row.categoryOverride,
    plaidCategoryPrimary: row.plaidCategoryPrimary,
    plaidCategoryDetailed: row.plaidCategoryDetailed,
    website: row.website,
    logoUrl: row.logoUrl,
    isoCurrencyCode: row.isoCurrencyCode,
    suggestedBudgetId: suggestions.get(row.id) ?? null,
  }));
}

export type BudgetSummaryTotals = {
  /** Total budgeted across both spending groups. */
  budgeted: number;
  /** Money out of those buckets this month. */
  spent: number;
  /** Money in assigned to earnings buckets this month. */
  income: number;
  /** budgeted - spent. Negative means over budget. */
  remaining: number;
  /** Fraction of the budget consumed as a percentage; can exceed 100. */
  percentUsed: number;
};

/**
 * Headline numbers for the summary card.
 *
 * Sourced from the same assignments as the per-bucket actuals, so the summary
 * can never disagree with the rows underneath it. "Leftover" is
 * `budgeted - spent`, which is what the ring visualises.
 */
export async function getBudgetSummary(
  userId: string,
  from: string,
  to: string,
): Promise<BudgetSummaryTotals> {
  const buckets = await db.query.budgets.findMany({
    where: eq(tables.budgets.userId, userId),
    columns: { id: true, budgetKind: true, monthlyLimit: true },
    orderBy: [asc(tables.budgets.id)],
  });

  if (buckets.length === 0) {
    return {
      budgeted: 0,
      spent: 0,
      income: 0,
      remaining: 0,
      percentUsed: 0,
    };
  }

  const actuals = await getActualsByBucket(userId, from, to);

  let budgeted = 0;
  let spent = 0;
  let income = 0;

  for (const bucket of buckets) {
    const actual = actuals.get(bucket.id) ?? 0;
    if (bucket.budgetKind === "earning") {
      income += actual;
      continue;
    }
    budgeted += toNumber(bucket.monthlyLimit);
    spent += actual;
  }

  return {
    budgeted,
    spent,
    income,
    remaining: budgeted - spent,
    percentUsed: budgeted > 0 ? (spent / budgeted) * 100 : 0,
  };
}

export type MonthPoint = {
  year: number;
  /** 1-12, to match a URL's ?month= parameter. */
  month: number;
  spent: number;
  income: number;
};

/**
 * Spending and income per month, for the month strip.
 *
 * `months` takes 1-based months, matching {@link MonthPoint}. Keep that
 * contract consistent: this previously added +1 to an already-1-based month and
 * silently labelled every bar one month late.
 *
 * Income is counted from transactions assigned to an **earnings bucket**, not
 * from every negative amount. Raw money-in includes transfers between the user's
 * own accounts, which are not income - counting them here would disagree with the
 * summary card and inflate every month that has a transfer.
 *
 * One grouped query for the whole range rather than one per month.
 */
export async function getMonthlySeries(
  userId: string,
  months: { year: number; month: number }[],
): Promise<MonthPoint[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) {
    return months.map((m) => ({ ...m, spent: 0, income: 0 }));
  }

  const earnings = await db.query.budgets.findMany({
    where: and(
      eq(tables.budgets.userId, userId),
      eq(tables.budgets.budgetKind, "earning"),
    ),
    columns: { id: true },
  });
  const earningsIds = earnings.map((b) => b.id);

  const rows = await db.execute<{
    month: string;
    spent: string;
    income: string;
  }>(sql`
    select to_char(date_trunc('month', date), 'YYYY-MM') as month,
           coalesce(sum(amount) filter (where amount > 0), 0)::text as spent,
           coalesce(
             sum(-amount) filter (
               where amount < 0
                 and budget_id in ${earningsIds.length ? earningsIds : [-1]}
             ),
             0
           )::text as income
    from transactions
    where account_id in ${accountIds}
      and pending = false
    group by 1
  `);

  const byMonth = new Map(
    rows.map((row) => [
      row.month,
      { spent: toNumber(row.spent), income: toNumber(row.income) },
    ]),
  );

  return months.map(({ year, month }) => {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const found = byMonth.get(key);
    return {
      year,
      month,
      spent: found?.spent ?? 0,
      income: found?.income ?? 0,
    };
  });
}

/**
 * Years that actually have data, ascending.
 *
 * Drives the year dropdown. Derived from the user's own transactions rather
 * than a hardcoded range, so it starts at whatever year their data begins and
 * never offers a year with nothing in it.
 */
export async function getYearRange(userId: string): Promise<{
  years: number[];
  minYear: number;
  maxYear: number;
}> {
  const accountIds = await getAccountIds(userId);
  const currentYear = new Date().getFullYear();

  if (accountIds.length === 0) {
    return { years: [currentYear], minYear: currentYear, maxYear: currentYear };
  }

  const [row] = await db.execute<{ min_year: number; max_year: number }>(sql`
    select extract(year from min(date))::int as min_year,
           extract(year from max(date))::int as max_year
    from transactions
    where account_id in ${accountIds}
  `);

  // Clamp to the current year: a clock skew or a bad date must not offer a
  // future year, and an empty result must not drop every year.
  const minYear = Math.min(row?.min_year ?? currentYear, currentYear);
  const maxYear = Math.max(row?.max_year ?? currentYear, currentYear);

  const years: number[] = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    years.push(year);
  }

  return { years, minYear, maxYear };
}

/**
 * Transaction count per account, for the removal confirmation dialogs.
 *
 * One grouped query rather than N, because the accounts page renders a count
 * next to every row.
 */
export async function getTransactionCountsByAccount(
  userId: string,
): Promise<Map<number, number>> {
  const accountIds = await getAccountIds(userId);
  const counts = new Map<number, number>();
  if (accountIds.length === 0) return counts;

  const rows = await db.execute<{ account_id: number; n: number }>(sql`
    select account_id, count(*)::int as n
    from transactions
    where account_id in ${accountIds}
    group by account_id
  `);

  for (const row of rows) {
    counts.set(Number(row.account_id), row.n);
  }
  return counts;
}

/**
 * The most recent month that actually contains transactions.
 *
 * The budgets page defaults to this rather than the current calendar month.
 * Plaid's Sandbox returns historical data, so "this month" is routinely empty
 * and every Actual reads 0 - which looks like assignment is broken when it
 * isn't. Defaulting to the newest month with data makes the page meaningful
 * immediately, and the user can still step forward with the month navigation.
 */
export async function getLatestTransactionMonth(
  userId: string,
): Promise<{ year: number; month: number } | null> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return null;

  const [row] = await db.execute<{ latest: string }>(sql`
    select max(date)::text as latest
    from transactions
    where account_id in ${accountIds} and pending = false
  `);

  if (!row?.latest) return null;
  // `date` columns come back as YYYY-MM-DD; parse as UTC to avoid a local
  // timezone shift moving the month.
  const [year, month] = row.latest.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return { year, month: month - 1 };
}

/**
 * The saved worksheet, or null if there isn't one yet.
 *
 * A single row per user, so this is one query and no aggregation. The calc is left
 * to `computeWorksheet` rather than done here, so the page and the API can never
 * report different figures from the same row.
 */
export async function getBudgetWorksheet(
  userId: string,
): Promise<(WorksheetInput & { id: number }) | null> {
  const row = await db.query.budgetWorksheet.findFirst({
    where: eq(tables.budgetWorksheet.userId, userId),
  });

  if (!row) return null;

  return {
    id: row.id,
    deriveGross: row.deriveGross,
    grossSalary: toNumber(row.grossSalary),
    asopRate: toNumber(row.asopRate),
    federalWithholding: toNumber(row.federalWithholding),
    federalMedEe: toNumber(row.federalMedEe),
    federalOasdiEe: toNumber(row.federalOasdiEe),
    stateWithholding: toNumber(row.stateWithholding),
    k401k: toNumber(row.k401k),
    vision: toNumber(row.vision),
    dental: toNumber(row.dental),
    hsa: toNumber(row.hsa),
    medical: toNumber(row.medical),
    rothIra: toNumber(row.rothIra),
    payPeriodsPerMonth: toNumber(row.payPeriodsPerMonth),
    includeRetirementInSavings: row.includeRetirementInSavings,
    rent: toNumber(row.rent),
    utilities: toNumber(row.utilities),
    wifi: toNumber(row.wifi),
    rentersInsurance: toNumber(row.rentersInsurance),
    carPayment: toNumber(row.carPayment),
    carInsurance: toNumber(row.carInsurance),
    gas: toNumber(row.gas),
    groceriesDining: toNumber(row.groceriesDining),
    studentLoans: toNumber(row.studentLoans),
    brokerage: toNumber(row.brokerage),
    hysa: toNumber(row.hysa),
    idealNeeds: toNumber(row.idealNeeds),
    idealSavings: toNumber(row.idealSavings),
    idealWants: toNumber(row.idealWants),
  };
}

/**
 * Create or replace the worksheet.
 *
 * An upsert rather than insert-or-409: this is one standing plan with one owner,
 * and making the client work out whether it is creating or updating is a way to
 * lose someone's numbers on the second save.
 */
export async function saveBudgetWorksheet(
  userId: string,
  input: WorksheetInput,
): Promise<void> {
  /*
   * Keyed by the table's field names, not the SQL column names. Drizzle maps
   * `grossSalary` to `gross_salary` itself; handing it `gross_salary` instead is
   * silently ignored rather than rejected, so half the form saves and half of it
   * quietly becomes zero - and the fields that look identical in both
   * (`k401k`, `rent`, `gas`, `hysa`) are the only ones that appear to work.
   */
  const row = {
    userId,
    deriveGross: input.deriveGross,
    ...Object.fromEntries(
      WORKSHEET_NUMBER_FIELDS.map((field) => [field, String(input[field])]),
    ),
    updatedAt: new Date(),
  };

  await db
    .insert(tables.budgetWorksheet)
    .values(row)
    .onConflictDoUpdate({ target: tables.budgetWorksheet.userId, set: row });
}

export type CashFlowBucket = {
  id: string;
  label: string;
  kind: "income" | "spending";
  /**
   * The budget row behind this node, so the UI can link to it. The string `id` is
   * only ever `"bucket:" + budgetId`, and parsing that back out at the call site
   * would work right up until something else needed an id.
   */
  budgetId: number;
  amount: number;
  /** Budgeted for the same window. Context for the tooltip, never a flow. */
  budgeted: number;
  /**
   * What is inside this bucket, by category, largest first.
   *
   * A bucket is the unit you budget in but a category is what you actually buy,
   * so a single fat node tells you nothing about whether it needs splitting. The
   * user had one bucket, "Everything Else", absorbing every uncategorised thing
   * they bought - and no way to see what was in it, so they were budgeting it by
   * guesswork. This is the same money, cut the other way.
   *
   * Sums to `amount`; absent for a bucket with no transactions behind it.
   */
  breakdown: { category: string; amount: number }[];
};

export type CashFlowData = {
  from: string;
  to: string;
  income: CashFlowBucket[];
  spending: CashFlowBucket[];
  /** Spending with no bucket. Part of `spending`, but reported on its own. */
  unassigned: number;
};

/**
 * Where the money came from and where it went, for the cash flow Sankey.
 *
 * `months` is how many months the window covers, so a budgeted figure can be
 * scaled for year-to-date instead of showing one month of limits beside twelve
 * months of spending.
 *
 * Income is read from **earnings buckets**, exactly as `getMonthlySeries` and
 * the summary card do. Counting every negative amount instead would sweep in
 * transfers between the user's own accounts, so the Sankey would claim income
 * the rest of the app does not, and its totals would not tie to the budgets page.
 * The buckets also decide the shape of the diagram, so the diagram and the rule
 * that fills the buckets have to agree.
 */
/**
 * Every transaction in a bucket, grouped by the category it carries.
 *
 * Uses the user's override when they have set one, falling back to Plaid's
 * primary category and finally the detailed one - the same precedence
 * categoryCandidates applies, so the drill-down splits money the same way the
 * rest of the app classifies it.
 *
 * Rows are summed per (bucket, category) in SQL rather than pulled back and
 * folded here: a YTD window is tens of thousands of rows and this runs on every
 * cash-flow page load.
 */
async function getCategoryBreakdownByBucket(
  userId: string,
  accountIds: number[],
  from: string,
  to: string,
): Promise<Map<number, { category: string; amount: number }[]>> {
  const byBucket = new Map<number, { category: string; amount: number }[]>();
  if (accountIds.length === 0) return byBucket;

  const rows = await db.execute<{
    budget_id: number;
    category: string;
    total: string;
  }>(sql`
    select budget_id,
           coalesce(
             ${tables.transactions.categoryOverride},
             ${tables.transactions.plaidCategoryPrimary},
             ${tables.transactions.plaidCategoryDetailed}
           ) as category,
           coalesce(sum(${tables.transactions.amount}), 0)::text as total
    from ${tables.transactions}
    where ${inArray(tables.transactions.accountId, accountIds)}
      and ${tables.transactions.budgetId} is not null
      and ${tables.transactions.date} >= ${from}
      and ${tables.transactions.date} <= ${to}
      and ${tables.transactions.pending} = false
      and ${tables.transactions.excluded} = false
      and ${tables.transactions.amount} > 0
    group by budget_id, category
    order by sum(${tables.transactions.amount}) desc
  `);

  for (const row of rows) {
    const list = byBucket.get(row.budget_id) ?? [];
    list.push({
      category: row.category ?? "Uncategorized",
      amount: toNumber(row.total),
    });
    byBucket.set(row.budget_id, list);
  }

  return byBucket;
}

export async function getCashFlow(
  userId: string,
  from: string,
  to: string,
  months: number,
): Promise<CashFlowData> {
  const empty: CashFlowData = {
    from,
    to,
    income: [],
    spending: [],
    unassigned: 0,
  };

  const buckets = await db.query.budgets.findMany({
    where: eq(tables.budgets.userId, userId),
    columns: { id: true, name: true, budgetKind: true, monthlyLimit: true },
    orderBy: [asc(tables.budgets.sortOrder), asc(tables.budgets.id)],
  });

  if (buckets.length === 0) return empty;

  const actuals = await getActualsByBucket(userId, from, to);
  const accountIds = await getAccountIds(userId);
  const breakdownByBucket = await getCategoryBreakdownByBucket(
    userId,
    accountIds,
    from,
    to,
  );

  const income: CashFlowBucket[] = [];
  const spending: CashFlowBucket[] = [];

  for (const bucket of buckets) {
    const amount = actuals.get(bucket.id) ?? 0;
    if (amount <= 0) continue;

    const isEarning = bucket.budgetKind === "earning";
    const row: CashFlowBucket = {
      id: `bucket:${bucket.id}`,
      label: bucket.name,
      kind: isEarning ? "income" : "spending",
      budgetId: bucket.id,
      amount,
      // An earnings bucket's limit is a target, not a cost, and spending buckets
      // are the only ones a limit means anything for.
      budgeted: isEarning
        ? 0
        : toNumber(bucket.monthlyLimit) * Math.max(months, 1),
      breakdown: breakdownByBucket.get(bucket.id) ?? [],
    };

    (isEarning ? income : spending).push(row);
  }

  /*
   * Spending nobody has filed yet. Counted rather than dropped: excluding it would
   * let the diagram report a healthy Remaining while real money went somewhere
   * unlabelled, which is the one thing a cash flow view must not do.
   *
   * The same shared predicate the queue and the badge use, so this figure, the
   * "N unassigned" link and the list behind it can never disagree - they were four
   * hand-written filters that had already drifted once.
   */
  let unassigned = 0;
  if (accountIds.length > 0) {
    const [row] = await db.execute<{ total: string }>(sql`
      select coalesce(sum(amount), 0)::text as total
      from transactions
      where ${unassignedSpend(accountIds)}
        and date >= ${from}
        and date <= ${to}
    `);
    unassigned = toNumber(row?.total ?? 0);
  }

  return { from, to, income, spending, unassigned };
}

export type BucketTransaction = {
  id: number;
  plaidTransactionId: string;
  date: string;
  authorizedDate: string | null;
  amount: number;
  merchantName: string | null;
  name: string | null;
  accountName: string;
  displayCategory: string;
  notes: string | null;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  website: string | null;
  logoUrl: string | null;
  isoCurrencyCode: string | null;
  /** Positive for spending; the bucket detail shows this sign as-is. */
  signedAmount: number;
  /**
   * Ignored: still shown in this bucket, greyed out, and excluded from its
   * total. Deliberately not removed, so the row remains visible and can be
   * un-ignored from where it would otherwise have been.
   */
  excluded: boolean;
};

/** One bucket, scoped to its owner. Null when it isn't the user's. */
export async function getBudgetForUser(
  userId: string,
  budgetId: number,
): Promise<tables.Budget | null> {
  const row = await db.query.budgets.findFirst({
    where: and(eq(tables.budgets.id, budgetId), eq(tables.budgets.userId, userId)),
  });
  return row ?? null;
}

/**
 * Transactions filed in one bucket for a date range, largest first.
 *
 * Scoped through the bucket's owner rather than trusting the id, so a guessed
 * bucket id can't list somebody else's transactions.
 */
export async function getTransactionsInBucket(
  userId: string,
  budgetId: number,
  from: string,
  to: string,
): Promise<BucketTransaction[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return [];

  const rows = await db.query.transactions.findMany({
    where: and(
      inArray(tables.transactions.accountId, accountIds),
      eq(tables.transactions.budgetId, budgetId),
      gte(tables.transactions.date, from),
      lte(tables.transactions.date, to),
      eq(tables.transactions.pending, false),
    ),
    orderBy: (t, { desc }) => [desc(t.date), desc(t.id)],
    limit: 500,
  });

  const detailAccountIds = [...new Set(rows.map((row) => row.accountId))];
  const accountNameById =
    detailAccountIds.length === 0
      ? new Map<number, string>()
      : new Map(
          (
            await db.query.accounts.findMany({
              where: inArray(tables.accounts.id, detailAccountIds),
              columns: { id: true, name: true },
            })
          ).map((account) => [account.id, account.name]),
        );

  return rows.map((row) => {
    const amount = toNumber(row.amount);
    return {
      id: row.id,
      plaidTransactionId: row.plaidTransactionId,
      date: row.date,
      authorizedDate: row.authorizedDate,
      amount,
      signedAmount: -amount,
      merchantName: row.merchantName,
      name: row.name,
      accountName: accountNameById.get(row.accountId) ?? "Unknown account",
      displayCategory:
        row.categoryOverride ?? row.plaidCategoryPrimary ?? "Uncategorized",
      notes: row.notes,
      categoryOverride: row.categoryOverride,
      plaidCategoryPrimary: row.plaidCategoryPrimary,
      plaidCategoryDetailed: row.plaidCategoryDetailed,
      website: row.website,
      logoUrl: row.logoUrl,
      isoCurrencyCode: row.isoCurrencyCode,
      // Kept in the bucket but not counted towards its total.
      excluded: row.excluded,
    };
  });
}

/**
 * Category values the user actually has transactions for in a date range.
 *
 * Feeds the budget row's category picker. Derived from real data rather than a
 * frozen Plaid list because the PFC taxonomy moved to v2 for Items created after
 * 2025-12-03, so any hardcoded set would go stale.
 */
/**
 * Categories a new bucket can be created from.
 *
 * Two things this deliberately is not:
 *
 *  - Not windowed by month. The previous query took `from`/`to`, which meant the
 *    list changed as you moved the month strip, so a bucket set up for March
 *    could not be added again in April.
 *  - Not limited to categories already in the transactions. Offering only what
 *    exists meant a bucket for a category with no spending yet could be deleted
 *    and never re-created, because the category vanished from the list with it.
 *
 * So this is the union of the user's own categories across all history and the
 * canonical set in categories.ts. Stable, and always enough to rebuild a bucket.
 */
export async function getCategoryOptions(userId: string): Promise<string[]> {
  const accountIds = await getAccountIds(userId);

  const seen = new Set<string>();

  if (accountIds.length > 0) {
    const rows = await db.execute<{ category: string }>(sql`
      select distinct coalesce(
        ${tables.transactions.categoryOverride},
        ${tables.transactions.plaidCategoryDetailed},
        ${tables.transactions.plaidCategoryPrimary}
      ) as category
      from transactions
      where ${inArray(tables.transactions.accountId, accountIds)}
        and coalesce(
          ${tables.transactions.categoryOverride},
          ${tables.transactions.plaidCategoryDetailed},
          ${tables.transactions.plaidCategoryPrimary}
        ) is not null
    `);
    for (const row of rows) seen.add(row.category);
  }

  /*
   * Only what the user has actually spent in, and nothing else.
   *
   * There used to be a seeded template list merged in here. It offered category
   * values nobody had transacted in - LOAN_PAYMENTS and SAVINGS among them - and
   * every bucket created from one was a bucket with no real boundary, which is
   * how "Loan Payments Car Payment" and "Savings & Debt" ended up competing for
   * the same transactions. A bucket is either one of the user's own categories,
   * or a name they chose themselves.
   */
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export async function getSpendableCategories(
  userId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const accountIds = await getAccountIds(userId);
  if (accountIds.length === 0) return [];

  const rows = await db.execute<{ category: string }>(sql`
    select distinct coalesce(
      ${tables.transactions.categoryOverride},
      ${tables.transactions.plaidCategoryDetailed},
      ${tables.transactions.plaidCategoryPrimary}
    ) as category
    from transactions
    where account_id in ${accountIds}
      and date >= ${from}
      and date <= ${to}
      and pending = false
      and coalesce(
        ${tables.transactions.categoryOverride},
        ${tables.transactions.plaidCategoryDetailed},
        ${tables.transactions.plaidCategoryPrimary}
      ) is not null
    order by 1
  `);

  return rows
    .map((row) => row.category)
    .filter((value): value is string => Boolean(value));
}

export async function getBudgets(userId: string): Promise<tables.Budget[]> {
  return db.query.budgets.findMany({
    where: eq(tables.budgets.userId, userId),
    // was `asc(b.category)`, which sorted display-only buckets (null) together
    // ahead of the ones that actually measure something. Sort order is the
    // user's own arrangement, so use it.
    orderBy: (b, { asc }) => [asc(b.sortOrder), asc(b.id)],
  });
}

export async function getManualAccounts(
  userId: string,
): Promise<tables.ManualAccount[]> {
  return db.query.manualAccounts.findMany({
    where: eq(tables.manualAccounts.userId, userId),
    orderBy: (m, { asc }) => [asc(m.name)],
  });
}

export async function getLiabilities(
  userId: string,
): Promise<(tables.Liability & { accountName: string })[]> {
  const accounts = await getAccounts(userId);
  if (accounts.length === 0) return [];

  const rows = await db.query.liabilities.findMany({
    where: inArray(
      tables.liabilities.accountId,
      accounts.map((a) => a.id),
    ),
  });

  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  return rows.map((r) => ({
    ...r,
    accountName: nameById.get(r.accountId) ?? "Unknown account",
  }));
}

export type HoldingWithDetails = {
  id: number;
  accountId: number;
  accountName: string;
  quantity: number;
  institutionPrice: number | null;
  institutionValue: number | null;
  costBasis: number | null;
  securityName: string;
  tickerSymbol: string | null;
  securityType: string | null;
  updatedAt: Date;
};

export async function getHoldings(
  userId: string,
): Promise<HoldingWithDetails[]> {
  const accounts = await getAccounts(userId);
  if (accounts.length === 0) return [];

  const rows = await db
    .select({
      id: tables.holdings.id,
      accountId: tables.holdings.accountId,
      quantity: tables.holdings.quantity,
      institutionPrice: tables.holdings.institutionPrice,
      institutionValue: tables.holdings.institutionValue,
      costBasis: tables.holdings.costBasis,
      securityName: tables.securities.name,
      tickerSymbol: tables.securities.tickerSymbol,
      securityType: tables.securities.type,
      updatedAt: tables.holdings.updatedAt,
    })
    .from(tables.holdings)
    .innerJoin(
      tables.securities,
      eq(tables.holdings.securityId, tables.securities.id),
    )
    .innerJoin(
      tables.accounts,
      eq(tables.holdings.accountId, tables.accounts.id),
    )
    .where(
      inArray(
        tables.holdings.accountId,
        accounts.map((a) => a.id),
      ),
    )
    .orderBy(asc(tables.securities.name));

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  return rows.map((r) => ({
    ...r,
    accountName: accountNameById.get(r.accountId) ?? "Unknown account",
    quantity: toNumber(r.quantity),
    institutionPrice:
      r.institutionPrice === null ? null : toNumber(r.institutionPrice),
    institutionValue:
      r.institutionValue === null ? null : toNumber(r.institutionValue),
    costBasis: r.costBasis === null ? null : toNumber(r.costBasis),
  }));
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export type LoanRow = {
  id: number;
  name: string;
  kind: tables.LoanKind;
  apr: number;
  principal: number;
  balance: number;
  paymentAmount: number | null;
  openedOn: string;
  lastAccruedAt: string | null;
  notes: string | null;
};

/**
 * Hand-tracked loans, newest name first.
 *
 * `balance` is returned as stored. The `loan_payments` trigger keeps it in step
 * with the payment history, so it never needs recomputing here.
 */
export async function getLoans(userId: string): Promise<LoanRow[]> {
  const rows = await db.query.loans.findMany({
    where: eq(tables.loans.userId, userId),
    orderBy: [asc(tables.loans.name)],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    apr: toNumber(row.apr),
    principal: toNumber(row.principal),
    balance: toNumber(row.balance),
    paymentAmount:
      row.paymentAmount === null ? null : toNumber(row.paymentAmount),
    openedOn: row.openedOn,
    lastAccruedAt: row.lastAccruedAt,
    notes: row.notes,
  }));
}

export type LoanPaymentRow = {
  id: number;
  loanId: number;
  transactionId: number;
  amount: number;
  interest: number;
  principal: number;
  overpayment: number;
  paidOn: string;
  /** Merchant name, falling back to the raw description. Null if neither. */
  payee: string | null;
};

/** Payment history for one loan, newest first. */
export async function getLoanPayments(
  userId: string,
  loanId: number,
): Promise<LoanPaymentRow[]> {
  const owned = await db.query.loans.findFirst({
    where: and(eq(tables.loans.id, loanId), eq(tables.loans.userId, userId)),
    columns: { id: true },
  });
  if (!owned) return [];

  /*
   * Joined to transactions because "600 on 2026-03-02" is not a payment history
   * anyone can check against their bank statement; the merchant is what makes it
   * recognisable.
   */
  const rows = await db
    .select({
      id: tables.loanPayments.id,
      loanId: tables.loanPayments.loanId,
      transactionId: tables.loanPayments.transactionId,
      amount: tables.loanPayments.amount,
      interest: tables.loanPayments.interest,
      principal: tables.loanPayments.principal,
      overpayment: tables.loanPayments.overpayment,
      paidOn: tables.loanPayments.paidOn,
      merchantName: tables.transactions.merchantName,
      name: tables.transactions.name,
    })
    .from(tables.loanPayments)
    .innerJoin(
      tables.transactions,
      eq(tables.transactions.id, tables.loanPayments.transactionId),
    )
    .where(eq(tables.loanPayments.loanId, loanId))
    .orderBy(desc(tables.loanPayments.paidOn), desc(tables.loanPayments.id));

  return rows.map((row) => ({
    id: row.id,
    loanId: row.loanId,
    transactionId: row.transactionId,
    amount: toNumber(row.amount),
    interest: toNumber(row.interest),
    principal: toNumber(row.principal),
    overpayment: toNumber(row.overpayment),
    paidOn: row.paidOn,
    payee: row.merchantName ?? row.name ?? null,
  }));
}

export type NetWorthBreakdown = {
  cash: number;
  other: number;
  investments: number;
  creditCards: number;
  loans: number;
  /** Of `loans`, the part that is a hand-tracked loan rather than a synced one. */
  manualLoans: number;
  manualAssets: number;
  manualLiabilities: number;
  assets: number;
  liabilities: number;
  netWorth: number;
};

/**
 * Compute current net worth.
 *
 * Sign handling (PLANNED_ARCHITECTURE.md 5.6): Plaid reports credit and loan
 * balances as positive amounts owed, so those get negated here. Investment
 * accounts are valued from HOLDINGS, not from `current_balance`, because a
 * brokerage's cash sweep can appear in both and would double count.
 */
export async function getNetWorth(userId: string): Promise<NetWorthBreakdown> {
  const accounts = await getAccounts(userId);
  const [holdings, manual, manualLoans] = await Promise.all([
    getHoldings(userId),
    getManualAccounts(userId),
    getLoans(userId),
  ]);

  const breakdown: NetWorthBreakdown = {
    cash: 0,
    other: 0,
    investments: 0,
    creditCards: 0,
    loans: 0,
    manualLoans: 0,
    manualAssets: 0,
    manualLiabilities: 0,
    assets: 0,
    liabilities: 0,
    netWorth: 0,
  };

  for (const account of accounts) {
    const balance = toNumber(account.currentBalance);
    switch (account.type) {
      case "depository":
        breakdown.cash += balance;
        break;
      case "credit":
        breakdown.creditCards += Math.abs(balance);
        break;
      case "loan":
        breakdown.loans += Math.abs(balance);
        break;
      case "investment":
        // Intentionally skipped; holdings are authoritative below.
        break;
      default:
        breakdown.other += balance;
        break;
    }
  }

  // Sum per account so two accounts holding the same security don't collide.
  const investmentsByAccount = new Map<number, number>();
  for (const holding of holdings) {
    const value = holding.institutionValue ?? 0;
    investmentsByAccount.set(
      holding.accountId,
      (investmentsByAccount.get(holding.accountId) ?? 0) + value,
    );
  }
  // Still accumulated per account before being summed: two accounts can hold the
  // same security, and the grouped view below reads the same rows.
  for (const value of investmentsByAccount.values()) {
    breakdown.investments += value;
  }

  for (const account of manual) {
    const value = Math.abs(toNumber(account.value));
    if (account.kind === "asset") {
      breakdown.manualAssets += value;
    } else {
      breakdown.manualLiabilities += value;
    }
  }

  /*
   * Hand-tracked loans count as debt and are reported under `loans` rather than
   * `manualLiabilities`, because a reader looking at "Loans" expects a car loan
   * to be there whether Plaid can see it or not.
   *
   * `Math.abs` because `splitPayment` can leave a balance negative in one case:
   * a loan where the payment does not cover the interest it accrued. That is a
   * growing debt, so it must still add to liabilities rather than cancel them.
   */
  for (const loan of manualLoans) {
    const owed = Math.abs(toNumber(loan.balance));
    breakdown.manualLoans += owed;
    breakdown.loans += owed;
  }

  breakdown.assets =
    breakdown.cash +
    breakdown.investments +
    breakdown.manualAssets +
    breakdown.other;
  breakdown.liabilities =
    breakdown.creditCards + breakdown.loans + breakdown.manualLiabilities;
  breakdown.netWorth = breakdown.assets - breakdown.liabilities;

  return breakdown;
}

export type NetWorthPoint = {
  date: string;
  assets: number;
  liabilities: number;
  netWorth: number;
};

/**
 * Net worth history from daily snapshots.
 *
 * Plaid gives current balances only, so history exists only for days we
 * actually recorded. Start the cron early - there is no backfill.
 */
export async function getNetWorthHistory(
  userId: string,
  days = 365,
): Promise<NetWorthPoint[]> {
  const rows = await db.query.netWorthSnapshots.findMany({
    where: eq(tables.netWorthSnapshots.userId, userId),
    /*
     * Newest first for the LIMIT, then flipped below.
     *
     * Ascending order with `limit: days` returns the OLDEST 365 rows, so once a
     * year of daily snapshots existed the chart would be pinned to the first
     * year forever and stop advancing - the exact opposite of what a history is
     * for. Ordering descending and reversing afterwards keeps the chart's
     * chronological order while making the window mean "the last N days".
     */
    orderBy: (s, { desc }) => [desc(s.snapshotDate)],
    limit: days,
  });

  return rows.reverse().map((r) => ({
    date: r.snapshotDate,
    assets: toNumber(r.assetsTotal),
    liabilities: toNumber(r.liabilitiesTotal),
    netWorth: toNumber(r.netWorth),
  }));
}

/** Escape LIKE wildcards so a search for "50%" doesn't match everything. */
function escapeLike(input: string): string {
  return input.replace(/([\\%_])/g, "\\$1");
}
// ---------------------------------------------------------------------------
// Per-account and per-loan detail pages
// ---------------------------------------------------------------------------

/**
 * One account, scoped to its owner.
 *
 * Reached through the account's Item rather than by id alone, so a guessed id
 * cannot read someone else's account. Null rather than a 403 for the same reason
 * the pages render a "not found" panel instead of leaking existence.
 */
export async function getAccountForUser(
  userId: string,
  accountId: number,
): Promise<AccountWithItem | null> {
  const [row] = await db
    .select({ account: tables.accounts, itemId: tables.items.id, institutionName: tables.items.institutionName })
    .from(tables.accounts)
    .innerJoin(tables.items, eq(tables.items.id, tables.accounts.itemId))
    .where(and(eq(tables.accounts.id, accountId), eq(tables.items.userId, userId)))
    .limit(1);

  if (!row) return null;
  return { ...row.account, institutionName: row.institutionName };
}

/**
 * An account's recorded balance on each day the cron ran.
 *
 * Descending for the LIMIT then reversed, so the window means "the last N days"
 * rather than pinning the chart to the oldest ones - see getNetWorthHistory for
 * the same trap on the aggregate.
 *
 * Empty for a while after a deployment, and there is nothing to backfill: Plaid
 * reports current balances only.
 */
export async function getAccountBalanceHistory(
  userId: string,
  accountId: number,
  days = 365,
): Promise<SeriesPoint[]> {
  const account = await getAccountForUser(userId, accountId);
  if (!account) return [];

  const rows = await db.query.accountBalanceSnapshots.findMany({
    where: eq(tables.accountBalanceSnapshots.accountId, accountId),
    orderBy: (s, { desc }) => [desc(s.snapshotDate)],
    limit: days,
  });

  return rows.reverse().map((row) => ({
    date: row.snapshotDate,
    value: toNumber(row.balance),
  }));
}

/**
 * A loan's balance history.
 *
 * Reconstructed from the payment ledger rather than read from a snapshot table,
 * because the `loan_payments` trigger makes it exactly recoverable - see
 * `loanBalanceSeries`. So this is complete from the first payment, with real
 * history available immediately rather than accumulating a point a day.
 */
export async function getLoanBalanceHistory(
  userId: string,
  loanId: number,
): Promise<SeriesPoint[]> {
  const loan = await db.query.loans.findFirst({
    where: and(eq(tables.loans.id, loanId), eq(tables.loans.userId, userId)),
    columns: { openedOn: true, balance: true },
  });
  if (!loan) return [];

  const payments = await db.query.loanPayments.findMany({
    where: eq(tables.loanPayments.loanId, loanId),
    columns: { paidOn: true, principal: true },
  });

  return loanBalanceSeries({
    openedOn: loan.openedOn,
    balance: toNumber(loan.balance),
    payments: payments.map((payment) => ({
      paidOn: payment.paidOn,
      principal: toNumber(payment.principal),
    })),
    today: new Date().toISOString().slice(0, 10),
  }).map((point) => ({ date: point.date, value: point.balance }));
}
