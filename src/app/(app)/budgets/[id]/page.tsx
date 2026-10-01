import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { formatCurrency, monthRange } from "@/lib/format";
import {
  getBudgetForUser,
  getLatestTransactionMonth,
  getTransactionsInBucket,
} from "@/lib/queries";
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

  const { from, to } = monthRange(year, month);

  const transactions = await getTransactionsInBucket(
    user.id,
    budget.id,
    from,
    to,
  );

  /**
   * Total for the header, using the same sign rules as getActualsByBucket so
   * this always agrees with the figure on the budgets page.
   *
   * Note `signedAmount` is the negation of Plaid's amount, so it is negative for
   * spending. Summing `Math.max(0, signedAmount)` would therefore always be 0 -
   * the totals come off raw Plaid amounts instead, keyed by bucket kind.
   */
  const total = transactions.reduce(
    (sum, t) =>
      sum +
      (budget.budgetKind === "earning"
        ? Math.max(0, -t.amount)
        : Math.max(0, t.amount)),
    0,
  );
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <Link
          href={`/budgets?year=${year}&month=${month + 1}`}
          className="text-xs text-neutral-500 underline"
        >
          &larr; Budgets
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{budget.name}</h1>
        <p className="text-sm text-neutral-500">
          {monthLabel} &middot; {formatCurrency(Number(budget.monthlyLimit))}{" "}
          budgeted &middot;{" "}
          <strong>
            {formatCurrency(total)}{" "}
            {budget.budgetKind === "earning" ? "received" : "spent"}
          </strong>
        </p>
      </header>

      {/*
        Keep the month in context while inspecting a bucket, so stepping through
        months does not drop you back to the budgets index.
      */}
      <MonthNav year={year} month={month} bucketId={budget.id} />

      {budget.category ? (
        <p className="text-xs text-neutral-500">
          New transactions matching this bucket&apos;s category are routed here
          automatically. Anything you move below stays where you put it.
        </p>
      ) : null}

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
        className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700"
      >
        Previous
      </Link>
      <Link
        href={`/budgets/${bucketId}?year=${next.getUTCFullYear()}&month=${next.getUTCMonth() + 1}`}
        className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700"
      >
        Next
      </Link>
    </nav>
  );
}

function Invalid() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Bucket not found</h1>
      <Link href="/budgets" className="text-sm underline">
        Back to budgets
      </Link>
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
