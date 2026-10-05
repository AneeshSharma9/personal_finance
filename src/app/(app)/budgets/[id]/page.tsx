import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { formatCurrency, monthRange, parseDateRange } from "@/lib/format";
import {
  getBudgetForUser,
  getBudgets,
  getCategoryOptions,
  getLatestTransactionMonth,
  getTransactionsInBucket,
} from "@/lib/queries";
import { BackLink } from "@/components/back-link";
import { BucketCategories } from "@/components/bucket-categories";
import { BucketTransactions } from "@/components/bucket-transactions";

export const metadata: Metadata = { title: "Bucket · Finance" };

/**
 * Transactions inside one budget bucket, with per-transaction reassignment.
 *
 * Rocket Money's flow: click a bucket, see what landed in it, drag the wrong
 * ones elsewhere. Reassigning writes `transactions.budget_id` directly, and the
 * engine deliberately never touches a non-null assignment - so a move made here
 * survives future syncs and rule changes.
 */
export default async function BucketPage({
  params,
  searchParams,
}: PageProps<"/budgets/[id]">) {
  const user = await requireUser();
  const { id: rawId } = await params;
  const query = await searchParams;

  const budgetId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return <Invalid />;
  }

  const budget = await getBudgetForUser(user.id, budgetId);
  // 404 rather than a redirect: a bucket id that isn't the user's shouldn't be
  // distinguishable from one that doesn't exist.
  if (!budget) return <Invalid />;

  // Resolve the month: explicit ?year/?month, else the newest month with data.
  const latest = await getLatestTransactionMonth(user.id);
  const fallback = latest ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
  const year =
    Number.parseInt(single(query.year) ?? "", 10) || fallback.year;
  const rawMonth = Number.parseInt(single(query.month) ?? "", 10);
  const month =
    Number.isInteger(rawMonth) && rawMonth >= 1 ? rawMonth - 1 : fallback.month;

  /*
   * Two ways in.
   *
   * `?year=&month=` is a single month, which is what the budgets page and
   * MonthNav link to. `?from=&to=` is an arbitrary window, which is what the cash
   * flow page links to: it can be showing a year to date, and "all of this
   * bucket's transactions" has to mean the same nine months the diagram did. There
   * was no way to express that before, so every bucket was reachable for exactly
   * one month at a time and a YTD figure could not be opened up at all.
   *
   * A malformed or absent range falls back to the month rather than erroring - the
   * page is browsable by hand and ?year= alone is a reasonable thing to type.
   */
  const range = parseDateRange(
    single(query.from),
    single(query.to),
  );
  const { from, to } = range ?? monthRange(year, month);
  const months = range?.months ?? 1;

  const [transactions, availableCategories, allBuckets] = await Promise.all([
    getTransactionsInBucket(user.id, budget.id, from, to),
    getCategoryOptions(user.id),
    getBudgets(user.id),
  ]);

  /*
   * Which bucket already claims each category, so the picker can grey out the
   * taken ones and say who has them.
   *
   * This bucket's own categories are excluded, or it would be competing with
   * itself and every category it already matched would look unavailable. The
   * catch-all is skipped: it is the bucket for spending nothing else claimed, so
   * it must not claim a category or it would take a real bucket's transactions.
   *
   * First bucket wins, matching the engine's first-match-wins order.
   */
  const claimedBy: Record<string, string> = {};
  for (const row of allBuckets) {
    const isCatchAll =
      row.budgetKind !== "earning" &&
      row.categories.length === 0 &&
      /everything\s*else|^other$/i.test(row.name);
    if (row.id === budget.id || isCatchAll) continue;
    for (const value of row.categories) {
      if (claimedBy[value] === undefined) claimedBy[value] = row.name;
    }
  }

  /**
   * Total for the header, using the same sign rules as getActualsByBucket so
   * this always agrees with the figure on the budgets page.
   *
   * Note `signedAmount` is the negation of Plaid's amount, so it is negative for
   * spending. Summing `Math.max(0, signedAmount)` would therefore always be 0 -
   * the totals come off raw Plaid amounts instead, keyed by bucket kind.
   *
   * Ignored rows are skipped, matching getActualsByBucket. They are still listed
   * in the table below, greyed out, so the total and the rows can be read
   * together without the two disagreeing.
   */
  const total = transactions.reduce(
    (sum, t) =>
      sum +
      (t.excluded
        ? 0
        : budget.budgetKind === "earning"
          ? Math.max(0, -t.amount)
          : Math.max(0, t.amount)),
    0,
  );
  const monthLabel =
    range?.label ??
    new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

  /*
   * A budget is a monthly figure, so a window covering several months needs the
   * figure scaled - and scaled by the months the window *touches*, not by its
   * length in days. January 1 to September 30 is 273 days but ten budgets were in
   * play. `monthsInRange` counts calendar months, which is what keeps this equal
   * to the figure on the cash flow page for the same window.
   */
  const budgeted = Number(budget.monthlyLimit) * months;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <BackLink
          href={
            range
              ? `/budgets/cash-flow?year=${year}&month=${month + 1}`
              : `/budgets?year=${year}&month=${month + 1}`
          }
        >
          {range ? "Cash flow" : "Budgets"}
        </BackLink>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{budget.name}</h1>
        <p className="text-sm text-neutral-500">
          {monthLabel} &middot; {formatCurrency(budgeted)} budgeted
          {months > 1 ? ` (${months} months)` : ""} &middot;{" "}
          <strong>
            {formatCurrency(total)}{" "}
            {budget.budgetKind === "earning" ? "received" : "spent"}
          </strong>{" "}
          across {transactions.length}{" "}
          {transactions.length === 1 ? "transaction" : "transactions"}
        </p>
      </header>

      {/*
        Keep the month in context while inspecting a bucket, so stepping through
        months does not drop you back to the budgets index.
      */}
      {range ? (
        <p className="text-xs text-neutral-500">
          <Link
            href={`/budgets/${budget.id}?year=${year}&month=${month + 1}`}
            className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Switch to {monthLabel} only
          </Link>
        </p>
      ) : (
        <MonthNav year={year} month={month} bucketId={budget.id} />
      )}

      {/*
        Moved here from the budgets table. On the row this was a strip of chips and
        a "+ category" button, and a bucket with three categories wrapped one line of
        a grid into five — the table is for comparing figures, and which categories a
        bucket claims is not comparable at a glance.
      */}
      <BucketCategories
        name={budget.name}
        kind={budget.budgetKind}
        categories={budget.categories}
        budgeted={Number(budget.monthlyLimit)}
        availableCategories={availableCategories}
        claimedBy={claimedBy}
      />

      <BucketTransactions
        transactions={transactions}
        currentBucketId={budget.id}
      />
    </div>
  );
}

function MonthNav({
  year,
  month,
  bucketId,
}: {
  year: number;
  month: number;
  bucketId: number;
}) {
  const prev = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month + 1, 1));

  return (
    <nav className="flex items-center gap-2 text-sm">
      <Link
        href={`/budgets/${bucketId}?year=${prev.getUTCFullYear()}&month=${prev.getUTCMonth() + 1}`}
        className="rounded-md border border-neutral-300 px-3 py-2 hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
      >
        Previous
      </Link>
      <Link
        href={`/budgets/${bucketId}?year=${next.getUTCFullYear()}&month=${next.getUTCMonth() + 1}`}
        className="rounded-md border border-neutral-300 px-3 py-2 hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
      >
        Next
      </Link>
    </nav>
  );
}

function Invalid() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Bucket not found</h1>
      <BackLink href="/budgets">Budgets</BackLink>
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
