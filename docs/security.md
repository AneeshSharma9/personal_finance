# Security notes

- Plaid secrets are server-only; every Plaid module imports `server-only`, so a
  client import is a build error rather than a runtime leak.
- Access tokens are encrypted at rest with AES-256-GCM. Logs never include
  tokens or full transaction payloads.
- `ALLOWED_EMAILS` plus per-query `user_id` scoping are the access control for
  **this app's own connections**. Every query goes through Drizzle over
  `DATABASE_URL`, which connects as `postgres` — the table *owner* — and owners
  bypass RLS. Do not assume RLS scopes anything here; it does not.
- RLS's job is the *other* door. `anon` and `authenticated` are what PostgREST
  uses, and before `0016_enable_rls` they had full `SELECT, INSERT, UPDATE,
  DELETE` on every table with RLS off, so anyone who loaded the deployed app could
  read and destroy the database through the public anon key. RLS on with **no
  policies** is deny-by-default for those roles, which is what closes it. Do not
  add a policy here: it would be a second, weaker copy of the scoping the queries
  already do, and the one place a mistake would re-open the door.
- Every function in `public` pins `search_path = ''` and qualifies the names it
  uses. `apply_loan_payment_to_balance` moves money; with a mutable path, a
  `loans` table earlier on the path would have received the balance update instead.
- Every route re-checks the session and scopes by `user_id`.
  `src/proxy.ts` is a UX convenience, not the security boundary.
- API routes are never redirected by the proxy; they return real status codes.

## What Supabase's advisor will keep reporting

Two findings are expected and should not be "fixed":

- **`rls_enabled_no_policy` on all 17 tables (INFO).** The linter cannot tell an
  intentional deny from a forgotten policy. No policies *is* the intent.
  `tests/rls-coverage.test.mts` asserts RLS is on and the grants are revoked.

One is a dashboard setting rather than code:

- **`auth_leaked_password_protection` (WARN).** Supabase Auth can check passwords
  against HaveIBeenPwned. It is toggled in the dashboard under **Authentication →
  Sign In / Providers**, not in SQL.
