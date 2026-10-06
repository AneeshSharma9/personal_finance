import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { budgetedTotal } from "@/lib/budget-remainder";
import { monthRange } from "@/lib/format";
import {
  getBudgetSummary,
  getBudgetsWithActuals,
  getLatestTransactionMonth,
  getMonthlySeries,
  getYearRange,
  getSpendSummary,
} from "@/lib/queries";
import { BudgetEditor } from "@/components/budget-editor";
import { BudgetSummary } from "@/components/budget-summary";
import { MergeBuckets } from "@/components/merge-buckets";
import { MonthStrip } from "@/components/month-strip";

export const metadata: Metadata = { title: "Budgets · Finance" };

/**
 * Budget page, laid out like Rocket Money: **Budget Basics** (automatic bills,
 * utilities, savings goals) and **Budget Categories** (flexible spending), each
 * with Budgeted / Actual per row, an Earnings figure, and a Spending Budget
 * footer.
 *
 * Every bucket is a real category drawn from the user's own transactions, and
 * transactions are routed into buckets automatically by lib/budget-engine.ts.
 */
export default async function BudgetsPage({
  searchParams,
}: PageProps<"/budgets">) {
  const user = await requireUser();
  const params = await searchParams;

  /**
   * Default to the newest month that actually has transactions rather than the
   * current calendar month. Plaid's Sandbox returns historical data, so the
   * current month is routinely empty and every Actual reads 0 - which looks like
   * assignment is broken when it isn't. Explicit ?year/?month still wins, so the
   * month navigation is unaffected.
   */
  const latest = await getLatestTransactionMonth(user.id);
  const fallback =
    latest ?? { year: new Date().getFullYear(), month: new Date().getMonth() };

  const year =
    Number.parseInt(single(params.year) ?? "", 10) || fallback.year;
  const rawMonth = Number.parseInt(single(params.month) ?? "", 10);
  const month =
    Number.isInteger(rawMonth) && rawMonth >= 1 ? rawMonth - 1 : fallback.month;

  const { from, to } = monthRange(year, month);

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  /*
   * The strip shows the whole selected year, so it is a pure function of `year`.
   *
   * There used to be a separate six-month window with its own `wYear`/`wMonth`
   * parameters, which was a second piece of state that could disagree with the
   * month whose figures were on screen - and it hid half the year, since reaching
   * October from a window ending in September meant pressing an arrow.
   */
  const stripMonths = buildYear(year);

  const [groups, unassigned, summary, series, yearRange] = await Promise.all([
    getBudgetsWithActuals(user.id, from, to),
    getSpendSummary(user.id, from, to),
    getBudgetSummary(user.id, from, to),
    getMonthlySeries(user.id, stripMonths),
    getYearRange(user.id),
  ]);

  /*
   * The remainder bucket's Budgeted figure is the budgeted income less every other
   * bucket, derived by lib/budget-remainder.ts rather than typed into the row. The
   * rows come back from the query already carrying it, which is why every total
   * below is computed from them directly: the Spending Budget footing the page now
   * equals the budgeted income by construction, instead of by the user having got
   * the arithmetic right on every row themselves.
   */
  const basics = groups.basic;
  const spending = groups.category;
  const earnings = groups.earning;

  const basicsBudgeted = budgetedTotal(basics);
  const categoriesBudgeted = budgetedTotal(spending);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/*
        The two sibling views sit in the header rather than partway down the page.
        They were floating between the summary and the grid, where they read as a
        caption to the summary instead of navigation - and a right-aligned pair with
        nothing to their left has no obvious owner.
      */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Budgets</h1>
          <p className="text-sm text-neutral-500">
            {new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </p>
        </div>
        {/*
          Each answers a different question from the grid below, so each has its own
          page. The worksheet is the plan; the cash flow is what happened - which is
          why only that one carries the selected month across.

          Buckets leads, and carries the month, because it is where this page's
          controls went. Adding a bucket, deleting one and choosing which categories
          each matches used to be scattered across here and the bucket's own page;
          what is left here is the comparison, so these are the ways off it.
        */}
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/budgets/buckets?year=${year}&month=${month + 1}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            Buckets
          </Link>
          <Link
            href="/budgets/worksheet"
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Budget worksheet
          </Link>
          <Link
            href={`/budgets/cash-flow?scope=month&year=${year}&month=${month + 1}`}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Cash flow
          </Link>
        </div>
      </header>

      <MonthStrip
        months={series}
        selected={{ year, month: month + 1 }}
        years={yearRange.years}
        currentYear={currentYear}
        currentMonth={currentMonth}
      />

      <BudgetSummary totals={summary} />

      {/*
        Both of these answer a different question from the grid below, so each gets
        its own page rather than another card here. The worksheet is the plan you
        made; the cash flow is what happened, for this month - which is why only
        the cash flow link carries the month across.
      */}
      <BudgetEditor
        basics={basics}
        categories={spending}
        earnings={earnings}
        unassigned={unassigned}
        year={year}
        month={month}
        totals={{
          basicsBudgeted,
          categoriesBudgeted,
          // Rocket Money's footer: every budgeted outflow, not one group.
          spendingBudget: basicsBudgeted + categoriesBudgeted,
          earningsBudgeted: budgetedTotal(earnings),
          basicsActual: sumActual(basics),
          categoriesActual: sumActual(spending),
          earningsActual: sumActual(earnings),
        }}
      />

      <MergeBuckets
        buckets={[
          ...basics.map((row) => ({ id: row.id, name: row.name, kind: "basic" })),
          ...spending.map((row) => ({ id: row.id, name: row.name, kind: "category" })),
          ...earnings.map((row) => ({ id: row.id, name: row.name, kind: "earning" })),
        ]}
      />

      {/*
        Rules live on their own page now: they can target loans as well as
        buckets, which does not belong under a page about monthly limits.
      */}
      <p className="text-sm text-neutral-500">
        <a href="/rules" className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
          Manage rules
        </a>{" "}
        to route transactions automatically, including past ones.
      </p>
    </div>
  );
}

/** All twelve months of `year`, ascending, as 1-based { year, month }. */
function buildYear(year: number): { year: number; month: number }[] {
  return Array.from({ length: 12 }, (_, offset) => ({
    year,
    month: offset + 1,
  }));
}


function sumActual(rows: { actual: number }[]): number {
  return rows.reduce((total, row) => total + row.actual, 0);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}