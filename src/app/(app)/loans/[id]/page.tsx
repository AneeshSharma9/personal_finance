import type { Metadata } from "next";
import Link from "next/link";

import { BackLink } from "@/components/back-link";
import { LoanActions } from "@/components/loan-actions";
import { TrendChart } from "@/components/trend-chart";
import { requireUser } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/format";
import { accruedInterest, loanBalanceSeries, projectPayoff } from "@/lib/loan-math";
import {
  getLoanBalanceHistory,
  getLoanPayments,
  getLoans,
} from "@/lib/queries";

export const metadata: Metadata = { title: "Loan · Finance" };

/**
 * One manual loan: its details, how far it has come down, and every action that
 * used to sit inline on the accounts page.
 *
 * The balance chart is reconstructed from the payment ledger rather than read
 * from a snapshot table, so it is complete from the first payment - see
 * `loanBalanceSeries`. The accounts list shows only a figure; seeing it fall is
 * the point of the page.
 */
export default async function LoanPage({ params }: PageProps<"/loans/[id]">) {
  const user = await requireUser();
  const { id: rawId } = await params;

  const loanId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(loanId) || loanId <= 0) return <NotFound />;

  const loans = await getLoans(user.id);
  const loan = loans.find((row) => row.id === loanId);
  // 404 rather than a redirect: a loan that is not the user's should be
  // indistinguishable from one that does not exist.
  if (!loan) return <NotFound />;

  const [history, payments] = await Promise.all([
    getLoanBalanceHistory(user.id, loanId),
    getLoanPayments(user.id, loanId),
  ]);

  const balance = Number(loan.balance);
  const principal = Number(loan.principal);
  const today = new Date().toISOString().slice(0, 10);

  const pendingInterest = accruedInterest({
    balance,
    apr: Number(loan.apr),
    fromDate: loan.lastAccruedAt ?? loan.openedOn,
    toDate: today,
  });

  const projection = projectPayoff({
    balance,
    apr: Number(loan.apr),
    payment: Number(loan.paymentAmount),
  });

  const paid = principal > 0 ? ((principal - balance) / principal) * 100 : null;
  // Reconstructed here too, so the header's starting figure and the chart's
  // first point cannot disagree.
  const opening = loanBalanceSeries({
    openedOn: loan.openedOn,
    balance,
    payments: payments.map((payment) => ({
      paidOn: payment.paidOn,
      principal: payment.principal,
    })),
    today,
  })[0];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-xs text-neutral-500">
          <Link href="/accounts" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
            Accounts
          </Link>{" "}
          · Manual loans
        </p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {loan.name}
            </h1>
            <p className="text-sm text-neutral-500">
              {Number(loan.apr).toFixed(2)}% APR
              {loan.paymentAmount !== null
                ? ` · ${formatCurrency(Number(loan.paymentAmount))}/mo`
                : ""}
              {` · opened ${formatDate(loan.openedOn)}`}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold tabular-nums">
              {formatCurrency(balance)}
            </p>
            <p className="text-xs text-neutral-500">
              of {formatCurrency(principal)} borrowed
            </p>
          </div>
        </div>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">
          Balance over time
        </h2>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          {/*
            A loan falling is the good case, so the chart's "up is green" rule is
            inverted: here a flat line is the bad outcome, not a rising one.
          */}
          <TrendChart points={history} label="Balance owed" risingIsGood={false} />
          <p className="mt-2 text-xs text-neutral-500">
            {history.length <= 1
              ? `Nothing paid yet, so there is nothing to chart beyond ${formatCurrency(
                  balance,
                )}.`
              : `${history.length} points from ${opening ? formatCurrency(opening.balance) : "—"} on ${formatDate(
                  opening?.date ?? today,
                )} to ${formatCurrency(balance)} today.`}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Paid off" value={paid === null ? null : `${Math.max(0, Math.min(100, paid)).toFixed(0)}%`} />
        <Stat label="Payments" value={String(payments.length)} />
        <Stat label="Interest accrued" value={formatCurrency(pendingInterest)} />
        <Stat
          label="Payoff"
          value={projection ? `${projection.months} mo` : null}
        />
      </section>

      {/*
        Two facts the graph cannot show, both because the stored balance only
        moves when a payment is recorded.
      */}
      {pendingInterest > 0 ? (
        <p className="text-xs text-neutral-500">
          {formatCurrency(pendingInterest)} of interest has accrued since the last
          payment and is <strong>not</strong> in the balance above — it is applied
          when the next payment is tagged.
        </p>
      ) : null}
      <p className="text-xs text-neutral-500">
        The line is flat between payments because only a recorded payment moves the
        stored balance. Each point is the balance the payment ledger implies for
        that day, not a reading taken that day.
      </p>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">Payments</h2>
        {payments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Nothing tagged yet. Open the{" "}
            <Link href="/transactions" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
              Transactions
            </Link>{" "}
            page and pick this loan on a payment.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
            {/* getLoanPayments already returns newest first. */}
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {/* Who was paid. Without this a history of "600.00" rows is
                        not checkable against a bank statement. */}
                    {payment.payee ?? "Unknown payee"}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {formatDate(payment.paidOn)} ·{" "}
                    {payment.payee ? (
                      <Link
                        href={`/transactions?q=${encodeURIComponent(payment.payee)}`}
                        className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100"
                      >
                        view
                      </Link>
                    ) : null}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-neutral-500">
                  {formatCurrency(payment.amount)} ={" "}
                  {formatCurrency(payment.principal)} principal +{" "}
                  {formatCurrency(payment.interest)} interest
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Correcting a balance, un-tagging a payment and deleting the loan are all
        consequences of the loan, so they live on the loan's page rather than
        being crammed into the accounts list.
      */}
      <LoanActions
        loan={{
          id: loan.id,
          name: loan.name,
          balance,
        }}
        untagTargets={payments.map((payment) => ({
          transactionId: payment.transactionId,
          label: `${formatDate(payment.paidOn)} · ${
            payment.payee ?? "Unknown payee"
          }`,
        }))}
      />
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 font-medium tabular-nums">
        {value ?? <span className="text-neutral-400">—</span>}
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        That loan does not exist.{" "}
        <BackLink href="/accounts">Accounts</BackLink>
      </p>
    </div>
  );
}