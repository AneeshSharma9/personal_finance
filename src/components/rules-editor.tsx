"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Toast } from "@/components/toast";

/**
 * Rules for buckets and loans.
 *
 * One form covers both because the difference is only where the match ends up,
 * and splitting them would make "what happens to a KFC charge" depend on which
 * page you happened to be on.
 *
 * Saving a rule applies it to transactions that already exist, so the response
 * says how many moved and that is reported rather than hidden - a rule that
 * silently matches nothing looks identical to a broken one.
 */

export type Rule = {
  id: number;
  matchType: "merchant" | "category" | "amount";
  matchValue: string;
  target: "bucket" | "loan" | "ignore";
  budgetName: string | null;
  loanName: string | null;
  priority: number;
  active: boolean;
};

export function RulesEditor({
  initialRules,
  buckets,
  loans,
  categories,
}: {
  initialRules: Rule[];
  buckets: { id: number; name: string; kind: string }[];
  loans: { id: number; name: string }[];
  categories: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  /** Bumped per notice so the Toast remounts and replays its animation. */
  const noticeSeq = useRef(0);

  const [matchType, setMatchType] = useState<Rule["matchType"]>("merchant");
  const [matchValue, setMatchValue] = useState("");
  const [target, setTarget] = useState<"bucket" | "loan" | "ignore">("bucket");
  const [budgetId, setBudgetId] = useState("");
  const [loanId, setLoanId] = useState("");

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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const response = await call("/api/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchType,
        matchValue,
        target,
        budgetId: target === "bucket" ? budgetId : undefined,
        loanId: target === "loan" ? loanId : undefined,
      }),
    });
    if (!response) return;

    const data = (await response.json()) as {
      applied?: { moved: number; matched: number; target: string };
    };
    const applied = data.applied;

    setMatchValue("");
    // Say what actually happened. "Moved 12 transactions" is the whole point of
    // the backfill, and reporting it is what makes a no-op legible.
    if (applied) reportApplied(applied);
  }

  /**
   * Re-apply a saved rule without changing it.
   *
   * Saving already backfills, so this exists for when the world moved on:
   * transactions that synced in afterwards, or rows excluded by hand in bulk.
   */
  async function rerun(id: number) {
    const response = await call("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response) return;

    const data = (await response.json()) as {
      applied?: { moved: number; matched: number; target: string };
    };
    if (data.applied) reportApplied(data.applied);
  }

/** One phrasing for both saving and re-running, so the counts read alike. */
  function reportApplied(applied: {
    moved: number;
    matched: number;
    target: string;
  }) {
    const where =
      applied.target === "loan"
        ? "to the loan"
        : applied.target === "ignore"
          ? "out of your budget"
          : "to the bucket";

    noticeSeq.current += 1;
    setNotice({
      id: noticeSeq.current,
      text:
        applied.moved === 0
          ? applied.matched === 0
            ? "Nothing matched yet."
            : `Matched ${applied.matched}, all already up to date.`
          : `Moved ${applied.moved} transaction${
              applied.moved === 1 ? "" : "s"
            } ${where}.`,
    });
  }

  async function remove(id: number) {
    await call(`/api/rules?id=${id}`, { method: "DELETE" });
  }

  const canSave =
    matchValue.trim().length > 0 &&
    target === "ignore" || (target === "bucket" ? budgetId !== "" : loanId !== "");

  return (
    <div className="space-y-4">
      <form
        onSubmit={save}
        className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">
              Match on
            </span>
            <select
              value={matchType}
              onChange={(event) =>
                setMatchType(event.target.value as Rule["matchType"])
              }
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              <option value="merchant">Merchant contains</option>
              <option value="category">Category</option>
              <option value="amount">Exact amount</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">
              {matchType === "amount" ? "Amount" : "Value"}
            </span>
            {matchType === "category" ? (
              <select
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
              >
                <option value="">Choose a category</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                placeholder={
                  matchType === "amount" ? "600" : "KFC"
                }
                inputMode={matchType === "amount" ? "decimal" : "text"}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
              />
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Send to</span>
            <select
              value={target}
              onChange={(event) =>
                setTarget(event.target.value as "bucket" | "loan")
              }
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              <option value="bucket">A budget bucket</option>
              <option value="loan">A loan</option>
              <option value="ignore">Ignore (count as neither)</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">
              {target === "bucket" ? "Bucket" : "Loan"}
            </span>
            {target === "ignore" ? (
              <p className="rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-700">
                Matches will be excluded from your budget entirely: not counted as
                income, not counted as spending.
              </p>
            ) : target === "bucket" ? (
              <select
                value={budgetId}
                onChange={(event) => setBudgetId(event.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
              >
                <option value="">Choose a bucket</option>
                {buckets.map((bucket) => (
                  <option key={bucket.id} value={bucket.id}>
                    {bucket.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={loanId}
                onChange={(event) => setLoanId(event.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
              >
                <option value="">Choose a loan</option>
                {loans.map((loan) => (
                  <option key={loan.id} value={loan.id}>
                    {loan.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

        <p className="text-xs text-neutral-500">
          {matchType === "amount"
            ? "Matches that exact figure, in or out. Sends only outgoing transactions to a loan."
            : "Applies to past transactions as well as future ones, and reports how many it moved."}
        </p>

        <button
          type="submit"
          disabled={!canSave || pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          Save rule
        </button>
      </form>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {initialRules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No rules yet. Transactions fall into the catch-all bucket until you add
          one.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {initialRules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
            >
              <p className="min-w-0 text-sm">
                <span className="font-medium">
                  {rule.matchType === "merchant"
                    ? `Merchant contains "${rule.matchValue}"`
                    : rule.matchType === "amount"
                      ? `Amount is ${rule.matchValue}`
                      : `Category ${rule.matchValue}`}
                </span>{" "}
                <span className="text-neutral-500">
                  &rarr;{" "}
                  {rule.target === "loan"
                    ? `pays ${rule.loanName ?? "a loan"}`
                    : rule.target === "ignore"
                      ? "is ignored"
                      : rule.budgetName ?? "a bucket"}
                </span>
              </p>
              <span className="flex shrink-0 items-center gap-3">
                {/*
                  Re-apply without editing. Saving already backfills, so this is
                  for when transactions arrived afterwards or rows were excluded
                  by hand.
                */}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void rerun(rule.id)}
                  title="Re-apply this rule to all matching transactions"
                  aria-label={`Re-apply the rule ${rule.matchType} ${rule.matchValue}`}
                  className="text-neutral-400 transition hover:text-neutral-700 disabled:opacity-50 dark:hover:text-neutral-200"
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
                    {/* Circular arrow, the same glyph as the Refresh button. */}
                    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                    <path d="M20 4v7h-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => remove(rule.id)}
                  className="text-xs text-red-600 underline dark:text-red-400"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {notice ? (
        <Toast
          key={notice.id}
          message={notice.text}
          onDismiss={() => setNotice(null)}
        />
      ) : null}
    </div>
  );
}