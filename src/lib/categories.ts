/**
 * Budget buckets and category matching.
 *
 * Deliberately NOT a hardcoded enum of Plaid categories. Plaid introduced a PFC
 * v2 taxonomy for Items created after 2025-12-03, and category values are
 * open-ended, so a frozen list would silently stop matching. Instead a budget row
 * stores a category string and we match it, case-insensitively, against every
 * category a transaction actually carries. The UI offers the categories present
 * in the user's own data, which is always valid.
 */

export type BudgetBucket = {
  /** Display name, Rocket Money style. */
  name: string;
  /** Plaid category values this bucket absorbs. */
  matches: string[];
};

/**
 * Suggested starting buckets, mirroring the Rocket Money layout.
 *
 * `matches` holds Plaid category values. Plaid lumps groceries and restaurants
 * into one FOOD_AND_DRINK primary, so they are separated on the *detailed*
 * category instead - which is why matching checks detailed as well as primary.
 */
export const suggestedBuckets: BudgetBucket[] = [
  {
    name: "Bills & Utilities",
    matches: [
      "RENT_AND_UTILITIES",
      "UTILITIES",
      "RENT",
      "ELECTRICITY",
      "GAS_AND_ELECTRICITY",
      "INTERNET_AND_CABLE",
      "TELEPHONE",
      "WATER",
    ],
  },
  {
    name: "Groceries",
    matches: ["FOOD_AND_DRINK_GROCERIES", "GROCERIES"],
  },
  {
    name: "Dining & Drinks",
    matches: ["FOOD_AND_DRINK_RESTAURANT", "RESTAURANT"],
  },
  {
    name: "Transportation",
    matches: [
      "TRANSPORTATION",
      "GASOLINE_AND_FUEL",
      "PUBLIC_TRANSPORTATION",
      "PARKING_AND_TOLLS",
      "AUTO_PAYMENT",
    ],
  },
  {
    name: "Insurance",
    matches: ["LOAN_PAYMENTS", "INSURANCE"],
  },
  {
    name: "Health & Fitness",
    matches: ["PERSONAL_CARE", "MEDICAL"],
  },
  {
    name: "Shopping",
    matches: ["GENERAL_MERCHANDISE", "RETAIL", "APPAREL"],
  },
  {
    name: "Entertainment",
    matches: ["ENTERTAINMENT", "RECREATION"],
  },
  {
    name: "Travel",
    matches: ["TRAVEL", "AIRLINES"],
  },
  {
    name: "Savings & Debt",
    matches: ["LOAN_PAYMENTS", "BANK_FEES", "SAVINGS"],
  },
  {
    name: "Income",
    matches: ["INCOME", "PAYROLL", "PAYCHECK", "INTEREST_EARNINGS"],
  },
  {
    name: "Everything Else",
    // A catch-all so nothing silently goes untracked. Matched as a literal
    // bucket rather than a Plaid category; see matchBucket.
    matches: [],
  },
];

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