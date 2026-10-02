import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { cache } from "react";

import { db, tables, toNumber } from "@/db";
import { isCatchAll, suggestedBuckets } from "@/lib/categories";
import { getActualsByBucket } from "@/lib/budget-engine";

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
  pending: boolean;
  notes: string | null;
  website: string | null;
  accountName: string;
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

  const [txns, accounts, tagged, [{ count }]] = await Promise.all([
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
  ]);

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
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
        pending: t.pending,
        notes: t.notes,
        website: t.website,
        accountName: accountNameById.get(t.accountId) ?? "Unknown account",
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
      category: budget.category,
      budgeted,
      actual,
      remaining: budgeted - actual,
      percentUsed: budgeted > 0 ? (actual / budgeted) * 100 : null,
      isCatchAll:
        budget.budgetKind !== "earning" && !budget.category && isCatchAll(budget.name),
    });
  }

  return groups;
}

export type BudgetRowResult = {
  id: number;
  kind: tables.BudgetKind;
  name: string;
  category: string | null;
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
    where account_id in ${accountIds}
      and date >= ${from}
      and date <= ${to}
      and pending = false
      and budget_id is null
      and amount > 0
  `);

  return {
    unassigned: row?.n ?? 0,
    unassignedTotal: toNumber(row?.total ?? 0),
  };
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

export type BucketTransaction = {
  id: number;
  plaidTransactionId: string;
  date: string;
  amount: number;
  merchantName: string | null;
  name: string | null;
  displayCategory: string;
  notes: string | null;
  /** Positive for spending; the bucket detail shows this sign as-is. */
  signedAmount: number;
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

  return rows.map((row) => {
    const amount = toNumber(row.amount);
    return {
      id: row.id,
      plaidTransactionId: row.plaidTransactionId,
      date: row.date,
      amount,
      signedAmount: -amount,
      merchantName: row.merchantName,
      name: row.name,
      displayCategory:
        row.categoryOverride ?? row.plaidCategoryPrimary ?? "Uncategorized",
      notes: row.notes,
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

  // The suggestions are a starting point, not a limit: every Plaid category
  // they reference is offered whether or not the user has spent there yet.
  for (const bucket of suggestedBuckets) {
    for (const category of bucket.matches) seen.add(category);
  }

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
    orderBy: (b, { asc }) => [asc(b.category)],
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
    orderBy: (s, { asc }) => [asc(s.snapshotDate)],
    limit: days,
  });

  return rows.map((r) => ({
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