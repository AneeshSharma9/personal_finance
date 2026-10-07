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

The chart draws from a **single** snapshot, as a lone marker with no line and no
fill, and says so underneath. One point is one point, and a line through it would
imply a direction the data does not contain. With two or more it renders normally.
Nothing to show at all is a separate case, and only that one is worth treating as
a fault: Plaid reports current balances only, so there is nothing to backfill and
a single day is genuinely one point.

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
