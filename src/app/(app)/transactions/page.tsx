import type { Metadata } from "next";

import { requireUser } from "@/lib/auth";
import { CategoryEditor } from "@/components/category-editor";
import { formatCurrency, formatDate } from "@/lib/format";
import { getAccounts, getCategories, getTransactions } from "@/lib/queries";

export const metadata: Metadata = { title: "Transactions · Finance" };

const PAGE_SIZE = 50;

/**
 * Transaction list.
 *
 * Filters live in searchParams so they survive a refresh and can be shared as a
 * link. `searchParams` is a Promise in Next.js 16.
 */
export default async function TransactionsPage({
  searchParams,
}: PageProps<"/transactions">) {
  const user = await requireUser();
  const params = await searchParams;

  const category = singleParam(params.category);
  const search = singleParam(params.q);
  const accountId = Number.parseInt(singleParam(params.accountId) ?? "", 10);
  const page =
    Math.max(
      1,
      Number.parseInt(singleParam(params.page) ?? "1", 10) || 1,
    );

  const [{ rows, total }, categories, accounts] = await Promise.all([
    getTransactions(user.id, {
      category,
      search,
      accountId: Number.isInteger(accountId) ? accountId : undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getCategories(user.id),
    getAccounts(user.id),
  ]);

  // A filter naming an account that is not the user's, or that no longer exists,
  // renders as "All accounts" rather than silently listing everything.
  const account = Number.isInteger(accountId)
    ? accounts.find((row) => row.id === accountId)
    : undefined;

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="text-sm text-neutral-500">
          {total.toLocaleString("en-US")} transaction
          {total === 1 ? "" : "s"}
          {account ? ` in ${account.name}` : ""}
          {category ? ` in ${category}` : ""}
          {search ? ` matching "${search}"` : ""}
        </p>
      </header>

      <form
        method="GET"
        action="/transactions"
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex-1 basis-40">
          <span className="mb-1 block text-xs text-neutral-500">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="Merchant or description"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>

        <label className="basis-40">
          <span className="mb-1 block text-xs text-neutral-500">Category</span>
          <select
            name="category"
            defaultValue={category ?? ""}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        {/*
          The account filter. The accounts page links here with accountId already
          set, which is why the query already supported it - only the control was
          missing.
        */}
        <label className="basis-40">
          <span className="mb-1 block text-xs text-neutral-500">Account</span>
          <select
            name="accountId"
            defaultValue={account ? String(account.id) : ""}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">All accounts</option>
            {accounts.map((row) => (
              <option key={row.id} value={row.id}>
                {/* Institution in the label: two banks can both have a
                    "Checking" and the filter is useless if they are
                    indistinguishable. */}
                {row.name}
                {row.institutionName ? ` · ${row.institutionName}` : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Apply
        </button>

        {/*
          Every filter is a GET field, so submitting re-runs the search from page
          one. Carrying ?page= would land on an out-of-range page whenever the
          filtered result set is smaller than the current one.
        */}
        {category || search || account ? (
          <a
            href="/transactions"
            className="rounded-md px-2 py-2 text-sm underline"
          >
            Clear
          </a>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No transactions match.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((row) => (
            <li key={row.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {row.merchantName ?? row.name ?? "Unknown"}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1 text-xs text-neutral-500">
                    {formatDate(row.date)} ·
                    <CategoryEditor
                      transactionId={row.id}
                      displayCategory={row.displayCategory}
                      categoryOverride={row.categoryOverride}
                      plaidCategoryPrimary={row.plaidCategoryPrimary}
                      options={categories}
                    />
                    {" · "}
                    {row.accountName}
                    {row.pending ? " · pending" : ""}
                  </p>
                </div>
                {/* signedAmount is negative for spending, which reads naturally
                    as a debit beside a merchant name. */}
                <p
                  className={`shrink-0 font-medium tabular-nums ${
                    row.signedAmount < 0
                      ? ""
                      : "text-green-700 dark:text-green-400"
                  }`}
                >
                  {formatCurrency(row.signedAmount, { showSign: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 ? (
        <nav className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <a
              href={buildHref({ q: search, category, accountId: account?.id, page: page - 1 })}
              className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700"
            >
              Previous
            </a>
          ) : (
            <span />
          )}
          <span className="text-neutral-500">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <a
              href={buildHref({ q: search, category, accountId: account?.id, page: page + 1 })}
              className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700"
            >
              Next
            </a>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Pagination has to carry every filter, not just some of them.
 *
 * It carried only the search and the category, so paging a filtered-by-account
 * list silently dropped the account and showed a different set of transactions
 * on page 2 - with the count in the header still describing the filtered one.
 */
function buildHref({
  q,
  category,
  accountId,
  page,
}: {
  q?: string;
  category?: string;
  accountId?: number;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (accountId !== undefined) params.set("accountId", String(accountId));
  params.set("page", String(page));
  return `/transactions?${params.toString()}`;
}

/** searchParams values can be string | string[]; take the first. */
function singleParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}