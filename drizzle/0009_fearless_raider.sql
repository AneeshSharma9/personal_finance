-- Where a step sits among its sibling steps.
--
-- A rule's steps are independent, so this decides nothing but the order they are
-- listed and applied in - but the user reorders them on purpose, so it has to
-- survive the page re-rendering. Ordering by id instead would snap them back to
-- the order they were first created in.
--
-- Existing rows all default to 0, which is harmless: they keep their current
-- relative order because the id tiebreak still applies.
ALTER TABLE "budget_rules" ADD COLUMN "step_order" integer DEFAULT 0 NOT NULL;
