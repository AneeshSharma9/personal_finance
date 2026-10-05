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
import { columnTone, columnValue, type Column } from "@/lib/budget-columns";
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

  const deleteBudget = (id: number) =>
    call(`/api/budgets?id=${id}`, { method: "DELETE" });

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
        options={earningOptions}
        claimedBy={claimedBy}
        pending={pending}
        column={column}
        onToggleColumn={toggleColumn}
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
        column={column}
        onToggleColumn={toggleColumn}
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
        column={column}
        onToggleColumn={toggleColumn}
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

/**
 * A section heading, with its explanation on hover rather than underneath.
 *
 * The descriptions were always on screen and always the same, so they stopped being
 * read — three permanent lines of static prose above a table, pushing the numbers
 * down. As a tooltip they are there when wanted and out of the way otherwise.
 *
 * `title` alone would be a mouse-only affordance: it does not appear on keyboard
 * focus, so the description would be unreachable without a pointer. `tabIndex` makes
 * the heading focusable so it also surfaces on focus.
 *
 * The hover is a background, like every other row and control here. It was a dotted
 * underline first, which was marking the same thing — but an underline under a
 * heading reads as a rule dividing the header from the table, and it was the one
 * underline left on the page after link underlines were removed.
 *
 * The `ⓘ` is decorative — the focusable element is the heading itself — so it is
 * hidden from assistive tech rather than announced as an empty label.
 */
function SectionHeader({
  title,
  description,
  adding,
  onToggleAdding,
}: {
  title: string;
  description: string;
  adding: boolean;
  onToggleAdding: () => void;
}) {
  return (
    <header className="mb-2 flex items-start justify-between gap-3">
      <h2
        tabIndex={0}
        title={description}
        className="-mx-1.5 min-w-0 cursor-help rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-700 dark:focus-visible:ring-neutral-600"
      >
        {title}
        <span aria-hidden className="ml-1 align-middle text-xs text-neutral-400">
          ⓘ
        </span>
      </h2>
      <button
        type="button"
        onClick={onToggleAdding}
        className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700 shrink-0"
      >
        {adding ? "Cancel" : "Add bucket"}
      </button>
    </header>
  );
}

/**
 * The right-hand column heading, which switches every table between Actual and
 * Remaining.
 *
 * A button because it is one: the label is also the state, so "Actual" means "you
 * are seeing Actual, click for Remaining". `title` spells out the consequence,
 * which matters more here than usual — the toggle applies to all three tables, so
 * clicking one heading changes two others, and that is not something the label
 * alone communicates.
 *
 * The swap glyph is `aria-hidden` because the accessible name is the visible word:
 * a screen reader announcing "Actual, button, swap" is worse than "Actual, button".
 */
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
  options,
  claimedBy,
  pending,
  year,
  month,
  column,
  onToggleColumn,
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
  column: Column;
  onToggleColumn: () => void;
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
      <SectionHeader
        title={title}
        description={subtitle}
        adding={adding}
        onToggleAdding={() => setAdding((value) => !value)}
      />

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[1fr_6rem_5rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800">
          <span>Name</span>
          <span className="text-right">Budgeted</span>
          <ColumnToggle column={column} onToggle={onToggleColumn} />
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
            column={column}
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
  column,
  onToggleColumn,
  onSave,
  onDelete,
}: {
  rows: BudgetRow[];
  options: string[];
  claimedBy: Map<string, string>;
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
  onDelete: (id: number) => Promise<Response | null>;
}) {
  // Same treatment as the budget sections: the picker is behind a control
  // instead of permanently occupying the bottom of the table.
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <SectionHeader
        title="Earnings"
        description="Income received this month. Deposits are routed here automatically."
        adding={adding}
        onToggleAdding={() => setAdding((value) => !value)}
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
            column={column}
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
                  className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
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
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-300"
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
                        : "border-neutral-300 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-700"
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
  column,
  onSave,
  onDelete,
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
  onDelete: (id: number) => Promise<Response | null>;
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
        <button
          type="button"
          onClick={() => onDelete(row.id)}
          disabled={disabled}
          aria-label={`Delete ${row.name}`}
          className="relative z-10 rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-700"
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
