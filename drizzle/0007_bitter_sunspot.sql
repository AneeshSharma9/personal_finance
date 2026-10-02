-- A rule is now a SET of steps, and each row in budget_rules is one step.
--
-- The old unique key was (user_id, match_type, match_value), one row per match,
-- which is why saving a second target for an existing match replaced the first
-- one instead of adding to it. Replaced by one row per (match, target).
--
-- coalesce around the two nullable ids because a btree unique index treats NULLs
-- as distinct, so without it the same "ignore" step could be inserted twice.
-- -1 is not a real id; both columns are identity columns starting at 1.
--
-- No data change: existing rows already satisfy the looser key. The
-- one_target CHECK is untouched - each row still has exactly one target.
DROP INDEX "budget_rules_user_type_value_key";--> statement-breakpoint
CREATE UNIQUE INDEX "budget_rules_user_match_target_key" ON "budget_rules" USING btree ("user_id","match_type","match_value",coalesce("budget_id", -1),coalesce("loan_id", -1),"exclude");--> statement-breakpoint
-- Grouping every step of one rule is now a lookup, not a full scan.
CREATE INDEX "budget_rules_user_match_idx" ON "budget_rules" USING btree ("user_id","match_type","match_value");