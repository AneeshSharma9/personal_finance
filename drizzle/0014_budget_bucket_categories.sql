-- A bucket is rarely one category: "Weekend" is dining AND entertainment,
-- "Amazon" is general merchandise AND online shopping. With one text column the
-- only options were a vague bucket name or several buckets competing for the same
-- transactions - and two buckets sharing a category was not rejected, so only the
-- first ever matched while the second read $0 forever with nothing explaining why.
--
-- Backfilled from the old single value, so no bucket loses the category it was
-- already measuring against. The order matters: add and populate the new column
-- before dropping the old one, or the values are gone in between.
ALTER TABLE "budgets" ADD COLUMN "categories" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "budgets" SET "categories" = ARRAY["category"] WHERE "category" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" DROP COLUMN "category";--> statement-breakpoint
