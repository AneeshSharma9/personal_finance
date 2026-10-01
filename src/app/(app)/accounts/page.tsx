import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import {
  getAccounts,
  getItems,
  getNetWorth,
  getTransactionCountsByAccount,
} from "@/lib/queries";
import { PlaidLinkButton, ReauthButton } from "@/components/plaid-link-button";
import { StatusBadge } from "@/components/status-badge";
import { SyncButton } from "@/components/sync-button";
import {
  RemoveAccountButton,
  UnlinkButton,
} from "@/components/unlink-controls";

export const metadata: Metadata = { title: "Accounts · Finance" };

export default async function AccountsPage() {
  const user = await requireUser();

  const [items, accounts, netWorth] = await Promise.all([
    getItems(user.id),
    getAccounts(user.id),
    getNetWorth(user.id),
  ]);

  // Per-institution transaction counts, so the removal dialogs can state exactly
  // what a click will destroy rather than "some data".
  const transactionCounts = await getTransactionCountsByAccount(user.id);
  const groups = groupByType(accounts);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
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
          No accounts yet. Use &ldquo;Link an account&rdquo; to connect a bank.
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

      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            {group.title}
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {group.list.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{account.name}</p>
                  <p className="text-xs text-neutral-500">
                    {account.institutionName ?? "Unknown institution"}
                    {account.mask ? ` ····${account.mask}` : ""}
                    {account.subtype ? ` · ${humanize(account.subtype)}` : ""}
                    {transactionCounts.get(account.id)
                      ? ` · ${transactionCounts.get(account.id)} transactions`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <p className="font-medium tabular-nums">
                    {formatCurrency(Number(account.currentBalance))}
                  </p>
                  <RemoveAccountButton
                    accountId={account.id}
                    accountName={account.name}
                    transactionCount={transactionCounts.get(account.id) ?? 0}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {accounts.length > 0 ? (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Totals</h2>
          <dl className="space-y-1 text-sm">
            <Row label="Cash" value={netWorth.cash + netWorth.other} />
            <Row label="Investments" value={netWorth.investments} />
            <Row label="Manual assets" value={netWorth.manualAssets} />
            <Row label="Credit cards" value={netWorth.creditCards} />
            <Row label="Loans" value={netWorth.loans} />
            <Row
              label="Manual liabilities"
              value={netWorth.manualLiabilities}
            />
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
    { title: "Loans", types: ["loan"] },
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

function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}