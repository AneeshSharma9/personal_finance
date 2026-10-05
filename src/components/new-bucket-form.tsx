"use client";

import { useState } from "react";

import { humanizeCategory } from "@/lib/categories";
import { selectAllProps } from "@/lib/select-all";

export type NewBucketKind = "basic" | "category" | "earning";

export function NewBucketForm({
  kind,
  options,
  claimedBy,
  disabled,
  emptyLabel,
  onCreate,
}: {
  kind: NewBucketKind;
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
    kind: NewBucketKind;
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
