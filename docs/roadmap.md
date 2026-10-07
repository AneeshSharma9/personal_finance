# Roadmap

## Known issues

- **Re-calling `matchesAny` with identical arguments returned different results**
  during development — the second call returned false, so bucket resolution fell
  through to `undefined`. The file on disk was provably correct and an isolated
  copy behaved, so it could not be reproduced; it may be a toolchain artefact.
  Every call site now computes the match once into a `const`, which sidesteps it.
  If odd routing ever reappears, start there.
- Plaid's Sandbox returns the same ~16-transaction pattern for every month, so
  the month strip shows near-identical bars. Harmless, but it makes the UI look
  untested.
- Sandbox data is historical (it ends before the current month), which is why the
  budgets page defaults to the newest month *with data*.

## Not yet built

- **`/api/manual-accounts`** write routes and UI for creating manual accounts.
  The table and the net-worth read path are done. (Manual *loans* now have both
  — see [Manual loans](loans.md) — but manual assets/liabilities still do not.)
- **A payoff date you can trust.** The projection assumes a fixed monthly
  payment and monthly compounding steps. Real lenders vary, and a loan with a
  payment below its monthly interest correctly reports no payoff rather than a
  fictional one.
- **Notes UI.** `PATCH /api/transactions/[id]` accepts `notes`; nothing calls it.
- **Per-transaction overrides.** A rule step that now matches a transaction you
  have already re-assigned by hand will overwrite that choice, because saving a
  rule deliberately applies it to history. There is no per-transaction "leave this
  alone" flag. (A hand-tagged *loan* payment is the exception: it carries
  `loan_payments.source = 'manual'` and survives an undo.)
- **Budget basics detection.** Budget Basics is currently just a grouping you
  assign rows to; nothing identifies your recurring bills and pre-seeds them
  there. That needs a recurring-charge detector.
- **Moving a bucket between groups.** A row's `budget_kind` is fixed at creation,
  because `PUT /api/budgets` uses it as the upsert key and never rewrites it. A
  "Move to Budget Basics" control would need `budgetKind` in the conflict `set`,
  and would want a decision about whether it should change routing precedence
  (see [Budget groups are not cosmetic](rules.md#budget-groups-are-not-cosmetic)).
- **Real PWA testing on iPhone**, including the open question of whether OAuth
  Link works inside a home-screen web app ([docs/architecture.md](architecture.md#12-open-questions)).

The `recurring` table still exists in the schema but is unused; the Subscriptions
feature was removed. It can be dropped with a migration if you want the schema to
match the feature set exactly.
