import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { buildCashFlowGraph, cashFlowWindow, type CashFlowScope } from "@/lib/cash-flow";
import { formatCurrency } from "@/lib/format";
import { getCashFlow, getLatestTransactionMonth, getYearRange } from "@/lib/queries";
import { BackLink } from "@/components/back-link";
import { CashFlowPeriod } from "@/components/cash-flow-period";
import { SankeyChart } from "@/components/sankey-chart";

export const metadata: Metadata = { title: "Cash flow · Finance" };

/**
 * Where the money came from and where it went, as a Sankey.
 *
 * Month or year-to-date, chosen in the URL so a view can be linked to. The
 * buckets are the same ones the budgets page routes into and the same earnings
 * buckets that count as income everywhere else, so this page agrees with the
 * summary card instead of telling a second, looser story.
 */
export default async function CashFlowPage({
  searchParams,
}: PageProps<"/budgets/cash-flow">) {
  const user = await requireUser();
  const params = await searchParams;

  /*
   * Default to the newest month with transactions, for the same reason the
   * budgets page does: a Plaid Sandbox's current month is routinely empty, and
   * an empty diagram reads as broken rather than as "nothing yet".
   */
  const latest = await getLatestTransactionMonth(user.id);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const fallbackYear = latest?.year ?? currentYear;
  const fallbackMonth = (latest ? latest.month + 1 : currentMonth) || currentMonth;

  const yearRange = await getYearRange(user.id);

  const requestedYear = Number.parseInt(single(params.year) ?? "", 10);
  // A hand-edited ?year= must not offer a year the app has no data for.
  const year = yearRange.years.includes(requestedYear)
    ? requestedYear
    : fallbackYear;

  const requestedMonth = Number.parseInt(single(params.month) ?? "", 10);
  const month =
    requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : fallbackMonth;

  const scope: CashFlowScope =
    single(params.scope) === "ytd" ? "ytd" : "month";

  const window = cashFlowWindow({
    scope,
    year,
    month,
    currentYear,
    currentMonth,
  });

  const data = await getCashFlow(user.id, window.from, window.to, window.months);
  const graph = buildCashFlowGraph({
    income: data.income,
    spending: data.spending,
    unassigned: data.unassigned,
  });

  const { income, spending, remaining, unassigned } = graph.totals;

  /*
   * Carries the exact window this diagram is showing, rather than just the month.
   *
   * A year-to-date figure that cannot be opened is a dead end: you can see that
   * Rent And Utilities took $10,525 across the year and have no way to look at the
   * transactions behind it, because the bucket page only ever took ?year=&month=.
   * So the link passes ?from=&to= and the bucket page honours it - which means
   * "all of this bucket's transactions" means the same nine months the ribbon did.
   */
  const rangeSuffix = `from=${window.from}&to=${window.to}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash flow</h1>
          <p className="text-sm text-neutral-500">{window.label}</p>
        </div>
        <BackLink href={`/budgets?year=${year}&month=${month}`}>Budgets</BackLink>
      </header>

      <CashFlowPeriod
        scope={scope}
        year={year}
        month={month}
        years={yearRange.years}
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Income" value={income} tone="income" />
        <Figure label="Spending" value={spending} />
        <Figure
          label={remaining >= 0 ? "Remaining" : "Overspent"}
          value={Math.abs(remaining)}
          tone={remaining >= 0 ? "income" : "overspent"}
        />
        <Figure
          label="Unassigned"
          value={unassigned}
          hint={
            unassigned > 0 ? (
              <Link
                href={`/budgets/unassigned?year=${year}&month=${month}`}
                className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {formatCurrency(unassigned)} to file
              </Link>
            ) : null
          }
        />
      </dl>

      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <SankeyChart graph={graph} periodLabel={window.label} />
      </div>

      {/*
        The table is the chart's text equivalent. A Sankey is unreadable with a
        screen reader and useless on a phone in a bright room, so every figure in
        it is also available as a number.
      */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          Where it went
        </h2>
        {graph.nodes.filter((node) => node.kind === "spending").length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing was spent in {window.label}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
                <th scope="col" className="py-1 font-normal">Bucket</th>
                <th scope="col" className="py-1 text-right font-normal">Spent</th>
                {scope === "month" ? (
                  <th scope="col" className="py-1 text-right font-normal">Budgeted</th>
                ) : null}
                <th scope="col" className="py-1 text-right font-normal">
                  Share of income
                </th>
              </tr>
            </thead>
            <tbody>
              {/*
                Rows are `relative` so the stretched link inside each one can cover
                the row. Without it the ::after positions against the page and
                swallows clicks on every other row.
              */}
              {graph.nodes
                .filter((node) => node.kind === "spending")
                .map((node) => (
                  <tr
                    key={node.id}
                    className="relative border-b border-neutral-100 dark:border-neutral-800/60"
                  >
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {node.budgetId === undefined ? (
                        node.label
                      ) : (
                        <Link
                          href={`/budgets/${node.budgetId}?${rangeSuffix}`}
                          title={`Every transaction in ${node.label}, ${window.label}`}
                          className="after:absolute after:inset-0 after:content-['']"
                        >
                          {node.label}
                        </Link>
                      )}
                    </th>
                    <td className="tabular-nums py-1.5 text-right">
                      {formatCurrency(node.amount)}
                    </td>
                    {scope === "month" ? (
                      <td className="tabular-nums py-1.5 text-right text-neutral-500">
                        {node.budgeted ? formatCurrency(node.budgeted) : "—"}
                      </td>
                    ) : null}
                    <td className="tabular-nums py-1.5 text-right text-neutral-500">
                      {income > 0 ? `${Math.round((node.amount / income) * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {/*
        Stated rather than left implicit: the diagram counts earnings buckets as
        income, so a transfer between the user's own accounts is not income here,
        and anyone comparing this to a bank statement needs to know that.
      */}
      <p className="text-sm text-neutral-500">
        Income counts money assigned to an earnings bucket, the same figure the
        budgets page uses. Transfers between your own accounts are not income, so
        this will not match a bank&apos;s &ldquo;total inflows&rdquo; line.
      </p>
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: number;
  hint?: React.ReactNode;
  tone?: "neutral" | "income" | "overspent";
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd
        className={`tabular-nums text-lg font-medium ${
          tone === "income"
            ? "text-green-700 dark:text-green-400"
            : tone === "overspent"
              ? "text-red-700 dark:text-red-400"
              : "text-neutral-900 dark:text-neutral-100"
        }`}
      >
        {formatCurrency(value)}
      </dd>
      {hint ? <dd className="mt-0.5 text-xs text-neutral-500">{hint}</dd> : null}
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}