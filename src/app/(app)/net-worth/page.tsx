import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  getAccounts,
  getHoldings,
  getLiabilities,
  getManualAccounts,
  getNetWorth,
  getNetWorthHistory,
} from "@/lib/queries";
import { HoldingsList } from "@/components/holdings-list";
import { NetWorthChart } from "@/components/net-worth-chart";

export const metadata: Metadata = { title: "Net worth · Finance" };

export default async function NetWorthPage() {
  const user = await requireUser();

  const [netWorth, history, accounts, holdings, liabilities, manual] =
    await Promise.all([
      getNetWorth(user.id),
      getNetWorthHistory(user.id),
      getAccounts(user.id),
      getHoldings(user.id),
      getLiabilities(user.id),
      getManualAccounts(user.id),
    ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Net worth</h1>
        <p className="text-sm text-neutral-500">
          {formatCurrency(netWorth.netWorth)}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Assets" value={netWorth.assets} />
        <Stat label="Liabilities" value={netWorth.liabilities} />
        <Stat label="Cash" value={netWorth.cash + netWorth.other} />
        <Stat label="Investments" value={netWorth.investments} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">History</h2>
        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            History builds one point per day. Plaid only reports current
            balances, so there is nothing to backfill.
          </p>
        ) : (
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            {/*
              One snapshot is enough to render. The chart draws it as a lone
              marker, because a line through a single point would imply a
              direction the data does not contain - but showing nothing at all
              for the first day read as a broken feature.
            */}
            <NetWorthChart points={history} />
            <p className="mt-2 text-xs text-neutral-500">
              {history.length === 1
                ? `1 daily snapshot, ${formatDate(history[0].date)}.`
                : `${history.length} daily snapshots, ${formatDate(history[0].date)} to ${formatDate(
                    history[history.length - 1].date,
                  )}.`}
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">Breakdown</h2>
        <dl className="space-y-1 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <Row label="Cash and checking" value={netWorth.cash} />
          <Row label="Other asset accounts" value={netWorth.other} />
          <Row
            label="Investments (holdings value)"
            value={netWorth.investments}
          />
          {/*
            Just the total here. Holdings are listed per account in the Holdings
            section further down, so repeating the same split in both places is
            noise rather than information.
          */}
          <Row label="Credit cards" value={netWorth.creditCards} negative />
          <Row label="Loans" value={netWorth.loans} negative />
      {/*
        Manual assets and liabilities are hidden rather than shown as $0.00.
        `manual_accounts` has no write path yet - no route, no insert anywhere -
        so both totals are structurally always zero and displaying them only
        implies they are being tracked. The read path, the breakdown fields and
        the snapshot keys are all left in place, so this is a display change and
        the feature can be revived without a migration.
      */}
          <div className="border-t border-neutral-200 pt-1 font-medium dark:border-neutral-800">
            <Row label="Net worth" value={netWorth.netWorth} strong />
          </div>
        </dl>
      </section>

      {liabilities.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            Loans and cards
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {liabilities.map((liability) => (
              <li
                key={liability.id}
                className="px-4 py-3 text-sm"
              >
                <p className="font-medium">{liability.accountName}</p>
                <p className="text-xs text-neutral-500">
                  {liability.kind}
                  {liability.apr
                    ? ` · ${Number(liability.apr).toFixed(2)}% APR`
                    : ""}
                  {liability.minimumPayment
                    ? ` · min ${formatCurrency(
                        Number(liability.minimumPayment),
                      )}`
                    : ""}
                  {liability.nextDueDate
                    ? ` · due ${formatDate(liability.nextDueDate)}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {holdings.length > 0 ? <HoldingsList holdings={holdings} /> : null}

      {manual.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            Manual accounts
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {manual.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{account.name}</p>
                  <p className="text-xs text-neutral-500">
                    {account.kind}
                    {account.category ? ` · ${account.category}` : ""}
                  </p>
                </div>
                <p className="shrink-0 tabular-nums">
                  {formatCurrency(Number(account.value))}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accounts.length === 0 ? (
        <p className="text-xs text-neutral-500">
          Link an institution to start tracking net worth.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 font-medium tabular-nums">
        {formatCurrency(value, { compact: true })}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
  negative = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
  negative?: boolean;
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
      <dd className="tabular-nums">
        {negative && value > 0 ? "-" : ""}
        {formatCurrency(value)}
      </dd>
    </div>
  );
}