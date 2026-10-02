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
| Tests | `node:test` via `tsx` (38 tests) |

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
not only when an Item needs attention. Per account, **×** removes just that
account.

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
- `category` — the Plaid category its Actual is measured against.

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
4. **The bucket's own `category`** — an implicit category rule.
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

The queue's filter is deliberately identical to the count's
(`getUnassignedTransactions` vs `getSpendSummary`): month-scoped, `pending =
false`, `budget_id is null`, `amount > 0`. A link that says "14 unassigned" and
lists 40 would be worse than no link. `amount > 0` is doing real work — money in
is routed to an earnings bucket automatically, and money moving a credit or loan
balance is excluded as neither, and both are negative.

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

## Net worth

Assets minus liabilities across checking/savings, credit cards, loans,
investments and manual accounts. Manual loans are counted under `loans` rather
than `manualLiabilities`, so a car loan appears there whether or not Plaid can see
it. `GET /api/cron/snapshot` writes one row per user per day, idempotently,
guarded by `CRON_SECRET`:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/snapshot
```

## Webhooks

`POST /api/plaid/webhook` verifies Plaid's signed JWT before trusting anything,
including a SHA-256 of the body so a genuine signature cannot be replayed over a
tampered payload. Local development needs a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Without a webhook URL, data still syncs via the **Refresh** button; you just
don't get pushed updates.

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