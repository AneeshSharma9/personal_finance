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

  /**
   * Hand the still-null transactions to the rules.
   *
   * Only ever fills empty buckets, so this cannot undo a manual choice - which
   * is also why the "clear everything and start again" variant is gone. It
   * cleared manual assignments too, and there was no way to tell afterwards
   * which of them had been deliberate.
   */
  const applyRules = async () => {
    setNotice(null);
    const response = await call("/api/budgets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response) return;
    const data = (await response.json()) as {
      assigned: number;
      scanned: number;
    };
    setNotice(`Routed ${data.assigned} of ${data.scanned} unassigned transactions.`);
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

      <ApplyRulesBar
        unassigned={unassigned}
        year={year}
        month={month}
        pending={pending}
        onApply={() => void applyRules()}
      />

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

/**
 * The automatic-assignment bar: what is still unrouted, and the two ways out.
 *
 * "Assign unassigned" runs the rules over everything still null. The count links
 * to the queue for the transactions the rules *cannot* place - a landlord
 * payment with no recognisable merchant, a split transaction, anything where
 * Plaid's category is wrong. One button cannot do both jobs, and it used to be
 * the only one, so those transactions were simply stuck.
 */
function ApplyRulesBar({
  unassigned,
  year,
  month,
  pending,
  onApply,
}: {
  unassigned: SpendSummary;
  /** 0-based, as the page holds it; only used to build the link. */
  year: number;
  month: number;
  pending: boolean;
  onApply: () => void;
}) {
  const queue = `/budgets/unassigned?year=${year}&month=${month + 1}`;

  return (
    <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Automatic assignment</p>
          {unassigned.unassigned === 0 ? (
            <p className="text-xs text-neutral-500">
              Every transaction is in a bucket.
            </p>
          ) : (
            <p className="text-xs text-neutral-500">
              <Link href={queue} className="underline underline-offset-2">
                {unassigned.unassigned} transaction
                {unassigned.unassigned === 1 ? "" : "s"} (
                {formatCurrency(unassigned.unassignedTotal)}) are not in a
                bucket yet
              </Link>
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={onApply}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Assign unassigned
        </button>
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
            Nothing here yet. Add a bucket below.
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
          <NewBucketForm
            kind={kind}
            options={options}
            disabled={pending}
            emptyLabel={rows.length === 0 ? "Pick a category" : "Filter categories"}
            onCreate={(payload) => {
              setAdding(false);
              return onSave(payload);
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
          <NewBucketForm
            kind="earning"
            options={options}
            disabled={pending}
            emptyLabel="Pick an income category"
            onCreate={(payload) => {
              setAdding(false);
              return onSave(payload);
            }}
          />
        ) : null}
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
function NewBucketForm({
  kind,
  options,
  disabled,
  emptyLabel,
  onCreate,
}: {
  kind: BudgetRow["kind"];
  options: string[];
  disabled: boolean;
  emptyLabel: string;
  onCreate: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    category: string | null;
    budgeted: number;
  }) => Promise<Response | null>;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");

  const visible = query.trim()
    ? options.filter((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0;

  function submit() {
    if (!canCreate) return;
    // Cleared before the await so a slow save cannot be double-submitted, and
    // so the form is ready for the next bucket either way.
    setName("");
    setCategory("");
    setQuery("");
    return onCreate({ kind, name: trimmed, category: category || null, budgeted: 0 });
  }

  return (
    <div className="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="block min-w-48 flex-1">
          <span className="mb-1 block text-xs text-neutral-500">Name</span>
          <input
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Whatever you want to call it"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>

        <label className="block min-w-48 flex-1">
          <span className="mb-1 block text-xs text-neutral-500">
            Match transactions by (optional)
          </span>
          <select
            value={category}
            disabled={disabled}
            onChange={(event) => setCategory(event.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">Nothing - display only</option>
            {options.map((value) => (
              <option key={value} value={value}>
                {humanizeCategory(value)}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={disabled || !canCreate}
          onClick={() => void submit()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Create
        </button>
      </div>

      {/*
        Chips are the shortcut: one click picks the category and pre-fills the
        name, which is still what you want most of the time. It no longer
        creates the row on its own, because the name is meant to be editable.
      */}
      {options.length === 0 ? (
        <p className="text-xs text-neutral-500">
          No categories in your transactions yet. Name a bucket above and it will
          stand on its own.
        </p>
      ) : (
        <>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${emptyLabel} (${options.length})`}
            className="mb-2 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {visible.map((value) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setCategory(value);
                  // Only fill a name the user has not written themselves.
                  if (!name.trim()) setName(humanizeCategory(value));
                }}
                className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-50 ${
                  category === value
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                }`}
              >
                {humanizeCategory(value)}
              </button>
            ))}
            {visible.length === 0 ? (
              <span className="text-xs text-neutral-500">No matches.</span>
            ) : null}
          </div>
        </>
      )}
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
