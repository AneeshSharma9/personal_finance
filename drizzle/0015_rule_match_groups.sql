-- A rule could only ever match one thing. The alternative to "UAS" was writing
-- the whole rule twice - once for "UAS", once for "US Department of Education" -
-- and then editing the step in both places, forever.
--
-- `rule_group` is the rule's identity, generated rather than typed: rows sharing
-- one are a single rule with several alternative match values, and every step of
-- that rule is repeated once per value. Each row still matches exactly one thing
-- and does exactly one thing, which is why the router, the undo path and the
-- one-target CHECK all carry on working untouched.
--
-- Backfilled so each existing rule gets ONE group, not one per row: today a rule
-- is every row sharing (user_id, match_type, match_value), so that is what the
-- grouping has to reproduce or every existing multi-step rule would come apart
-- into several one-step rules.
ALTER TABLE "budget_rules" ADD COLUMN "rule_group" uuid;--> statement-breakpoint
UPDATE "budget_rules" AS rule SET "rule_group" = grouped."rule_group" FROM (
  SELECT gen_random_uuid() AS "rule_group", "user_id", "match_type", "match_value"
  FROM "budget_rules"
  GROUP BY "user_id", "match_type", "match_value"
) AS grouped
WHERE grouped."user_id" = rule."user_id"
  AND grouped."match_type" = rule."match_type"
  AND grouped."match_value" = rule."match_value";--> statement-breakpoint
CREATE INDEX "budget_rules_user_group_idx" ON "budget_rules" USING btree ("user_id","rule_group");