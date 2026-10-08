import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import {
  changePeriodFrom,
  parseChangePeriod,
  resolveAccountChange,
} from "@/lib/change-period";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import {
  accruedInterest,
  payoffProgress,
  projectPayoff,
} from "@/lib/loan-math";
import {
  getAccountChanges,
  getAccounts,
  getItems,
  getLoanPayments,
  getLoans,
  getNetWorth,
  getTransactionCountsByAccount,
} from "@/lib/queries";
import { AccountChangeList } from "@/components/account-change-list";
import { AccountName } from "@/components/account-name";
import { ChangePeriodPicker } from "@/components/change-period";
import { ManualLoans } from "@/components/manual-loans";
import {
  AddAccountButton,
  PlaidLinkButton,
  ReauthButton,
} from "@/components/plaid-link-button";
import { StatusBadge } from "@/components/status-badge";
import { SyncButton } from "@/components/sync-button";
import { UnlinkButton } from "@/components/unlink-controls";

export const metadata: Metadata = { title: "Accounts · Finance" };

export default async function AccountsPage({
  searchParams,
}: PageProps<"/accounts">) {
  const user = await requireUser();
  const params = await searchParams;

  /*
   * Unlike the dashboard, the period here is chosen rather than assumed. The
   * breakdown below says "how far has each account moved", and that is a
   * different question at 30 days than it is at one night - so the window lives
   * in the URL, and defaults to the previous day because that is what someone
   * opening this page is asking. Every other window, including the whole record,
   * is one click away in the picker below.
   */
  const period = parseChangePeriod(params.change);

  const [items, accounts, netWorth, loans, accountChanges] = await Promise.all([
    getItems(user.id),
    getAccounts(user.id),
    getNetWorth(user.id),
    getLoans(user.id),
    getAccountChanges(user.id, changePeriodFrom(period)),
  ]);

  // Per-institution transaction counts, so the removal dialogs can state exactly
  // what a click will destroy rather than "some data".
  const transactionCounts = await getTransactionCountsByAccount(user.id);
  const groups = groupByType(accounts);

  /*
   * Plaid loan accounts and hand-tracked loans are deliberately separate
   * sections: the first is maintained by a sync and cannot be edited, the second
   * is the user's own figure and can be. Presenting them in one list would hide
   * which numbers are authoritative.
   */
  const linkedLoans = accounts.filter((account) => account.type === "loan");
  const manualLoans = await buildManualLoanViews(user.id, loans);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-neutral-500">
            {accounts.length} account{accounts.length === 1 ? "" : "s"} · net
            worth {formatCurrency(netWorth.netWorth)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SyncButton />
          <PlaidLinkButton />
        </div>
      </header>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No accounts yet. Use &ldquo;Link an institution&rdquo; to connect a bank.
        </p>
      ) : null}

      {/*
        Institutions are listed in their own section, always, so Unlink is
        reachable for healthy Items too. Previously it lived only inside the
        "needs attention" banner below, which renders nothing when everything is
        syncing normally.
      */}
      {items.length > 0 ? (
        <section>
          <header className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-500">
              Linked institutions
            </h2>
            <p className="text-xs text-neutral-500">
              Using {items.length} of 10 Plaid Trial Item slots
            </p>
          </header>

          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {items.map((item) => {
              const itemAccounts = accounts.filter(
                (account) => account.itemId === item.id,
              );

              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {item.institutionName ?? "Unknown institution"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {itemAccounts.length} account
                      {itemAccounts.length === 1 ? "" : "s"} · {item.environment}
                      {" · synced "}
                      {formatRelativeTime(item.lastSyncedAt?.toISOString() ?? null)}
                    </p>
                    {item.status !== "healthy" ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        {item.errorMessage ?? `Status: ${item.status}`}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={item.status} />
                    {/*
                      Update mode, so this costs no Trial slot. Unlinking to add a
                      card would, since /item/remove does not free a slot.
                    */}
                    <AddAccountButton itemId={item.id} />
                    <ReauthButton itemId={item.id} status={item.status} />
                    <UnlinkButton
                      itemId={item.id}
                      institutionName={item.institutionName}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          {/*
            Plaque the Trial-plan constraint next to the control that spends it.
            Removing an Item does not free its slot, so this is easy to get wrong
            in production.
          */}
          <p className="mt-2 text-xs text-neutral-500">
            Unlinking removes the institution, its accounts and all their
            transactions. It does <strong>not</strong> free a Trial-plan Item
            slot.
          </p>
        </section>
      ) : null}

      {/*
        Plaid loan accounts get their own section rather than appearing in the
        generic groups below, so the balance on show is clearly Plaid's.
      */}
      {linkedLoans.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            Linked loans
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {linkedLoans.map((account) => (
              <li key={account.id}>
                {/*
                  Whole row is the link, matching the loan cards. That was only
                  possible once the remove button moved to this account's own
                  page: a button cannot be nested inside an anchor, and a
                  row-sized link wrapping "remove this" is a misclick.
                */}
                <Link
                  href={`/accounts/${account.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <div className="min-w-0">
                    <AccountName
                      name={account.displayName}
                      plaidName={account.name}
                      className="block truncate font-medium"
                    />
                    <p className="text-xs text-neutral-500">
                      {account.institutionName ?? "Unknown institution"}
                      {account.mask ? ` ····${account.mask}` : ""} · balance
                      comes from the sync
                    </p>
                  </div>
                  <p className="shrink-0 font-medium tabular-nums">
                    {formatCurrency(Number(account.currentBalance))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ManualLoans initialLoans={manualLoans} />

      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            {group.title}
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {group.list.map((account) => (
              <li key={account.id}>
                <Link
                  href={`/accounts/${account.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <div className="min-w-0">
                    <AccountName
                      name={account.displayName}
                      plaidName={account.name}
                      className="block truncate font-medium"
                    />
                    <p className="text-xs text-neutral-500">
                      {account.institutionName ?? "Unknown institution"}
                      {account.mask ? ` ····${account.mask}` : ""}
                      {account.subtype ? ` · ${humanize(account.subtype)}` : ""}
                      {/* Plain text; it is a link on this account's own page. */}
                      {transactionCounts.get(account.id)
                        ? ` · ${transactionCounts.get(account.id)} transactions`
                        : ""}
                    </p>
                  </div>
                  <p className="shrink-0 font-medium tabular-nums">
                    {formatCurrency(Number(account.currentBalance))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/*
        The breakdown sits with the Totals card rather than above the account
        lists, because it answers a summary question - "how did the total get
        here" - rather than "which accounts do I have". The lists above show
        live balances straight from Plaid; this shows recorded ones with the
        movement between them, which is a different and slower-moving thing, and
        putting the two side by side without saying so would look like a
        disagreement rather than a difference of basis.
      */}
      {accounts.length > 0 ? (
        <section>
          <header className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-500">
              Change by account
            </h2>
            <ChangePeriodPicker current={period} />
          </header>
          <AccountChangeList
            rows={accountChanges.map((row) => resolveAccountChange(row, period))}
            // The lists above already link every account to its own page; making
            // these rows links too would repeat the same destination three times
            // on one page. On /net-worth, which has no account list, they do.
            linkToAccounts={false}
          />
        </section>
      ) : null}

      {accounts.length > 0 ? (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Totals</h2>
          <dl className="space-y-1 text-sm">
            <Row label="Cash" value={netWorth.cash + netWorth.other} />
            <Row label="Investments" value={netWorth.investments} />
            <Row label="Credit cards" value={netWorth.creditCards} />
            <Row label="Loans" value={netWorth.loans} />
            <div className="border-t border-neutral-200 pt-1 font-medium dark:border-neutral-800">
              <Row label="Net worth" value={netWorth.netWorth} strong />
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt
        className={
          strong ? "font-medium" : "text-neutral-600 dark:text-neutral-400"
        }
      >
        {label}
      </dt>
      <dd className="tabular-nums">{formatCurrency(value)}</dd>
    </div>
  );
}

function groupByType(accounts: Awaited<ReturnType<typeof getAccounts>>) {
  const order: { title: string; types: string[] }[] = [
    { title: "Cash", types: ["depository"] },
    { title: "Credit cards", types: ["credit"] },
    // "loan" is excluded: Plaid loans render in their own section above.
    { title: "Investments", types: ["investment"] },
    { title: "Other", types: ["other"] },
  ];

  return order
    .map(({ title, types }) => ({
      title,
      list: accounts.filter((account) => types.includes(account.type)),
    }))
    .filter((group) => group.list.length > 0);
}

/**
 * Assemble what ManualLoans needs: the stored row, the interest accrued since
 * the last payment, the payoff estimate, and the payment history.
 *
 * The interest split on each payment is stored, not recomputed, so history stays
 * truthful even after the user corrects the balance by hand.
 */
async function buildManualLoanViews(
  userId: string,
  loans: Awaited<ReturnType<typeof getLoans>>,
) {
  const today = new Date().toISOString().slice(0, 10);

  return Promise.all(
    loans.map(async (loan) => {
      const payments = await getLoanPayments(userId, loan.id);

      return {
        id: loan.id,
        name: loan.name,
        kind: loan.kind,
        apr: loan.apr,
        principal: loan.principal,
        balance: loan.balance,
        paymentAmount: loan.paymentAmount,
        openedOn: loan.openedOn,
        lastAccruedAt: loan.lastAccruedAt,
        notes: loan.notes,
        pendingInterest: accruedInterest({
          balance: loan.balance,
          apr: loan.apr,
          fromDate: loan.lastAccruedAt ?? loan.openedOn,
          toDate: today,
        }),
        projection: projectPayoff({
          balance: loan.balance,
          apr: loan.apr,
          payment: loan.paymentAmount,
        }),
        // Computed here rather than in the component: lib/loan-math is
        // server-only and ManualLoans is a client component, so it arrives as
        // data for the same reason pendingInterest and projection do.
        progress: payoffProgress({
          balance: loan.balance,
          principal: loan.principal,
        }),
        payments: payments.map((payment) => ({
          id: payment.id,
          transactionId: payment.transactionId,
          amount: payment.amount,
          interest: payment.interest,
          principal: payment.principal,
          paidOn: payment.paidOn,
          payee: payment.payee,
        })),
      };
    }),
  );
}

function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}