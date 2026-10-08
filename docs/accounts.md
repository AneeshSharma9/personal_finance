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

## Nicknames

An account can be given one of your own names — "Everyday", "Emergency Fund" —
which is shown everywhere instead of the bank's, in the accounts lists, the
change breakdown, net worth, and a transaction's account sub-line.

It is a nickname rather than a rename because `accounts.name` belongs to Plaid:
`syncAccounts` writes it on every sync, so a rename stored there would be reverted
by the next one, silently. The user's name lives in `accounts.name_override` and
is applied at read time (`accountDisplayName`), so it survives every sync and a
nickname is reversible rather than destructive. The bank's name is never lost —
it stays in `name` and is what comes back when you clear the nickname.

The bank's name stays reachable in three places, because a nickname that hides
what an account actually is would make a balance unrecognisable:

- **On hover** — a `title` on the name wherever it appears, via `AccountName`.
- **On tap** — `TapToRevealName` expands the name in place. Only on the change
  breakdown, and only where it is not a link: the accounts list rows are links
  from end to end, and a button nested inside an anchor is both invalid HTML and
  a misclick — the same constraint that moved the removal buttons.
- **As a detail** — `/accounts/[id]` states it outright, and offers the editor.

**Nickname this** (now on `/accounts/[id]`) — `PATCH /api/accounts/:id`. An empty
field clears the nickname rather than being rejected, so "reset to what the bank
calls it" is the same control as setting one.

The account page lists the two sides of the change separately rather than
replacing the header sub-line with the bank name, so the institution, the mask
and the official name stay on screen either way.

## Change by account

A **Change by account** section sits between the account lists and the Totals
card: every account's recorded balance and how far it has moved, over a period you
choose. The period is `?change=`, defaulting to **Previous day** — the same default
`/net-worth` uses.

Plain links, no client state, for the same reason the month strip and the cash
flow scope are URL-driven: the server already knows the answer, and the choice is
one worth being able to share — "did you mean 30 days or all time" is a real
disagreement about a number.

It offers the same periods as `/net-worth`, because there is one list. The
day-over-day option is worth having here most of all: on a page with no chart,
"which account moved since yesterday, and by how much" is the question the list is
usually opened to answer.

It used to default to **all time**, on the argument that the widest window is the
one answer that can never be wrong about which window it is describing. That was
true and it answered a question nobody was asking: the picker is right there, so
every other window is one click away, while defaulting to the widest means the
common case gets corrected on every visit. **Previous day** leads the list for the
same reason it leads `CHANGE_PERIODS`.

`DEFAULT_CHANGE_PERIOD` is now the *first* entry rather than the last, so
reordering the list cannot silently change what a bare URL means.

The balances shown are the nightly job's **recorded** ones rather than Plaid's
live `current_balance`, and the section says so. That is also why the section
exists *next to* the lists rather than inside them: the lists above show live
balances, this shows recorded ones with the movement between them, and putting
them side by side without saying so reads as a disagreement rather than a
difference of basis.

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
