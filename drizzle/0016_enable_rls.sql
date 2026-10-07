-- Every table in `public` was reachable by anyone holding the project URL and the
-- anon key - which is in the browser bundle by design, so it is public. With RLS
-- off and table grants in place, PostgREST served the lot: all 358 transactions,
-- the loans, the loan payments and the user row, to an unauthenticated caller,
-- with UPDATE and DELETE available too.
--
-- This app never needed that access. Supabase is used for AUTH only
-- (`supabase.auth.getUser()` in lib/auth.ts); every table is read and written
-- through Drizzle over DATABASE_URL, which connects as `postgres` - the table
-- owner - and so bypasses RLS. Turning RLS on therefore closes the public door
-- without touching the app.
--
-- Two controls, deliberately:
--
--   1. ENABLE ROW LEVEL SECURITY with **no policies**. RLS on plus no policy is
--      deny-by-default, so `anon` and `authenticated` match nothing. There is
--      nothing to write a policy against anyway - per-user access is enforced in
--      application code by scoping every query to the session's user id, and a
--      policy here would be a second, weaker copy of that.
--
--   2. REVOKE the grants as well. RLS alone is enough today, but these grants are
--      what made the table "publicly accessible" in the first place, and leaving
--      them means a future accidental `DISABLE ROW LEVEL SECURITY` - or a table
--      recreated by `drizzle-kit push` - is instantly exploitable again.
--
-- NO `FORCE ROW LEVEL SECURITY`: that applies RLS to the owner too, and with no
-- policies that locks the app out of its own data. The owner bypass is exactly
-- what makes the no-policy version safe.
--
-- Note `auth.*` is untouched: Supabase manages that schema and it already has RLS.
-- New tables need both lines; tests/rls-coverage.test.mts fails the build if one
-- is missed.
ALTER TABLE "public"."account_balance_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."account_balance_snapshots" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."account_balance_snapshots" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."accounts" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."accounts" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."budget_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budget_rules" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budget_rules" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."budget_worksheet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budget_worksheet" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budget_worksheet" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budgets" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."budgets" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."holdings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."holdings" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."holdings" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."investment_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."investment_transactions" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."investment_transactions" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."items" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."items" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."liabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."liabilities" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."liabilities" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."loan_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."loan_payments" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."loan_payments" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."loans" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."loans" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."manual_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."manual_accounts" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."manual_accounts" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."net_worth_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."net_worth_snapshots" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."net_worth_snapshots" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."recurring" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."recurring" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."recurring" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."securities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."securities" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."securities" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."transactions" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."transactions" FROM "authenticated";--> statement-breakpoint
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."users" FROM "anon";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."users" FROM "authenticated";