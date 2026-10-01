"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { humanizeCategory } from "@/lib/format";

export type Rule = {
  id: number;
  budgetId: number;
  budgetName: string;
  matchType: "merchant" | "category";
  matchValue: string;
  priority: number;
  active: boolean;
};

type Bucket = { id: number; name: string };

/**
 * Routing rules, Rocket Money style.
 *
 * Two kinds, both routing a match into a bucket:
 *  - merchant: a substring of the merchant or raw description. Wins over
 *    category matching, so it can override a broad default ("all Starbucks is
 *    Dining" even though Starbucks categorises as coffee shops).
 *  - category: a Plaid category value, prefix-matched.
 *
 * Rules apply to transactions that have no bucket yet. Changing a rule therefore
 * affects future transactions and anything currently unassigned; use
 * "Re-assign everything" on the budgets page to re-decide existing ones.
 */
export function BudgetRules({
  buckets,
  availableCategories,
  initialRules,
}: {
  buckets: Bucket[];
  availableCategories: string[];
  initialRules: Rule[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Merchant text and the bucket it routes to.
  const [matchType, setMatchType] = useState<"merchant" | "category">(
    "merchant",
  );
  const [matchValue, setMatchValue] = useState("");
  const [bucketId, setBucketId] = useState<string>("");

  /**
   * Re-read after a mutation. Kept as an explicit call rather than an effect on
   * mount: the page is a Server Component and already passes the initial rows,
   * so there is nothing to synchronise on first paint.
   */
  async function reload() {
    const response = await fetch("/api/budgets/rules");
    if (!response.ok) return;
    const data = (await response.json()) as { rules: Rule[] };
    setRules(data.rules);
  }

  async function save() {
    setError(null);
    const response = await fetch("/api/budgets/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchType,
        matchValue,
        budgetId: Number(bucketId),
      }),
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? "Could not save the rule.");
      return;
    }
    setMatchValue("");
    await reload();
    startTransition(() => router.refresh());
  }

  async function remove(id: number) {
    setError(null);
    const response = await fetch(`/api/budgets/rules?id=${id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? "Could not delete the rule.");
      return;
    }
    await reload();
    startTransition(() => router.refresh());
  }

  const canSave =
    matchValue.trim().length > 0 && bucketId !== "" && buckets.length > 0;

  return (
    <section>
      <header className="mb-2 flex items-end justify-between gap-3">
        <div>
          <h2 className="font-medium">Rules</h2>
          <p className="text-xs text-neutral-500">
            Automatically send matching transactions to a bucket. Merchant rules
            take priority over categories.
          </p>
        </div>
        {buckets.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="text-sm text-neutral-600 underline dark:text-neutral-400"
          >
            {open ? "Close" : "Add rule"}
          </button>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {open && buckets.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <label className="basis-32">
            <span className="mb-1 block text-xs text-neutral-500">Match</span>
            <select
              value={matchType}
              onChange={(event) =>
                setMatchType(event.target.value as "merchant" | "category")
              }
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="merchant">Merchant</option>
              <option value="category">Category</option>
            </select>
          </label>

          <label className="flex-1 basis-40">
            <span className="mb-1 block text-xs text-neutral-500">
              {matchType === "merchant" ? "Contains" : "Category"}
            </span>
            {matchType === "merchant" ? (
              <input
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                placeholder="e.g. Starbucks"
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            ) : (
              <select
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">Choose a category</option>
                {availableCategories.map((value) => (
                  <option key={value} value={value}>
                    {humanizeCategory(value)}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="flex-1 basis-32">
            <span className="mb-1 block text-xs text-neutral-500">
              Send to bucket
            </span>
            <select
              value={bucketId}
              onChange={(event) => setBucketId(event.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="">Choose a bucket</option>
              {buckets.map((bucket) => (
                <option key={bucket.id} value={bucket.id}>
                  {bucket.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={save}
            disabled={!canSave || pending}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            Add
          </button>
        </div>
      ) : null}

      {buckets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Add a bucket first, then rules can route transactions into it.
        </p>
      ) : rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No rules. Each bucket&apos;s own category already matches automatically.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
            >
              <span className="min-w-0 truncate">
                <span className="text-neutral-500">
                  {rule.matchType === "merchant" ? "Merchant contains " : "Category "}
                </span>
                <span className="font-medium">
                  {rule.matchType === "merchant"
                    ? rule.matchValue
                    : humanizeCategory(rule.matchValue)}
                </span>
                <span className="text-neutral-500"> &rarr; </span>
                <span>{rule.budgetName}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(rule.id)}
                aria-label={`Delete rule ${rule.matchValue}`}
                className="text-neutral-400 hover:text-red-600"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}