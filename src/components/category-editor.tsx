"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { humanizeCategory } from "@/lib/format";

/**
 * Inline category editor for one transaction.
 *
 * Shows the effective category as a button; clicking swaps it for a select so a
 * page full of rows doesn't render a dropdown per row. Saving writes
 * `categoryOverride` through PATCH /api/transactions/[id], which is already
 * implemented - this only supplies the control.
 *
 * Changing the category also clears the transaction's budget bucket, so the rule
 * engine can re-route it. Otherwise the transaction would keep sitting in a
 * bucket that no longer matches its category, and the budgets page would
 * disagree with the transactions page. See PATCH /api/transactions/[id].
 */

const PLAID_OPTION = "__plaid__";

export function CategoryEditor({
  transactionId,
  displayCategory,
  categoryOverride,
  plaidCategoryPrimary,
  options,
}: {
  transactionId: number;
  /** What the list is currently showing: override, else Plaid's own. */
  displayCategory: string;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  /** Categories already in use, so the picker only offers real ones. */
  options: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isOverridden = categoryOverride !== null;

  async function save(next: string) {
    setError(null);

    const response = await fetch(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // The sentinel means "drop my override and use Plaid's category".
      body: JSON.stringify({
        categoryOverride: next === PLAID_OPTION ? null : next,
      }),
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? "Could not change the category.");
      return;
    }

    setOpen(false);

    // The category change cleared the bucket assignment; re-run the engine so the
    // transaction lands in the right one immediately instead of waiting for the
    // next sync.
    const applied = await fetch("/api/budgets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    void applied;
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          isOverridden
            ? "Category set by you. Click to change."
            : "Set by Plaid. Click to change."
        }
        className={`rounded px-1 py-0.5 text-left underline-offset-2 hover:underline ${
          isOverridden ? "text-blue-700 dark:text-blue-400" : ""
        }`}
      >
        {displayCategory}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={categoryOverride ?? PLAID_OPTION}
        disabled={pending}
        autoFocus
        onChange={(event) => {
          const next = event.target.value;
          const current = categoryOverride ?? PLAID_OPTION;
          if (next !== current) {
            void save(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="max-w-[14rem] rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
      >
        {plaidCategoryPrimary ? (
          <option value={PLAID_OPTION}>
            {humanizeCategory(plaidCategoryPrimary)} (Plaid)
          </option>
        ) : null}
        {options.map((value) => (
          <option key={value} value={value}>
            {humanizeCategory(value)}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Cancel"
        className="text-neutral-400 hover:text-neutral-600"
      >
        ×
      </button>

      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}