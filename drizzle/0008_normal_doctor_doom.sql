-- Where a loan payment came from: tagged by hand, or minted by a rule.
--
-- Needed to undo a removed rule step without also deleting a tag the user set
-- themselves on the transactions page. The two are otherwise identical rows.
--
-- Defaults to 'manual' so every existing payment is treated as the user's own
-- decision. That is the safe direction: an undo skips them rather than quietly
-- reversing a deliberate payment and its recorded interest split.
CREATE TYPE "public"."loan_payment_source" AS ENUM('manual', 'rule');--> statement-breakpoint
ALTER TABLE "loan_payments" ADD COLUMN "source" "loan_payment_source" DEFAULT 'manual' NOT NULL;
