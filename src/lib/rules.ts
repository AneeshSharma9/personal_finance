import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { loadRuleSet, type RuleSet } from "@/lib/budget-engine";
import { recordLoanPayment } from "@/lib/loan-payments";

/**
 * Applying rules to transactions that already exist.
 *
 * `applyBudgetRules` in budget-engine.ts only fills in *unassigned* transactions,
 * which is what keeps a manual assignment durable across re-syncs. That same
 * property is why a new rule appears to do nothing: every transaction the rule
 * matches has usually been assigned already, by an earlier run or by hand.
 *
 * These functions are the other half. They deliberately overwrite, because
 * "make everything matching this rule go to Shopping" is only useful if it
 * includes last month's KFC.
 */

export type RuleTargetKind = "bucket" | "loan";

export type StoredRule = {
  id: number;
  matchType: "merchant" | "category" | "amount";
  matchValue: string;
  budgetId: number | null;
  loanId: number | null;
};

export type ApplyResult = {
  /** Transactions whose target actually changed. */
  moved: number;
  /** Transactions the rule matched, including ones already pointing there. */
  matched: number;
  target: RuleTargetKind;
};

/** Transactions that could match a rule, newest last so loan payments accrue in order. */
async function ruleCandidateRows(
  userId: string,
  options: { excludePending: boolean } = { excludePending: true },
) {
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  if (items.length === 0) return [];

  const accounts = await db.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((item) => item.id),
    ),
    columns: { id: true },
  });
  if (accounts.length === 0) return [];

  const conditions = [inArray(tables.transactions.accountId, accounts.map((a) => a.id))];
  if (options.excludePending) {
    conditions.push(eq(tables.transactions.pending, false));
  }

  return db.query.transactions.findMany({
    where: and(...conditions),
    // Ascending: a bulk loan application inserts one payment per transaction, and
    // each insert advances the loan's accrual cursor. Backfilling newest-first
    // would accrue a whole year of interest against the first payment and none
    // against the rest.
    orderBy: [asc(tables.transactions.date), asc(tables.transactions.id)],
    columns: {
      id: true,
      date: true,
      amount: true,
      merchantName: true,
      name: true,
      categoryOverride: true,
      plaidCategoryPrimary: true,
      plaidCategoryDetailed: true,
      budgetId: true,
    },
  });
}

/**
 * Does one transaction match one rule?
 *
 * Shared by the bucket and loan paths so "merchant contains KFC" means the same
 * thing whichever target the rule points at.
 */
export function matchesStoredRule(
  row: {
    merchantName: string | null;
    name: string | null;
    amount: number;
    categoryOverride?: string | null;
    plaidCategoryPrimary?: string | null;
    plaidCategoryDetailed?: string | null;
  },
  rule: StoredRule,
): boolean {
  switch (rule.matchType) {
    case "merchant": {
      const haystack = `${row.merchantName ?? ""} ${row.name ?? ""}`.toLowerCase();
      const needle = rule.matchValue.trim().toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    }
    case "amount": {
      const target = Number(rule.matchValue);
      if (!Number.isFinite(target)) return false;
      return Math.abs(target - Math.abs(row.amount)) < 0.005;
    }
    case "category": {
      // Category matching keeps the engine's boundary-aware prefix semantics
      // rather than a plain substring, so FOOD_AND_DRINK does not swallow
      // FOOD_AND_DRINK_TRAVEL by accident.
      const value = rule.matchValue.trim().toUpperCase();
      if (!value) return false;
      return categoryMatch(row, value);
    }
    default:
      return false;
  }
}

function categoryMatch(
  row: {
    categoryOverride?: string | null;
    plaidCategoryPrimary?: string | null;
    plaidCategoryDetailed?: string | null;
  },
  value: string,
): boolean {
  /*
   * A category override is the user's own decision, so it is authoritative and
   * Plaid's categories are not consulted at all when one exists. This mirrors
   * resolveBucket in budget-engine.ts; if the two disagree, saving a rule would
   * quietly re-route transactions the sync engine leaves alone.
   */
  const override = row.categoryOverride?.trim();
  const candidates = override
    ? [override]
    : [row.plaidCategoryPrimary, row.plaidCategoryDetailed].filter(
        (entry): entry is string => Boolean(entry),
      );

  const upper = candidates.map((entry) => entry.trim().toUpperCase());

  return upper.some(
    (candidate) =>
      candidate === value ||
      candidate.startsWith(`${value}_`) ||
      value.startsWith(`${candidate}_`),
  );
}

/**
 * Apply one bucket rule to every matching transaction, including ones already in
 * another bucket.
 */
export async function applyBucketRuleToHistory(
  userId: string,
  rule: StoredRule,
): Promise<ApplyResult> {
  if (rule.budgetId === null) {
    return { moved: 0, matched: 0, target: "bucket" };
  }

  const rows = await ruleCandidateRows(userId);
  let matched = 0;
  let moved = 0;

  for (const row of rows) {
    const amount = toNumber(row.amount);
    if (!matchesStoredRule({ ...row, amount }, rule)) continue;
    matched += 1;
    if (row.budgetId === rule.budgetId) continue;
    moved += 1;
    await db
      .update(tables.transactions)
      .set({ budgetId: rule.budgetId, updatedAt: new Date() })
      .where(eq(tables.transactions.id, row.id));
  }

  return { moved, matched, target: "bucket" };
}

/**
 * Apply one loan rule to every matching transaction, creating a payment for each.
 *
 * Processed in date order for the reason given on ruleCandidateRows: each
 * inserted payment advances the loan's accrual cursor, so out-of-order inserts
 * would charge a year of interest against the wrong payment.
 */
export async function applyLoanRuleToHistory(
  userId: string,
  rule: StoredRule,
): Promise<ApplyResult> {
  if (rule.loanId === null) {
    return { moved: 0, matched: 0, target: "loan" };
  }

  const rows = await ruleCandidateRows(userId);

  // Already-tagged transactions are skipped: loan_payments.transaction_id is
  // unique and this path is about first-time assignment.
  const tagged = await db
    .select({ transactionId: tables.loanPayments.transactionId })
    .from(tables.loanPayments)
    .where(eq(tables.loanPayments.loanId, rule.loanId));
  const already = new Set(tagged.map((entry) => entry.transactionId));

  let matched = 0;
  let moved = 0;

  for (const row of rows) {
    const amount = toNumber(row.amount);
    if (!matchesStoredRule({ ...row, amount }, rule)) continue;

    // A loan payment is money out. Plaid signs are positive for outflow, so an
    // inflow matching the rule is left alone rather than silently flipped.
    if (amount <= 0) continue;
    if (already.has(row.id)) continue;

    matched += 1;
    try {
      await recordLoanPayment({
        loanId: rule.loanId,
        userId,
        transactionId: row.id,
        paidOn: row.date,
        amount,
      });
      moved += 1;
    } catch (error) {
      // One bad row must not abandon the rest of the backfill.
      console.error("[rules] could not record a loan payment:", error);
    }
  }

  return { moved, matched, target: "loan" };
}

export async function applyRuleToHistory(
  userId: string,
  rule: StoredRule,
): Promise<ApplyResult> {
  return rule.loanId === null
    ? applyBucketRuleToHistory(userId, rule)
    : applyLoanRuleToHistory(userId, rule);
}

/**
 * Route untagged transactions to loans, run after a sync.
 *
 * Mirrors applyBudgetRules: only transactions with no existing payment are
 * touched, so a payment the user assigned by hand is never duplicated.
 */
export async function applyLoanRules(
  userId: string,
): Promise<{ scanned: number; tagged: number }> {
  const ruleSet = await loadRuleSet(userId);
  if (ruleSet.loanRules.length === 0) return { scanned: 0, tagged: 0 };

  const rows = await ruleCandidateRows(userId);
  if (rows.length === 0) return { scanned: 0, tagged: 0 };

  const alreadyTagged = await db.select({
    transactionId: tables.loanPayments.transactionId,
  }).from(tables.loanPayments);
  const tagged = new Set(alreadyTagged.map((entry) => entry.transactionId));

  let scanned = 0;
  let count = 0;

  for (const row of rows) {
    const loanId = resolveLoan({ ...row, amount: toNumber(row.amount) }, ruleSet);
    if (loanId === null) continue;
    scanned += 1;
    if (tagged.has(row.id)) continue;

    const amount = toNumber(row.amount);
    if (amount <= 0) continue;

    try {
      await recordLoanPayment({
        loanId,
        userId,
        transactionId: row.id,
        paidOn: row.date,
        amount,
      });
      count += 1;
    } catch (error) {
      console.error("[rules] could not record a loan payment:", error);
    }
  }

  return { scanned, tagged: count };
}

/**
 * Which loan, if any, a transaction pays.
 *
 * Evaluated in the rule table's own priority order, so the same precedence that
 * decides which bucket wins decides which loan wins.
 */
export function resolveLoan(
  row: {
    merchantName: string | null;
    name: string | null;
    amount: number;
    categoryOverride: string | null;
    plaidCategoryPrimary: string | null;
    plaidCategoryDetailed: string | null;
  },
  rules: RuleSet,
): number | null {
  for (const rule of rules.loanRules) {
    const stored: StoredRule = {
      id: 0,
      matchType: rule.matchType as StoredRule["matchType"],
      matchValue: rule.value,
      budgetId: null,
      loanId: rule.loanId,
    };
    if (matchesStoredRule(row, stored)) return rule.loanId;
  }
  return null;
}