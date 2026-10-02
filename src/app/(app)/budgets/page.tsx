import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { monthRange } from "@/lib/format";
import {
  getBudgetSummary,
  getBudgetsWithActuals,
  getLatestTransactionMonth,
  getMonthlySeries,
  getYearRange,
  getCategoryOptions,
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

  /**
   * Strip window anchor: six months ending at TODAY by default.
   *
   * Deliberately independent of the selected month. The two serve different
   * purposes and defaulting the window to `selected` hid the current month: the
   * selected month defaults to the newest month that has transactions (so the
   * figures are not all zero on a fresh Plaid Sandbox), which is usually *behind*
   * today. Anchoring the window to that put September last and October was never
   * offered.
   *
   * `wYear`/`wMonth` carry the anchor once the user has paged with the arrows,
   * and are clamped so a future month can never appear.
   */
  const anchorYear =
    Number.parseInt(single(params.wYear) ?? "", 10) || currentYear;
  const anchorMonthRaw =
    Number.parseInt(single(params.wMonth) ?? "", 10) || currentMonth;

  const currentIndex = currentYear * 12 + (currentMonth - 1);
  const anchorIndex = Math.min(
    anchorYear * 12 + (anchorMonthRaw - 1),
    currentIndex,
  );
  const stripMonths = buildWindow(anchorIndex, 6);

  const [
    groups,
    availableCategories,
    unassigned,
    summary,
    series,
    yearRange,
  ] = await Promise.all([
    getBudgetsWithActuals(user.id, from, to),
    getCategoryOptions(user.id),
    getSpendSummary(user.id, from, to),
    getBudgetSummary(user.id, from, to),
    getMonthlySeries(user.id, stripMonths),
    getYearRange(user.id),
  ]);

  const basics = groups.basic;
  const spending = groups.category;
  const earnings = groups.earning;

  const basicsBudgeted = sum(basics);
  const categoriesBudgeted = sum(spending);

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
        */}
        <div className="flex flex-wrap gap-2">
          <Link
            href="/budgets/worksheet"
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Budget worksheet
          </Link>
          <Link
            href={`/budgets/cash-flow?scope=month&year=${year}&month=${month + 1}`}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
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
        anchorYear={Math.floor(anchorIndex / 12)}
        anchorMonth={(anchorIndex % 12) + 1}
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
        availableCategories={availableCategories}
        unassigned={unassigned}
        year={year}
        month={month}
        totals={{
          basicsBudgeted,
          categoriesBudgeted,
          // Rocket Money's footer: every budgeted outflow, not one group.
          spendingBudget: basicsBudgeted + categoriesBudgeted,
          earningsBudgeted: sum(earnings),
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
        <a href="/rules" className="underline">
          Manage rules
        </a>{" "}
        to route transactions automatically, including past ones.
      </p>
    </div>
  );
}

/** Six-month window ending at `anchorIndex`, as 1-based { year, month }. */
function buildWindow(
  anchorIndex: number,
  size: number,
): { year: number; month: number }[] {
  return Array.from({ length: size }, (_, offset) => {
    const index = anchorIndex - (size - 1) + offset;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
  });
}


function sum(rows: { budgeted: number }[]): number {
  return rows.reduce((total, row) => total + row.budgeted, 0);
}

function sumActual(rows: { actual: number }[]): number {
  return rows.reduce((total, row) => total + row.actual, 0);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}