"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { selectAllProps } from "@/lib/select-all";

/**
 * The destructive and correcting actions for one loan.
 *
 * Lives on /loans/[id] rather than inline on the accounts list. A row there is a
 * link now, and you cannot put a button inside an anchor — so either the row
 * stops being a link, or the actions move. They moved, which also means "correct
 * the balance" is next to the balance it corrects.
 *
 * Every call here goes through an existing route: `PUT /api/loans` for the
 * balance correction, `PATCH /api/transactions/[id]` to un-tag a payment (which
 * lets the trigger put the money back), and `DELETE /api/loans` for the loan.
 */
export function LoanActions({
  loan,
  untagTargets,
}: {
  loan: { id: number; name: string; balance: number };
  /** Payments that can be un-tagged from here. */
  untagTargets: { transactionId: number; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState(String(loan.balance));

  async function call(input: string, init: RequestInit) {
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
    } catch {
      setError("Could not reach the server.");
      return null;
    }
  }

  async function saveBalance() {
    const response = await call("/api/loans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: loan.id, balance: balanceInput }),
    });
    if (response) setEditingBalance(false);
  }

  async function untag(transactionId: number) {
    await call(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loanId: null }),
    });
  }

  async function remove() {
    if (!confirm(`Delete "${loan.name}" and its payment history?`)) return;
    await call(`/api/loans?id=${loan.id}`, { method: "DELETE" });
  }

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div>
          <p className="font-medium">Correct the balance</p>
          <p className="text-xs text-neutral-500">
            For a lender correction or an untagged payment. Every point on the
            chart above moves by the same amount, so the line stays coherent.
          </p>
        </div>
        {editingBalance ? (
          <span className="inline-flex items-center gap-1">
            <input
              {...selectAllProps}
              value={balanceInput}
              onChange={(event) => setBalanceInput(event.target.value)}
              inputMode="decimal"
              aria-label="Current balance"
              className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-800"
            />
            <button
              type="button"
              onClick={saveBalance}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-700"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingBalance(false)}
              className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700 px-1"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setBalanceInput(String(loan.balance));
              setEditingBalance(true);
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700 shrink-0"
          >
            Edit balance
          </button>
        )}
      </div>

      {untagTargets.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700">
            Un-tag a payment ({untagTargets.length})
          </summary>
          <p className="mt-1 text-xs text-neutral-500">
            Removing a tag deletes the payment and returns its principal to the
            balance. The interest split it recorded goes with it.
          </p>
          <ul className="mt-2 divide-y divide-neutral-100 text-xs dark:divide-neutral-800">
            {untagTargets.map((target) => (
              <li
                key={target.transactionId}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void untag(target.transactionId)}
                  className="rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700 shrink-0 disabled:opacity-50"
                >
                  Un-tag
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm dark:border-neutral-800">
        <p className="text-xs text-neutral-500">
          Deleting removes the loan and its payment history. Budget buckets and
          transactions survive.
        </p>
        <button
          type="button"
          onClick={() => void remove()}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
        >
          Delete loan
        </button>
      </div>
    </section>
  );
}