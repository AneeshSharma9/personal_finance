/**
 * Shapes for "which transactions is this rule affecting".
 *
 * Split out with no imports at all, deliberately.
 *
 * The matching itself has to run on the server, because it lives in
 * `matchesStoredRule` - beside the routing engine, in a `server-only` module. But
 * the rules page is a client component, and a client component that imports even a
 * *value* from a module in that chain drags the whole thing into the browser
 * bundle. TypeScript will not catch it: the types are erased, so `tsc` and `eslint`
 * pass and only the build fails.
 *
 * So this file holds everything the client can safely have - the types, and nothing
 * that needs the engine - and `rule-matches.ts` holds the matching.
 */

/** The fields matching needs, plus enough to describe a transaction to a person. */
export type RuleCandidate = {
  id: number;
  date: string;
  amount: number;
  merchantName: string | null;
  name: string | null;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  budgetId: number | null;
  excluded: boolean;
};

export type RuleMatch = {
  id: number;
  date: string;
  /** Merchant, falling back to the raw description. */
  label: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  excluded: boolean;
  /**
   * Whether the transaction already sits in the bucket this rule targets.
   *
   * The distinction that makes the list useful: `false` means the rule would move
   * it, `true` means it has already been applied. Without it, a long list gives no
   * hint whether the rule is doing anything.
   *
   * Null when the rule has no bucket step - a loan step has no bucket to be in.
   */
  inTarget: boolean | null;
};

export type RuleMatches = {
  /** Newest first, capped. */
  matches: RuleMatch[];
  /** How many match in total, which may exceed `matches.length`. */
  total: number;
  /** Transactions shown before the cap. */
  shown: number;
};

/**
 * Kept modest on purpose: enough to spot a wrong rule, not a transaction log.
 *
 * Also bounds the page payload, since the preview crosses to the client.
 */
export const MATCH_PREVIEW_LIMIT = 20;
