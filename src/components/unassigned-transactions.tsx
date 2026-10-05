"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { BackLink } from "@/components/back-link";
import { formatCurrency, formatDate, humanizeCategory } from "@/lib/format";
import type { UnassignedTransaction } from "@/lib/queries";

/**
 * The month's unassigned spending, one row per transaction, each routed by hand.
 *
 * This is the other half of "assign what the engine missed". "Assign
 * unassigned" runs the rules over everything still null, which is right for the
 * transactions the engine *can* place and useless for the ones it genuinely
 * cannot: a payment to a landlord with no recognisable merchant, a split
 * transaction, anything where Plaid's category is simply wrong. Those need a
 * person, one row at a time.
 *
 * Writes `budgetId` through PATCH /api/transactions/[id], the same route the
 * bucket detail page uses. That matters: the engine only ever fills in null
 * assignments, so a choice made here is durable and a later sync will not undo
 * it.
 *
 * Assigning a row removes it from the list, because `router.refresh()` re-runs
 * the server query. That is the feedback - no confirmation toast, the row is
 * simply gone.
 */
export function UnassignedTransactions({
  transactions,
  buckets,
  year,
  month,
}: {
  transactions: UnassignedTransaction[];
  buckets: { id: number; name: string; kind: string }[];
  /** 1-based, as the month strip carries it. */
  year: number;
  month: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const bucketName = new Map(buckets.map((bucket) => [bucket.id, bucket.name]));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  async function assign(transactionId: number, budgetId: number) {
    setError(null);
    setSaving(transactionId);
    try {
      const response = await fetch(`/api/transactions/${transactionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetId }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Could not route that transaction.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(null);
    }
  }

  /**
   * Take a row out of the queue without putting it in a bucket.
   *
   * Without this the queue cannot be emptied honestly: some spending should be
   * in no bucket at all, and the alternative would be filing it under the
   * nearest wrong category. `excluded` keeps it visible and greyed rather than
   * deleting it, so the decision stays reversible.
   */
  async function ignore(transactionId: number) {
    setError(null);
    setSaving(transactionId);
    try {
      const response = await fetch(`/api/transactions/${transactionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Could not ignore that transaction.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(null);
    }
  }

  const total = transactions.reduce((sum, t) => sum + t.amount, 0);
  const back = `/budgets?year=${year}&month=${month}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-neutral-500">
          {transactions.length === 0
            ? "Nothing waiting."
            : `${transactions.length} transaction${
                transactions.length === 1 ? "" : "s"
              }, ${formatCurrency(total)}`}
        </p>
        <BackLink href={back}>Budgets</BackLink>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {transactions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Every transaction this month is in a bucket.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {transactions.map((transaction) => (
            <li
              key={transaction.id}
              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 ${
                saving === transaction.id ? "opacity-60" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {transaction.merchantName ?? transaction.name ?? "Unknown"}
                </p>
                <p className="text-xs text-neutral-500">
                  {formatDate(transaction.date)} &middot;{" "}
                  {humanizeCategory(transaction.displayCategory)}
                </p>
                {/*
                  What the engine would do, computed with the same matcher it
                  uses. Shown before the assign control rather than after it,
                  because the first thing you want to know about a queue of
                  transactions is whether your rules already know the answer -
                  not whether you can guess it faster than the app can.
                */}
                <p className="mt-0.5 text-xs text-neutral-400">
                  {transaction.suggestedBudgetId === null ? (
                    <>No rule matches this yet</>
                  ) : (
                    <>
                      Auto:{" "}
                      <span className="text-neutral-600 dark:text-neutral-300">
                        {bucketName.get(transaction.suggestedBudgetId) ??
                          "a bucket that no longer exists"}
                      </span>
                    </>
                  )}
                </p>
              </div>

              <p className="shrink-0 text-sm tabular-nums">
                {formatCurrency(transaction.amount, { showSign: true })}
              </p>

              <span className="flex shrink-0 items-center gap-2">
                {transaction.suggestedBudgetId !== null ? (
                  <button
                    type="button"
                    disabled={pending || saving !== null}
                    onClick={() =>
                      void assign(transaction.id, transaction.suggestedBudgetId!)
                    }
                    title={`File this in ${bucketName.get(transaction.suggestedBudgetId) ?? "the matching bucket"}`}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-700"
                  >
                    Use this
                  </button>
                ) : null}

                <button
                  type="button"
                  disabled={pending || saving !== null}
                  onClick={() => void ignore(transaction.id)}
                  title="Keep this out of every bucket - it is neither income nor spending"
                  className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-700"
                >
                  Ignore
                </button>

                <label>
                  <span className="sr-only">
                    Send{" "}
                    {transaction.merchantName ?? transaction.name} to a bucket
                  </span>
                  <select
                    value=""
                    disabled={pending || saving !== null || buckets.length === 0}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value > 0) {
                        void assign(transaction.id, value);
                      }
                    }}
                    className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800"
                  >
                    <option value="">
                      {buckets.length === 0 ? "No buckets yet" : "Send to..."}
                    </option>
                    {buckets.map((bucket) => (
                      <option key={bucket.id} value={bucket.id}>
                        {bucket.name}
                      </option>
                    ))}
                  </select>
                </label>
              </span>
            </li>
          ))}
        </ul>
      )}

      {buckets.length === 0 ? (
        <p className="text-xs text-neutral-500">
          There are no buckets to send these to yet. Create one on the budgets
          page first.
        </p>
      ) : null}
    </div>
  );
}