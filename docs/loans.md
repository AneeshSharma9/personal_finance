# Manual loans

Debt Plaid cannot see, like a car loan from a credit union. `loans` holds the
loan; `loan_payments` is the ledger of tagged transactions paying it down.
Separate from `liabilities`, which is pinned 1:1 to a synced account and whose
balance belongs to Plaid.

Add one on **Accounts → Manual loans**: name, amount borrowed, APR, and an
optional monthly payment. Payments are recorded by rule, not entered one at a
time: see [Rules](rules.md). Each matched transaction becomes a payment.

## Interest

Simple interest on the outstanding balance, accruing daily at APR/365 from the
last accrual date. Actual/365 rather than a whole monthly step, because payments
get tagged whenever you get round to it and a fixed step would over- or
under-charge depending on when the tag lands. So a $600 payment on a $25,000 loan
at 5.9% after a month is about $121 interest and $479 of principal — the payment
does **not** retire $600 of debt.

A payment smaller than the interest it accrues produces a negative principal and
the balance grows. That is shown rather than hidden, because reporting it as
progress would make a bad loan look healthy.

## The balance is maintained by a trigger

`loans.balance` is authoritative and user-editable (click the figure to correct
it — useful for a lender adjustment or a payment made outside the app). But
tagging a transaction writes a `loan_payments` row, and a database trigger moves
the balance: `balance -= principal` on insert, `+= principal` on delete.

This lives in the database on purpose. Sync deletes transaction rows that Plaid
reports as gone, so a tagged payment can vanish without the app asking. An
API-layer adjustment would never see it happen and the loan would drift upward
forever. `accrued_from` is stored on each payment so un-tagging also rewinds the
accrual cursor; otherwise the reverted stretch of interest would never be
counted again. See `drizzle/0004_motionless_dark_beast.sql`.

Consequences worth knowing:

- Tagging a transaction to a second loan fails; `loan_payments.transaction_id`
  is unique. Un-tag first.
- Only outgoing transactions can be tagged. Plaid signs are positive for money
  out, and a loan payment is money out.
- Deleting a loan deletes its payment history with it.
- `source` records whether the payment was tagged by hand or by a rule, so
  removing a rule step undoes only its own writes. See [Rules → Undoing a
  step](rules.md#undoing-a-step).

The interest split on each payment is **stored, not recomputed**, so history stays
truthful after you correct the balance by hand.

Arithmetic lives in `src/lib/loan-math.ts` as pure functions, tested in
`tests/loan-math.test.mts`. API: `GET|POST /api/loans`, `PUT|DELETE
/api/loans?id=`.
