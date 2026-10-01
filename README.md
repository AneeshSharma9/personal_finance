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
(`17 7 * * *`). Vercel sends `Authorization: Bearer $CRON_SECRET` automatically
when that variable is set.

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

A row stores two deliberately separate things:

- `name` — the display label, free-form and yours ("Bills & Utilities").
- `category` — the Plaid category its Actual is measured against.

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
- **Re-assign everything** clears assignments first, when you want existing
  routing decisions re-made.

It runs after every transaction sync, on the `SYNC_UPDATES_AVAILABLE` webhook,
and on demand:

```bash
curl -X POST localhost:3000/api/budgets/apply -d '{}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/api/budgets/apply -d '{"reset":true}' -H 'Content-Type: application/json'

# A merchant rule routing every Starbucks charge into a bucket
curl -X PUT localhost:3000/api/budgets/rules -H 'Content-Type: application/json' \
  -d '{"matchType":"merchant","matchValue":"Starbucks","budgetId":3}'
```

`PUT /api/budgets` upserts on `(kind, name)`, so saving the same name again
updates the row — that is what lets the UI save on blur.

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

## Net worth

Assets minus liabilities across checking/savings, credit cards, loans,
investments and manual accounts. `GET /api/cron/snapshot` writes one row per user
per day, idempotently, guarded by `CRON_SECRET`:

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
  The table and the net-worth read path are done.
- **Notes UI.** `PATCH /api/transactions/[id]` accepts `notes`; nothing calls it.
- **"Move and remember" rules.** Reassigning a transaction in a bucket moves that
  one transaction. It does not create a merchant rule, so a later sync routes new
  matching transactions by category again. Rocket Money's equivalent applies the
  change to all future matches.
- **Budget basics detection.** Budget Basics is currently just a grouping you
  assign rows to; nothing identifies your recurring bills and pre-seeds them
  there. That needs a recurring-charge detector.
- **Real PWA testing on iPhone**, including the open question of whether OAuth
  Link works inside a home-screen web app (architecture doc section 12).

The `recurring` table still exists in the schema but is unused; the Subscriptions
feature was removed. It can be dropped with a migration if you want the schema to
match the feature set exactly.