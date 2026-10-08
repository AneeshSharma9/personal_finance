# Net worth

Assets minus liabilities across checking/savings, credit cards, loans,
investments and manual accounts. Manual loans are counted under `loans` rather
than `manualLiabilities`, so a car loan appears there whether or not Plaid can see
it.

## History needs two days to exist

`GET /api/cron/snapshot` runs two steps in order, guarded by `CRON_SECRET`. First
it syncs every Plaid Item, then it writes one snapshot row per user per day,
idempotently:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/snapshot
```

The order is the point. The snapshot records balances, and balances are only as
fresh as the last Plaid call, so syncing first means the day's row holds today's
numbers instead of whatever the last page load happened to leave behind. Reversed,
it would be a permanently one-day-stale chart and nothing downstream would notice.

**The sync is why you don't have to press Refresh.** Because the job pulls
transactions, balances, holdings and liabilities on its own, "Last synced" on the
dashboard advances while the app sits closed. It is still worth keeping the
button — it is the only way to pull a transaction that landed an hour ago.

Each step is isolated: a Plaid outage reports itself in the response and the
snapshot still lands, rather than the whole run failing and the day having no row
at all. A broken Item doesn't even fail the step — `refreshAllForItem` returns
`ok: false` and writes the Item's status, which is what surfaces the dashboard's
"needs attention" link. The response carries `sync[]` and `failedSteps[]` so the
Vercel logs say what actually happened.

**When it runs: 12:00 UTC daily, via Vercel Cron** (`vercel.json`). Nothing in
the repo invokes it on a schedule, so `npm run dev` never fires it — locally the
curl above is the only trigger. If the app has never been deployed, or
`CRON_SECRET` is unset in the Vercel project, the endpoint returns 500 and no
row is ever written.

**"0 12 * * *" does not mean 12:00:00.** On the Hobby plan Vercel invokes a cron
job *at any point within the specified hour* to spread load across accounts, so
`0 12 * * *` can fire anywhere from 12:00:00 to 12:59:59 UTC. Pro and Enterprise
get the minute specified. So a snapshot landing at 12:34 is documented behaviour,
not a misconfiguration — and worth remembering before treating a snapshot's
timestamp as precise.

**Two readings is a floor, not a preference** — it is the smallest number that can
show a movement, and reporting a change for a series that has none is exactly the
failure `seriesChange` returning null exists to prevent.

The chart **needs two readings, and says so when it has fewer.** It used to draw a
single snapshot as a lone marker with no line and caption it "one reading" —
correct, in that a line through one point asserts a direction the data does not
contain — but the wrong trade once a period selector existed. With a window to
choose, one point is a *normal* outcome rather than a first-day edge case: it is
what every period the data does not reach into produces. A bare dot with no line
and a caption underneath reads as a chart that failed to draw, which is the one
thing it must never do. So below two readings it renders a plain "No graph data
available" panel, naming the one reading it does have.



Nothing to show at all is the same panel with different words, and the one case
worth treating as a fault: Plaid reports current balances only, so there is
nothing to backfill and a single day genuinely is one point.

## Charts are visx, not hand-rolled

`trend-chart.tsx` was originally hand-rolled SVG, on the grounds that one series
in one component did not justify a dependency. That was a reasonable call at the
time and the wrong one to leave in place: it had no hover, no keyboard access to
the series at all, and raw ISO dates on the x-axis. So it now uses
[visx](https://visx.dev), installed as the individual packages the charts need
(`@visx/scale`, `@visx/shape`, `@visx/axis`, `@visx/grid`, `@visx/curve`,
`@visx/event`, `@visx/tooltip`, `@visx/sankey`) rather than the `visx` umbrella,
so nothing else gets pulled in. About **27KB gzipped** before the Sankey was
added, and it is still the only non-essential runtime dependency in the project.

The Sankey is the one place the dependency clearly earns itself: laying out
overlapping curved ribbons is real work (relaxation iterations, link routing),
and `d3-sankey` is already the reference implementation.

**A ribbon is stroked, not filled.** `sankeyLinkHorizontal()` emits only the
ribbon's *centreline* — one open curve, no closing edge — so its thickness is
carried by `stroke-width`:

```jsx
<path d={createPath(link)} fill="none" stroke={colour}
      strokeWidth={link.width} strokeOpacity={0.4} />
```

Filling it instead paints a zero-area shape, and every ribbon collapses to an
antialiased hairline. It is a quiet failure: the node bars still render at the
right heights, the paths still exist at the right coordinates, and the totals are
all correct — only the ribbons look broken, which reads as "the numbers are
wrong" rather than "the render is wrong". Worth knowing before debugging the
layout maths when it happens again.

It is now `TrendChart`, not `NetWorthChart`, and serves every graph in the app —
net worth, an account's balance, a loan paying down — because those differ only
in the label and whether a rising line is good news (`risingIsGood`: false for a
credit card or a loan). All three narrow their query rows to `SeriesPoint`
(`{ date, value }`) first, which is what lets one component serve all three.

## Where the two kinds of history come from

This is the part worth knowing before you trust a graph.

**Loans are reconstructed, not recorded.** The `loan_payments` trigger only ever
does `balance -= principal` on insert and `+= principal` on delete, so a loan's
balance on any past day is *exactly*

```
balance(D) = currentBalance + sum(principal of payments made after D)
```

`loanBalanceSeries` in `src/lib/loan-math.ts` walks the ledger backwards from
today's balance to produce that. So a loan's chart is complete from its first
payment — 15 months of real history on the Mazda 3 the moment the feature lands,
with nothing to accumulate. Points are emitted at the opening and after each
payment, not per calendar day: a day with no payment had no balance change, so a
point per day would be a straight line drawn between events that did not happen.

A hand-corrected balance shifts every point by the same amount, because it shifts
`currentBalance` and the walk backwards inherits it. The line never shows a jump
that no payment explains.

**Accounts must be recorded.** Plaid reports current balances only, and
transactions do not determine a balance — a transfer moves one without the other,
as do interest and pending authorisations. So `account_balance_snapshots` holds one
row per account per day, written by the same cron, and it **starts empty**: there
is nothing to backfill. An account page shows a "fills in from tomorrow" message
until the first few runs.

Hover and keyboard share one `activeIndex`, so the tooltip is reachable without a
mouse and there is a single code path that positions it. Arrow keys step through
the series, Escape clears it, and the accessible name says so.

Two things worth knowing if you add a chart here:

- **Measure the container; do not rely on a `viewBox`.** A `viewBox` scales the
  drawing to fit, but an HTML tooltip does not scale with it, so the two drift
  apart at any width other than the one they were designed for.
  `useMeasuredWidth` in `src/lib/use-measured-width.ts` exists for this, and
  seeds from a fallback so the server sends a real chart rather than an empty
  box that fills in on mount.
- **Keep the maths out of the component.** `nearestIndex` — which recorded day a
  pointer lands on — lives in `src/lib/series.ts`, free of any chart import, so
  it can be tested directly. Importing it from a component that pulls in visx
  drags the whole rendering stack into the test runner, and visx's tooltip
  imports `react-dom`, which does not load under this project's `react-server`
  test condition.
- **`lib/loan-math.ts` is `server-only`.** A client component cannot import it,
  which is why `ManualLoans` receives `progress` as a prop rather than calling
  `payoffProgress` itself — the same reason `pendingInterest` and `projection`
  have always been passed in.

`nearestIndex` snaps to a recorded day rather than interpolating. A pointer in a
gap between snapshots resolves to a day that exists; it will never report a
figure for a day that was never measured.

Two things about the history query that are easy to get wrong:

- `getNetWorthHistory` orders **descending** for its `limit`, then reverses.
  Ascending order with `limit: 365` returns the *oldest* 365 rows, which would pin
  the chart to the first year and stop it ever advancing.
- The snapshot upsert refreshes `breakdown_json` as well as the totals. It used
  to leave the breakdown from the day's first run, so an account linked later left
  `accountCount` stale until midnight.

## A change is measured against a reading, not a date

Every change figure in the app — the one under a chart, the one on every row of
the account breakdown — is a difference between two **recorded readings**, never
between two calendar dates. `seriesChange` in `src/lib/series.ts` is the only
place that arithmetic happens, and it has two bases:

| Basis | Measured from | Used by |
|---|---|---|
| `day` | the reading before the newest one | the dashboard, `?change=1d` |
| `period` | the oldest reading in the window | every other period |

The dashboard's used to be `period` unconditionally, which meant the figure under
a year-long chart — spanning however long this database happened to be old — was
read as "today". On a three-day-old database it was correct and on a
three-year-old one it would have been a lie. The dashboard now asks for `day`.

`/net-worth` and `/accounts` both have a `?change=` selector, and they use it for
two different things, which is deliberate:

- **`/net-worth` moves the chart's window too.** A period control that left the
  chart alone would be asking the reader to believe two things at once — "you are
  looking at 30 days" and "here is a year of line". So `changePeriodWindow` hands
  a date straight to `getNetWorthHistory`, which bounds which points exist at all:
  the chart plots what is left rather than plotting everything and labelling it.
- **`/accounts` does not**, because there is no chart on that page. The lists
  always show every account; the period only chooses what the change is measured
  against.

**That window is a date, not a count of readings**, and that is the part worth
remembering. They are interchangeable while the cron runs every day and stop being
interchangeable the moment it misses one: "30 days" as thirty rows then covers
five weeks, while the same window as a date still covers thirty days and simply
shows fewer points. A label in days can only be honoured by a date, so
`getNetWorthHistory` takes `from: string | undefined` and filters on
`snapshot_date >= from`, ascending with no limit. The
descending-limit-then-reverse dance it replaced existed only to stop
`limit: 365` returning the *oldest* 365 rows; with a floor on the date there is
nothing left for it to pin.

`getAccountBalanceHistory` still takes a **count**, and that is not an oversight:
it backs `/accounts/[id]`, which has no period selector, so "the last 365 readings"
is the whole ask and there is no label to contradict. The two functions sit next to
each other and mean different things by design, which is why both say so.

**Every period is offered on every page, including "Previous day"** — which took
getting the window wrong twice to get right, and both mistakes are worth keeping
written down.

**First wrong: excluding the option.** It was dropped from the chart pages on the
reasoning that a one-day window holds a single reading, so it cannot produce a
line. That is wrong because **the floor is inclusive**: a floor of yesterday puts
yesterday *and* today in the window, which on daily data is exactly the pair the
day-over-day change is measured between.

**Then wrong in the other direction: trusting that.** It does produce a line, but
only from about 8:34am to 8pm New York time, because two things stack:

- the day rolls over at **UTC** midnight, which is **8pm** in New York; and
- the nightly cron writes at **12:34 UTC** (`0 12 * * *`, and Vercel Hobby can fire
  it at any minute in the hour), which is **8:34am** in New York.

So a one-day floor held exactly one reading for those **twelve and a half hours** —
most of them overnight — and the chart said "No graph data available" on the option
most likely to be opened. The floor is now **`daysAgo(2)`**, which guarantees two
readings at every hour.

The cost, stated plainly: between UTC midnight and the cron, the newest reading in
the window is yesterday's, so the graph draws yesterday against the day before
rather than against today. The alternative was an empty chart for half of every day,
which is the failure that actually stops someone reading the figure.

`tests/account-change.test.mts` asserts the floor holds two readings at *every* hour
of the day, and separately that a one-day floor would fail in exactly hours 00–12 —
so the widening cannot later be mistaken for arbitrary padding, and the reason it
exists is recoverable from the test that locks it in.

Two names survived that history and are worth recognising: `CHANGE_PERIODS_WITH_WINDOW`
is now just `CHANGE_PERIODS`, and `parseChartPeriod` is an alias of
`parseChangePeriod` that used to reject the day basis. Both kept so the call sites
say what they mean and so changing either is a deliberate act rather than an edit to
something every page shares.

The genuine single-point case is still a single point — the cron missing a whole
day — and that is the "No graph data available" panel rather than a lone dot.

Both bases return **null** when there is no comparison to make, and the callers
say so. One reading is not a change of zero: `$0.00` claims the number was
measured twice and did not move, which is a much stronger claim than "nothing
recorded yet".

Three consequences worth remembering, all of which were the interesting part:

- **A gap spans, it does not zero.** The cron missed the 2nd, so "since the reading
  before the newest" is the 1st to the 3rd — which is what actually happened to
  the money. And because the row prints the date it was measured from, a
  three-day gap *says* three days instead of calling itself yesterday.
- **`day` ignores the window.** A `1d` period has no window at all; it is the
  previous reading. Otherwise it would silently become "the whole window" for any
  account with an early snapshot in it.
- **A window too narrow to hold two readings falls back to `previous`.** A one-day
  window over a daily series holds exactly one reading, so measuring the window's
  oldest against its newest is always `$0.00` — the flat-zero lie above. It uses
  the nearest real comparison and names its date.

`changeIsGood` inverts the verdict for `credit` and `loan` accounts, whose
balances count *up* as money owed, and returns `null` for no movement at all. That
`null` is a fix: `change > 0 !== isLiability` alone reports a flat checking
account as bad news and a flat credit card as good, and the same expression was
painting `TrendChart`'s line — a net worth that had not moved was drawn red.

## The per-account breakdown

The total answers "am I up or down". It cannot answer "which account did it": a
$400 drop is a car payment in one account and nothing at all in nine. So
`AccountChangeList` prints underneath the chart on this page, and in its own
section on `/accounts`.

**It lives here rather than on the dashboard** because here the window is a choice.
A per-account figure measured across a different span than the chart above it is
worse than showing none — the totals visibly refuse to add up — so it went where
the period selector could drive both from one `?change=`. The page computes
`changePeriodWindow(period)` **once** and hands it to both queries, which is what
stops them drifting apart; `BEGINNING_OF_TIME` is only there because the breakdown
query needs a real date where the history query is happy with `undefined`.

Three decisions in it are not obvious:

- **It shows recorded balances, not `accounts.currentBalance`.** The change is
  measured to the newest reading, so showing a live balance from another day
  would print two figures that do not reconcile with each other — in the one view
  whose entire purpose is that the columns add up. The as-of date is printed for
  the same reason.
- **One row per line, and the dates are in the `title`.** It started with an
  institution line under every name and three sentences of basis below the list, and
  both went: this is read as a quick answer to "which one moved", and on a page
  whose headline number sits right above it, three sentences of caveat push the
  numbers off the screen. What survives is one line saying the balances are
  recorded rather than live — without which the list appears to disagree with the
  live figure above it — plus each row's `title`, holding the institution, the
  reading date and the date the change was measured from. That is what makes the
  figure checkable without costing the scan.
- **Assets and liabilities are separate lists** (`splitByLiability`). The sign only
  makes sense within a group: a card's balance rising is debt growing while savings
  rising is money growing, and one list ranked by movement interleaves them into
  what reads as a contradiction.
- **Rows link on `/net-worth` and not on `/accounts`.** This page has no account
  list, so the breakdown is the only route into one from here. `/accounts` has the
  lists, and linking both would repeat a destination three times on one page.
- **Investment rows are the brokerage's cash balance, not its holdings.** They are
  snapshotted at `current_balance` while net worth values them from `holdings`, so
  an investment row can sit well below the "Investments" figure above it. That one
  note was dropped with the rest of the row detail; it is the first thing to look
  for if the list seems not to add up to the total.

`getAccountChanges` is one query with three `LEFT JOIN LATERAL`s over the
`(account_id, snapshot_date)` unique index — newest reading, the reading before
it, oldest reading in the window — rather than a year of daily rows per account
reduced in JS. Note the alias for the third one is `oldest`, not `window`: `window`
is reserved in SQL and fails the entire query the first time it runs against a
database.
