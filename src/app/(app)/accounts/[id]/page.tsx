import type { Metadata } from "next";
import Link from "next/link";

import { AccountNameEditor } from "@/components/account-rename";
import { BackLink } from "@/components/back-link";
import { HoldingsTable, totalValue } from "@/components/holdings-list";
import { TrendChart } from "@/components/trend-chart";
import { RemoveAccountButton } from "@/components/unlink-controls";
import { isRenamedName } from "@/lib/account-name";
import { requireUser } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  getAccountBalanceHistory,
  getAccountForUser,
  getHoldings,
  getTransactionCountsByAccount,
} from "@/lib/queries";

export const metadata: Metadata = { title: "Account · Finance" };

/**
 * One linked account: its details, its balance over time, and the actions that
 * used to sit inline on the accounts page.
 *
 * The actions moved here rather than staying on the list, because a row that is
 * both a link and a delete button is ambiguous to click and impossible to make
 * accessible: you cannot nest a button inside an anchor, and a row-sized link
 * swallowing a "remove this" control is a misclick waiting to happen. The list is
 * now a set of links; the consequences live on the thing you opened.
 *
 * Credit and loan balances count *up* as bad news, so `risingIsGood` is derived
 * from the account type rather than assumed.
 */
export default async function AccountPage({
  params,
}: PageProps<"/accounts/[id]">) {
  const user = await requireUser();
  const { id: rawId } = await params;

  const accountId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(accountId) || accountId <= 0) return <NotFound />;

  const account = await getAccountForUser(user.id, accountId);
  // 404 rather than a redirect: an id that is not the user's should be
  // indistinguishable from one that does not exist.
  if (!account) return <NotFound />;

  const [history, holdings, transactionCounts] = await Promise.all([
    getAccountBalanceHistory(user.id, accountId),
    getHoldings(user.id),
    getTransactionCountsByAccount(user.id),
  ]);

  const balance = Number(account.currentBalance);
  const isLiability = account.type === "credit" || account.type === "loan";
  const transactionCount = transactionCounts.get(accountId) ?? 0;
  const accountHoldings = holdings.filter(
    (holding) => holding.accountId === accountId,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-xs text-neutral-500">
          <Link href="/accounts" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
            Accounts
          </Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <AccountNameEditor
              accountId={accountId}
              name={account.displayName}
              plaidName={account.name}
            />
            <p className="text-sm text-neutral-500">
              {account.institutionName ?? "Unknown institution"}
              {account.mask ? ` ····${account.mask}` : ""}
              {account.officialName && account.officialName !== account.name
                ? ` · ${account.officialName}`
                : ""}
            </p>
            {/*
              The bank name is a detail here rather than only a tooltip. This is the
              one page where it is not competing for a line, so a renamed account
              states it outright instead of leaving it to a hover that a phone
              cannot perform. Reversed against `accountNameHint` - real name first -
              because the display name is the heading directly above this and
              repeating it would be noise; "(renamed)" is what carries the label.
            */}
            {isRenamedName(account.displayName, account.name) ? (
              <p className="text-sm text-neutral-500">
                {account.name} (renamed)
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold tabular-nums">
              {formatCurrency(balance)}
            </p>
            {/*
              A credit or loan balance is money owed, so it is labelled as such
              rather than left to look like a cash balance that happens to be
              negative in effect.
            */}
            <p className="text-xs text-neutral-500">
              {isLiability ? "owed" : humanize(account.type)}
              {account.subtype ? ` · ${humanize(account.subtype)}` : ""}
            </p>
          </div>
        </div>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">
          Balance history
        </h2>
        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            One reading per day, recorded by the nightly job. Plaid reports
            current balances only, so there is nothing to backfill — this fills in
            from tomorrow.
          </p>
        ) : (
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <TrendChart
              points={history}
              label={isLiability ? "Balance owed" : "Balance"}
              risingIsGood={!isLiability}
            />
            <p className="mt-2 text-xs text-neutral-500">
              {history.length === 1
                ? `1 daily reading, ${formatDate(history[0].date)}.`
                : `${history.length} daily readings, ${formatDate(history[0].date)} to ${formatDate(
                    history[history.length - 1].date,
                  )}.`}
            </p>
          </div>
        )}
      </section>

      {accountHoldings.length > 0 ? (
        <section>
          {/*
            HoldingsTable, not HoldingsList. HoldingsList is the multi-account
            presentation: it brings its own "Holdings" heading, a grand total, and
            a subheading repeating the account name. Rendering it under this
            page's own heading put the same word twice and the same figure three
            times on screen - the account is already the page title here, and the
            balance is already the headline.
          */}
          <header className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-500">Holdings</h2>
            <p className="text-xs tabular-nums text-neutral-500">
              {formatCurrency(totalValue(accountHoldings))}
            </p>
          </header>
          <HoldingsTable rows={accountHoldings} />
          {/*
            The total is the sum of what the positions are worth; the balance in
            the header is what the institution reported for the whole account.
            They usually agree and occasionally do not, so saying which is which
            matters more than hiding one.
          */}
          <p className="mt-1 text-xs text-neutral-500">
            Sum of what these positions are worth. The balance above is what the
            institution reports for the account, which can also include cash.
          </p>
        </section>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="text-sm">
          {/*
            Moved here from the accounts list. Zero stays plain text, because
            there is nothing to open.
          */}
          {transactionCount > 0 ? (
            <Link
              href={`/transactions?accountId=${accountId}`}
              className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              {transactionCount} transaction
              {transactionCount === 1 ? "" : "s"}
            </Link>
          ) : (
            <span className="text-neutral-500">No transactions</span>
          )}
        </div>
        <RemoveAccountButton
          accountId={accountId}
          accountName={account.displayName}
          transactionCount={transactionCount}
        />
      </section>

      {/*
        Both figures come from Plaid's last update, so they can disagree with the
        balance above by hours. Stating where each came from is more honest than
        picking one silently.
      */}
      <p className="text-xs text-neutral-500">
        Balance from Plaid,{" "}
        {account.balanceUpdatedAt
          ? `last updated ${formatDate(account.balanceUpdatedAt.toISOString().slice(0, 10))}`
          : "not yet dated"}
        {account.availableBalance !== null
          ? ` · ${formatCurrency(Number(account.availableBalance))} available`
          : ""}
        . Balances are reported by the institution, not this app.
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        That account does not exist. <BackLink href="/accounts">Accounts</BackLink>
      </p>
    </div>
  );
}

function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}