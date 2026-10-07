# Accounts

Institutions are listed with their own section so **Unlink** is always reachable,
not only when an Item needs attention.

Every linked account — cash, credit cards, investments, other — is a link to
`/accounts/[id]`, and every manual loan is a link to `/loans/[id]`. The **whole row**
is the link, in both cases. The list is navigation only; the actions moved to
those pages.

The ordering here was not cosmetic, it was load-bearing. A row cannot be both a
link and a "remove this" button: you cannot nest a `<button>` inside an `<a>`, and
a row-sized link swallowing a destructive control is a misclick waiting to
happen. So the actions had to move *before* the row could become a link — which
is why the buttons are on the detail pages and not on the list.

- **× / remove** (now on `/accounts/[id]`) — `DELETE /api/accounts/:id`.
- **N transactions** (now on `/accounts/[id]`) — links to
  `/transactions?accountId=<id>`.
- **Correct the balance**, **un-tag a payment**, **delete loan** (now on
  `/loans/[id]`).

**Add a loan** stays on `/accounts`, because creating is a list-level action and
has nowhere else to belong.

## Holdings, two presentations

`HoldingsList` is the multi-account version for `/net-worth`: it groups positions
by account, repeats each account's name, and totals the lot. `HoldingsTable` is
the bare positions table, largest first, with no heading, no account name and no
total of its own.

An account's own page uses `HoldingsTable` and supplies its own heading and total.
Using `HoldingsList` there put the word "Holdings" twice and the same figure three
times — once as that list's grand total, once as its per-account total, once as
the single row underneath, with the account's name repeated as well.

The total is kept on the account page because it is a genuinely different number
from the balance above it: the total is what the positions are worth, the balance
is what the institution reports for the whole account, and the difference is cash
sitting alongside the investments. The page says so rather than hiding one.

- **Unlink institution** — `DELETE /api/items/:id`. Calls Plaid `/item/remove`
  first so the grant is actually revoked, then deletes the row.
  `items → accounts → transactions` cascade, along with holdings, liabilities
  and investment transactions.
- **Remove one account** — `DELETE /api/accounts/:id`. Plaid exposes no
  single-account removal (an Item is its smallest unit), so this is local only
  and leaves the rest of the institution linked.

Budget buckets **survive** both: `transactions.budget_id` is `ON DELETE SET
NULL`, so buckets report `$0` rather than disappearing.

The confirmation dialog states the real account and transaction counts and
requires typing the institution name. It also says the thing people get wrong:

> Removing an institution does **not** free one of the 10 Items on your Plaid
> Trial plan. Re-linking later creates a new one.

If the Plaid revocation call fails, local rows are still removed — orphaned data
you asked to delete is worse than a stale Item — and the response points at the
Plaid Dashboard.

Each account's **N transactions** is a link to `/transactions?accountId=<id>`.
It was the one figure on the page with no way to act on it — "1,204 transactions"
is a question — and the transactions page could already filter by account, it just
had no control for it. Zero stays plain text, because there is nothing to open.
