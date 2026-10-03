# Personal Finance

A self-hosted, Rocket Money–style finance tracker built on Plaid's free Trial
plan. Web app first, installable on iPhone as a PWA.

The design and constraints this implements live in
[PLANNED_ARCHITECTURE.md](./PLANNED_ARCHITECTURE.md).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript |
| UI | Tailwind v4, mobile-first |
| Database | Postgres (Supabase) via Drizzle ORM |
| Auth | Supabase Auth, locked to an email allowlist |
| Plaid | `plaid` Node SDK + `react-plaid-link` |
| Charts | `visx` (scales, shapes, axes, tooltip) |
| Tests | `node:test` via `tsx` (137 tests) |

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Project Settings → **API** → copy `Project URL` and `anon public` key.
3. Project Settings → **Database** → **Connection string**. Pick **Session
   pooler** (or the "URI" option, which is the same thing):

   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

   Use port **5432**, not the Transaction pooler (6543) — Drizzle needs
   prepared statements.

   **Do not use the "Direct connection" option.** Its host is
   `db.<ref>.supabase.co`, which is **IPv6-only**. It often works from a laptop
   and then fails from Vercel with a 500 on every page that queries the
   database. If you already have a direct-connection URL, replace the host with
   the pooler host above and keep the password URL-encoded.
4. Authentication → Users → **Add user** with your email and a password. The app
   has no signup UI on purpose: only addresses in `ALLOWED_EMAILS` can use it.
5. Authentication → Sign In / Providers → email → disable "Allow new users to
   sign up." Not strictly required, since the allowlist is the real gate, but it
   is a free second lock.

### 2. Plaid

[dashboard.plaid.com](https://dashboard.plaid.com) → Developers → **Keys**.
Copy the Sandbox **and** Production client ID / secret; both live in `.env.local`
and `PLAID_ENV` picks which pair is used.

Sandbox login for testing: `user_good` / `pass_good`.

### 3. Environment

```bash
cp .env.example .env.local
```

`TOKEN_ENCRYPTION_KEY` and `CRON_SECRET` are already generated in the committed
`.env.local`. Everything else needs filling in.

**Back up `TOKEN_ENCRYPTION_KEY`.** Rotating or losing it makes every stored Plaid
access token undecryptable, which means losing every linked Item *and* its
Trial-plan slot. A database backup is useless without it.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4. Database

```bash
npm run db:migrate
```

Migrations are plain SQL in `drizzle/`, so you can paste them into Supabase's
SQL editor instead of running the CLI. `drizzle.config.ts` loads `.env.local`
itself — `drizzle-kit` only ever reads `.env`, which is why migrations are run
through npm rather than invoking the binary directly.

### 5. Run

```bash
npm run dev
```

Sign in at http://localhost:3000, then **Accounts → Link an account**.

## Deploying to Vercel

1. Commit and push. `.env*` is gitignored; `.env.example` is committed.
2. [vercel.com/new](https://vercel.com/new) → import the repo. Framework is
   detected automatically.
3. Add these under Settings → Environment Variables, for **both** Production and
   Preview:

   ```
   DATABASE_URL              postgresql://...:5432/postgres
   NEXT_PUBLIC_SUPABASE_URL  https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   ALLOWED_EMAILS            you@example.com
   TOKEN_ENCRYPTION_KEY
   CRON_SECRET
   PLAID_ENV                 sandbox
   PLAID_SANDBOX_CLIENT_ID
   PLAID_SANDBOX_SECRET
   PLAID_PRODUCTION_CLIENT_ID
   PLAID_PRODUCTION_SECRET
   PLAID_DAYS_REQUESTED      730
   ```

4. Deploy.
5. From the assigned domain, set and redeploy:
   `PLAID_WEBHOOK_URL=https://<domain>/api/plaid/webhook` and
   `PLAID_REDIRECT_URI=https://<domain>`. Then register the redirect URI in the
   Plaid Dashboard under Developer → OAuth.

Two things worth knowing:

- **`NEXT_PUBLIC_*` must be present at build time.** Next.js inlines them by
  substituting the literal property access, so they are baked into the client
  bundle. Adding them after a deploy requires a rebuild. A clean build with no
  env vars still succeeds — the DB client is a lazy proxy — so a missing value
  fails at runtime rather than build time.
- **Keep `PLAID_ENV=sandbox` until you are ready.** See "Adding a bank" below.

The daily snapshot cron is already configured in `vercel.json`
(`0 12 * * *`, i.e. 08:00 America/New_York). Vercel sends
`Authorization: Bearer $CRON_SECRET` automatically when that variable is set.

`0 12 * * *` means **"sometime in the 12:00 hour"**, not "at 12:00:00". On the
Hobby plan Vercel may invoke a cron job at any point within the specified hour, to
spread load across accounts — so `0 12 * * *` fires somewhere between 12:00:00
and 12:59:59 UTC. Pro and Enterprise are invoked within the minute specified.
Vercel's own docs are explicit that cron delivery is best effort: a run may be
skipped entirely on a transient network error, and the same run may occasionally be
delivered twice. This app is already idempotent (a unique index on
`user_id + snapshot_date` plus an upsert), which is exactly what that requires.

Vercel cron schedules are always UTC and cannot name a timezone, so this cannot
stay at 08:00 ET across a DST change. **On 1 November 2026** New York leaves
EDT (UTC-4) for EST (UTC-5) and the job will start firing at 07:00 local.
Change the schedule to `0 13 * * *` at that point to hold 08:00, and back to
`0 12 * * *` in March.

The endpoint fails closed: with `CRON_SECRET` unset it returns 500 rather than
running, so a missing variable is visible instead of silently leaving the
snapshot table empty. It still 401s if Vercel's copy of the variable is missing
or stale - check the deployment logs, not just your local `.env.local`.

### Diagnosing a bad deploy

`GET /api/health` checks that the database is reachable and that the required
secrets are present, returning 503 with a per-check breakdown. It is gated by
`CRON_SECRET` so it can't be used to probe infrastructure.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/health
```

```json
{"ok":true,"checks":{
  "database":{"ok":true,"detail":"1 users"},
  "encryptionKey":{"ok":true},
  "plaid":{"ok":true,"detail":"sandbox"},
  "allowedEmails":{"ok":true}}}
```

The usual cause of "every page 500s" is `database.ok: false`. A detail of
`getaddrinfo ENOTFOUND` or a timeout means the host is unreachable from
Vercel — see the IPv6 warning under Setup above.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests |
| `npm run db:generate` | Write a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse synced data in Drizzle Studio |
| `GET /api/health` | Deployment health check (needs `CRON_SECRET`) |

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

## Accounts

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

### Holdings, two presentations

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

## Transactions

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

## Budgets

Modelled on Rocket Money's layout: **Budget Basics** (automatic bills, utilities,
savings goals) and **Budget Categories** (flexible spending), each with
`Budgeted` / `Actual` per row, plus Earnings and a Spending Budget footer.

### Buckets come from your own transactions

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

Categories can be added and removed **after** the bucket exists: each one is a chip
under the bucket's name with a `×` on it, and **+ category** opens a picker of the
ones still free. This used to be impossible — `RowEditor` could edit nothing but the
budgeted figure — so the natural want of "Weekend starts as dining, then a month
shows it should also match entertainment" had no route, and the only way to get it
was to delete the bucket and rebuild it, losing the figure and the manual
assignments already pointing at it. The picker stays open after a pick, because a
bucket usually wants two or three.

An already-claimed category is **greyed out** in the picker rather than hidden,
with a tooltip naming the bucket that has it. Hiding it meant a category that had
gone somewhere else simply stopped being offerable, and the only symptom was that
the bucket could never match anything again with nothing to say why. Sharing is
still permitted — the editor greys the option, but a direct `PUT` allows it — and
when it happens only the first bucket in display order ever matches while the
second reads $0 forever, silently.

### Naming a bucket yourself

**Add bucket** opens a form, not a list to pick from. The name is yours; the
category is optional.

Pick a category chip to fill both in at once, then edit the name, or skip the chips
entirely and type a name with **Nothing - display only** selected. That creates a
row that claims no transactions — the right shape for a bucket like "Vacation
fund" that you are planning for rather than tracking. A display-only bucket's
Actual stays 0 until you route something into it, which you can do with a rule
step on `/rules` (see [Rules](#a-rule-is-a-match-plus-steps)).

Bucket names are unique **per group**, so "Bills & Utilities" can exist under both
Budget Basics and Budget Categories.

A row's group is fixed at creation: `PUT /api/budgets` uses `kind` as part of its
upsert key and never rewrites it, so moving a bucket between Budget Basics and
Budget Categories means deleting and recreating it (which cascades away any rule
pointing at it). Worth knowing, because the group is not purely cosmetic — see
[Which rule wins](#which-rule-wins).

### Summary and month navigation

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

### Reading the numbers

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

Colour follows the row's group, not the arithmetic. Over budget is red for
spending and **green for income** — exceeding the target on the earnings row is
the point, and it used to render the same red as overspending. The **Spending
Budget** footer turns red when the month's actual passes the total budgeted,
which is the one figure that says whether the month worked; it was previously the
same muted grey at 40% and at 140%.

### Automatic assignment

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
# A rule is a match plus steps; see Rules below.
curl -X PUT localhost:3000/api/rules -H 'Content-Type: application/json' \
  -d '{"matchType":"merchant","matchValue":"Starbucks",
       "steps":[{"target":"bucket","budgetId":3}]}'
```

`PUT /api/budgets` upserts on `(kind, name)`, so saving the same name again
updates the row — that is what lets the UI save on blur.

### The unassigned queue

The count on the budgets page links to `/budgets/unassigned?year=&month=`: the
month's spending with no bucket, one row per transaction, each routed by hand.

**Assign unassigned** and this page do different jobs. The button runs the rules
over everything still null, which is right for the transactions the engine *can*
place and useless for the ones it cannot — a landlord payment with no recognisable
merchant, a split transaction, anything where Plaid's category is simply wrong.
Those need a person, one row at a time.

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

### One definition of "unassigned"

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

### Seeing inside a bucket on the cash flow diagram

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

### Changing a transaction's category

Click a category on the transactions page to change it. That writes
`categoryOverride` and clears `budgetId` so the engine re-routes immediately —
otherwise a re-categorised transaction would sit in a bucket that no longer
matches, and the budgets page would contradict the transactions page.

`PATCH /api/transactions/[id]` accepts `budgetId` (null clears), `categoryOverride`
and `notes`. An explicit `budgetId` in the same request wins over the clear.

### Per-bucket detail

Bucket names link to `/budgets/[id]`, carrying the month you were viewing. Every
transaction in that bucket can be moved to another bucket individually, which is
durable because the engine never overwrites a non-null assignment. Prev/Next
navigation keeps the month in context.

### Actuals are sign-aware

Spending buckets sum only outgoing amounts; earnings buckets sum incoming ones.
This is not cosmetic. Summing `abs(amount)` inflates any category holding both
directions — in this project's own data a `TRAVEL` category whose transactions
net to **$500** reports **$24,500** that way. Bucket totals reconcile to the sum
of positive transaction amounts to the cent.

Income is read from **earnings bucket assignments**, not from every negative
amount. Raw money-in includes transfers between your own accounts, which are not
income; counting them made the month strip disagree with the summary card.

## Budget worksheet

`/budgets/worksheet` — the "After Raise" sheet of a spreadsheet, ported. Reached
from a **Budget worksheet** button on the budgets page.

One saved row per user (`budget_worksheet`, migration 0012), stored separately
from `budgets` on purpose: `budgets` measures what happened to real transactions,
this is what you *intend*. Nothing reconciles the two, and keeping them apart is
what stops one quietly overwriting the other.

### Every figure is derived from the inputs

`computeWorksheet` in `src/lib/budget-worksheet.ts` is pure and holds all of it,
and the client form calls the *same function* the API uses to produce what it
saves — so what you see before saving and what the server stores cannot disagree.
The form keeps inputs as text while typing and normalises on the way into the
maths, because coercing on every keystroke is what eats the trailing `.` of `12.`
and stops a field clearing.

### Two decisions worth knowing about

**Signs are inverted deliberately.** The spreadsheet stores deductions as negative
numbers and subtracts them, so a total is a sum of mixed signs and one missing
minus silently inverts the sheet while every figure still looks plausible.
Everything here is stored and entered as a positive magnitude and subtracted
explicitly.

**Stock is a share of the salary granted on top of it**, so you type the cash
salary and the stock is added: $88,360 plus 12% is **$98,963.20** of total
compensation. Take-home is built from the **cash** salary alone — stock is not money
that lands in an account, so counting it would inflate the figure everything else on
the page is measured against. A test asserts that dropping the stock rate to zero
leaves take-home *identical*, which is what stops a stock-only raise from appearing
to change anything.

This was the first thing built wrong. The spreadsheet's `E8 = E4 + F8` with
`F8 = E8*0.12` reads as though the stock sat *inside* the gross, so it was
implemented as `gross = bills / (1 - rate)` — which for these figures gives a
monthly salary of **$238** against **$2,611** of withholding. Dividing by
`(1 - rate)` instead of multiplying by `(1 + rate)` understates pay by nearly $10k a
year, and drags every other figure down with it, because they are all shares of it.

**The salary solve is opt-in and now asks a coherent question.** Rather than the
spreadsheet's unreconcilable bills-to-salary relationship, it solves for the cash
salary at which take-home exactly covers the bills — `salary = (bills +
deductions) × 12` — which is what the sheet was reaching for: *what do I have to earn
for this plan to work?* Stock is deliberately excluded from that arithmetic, since a
plan that only balances on equity that cannot pay a rent is not a plan. Typed is the
default, because it is what the real figures need.

### Pay periods: the spreadsheet's `x2` is probably wrong

Every withholding and pre-tax figure is entered **per pay period** and multiplied up
to a month. The multiplier is `payPeriodsPerMonth`, defaulting to **26/12** rather
than a flat 2, because biweekly pay is the norm in the US and 26 checks a year is
2.1667 months — a flat 2 models two paychecks that never arrive.

That is not a preference, it is measurable. On the real figures:

| | deductions/mo | take-home | vs recorded $4,510.44 |
| --- | --- | --- | --- |
| 2 (semi-monthly, 24/yr) | $2,611.44 | $4,751.89 | off by **$241.45** |
| 26/12 (biweekly, 26/yr) | $2,829.10 | $4,534.23 | off by **$23.79** |

Biweekly is an order of magnitude closer to what the app has actually recorded as
income, which is why it is the default. Set it to 2 if the pay really is the 1st and
15th.

### Retirement: a separate pot from the goals, by default

The 50/30/20 comparison leaves the 401k and Roth IRA **out** of savings, matching the
spreadsheet, and a checkbox folds them in. Neither is wrong, and the reason they
differ is not accounting pedantry:

- **The goals** (student loans, brokerage, HYSA) are paid out of take-home.
- **The retirement contributions** come out of gross before the money is yours.

Different pots, so folding them together is a presentational choice rather than a
correctness one. It moves what the percentages are measured *against*, and the code
keeps that honest by switching the base too — with retirement counted, the split is
of income-before-savings rather than take-home, so the three shares still add to 100%
either way:

| | base | needs / savings / wants |
| --- | --- | --- |
| goals only (default) | $4,534.23 | 57% / 22% / 21% |
| with retirement | $5,543.05 | 46% / 36% / 17% |

Wants is untouched by the choice, because it is the remainder of take-home either
way. Counting retirement is the more common reading of the rule in public guidance;
leaving it out is the more honest one about what each dollar was actually taken from.

### Select-all on numeric fields

Numeric and short-identifier fields across the app select their whole contents when
focused **or clicked**, via `selectAllProps` in `src/lib/select-all.ts`:

```jsx
<input {...selectAllProps} ... />
```

Both handlers, because neither covers the other. `onFocus` covers arriving by
keyboard — tabbing in never fires a click. `onClick` covers arriving by mouse —
`onFocus` alone fires only when a field *gains* focus, so clicking a field that
already has it just moves the caret. That is what made the first attempt look
intermittent: right-aligned inputs mean clicking the empty space left of the digits
focuses nothing new, so the first click worked and the next one undid it.
`onMouseDown` is avoided deliberately, because selecting there gets undone by the
browser's own caret placement on mouseup.

Deliberately **not** applied to the transaction search box or the category filter
(free text you edit in place — clicking to put a caret after part of a query is the
normal gesture there), the password field (selecting one reveals its length), or
the login email (typed fresh each time, and a login form is the wrong place to be
surprising someone). `tests/select-all.test.mts` asserts the exclusions stay
excluded, because the failure mode is silent: a field without it just behaves like
it always did.

### A note on what the sheet's own figures do not reconcile

`Everything Else` and the ideal-allocation targets depend on cells that are only
legible in a screenshot, so those transcribed values are plausible rather than
confirmed. The salary/stock relationship was confirmed and corrected; if another
total looks wrong, that line is where to look first.

### Testing the save path

Drizzle maps `grossSalary` to `gross_salary` itself, and silently *ignores* an
insert key it does not recognise rather than rejecting it. An early version used
the SQL column names, so every camelCase field saved as zero while the four whose
names happen to match in both (`k401k`, `rent`, `gas`, `hysa`) worked — half the
form saving, silently. A test now asserts every field in the list is a real field
on the table, which needs no database.

## Cash flow

`/budgets/cash-flow` — where the money came from and where it went, as a Sankey.
Reached from a **Cash flow** button on the budgets page, which carries the month
across so the two views describe the same period.

Switchable between a single **month** and **year to date**, with a year row and a
month row above the chart. All of it is query parameters
(`?scope=month|ytd&year=&month=`), so every view is linkable and works with
JavaScript off.

### The diagram always balances

The interesting part is what happens when spending exceeds income. A Sankey whose
ribbons do not meet is either lying or unreadable, so the shortfall becomes an
explicit **From savings** node on the income side. The month is then honestly
shown as funded by money that was not earned, instead of ribbons being silently
rescaled away from the totals printed beside them.

`buildCashFlowGraph` (`src/lib/cash-flow.ts`) is pure and unit-tested for exactly
this: that every ribbon out of a source sums to that source, that the ribbons
into each target sum to it, and that neither holds by more than float noise. The
source side is pinned exactly by giving the last slot the rounding remainder; the
target side drifts by ~1e-14, which is four orders of magnitude below the
four-decimal precision money is stored at, so it is not worth a matrix-scaling
pass to eliminate.

**Zero is not a ribbon.** Buckets with no activity in the window are dropped
rather than given a zero-width node and a label, which would otherwise put a dozen
empty rows down the side of a quiet month.

### Income means the same thing here as everywhere else

Read from **earnings buckets**, exactly as the summary card and
`getMonthlySeries` do. Counting every negative amount would sweep in transfers
between the user's own accounts, so the Sankey would claim income the rest of the
app does not and its totals would not tie to the budgets page. The buckets decide
the shape of the diagram, so the diagram and the rule that fills the buckets have
to agree. The page says so on screen, because anyone comparing it to a bank's
"total inflows" line will otherwise think it is broken.

Unassigned spending gets its own node rather than being folded into a category —
it is a to-do, not a category, and there is already a queue for it. It is counted
because excluding it would let the diagram report a healthy *Remaining* while
real money went somewhere unlabelled.

### Year to date scales the budgeted column

A bucket's limit is monthly, so a twelve-month window compared against one
month's limit makes every bucket look overspent. `cashFlowWindow` counts only the
months that have actually happened: twelve for a finished year, up to the current
month for this one.

### Every bar is at least three pixels

d3-sankey draws height as `value * ky` — one linear px-per-dollar scale for the
whole diagram — so a single dominant category squeezes everything else out of
existence. Your September 2026 figures, at 0.065 px per dollar:

| bucket | amount | px, before |
| --- | --- | --- |
| Rent And Utilities | $1,527.21 | 93.31 |
| Savings/Debt | $1,053.91 | 64.39 |
| Groceries | $133.61 | 8.16 |
| Dining & Drinks | $36.04 | 2.20 |
| Insurance | $9.41 | **0.57** |

Half a pixel is an anti-aliasing artefact, not a bar, and it reads as a broken
chart rather than a small number. Extra height does not fix it either: doubling
the canvas doubles half a pixel to one. So `applyMinimumThickness` floors every
bar and ribbon at 3px in *pixel* space after the layout has chosen proportions.

The distortion is deliberately bounded and one-directional:

- Only bars already too thin to see are touched. A bar that was legible keeps its
  exact height — and an entirely comfortable month comes through byte-identical,
  which is a test.
- **Totals never move.** No node is added or removed, so a month that genuinely
  saved still shows *Remaining* and one that genuinely overspent still shows
  *From savings*. Only bar thickness is approximate.
- Nodes are re-stacked preserving their original padding, and a bar is grown to
  fit the ribbons meeting it, so nothing overflows or collides.
- The exact figure is never in the geometry. It is in the label, the tooltip and
  the table underneath, which is why all three are always present.

**Flooring invalidates the ribbon endpoints, and they have to be rebuilt.**
d3-sankey bakes each ribbon's two ends into the link as absolute pixels — `y0`
where it leaves the source, `y1` where it meets the target — and
`sankeyLinkHorizontal` reads them verbatim. Move a node or widen a ribbon without
recomputing both and the geometry stops describing the bars it is drawn between:
the small bars, which are exactly the ones that get floored and moved, end up with
ribbons ending in the gap beside their own labels. `applyMinimumThickness`
re-stacks them the way d3-sankey does, accumulating each node's links down its
height in the existing order, centred so a bar taller than its ribbons splits the
slack evenly.

This is worth writing down because it is invisible to every check that is not
geometric: the paths exist, the bars are the right height, the totals tie out, and
the only symptom is a ribbon that stops short. Measured against the 2026
year-to-date figures, 4 of 12 ribbons landed outside the bar they belonged to
before the rebuild and 0 of 12 after.

The floor also has to buy the labels room. A floored bar is 3px tall with its
neighbour 16px away, and two stacked lines of text there collide, so `nodePadding`
is 16 rather than d3-sankey's default 8 and a bar under 28px gets its amount as
an inline `<tspan>` beside its name instead of on a line below.

### Pan and zoom

The diagram is laid out **once**, in its own coordinates, and the `viewBox` is a
window onto it — so panning and zooming never re-run the Sankey layout, which is
the expensive part and the part that could shuffle bars you were looking at.

It also gives the drawing a **floor width** of 620px regardless of the container.
Below that the 132px label margins on each side leave almost nothing for the
ribbons, so a phone gets a squashed complete view it can zoom into, rather than a
legible one it has to pan sideways to read.

Five ways to move it, because no single gesture works everywhere:

| | |
| --- | --- |
| drag | pan, mouse or one finger |
| pinch | zoom, two fingers |
| wheel / trackpad | zoom about the pointer; `ctrl`+wheel from a trackpad pinch |
| buttons | zoom in, zoom out, and Fit |
| keyboard | arrows pan and step through items, `+`/`-` zoom, `0` fits |

Up/down arrows step through the items and left/right pan, rather than both being
item navigation — it is a vertical list of bars, so vertical is the natural
direction to read, and horizontal is left free for moving the canvas.

The window maths lives in `src/lib/zoom-view.ts`, pure and tested, because the
bugs that matter are invisible in a screenshot:

- **A zoom keeps the point you aimed at under the cursor.** Zooming about the
  centre instead slides the bar you were aiming at out from under the pointer
  exactly when you are lining it up with its label. One exception: when the new
  window would hang off the drawing, clamping wins, because a cursor-anchored
  window running past the edge shows blank space where the chart should be.
- **Neither control can lose the chart.** Zoom is bounded to 0.5×–6×, and panning
  stops at the edges. A window larger than the drawing is *centred*, not pinned
  to one side, which would leave a sliver of chart on the left and empty space on
  the right.
- The wheel listener is **native and non-passive**, because React registers
  `wheel` passively and a passive handler cannot `preventDefault` — the page would
  scroll out from under the chart instead of zooming it.
- `touch-action: none` on the SVG, or a finger on a chart always scrolls the page.

Resizing drops any zoom, since the diagram is re-laid-out and a window chosen for
the old size would be showing nothing.

### One colour per role, not per bucket

Income and what remains are green, spending is the single accent colour, an
overspend is amber. Giving twelve buckets twelve colours would imply they are
twelve different kinds of thing, which is the same reason the bar list is one
colour per bar. Hovering or arrowing through a node dims everything it is not
connected to, so a fan of overlapping ribbons stays readable.

## Rules

`/rules` manages automatic routing for **both** buckets and loans. Rules used to
live under Budgets, which was wrong as soon as a rule could pay down a loan: that
is a different kind of write (it mints a payment record and moves a debt balance)
from sorting spending into a bucket.

`GET|PUT /api/rules`, `POST /api/rules`, `DELETE /api/rules?id=`.

### A rule is a match plus steps

A rule is **one match and any number of steps**. Each step sends matching
transactions somewhere different, and they do not compete:

```
Match: amount 453.91
  1. send to  → Mazda 3 Loan        (records a payment, moves the balance)
  2. send to  → Car Payment bucket  (sets budget_id)
```

Both run. The loan write and the bucket write touch different columns, so the
same transaction ends up recorded as a car-loan payment *and* counted as car
spending — which is the point of expressing them as one rule.

**One row in `budget_rules` is one step.** Every row sharing a
`(match_type, match_value)` belongs to the same rule, so a rule's identity is its
match, not a row id. `PUT` replaces the whole set: steps still listed are updated
in place, steps no longer listed are deleted, only genuinely new steps are
inserted.

This replaced a one-target design where the table was unique on
`(user_id, match_type, match_value)` and saving was an upsert on that key. Adding
a second target therefore **replaced** the first instead of joining it, so a
"pay the car loan" rule silently became a "spend on car payments" rule. Each
*step* still satisfies `budget_rules_one_target_check` — exactly one of
`budget_id`, `loan_id`, `exclude` — so no individual row is ambiguous; only the
rule as a whole has several targets.

### Editing

Each rule has an **edit** button that loads its steps back into the same form,
so steps can be added, removed, reordered, or retargeted. Removing a step is not
just "stop doing this going forward" — see [Undo](#undoing-a-step).

### Match types

| Type | Matches | Notes |
|---|---|---|
| `merchant` | Merchant or raw description contains the text | Case-insensitive, substring not prefix |
| `category` | A Plaid category, or any child of it | Boundary-aware: `FOOD` does not claim `FASTFOOD_RESTAURANT` |
| `amount` | That exact figure | Magnitude, so direction-agnostic; `600` and `600.00` are one rule |

### Precedence

Between rules, for which bucket wins:

1. Exact amount.
2. Merchant contains.
3. Category - but your own category override wins over Plaid's suggestion.
4. The catch-all bucket.

Within one rule there is no precedence: every step runs.

#### Budget groups are not cosmetic

The `Which rule wins` list on `/budgets` is about *rules*. Between *buckets*,
there is a precedence people do not expect: `loadRuleSet` orders buckets by
`budget_kind` first, and Postgres orders an enum by its declaration order —
`basic`, `category`, `earning`. So **every Budget Basics bucket is tested before
every Budget Categories bucket**, and because matching is prefix-based on the
underscore boundary, a Basics bucket on `LOAN_PAYMENTS` claims
`LOAN_PAYMENTS_CAR_PAYMENT` before a Categories bucket on `LOAN_PAYMENTS` ever
sees it.

That is why having both "Loan Payments Car Payment" (Basics) and "Savings &
Debt" (Categories) was quietly redundant rather than additive. It is not written
down anywhere in the UI, and it is a side effect of reusing the display group as
the sort key.

### Saving a rule applies it to history

The sync-time engine (`applyBudgetRules`) only fills in transactions with **no**
assignment, which is what makes a manual assignment survive later syncs. That is
also why a new rule used to look broken: every transaction it matched had already
been assigned.

Saving a rule therefore applies every step to every matching transaction,
overwriting existing assignments, and the response reports `applied` — one
`{moved, matched, target}` per step, so the page can say what each one did. A
rule that silently matched nothing would be indistinguishable from a working one.

The one thing it does **not** do is create a rule from a per-transaction
reassignment; those remain one-off.

### Loan steps

A step aimed at a loan tags matching outgoing transactions as payments, creating
`loan_payments` rows. Backfill runs in **ascending date order** on purpose: each
insert advances the loan's accrual cursor, so applying newest-first would charge
a year of interest against the first payment and none against the rest.

Runs after a sync (`applyLoanRules`), non-fatally and separately from bucket
routing, and skips transactions that already have a payment.

### Undoing a step

Removing a step undoes what it did, because a step that wrote loan payments has
already moved a debt balance — leaving those behind would leave the rule's
history asserting something untrue. Deleting a rule undoes all of its steps.

The writes are not always the step's alone, so each one is checked against
everything that still wants it and left alone if so (`kept` in the response):

| Step | Undo | Left alone when |
|---|---|---|
| bucket | clears `budget_id` | another step or rule still targets that bucket |
| ignore | clears `excluded` | the row is a credit/loan balance movement, which the routing engine excludes for its own reasons |
| loan | deletes the `loan_payments` row | the payment has `source = 'manual'`, or another rule still targets that loan |

Clearing `budget_id` leaves the transaction **undecided** rather than repointed.
`applyBudgetRules` only fills nulls, so the next routing pass decides from
whatever else matches; if nothing does, the row visibly falls to the catch-all
instead of quietly staying where it was.

`loan_payments.source` is what keeps an undo from deleting a tag the user set by
hand on the transactions page. Without it the two are indistinguishable rows. It
has **no database default**, so an insert has to say which it is — the column
used to default to `'manual'`, which meant every row written before it existed was
labelled as a hand-tag and no undo ever removed any of them. See
`drizzle/0010_silent_veda.sql`, which relabels those rows and drops the default.

### Seeing what a rule is affecting

Each rule on `/rules` carries a count of the transactions it matches, and a
collapsed list behind it: date, description, amount, and whether the rule has
already routed it.

**The count comes from the engine's own matcher.** `transactionsForRule` calls the
same `matchesStoredRule` that `applyRulesToHistory` does, so the number here and
what saving a rule actually does cannot disagree — which is the only property worth
having. A rule list that filtered in SQL would be faster and might well answer a
slightly different question, and a confidently wrong count is worse than none.

Because that matcher lives beside the routing engine in a `server-only` module, the
matching runs on the server and only the capped preview crosses to the client.
Nothing is recomputed in the browser, which is also why there is no second
implementation to drift.

Three details that are load-bearing rather than decorative:

- **Excluded rows are listed, and labelled "ignored".** They are excluded from
  budgeting but still *match*, and a rule whose every match is ignored is exactly
  the case this view exists to explain. All three of the ignore rules in the seed
  data are in that position.
- **"Applied" versus "would move"** is what makes a long list worth reading. Without
  it you cannot tell a working rule from one that has not been re-run.
- **The list is capped at 20, the count is not.** A merchant rule from three years
  ago matches hundreds of rows; the question being asked is usually "is this rule
  doing what I think", which the most recent twenty answer.

A rule with no bucket step (a loan step, or an ignore) has no bucket to be "applied"
to, so that column is dropped rather than guessed at.

The trade-off is O(rules × transactions) in memory per page load: candidates are read
once and filtered per rule in JS rather than per rule in SQL. For a personal
finance app with thousands of transactions that is the right way round — the page is
responsive and, more importantly, it cannot disagree with the engine.

## Manual loans

Debt Plaid cannot see, like a car loan from a credit union. `loans` holds the
loan; `loan_payments` is the ledger of tagged transactions paying it down.
Separate from `liabilities`, which is pinned 1:1 to a synced account and whose
balance belongs to Plaid.

Add one on **Accounts → Manual loans**: name, amount borrowed, APR, and an
optional monthly payment. Payments are recorded by rule, not entered one at a
time: see [Rules](#rules) above. Each matched transaction becomes a payment.

### Interest

Simple interest on the outstanding balance, accruing daily at APR/365 from the
last accrual date. Actual/365 rather than a whole monthly step, because payments
get tagged whenever you get round to it and a fixed step would over- or
under-charge depending on when the tag lands. So a $600 payment on a $25,000 loan
at 5.9% after a month is about $121 interest and $479 of principal — the payment
does **not** retire $600 of debt.

A payment smaller than the interest it accrues produces a negative principal and
the balance grows. That is shown rather than hidden, because reporting it as
progress would make a bad loan look healthy.

### The balance is maintained by a trigger

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
  step](#undoing-a-step).

The interest split on each payment is **stored, not recomputed**, so history stays
truthful after you correct the balance by hand.

Arithmetic lives in `src/lib/loan-math.ts` as pure functions, tested in
`tests/loan-math.test.mts`. API: `GET|POST /api/loans`, `PUT|DELETE
/api/loans?id=`.

## Dashboard

A read-only landing page: what you have, what the month looks like, and whether
the data is current. It deliberately does **not** list linked institutions or
accounts — that is `/accounts`, and duplicating it pushed the month's numbers off
the screen.

- **Net worth**, with the trend under it (`TrendChart` over the daily snapshots).
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

### Which chart, and why

The three new visual pieces are chosen by the question each one answers:

| Piece | Question | Why this form |
|---|---|---|
| `TrendChart` | How has this moved over time? | Position along a common baseline is the most accurately read encoding there is |
| `BarList` | Which is biggest, by how much? | Ten rows compared against each other. Bars, not a pie: angles and areas are read far less precisely than length |
| `Donut` | How is the total made up? | Genuinely part-to-whole, and the centre gives the arithmetic away. This is the one place a donut earns its keep |

`BarList` and `CashFlow` are plain HTML — divs sized by percentage — rather than
SVG or a chart library. Nothing here needs an axis, and a `viewBox` cannot do what
a text label does: wrap, reflow, and stay selectable and accessible for free.

### Colour

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

## Net worth

Assets minus liabilities across checking/savings, credit cards, loans,
investments and manual accounts. Manual loans are counted under `loans` rather
than `manualLiabilities`, so a car loan appears there whether or not Plaid can see
it.

### History needs two days to exist

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

### Charts are visx, not hand-rolled

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

### Where the two kinds of history come from

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

## Webhooks

`POST /api/plaid/webhook` verifies Plaid's signed JWT before trusting anything,
including a SHA-256 of the body so a genuine signature cannot be replayed over a
tampered payload. Local development needs a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Without a webhook URL, the daily cron still syncs once a day and the **Refresh**
button still works on demand; you just don't get pushed updates between runs.

## Security notes

- Plaid secrets are server-only; every Plaid module imports `server-only`, so a
  client import is a build error rather than a runtime leak.
- Access tokens are encrypted at rest with AES-256-GCM. Logs never include
  tokens or full transaction payloads.
- `ALLOWED_EMAILS` is the real access control. Queries go through Drizzle over
  `DATABASE_URL`, not Supabase's PostgREST API, so **RLS does not protect these
  tables** — the allowlist and per-query `user_id` scoping do. Do not assume RLS
  is a backstop.
- Every route re-checks the session and scopes by `user_id`.
  `src/proxy.ts` is a UX convenience, not the security boundary.
- API routes are never redirected by the proxy; they return real status codes.

## Adding a bank

Before spending a Trial slot, write down every institution you want and count the
Items. Checking + savings at one bank = 1 Item. Each additional institution, card
issuer, brokerage, 401k, and loan servicer = 1 more. Ten total.

Link one real account first, confirm the sync, *then* continue.

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
  — see Manual loans above — but manual assets/liabilities still do not.)
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
  (see [Budget groups are not cosmetic](#budget-groups-are-not-cosmetic)).
- **Real PWA testing on iPhone**, including the open question of whether OAuth
  Link works inside a home-screen web app (architecture doc section 12).

The `recurring` table still exists in the schema but is unused; the Subscriptions
feature was removed. It can be dropped with a migration if you want the schema to
match the feature set exactly.