import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { getBudgets, getCategoryOptions, getLatestTransactionMonth } from "@/lib/queries";
import { BackLink } from "@/components/back-link";
import {
  BucketManager,
  type BucketGroups,
} from "@/components/bucket-manager";

export const metadata: Metadata = { title: "Buckets · Finance" };

/**
 * Every bucket, and every way of changing one.
 *
 * This used to be three places: an "Add bucket" control on each section of the
 * budgets page, a delete `×` on every row there, and the category matcher on the
 * bucket's own transactions page. Configuring a bucket meant moving between three
 * screens, and none of them was the screen where buckets live.
 *
 * The budgets page keeps what it is for — comparing what you budgeted against what
 * you spent — and this page keeps everything that changes what a bucket *is*.
 */
export default async function BucketsPage({
  searchParams,
}: PageProps<"/budgets/buckets">) {
  const user = await requireUser();
  const params = await searchParams;

  /*
   * The month is only carried so the links into each bucket's transactions land
   * somewhere sensible. Nothing on this page is month-scoped: a bucket exists
   * regardless of which month you are looking at.
   */
  const latest = await getLatestTransactionMonth(user.id);
  const fallback = latest ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
  const year = Number.parseInt(first(params.year) ?? "", 10) || fallback.year;
  const rawMonth = Number.parseInt(first(params.month) ?? "", 10);
  const month =
    Number.isInteger(rawMonth) && rawMonth >= 1 ? rawMonth - 1 : fallback.month;

  const [buckets, availableCategories] = await Promise.all([
    getBudgets(user.id),
    getCategoryOptions(user.id),
  ]);

  const groups: BucketGroups = { basic: [], category: [], earning: [] };
  for (const bucket of buckets) {
    groups[bucket.budgetKind].push({
      id: bucket.id,
      kind: bucket.budgetKind,
      name: bucket.name,
      categories: bucket.categories,
      budgeted: Number(bucket.monthlyLimit),
    });
  }

  const total = groups.basic.length + groups.category.length + groups.earning.length;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <BackLink href={`/budgets?year=${year}&month=${month + 1}`}>Budgets</BackLink>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Buckets</h1>
        <p className="text-sm text-neutral-500">
          {total} {total === 1 ? "bucket" : "buckets"}. Add and delete them here, and
          choose which categories each one matches.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Budgeted amounts are set on the{" "}
          <Link href={`/budgets?year=${year}&month=${month + 1}`} className="hover:underline">
            budgets page
          </Link>
          , not here — one place per figure.
        </p>
      </header>

      <BucketManager
        groups={groups}
        availableCategories={availableCategories}
        year={year}
        month={month}
      />
    </div>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}