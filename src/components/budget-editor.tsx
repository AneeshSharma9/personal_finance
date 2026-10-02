"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { formatCurrency, humanizeCategory } from "@/lib/format";

export type BudgetRow = {
  id: number;
  kind: "basic" | "category" | "earning";
  name: string;
  category: string | null;
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
  availableCategories: string[];
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
  availableCategories,
  unassigned,
  totals,
  year,
  month,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    category: string | null;
    budgeted: number;
  }) =>
    call("/api/budgets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const deleteBudget = (id: number) =>
    call(`/api/budgets?id=${id}`, { method: "DELETE" });

  const applyRules = async (reset: boolean) => {
    setNotice(null);
    const response = await call("/api/budgets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset }),
    });
    if (!response) return;
    const data = (await response.json()) as {
      assigned: number;
      cleared: number;
      scanned: number;
    };
    setNotice(
      reset
        ? `Cleared ${data.cleared} assignments and routed ${data.assigned} transactions.`
        : `Routed ${data.assigned} of ${data.scanned} unassigned transactions.`,
    );
  };

  /**
   * Categories already used as a bucket, so they don't appear as options twice.
   */
  const usedCategories = new Set(
    [...basics, ...categories, ...earnings]
      .map((row) => row.category)
      .filter((value): value is string => Boolean(value)),
  );

  const options = availableCategories.filter(
    (category) => !usedCategories.has(category),
  );

  const spendingOptions = options.filter(
    (category) => !isIncomeCategory(category),
  );
  const earningOptions = options.filter(isIncomeCategory);

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
      {notice ? (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          {notice}
        </p>
      ) : null}

      <ApplyRulesBar unassigned={unassigned} pending={pending} onApply={applyRules} />

      {/*
        Earnings leads: you plan the budget from what comes in, then decide
        where it goes.
      */}
      <EarningsTable
        rows={earnings}
        options={earningOptions}
        pending={pending}
        year={year}
        month={month}
        onSave={saveBudget}
        onDelete={deleteBudget}
      />

      <BudgetTable
        title="Budget Basics"
        subtitle="Automatic bills, utilities, savings goals and debt payments."
        rows={basics}
        kind="basic"
        options={spendingOptions}
        pending={pending}
        year={year}
        month={month}
        onSave={saveBudget}
        onDelete={deleteBudget}
      />

      <BudgetTable
        title="Budget Categories"
        subtitle="Flexible spending, grouped into buckets."
        rows={categories}
        kind="category"
        options={spendingOptions}
        pending={pending}
        year={year}
        month={month}
        onSave={saveBudget}
        onDelete={deleteBudget}
      />

      <div className="flex items-center justify-between rounded-lg border border-neutral-300 px-4 py-3 dark:border-neutral-700">
        <span className="font-medium">Spending Budget</span>
        <span className="flex gap-6 text-sm tabular-nums">
          <span>{formatCurrency(totals.spendingBudget)}</span>
          <span className="text-neutral-500">
            {formatCurrency(totals.basicsActual + totals.categoriesActual)}
          </span>
        </span>
      </div>
    </div>
  );
}

function ApplyRulesBar({
  unassigned,
  pending,
  onApply,
}: {
  unassigned: SpendSummary;
  pending: boolean;
  onApply: (reset: boolean) => void;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Automatic assignment</p>
          <p className="text-xs text-neutral-500">
            {unassigned.unassigned === 0
              ? "Every transaction is in a bucket."
              : `${unassigned.unassigned} transactions (${formatCurrency(
                  unassigned.unassignedTotal,
                )}) are not in a bucket yet.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onApply(false)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Assign unassigned
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onApply(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Re-assign everything
          </button>
        </div>
      </div>
    </section>
  );
}

function BudgetTable({
  title,
  subtitle,
  rows,
  kind,
  options,
  pending,
  year,
  month,
  onSave,
  onDelete,
}: {
  title: string;
  subtitle: string;
  rows: BudgetRow[];
  kind: "basic" | "category";
  options: string[];
  pending: boolean;
  year: number;
  month: number;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    category: string | null;
    budgeted: number;
  }) => Promise<Response | null>;
  onDelete: (id: number) => Promise<Response | null>;
}) {
  /*
   * The picker used to render only while the section was empty, so adding one
   * bucket removed the only way to add a second. It now sits behind a control in
   * the section header and stays open until dismissed.
   */
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{title}</h2>
          <p className="text-xs text-neutral-500">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="shrink-0 text-xs font-medium text-neutral-600 underline dark:text-neutral-400"
        >
          {adding ? "Cancel" : "Add bucket"}
        </button>
      </header>

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_6rem_5rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800">
          <span>Name</span>
          <span className="text-right">Budgeted</span>
          <span className="text-right">Actual</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">
            Nothing here yet. Pick a category below.
          </p>
        ) : null}

        {rows.map((row) => (
          <RowEditor
            key={row.id}
            row={row}
            year={year}
            month={month}
            disabled={pending}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))}

        {/*
          Shown when the section is empty, so the first bucket is discoverable
          without hunting for a button, and whenever the header toggle is open.
        */}
        {rows.length === 0 || adding ? (
          <CategoryPicker
            options={options}
            disabled={pending}
            emptyLabel={
              rows.length === 0 ? "Pick a category to add a bucket" : undefined
            }
            onPick={(category) => {
              setAdding(false);
              return onSave({
                kind,
                name: humanizeCategory(category),
                category,
                budgeted: 0,
              });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function EarningsTable({
  rows,
  options,
  pending,
  year,
  month,
  onSave,
  onDelete,
}: {
  rows: BudgetRow[];
  options: string[];
  pending: boolean;
  year: number;
  month: number;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    category: string | null;
    budgeted: number;
  }) => Promise<Response | null>;
  onDelete: (id: number) => Promise<Response | null>;
}) {
  // Same treatment as the budget sections: the picker is behind a control
  // instead of permanently occupying the bottom of the table.
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">Earnings</h2>
          <p className="text-xs text-neutral-500">
            Income received this month. Deposits are routed here automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="shrink-0 text-xs font-medium text-neutral-600 underline dark:text-neutral-400"
        >
          {adding ? "Cancel" : "Add bucket"}
        </button>
      </header>

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_6rem_5rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800">
          <span>Name</span>
          <span className="text-right">Budgeted</span>
          <span className="text-right">Actual</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">
            No earnings buckets yet. Deposits will not be routed anywhere until
            one exists.
          </p>
        ) : null}

        {rows.map((row) => (
          <RowEditor
            key={row.id}
            row={row}
            year={year}
            month={month}
            disabled={pending}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))}

        {adding ? (
          <CategoryPicker
            options={options}
            disabled={pending}
            emptyLabel="Pick an income category"
            onPick={(category) => {
              setAdding(false);
              return onSave({
                kind: "earning",
                name: humanizeCategory(category),
                category,
                budgeted: 0,
              });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The bucket options, taken straight from the categories in the user's own
 * transactions.
 *
 * There are no template buckets. Picking a real category is the only way to add
 * a row, which is what makes "Everything Else"-style leftovers unnecessary: the
 * user's own categories are the buckets.
 */
function CategoryPicker({
  options,
  disabled,
  emptyLabel = "Pick a category",
  onPick,
}: {
  options: string[];
  disabled: boolean;
  emptyLabel?: string;
  onPick: (category: string) => void;
}) {
  const [query, setQuery] = useState("");

  const visible = query.trim()
    ? options.filter((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  if (options.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-neutral-500">
        {query ? "No categories match." : "No categories available yet."}
      </p>
    );
  }

  return (
    <div className="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`${emptyLabel} (${options.length})`}
        className="mb-2 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
      />
      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {visible.map((category) => (
          <button
            key={category}
            type="button"
            disabled={disabled}
            onClick={() => onPick(category)}
            className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {humanizeCategory(category)}
          </button>
        ))}
        {visible.length === 0 ? (
          <span className="text-xs text-neutral-500">No matches.</span>
        ) : null}
      </div>
    </div>
  );
}

function RowEditor({
  row,
  year,
  month,
  disabled,
  onSave,
  onDelete,
}: {
  row: BudgetRow;
  year: number;
  month: number;
  disabled: boolean;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    category: string | null;
    budgeted: number;
  }) => Promise<Response | null>;
  onDelete: (id: number) => Promise<Response | null>;
}) {
  const [budgeted, setBudgeted] = useState(String(row.budgeted));

  const [seen, setSeen] = useState(row.budgeted);
  if (seen !== row.budgeted) {
    setSeen(row.budgeted);
    setBudgeted(String(row.budgeted));
  }

  const over = row.percentUsed !== null && row.percentUsed > 100;

  return (
    <div className="grid grid-cols-[1fr_6rem_5rem] items-center gap-2 border-b border-neutral-100 px-4 py-2 last:border-0 dark:border-neutral-800">
      <div className="min-w-0">
        {/* Clicking the name opens the bucket so its transactions can be
            reviewed and moved. */}
        <Link
          href={`/budgets/${row.id}?year=${year}&month=${month + 1}`}
          className="block truncate text-sm underline-offset-2 hover:underline"
        >
          {row.name}
        </Link>
        {row.category ? (
          <span className="block truncate text-xs text-neutral-500">
            {humanizeCategory(row.category)}
          </span>
        ) : null}
      </div>

      <input
        value={budgeted}
        disabled={disabled}
        inputMode="decimal"
        aria-label={`Budgeted for ${row.name}`}
        onChange={(event) => setBudgeted(event.target.value)}
        onBlur={(event) => {
          const parsed = Number(event.target.value.replace(/[$,\s]/g, ""));
          if (Number.isFinite(parsed) && parsed !== row.budgeted) {
            onSave({
              kind: row.kind,
              name: row.name,
              category: row.category,
              budgeted: parsed,
            });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full bg-transparent text-right text-sm tabular-nums outline-none disabled:opacity-50"
      />

      <div className="flex items-center justify-end gap-1">
        <span
          className={`text-sm tabular-nums ${over ? "text-red-600 dark:text-red-400" : "text-neutral-500"}`}
        >
          {formatCurrency(row.actual)}
        </span>
        <button
          type="button"
          onClick={() => onDelete(row.id)}
          disabled={disabled}
          aria-label={`Delete ${row.name}`}
          className="text-neutral-400 hover:text-red-600 disabled:opacity-50"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

function isIncomeCategory(category: string): boolean {
  return /INCOME|PAYROLL|PAYCHECK|INTEREST_EARNINGS/i.test(
    category.toUpperCase(),
  );
}
