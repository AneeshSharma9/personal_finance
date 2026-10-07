# Personal Finance

A self-hosted, Rocket Money–style personal finance tracker built on Plaid's free
Trial plan. It links your accounts through Plaid, routes every transaction into a
budget bucket automatically, and applies rules over the ones Plaid can't classify.
Web app first, installable on iPhone as a PWA.

Single-user by design: access is an email allowlist, and every query is scoped to
the signed-in user's id.

## What it does

| Area | What you get |
|---|---|
| **Accounts** | Link checking, savings, credit, brokerage, 401k and loans through Plaid. Holdings shown both as positions and as a single balance. |
| **Transactions** | Searchable and filterable by category and account; the filters live in the URL so a view can be shared. Click any one to see details or re-categorise it. |
| **Budgets** | Rocket Money's layout — Budget Basics, Budget Categories, Earnings — with the "Everything Else" bucket derived as whatever is left of your budgeted earnings. |
| **Rules** | Route transactions by merchant, category or amount; match on several alternatives at once; apply to history, not just future syncs. Steps can pay down a loan, file into a bucket, or exclude entirely. |
| **Budget worksheet** | A 50/30/20 planner with pay-period, withholding, HSA/401k and loan modelling. |
| **Cash flow** | A Sankey diagram of where the money actually went, with pan and zoom. |
| **Net worth** | Assets, liabilities and a recorded daily history. |
| **Manual loans** | Track a loan Plaid does not cover; interest and payoff projection computed from the payment schedule. |

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| UI | Tailwind v4, mobile-first |
| Database | Postgres (Supabase) via Drizzle ORM |
| Auth | Supabase Auth, locked to an email allowlist |
| Plaid | `plaid` Node SDK + `react-plaid-link` |
| Charts | `visx` (scales, shapes, axes, sankey, tooltip) |
| Tests | `node:test` via `tsx` (361 tests) |

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

Migrations enable Row-Level Security and revoke every table grant from `anon` and
`authenticated`, because Supabase grants them by default. Without that, the public
anon key — which ships in the browser bundle — can read and destroy the whole
database through PostgREST. See [docs/security.md](docs/security.md).

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

Before linking anything real, read [Plaid's constraints](docs/plaid.md) — the
Trial plan allows **10 Items** for the life of the account and one cannot be
recovered by removing it.

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
- **Keep `PLAID_ENV=sandbox` until you are ready.** See
  [Adding a bank](docs/plaid.md#adding-a-bank).

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

## Project layout

```
src/
  app/
    (app)/          signed-in pages: dashboard, accounts, transactions,
                    budgets, loans, rules, net-worth
    api/            route handlers: plaid, items, sync, transactions,
                    budgets, buckets, rules, loans, worksheet, cron, health
    login/          sign-in page
  components/       client components, one per feature area
  db/
    schema.ts       every table, column, index and constraint
    index.ts        the Drizzle client
  lib/
    plaid/          link, sync, webhook verification
    supabase/       auth clients
    queries.ts      read paths
    *-engine.ts     the write paths: routing, rules, loan payments
  proxy.ts          session refresh middleware
drizzle/            migrations, one .sql per change
tests/              node:test, one file per concern
docs/               design notes — see docs/README.md
```

Two conventions worth knowing before you read the code:

- **Reads live in `lib/queries.ts`; writes live in the engine modules.**
  `budget-engine.ts` fills in `transactions.budget_id` and never overwrites a
  non-null assignment, which is what makes a manual reassignment durable across
  re-syncs. `rules.ts` is the deliberate exception: a rule applied by hand is
  *supposed* to overwrite, because "make everything matching this go to Shopping"
  has to include last month's KFC.
- **Anything with a `server-only` import never reaches the browser.** The test
  runner resolves React through the `react-server` condition, so a client component
  that imported one would fail the build rather than leak.

## Development

```bash
npm test          # 361 tests, no database required
npm run typecheck
npm run lint
```

Tests run on `node:test` through `tsx` and read `.env.local`. Most are pure and
need no network; several assert against the **source** rather than a rendered
component, because the components call `useRouter()` and cannot be rendered
outside an app router — or because the thing being guarded is a relationship
between two files that neither test can see alone.

Two conventions the test suite enforces, because both were real bugs:

- **No HTML entities inside JS string literals.** JSX decodes `&larr;` only in
  children position; inside `{...}` it renders literally. `tests/jsx-entities.test.mts`
  walks string literals properly rather than pattern-matching, since a regex
  cannot tell `"{a}" &middot;{" "}` from a real violation.
- **The client boundary.** A type-only import of a `server-only` module is free,
  so `tsc` and `eslint` both pass while a *value* import drags the whole chain
  into the browser bundle. `tests/client-boundary.test.mts` reads the import graph.

### Changing the schema

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` — writes `drizzle/NNNN_*.sql` and a snapshot.
3. Add the data backfill by hand if the change needs one. Migrations are plain
   SQL and are edited after generation; `0014` and `0015` both are.
4. `npm run db:migrate`.
5. `npm test` — `tests/rls-coverage.test.mts` fails if the new table has no
   Row-Level Security lines.

Migrations are applied per environment, so a new one has to be run against
production too. `drizzle-kit migrate` tracks what it has applied; Supabase's SQL
editor takes the same `.sql` file.

## Documentation

Design notes live in [`docs/`](docs/README.md) — one file per feature, covering
what was decided and *why*, including the reasoning behind decisions that look
wrong until you know the history. Start with:

| | |
|---|---|
| [Architecture](docs/architecture.md) | The original build plan: scope, data model, API surface |
| [Security](docs/security.md) | Access control, RLS, what the Supabase advisor reports |
| [Budgets](docs/budgets.md) | Buckets, routing, the unassigned queue, the remainder bucket |
| [Rules](docs/rules.md) | Match types, precedence, steps, undo |
| [Plaid](docs/plaid.md) | Trial-plan limits to design around; adding a bank |
| [Known issues](docs/roadmap.md) | What is broken, and what is not built yet |

## Security

Access is an email allowlist plus per-query `user_id` scoping; every route
re-checks the session. `src/proxy.ts` is a UX convenience, not the security
boundary. Supabase is used for **auth only** — all data access goes through
Drizzle as the table owner.

Before deploying your own instance, read [docs/security.md](docs/security.md),
particularly the RLS section: Supabase grants `anon` and `authenticated` full
table access by default, and migrations `0016`/`0017` are what close that.