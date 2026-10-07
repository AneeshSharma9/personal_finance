# Budgets

Modelled on Rocket Money's layout: **Budget Basics** (automatic bills, utilities,
savings goals) and **Budget Categories** (flexible spending), each with
`Budgeted` / `Actual` per row, plus Earnings and a Spending Budget footer.

## Buckets come from your own transactions

There are no template buckets. The options on the budgets page are the categories
actually present in your transactions, so a bucket is always something you really
spend on. Category values are **not** validated against a frozen list, because
Plaid moved to a PFC **v2** taxonomy for Items created after 2025-12-03 and a
hardcoded enum would go stale.

There used to be a seeded list of suggested buckets merged into those options.
It was removed: it offered category values nobody had transacted in —
`LOAN_PAYMENTS`, `BANK_FEES`, `SAVINGS` — and every bucket created from one was a
bucket with no real boundary. That is how "Loan Payments Car Payment" and
"Savings & Debt" came to exist and compete for the same transactions. A
transaction's own Plaid category is the honest unit of a bucket.

A row stores two deliberately separate things:

- `name` — the display label, free-form and yours ("Bills & Utilities").
- `categories` — the Plaid categories its Actual is measured against. A **list**,
  because a real spending bucket is rarely one category: "Weekend" is dining *and*
  entertainment, "Amazon" is general merchandise *and* online shopping. It was a
  single `text` column, which forced a choice between a vague name and several
  buckets fighting over the same transactions.

  Empty means display-only. Migration `0014` backfilled it from the old single
  value, so no bucket lost the category it was already measuring against.

## Where a bucket is configured: `/budgets/buckets`

Adding a bucket, deleting one, and choosing which categories it matches all live on
their own page, reached by **Buckets** in the budgets page header.

They were in three places: an "Add bucket" control on each section of the budgets
page, a delete `×` on every row there, and the category matcher on the bucket's own
transactions page. So configuring a bucket meant moving between three screens, and
none of them was the screen where buckets live. The budgets page was carrying four
controls per row that all navigated somewhere else.

The split is by question, not by convenience:

- **`/budgets`** — what you budgeted against what you spent. The budgeted amount is
  edited here and shown read-only on the buckets page; one editor per figure, or they
  drift apart.
- **`/budgets/buckets`** — what a bucket *is*. Name, categories, add, delete.
- **`/budgets/[id]`** — what is *in* it. The transaction list, and reassignment.

The bucket detail page carries no editor and says so, pointing at the buckets page.
It used to hold the matcher as a disclosure, which arrived with a strip of chips and a
picker that crowded out the transactions underneath it — a page about a list of
transactions had a configuration form in it.

`isActive` in the nav already treats `/budgets/*` as Budgets, so the new page lights up
the same nav item without a change.

## How a bucket's categories are edited

In a **Match transactions by category** disclosure per bucket, on the buckets page.
The disclosure gained a `flush` variant there: as a standalone card its border says
"this is a thing you open", nested inside a row that already has one it read as a box
inside a box. The summary line is the title and nothing
else; it used to append the current list, which restated what the panel underneath
shows the moment you open it and made the collapsed row twice as tall as needed.

On the row it was a strip of removable chips plus a "+ category" button and an inline
picker. A row is a grid cell, so the chips wrapped, the button wrapped, and a bucket
with three categories turned one line of a financial table into five. The budgets
page is for comparing figures at a glance, and "which categories does this claim" is
not comparable at a glance — it is per-bucket detail, one click away.

The trade is real: from the table you can no longer tell an auto-matched bucket from
a display-only one. That is the right trade for a page whose job is scanning numbers.

The disclosure also says the thing that is easy to get wrong — a transaction already
filed keeps its bucket even if the category that put it there is later removed, since
rules only decide future transactions and anything still unassigned.

Saving goes through the same `PUT /api/budgets` the table uses, which upserts on
(user, kind, name). That is why the component is passed the bucket's `budgeted`
figure: the endpoint writes the whole row, and sending it back unchanged is what
stops an edit to one category silently resetting the month's figure.

`claimedBy` is built server-side — category to owning bucket, excluding this one and
excluding the catch-all — so the client cannot disagree with the editor's own list
about who owns a category.

The picker has a search box, because real data has a few dozen distinct Plaid
categories and the list is unusable without one. It matches both the display name
and the raw value, since people search for either. **Searching widens the list rather
than narrowing the addable one**: filtering to only what can be added means searching
for a category another bucket already has returns nothing at all, which reads as "no
such category" when it is right there in the user's own transactions. So a search
shows every match and the taken ones are struck through, disabled, and attributed to
the bucket holding them.

The panel also states what "no categories" means, because the obvious reading is
wrong. Such a bucket is not inert — merchant rules, amount rules and explicitly
tagged loan payments all still route into it. An earlier version called this
"display only", which claimed the opposite, and several of the user's buckets are
funded entirely by tagged loan payments while claiming nothing at all.

An already-claimed category is **greyed out** in the picker rather than hidden,
with a tooltip naming the bucket that has it. Hiding it meant a category that had
gone somewhere else simply stopped being offerable, and the only symptom was that
the bucket could never match anything again with nothing to say why. Sharing is
still permitted — the editor greys the option, but a direct `PUT` allows it — and
when it happens only the first bucket in display order ever matches while the
second reads $0 forever, silently.

## Naming a bucket yourself

**Add bucket** opens a form, not a list to pick from. The name is yours; the
category is optional.

Pick a category chip to fill both in at once, then edit the name, or skip the chips
entirely and type a name with **Nothing - display only** selected. That creates a
row that claims no transactions — the right shape for a bucket like "Vacation
fund" that you are planning for rather than tracking. A display-only bucket's
Actual stays 0 until you route something into it, which you can do with a rule
step on `/rules` (see [Rules](rules.md#a-rule-is-a-match-plus-steps)).

Bucket names are unique **per group**, so "Bills & Utilities" can exist under both
Budget Basics and Budget Categories.

A row's group is fixed at creation: `PUT /api/budgets` uses `kind` as part of its
upsert key and never rewrites it, so moving a bucket between Budget Basics and
Budget Categories means deleting and recreating it (which cascades away any rule
pointing at it). Worth knowing, because the group is not purely cosmetic — see
[Budget groups are not cosmetic](rules.md#budget-groups-are-not-cosmetic).

## Summary and month navigation

The **Summary** card shows leftover as `Spending Budget − Spending`, drawn as a
ring that turns amber past 90% and red when over budget. Underneath: Spending
Budget, Spending, Remaining, Income.

Month switching is a strip of six tiles ending at the **current** month, with
arrows paging six months at a time. Each tile shows two bars — solid for
spending, dashed for income — on a shared scale. No future months are ever shown:
the window anchor is clamped to today in both the page and the component.

The window anchor is independent of the selected month and lives in
`?wYear=&wMonth=`, defaulting to today. That separation matters because the
selected month defaults to the newest month *with data* — otherwise the current
month would never appear whenever the two differ.

A **Year** dropdown covers the years that actually have transactions.

## Reading the numbers

The **Budgeted** column is a money field, not a text label: it formats to
`$1,550` as you type, via `formatCurrencyInput` in `src/lib/format.ts`. Two
details make that usable rather than merely correct, and both are load-bearing:

- The format runs on **every keystroke**, so it has to be idempotent — feeding
  its own output back in is a fixed point. The usual "format on blur, strip on
  focus" trick cannot be used here because it loses the caret.
- A trailing `.` survives. Dropping it makes decimals untypable: the point
  vanishes before any digit can follow it. Fractional digits are also neither
  padded nor truncated while typing, so "1550.5" stays `$1,550.5` rather than
  jumping to `$1,550.50` and moving the caret.

`parseCurrencyInput` returns `null` for an empty field rather than `0`. Clearing
the box and typing zero are different intentions, and conflating them wipes a
real budget on blur.

The one exception is **Everything Else**, which has no field at all — see below.

Colour follows the row's group, not the arithmetic. Over budget is red for
spending and **green for income** — exceeding the target on the earnings row is
the point, and it used to render the same red as overspending. The **Spending
Budget** footer turns red when the month's actual passes the total budgeted,
which is the one figure that says whether the month worked; it was previously the
same muted grey at 40% and at 140%.

## Everything Else is the remainder, not a budget

Every other row's **Budgeted** figure is a decision you made. The remainder
bucket's is an output: your **budgeted earnings** less every amount set on the
other buckets. It is derived in `src/lib/budget-remainder.ts` on every render,
and the stored `monthlyLimit` on that row is ignored wherever a plan is built.

Which is why its cell is a figure rather than an input. A field there could only
accept a value and then discard it — typing into it would appear to work until
the next edit elsewhere on the page quietly replaced it — so the table's footer
carries the explanation instead, and editing it is done by editing something
else. Nothing is written back to the row, which is what keeps the figure correct
the moment any other bucket changes rather than only after the next save.

Consequences worth knowing:

- The **Spending Budget** total now equals the budgeted earnings by
  construction. The arithmetic that used to be the user's job on every row is the
  page's.
- Income is the **budgeted** earnings, not the money that actually arrived.
  Using actuals would mean the remainder moved as deposits landed, so a figure
  typed into Rent would quietly stop meaning what was typed.
- Over-allocating shows as a **negative** remainder rather than clamping to zero.
  Clamping would hide the shortfall *and* leave the totals adding up to more than
  the income. The note under the table says so.
- No remainder bucket means no remainder — a plan without one is reported as-is,
  not as one over-allocated by the whole income.

A bucket is only the remainder if it has **no categories** as well as the right
name (`isRemainderBucket` in `src/lib/categories.ts`). "Everything Else" plus
`[ENTERTAINMENT]` is a real bucket with a confusing name, and stays editable. If
there are somehow two, the older one takes the figure — the same first-one-wins
the routing engine uses — and the extra keeps its own limit.

**Every view that shows a limit goes through it.** The grid and the summary card
get it from `getBudgetsWithActuals` and `getBudgetSummary`; the buckets list, a
bucket's own page and the cash flow diagram use `displayLimit` over
`getBudgetLimits`. Those three are one click from the budget page, and each of them
reading `monthlyLimit` directly would put a stale figure next to a current one.

## Automatic assignment

`transactions.budget_id` holds the bucket a transaction belongs to.
`src/lib/budget-engine.ts` fills it in, with this precedence — first match wins:

1. **Merchant rules** — "contains Starbucks". Beats everything, including a
   category override, being the most explicit intent you can express.
2. **A category override**, if the transaction has one. Only the override is
   matched; Plaid's own categories are deliberately ignored, because a bucket
   whose category happens to match Plaid's value would otherwise claim the
   transaction first (buckets are evaluated in display order). If no bucket
   matches the override it falls to Everything Else rather than being misfiled.
3. **Explicit category rules** — stored in `budget_rules`.
4. **The bucket's own `categories`** — one implicit category rule per value, so
   a multi-category bucket matches all of them rather than only the first.
5. **Everything Else** — the remainder.
6. **An earnings bucket** — for money in, never for spending.

Matching is case-insensitive and boundary-aware: `FOOD` absorbs `FOOD_AND_DRINK`,
but `FOO` matches nothing. A bare substring match would let a truncated rule
swallow unrelated spending. Each match is computed once and reused — see
"Not yet built" for why that is load-bearing.

The engine only ever fills in **null** assignments, so:

- Re-running it never overwrites a manual assignment.
- Changing a rule affects future transactions and anything still unassigned.
- There is no way to clear every assignment and start over. There used to be —
  a **Re-assign everything** button, and `{"reset":true}` on the endpoint below.
  It cleared manual assignments too, since they were never tracked separately,
  so it was a one-click way to lose every routing decision made by hand. To move
  a transaction that is already in a bucket, assign it from the queue below or
  from the bucket's own page.

It runs after every transaction sync, on the `SYNC_UPDATES_AVAILABLE` webhook, and
on demand:

```bash
curl -X POST localhost:3000/api/budgets/apply -H 'Content-Type: application/json'

# A merchant rule routing every Starbucks charge into bucket 3.
# A rule is a match plus steps; see docs/rules.md.
curl -X PUT localhost:3000/api/rules -H 'Content-Type: application/json' \
  -d '{"matchType":"merchant","matchValue":"Starbucks",
       "steps":[{"target":"bucket","budgetId":3}]}'
```

`PUT /api/budgets` upserts on `(kind, name)`, so saving the same name again
updates the row — that is what lets the UI save on blur.

## Ignore rules run on sync, not only when you save them

There are two rule engines, and only one of them could perform an "ignore" step.

`applyRulesToHistory` (`rules.ts`) handles full steps — bucket, loan and ignore — but
is called from exactly one place: `api/rules/route.ts`, when a rule is saved.
`applyBudgetRules` (`budget-engine.ts`) runs after every Plaid sync and webhook, and
only ever assigned buckets.

The cause was one line in `loadRuleSet`:

```ts
const bucketRules = rules.filter((rule) => rule.budgetId !== null);
```

Correct for routing — an ignore step has no bucket to route into — and wrong for
exclusion. Ignore rules have `budgetId = null`, so they were dropped before the matcher
saw them. The visible effect: an ignore rule worked on transactions that existed when
it was saved, and did nothing for anything that arrived afterwards. A Capital One card
payment landed in "Everything Else" as spending while every older identical payment
sat correctly ignored, thirteen of them and then a fourteenth.

Worse, it was permanent. `applyBudgetRules` only fills `budget_id IS NULL`, and
`rules.ts` documents that it "only excludes rows that have no bucket" — so once the
transaction had a bucket, nothing would ever revisit it, by either engine.

`exclusionRules` now carries the ignore steps past that filter, and
`matchesExclusion` asks the question separately from `resolveBucket`. Separate on
purpose: routing answers *where money goes*, which has no answer for "nowhere", and
`resolveBucket`'s precedence is not disturbed by this.

**Ignored and bucketed are not exclusive.** A row can be both, and the codebase
depends on it — two of the user's rules match "uas", one ignoring it and one filing it
into Savings/Debt, and the row is meant to end up excluded *and* bucketed: excluded so
it counts as neither income nor spending, bucketed so it stays visible where it was
put. An early `continue` on the ignore would have quietly broken the second rule for
every future transaction.

An unparseable amount rule parses to `NaN`, not `0`. The obvious stand-in is wrong:
`Math.abs(0 - 0) < 0.005` is true, so an unparseable rule would match every
zero-value transaction — and `Number("")` is `0` too, which is how an empty match value
gets in.

## The unassigned queue

The count on the budgets page links to `/budgets/unassigned?year=&month=`: the
month's spending with no bucket, one row per transaction, each routed by hand.

**Routing is automatic and there is no button.** `applyBudgetRules` runs after every
Plaid sync (`sync-items.ts`), after every webhook, and after every rule or merge
change, so nothing waits on the user pressing anything. The budgets page used to
carry an **Assign unassigned** button and it was a no-op in practice: with an
"Everything Else" bucket present the engine leaves nothing unrouted, because
spending that no rule claims falls through to the catch-all as its last step.
Pressing it re-ran the same matcher over the same empty set.

The budgets page now shows a warning line **only when the count is non-zero** —
"N transactions ($X) aren't in a bucket yet" — linking to the queue. Nothing is
rendered at all in the normal case.

This went through three versions, and the progression is the point. A permanent
tile with a button asked the user to do by hand what the sync had already done. A
permanent tile *explaining* that assignment was automatic and there was nothing to
press was honest but still occupied the top of the page with a non-event. A tile
that appears precisely when it has something to say needs no explanation the rest
of the time.

The count is the only signal, and it is enough: with an "Everything Else" bucket it
is 0, and it is non-zero only for a transaction that arrived before any bucket
existed or income with no earnings bucket to go to.

Rows leave the list as they are assigned, which is the confirmation. **Ignore**
takes a row out of the queue without bucketing it: `excluded` keeps it visible
and greyed rather than deleting it, so the decision stays reversible. Without it
the queue cannot be emptied honestly — some spending belongs in no bucket at all.

Both write `budgetId` / `excluded` through `PATCH /api/transactions/[id]`, the
same route the bucket detail page uses. Since the engine only fills nulls, a
choice made here is durable and a later sync will not undo it.

Every row shows **what the engine would do with it** before you touch anything,
computed by `suggestBucketAssignments` — the same `resolveBucket` and the same
`RuleSet` that **Assign unassigned** uses, run over rows that are still null and
never written. **Use this** files it in one click. A transaction with no match says
so rather than showing nothing.

The preview matters because of how the engine treats its own output: it only ever
fills nulls, so a guess you make here becomes a manual assignment and is never
revisited. Finding out where a transaction belongs *after* assigning it teaches you
nothing about whether your rules are right.

## One definition of "unassigned"

"What still needs a bucket" is defined **once**, in `unassignedSpend()`, and used
by all four places that answer it: the queue, the count on the budgets page, the
number reported after **Assign unassigned**, and the cash-flow diagram's unassigned
figure.

This was not the case. Three places each spelled out their own filters and had
already drifted: the queue filtered `amount > 0` but not `excluded`, the engine
filtered `excluded = false`, and the count filtered neither. Thirteen Discover card
payments were `excluded = true` — correct, since paying a card is not spending — so
the queue **listed** them while **Assign unassigned** was structurally incapable of
touching them. From the user's side: rows that could not be assigned no matter how
many times the button was pressed, and a count that moved by a different number
than the list.

`excluded = false` is the clause that matters and it is not cosmetic. Ignored means
the user has already answered "this is not spending", so re-surfacing it as an open
question contradicts a decision they made.

`applyBudgetRules` deliberately does **not** use the shared predicate: it scans a
superset, including money coming in and negative amounts on card accounts, because
routing income and marking a card payment excluded are both its job. The invariant
is one-directional — everything the queue shows must be reachable by the engine —
and `tests/unassigned-filter.test.mts` asserts it, because no arithmetic test can
see a disagreement between three functions.

`amount > 0` is still doing real work in that predicate: money in is routed to an
earnings bucket automatically, and money moving a credit or loan balance is
excluded as neither.

## Seeing inside a bucket on the cash flow diagram

Clicking a spending bar opens a breakdown of that bucket by category: amount, share
of the bucket, and a proportional bar. A bucket is the unit you budget in, but a
category is what you actually buy, so one fat bar cannot tell you whether a bucket
needs splitting — only its contents can.

Bars are resolved on the chart's `pointerup`, not on the bars' own `onClick`. The
pan gesture used to call `setPointerCapture` on `pointerdown`, and an element
holding pointer capture also receives the *compatibility mouse events* — `click`
included — whatever is underneath the pointer. Every click on the diagram was
therefore retargeted to the wrapper and the drill-down silently did nothing, while
keyboard activation kept working and made it look like a rendering fault. Capture
is now taken on first movement past a 5px slop threshold, so a press that turns
into a drag still pans and a press that turns into nothing reaches the bar.
`tests/sankey-interaction.test.mts` pins that ordering, since the natural
"tidy-up the drag handler" refactor would restore the bug with nothing failing.

Each expandable bar also gets a transparent hit target wider than its ~12px visible
width, because the bars worth opening are often the shortest.

It is a panel rather than a re-laid-out diagram on purpose. The ribbons are drawn in
proportion to node size, so splitting one bar into several *inside* the Sankey would
resize Rent, Groceries and every other bar. Answering "what is in this bucket" must
not move the other bars.

The breakdown comes from `getCategoryBreakdownByBucket`, summed per (bucket,
category) in SQL, and every row sums exactly to its bucket's total.

## Interaction styling: rows, buttons, back links

Three consistent treatments, all taken from what already existed in the app rather
than invented.

**Rows highlight, and the whole row is the link.** A budget row used to be clickable
only on the bucket name, with an underline appearing on hover to say so. The
underline was a poor signal for a target the size of the row, and it marked four of
the row's five columns as not clickable.

The row is now the link, via `relative` on the row plus a stretched `::after` on the
name — not an `<a>` around the row, because the row contains a real `<input>` and a
delete `<button>` and neither is valid inside an anchor. Those two controls are lifted
above the stretched overlay with `relative z-10`. **Without that they sit underneath
it**, so typing a budget amount or deleting a bucket would navigate to the bucket
page instead: a nasty failure, because the budget field is the thing you use most on
that page.

Hover is the nav's: `hover:bg-neutral-100 dark:hover:bg-neutral-800`.

**Four button styles**, and every button on the site uses one:

| | style |
|---|---|
| primary | `bg-neutral-900 text-white`, hover `bg-neutral-700` |
| danger | `bg-red-600 text-white`, hover `bg-red-700` |
| outlined | `border`, hover `bg-neutral-100` |
| ghost | no border or fill, hover `bg-neutral-100` |

Solid buttons darken rather than gaining a light background, which would wash them
out. Text buttons that were `className="text-xs underline"` became ghost buttons,
because an underlined label and a button are different things.

The dark-mode hover for a solid button is `dark:hover:bg-neutral-300`, not `-200`.
The dark primary is `dark:bg-white`, and white to `neutral-200` is imperceptible —
which is exactly how the first pass went unnoticed on every primary button in the
app, the rules page's **Save rule** included. Worth knowing when auditing: `hover:bg-*`
being present in the markup is not evidence that it is *visible*.

Two controls were missed in the first pass and are worth naming, because both looked
already-styled and neither was: the bucket page's **Previous / Next** (outlined, so
`border-neutral-300` on white reads as a button until you hover and nothing happens)
and the **Match transactions by category** disclosure (a `<summary>`, so it is not a
`<button>` at all and an audit that only counts buttons misses it permanently). An
audit of `grep -c "<button"` finds neither; the same sweep now covers `<summary>`.

**A hover colour must never also be a surface colour.** The dark-mode hover was
`dark:hover:bg-neutral-800` site-wide, chosen because it lifts off the page background
(`#171717`, a neutral-900). It was applied without checking what else is *painted*
neutral-800 — and 34 places are, including every table's column header strip.

So hovering the first row of a budgets table painted it the exact colour of the
header directly above, and the row vanished into it. It was reported as "there is no
visible border under the table headers in dark mode", which describes the symptom
accurately and not the cause: the border was fine, the row was matching the header.

It affected six components, not one. `neutral-700` is not used as a surface anywhere,
so rows and controls inside panels now hover to that — still a subtle lift against the
page, and now visible against the header too. Chrome outside those panels is
untouched, where `neutral-800` was already right.

This could not be caught by the "does every button have a hover" audit, which passed
while all of these hovers were invisible. `tests/hover-contrast.test.mts` compares the
two colour sets within each file instead, and names the header-strip case specifically
so that recolouring the header cannot quietly satisfy it.

That audit reports 50 buttons with 0 without a hover state. It resolves `className={CONST}`
references, and it strips comments first — otherwise every `<button` written inside an
explanatory comment about buttons counts as a real one, which is how two phantom
failures turned up while doing this.

**Back links are a pill.** `BackLink` is deliberately a different *shape* — borderless
`rounded-full`, muted, one step smaller, with a leading arrow that nudges left on
hover — rather than a different shade. A back link sits directly above pages full of
`rounded-md` action buttons, and two greys side by side would read as "another
button". It replaced an underlined text link, which had the opposite problem: it
looked like body text that happened to be clickable.

**No underlines remain anywhere.** The section headings were the last holdout: their
tooltip was marked with a dotted underline, which read as a rule dividing the header
from the table rather than as "this has more on it". They now use the same background
hover as every other row and control.

## Section descriptions are tooltips, not prose

`SectionHeader` (`src/components/section-header.tsx`) is shared: the budgets tables and
the buckets page both use it, so they cannot drift into looking like different
products. It carries the explanation as a `title` on the heading rather than a line of
text underneath.

They were always on screen and always the same, so they had stopped being read: three
permanent lines of static prose above the tables, pushing the numbers down. On hover
they are there when wanted and out of the way otherwise.

`title` on its own would be mouse-only — it does not fire on keyboard focus, so the
description would be unreachable without a pointer. The heading is therefore
`tabIndex={0}` with a focus ring, and the heading text carries a dotted underline to
mark it as holding more than its own words. The `ⓘ` is `aria-hidden`, because the
focusable element is the heading itself and an announced glyph would just be noise.

The buckets page uses it too, which is why its Earnings / Budget Basics / Budget
Categories headings behave identically — a `slot` prop carries the "Add bucket" button
opposite the heading, so the header component does not need to know what buttons are.

The buckets page has no prose above its own `<h1>` at all. It had a bucket count, a
one-line description of the page, and a note explaining that budgeted amounts are
edited elsewhere — three lines of static text above a page whose sections say the
same things on hover.

## Opening a bucket from the cash flow

Every row in **Where it went** links to its bucket, carrying the diagram's own
window rather than a month: `/budgets/<id>?from=2026-01-01&to=2026-10-31`. The
link is stretched over the row, because the labels are short and a link the width
of "Travel" is not a target.

The bucket page takes two kinds of window. `?year=&month=` is a single month, which
is what the budgets page and its own prev/next link to. `?from=&to=` is an arbitrary
range, which is what a year-to-date figure needs — before this, a bucket was
reachable for exactly one month at a time and a YTD total could not be opened up at
all. A malformed range falls back to the month rather than erroring, since
`?year=` on its own is a reasonable thing to type. In range mode the header shows
the transaction count and a link back to the cash flow, and the budget is scaled by
the **months the range touches** — January 1 to September 30 is 273 days but nine
monthly budgets were in play, and comparing against the wrong multiple is worse than
no comparison.

`parseDateRange` rejects impossible dates rather than passing them on: Postgres
reads `2026-02-31` as March 3rd and would quietly show the wrong rows.

## The year-to-date window ends where its month count does

`cashFlowWindow` returns `to: <year>-12-31` for a year to date but `months` set to
the number of months elapsed, which mid-year disagree — twelve months of budget
against ten months of spend.

That was harmless while the cash flow page was the only consumer, because no
transaction is dated in the future and the wider `to` returned the same rows. It
stopped being harmless once the bucket page accepted this window and scaled its own
budget by the months the range touches: the same bucket would have shown "ten months
budgeted" on one page and "twelve" on the other. `to` now ends at the last day of
the elapsed month, so the two agree by construction. A finished year is unchanged.

## The month strip

The budgets page picks its month from a strip of the selected year's twelve months,
horizontally scrolling, with the year dropdown above it on the right.

It replaced a rolling six-month window flanked by arrows, which had three problems
worth recording. Paging moved the window *and* the selection together, so the
figures below always jumped — there was no way to scroll the strip just to look
around. Six of twelve months were unreachable without paging, on a page whose
subject is a month. And the window kept its own `wYear`/`wMonth` URL parameters: a
second piece of state that could disagree with the month actually on screen. Those
parameters are deleted, not ignored; the strip is a pure function of the year.

The scrollbar is hidden (`.scrollbar-hidden`) and the fades (`.fade-edge-*`) are
the replacement affordance. The fade on each side appears **only** when there is
more of the year past it, measured on scroll, resize and content change — so at
either end of the year exactly one shows, and a strip wide enough to hold all
twelve shows neither. Measured rather than assumed because twelve tiles are close
enough to a wide desktop's width that there would otherwise be two permanent
smudges at the ends of a static row.

Three details that are easy to lose:

- **`scrollIntoView` uses `inline: "nearest"`.** A link to March must not open with
  March off-screen, but a phone shows only about three tiles, and `"start"` would
  hide everything before the selection.
- **`overscroll-x-contain`** stops a flick at the end of the year scrolling the page
  behind the strip, which is most of what makes a horizontal scroller feel broken
  on a phone.
- **The fades are `pointer-events: none`**, so a decorative gradient can never be
  the reason a tile cannot be clicked.

Future months are drawn but not linked: they cannot have transactions, so a link
would promise an empty page.

### Why the strip snaps in JavaScript

Selecting a month scrolls it fully into view, flush against whichever edge it is
nearer. That took **three** attempts, all of which failed in the same way, and the
reason is worth keeping:

A tile can only snap flush to its **start** edge, so the last tiles' snap positions
fall beyond `maxScroll` and are simply unreachable. Twelve 72px tiles with an 8px gap
is 952px of content, and at every container width narrow enough to scroll at all,
December's snap point is past the end.

1. `scroll-snap-type: x mandatory` + `snap-align: start`. Mandatory snapping had no
   valid target for the last tiles and left them wherever the scroll landed — half
   cut off.
2. `scrollIntoView({ inline: "nearest" })`. Scrolls the minimum distance to make the
   tile visible, which lands a few pixels off a boundary; the browser then
   reconciled that with the snap rule and pulled the tile back.
3. Rounding the required scroll to the nearest boundary. Rounds *away* from the
   scroll a tile needs: at 700px, September needs 20px, which rounds to 0, which
   cuts its last 12px off again.

The working version is in `src/lib/month-strip.ts`, pure and React-free, because it
has to be testable — a `"use client"` module cannot be imported by the test runner,
which resolves React through the `react-server` condition and gets a build with no
`createContext`.

The fix is **bands, not points**. `visible` is every position that shows the tile
whole; `roomy` is the subset that also leaves a gap at the edge it stops against.
Prefer `roomy`, fall back to `visible`, and never round out of `visible` — showing
the tile matters more than landing on a tidy boundary. Two details that follow from
it: an already-visible tile is left alone (otherwise the band search answers "80"
when the answer is "stay put", because zero is excluded for want of a gap), and an
off-boundary position is legitimate when no boundary fits the band.

Settling after a free drag is debounced at 140ms — long enough to outlast iOS
momentum scrolling, which keeps firing `scroll` after the finger lifts.

### The reveal and the settle must not fight

Both move the strip by assigning `scrollLeft`, which fires a scroll event, which is
what schedules the settle. That coupling took three attempts to get right:

1. Selecting **December** revealed it flush right at `maxScroll`; the settle fired off
   that scroll event 140ms later, rounded the position back to a boundary, and cut
   December off again — by up to 32px. December is the only tile that can need the
   strip at `maxScroll`, and `maxScroll` is never a multiple of the stride, so it was
   the only tile that revealed off-boundary and the only one visibly wrong. Every
   other month revealed onto a boundary already, so the settle agreed with it. That
   asymmetry is why it presented as "something is off on December" rather than "the
   settling is broken".
2. The fix was to make the settle refuse any boundary that clipped the **selected**
   month. December was fixed and dragging broke: the selected month is usually
   off-screen while you browse, so the strip sprang back to it on every release and
   felt like it was fighting you. Free scrolling has to stay free.
3. The actual fix: **a scroll the component caused does not schedule a settle.**

So the division of labour is: the reveal owns "is the selected month visible", and
the settle owns only "is the strip on a tile boundary". Neither consults the other.

The end of the strip is also a resting place, not just a limit. `maxScroll` is rarely
a whole number of strides from zero — 352px at a 600px container — so rounding always
stopped short of it and the last tile could never sit flush right at rest. Whichever
of {nearest boundary, `maxScroll`} is nearer to where the drag ended wins, so the end
is reachable without making the whole strip magnetic towards it.

`tests/month-strip-interaction.test.mts` pins the event ordering (there is no DOM
harness here, and this is about ordering rather than arithmetic); the arithmetic is in
`month-strip-scroll.test.mts`. The source-level assertion that matters most is that
`settleStrip` never reaches for `selectedRef` again — that is the exact shape of the
regression, and nothing else would fail if it came back. Revealing on
selection is instant rather than animated, because it runs straight after a
navigation where Next restores scroll on its own schedule.

`tests/month-strip-scroll.test.mts` pins all twelve months as fully visible across
seven container widths, because this only ever misbehaved for the last few tiles at
particular widths — the range nobody checks by hand.

Both utilities are plain CSS in `globals.css` rather than Tailwind gradient
utilities, because that utility was `bg-gradient-to-r` in v3 and `bg-linear-to-r`
in v4 — and a build will not tell you a class name it does not recognise, it
silently emits nothing. Explicit CSS cannot be silently wrong.

## Per-bucket detail

Bucket names link to `/budgets/[id]`, carrying the month you were viewing. Every
transaction in that bucket can be moved to another bucket individually, which is
durable because the engine never overwrites a non-null assignment. Prev/Next
navigation keeps the month in context.

## Actuals are sign-aware

Spending buckets sum only outgoing amounts; earnings buckets sum incoming ones.
This is not cosmetic. Summing `abs(amount)` inflates any category holding both
directions — in this project's own data a `TRAVEL` category whose transactions
net to **$500** reports **$24,500** that way. Bucket totals reconcile to the sum
of positive transaction amounts to the cent.

Income is read from **earnings bucket assignments**, not from every negative
amount. Raw money-in includes transfers between your own accounts, which are not
income; counting them made the month strip disagree with the summary card.
