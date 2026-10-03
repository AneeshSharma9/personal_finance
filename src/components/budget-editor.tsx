"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  formatCurrency,
  formatCurrencyInput,
  humanizeCategory,
  parseCurrencyInput,
} from "@/lib/format";
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
    categories: string[];
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
   * Which bucket already claims each category, so the picker can show the options
   * that are still free and mark the ones that are taken.
   *
   * A map rather than a set, because the editor no longer hides a claimed
   * category - it greys it out and says who has it. Hiding it meant a category
   * that had gone somewhere else simply stopped being offerable, so the only
   * visible symptom was that "Groceries" could never match anything again and
   * nothing said why.
   *
   * The catch-all is not listed: it is the bucket for spending nothing else
   * claimed, so it must not itself claim a category or it would compete with a
   * real bucket and take its transactions.
   */
  const claimedBy = new Map<string, string>();
  for (const row of [...basics, ...categories, ...earnings]) {
    if (row.isCatchAll) continue;
    for (const value of row.categories) {
      // First bucket wins, matching resolveBucket's first-match-wins order.
      if (!claimedBy.has(value)) claimedBy.set(value, row.name);
    }
  }

  const options = availableCategories;

  const spendingOptions = options.filter(
    (category) => !isIncomeCategory(category),
  );
  const earningOptions = options.filter(isIncomeCategory);

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
        claimedBy={claimedBy}
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
        claimedBy={claimedBy}
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
        claimedBy={claimedBy}
        pending={pending}
        year={year}
        month={month}
        onSave={saveBudget}
        onDelete={deleteBudget}
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
  claimedBy,
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
  claimedBy: Map<string, string>;
  pending: boolean;
  year: number;
  month: number;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
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
            availableCategories={options}
            claimedBy={claimedBy}
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
            claimedBy={claimedBy}
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
  claimedBy,
  pending,
  year,
  month,
  onSave,
  onDelete,
}: {
  rows: BudgetRow[];
  options: string[];
  claimedBy: Map<string, string>;
  pending: boolean;
  year: number;
  month: number;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
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
            availableCategories={options}
            claimedBy={claimedBy}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))}

        {adding ? (
          <NewBucketForm
            kind="earning"
            options={options}
            claimedBy={claimedBy}
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
  claimedBy,
  disabled,
  emptyLabel,
  onCreate,
}: {
  kind: BudgetRow["kind"];
  options: string[];
  /**
   * Which bucket already claims each category, so a taken option can be greyed
   * out and attributed rather than silently hidden. Hiding it looked like the
   * category had stopped existing.
   */
  claimedBy: Map<string, string>;
  disabled: boolean;
  emptyLabel: string;
  onCreate: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) => Promise<Response | null>;
}) {
  const [name, setName] = useState("");
  /*
   * A set, because a bucket is rarely one category: "Weekend" is dining AND
   * entertainment, "Amazon" is general merchandise AND online shopping. One slot
   * per bucket forced a choice between a vague name and several buckets fighting
   * over the same transactions.
   */
  const [categories, setCategories] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const toggle = (value: string) =>
    setCategories((current) =>
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    );

  const visible = query.trim()
    ? options.filter((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  /*
   * Offered for this form but already spoken for. Still rendered, still
   * searchable - just not selectable - because "why can't I pick Groceries?" is a
   * worse experience than "Groceries is already matched by Groceries".
   */
  const takenElsewhere = (value: string) => claimedBy.get(value) !== undefined;

  const selectable = visible.filter((value) => !takenElsewhere(value));

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0;

  function submit() {
    if (!canCreate) return;
    // Cleared before the await so a slow save cannot be double-submitted, and
    // so the form is ready for the next bucket either way.
    setName("");
    setCategories([]);
    setQuery("");
    return onCreate({ kind, name: trimmed, categories, budgeted: 0 });
  }

  return (
    <div className="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="block min-w-48 flex-1">
          <span className="mb-1 block text-xs text-neutral-500">Name</span>
          <input
            {...selectAllProps}
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

        {/*
          A summary rather than a control. The chips below are the real picker -
          a <select multiple> needs ctrl-click, scrolls to one item at a time, and
          cannot say why an option is unavailable. This just reports the current
          state of the choice and offers the one action that changes it.
        */}
        <div className="min-w-48 flex-1">
          <span className="mb-1 block text-xs text-neutral-500">
            Match transactions by (optional)
          </span>
          <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700">
            {categories.length === 0 ? (
              <span className="text-neutral-500">
                Nothing - display only
              </span>
            ) : (
              <>
                {categories.map((value) => (
                  <span
                    key={value}
                    className="flex items-center gap-1 rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-white dark:bg-white dark:text-neutral-900"
                  >
                    {humanizeCategory(value)}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(value)}
                      aria-label={`Stop matching ${humanizeCategory(value)}`}
                      className="opacity-70 hover:opacity-100"
                    >
                      &times;
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setCategories([])}
                  className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

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
            {visible.map((value) => {
              const owner = claimedBy.get(value);
              const selected = categories.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled || owner !== undefined}
                  aria-pressed={selected}
                  /*
                    The tooltip is the whole point of greying rather than hiding:
                    it names the bucket that already has this category. Two buckets
                    claiming one category is not rejected - the first silently wins
                    and the second reads $0 forever - so this is the only place the
                    user is told.
                  */
                  title={
                    owner !== undefined
                      ? `Already matched by "${owner}"`
                      : selected
                        ? `Stop matching ${humanizeCategory(value)}`
                        : `Also match ${humanizeCategory(value)}`
                  }
                  onClick={() => {
                    toggle(value);
                    // Only fill a name the user has not written themselves, and
                    // only from the first pick - "Weekend" beats "Dining And Drink".
                    if (!name.trim() && categories.length === 0) {
                      setName(humanizeCategory(value));
                    }
                  }}
                  className={`rounded-full border px-2.5 py-1 text-xs disabled:cursor-not-allowed ${
                    selected
                      ? "border-neutral-900 bg-neutral-900 text-white disabled:opacity-100 dark:border-white dark:bg-white dark:text-neutral-900"
                      : owner !== undefined
                        ? "border-neutral-200 text-neutral-400 line-through dark:border-neutral-800 dark:text-neutral-600"
                        : "border-neutral-300 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  }`}
                >
                  {humanizeCategory(value)}
                </button>
              );
            })}
            {visible.length === 0 ? (
              <span className="text-xs text-neutral-500">No matches.</span>
            ) : selectable.length === 0 && visible.length > 0 ? (
              <span className="text-xs text-neutral-500">
                Everything here is already matched by another bucket.
              </span>
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
  availableCategories,
  claimedBy,
  onSave,
  onDelete,
}: {
  row: BudgetRow;
  year: number;
  month: number;
  disabled: boolean;
  /** Every category present in the user's transactions, for the add picker. */
  availableCategories: string[];
  claimedBy: Map<string, string>;
  onSave: (payload: {
    kind: BudgetRow["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) => Promise<Response | null>;
  onDelete: (id: number) => Promise<Response | null>;
}) {
  /*
   * Adding or removing a category is a normal edit, not a new-bucket form.
   *
   * It used to be impossible: a bucket's category could only be set at creation,
   * and RowEditor could edit nothing but the figure. So the natural thing to want
   * - "Weekend" starts as dining, then a month reveals it should also match
   * entertainment - had no route at all, and the only way to get it was to delete
   * the bucket and rebuild it, losing the budgeted amount and the manual
   * assignments already pointing at it.
   */
  const [pickingCategory, setPickingCategory] = useState(false);

  /**
   * Categories this row could still take.
   *
   * A category already on *this* bucket is not offered, and neither is one another
   * bucket has claimed. Sharing is not rejected - the first bucket in display order
   * simply wins forever and the other reads $0 - so this is the only place that
   * fact is visible.
   */
  const addableCategories = availableCategories.filter(
    (value) =>
      !row.categories.includes(value) && claimedBy.get(value) !== row.name,
  );

  function saveCategories(next: string[]) {
    if (next.length === row.categories.length) return;
    return onSave({
      kind: row.kind,
      name: row.name,
      categories: next,
      budgeted: row.budgeted,
    });
  }

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
  const over = row.budgeted > 0 && row.actual > row.budgeted;
  const tone = !over ? "" : row.kind === "earning" ? "good" : "bad";

  const reset = () => {
    setSeen(row.budgeted);
    setText(formatCurrencyInput(String(row.budgeted)));
  };

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
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {row.categories.map((value) => (
            <span
              key={value}
              className="flex max-w-40 items-center gap-1 rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              <span className="truncate">{humanizeCategory(value)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void saveCategories(
                    row.categories.filter((entry) => entry !== value),
                  )
                }
                aria-label={`Stop matching ${humanizeCategory(value)} on ${row.name}`}
                title={`Stop matching ${humanizeCategory(value)}`}
                className="shrink-0 text-neutral-400 hover:text-neutral-800 disabled:opacity-50 dark:hover:text-neutral-100"
              >
                &times;
              </button>
            </span>
          ))}

          <button
            type="button"
            disabled={disabled || addableCategories.length === 0}
            onClick={() => setPickingCategory((open) => !open)}
            aria-expanded={pickingCategory}
            title={
              addableCategories.length === 0
                ? "Every category is either already on this bucket or claimed by another"
                : "Add a category this bucket matches"
            }
            className="rounded-full border border-dashed border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {pickingCategory ? "Cancel" : "+ category"}
          </button>

          {pickingCategory ? (
            <div className="flex max-h-28 w-full flex-wrap gap-1 overflow-y-auto rounded border border-neutral-200 p-1 dark:border-neutral-800">
              {addableCategories.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    // Left open on purpose: a bucket usually wants two or three
                    // categories, and reopening between each one would make the
                    // second one a separate errand.
                    void saveCategories([...row.categories, value]);
                  }}
                  title={`Also match ${humanizeCategory(value)}`}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {humanizeCategory(value)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
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
        className="w-full bg-transparent text-right text-sm tabular-nums outline-none disabled:opacity-50"
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
