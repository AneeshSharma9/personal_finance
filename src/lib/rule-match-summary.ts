import type { RuleMatches } from "@/lib/rule-match-types";

/**
 * One line describing how much a rule matches.
 *
 * Client-safe on purpose, and in its own module for that reason: `rule-matches.ts`
 * reaches `matchesStoredRule` and so cannot be imported by a client component, and
 * this string is the one thing the collapsed row needs.
 *
 * "No matches" reads differently from "12 matches", and a rule matching nothing is
 * the most common reason a rule does not work - so this is always on screen.
 */
export function summariseMatches(result: RuleMatches): string {
  if (result.total === 0) return "No matching transactions";
  if (result.total === 1) return "1 matching transaction";
  return `${result.total} matching transactions`;
}
