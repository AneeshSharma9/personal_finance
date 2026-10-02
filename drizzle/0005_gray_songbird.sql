ALTER TYPE "public"."budget_rule_match_type" ADD VALUE 'amount';--> statement-breakpoint
ALTER TABLE "budget_rules" ALTER COLUMN "budget_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_rules" ADD COLUMN "loan_id" integer;--> statement-breakpoint
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_rules_user_loan_idx" ON "budget_rules" USING btree ("user_id","loan_id");--> statement-breakpoint
-- A rule routes to either a bucket or a loan, never both and never neither.
-- All pre-existing rows set budget_id and leave loan_id null, so this validates
-- against the current data rather than failing the migration.
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_one_target_check" CHECK ((budget_id IS NOT NULL) <> (loan_id IS NOT NULL));
