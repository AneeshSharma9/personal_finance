/**
 * The remainder bucket as what is left over.
 *
 * Every other bucket's Budgeted figure is a decision the user made. The remainder
 * bucket's is an output: the budgeted income less everything the other buckets were
 * given. Which means it cannot also be a decision — a figure you can type into it is
 * a figure that can disagree with the rest of the page, and the usual outcome is a
 * set of budgets adding up to more than the income they are spending, discovered at
 * the end of the month rather than at the point of entry.
 *
 * So it is derived, never stored-as-truth. Nothing is written back: the stored
 * `monthlyLimit` on that row is ignored wherever a plan has been built, which keeps
 * the figure correct the instant any other bucket is edited rather than only after
 * the next save.
 *
 * Income is the *budgeted* income, not the money that actually arrived. The pages
 * are plans — the Earnings table carries a Budgeted column like every other table —
 * and mixing a plan with an actual would mean the remainder moved as deposits
 * landed, so a figure the user typed into Rent would quietly stop meaning what they
 * typed.
 *
 * A negative remainder is reported, not hidden. Over-allocating is a real and common
 * state, and clamping to zero would both hide the shortfall and leave the totals
 * adding up to more than the income. The minus sign carries it.
 *
 * Pure and React-free so it can be tested, and so that the budget grid, the summary
 * card above it, the bucket's own page and the dashboard all derive one number the
 * same way. Four views of the same figure, computed once.
 */

import { isRemainderBucket } from "@/lib/categories";
import type { BudgetGroups, BudgetRowResult } from "@/lib/queries";

/** The columns the remainder is computed from, and nothing else it needs. */
export type RemainderInput = {
  id: number;
  kind: "basic" | "category" | "earning";
  name: string;
  /** Plaid categories this bucket claims. Non-empty means it is not a remainder. */
  categories: readonly string[];
  budgeted: number;
};

export type RemainderPlan = {
  /** The derived limit, or null when there is no remainder bucket. */
  limit: number | null;
  /** Which bucket carries it, or null. Same null-ness as `limit`. */
  bucketId: number | null;
  earningsBudgeted: number;
  /** Every spending bucket's limit, the remainder one included. */
  spendingBudgeted: number;
};

/**
 * The remainder bucket out of the plan's buckets.
 *
 * A user can end up with more than one — the unique constraint is on (kind, name),
 * so "Everything Else" under Budget Basics and "Other" under Budget Categories both
 * qualify — and then only one of them can be the leftover. The oldest wins, by id:
 * that is the row `bucketCategoryRules` reaches first when routing uncategorised
 * spending, so it is the row whose figure has to be the remainder for the page to be
 * describing the same thing the engine is doing. An extra remainder bucket keeps its
 * own limit and is subtracted like any other row.
 *
 * Lowest id rather than "first in the array" on purpose: callers hand over rows in
 * whatever order they were queried or displayed in, and the display sort reorders as
 * amounts change, so positional selection would move the figure between two rows
 * every time a budget was edited.
 */
function remainderBucket(
  spending: readonly RemainderInput[],
): RemainderInput | null {
  let best: RemainderInput | null = null;
  for (const row of spending) {
    if (!isRemainderBucket(row.name, row.categories)) continue;
    if (best === null || row.id < best.id) best = row;
  }
  return best;
}

/**
 * Derive the remainder from every bucket in the plan.
 *
 * Takes the earnings rows too, rather than a pre-filtered spending set and a
 * separate income figure: the two cannot then be passed in inconsistently, and
 * there is no way to accidentally measure the plan against itself.
 */
export function planFrom(rows: readonly RemainderInput[]): RemainderPlan {
  const spending = rows.filter((row) => row.kind !== "earning");
  const earningsBudgeted = budgetedTotal(rows.filter((r) => r.kind === "earning"));
  const remainder = remainderBucket(spending);

  if (remainder === null) {
    return {
      limit: null,
      bucketId: null,
      earningsBudgeted,
      spendingBudgeted: budgetedTotal(spending),
    };
  }

  const allocated = budgetedTotal(spending.filter((row) => row.id !== remainder.id));
  const limit = toCents(earningsBudgeted - allocated);

  return {
    limit,
    bucketId: remainder.id,
    earningsBudgeted,
    spendingBudgeted: allocated + limit,
  };
}

/**
 * Round to whole cents, because this is money and because the figure is written into
 * a field that would otherwise show the float's noise — $1,234.5600000000001 in a
 * budget row is not a rounding curiosity, it is the page telling the user it does
 * not know what the number is.
 */
function toCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The budget groups with the remainder bucket's figure replaced by the remainder.
 *
 * Returns the input unchanged when there is no remainder bucket, so a caller can
 * apply this unconditionally and pay one pass over rows it already has.
 */
export function applyRemainderBucket(groups: BudgetGroups): BudgetGroups {
  const plan = planFrom([...groups.basic, ...groups.category, ...groups.earning]);
  if (plan.limit === null || plan.bucketId === null) return groups;
  const limit = plan.limit;

  const replace = (row: BudgetRowResult): BudgetRowResult =>
    row.id !== plan.bucketId
      ? row
      : {
          ...row,
          budgeted: limit,
          // Derived from the new figure rather than shifted by the old one, so a
          // stale stored limit cannot leak into the leftover or the percentage.
          remaining: limit - row.actual,
          percentUsed: limit > 0 ? (row.actual / limit) * 100 : null,
        };

  return {
    ...groups,
    basic: groups.basic.map(replace),
    category: groups.category.map(replace),
    earning: groups.earning,
  };
}

/**
 * The limit to show for one bucket: the derived remainder for that one bucket, and
 * the stored limit for every other.
 *
 * So a page can read every bucket's `monthlyLimit` the same way and get the derived
 * figure for exactly the row that needs one — which is the whole point of deriving
 * it, rather than expecting each reader to remember.
 */
export function displayLimit(
  plan: RemainderPlan,
  bucket: { id: number; budgeted: number },
): number {
  return plan.bucketId === bucket.id && plan.limit !== null
    ? plan.limit
    : bucket.budgeted;
}

/**
 * The budgeted total of a group.
 *
 * The budgeted income is the remainder's baseline, so a caller needs this on the
 * earnings rows before it can apply the remainder — and then on every group again to
 * foot the tables. One helper for both, so "add up the Budgeted column" is not
 * re-implemented per caller.
 */
export function budgetedTotal(
  rows: readonly { budgeted: number }[],
): number {
  return rows.reduce((sum, row) => sum + row.budgeted, 0);
}