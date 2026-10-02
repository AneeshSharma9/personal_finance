"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { formatCurrency, formatPercent } from "@/lib/format";
import { selectAllProps } from "@/lib/select-all";

/**
 * Manual loans section for /accounts.
 *
 * A loan is debt the user tracks by hand because Plaid cannot see it. Each entry
 * is a link to /loans/[id], which carries the balance chart, the payment history,
 * the balance correction, un-tagging and delete.
 *
 * That split is deliberate. Every one of those actions was inline here, and a row
 * that is simultaneously a link and a delete button is ambiguous to click and
 * impossible to make accessible - you cannot nest a button inside an anchor. The
 * list is now navigation; the consequences live on the thing you opened.
 *
 * Adding a loan stays here, because creating is a list-level action and has
 * nowhere else to belong.
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
  /**
   * Percent of the original principal already retired, computed on the server.
   *
   * It lives in `lib/loan-math.ts`, which is `server-only`, and this is a client
   * component — so it arrives as data rather than being recomputed here. Same
   * reason `pendingInterest` and `projection` are passed in.
   */
  progress: number | null;
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

      {/*
        Shaped like every other list on /accounts: one bordered container with
        dividers between rows. These were separate bordered cards with gaps between
        them, which made the section read as a different kind of thing rather than
        as more accounts - and on a narrow screen the gaps were most of the
        difference.
      */}
      <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {initialLoans.map((loan) => (
          <LoanCard key={loan.id} loan={loan} />
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
            {...selectAllProps}
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
            {...selectAllProps}
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
            {...selectAllProps}
            value={apr}
            onChange={(event) => setApr(event.target.value)}
            placeholder="5.9"
            inputMode="decimal"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Field>
        <Field label="Monthly payment (optional)">
          <input
            {...selectAllProps}
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
}: {
  loan: ManualLoan;
}) {
  return (
    <li>
      {/*
        `items-center`, `px-4 py-3` and `shrink-0` are copied from the account and
        linked-loan rows rather than chosen.

        They are what stops this card breaking on a phone. `flex-wrap` used to be
        here, so when the two columns stopped fitting, the balance dropped onto a
        second line and jumped to the left edge - one long name and one short
        loan rendered as a ragged two-row block. Without `shrink-0` the amount could
        also be squeezed mid-number. Now the row holds its shape all the way down,
        exactly like the cards above it.
      */}
      <Link
        href={`/loans/${loan.id}`}
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        <div className="min-w-0">
          <p className="truncate font-medium">{loan.name}</p>
          <p className="truncate text-xs text-neutral-500">
            {formatPercent(loan.apr)} APR
            {loan.paymentAmount !== null
              ? ` · ${formatCurrency(loan.paymentAmount)}/mo`
              : ""}
            {loan.progress !== null
              ? ` · ${loan.progress.toFixed(0)}% paid`
              : ""}
            {loan.payments.length > 0
              ? ` · ${loan.payments.length} payment${loan.payments.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-medium tabular-nums">
            {formatCurrency(loan.balance)}
          </p>
          <p className="text-xs text-neutral-500">
            of {formatCurrency(loan.principal)} borrowed
          </p>
        </div>
      </Link>
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