import { matchesStoredRule, type StoredRule } from "@/lib/rules";
import {
  MATCH_PREVIEW_LIMIT,
  type RuleCandidate,
  type RuleMatches,
} from "@/lib/rule-match-types";

/**
 * Which transactions a rule is affecting. **Server only.**
 *
 * Built on the same `matchesStoredRule` the routing engine uses, so a count here
 * cannot disagree with what saving a rule actually did - which is the only property
 * worth having, and the reason this does not live near the client component that
 * displays it. See `rule-match-types.ts` for why that split exists.
 */

/**
 * The transactions one rule affects, newest first.
 *
 * A rule can name several alternatives, so a row is in scope when it matches any of
 * them - which is the same "one of these" reading the router applies row by row.
 * Each alternative is asked separately rather than the values being joined into one
 * string: "600 or 700" as a substring would look for an amount containing both.
 *
 * Excluded rows are included deliberately. They are excluded from budgeting, but
 * they still *match*, and a rule that silently appears to affect nothing because
 * its matches are all excluded is exactly the case this view exists to explain.
 * Each row says which it is.
 */
export function transactionsForRule(
  candidates: readonly RuleCandidate[],
  rule: {
    matchType: StoredRule["matchType"];
    matchValues: readonly string[];
  },
  targetBudgetId: number | null = null,
  limit: number = MATCH_PREVIEW_LIMIT,
): RuleMatches {
  const matched = candidates.filter((row) =>
    rule.matchValues.some((value) =>
      matchesStoredRule(row, { matchType: rule.matchType, matchValue: value }),
    ),
  );

  // Newest first, id as a tiebreak so same-day rows do not reorder between loads.
  const ordered = [...matched].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
  );

  const matches = ordered.slice(0, Math.max(limit, 0)).map((row) => ({
    id: row.id,
    date: row.date,
    label: row.merchantName?.trim() || row.name?.trim() || "(no description)",
    amount: row.amount,
    excluded: row.excluded,
    inTarget:
      targetBudgetId === null ? null : row.budgetId === targetBudgetId,
  }));

  return {
    matches,
    total: matched.length,
    shown: matches.length,
  };
}

export type { RuleCandidate, RuleMatch, RuleMatches } from "@/lib/rule-match-types";
export { MATCH_PREVIEW_LIMIT } from "@/lib/rule-match-types";
