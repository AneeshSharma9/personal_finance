import Link from "next/link";

import { BarList } from "@/components/bar-list";
import { BudgetSummary } from "@/components/budget-summary";
import { CashFlow } from "@/components/cash-flow";
import { DONUT_COLOURS, Donut } from "@/components/donut";
import { SyncStatus } from "@/components/sync-status";
import { TrendChart } from "@/components/trend-chart";
import { SyncButton } from "@/components/sync-button";
import { formatCurrency, formatPercent, monthRange } from "@/lib/format";
import { payoffProgress } from "@/lib/loan-math";
import {
  getBudgetSummary,
  getBudgetsWithActuals,
  getItems,
  getLatestTransactionMonth,
  getLoans,
  getMonthlySeries,
  getNetWorth,
  getNetWorthHistory,
  getSpendSummary,
} from "@/lib/queries";

export default async function DashboardPage() {
  // `getItems` etc. take the user id rather than reading the session again, so
  // the layout stays the single place that resolves it.
  const { getCurrentUser } = await import("@/lib/auth");
  const user = await getCurrentUser();
  if (!user) return null;

  /*
   * The month shown is the newest one with transactions, not the calendar month.
   *
   * On the 2nd of a month the calendar month holds almost nothing, so a "this
   * month" summary would read as empty spending and full remaining - technically
   * true, and useless. /budgets already defaults this way, so matching it keeps
   * the two pages telling the same story. The month is named below, because
   * "the month" is ambiguous once that is true.
   */
  const latest = await getLatestTransactionMonth(user.id);
  const fallback =
    latest ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
  const { from, to } = monthRange(fallback.year, fallback.month);
  const monthName = new Date(Date.UTC(fallback.year, fallback.month, 1)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  const flowMonths = lastMonths(6);

  const [
    items,
    netWorth,
    netWorthHistory,
    budgetSummary,
    spendSummary,
    buckets,
    flow,
    loans,
  ] = await Promise.all([
    getItems(user.id),
    getNetWorth(user.id),
    getNetWorthHistory(user.id),
    getBudgetSummary(user.id, from, to),
    getSpendSummary(user.id, from, to),
    getBudgetsWithActuals(user.id, from, to),
    getMonthlySeries(
      user.id,
      flowMonths.map((m) => ({ year: m.year, month: m.month + 1 })),
    ),
    getLoans(user.id),
  ]);

  const noAccounts = items.length === 0;

  /*
   * Spending buckets that actually moved. Earnings are excluded deliberately:
   * they are not spending and mixing them in would answer a different question
   * than "where did the money go". A bucket with no actual is dropped rather than
   * shown as $0, which would be a row of zero-width bars.
   */
  const spendingRows = [...buckets.basic, ...buckets.category]
    .filter((row) => row.actual > 0)
    .map((row) => ({
      key: row.id,
      label: row.name,
      value: row.actual,
      over: row.budgeted > 0 && row.actual > row.budgeted,
      href: `/budgets/${row.id}?year=${fallback.year}&month=${fallback.month + 1}`,
      detail:
        row.budgeted > 0
          ? `of ${formatCurrency(row.budgeted)} budgeted`
          : "no budget set",
    }));

  const composition = [
    { key: "cash", label: "Cash", value: netWorth.cash, color: DONUT_COLOURS.cash },
    {
      key: "investments",
      label: "Investments",
      value: netWorth.investments,
      color: DONUT_COLOURS.investments,
    },
    {
      key: "other",
      label: "Other assets",
      value: netWorth.other + netWorth.manualAssets,
      color: DONUT_COLOURS.other,
    },
    {
      key: "creditCards",
      label: "Credit cards",
      value: netWorth.creditCards,
      color: DONUT_COLOURS.creditCards,
    },
    {
      key: "loans",
      label: "Loans",
      value: netWorth.loans + netWorth.manualLiabilities,
      color: DONUT_COLOURS.loans,
    },
  ];
  // A zero slice would render an invisible arc and an empty legend row.
  const visibleComposition = composition.filter((slice) => slice.value > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-neutral-500">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <SyncStatus items={items} />
        </div>
        <SyncButton />
      </header>

      {noAccounts ? (
        <section className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <h2 className="mb-1 font-medium">No accounts linked yet</h2>
          <p className="mx-auto max-w-sm text-sm text-neutral-500">
            Link your first bank to start tracking balances and transactions.
            Each bank login uses one of the 10 Items on your Plaid Trial plan,
            so link only what you need.
          </p>
          <Link
            href="/accounts"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2.5 font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Link an institution
          </Link>
        </section>
      ) : (
        <>
          {/*
            Net worth is the headline, with the trend under it. The change is
            measured from the oldest snapshot on record, which is the same basis
            the chart's footer uses, so the two always agree.
          */}
          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium text-neutral-500">
                  Net worth
                </h2>
                <p className="text-3xl font-semibold tabular-nums">
                  {formatCurrency(netWorth.netWorth)}
                </p>
              </div>
              <dl className="flex gap-5 text-sm">
                <div>
                  <dt className="text-xs text-neutral-500">Cash</dt>
                  <dd className="tabular-nums">
                    {formatCurrency(netWorth.cash + netWorth.other)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Investments</dt>
                  <dd className="tabular-nums">
                    {formatCurrency(netWorth.investments)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Debt</dt>
                  <dd className="tabular-nums">
                    {formatCurrency(netWorth.creditCards + netWorth.loans)}
                  </dd>
                </div>
              </dl>
            </header>

            <div className="mt-3">
              <TrendChart
                points={netWorthHistory.map((point) => ({
                  date: point.date,
                  value: point.netWorth,
                }))}
                label="Net worth"
              />
            </div>
          </section>

          {/*
            The month's position, reusing the budgets page's own summary card so
            the two cannot drift apart. It already carries the ring and the
            leftover figure, which is the quick read this page was missing.
          */}
          <section>
            <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-neutral-500">
                {monthName}
              </h2>
              {spendSummary.unassigned > 0 ? (
                <Link
                  href={`/budgets/unassigned?year=${fallback.year}&month=${fallback.month + 1}`}
                  className="rounded-md px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {spendSummary.unassigned} unbudgeted (
                  {formatCurrency(spendSummary.unassignedTotal)}) &rarr;
                </Link>
              ) : null}
            </header>
            <BudgetSummary totals={budgetSummary} />
          </section>

          <div className="grid gap-6 sm:grid-cols-2">
            <section>
              <h2 className="mb-2 text-sm font-medium text-neutral-500">
                Where the money went
              </h2>
              <p className="mb-2 text-xs text-neutral-500">{monthName}</p>
              <BarList
                rows={spendingRows}
                emptyMessage={`Nothing spent in ${monthName}.`}
              />
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium text-neutral-500">
                What you own and owe
              </h2>
              <Donut
                slices={visibleComposition}
                centerValue={netWorth.netWorth}
                centerLabel="net worth"
              />
            </section>
          </div>

          <section>
            <h2 className="mb-2 text-sm font-medium text-neutral-500">
              Cash flow
            </h2>
            <CashFlow
              months={flow.map((month) => ({
                label: new Date(Date.UTC(month.year, month.month, 1))
                  .toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
                income: month.income,
                spent: month.spent,
              }))}
            />
            <p className="mt-2 text-xs text-neutral-500">
              Every transaction, not only the ones in a bucket &mdash; so this
              will not tie to Spending Budget above, which counts only budgeted
              spending.
            </p>
          </section>

          {loans.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-medium text-neutral-500">
                Loans
              </h2>
              <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {loans.map((loan) => {
                  const progress = payoffProgress({
                    balance: Number(loan.balance),
                    principal: Number(loan.principal),
                  });
                  return (
                    <li key={loan.id}>
                      <Link
                        href={`/loans/${loan.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm">
                            {loan.name}
                          </span>
                          <span className="text-xs text-neutral-500">
                            {formatPercent(Number(loan.apr))} APR
                            {progress !== null
                              ? ` · ${progress.toFixed(0)}% paid`
                              : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">
                          {formatCurrency(Number(loan.balance))}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <p className="text-xs text-neutral-500">
        Using {items.length} of the 10 Plaid Trial Item slots.{" "}
        <Link href="/accounts" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
          Manage accounts
        </Link>{" "}
        &middot;{" "}
        <Link href="/budgets" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
          Budgets
        </Link>{" "}
        &middot;{" "}
        <Link href="/rules" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
          Rules
        </Link>
      </p>
    </div>
  );
}

/** The last `count` months, ending with the current calendar month. */
function lastMonths(count: number): { year: number; month: number }[] {
  const now = new Date();
  const current = now.getFullYear() * 12 + now.getMonth();
  return Array.from({ length: count }, (_, offset) => {
    const index = current - (count - 1) + offset;
    return { year: Math.floor(index / 12), month: index % 12 };
  });
}