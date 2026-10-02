"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { formatCurrency, formatDate } from "@/lib/format";
import type { BucketTransaction } from "@/lib/queries";

/**
 * Transactions in a bucket, each reassignable to any other bucket.
 *
 * Writes `budgetId` through PATCH /api/transactions/[id]. The rule engine only
 * fills in null assignments, so a move made here is durable: a later sync or
 * rule change will not move it back.
 */
export function BucketTransactions({
  transactions,
  currentBucketId,
}: {
  transactions: BucketTransaction[];
  currentBucketId: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // All buckets the transaction could move to, fetched lazily and cached for the
  // session so each row's picker doesn't refetch.
  const [buckets, setBuckets] = useState<
    { id: number; name: string }[] | null
  >(null);
  const [loadError, setLoadError] = useState(false);

  async function ensureBuckets() {
    if (buckets !== null || loadError) return;
    const response = await fetch("/api/budgets");
    if (!response.ok) {
      setLoadError(true);
      return;
    }
    const data = (await response.json()) as {
      groups: Record<string, { id: number; name: string }[]>;
    };
    const flat = Object.values(data.groups).flat();
    setBuckets(flat.filter((b) => b.id !== currentBucketId));
  }

  async function move(transactionId: number, targetBucketId: number) {
    setError(null);
    const response = await fetch(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budgetId: targetBucketId }),
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? "Could not move that transaction.");
      return;
    }
    startTransition(() => router.refresh());
  }

  if (transactions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Nothing landed in this bucket for this month.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {transactions.map((transaction) => (
          <li
            key={transaction.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {transaction.merchantName ?? transaction.name ?? "Unknown"}
              </p>
              <p className="text-xs text-neutral-500">
                {formatDate(transaction.date)} &middot;{" "}
                {transaction.displayCategory}
              </p>
            </div>

            <p className="shrink-0 text-sm tabular-nums">
              {formatCurrency(transaction.signedAmount, { showSign: true })}
            </p>

            <label className="shrink-0">
              <span className="sr-only">
                Move {transaction.merchantName ?? transaction.name}
              </span>
              <select
                defaultValue=""
                disabled={pending}
                onFocus={ensureBuckets}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value > 0) {
                    void move(transaction.id, value);
                  }
                }}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
              >
                <option value="">Move to...</option>
                {buckets === null ? (
                  <option disabled>loading...</option>
                ) : (
                  buckets.map((bucket) => (
                    <option key={bucket.id} value={bucket.id}>
                      {bucket.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}