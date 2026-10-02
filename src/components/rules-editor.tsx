"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Toast } from "@/components/toast";
import { selectAllProps } from "@/lib/select-all";

/**
 * Rules for buckets and loans.
 *
 * A rule is one match and any number of STEPS. Each step sends matching
 * transactions somewhere different, and they do not compete: "amount 453.91 pays
 * the car loan" and "amount 453.91 lands in Car Payment" are two steps of one
 * rule, and both run, so the payment is recorded and the transaction is still
 * counted as spending.
 *
 * Because a rule is its match rather than a row, editing means loading its steps
 * into the same form that created it and saving replaces the set. That is also
 * why a second step can be added at all - an earlier version upserted on the
 * match, so adding one silently replaced the other.
 *
 * Saving a rule applies it to transactions that already exist, and removing a
 * step undoes what that step did. Both are reported rather than hidden: a rule
 * that silently matches nothing looks identical to a broken one, and an undo
 * that silently skips rows looks identical to one that worked.
 */

/** One step in the form. `id` exists only while editing, so React has a key. */
export type StepDraft = {
  id: number;
  target: "bucket" | "loan" | "ignore";
  budgetId: string;
  loanId: string;
};

export type RuleStep = {
  target: "bucket" | "loan" | "ignore";
  budgetId: number | null;
  budgetName: string | null;
  loanId: number | null;
  loanName: string | null;
};

export type Rule = {
  id: number;
  matchType: "merchant" | "category" | "amount";
  matchValue: string;
  steps: RuleStep[];
};

let draftSeq = 0;
const newStep = (): StepDraft => {
  draftSeq += 1;
  return { id: draftSeq, target: "bucket", budgetId: "", loanId: "" };
};

const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800";
const LABEL = "mb-1 block text-xs text-neutral-500";
const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

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
  const [steps, setSteps] = useState<StepDraft[]>([newStep()]);
  /**
   * Id of the rule being edited, or null for a new one.
   *
   * The match is what identifies the rule on the server, so this is only a
   * handle for the UI: it decides whether the button says Save or Update, and
   * which row is highlighted.
   */
  const [editingId, setEditingId] = useState<number | null>(null);

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

  function updateStep(id: number, patch: Partial<StepDraft>) {
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    );
  }

  function addStep() {
    setSteps((current) => [...current, newStep()]);
  }

  function removeStep(id: number) {
    // Never leave the form with no steps: a rule that matches and does nothing
    // is not a thing, so the last step has to be edited rather than removed.
    setSteps((current) =>
      current.length === 1 ? current : current.filter((step) => step.id !== id),
    );
  }

  function moveStep(id: number, delta: -1 | 1) {
    setSteps((current) => {
      const from = current.findIndex((step) => step.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function resetForm() {
    setMatchType("merchant");
    setMatchValue("");
    setSteps([newStep()]);
    setEditingId(null);
  }

  /** Load a saved rule back into the form so its steps can be changed. */
  function editRule(rule: Rule) {
    setMatchType(rule.matchType);
    setMatchValue(rule.matchValue);
    setSteps(
      rule.steps.map((step) => {
        draftSeq += 1;
        return {
          id: draftSeq,
          target: step.target,
          budgetId: step.budgetId === null ? "" : String(step.budgetId),
          loanId: step.loanId === null ? "" : String(step.loanId),
        };
      }),
    );
    setEditingId(rule.id);
    setNotice(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const response = await call("/api/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchType,
        matchValue,
        steps: steps.map((step) => ({
          target: step.target,
          budgetId: step.target === "bucket" ? step.budgetId : undefined,
          loanId: step.target === "loan" ? step.loanId : undefined,
        })),
      }),
    });
    if (!response) return;

    const data = (await response.json()) as {
      applied?: ApplyReport[];
      reverted?: RevertReport[];
      bucketed?: number;
    };

    resetForm();
    // Say what actually happened. "Moved 12 transactions" is the whole point of
    // the backfill, and reporting it is what makes a no-op legible.
    reportApplied(data.applied ?? [], data.reverted ?? [], data.bucketed ?? 0);
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
      applied?: ApplyReport[];
      bucketed?: number;
    };
    reportApplied(data.applied ?? [], [], data.bucketed ?? 0);
  }

  async function remove(id: number) {
    const response = await call(`/api/rules?id=${id}`, { method: "DELETE" });
    if (!response) return;

    const data = (await response.json()) as {
      reverted?: RevertReport[];
      bucketed?: number;
    };
    if (editingId === id) resetForm();
    reportReverted(data.reverted ?? []);
  }

  function reportApplied(
    applied: ApplyReport[],
    reverted: RevertReport[],
    bucketed: number,
  ) {
    const parts: string[] = [];

    for (const step of applied) {
      if (step.matched === 0) continue;
      parts.push(
        step.moved === 0
          ? `${step.matched} already ${where(step.target)}`
          : `moved ${step.moved} ${where(step.target)}`,
      );
    }

    for (const step of reverted) {
      if (step.reverted > 0) {
        parts.push(`undid ${step.reverted} ${where(step.target)}`);
      }
    }

    /*
     * A loan step tags payments without touching budget_id, so mention when
     * those rows also landed in a bucket. That is what makes "attach to the
     * loan, then budget it" read as one action rather than two side effects.
     */
    if (bucketed > 0) parts.push(`${bucketed} also into a bucket`);

    noticeSeq.current += 1;
    setNotice({
      id: noticeSeq.current,
      text:
        parts.length === 0
          ? "Nothing matched yet."
          : `${capitalise(parts.join(", "))}.`,
    });
  }

  function reportReverted(reverted: RevertReport[]) {
    const parts = reverted
      .filter((step) => step.reverted > 0)
      .map((step) => `undid ${step.reverted} ${where(step.target)}`);

    noticeSeq.current += 1;
    setNotice({
      id: noticeSeq.current,
      text: parts.length === 0 ? "Rule deleted." : `Rule deleted. ${capitalise(parts.join(", "))}.`,
    });
  }

  /** A step is only as valid as the target it names. */
  function stepComplete(step: StepDraft): boolean {
    if (step.target === "ignore") return true;
    return (step.target === "bucket" ? step.budgetId : step.loanId) !== "";
  }

  const canSave =
    matchValue.trim().length > 0 && steps.length > 0 && steps.every(stepComplete);

  return (
    <div className="space-y-4">
      <form
        onSubmit={save}
        className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Match on</span>
            <select
              value={matchType}
              onChange={(event) =>
                setMatchType(event.target.value as Rule["matchType"])
              }
              className={INPUT}
            >
              <option value="merchant">Merchant contains</option>
              <option value="category">Category</option>
              <option value="amount">Exact amount</option>
            </select>
          </label>

          <label className="block">
            <span className={LABEL}>
              {matchType === "amount" ? "Amount" : "Value"}
            </span>
            {matchType === "category" ? (
              <select
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                className={INPUT}
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
                {...selectAllProps}
                value={matchValue}
                onChange={(event) => setMatchValue(event.target.value)}
                placeholder={matchType === "amount" ? "453.91" : "KFC"}
                inputMode={matchType === "amount" ? "decimal" : "text"}
                className={INPUT}
              />
            )}
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className={LABEL + " mb-0"}>
              Then do each of these, in order
            </span>
            <button
              type="button"
              onClick={addStep}
              className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Add step
            </button>
          </div>

          {steps.map((step, index) => (
            <div
              key={step.id}
              className="flex flex-wrap items-end gap-2 rounded-md border border-neutral-100 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <span className="w-6 pb-2 text-center text-xs text-neutral-400">
                {index + 1}
              </span>

              <label className="block min-w-32 flex-1">
                <span className={LABEL}>Send to</span>
                <select
                  value={step.target}
                  onChange={(event) =>
                    updateStep(step.id, {
                      target: event.target.value as StepDraft["target"],
                    })
                  }
                  className={INPUT}
                >
                  <option value="bucket">A budget bucket</option>
                  <option value="loan">A loan</option>
                  <option value="ignore">Ignore (count as neither)</option>
                </select>
              </label>

              <label className="block min-w-40 flex-1">
                <span className={LABEL}>
                  {step.target === "ignore"
                    ? "Effect"
                    : step.target === "bucket"
                      ? "Bucket"
                      : "Loan"}
                </span>
                {step.target === "ignore" ? (
                  <p className="rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-700">
                    Excluded from income and spending entirely.
                  </p>
                ) : step.target === "bucket" ? (
                  <select
                    value={step.budgetId}
                    onChange={(event) =>
                      updateStep(step.id, { budgetId: event.target.value })
                    }
                    className={INPUT}
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
                    value={step.loanId}
                    onChange={(event) =>
                      updateStep(step.id, { loanId: event.target.value })
                    }
                    className={INPUT}
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

              <span className="flex items-center gap-1 pb-1">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => moveStep(step.id, -1)}
                  title="Move this step earlier"
                  aria-label={`Move step ${index + 1} earlier`}
                  className={ICON_BUTTON}
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
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={index === steps.length - 1}
                  onClick={() => moveStep(step.id, 1)}
                  title="Move this step later"
                  aria-label={`Move step ${index + 1} later`}
                  className={ICON_BUTTON}
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
                    <path d="M12 5v14" />
                    <path d="m19 12-7 7-7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={steps.length === 1}
                  onClick={() => removeStep(step.id)}
                  title="Remove this step and undo what it did"
                  aria-label={`Remove step ${index + 1}`}
                  className={`${ICON_BUTTON} hover:text-red-600 dark:hover:text-red-400`}
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
                    <path d="M6 6l12 12" />
                    <path d="M18 6 6 18" />
                  </svg>
                </button>
              </span>
            </div>
          ))}
        </div>

        <p className="text-xs text-neutral-500">
          {matchType === "amount"
            ? "Matches that exact figure, in or out. Every step runs, so a loan step and a bucket step can both apply to the same transactions. A loan step only sends outgoing transactions."
            : "Every step runs against every match, past and future, and the page reports how many each one moved."}
        </p>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSave || pending}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {editingId === null ? "Save rule" : "Update rule"}
          </button>
          {editingId === null ? null : (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Cancel edit
            </button>
          )}
        </div>
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
              className={`flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 ${
                editingId === rule.id ? "bg-neutral-50 dark:bg-neutral-900" : ""
              }`}
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {rule.matchType === "merchant"
                    ? `Merchant contains "${rule.matchValue}"`
                    : rule.matchType === "amount"
                      ? `Amount is ${rule.matchValue}`
                      : `Category ${rule.matchValue}`}
                </p>
                <ol className="mt-0.5 space-y-0.5 text-neutral-500">
                  {rule.steps.map((step, index) => (
                    <li key={`${rule.id}-${index}`}>
                      <span className="text-neutral-400">{index + 1}.</span>{" "}
                      {describeStep(step)}
                    </li>
                  ))}
                </ol>
              </div>
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
                  disabled={pending}
                  onClick={() => editRule(rule)}
                  title="Edit the steps of this rule"
                  aria-label={`Edit the rule ${rule.matchType} ${rule.matchValue}`}
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
                    <path d="M4 20h4L20 8l-4-4L4 16z" />
                    <path d="m14 6 4 4" />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void remove(rule.id)}
                  className="text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
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

type ApplyReport = { moved: number; matched: number; target: string };
type RevertReport = { target: string; reverted: number; kept: number };

/** "pays the car loan" - the step, as a clause hanging off the match. */
function describeStep(step: RuleStep): string {
  if (step.target === "loan") return `pays ${step.loanName ?? "a loan"}`;
  if (step.target === "ignore") return "is ignored";
  return `goes to ${step.budgetName ?? "a bucket"}`;
}

/** The same wording again, for a toast about what a step just did. */
function where(target: string): string {
  if (target === "loan") return "to the loan";
  if (target === "ignore") return "out of your budget";
  return "to the bucket";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}