/**
 * Budget buckets and category matching.
 *
 * Deliberately NOT a hardcoded enum of Plaid categories. Plaid introduced a PFC
 * v2 taxonomy for Items created after 2025-12-03, and category values are
 * open-ended, so a frozen list would silently stop matching. Instead a budget row
 * stores a category string and we match it, case-insensitively, against every
 * category a transaction actually carries.
 *
 * There is also no built-in list of buckets to suggest. The picker offers the
 * categories present in the user's own transactions, and nothing else, so every
 * option is one they have actually spent in. A seeded template list used to sit
 * here, and it was worse than useless: it offered things like LOAN_PAYMENTS and
 * SAVINGS, so buckets named "Loan Payments Car Payment" and "Savings & Debt"
 * would be created against categories that were never a real boundary. A
 * transaction's own Plaid category is the honest unit of a bucket, and a bucket
 * the user wants to name themselves does not need a category at all - see
 * `category` on the budgets table, which is nullable for exactly that reason.
 */

/** Category values that mean "money in", used for earnings actuals. */
export const EARNING_CATEGORY_HINTS = [
  "INCOME",
  "PAYROLL",
  "PAYCHECK",
  "INTEREST_EARNINGS",
  "INCOME_WAGES",
  "INCOME_INTEREST_EARNINGS",
];

/** Categories that look like spending rather than income. */
export const isEarningCategory = (category: string): boolean =>
  EARNING_CATEGORY_HINTS.some(
    (hint) => category.toUpperCase().includes(hint),
  );

/**
 * Category values present in a transaction, most specific first.
 *
 * A transaction carries an override (user's choice), a detailed and a primary
 * Plaid category. All three are candidates so a bucket can match whichever level
 * it was built around.
 */
export function categoryCandidates(row: {
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
}): string[] {
  const values = [
    row.categoryOverride,
    row.plaidCategoryDetailed,
    row.plaidCategoryPrimary,
  ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const upper = value.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

/** Whether any candidate equals `category`, or the bucket's literal name. */
export function matchesCategory(
  candidates: string[],
  category: string | null,
  bucketName?: string,
): boolean {
  const target = category?.toUpperCase() ?? null;

  if (target) {
    if (candidates.includes(target)) return true;
    // Prefix match lets a bucket absorb a whole family, e.g. matching
    // FOOD_AND_DRINK catches GROCERIES and RESTAURANT too.
    if (
      candidates.some(
        (candidate) =>
          candidate.startsWith(`${target}_`) || target.startsWith(`${candidate}_`),
      )
    ) {
      return true;
    }
  }

  // "Everything Else" is a bucket name, not a category: it matches any spending
  // that no other bucket claimed.
  if (bucketName && isCatchAll(bucketName)) {
    return candidates.length > 0;
  }

  return false;
}

export function isCatchAll(name: string): boolean {
  return /everything\s*else|^other$/i.test(name.trim());
}

/** Turn "FOOD_AND_DRINK_GROCERIES" into "Food and Drink Groceries". */
export function humanizeCategory(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}