ALTER TABLE "budget_rules" ADD COLUMN "exclude" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_excluded_idx" ON "transactions" USING btree ("excluded");--> statement-breakpoint
-- A rule now targets exactly one of: a bucket, a loan, or "ignore this".
--
-- The previous constraint required exactly one of budget_id/loan_id, which left
-- no room for an exclusion rule.
--
-- Counted as `::int` of each boolean rather than with `num_nonnulls`, because
-- num_nonnulls counts NON-NULL values: `exclude` defaults to false, which is
-- perfectly non-null, so every existing rule would score 2 and the constraint
-- would reject the table. Casting to int counts only the ones that are TRUE.
ALTER TABLE "budget_rules" DROP CONSTRAINT IF EXISTS "budget_rules_one_target_check";--> statement-breakpoint
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_one_target_check" CHECK (((budget_id IS NOT NULL)::int + (loan_id IS NOT NULL)::int + exclude::int) = 1);
