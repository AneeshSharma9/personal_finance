# Plaid

## Plaid constraints this app is built around

- **10 Item limit, and `/item/remove` does NOT free a slot.** One Item is one
  bank login, however many accounts it holds. Re-auth uses Plaid Link in **update
  mode**, which never creates a new Item. Do connect/disconnect testing in
  Sandbox.
- **`days_requested` is only applied when an Item is first initialized** and
  cannot be changed later without spending another slot. It defaults to 730,
  Plaid's ceiling.
- **Investment value comes from holdings, not `current_balance`.** A brokerage's
  cash sweep can appear in both and would double count.
- **Credit and loan balances arrive from Plaid as positive amounts owed.** The raw
  sign is stored and flipped at read time, in one place.
- **Net-worth history cannot be backfilled.** Plaid reports current balances
  only, so history exists only for days you recorded.
- **Liabilities and Investments are `optional_products`** so institutions that
  don't support them can still link. Their absence is a warning, not a failure.

## Adding a bank

Before spending a Trial slot, write down every institution you want and count the
Items. Checking + savings at one bank = 1 Item. Each additional institution, card
issuer, brokerage, 401k, and loan servicer = 1 more. Ten total.

Link one real account first, confirm the sync, *then* continue.
