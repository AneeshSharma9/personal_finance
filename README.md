# Personal Finance

A self-hosted, Rocket Money–style finance tracker built on Plaid's free Trial
plan. Web app first, installable on iPhone as a PWA.

The design and constraints this implements live in [PLANNED_ARCHITECTURE.md](./PLANNED_ARCHITECTURE.md).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript |
| UI | Tailwind v4, mobile-first, shadcn-style components |
| Database | Postgres (Supabase) via Drizzle ORM |
| Auth | Supabase Auth, locked to an email allowlist |
| Plaid | `plaid` Node SDK + `react-plaid-link` |
| Tests | `node:test` via `tsx` |

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Project Settings → API → copy `Project URL` and `anon key`.
3. Project Settings → Database → copy the **connection string URI** (not the
   transaction-pooled one).
4. Authentication → Users → **Add user** with your email and a password. The app
   has no signup UI on purpose: only addresses in `ALLOWED_EMAILS` can use it.

### 2. Plaid

1. [dashboard.plaid.com](https://dashboard.plaid.com) → Developers → Keys.
2. Copy **Sandbox** client ID and secret.
3. If you have Production Trial keys, copy those too. Both sets live in
   `.env.local`; `PLAID_ENV` selects which is active.
4. Sandbox login for testing: `user_good` / `pass_good`.

### 3. Environment

```bash
cp .env.example .env.local
```

Fill in the blanks. Two values are generated for you already:

- `TOKEN_ENCRYPTION_KEY` — AES-256-GCM key for Plaid access tokens.
- `CRON_SECRET` — guards the daily snapshot endpoint.

**Back up `TOKEN_ENCRYPTION_KEY` somewhere safe.** Rotating or losing it makes
every stored Plaid access token undecryptable, which means losing every linked
Item *and* its Trial-plan slot. The database backup is useless without it.

Generate a fresh one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4. Database

```bash
npm run db:migrate
```

Migrations are plain SQL in `drizzle/`, so you can also paste them into
Supabase's SQL editor instead of running the CLI.

### 5. Run

```bash
npm run dev
```

Open http://localhost:3000, sign in, then link an account from **Accounts**.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (crypto, webhook verification, allowlist) |
| `npm run db:generate` | Write a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse synced data in Drizzle Studio |

## Plaid constraints this app is built around

These are load-bearing, not incidental:

- **10 Item limit, and `/item/remove` does not free a slot.** One Item is one
  bank login, however many accounts it holds. Re-authentication uses Plaid Link
  in **update mode** (`/api/plaid/link-token` with an `itemId`), which never
  creates a new Item. Do all connect/disconnect testing in Sandbox.
- **`days_requested` is only applied when an Item is first initialized.** It
  cannot be changed later without spending another slot. `PLAID_DAYS_REQUESTED`
  defaults to 730 (Plaid's ceiling) so you get full history on the first real
  link.
- **Investment value comes from holdings, not `current_balance`.** A brokerage's
  cash sweep can appear in both and would double count.
- **Credit and loan balances arrive from Plaid as positive amounts owed.** The
  raw sign is stored and flipped at read time, in exactly one place
  (`signedBalance` / `getNetWorth`).
- **Net-worth history cannot be backfilled.** Plaid only reports current
  balances, so history exists only for days you recorded. Enable the daily
  snapshot early.
- **Liabilities and Investments are requested as `optional_products`** so
  institutions that don't support them can still link. Their absence is a
  warning, not a failure.

## Webhooks

`POST /api/plaid/webhook` verifies Plaid's signed JWT (`Plaid-Verification`)
before trusting anything, including a SHA-256 of the body so a genuine
signature can't be replayed over a tampered payload.

Set `PLAID_WEBHOOK_URL` to your public HTTPS URL, e.g.
`https://your-app.vercel.app/api/plaid/webhook`. In local dev, expose it with a
tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Without webhooks, data still syncs via the **Refresh** button — you just won't
get updates pushed.

## Daily net-worth snapshots

`GET /api/cron/snapshot` writes one row per user per day (idempotent, so
re-running is safe). It requires `Authorization: Bearer $CRON_SECRET`:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/snapshot
```

On Vercel, add a Cron entry to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/snapshot", "schedule": "17 7 * * *" }] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when the
`CRON_SECRET` env var is set.

## Security notes

- Plaid secrets and the service-role key are server-only; every Plaid module
  imports `server-only` so a client import is a build error, not a runtime leak.
- Access tokens are encrypted at rest with AES-256-GCM. Logs never include
  tokens or full transaction payloads.
- `ALLOWED_EMAILS` is the real access control. Supabase signups may be open;
  the allowlist is what prevents strangers from consuming your Item cap.
- Every route re-checks the session and scopes queries by `user_id`.
  `src/proxy.ts` is a UX convenience, not the security boundary.
- `.env*` is gitignored; `.env.example` is committed.

## Adding a bank

Before you spend a Trial slot, write down every institution you want and count
the Items. Checking + savings at one bank = 1 Item. Each additional institution,
card issuer, brokerage, 401k, and loan servicer = 1 more. Ten total.

Link one real account first, confirm the sync, *then* continue.

## Roadmap

Implemented: auth + allowlist, Plaid Link and update-mode re-auth, transaction
sync with cursor, accounts, category overrides, two-group budgets with
per-row budgeted/actual and a Spending Budget total, recurring-charge display,
net worth with history and snapshots, liabilities, investments, manual
accounts, PWA shell.

## Budgets

Modelled on Rocket Money's layout: **Budget Basics** (automatic bills,
utilities, savings goals) and **Budget Categories** (flexible spending), each
with `Budgeted` / `Actual` per row, plus Earnings and a Spending Budget footer.

### Buckets come from your own transactions

There are no template buckets. The options on the budgets page are the
categories actually present in your transactions, so a bucket is always
something you really spend on. Category values are **not** validated against a
frozen list, because Plaid moved to a PFC **v2** taxonomy for Items created after
2025-12-03 and any hardcoded enum would go stale.

A row stores two things that are deliberately separate:

- `name` — the display label, free-form and yours ("Bills & Utilities").
- `category` — the Plaid category its Actual is measured against.

### Automatic assignment

`transactions.budget_id` holds the bucket a transaction belongs to. The engine in
`src/lib/budget-engine.ts` fills it in, with this precedence — first match wins:

1. **Merchant rules** — "contains Starbucks". Beats categories, so it can
   override a broad default. Plaid files coffee shops under `FOOD_AND_DRINK`, so
   without a rule every coffee shop lands wherever `FOOD_AND_DRINK` points.
2. **Explicit category rules** — stored in `budget_rules`.
3. **The bucket's own `category`** — an implicit category rule.
4. **Everything Else** — the remainder, absorbing what nothing claimed.
5. **An earnings bucket** — for money in. Income never lands in a spending bucket.

Matching is case-insensitive against the override, detailed, and primary category
a transaction carries, and boundary-aware: `FOOD` absorbs `FOOD_AND_DRINK`, but
`FOO` matches nothing. A bare substring match would let a truncated rule swallow
unrelated spending.

The engine only ever fills in **null** assignments, so:

- Re-running it never overwrites a manual assignment.
- Changing a rule affects future transactions and anything still unassigned.
- **Re-assign everything** clears assignments first, when you want existing
  routing decisions re-made.

It runs automatically after every transaction sync and on the
`SYNC_UPDATES_AVAILABLE` webhook, and on demand:

```bash
curl -X POST localhost:3000/api/budgets/apply -d '{}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/api/budgets/apply -d '{"reset":true}' -H 'Content-Type: application/json'
```

```bash
# A merchant rule routing everything from Starbucks into a bucket
curl -X PUT localhost:3000/api/budgets/rules -H 'Content-Type: application/json' \
  -d '{"matchType":"merchant","matchValue":"Starbucks","budgetId":3}'
```

`PUT /api/budgets` upserts on `(kind, name)`, so saving the same name again
updates the row — that's what lets the UI save on blur. `PATCH
/api/transactions/[id]` accepts `budgetId` to file a single transaction.

### Actuals are sign-aware

Spending buckets sum only outgoing amounts; earnings buckets sum incoming ones.
This is not cosmetic. Summing `abs(amount)` inflates any category holding both
directions — in this project's own data a `TRAVEL` category whose transactions
net to **$500** reports **$24,500** that way. Bucket totals reconcile to the sum
of positive transaction amounts to the cent.

### Unlinking and removing accounts

Both are irreversible, and both cascade.

- **Unlink institution** — `DELETE /api/items/:id`. Calls Plaid `/item/remove`
  first so the grant is actually revoked at Plaid, then deletes the row.
  `items → accounts → transactions` all cascade, plus holdings, liabilities and
  investment transactions.
- **Remove one account** — `DELETE /api/accounts/:id`. Plaid exposes no
  single-account removal (an Item is the smallest unit), so this is local only
  and leaves the rest of the institution linked.

Budget buckets **survive** both: `transactions.budget_id` is `ON DELETE SET
NULL`, so buckets start reporting `$0` instead of disappearing.

The confirmation dialog states the exact account and transaction counts before
anything is deleted, and requires typing the institution name. It also says the
thing most people get wrong:

> Removing an institution does **not** free one of the 10 Items on your Plaid
> Trial plan. Re-linking later creates a new one.

If the Plaid revocation call fails, local rows are still removed — orphaned data
you asked to delete is worse than a stale Item — and the response says so, with a
pointer to remove it in the Plaid Dashboard.

## Not yet built

- **`/api/manual-accounts`** write routes and UI for creating manual accounts.
  The table and the net-worth read path are done.
- **Category override UI.** `PATCH /api/transactions/[id]` works, but there's no
  control on the transactions page to call it yet. Buckets *are* assignable per
  transaction via the same endpoint.
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