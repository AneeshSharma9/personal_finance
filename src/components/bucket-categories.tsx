"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { humanizeCategory } from "@/lib/categories";

/**
 * Which Plaid categories a bucket claims, editable.
 *
 * This lives on a bucket's own page rather than on its row in the budgets table.
 * On the row it was a strip of chips plus a "+ category" button and an inline
 * picker, and a row is a grid cell — the chips wrapped, the button wrapped, and a
 * bucket with three categories turned one line of a financial table into five. The
 * information is per-bucket and rarely per-row; the budgets page is for comparing
 * figures at a glance, and "which categories does this claim" is not one.
 *
 * A row still shows nothing here at all. That is a real trade: from the table you
 * can no longer tell an auto-matched bucket from a display-only one. It is the
 * right trade for a page whose job is scanning numbers, and the bucket's own page
 * is one click away.
 *
 * Saving goes through the same `PUT /api/budgets` the table uses, which upserts on
 * (user, kind, name) — so `budgeted` has to be sent back unchanged or the save
 * would quietly reset the month's figure. That is the whole reason this component
 * takes the figure rather than patching one field: the endpoint is a whole-row
 * upsert, and half of it is not ours to change here.
 */
export function BucketCategories({
  name,
  kind,
  categories,
  budgeted,
  availableCategories,
  claimedBy,
}: {
  name: string;
  kind: "basic" | "category" | "earning";
  categories: string[];
  budgeted: number;
  /** Every category present in the user's transactions. */
  availableCategories: string[];
  /**
   * Category to the name of the bucket that already claims it, excluding this one.
   *
   * Built by the server so the client does not need every bucket row to work out
   * who owns what — and so the answer cannot disagree with the editor's own list.
   */
  claimedBy: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function save(next: string[]) {
    setError(null);
    try {
      const response = await fetch("/api/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name, categories: next, budgeted }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Could not save that.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    }
  }

  const addable = availableCategories.filter(
    (value) => !categories.includes(value) && claimedBy[value] === undefined,
  );

  return (
    <details className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">
          Match transactions by category
        </span>{" "}
        <span className="text-neutral-500">
          {categories.length === 0
            ? "— none, this bucket is display only"
            : categories.map(humanizeCategory).join(", ")}
        </span>
      </summary>

      <div className="space-y-2 border-t border-neutral-100 px-3 py-3 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">
          {/*
            Stated here because it is the part that is easy to get wrong: a
            transaction already filed keeps its bucket even if the category that put
            it there is later removed. Rules decide future transactions and anything
            still unassigned.
          */}
          New transactions matching these categories are routed here automatically.
          Anything already in this bucket stays where it is, even if you change
          this list afterwards.
        </p>

        {categories.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {categories.map((value) => (
              <li key={value}>
                <span className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  {humanizeCategory(value)}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void save(categories.filter((entry) => entry !== value))
                    }
                    aria-label={`Stop matching ${humanizeCategory(value)} on ${name}`}
                    title={`Stop matching ${humanizeCategory(value)}`}
                    className="text-neutral-400 hover:text-neutral-800 disabled:opacity-50 dark:hover:text-neutral-100"
                  >
                    &times;
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}

        {picking ? (
          addable.length === 0 ? (
            <p className="text-xs text-neutral-500">
              Every category is either already on this bucket or claimed by another
              one.
            </p>
          ) : (
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
              {addable.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={pending}
                  onClick={() => void save([...categories, value])}
                  title={`Also match ${humanizeCategory(value)}`}
                  className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {humanizeCategory(value)}
                </button>
              ))}
            </div>
          )
        ) : (
          <button
            type="button"
            disabled={pending || addable.length === 0}
            onClick={() => setPicking(true)}
            className="rounded-md border border-dashed border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-400 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            {addable.length === 0 ? "No categories left to add" : "+ Add a category"}
          </button>
        )}

        {picking && addable.length > 0 ? (
          <button
            type="button"
            onClick={() => setPicking(false)}
            className="text-xs text-neutral-500 underline underline-offset-2"
          >
            Done
          </button>
        ) : null}

        {/*
          Named so a bucket with no categories says why its Actual is $0 rather
          than leaving it looking broken. It is the single most confusing thing
          about a display-only bucket.
        */}
        {categories.length === 0 ? (
          <p className="text-xs text-neutral-500">
            With no category this bucket measures nothing on its own — its Actual
            stays 0 until you route a transaction into it by hand, or give it a
            category above.
          </p>
        ) : null}
      </div>
    </details>
  );
}
