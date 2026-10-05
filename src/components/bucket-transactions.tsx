"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { TransactionDetailsButton } from "@/components/transaction-details";
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
  bucketName,
}: {
  transactions: BucketTransaction[];
  currentBucketId: number;
  bucketName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

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
    setMoveError(null);
    const response = await fetch(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budgetId: targetBucketId }),
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setMoveError(data.error ?? "Could not move that transaction.");
      return;
    }
    startTransition(() => router.refresh());
  }

  /**
   * Ignore / un-ignore a row without moving it.
   *
   * The row keeps its bucket: `excluded` only stops it counting towards the
   * total, so the user can still see and reverse the decision in place.
   */
  async function setExcluded(transactionId: number, excluded: boolean) {
    setError(null);
    const response = await fetch(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded }),
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? "Could not update that transaction.");
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
      {error ?? moveError ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error ?? moveError}
        </p>
      ) : null}

      <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {transactions.map((transaction) => (
          <li
            key={transaction.id}
            className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 ${
              transaction.excluded
                ? "text-neutral-400 dark:text-neutral-500"
                : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <TransactionDetailsButton
                transaction={{
                  id: transaction.id,
                  title:
                    transaction.merchantName ?? transaction.name ?? "Unknown",
                  bankDescription: transaction.name,
                  signedAmount: transaction.signedAmount,
                  date: transaction.date,
                  authorizedDate: transaction.authorizedDate,
                  pending: false,
                  excluded: transaction.excluded,
                  accountName: transaction.accountName,
                  bucketName,
                  categoryDisplay: transaction.displayCategory,
                  categoryOverride: transaction.categoryOverride,
                  plaidCategoryPrimary: transaction.plaidCategoryPrimary,
                  plaidCategoryDetailed: transaction.plaidCategoryDetailed,
                  notes: transaction.notes,
                  currency: transaction.isoCurrencyCode,
                  website: transaction.website,
                  logoUrl: transaction.logoUrl,
                }}
                buttonClassName="block w-full truncate rounded-md px-1 py-0.5 text-left text-sm font-medium transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700"
                footer={
                  <div>
                    <label className="block">
                      <span className="mb-1 block text-xs text-neutral-500">
                        Move to another bucket
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
                        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800"
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
                    {moveError ? (
                      <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                        {moveError}
                      </p>
                    ) : null}
                  </div>
                }
              />
              <p className="text-xs text-neutral-500">
                {formatDate(transaction.date)} &middot;{" "}
                {transaction.displayCategory}
              </p>
            </div>

            <p
              className={`shrink-0 text-sm tabular-nums ${
                transaction.excluded ? "line-through" : ""
              }`}
            >
              {formatCurrency(transaction.signedAmount, { showSign: true })}
            </p>

            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void setExcluded(transaction.id, !transaction.excluded)
              }
              aria-pressed={transaction.excluded}
              title={
                transaction.excluded
                  ? "Count this transaction again"
                  : "Ignore this transaction"
              }
              aria-label={
                transaction.excluded
                  ? `Stop ignoring ${transaction.merchantName ?? transaction.name}`
                  : `Ignore ${transaction.merchantName ?? transaction.name}`
              }
              className={`shrink-0 rounded p-1 transition hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
                transaction.excluded
                  ? "text-neutral-500 dark:text-neutral-400"
                  : "text-neutral-300 hover:text-neutral-600 dark:text-neutral-600 dark:hover:text-neutral-300"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="h-4 w-4"
              >
                {/* Eye */}
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="2.5" />
                {/* Slash, only when ignored. */}
                {transaction.excluded ? <path d="M3 3l18 18" /> : null}
              </svg>
            </button>

          </li>
        ))}
      </ul>
    </div>
  );
}