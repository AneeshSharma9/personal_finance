import type { Metadata } from "next";
import Link from "next/link";

import { UnassignedTransactions } from "@/components/unassigned-transactions";
import { requireUser } from "@/lib/auth";
import { monthRange } from "@/lib/format";
import {
  getBudgets,
  getLatestTransactionMonth,
  getUnassignedTransactions,
} from "@/lib/queries";

export const metadata: Metadata = { title: "Unassigned · Finance" };

/**
 * The month's spending with no bucket, routed by hand.
 *
 * "Assign unassigned" on the budgets page runs the rules over everything still
 * null, which handles what the engine can place and nothing else. This page is
 * for what it cannot: a landlord payment with no recognisable merchant, a split
 * transaction, anything where Plaid's category is simply wrong.
 *
 * Under /budgets rather than /transactions because the unit of work is a bucket,
 * not a transaction, and because the budgets page's count links straight here
 * carrying its month.
 *
 * The filter must stay identical to getSpendSummary's, or the number on the
 * budgets page and the length of this list disagree.
 */
export default async function UnassignedPage({
  searchParams,
}: PageProps<"/budgets/unassigned">) {
  const user = await requireUser();
  const params = await searchParams;

  const latest = await getLatestTransactionMonth(user.id);
  const fallback =
    latest ?? { year: new Date().getFullYear(), month: new Date().getMonth() };

  const year = Number.parseInt(single(params.year) ?? "", 10) || fallback.year;
  const rawMonth = Number.parseInt(single(params.month) ?? "", 10);
  const month =
    Number.isInteger(rawMonth) && rawMonth >= 1 ? rawMonth - 1 : fallback.month;

  const { from, to } = monthRange(year, month);

  const [transactions, buckets] = await Promise.all([
    getUnassignedTransactions(user.id, from, to),
    getBudgets(user.id),
  ]);

  /*
   * Earnings are not offered as a destination. Money in is routed there
   * automatically, and this queue only holds outgoing transactions
   * (`amount > 0`), so every row here is spending and belongs in a spending
   * bucket.
   */
  const destinations = buckets
    .filter((bucket) => bucket.budgetKind !== "earning")
    .map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      kind: bucket.budgetKind,
    }));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Unassigned</h1>
        <p className="text-sm text-neutral-500">
          {new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}{" "}
          &middot; spending with no bucket. Pick one per transaction; the choice
          sticks, because the rules only ever fill in empty buckets.{" "}
          <Link href={`/budgets?year=${year}&month=${month + 1}`} className="underline">
            Back to budgets
          </Link>
        </p>
      </header>

      <UnassignedTransactions
        transactions={transactions}
        buckets={destinations}
        year={year}
        month={month + 1}
      />
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}