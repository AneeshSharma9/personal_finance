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
  const [search, setSearch] = useState("");

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

  /*
   * Searching widens the list rather than narrowing the addable one.
   *
   * Filtering only what can be added means searching for a category another bucket
   * already has returns nothing at all — a dead end that reads as "no such category"
   * when the category is right there in the user's own transactions. So a search
   * shows every match, and the taken ones are listed but disabled, attributed to
   * the bucket that has them. An empty result then means what it says.
   *
   * With no query the list stays addable-only, because "which categories are free"
   * is the question being asked when nobody has searched for anything.
   */
  const query = search.trim().toLowerCase();
  const matches = (value: string) =>
    query.length === 0 ||
    humanizeCategory(value).toLowerCase().includes(query) ||
    value.toLowerCase().includes(query);

  const shown = query
    ? availableCategories.filter(
        (value) => !categories.includes(value) && matches(value),
      )
    : addable;

  const takenCount = shown.filter((value) => claimedBy[value] !== undefined).length;

  return (
    <details className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      {/*
        Title only. The summary used to append the current list — "— none, this
        bucket is display only", or "Groceries, Restaurants" — which restated what
        the panel underneath already shows the moment you open it, and made the
        collapsed row twice as tall as it needed to be. Worse, the "display only"
        wording was doing a job it could not do honestly: a bucket can receive
        transactions through merchant or amount rules and through explicitly tagged
        loan payments while claiming no category at all, so "display only" read as
        "nothing will ever land here" and was wrong for most buckets.
      */}
      <summary className="cursor-pointer list-none rounded-t-lg px-3 py-2 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800">
        Match transactions by category
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
          <>
            {/*
              There are a few dozen categories in real data — every distinct Plaid
              category the user has actually transacted in — so the list needs
              filtering before it is usable. Matches both the display name and the
              raw value, because people search for either.
            */}
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search categories (${addable.length} available)`}
              aria-label="Search categories"
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            />

            {shown.length === 0 ? (
              <p className="text-xs text-neutral-500">
                {query.length > 0
                  ? `Nothing matches "${search.trim()}".`
                  : "Every category is either already on this bucket or claimed by another one."}
              </p>
            ) : (
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                {shown.map((value) => {
                  const owner = claimedBy[value];
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={pending || owner !== undefined}
                      onClick={() => void save([...categories, value])}
                      title={
                        owner !== undefined
                          ? `Already matched by "${owner}"`
                          : `Also match ${humanizeCategory(value)}`
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs disabled:cursor-not-allowed ${
                        owner !== undefined
                          ? "border-neutral-200 text-neutral-400 line-through dark:border-neutral-800 dark:text-neutral-600"
                          : "border-neutral-300 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {humanizeCategory(value)}
                    </button>
                  );
                })}
              </div>
            )}

            {/*
              Said only when a search surfaced something unavailable. Otherwise the
              struck-through chip and its tooltip are doing the job quietly enough.
            */}
            {takenCount > 0 ? (
              <p className="text-xs text-neutral-500">
                {takenCount} of those {takenCount === 1 ? "is" : "are"} already
                matched by another bucket.
              </p>
            ) : null}
          </>
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

        {picking ? (
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setSearch("");
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 shrink-0"
          >
            Done
          </button>
        ) : null}

        {/*
          Says what "no categories" actually means, because the obvious reading is
          wrong. A bucket with no category is not inert: merchant rules, amount
          rules and explicitly tagged loan payments all still route transactions
          into it. "Display only" claimed the opposite, and several buckets here are
          funded entirely by tagged loan payments while claiming nothing.
        */}
        {categories.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No categories, so nothing is routed here <em>by category</em>.
            Transactions can still arrive from rules, from loan payments tagged to
            this bucket, or by moving them here by hand. Its Actual will read 0 until
            one does.
          </p>
        ) : null}
      </div>
    </details>
  );
}
