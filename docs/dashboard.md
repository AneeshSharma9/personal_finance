# Dashboard

A read-only landing page: what you have, what the month looks like, and whether
the data is current. It deliberately does **not** list linked institutions or
accounts — that is `/accounts`, and duplicating it pushed the month's numbers off
the screen.

- **Net worth**, with the trend under it (`TrendChart` over the daily snapshots).
  The change under the chart is measured from the reading before the newest one,
  not from the oldest one on record; see
  [Net worth](net-worth.md#a-change-is-measured-against-a-reading-not-a-date).

  There is **no per-account breakdown here** — it moved to `/net-worth`, which is
  where the period selector lives. A per-account figure measured across a different
  window than the chart above it is worse than showing none, so it went where the
  window can be chosen rather than hardcoded to this page's basis. This chart is
  itself capped at a year (`DEFAULT_HISTORY_DAYS`), which is another reason the
  two do not belong together.
- **The month's position** — reuses `BudgetSummary`, the budgets page's own card,
  so the two cannot drift apart. Leftover, spending budget, spending, income.
  With a link to the unassigned queue when anything is unrouted.
- **Where the money went** — `BarList` over the month's bucketed spending, ranked,
  with each row's share and budget line, red when over.
- **What you own and owe** — a donut of cash, investments, credit cards and loans
  with net worth in the middle.
- **Cash flow**, last six months: money in against money out, a month that outspends
  its income turning red.
- **Loans**, with APR and percent paid.
- **Sync status**: the most recent sync across all Items, and a warning when any
  Item needs attention.

Two things about it worth knowing:

**The month is the newest one with transactions, not the calendar month.** On the
2nd, the calendar month holds almost nothing, so "this month" would read as empty
spending and full remaining — true, and useless. `/budgets` already defaults this
way, so matching it keeps the two pages telling the same story. The month is named
in the heading, because "the month" is ambiguous once that is true.

**Cash flow and Spending Budget will not tie, on purpose.** Cash flow counts every
transaction; the budget summary counts only money in a bucket. Different questions,
so they are labelled differently rather than quietly reconciled into one number.

**The page does not list accounts.** The lists exist so you can *act* — open one,
remove one, see its transactions — and duplicating them pushed the month's numbers
off the screen. "Which account did it" is a different question, but it is a
question about a *window*, and the dashboard hardcodes one (the reading before the
newest), so it lives on `/net-worth` where the window is a choice.

## Which chart, and why

The three new visual pieces are chosen by the question each one answers:

| Piece | Question | Why this form |
|---|---|---|
| `TrendChart` | How has this moved over time? | Position along a common baseline is the most accurately read encoding there is |
| `BarList` | Which is biggest, by how much? | Ten rows compared against each other. Bars, not a pie: angles and areas are read far less precisely than length |
| `Donut` | How is the total made up? | Genuinely part-to-whole, and the centre gives the arithmetic away. This is the one place a donut earns its keep |

`BarList` and `CashFlow` are plain HTML — divs sized by percentage — rather than
SVG or a chart library. Nothing here needs an axis, and a `viewBox` cannot do what
a text label does: wrap, reflow, and stay selectable and accessible for free.

## Colour

Colour is used as identity rather than decoration. The donut's five categories
have fixed colours so cash is the same indigo every render; the bar list uses one
colour for every bar with red reserved for "over budget", because colouring each
row differently would imply the buckets are different kinds of thing. A month that
outspends its income turns red because that is a verdict, not a category.

Every chart colour is Tailwind's **400** shade, not the 500s. At 500 they were too
bright against a page that is otherwise neutral greys; at 400 they sit around 70%
lightness, which is also the one band that reads against both a white card and the
`neutral-900` dark one — so no chart needs a dark-mode variant at all. The two greys
in the budget ring are empty-track colours and unrelated.
