# Transactions

`/transactions` filters by search text, category and **account**, all in
`searchParams` so they survive a refresh and can be shared as a link. Account
options carry the institution name too, because two banks can both have a
"Checking" and the filter is useless if they are indistinguishable.

Pagination carries every filter, not just some of them. It used to pass the
search and the category but drop the account, so paging a filtered list silently
showed a different set of transactions on page 2 while the count in the header
still described the filtered one.

`accountId` is re-checked against the caller's own accounts in `getTransactions`,
so a crafted id cannot widen the scope — it returns nothing. A filter naming an
account that isn't yours, or that no longer exists, renders as "All accounts"
rather than quietly listing everything.

## Changing a transaction's category

Click a category on the transactions page to change it. That writes
`categoryOverride` and clears `budgetId` so the engine re-routes immediately —
otherwise a re-categorised transaction would sit in a bucket that no longer
matches, and the budgets page would contradict the transactions page.

`PATCH /api/transactions/[id]` accepts `budgetId` (null clears), `categoryOverride`
and `notes`. An explicit `budgetId` in the same request wins over the clear.

## Transaction details

Clicking a transaction name opens a read-only dialog with the row already loaded
on the page: amount and date, status, category lineage, account, budget, notes,
currency, and Plaid-supplied website or logo. The launcher passes serializable data
into the client modal, so the dialog makes no additional request.

It deliberately does not show a raw original statement description. That field is
not stored; "Description from Plaid" is exactly the description Plaid already
supplied. Website links allow only HTTP(S), and logos must be HTTPS so an HTTP
image cannot become mixed-content breakage.

Bucket transactions use the dialog footer for the bucket-move selector, so each
list row keeps only the details launcher, amount, and ignore control. The selector
still writes through `PATCH /api/transactions/[id]` and uses the same lazy bucket
loading.
