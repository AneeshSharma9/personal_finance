"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  formatCurrency,
  formatCurrencyInput,
  parseCurrencyInput,
} from "@/lib/format";
import { columnTone, columnValue, type Column } from "@/lib/budget-columns";
import { SectionHeader } from "@/components/section-header";
import { selectAllProps } from "@/lib/select-all";

export type BudgetRow = {
  id: number;
  kind: "basic" | "category" | "earning";
  name: string;
  categories: string[];
  budgeted: number;
  actual: number;
  remaining: number;
  percentUsed: number | null;
  isCatchAll: boolean;
};

export type BudgetTotals = {
  basicsBudgeted: number;
  categoriesBudgeted: number;
  spendingBudget: number;
  earningsBudgeted: number;
  basicsActual: number;
  categoriesActual: number;
  earningsActual: number;
};

export type SpendSummary = {
  unassigned: number;
  unassignedTotal: number;
};

type Props = {
  basics: BudgetRow[];
  categories: BudgetRow[];
  earnings: BudgetRow[];
  unassigned: SpendSummary;
  totals: BudgetTotals;
  /** Month currently displayed; carried into bucket links. */
  year: number;
  month: number;
};

export function BudgetEditor({
  basics,
  categories,
  earnings,
  unassigned,
  totals,
  year,
  month,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /*
   * Which money figure the tables show: what was spent, or what is left.
   *
   * One piece of state for all three tables rather than one per table. The three
   * tables are read as one budget — the summary above them adds their totals
   * together — so letting one show Actual while another shows Remaining produced a
   * page where two columns claimed the same name and meant different things, and
   * the only way to tell them apart was to count rows.
   *
   * Local state, not the URL, matching the "Add bucket" toggles: this is a viewing
   * preference for this visit, not a different budget.
   */
  const [column, setColumn] = useState<Column>("actual");
  const toggleColumn = () =>
    setColumn((current) => (current === "actual" ? "remaining" : "actual"));
  const [error, setError] = useState<string | null>(null);

  async function call(
    input: RequestInfo,
    init: RequestInit,
  ): Promise<Response | null> {
    setError(null);
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Something went wrong.");
        return null;
      }
      startTransition(() => router.refresh());
      return response;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      return null;
    }
  }

  const saveBudget = (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) =>
    call("/api/budgets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });


  const spendingActual = totals.basicsActual + totals.categoriesActual;
  const overSpending = spendingActual > totals.spendingBudget;

  return (
    <div className="space-y-8">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
      <UnassignedWarning
        unassigned={unassigned}
        year={year}
        month={month}
      />

      {/*
        Earnings leads: you plan the budget from what comes in, then decide
        where it goes.
      */}
      <EarningsTable
        rows={earnings}
        pending={pending}
        column={column}
        onToggleColumn={toggleColumn}
        year={year}
        month={month}
        onSave={saveBudget}
      />

      <BudgetTable
        title="Budget Basics"
        subtitle="Automatic bills, utilities, savings goals and debt payments."
        rows={basics}
        kind="basic"
        pending={pending}
        column={column}
        onToggleColumn={toggleColumn}
        year={year}
        month={month}
        onSave={saveBudget}
      />

      <BudgetTable
        title="Budget Categories"
        subtitle="Flexible spending, grouped into buckets."
        rows={categories}
        kind="category"
        pending={pending}
        column={column}
        onToggleColumn={toggleColumn}
        year={year}
        month={month}
        onSave={saveBudget}
      />

      {/*
        The month's verdict. The Actual turns red when spending has passed the
        total budgeted, which is the one number on the page that says whether the
        month worked. It did not before: the figure was rendered in the same
        muted grey whether it was 40% or 140% of budget, so overspending had to
        be spotted by comparing two numbers by eye.
      */}
      <div
        className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
          overSpending
            ? "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40"
            : "border-neutral-300 dark:border-neutral-700"
        }`}
      >
        <span className="font-medium">Spending Budget</span>
        <span className="flex gap-6 text-sm tabular-nums">
          <span>{formatCurrency(totals.spendingBudget)}</span>
          <span
            className={
              overSpending
                ? "font-medium text-red-700 dark:text-red-400"
                : "text-neutral-500"
            }
          >
            {formatCurrency(spendingActual)}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * A warning, shown only when something is actually unfiled.
 *
 * This used to be a permanent "Automatic assignment" tile with a button on it, then
 * a permanent tile explaining that assignment was automatic and there was nothing
 * to press. Both were noise: with an "Everything Else" bucket the engine leaves
 * nothing unrouted, so the count is 0 and there is no news.
 *
 * Now it renders only when the count is non-zero, and says only the one useful
 * thing - there are N transactions and here is where to put them. A tile that
 * appears precisely when it has something to say does not need to explain itself
 * the rest of the time.
 */
function UnassignedWarning({
  unassigned,
  year,
  month,
}: {
  unassigned: SpendSummary;
  /** 0-based, as the page holds it; only used to build the link. */
  year: number;
  month: number;
}) {
  if (unassigned.unassigned === 0) return null;

  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Link
        href={`/budgets/unassigned?year=${year}&month=${month + 1}`}
        className="rounded-md px-1 hover:bg-amber-100 dark:hover:bg-amber-900"
      >
        {unassigned.unassigned} transaction
        {unassigned.unassigned === 1 ? "" : "s"} (
        {formatCurrency(unassigned.unassignedTotal)}) aren&apos;t in a bucket yet
      </Link>
    </p>
  );
}

function ColumnToggle({
  column,
  onToggle,
}: {
  column: Column;
  onToggle: () => void;
}) {
  const showingActual = column === "actual";
  return (
    <span className="flex justify-end">
      <button
        type="button"
        onClick={onToggle}
        title={
          showingActual
            ? "Show what is left in every table instead"
            : "Show what was spent in every table instead"
        }
        className="-mr-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
      >
        {showingActual ? "Actual" : "Remaining"}
        <span aria-hidden className="text-[10px] leading-none">
          {"\u21C4"}
        </span>
      </button>
    </span>
  );
}

function BudgetTable({
  title,
  subtitle,
  rows,
  kind,
  pending,
  year,
  month,
  column,
  onToggleColumn,
  onSave,
}: {
  title: string;
  subtitle: string;
  rows: BudgetRow[];
  kind: "basic" | "category";
  pending: boolean;
  year: number;
  month: number;
  column: Column;
  onToggleColumn: () => void;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) => Promise<Response | null>;
}) {
  return (
    <section>
      <SectionHeader
        title={title}
        description={subtitle}
      />

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_6rem_5rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800">
          <span>Name</span>
          <span className="text-right">Budgeted</span>
          <ColumnToggle column={column} onToggle={onToggleColumn} />
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">
            Nothing here yet.{" "}
            <Link
              href={`/budgets/buckets?year=${year}&month=${month + 1}`}
              className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              Add a bucket
            </Link>
          </p>
        ) : null}

        {rows.map((row) => (
          <RowEditor
            key={row.id}
            row={row}
            year={year}
            month={month}
            disabled={pending}
            column={column}
            onSave={onSave}
          />
        ))}

      </div>
    </section>
  );
}

function EarningsTable({
  rows,
  pending,
  year,
  month,
  column,
  onToggleColumn,
  onSave,
}: {
  rows: BudgetRow[];
  pending: boolean;
  year: number;
  month: number;
  column: Column;
  onToggleColumn: () => void;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) => Promise<Response | null>;
}) {
  // Same treatment as the budget sections: the picker is behind a control
  // instead of permanently occupying the bottom of the table.
  return (
    <section>
      <SectionHeader
        title="Earnings"
        description="Income received this month. Deposits are routed here automatically."
      />

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_6rem_5rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800">
          <span>Name</span>
          <span className="text-right">Budgeted</span>
          <ColumnToggle column={column} onToggle={onToggleColumn} />
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">
            No earnings buckets yet. Deposits will not be routed anywhere until
            one exists.{" "}
            <Link
              href={`/budgets/buckets?year=${year}&month=${month + 1}`}
              className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              Add one
            </Link>
          </p>
        ) : null}

        {rows.map((row) => (
          <RowEditor
            key={row.id}
            row={row}
            year={year}
            month={month}
            disabled={pending}
            column={column}
            onSave={onSave}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Add a bucket, either from one of the user's own categories or from nothing.
 *
 * A category chip fills both the name and the backing category, and either can
 * then be changed: the name is the user's to choose and the category is what
 * routing matches on. Leaving the category empty creates a display-only row -
 * a place to plan money without claiming any transactions, which is the honest
 * shape for a bucket like "Vacation fund" that has no spending to route yet.
 *
 * Picking a real category used to be the *only* way to add a row, which made a
 * bucket that is not a Plaid category impossible to express at all.
 */
function RowEditor({
  row,
  year,
  month,
  disabled,
  column,
  onSave,
}: {
  row: BudgetRow;
  year: number;
  month: number;
  disabled: boolean;
  column: Column;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) => Promise<Response | null>;
}) {
  const [text, setText] = useState(() =>
    formatCurrencyInput(String(row.budgeted)),
  );

  /*
   * Re-seed from the server's value, but only when it actually changed.
   *
   * Comparing the number rather than the text is what stops this clobbering
   * what is being typed: the formatted string for 1550 is "$1,550" whether it
   * came from the prop or from the keyboard, so re-seeding on every render would
   * reset the caret mid-edit.
   */
  const [seen, setSeen] = useState(row.budgeted);
  if (seen !== row.budgeted) {
    setSeen(row.budgeted);
    setText(formatCurrencyInput(String(row.budgeted)));
  }

  /*
   * Over budget is bad news for spending and good news for income, so the colour
   * follows the row's group rather than the arithmetic.
   *
   * Before this, a month where income beat its target rendered red - the same
   * red as overspending, on the one row where exceeding the number is the point.
   */
  /*
   * One figure, one judgement, whichever column is showing — see `columnTone` for
   * why the two columns have to agree and why the comparison inverts between them.
   */
  const tone = columnTone(row, column);
  const value = columnValue(row, column);

  const reset = () => {
    setSeen(row.budgeted);
    setText(formatCurrencyInput(String(row.budgeted)));
  };

  return (
    /*
     * The whole row is the link.
     *
     * `relative` plus a stretched `::after` on the name link, rather than wrapping
     * the row in an `<a>`: the row contains a real `<input>` and a delete `<button>`,
     * and neither is valid inside an anchor.
     *
     * Those two controls are lifted above the stretched link with `relative z-10`.
     * Without it they sit underneath it, so typing a budget amount or deleting a
     * bucket would navigate to the bucket page instead - a genuinely nasty failure,
     * because the budget field is the one thing on this page you use constantly.
     *
     * The row highlights on hover the way the nav items do, which is why the link no
     * longer needs its own underline. An underline on the name was the only thing
     * marking four of the five columns as clickable, and it was a poor signal for a
     * target the size of the row.
     */
    <div className="group relative grid grid-cols-[1fr_6rem_5rem] items-center gap-2 border-b border-neutral-100 px-4 py-2 transition-colors last:border-0 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-700">
      <div className="min-w-0">
        <Link
          href={`/budgets/${row.id}?year=${year}&month=${month + 1}`}
          className="block truncate text-sm after:absolute after:inset-0 after:content-['']"
        >
          {row.name}
        </Link>
      </div>

      <input
        {...selectAllProps}
        value={text}
        disabled={disabled}
        inputMode="decimal"
        aria-label={`Budgeted for ${row.name}`}
        onChange={(event) => setText(formatCurrencyInput(event.target.value))}
        onBlur={(event) => {
          const parsed = parseCurrencyInput(event.target.value);
          // An emptied field is not a request to budget zero, so it snaps back
          // rather than silently wiping a real figure.
          if (parsed === null) {
            reset();
            return;
          }
          if (parsed === row.budgeted) return;
          setSeen(parsed);
          void onSave({
            kind: row.kind,
            name: row.name,
            categories: row.categories,
            budgeted: parsed,
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          // Escape abandons the edit instead of saving a half-typed figure.
          if (event.key === "Escape") {
            reset();
            event.currentTarget.blur();
          }
        }}
        className="relative z-10 w-full bg-transparent text-right text-sm tabular-nums outline-none disabled:opacity-50"
      />

      <div className="flex items-center justify-end gap-1">
        <span
          className={`text-sm tabular-nums ${
            tone === "good"
              ? "font-medium text-green-700 dark:text-green-400"
              : tone === "bad"
                ? "font-medium text-red-700 dark:text-red-400"
                : "text-neutral-500"
          }`}
        >
          {/*
            Signed in Remaining mode on purpose. A negative is the information —
            it says the bucket is over — and a leading "-" makes that legible without
            needing the colour.
          */}
          {formatCurrency(value)}
        </span>

      </div>
    </div>
  );
}

