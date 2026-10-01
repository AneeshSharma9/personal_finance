import { getAccounts, getItems, getNetWorth } from "@/lib/queries";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { SyncButton } from "@/components/sync-button";

export default async function DashboardPage() {
  // `getItems` etc. take the user id rather than reading the session again, so
  // the layout stays the single place that resolves it.
  const { getCurrentUser } = await import("@/lib/auth");
  const user = await getCurrentUser();
  if (!user) return null;

  const [items, accounts, netWorth] = await Promise.all([
    getItems(user.id),
    getAccounts(user.id),
    getNetWorth(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-neutral-500">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <SyncButton />
      </header>

      {items.length === 0 ? (
        <section className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <h2 className="mb-1 font-medium">No accounts linked yet</h2>
          <p className="mx-auto max-w-sm text-sm text-neutral-500">
            Link your first bank to start tracking balances and transactions.
            Each bank login uses one of the 10 Items on your Plaid Trial plan,
            so link only what you need.
          </p>
          <a
            href="/accounts"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2.5 font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Link an account
          </a>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Net worth" value={netWorth.netWorth} />
            <Stat label="Cash" value={netWorth.cash + netWorth.other} />
            <Stat label="Investments" value={netWorth.investments} />
            <Stat
              label="Debt"
              value={netWorth.creditCards + netWorth.loans}
            />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-neutral-500">
              Linked institutions
            </h2>
            <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {item.institutionName ?? "Unknown institution"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {item.environment} · synced{" "}
                      {formatRelativeTime(item.lastSyncedAt?.toISOString() ?? null)}
                    </p>
                  </div>
                  <StatusBadge status={item.status} />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-neutral-500">
              Using {items.length} of the 10 Items on your Plaid Trial plan.
              Slots are permanent: removing an institution does not free one.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-neutral-500">
              Accounts
            </h2>
            <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {accounts.slice(0, 8).map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate">{account.name}</p>
                    <p className="text-xs text-neutral-500">
                      {account.institutionName ?? "Unknown"}
                      {account.mask ? ` ····${account.mask}` : ""}
                    </p>
                  </div>
                  <p className="shrink-0 tabular-nums">
                    {formatCurrency(Number(account.currentBalance))}
                  </p>
                </li>
              ))}
            </ul>
            {accounts.length > 8 ? (
              <a
                href="/accounts"
                className="mt-2 inline-block text-sm text-neutral-600 underline dark:text-neutral-400"
              >
                View all {accounts.length} accounts
              </a>
            ) : null}
          </section>
        </>
      )}
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