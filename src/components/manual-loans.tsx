"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { formatCurrency, formatPercent } from "@/lib/format";

/**
 * Manual loans section for /accounts.
 *
 * A loan is debt the user tracks by hand because Plaid cannot see it. The balance
 * shown here is authoritative and editable - a lender correction or an untagged
 * payment is a real thing - but tagging a transaction in the transactions list
 * moves it too, and the split between interest and principal is decided on the
 * server so the two cannot disagree.
 */

export type ManualLoan = {
  id: number;
  name: string;
  kind: string;
  apr: number;
  principal: number;
  balance: number;
  paymentAmount: number | null;
  openedOn: string;
  lastAccruedAt: string | null;
  notes: string | null;
  pendingInterest: number;
  projection: { months: number; totalInterest: number } | null;
  payments: {
    id: number;
    transactionId: number;
    amount: number;
    interest: number;
    principal: number;
    paidOn: string;
    payee: string | null;
  }[];
};

const KINDS = [
  { value: "auto", label: "Car / auto" },
  { value: "personal", label: "Personal" },
  { value: "student", label: "Student" },
  { value: "mortgage", label: "Mortgage" },
  { value: "medical", label: "Medical" },
  { value: "other", label: "Other" },
] as const;

export function ManualLoans({ initialLoans }: { initialLoans: ManualLoan[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(initialLoans.length === 0);

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

  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-500">Manual loans</h2>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          className="text-xs font-medium text-neutral-600 underline dark:text-neutral-400"
        >
          {creating ? "Cancel" : "Add a loan"}
        </button>
      </header>

      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {creating ? (
        <LoanForm
          onDone={() => setCreating(false)}
          call={call}
          disabled={pending}
        />
      ) : null}

      {initialLoans.length === 0 && !creating ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No manual loans. Add one for debt Plaid cannot see, like a car loan
          from a credit union.
        </p>
      ) : null}

      <ul className="space-y-3">
        {initialLoans.map((loan) => (
          <LoanCard
            key={loan.id}
            loan={loan}
            call={call}
            disabled={pending}
          />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

type Call = (input: string, init: RequestInit) => Promise<Response | null>;

function LoanForm({
  onDone,
  call,
  disabled,
}: {
  onDone: () => void;
  call: Call;
  disabled: boolean;
}) {
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [apr, setApr] = useState("");
  const [payment, setPayment] = useState("");
  const [kind, setKind] = useState<string>("auto");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const response = await call("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        principal,
        apr: apr === "" ? 0 : apr,
        paymentAmount: payment === "" ? null : payment,
        kind,
      }),
    });
    if (response) onDone();
  }

  return (
    <form
      onSubmit={submit}
      className="mb-3 space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Car loan"
            required
            maxLength={80}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Field>
        <Field label="Type">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount borrowed">
          <input
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
            placeholder="25000"
            inputMode="decimal"
            required
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Field>
        <Field label="APR (%)">
          <input
            value={apr}
            onChange={(event) => setApr(event.target.value)}
            placeholder="5.9"
            inputMode="decimal"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Field>
        <Field label="Monthly payment (optional)">
          <input
            value={payment}
            onChange={(event) => setPayment(event.target.value)}
            placeholder="600"
            inputMode="decimal"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Field>
      </div>
      <p className="text-xs text-neutral-500">
        The monthly payment only drives the payoff estimate. Payments are
        recorded by tagging a transaction from the Transactions page.
      </p>
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        Add loan
      </button>
    </form>
  );
}

function LoanCard({
  loan,
  call,
  disabled,
}: {
  loan: ManualLoan;
  call: Call;
  disabled: boolean;
}) {
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState(String(loan.balance));
  const [showHistory, setShowHistory] = useState(false);

  const progress =
    loan.principal > 0
      ? Math.max(0, Math.min(100, ((loan.principal - loan.balance) / loan.principal) * 100))
      : null;

  async function saveBalance() {
    const response = await call("/api/loans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: loan.id, balance: balanceInput }),
    });
    if (response) setEditingBalance(false);
  }

  async function remove() {
    if (!confirm(`Delete "${loan.name}" and its payment history?`)) return;
    const response = await call(`/api/loans?id=${loan.id}`, { method: "DELETE" });
    if (response) setShowHistory(false);
  }

  async function untag(transactionId: number) {
    await call(`/api/transactions/${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loanId: null }),
    });
  }

  return (
    <li className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{loan.name}</p>
          <p className="text-xs text-neutral-500">
            {formatPercent(loan.apr)} APR
            {loan.paymentAmount !== null
              ? ` · ${formatCurrency(loan.paymentAmount)}/mo`
              : ""}
            {progress !== null ? ` · ${progress.toFixed(0)}% paid` : ""}
          </p>
        </div>

        <div className="text-right">
          {editingBalance ? (
            <span className="inline-flex items-center gap-1">
              <input
                value={balanceInput}
                onChange={(event) => setBalanceInput(event.target.value)}
                inputMode="decimal"
                aria-label="Current balance"
                className="w-24 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-800"
              />
              <button
                type="button"
                onClick={saveBalance}
                disabled={disabled}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
              >
                Save
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setBalanceInput(String(loan.balance));
                setEditingBalance(true);
              }}
              className="font-medium tabular-nums underline decoration-dotted"
              title="Correct the balance"
            >
              {formatCurrency(loan.balance)}
            </button>
          )}
          <p className="text-xs text-neutral-500">
            of {formatCurrency(loan.principal)} borrowed
          </p>
        </div>
      </div>

      {loan.pendingInterest > 0 ? (
        <p className="mt-2 text-xs text-neutral-500">
          {formatCurrency(loan.pendingInterest)} of interest has accrued since
          the last payment and is not in the balance above.
        </p>
      ) : null}

      {loan.projection ? (
        <p className="mt-1 text-xs text-neutral-500">
          About {loan.projection.months} monthly payments left,{" "}
          {formatCurrency(loan.projection.totalInterest)} of interest to pay.
        </p>
      ) : loan.balance > 0 ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          No payoff estimate: set a monthly payment above the interest, or the
          balance only grows.
        </p>
      ) : (
        <p className="mt-1 text-xs text-green-700 dark:text-green-400">
          Paid off.
        </p>
      )}

      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className="text-neutral-600 underline dark:text-neutral-400"
        >
          {showHistory ? "Hide" : "Show"}{" "}
          {loan.payments.length === 0
            ? "no payments"
            : `${loan.payments.length} payment${loan.payments.length === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={remove}
          className="text-red-600 underline dark:text-red-400"
        >
          Delete
        </button>
      </div>

      {showHistory ? (
        <ul className="mt-2 divide-y divide-neutral-100 border-t border-neutral-100 text-xs dark:divide-neutral-800 dark:border-neutral-800">
          {loan.payments.length === 0 ? (
            <li className="pt-2 text-neutral-500">
              Nothing tagged yet. Open the Transactions page and pick this loan on
              a payment.
            </li>
          ) : (
            [...loan.payments].reverse().map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
              >
                <span className="tabular-nums text-neutral-500">
                  {payment.paidOn}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {/* Who was paid. Without this a history of "600.00" rows is
                      not checkable against a bank statement. */}
                  {payment.payee ?? "Unknown payee"}
                </span>
                <span className="tabular-nums">
                  {formatCurrency(payment.amount)} ={" "}
                  {formatCurrency(payment.principal)} principal +{" "}
                  {formatCurrency(payment.interest)} interest
                </span>
                <button
                  type="button"
                  onClick={() => untag(payment.transactionId)}
                  className="text-neutral-600 underline dark:text-neutral-400"
                >
                  Un-tag
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}