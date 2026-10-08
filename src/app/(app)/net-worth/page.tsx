import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import {
  BEGINNING_OF_TIME,
  CHANGE_PERIODS_WITH_WINDOW,
  changePeriodWindow,
  parseChartPeriod,
  resolveAccountChange,
} from "@/lib/change-period";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  getAccountChanges,
  getAccounts,
  getHoldings,
  getLiabilities,
  getManualAccounts,
  getNetWorth,
  getNetWorthHistory,
} from "@/lib/queries";
import { AccountChangeList } from "@/components/account-change-list";
import { ChangePeriodPicker } from "@/components/change-period";
import { HoldingsList } from "@/components/holdings-list";
import { TrendChart } from "@/components/trend-chart";

export const metadata: Metadata = { title: "Net worth · Finance" };

/**
 * The net-worth total, its history, and what it is made of.
 *
 * The period selector moves the chart's window *and* the basis of the change
 * under it, because a period control that left the chart alone would be asking
 * the user to believe two different things at once. It is `?change=`, so a
 * particular window is a link rather than a piece of state.
 *
 * "Previous day" is deliberately absent. A one-day window is a single reading, and
 * the change it exists to show is measured against a day outside that window - so
 * honouring it here would show a graph and a figure describing different spans.
 * The day-over-day read lives on the dashboard, where it is what you want.
 */
export default async function NetWorthPage({
  searchParams,
}: PageProps<"/net-worth">) {
  const user = await requireUser();
  const params = await searchParams;
  const period = parseChartPeriod(params.change);

  /*
   * One bound for both the chart and the breakdown below it.
   *
   * They have to agree: a net worth line over 30 days beside a per-account list
   * measured across a year reads as two accounts of the truth rather than one
   * period, and the totals then visibly refuse to add up. `changePeriodWindow` is
   * `undefined` for All time, which is exactly what the history query wants; the
   * breakdown needs a real date, and `BEGINNING_OF_TIME` is its "no lower bound".
   */
  const windowFrom = changePeriodWindow(period);

  const [
    netWorth,
    history,
    accountChanges,
    accounts,
    holdings,
    liabilities,
    manual,
  ] = await Promise.all([
    getNetWorth(user.id),
    /*
     * The selected period bounds which points exist at all - the chart plots what
     * is left, rather than plotting everything and labelling it.
     */
    getNetWorthHistory(user.id, windowFrom),
    getAccountChanges(user.id, windowFrom ?? BEGINNING_OF_TIME),
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
        <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-500">History</h2>
          <ChangePeriodPicker
            current={period}
            periods={CHANGE_PERIODS_WITH_WINDOW}
          />
        </header>
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
            {/* NetWorthPoint carries assets and liabilities; the chart only
                needs the total, so it is narrowed to the common shape. */}
            <TrendChart
              points={history.map((point) => ({
                date: point.date,
                value: point.netWorth,
              }))}
              label="Net worth"
              changeBasis={period.basis}
            />
            <p className="mt-2 text-xs text-neutral-500">
              {history.length === 1
                ? `1 daily snapshot, ${formatDate(history[0].date)}.`
                : `${history.length} daily snapshots, ${formatDate(history[0].date)} to ${formatDate(
                    history[history.length - 1].date,
                  )}.`}
            </p>
          </div>
        )}

        {/*
          The breakdown is here rather than on the dashboard because this is where
          the period selector lives, and a per-account figure measured across a
          different window than the chart above it is worse than not showing one at
          all - the totals would visibly refuse to add up. One `?change=` drives
          both, so they cannot drift apart.

          Rows link to the accounts themselves: this page has no account list, so
          the breakdown is the only route into one from here. On `/accounts` the
          lists above already do that job and the rows there do not link.
        */}
        {accountChanges.length > 0 ? (
          <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <h3 className="mb-2 text-sm font-medium text-neutral-500">
              Which accounts moved
            </h3>
            <AccountChangeList
              rows={accountChanges.map((row) =>
                resolveAccountChange(row, period),
              )}
            />
          </div>
        ) : null}
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