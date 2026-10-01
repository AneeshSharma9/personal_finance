CREATE TYPE "public"."budget_kind" AS ENUM('basic', 'category', 'earning');--> statement-breakpoint
DROP INDEX "budgets_user_category_key";--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "budget_kind" "budget_kind" DEFAULT 'category' NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_user_kind_name_key" ON "budgets" USING btree ("user_id","budget_kind","name");--> statement-breakpoint
CREATE INDEX "budgets_user_kind_idx" ON "budgets" USING btree ("user_id","budget_kind");