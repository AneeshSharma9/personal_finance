import Link from "next/link";

import { AccountName } from "@/components/account-name";
import { TapToRevealName } from "@/components/account-rename";
import { splitByLiability, type ResolvedAccountChange } from "@/lib/change-period";
import { isRenamedName } from "@/lib/account-name";
import { formatCurrency, formatDate } from "@/lib/format";

/**
 * Net worth, one account at a time, with how far each has moved.
 *
 * The total above it answers "am I up or down"; this answers "which account did
 * it". Those are different questions and the aggregate genuinely cannot answer
 * the second one: a $400 drop is a car payment in one account and nothing at all
 * in nine, and only naming them says so.
 *
 * A server component on purpose. Every figure comes from the nightly job, so there
 * is nothing to fetch on the client and nothing to keep in step with it — a change
 * period is a URL parameter (see `ChangePeriodPicker`), which also means this list
 * is linkable and works with JavaScript off.
 *
 * **One row per line, deliberately.** This started with an institution line under
 * the name and three sentences of basis below the list, and both went: the block is
 * read as a quick answer to "which one moved", and on a page whose headline number
 * is right above it, three sentences of caveat push the numbers off the screen. The
 * load-bearing facts survive in a single line below and in each row's `title` — the
 * balance shown is the newest *recorded* one rather than Plaid's live figure,
 * because that is the reading the change is measured to. Mixing the two would print
 * a balance from one day and a change against another, and the two would not add up
 * to each other, which is exactly the arithmetic the list exists to make checkable.
 */
export function AccountChangeList({
  rows,
  /** False where the page already links every account to its own page. */
  linkToAccounts = true,
}: {
  rows: ResolvedAccountChange[];
  linkToAccounts?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">No accounts to break down.</p>;
  }

  const { assets, liabilities } = splitByLiability(rows);

  return (
    <div className="space-y-3">
      {/* Separate lists rather than one ranked one — see splitByLiability. */}
      {[
        { title: "Assets", list: assets },
        { title: "Liabilities", list: liabilities },
      ]
        .filter((group) => group.list.length > 0)
        .map((group) => (
          <section key={group.title}>
            <h3 className="mb-1 text-xs text-neutral-500">{group.title}</h3>
            <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {group.list.map((row) => (
                <Row
                  key={row.accountId}
                  row={row}
                  linkToAccount={linkToAccounts}
                />
              ))}
            </ul>
          </section>
        ))}

      <p className="text-xs text-neutral-500">
        Recorded balances, not live figures — the nightly job writes one per account
        per day, and each change is measured against the reading its row names.
      </p>
    </div>
  );
}

function Row({
  row,
  linkToAccount,
}: {
  row: ResolvedAccountChange;
  linkToAccount: boolean;
}) {
  const body = (
    <>
      {/*
        The two variants differ only in what a tap can do here. On /accounts these
        rows are plain, so the name expands to reveal the bank's on touch; on
        /net-worth the row is the link to the account's own page and a button
        nested in an anchor is invalid, so the name keeps the tooltip only.
      */}
      {linkToAccount ? (
        <AccountName
          name={row.name}
          plaidName={row.plaidName}
          className="min-w-0 truncate text-sm"
        />
      ) : (
        <TapToRevealName
          name={row.name}
          plaidName={row.plaidName}
          className="min-w-0"
        />
      )}
      <span className="shrink-0 text-right">
        <span className="block text-sm font-medium tabular-nums">
          {row.latest === null ? "—" : formatCurrency(row.latest.value)}
        </span>
        <span
          className={`block text-xs tabular-nums ${
            row.change === null || row.good === null
              ? "text-neutral-500"
              : row.good
                ? "text-green-700 dark:text-green-400"
                : "text-red-700 dark:text-red-400"
          }`}
        >
          {changeLabel(row)}
        </span>
      </span>
    </>
  );

  const classes =
    "flex items-center justify-between gap-3 px-4 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900";

  return (
    <li>
      {linkToAccount ? (
        /*
          The dates are in the `title` rather than the row. They are what makes the
          figure checkable, and they are also long enough to turn every row into two
          lines - so they stay available on hover without costing the scan.
        */
        <Link
          href={`/accounts/${row.accountId}`}
          className={classes}
          title={rowTitle(row)}
        >
          {body}
        </Link>
      ) : (
        <div className={classes} title={rowTitle(row)}>
          {body}
        </div>
      )}
    </li>
  );
}

/** "+$120.55 since Oct 6", or why there isn't one. */
function changeLabel(row: ResolvedAccountChange): string {
  if (row.change === null || row.from === null) {
    return row.latest === null
      ? "not recorded yet"
      : "nothing to compare against";
  }
  const sign = row.change >= 0 ? "+" : "";
  return `${sign}${formatCurrency(row.change)} since ${formatDate(row.from.date)}`;
}

/** The full record behind a row: what is held, and what it was measured against. */
function rowTitle(row: ResolvedAccountChange): string {
  const balance =
    row.latest === null
      ? "no balance recorded"
      : `${formatCurrency(row.latest.value)} recorded ${formatDate(row.latest.date)}`;
  const change =
    row.change === null || row.from === null
      ? "no earlier reading to compare against"
      : `${row.change >= 0 ? "+" : ""}${formatCurrency(row.change)} since ${formatDate(
          row.from.date,
        )}`;
  // A renamed account's row would otherwise name the account by a name the bank
  // does not recognise, in the one tooltip on the page that explains the row.
  const renamed = isRenamedName(row.name, row.plaidName);
  const label = renamed ? `${row.name} (${row.plaidName})` : row.name;
  return `${label} — ${balance}, ${change}`;
}