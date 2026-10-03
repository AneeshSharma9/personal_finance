import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { loadRuleSet, isBalanceMovement, type RuleSet } from "@/lib/budget-engine";
import { clearLoanPayment, recordLoanPayment } from "@/lib/loan-payments";

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
 *
 * A RULE IS A SET OF STEPS. Every row in `budget_rules` sharing a
 * (match_type, match_value) is one step of one rule, and each step does its own
 * thing to the transactions the match finds. "Amount 453.91 pays the car loan"
 * and "amount 453.91 lands in Car Payment" are two steps of one rule, and both
 * run - the loan write mints a payment and moves a debt balance while the bucket
 * write sets a category, neither of which gets in the other's way.
 */

export type StoredRule = {
  id: number;
  matchType: "merchant" | "category" | "amount";
  matchValue: string;
  budgetId: number | null;
  loanId: number | null;
  /** Step says "ignore these" rather than routing them somewhere. */
  exclude?: boolean;
};

export type RuleTargetKind = "bucket" | "loan" | "ignore";

export type ApplyResult = {
  /** Transactions whose target actually changed. */
  moved: number;
  /** Transactions the rule matched, including ones already pointing there. */
  matched: number;
  target: RuleTargetKind;
};

export type RevertResult = {
  target: RuleTargetKind;
  /**
   * Transactions this step had changed that are no longer claimed by anything,
   * and have been put back.
   */
  reverted: number;
  /**
   * Left alone because something else still wants them there: another step of
   * this rule, another rule entirely, or the routing engine's own reason for
   * excluding a card payment.
   */
  kept: number;
};

/**
 * One step, target flattened out of the nullable id columns.
 *
 * The row shape is awkward to work with - a bucket step has `loan_id` null and
 * an ignore step has both null plus a boolean - so steps are passed around as
 * this instead, which cannot describe a half-filled target at all.
 */
export type RuleAction = {
  target: RuleTargetKind;
  budgetId: number | null;
  loanId: number | null;
};

/** Identity of a step: what it targets, ignoring the match it belongs to. */
export function actionKey(action: RuleAction): string {
  if (action.target === "bucket") return `bucket:${action.budgetId}`;
  if (action.target === "loan") return `loan:${action.loanId}`;
  return "ignore";
}

/** Read the single step a stored row describes. */
export function actionOf(rule: StoredRule): RuleAction {
  if (rule.exclude) return { target: "ignore", budgetId: null, loanId: null };
  if (rule.loanId !== null) {
    return { target: "loan", budgetId: null, loanId: rule.loanId };
  }
  return { target: "bucket", budgetId: rule.budgetId, loanId: null };
}

/**
 * A rule as the user thinks of it: one match, any number of steps.
 *
 * `id` is the lowest row id under the match. It is a handle, not a pointer to
 * one step - deleting or re-applying by it means "the whole rule".
 */
export type RuleGroup = {
  id: number;
  matchType: StoredRule["matchType"];
  matchValue: string;
  steps: RuleAction[];
};

/**
 * Collapse one-row-per-step rows into one entry per rule.
 *
 * Preserves the order rows arrive in, which is the table's priority order, so a
 * rule's steps list in the order they were first added and rules stay in the
 * order they should be evaluated.
 */
export function groupRuleRows(rows: StoredRule[]): RuleGroup[] {
  const groups: RuleGroup[] = [];
  const byMatch = new Map<string, RuleGroup>();

  for (const row of rows) {
    const key = `${row.matchType}:${row.matchValue}`;
    const existing = byMatch.get(key);
    if (existing) {
      existing.steps.push(actionOf(row));
      if (row.id < existing.id) existing.id = row.id;
      continue;
    }
    const group: RuleGroup = {
      id: row.id,
      matchType: row.matchType,
      matchValue: row.matchValue,
      steps: [actionOf(row)],
    };
    byMatch.set(key, group);
    groups.push(group);
  }

  return groups;
}

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
      accountId: true,
      budgetId: true,
      excluded: true,
    },
  });
}

type RawCandidate = Awaited<ReturnType<typeof ruleCandidateRows>>[number];

/** A candidate row with `amount` already a number, which is what matching wants. */
type CandidateRow = Omit<RawCandidate, "amount"> & { amount: number };

/**
 * One read of the transactions a rule could touch, shared by every step.
 *
 * Loading per step would mean re-querying per step and, worse, each step would
 * see a slightly different snapshot as earlier steps write.
 */
async function loadCandidates(userId: string): Promise<CandidateRow[]> {
  const rows = await ruleCandidateRows(userId);
  return rows.map((row) => ({ ...row, amount: toNumber(row.amount) }));
}

/**
 * The transactions a rule could touch, for the rules page to show.
 *
 * Exported rather than reimplemented because the rules page has to agree with the
 * engine exactly. If it queried its own rows with its own filter and reported a
 * different count, the page would be worse than useless - it would be confidently
 * wrong about what a rule does.
 *
 * Exported as a type too: `ClientRuleCandidate` is what reaches the client, and it
 * is this exact shape, so the page cannot drift from the source.
 */
export type ClientRuleCandidate = Omit<CandidateRow, "accountId">;

export async function getRuleCandidates(
  userId: string,
): Promise<ClientRuleCandidate[]> {
  const rows = await loadCandidates(userId);
  return rows.map((row) => {
    /*
     * accountId is dropped on purpose: the rules page has no use for it, and
     * sending it would put every transaction's account in the page payload for
     * nothing.
     */
    const copy = { ...row };
    delete (copy as Partial<CandidateRow>).accountId;
    return copy;
  });
}

/** Account type per accountId, needed to tell a card payment from real spending. */
async function loadAccountTypes(
  userId: string,
): Promise<Map<string, string>> {
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  if (items.length === 0) return new Map();

  const accounts = await db.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((item) => item.id),
    ),
    columns: { id: true, type: true },
  });
  return new Map(accounts.map((account) => [String(account.id), account.type]));
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
  /*
   * Narrower than StoredRule on purpose: matching reads two fields, and the rules
   * page needs to ask the question without holding a stored row. Demanding the full
   * type here would mean every caller had to fabricate ids and targets.
   */
  rule: Pick<StoredRule, "matchType" | "matchValue">,
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
 * Apply one bucket step to every matching transaction, including ones already
 * in another bucket.
 */
async function applyBucketStep(
  rule: StoredRule,
  rows: CandidateRow[],
): Promise<ApplyResult> {
  if (rule.budgetId === null) {
    return { moved: 0, matched: 0, target: "bucket" };
  }

  const budgetId = rule.budgetId;
  const movedIds: number[] = [];
  let matched = 0;

  for (const row of rows) {
    if (!matchesStoredRule(row, rule)) continue;
    matched += 1;
    if (row.budgetId === budgetId) continue;
    movedIds.push(row.id);
  }

  // One statement rather than N round trips; the list can be long.
  await applyAssignments(movedIds, budgetId);

  return { moved: movedIds.length, matched, target: "bucket" };
}

/** Set `budget_id` on a batch of transactions. No-op on an empty list. */
async function applyAssignments(
  ids: number[],
  budgetId: number | null,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(tables.transactions)
    .set({ budgetId, updatedAt: new Date() })
    .where(inArray(tables.transactions.id, ids));
}

/**
 * Apply one loan step to every matching transaction, creating a payment for
 * each.
 *
 * Processed in date order for the reason given on ruleCandidateRows: each
 * inserted payment advances the loan's accrual cursor, so out-of-order inserts
 * would charge a year of interest against the wrong payment.
 */
async function applyLoanStep(
  userId: string,
  rule: StoredRule,
  rows: CandidateRow[],
): Promise<ApplyResult> {
  if (rule.loanId === null) {
    return { moved: 0, matched: 0, target: "loan" };
  }

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
    if (!matchesStoredRule(row, rule)) continue;

    /*
     * Counted as matched BEFORE the two exclusions below, matching the bucket
     * and ignore paths.
     *
     * It used to be counted after, which meant a second run over a rule that had
     * already recorded its payments reported "matched 0" - indistinguishable
     * from a rule that matches nothing. `matched` answers "how many does this
     * rule describe"; `moved` answers "how many just changed".
     */
    matched += 1;

    // A loan payment is money out. Plaid signs are positive for outflow, so an
    // inflow matching the rule is left alone rather than silently flipped.
    if (row.amount <= 0) continue;

    // Already recorded: loan_payments.transaction_id is unique, so re-inserting
    // would fail. Counted as matched, not moved.
    if (already.has(row.id)) continue;

    try {
      await recordLoanPayment({
        loanId: rule.loanId,
        userId,
        transactionId: row.id,
        paidOn: row.date,
        amount: row.amount,
        // Marks the row as a write this app made on a rule's behalf, so
        // removing the step later can undo exactly this and nothing else.
        source: "rule",
      });
      moved += 1;
    } catch (error) {
      // One bad row must not abandon the rest of the backfill.
      console.error("[rules] could not record a loan payment:", error);
    }
  }

  return { moved, matched, target: "loan" };
}

/**
 * Apply one "ignore these" step to every matching transaction.
 *
 * The row keeps its bucket and is only flagged, so it stays visible in place -
 * greyed out and excluded from the total - rather than disappearing. That is why
 * this is separate from the bucket step: exclusion has to be able to reach rows
 * that already have a bucket, which the routing path never revisits.
 */
async function applyIgnoreStep(
  rule: StoredRule,
  rows: CandidateRow[],
): Promise<ApplyResult> {
  const movedIds: number[] = [];
  let matched = 0;

  for (const row of rows) {
    if (!matchesStoredRule(row, rule)) continue;
    matched += 1;
    // Only the flag changes: the row stays in whatever bucket it was in so the
    // user can still see it there, greyed out. Actuals skip excluded rows.
    if (row.excluded) continue;
    movedIds.push(row.id);
  }

  await applyExclusions(movedIds);

  return { moved: movedIds.length, matched, target: "ignore" };
}

/** Flag transactions as excluded from income and spending. No-op when empty. */
async function applyExclusions(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(tables.transactions)
    .set({ excluded: true, updatedAt: new Date() })
    .where(inArray(tables.transactions.id, ids));
}

/**
 * Run every step of one rule, in step order.
 *
 * Returns one result per step rather than a single number, because a rule with
 * a loan step and a bucket step moved two different things and reporting one
 * total would hide that. The two also overlap legitimately: the same
 * transaction can be a loan payment and sit in a spending bucket at once.
 */
export async function applyRulesToHistory(
  userId: string,
  rules: StoredRule[],
): Promise<ApplyResult[]> {
  if (rules.length === 0) return [];

  const rows = await loadCandidates(userId);
  const results: ApplyResult[] = [];

  for (const rule of rules) {
    if (rule.exclude) {
      results.push(await applyIgnoreStep(rule, rows));
      continue;
    }
    if (rule.loanId !== null) {
      results.push(await applyLoanStep(userId, rule, rows));
      continue;
    }

    /*
     * A bucket step with no bucket id is not a step that matched nothing - it is
     * a step that was never fully specified, and the two look identical if the
     * target is inferred. Reporting 0/0 here is what made an ignore step that
     * forgot its flag look like "no matching transactions" instead of a bug.
     *
     * The DB CHECK guarantees exactly one target, so reaching this is a caller
     * error, and it should say so rather than quietly return a plausible number.
     */
    if (rule.budgetId === null) {
      throw new Error(
        `Rule ${rule.id} has no target. Exactly one of budgetId, loanId or exclude must be set.`,
      );
    }

    results.push(await applyBucketStep(rule, rows));
  }

  return results;
}

/**
 * Undo the steps a user just removed from a rule.
 *
 * Removing a step has to mean more than "stop doing this going forward". A step
 * that said "everything at 453.91 pays the car loan" already wrote loan payment
 * rows, and those rows are what moved the debt balance. If the step vanishes and
 * the payments stayed, the rule would be lying about what it does.
 *
 * The catch is that a write is rarely the step's alone. Two steps can reach the
 * same transaction, and a payment can be tagged by hand on the transactions
 * page, and `excluded` is also set by the routing engine for card payments. So
 * every write is checked against everything that still wants it, and anything
 * still claimed is left alone and counted in `kept`.
 *
 * Must run AFTER the rule has been saved, so "still claimed" reads the rules as
 * they now stand, and BEFORE the remaining steps are re-applied, so their writes
 * win.
 */
export async function revertRuleSteps(
  userId: string,
  match: { matchType: StoredRule["matchType"]; matchValue: string },
  removed: RuleAction[],
): Promise<RevertResult[]> {
  if (removed.length === 0) return [];

  const [rows, remaining] = await Promise.all([
    loadCandidates(userId),
    // Everything that still exists, not just this rule: another rule matching
    // the same transaction to the same loan keeps it a payment.
    db.query.budgetRules.findMany({
      where: and(
        eq(tables.budgetRules.userId, userId),
        eq(tables.budgetRules.active, true),
      ),
    }),
  ]);

  const matcher: StoredRule = {
    id: 0,
    matchType: match.matchType,
    matchValue: match.matchValue,
    budgetId: null,
    loanId: null,
  };

  const accountTypes =
    removed.some((action) => action.target === "ignore")
      ? await loadAccountTypes(userId)
      : new Map<string, string>();

  const matching = rows.filter((row) => matchesStoredRule(row, matcher));

  /**
   * Surviving steps pointed at the same target, which is the only ones that can
   * keep a write alive. Narrowed per step rather than rescanning every rule for
   * every transaction.
   */
  const claimants = (pick: (rule: StoredRule) => number | null) =>
    remaining.filter((rule) => pick(rule) !== null);

  const results: RevertResult[] = [];

  for (const action of removed) {
    if (action.target === "bucket" && action.budgetId !== null) {
      const bucketId = action.budgetId;
      const others = claimants((rule) =>
        rule.budgetId === bucketId ? rule.budgetId : null,
      );

      const ids: number[] = [];
      let kept = 0;
      for (const row of matching) {
        if (row.budgetId !== bucketId) continue;
        if (others.some((rule) => matchesStoredRule(row, rule))) {
          kept += 1;
          continue;
        }
        ids.push(row.id);
      }
      /*
       * Cleared rather than repointed: what the user removed was the claim that
       * these belong in this bucket, so the honest end state is "undecided".
       * applyBudgetRules only ever fills null assignments, so the next routing
       * pass re-decides from whatever else matches - and if nothing does, the
       * row visibly falls to the catch-all instead of quietly staying put.
       */
      await applyAssignments(ids, null);
      results.push({ target: "bucket", reverted: ids.length, kept });
      continue;
    }

    if (action.target === "ignore") {
      const ids: number[] = [];
      let kept = 0;
      for (const row of matching) {
        if (!row.excluded) continue;
        /*
         * `excluded` is not this rule's alone. The routing engine sets it for
         * anything that moves a credit or loan balance, which is neither income
         * nor spending for reasons that have nothing to do with any rule. Those
         * stay excluded; the engine will not revisit them, because it only
         * excludes rows that have no bucket.
         */
        if (
          isBalanceMovement({
            amount: row.amount,
            accountType: accountTypes.get(String(row.accountId)) ?? "other",
          })
        ) {
          kept += 1;
          continue;
        }
        ids.push(row.id);
      }
      if (ids.length > 0) {
        await db
          .update(tables.transactions)
          .set({ excluded: false, updatedAt: new Date() })
          .where(inArray(tables.transactions.id, ids));
      }
      results.push({ target: "ignore", reverted: ids.length, kept });
      continue;
    }

    if (action.target === "loan" && action.loanId !== null) {
      const loanId = action.loanId;
      const others = claimants((rule) =>
        rule.loanId === loanId ? rule.loanId : null,
      );

      /*
       * Only outgoing rows could ever have been a payment - the same guard the
       * apply path applies - so an inflow matching the rule is not a candidate
       * for being un-tagged.
       */
      const candidates = new Map(
        matching.filter((row) => row.amount > 0).map((row) => [row.id, row]),
      );
      if (candidates.size === 0) {
        results.push({ target: "loan", reverted: 0, kept: 0 });
        continue;
      }

      const payments = await db
        .select({
          transactionId: tables.loanPayments.transactionId,
          source: tables.loanPayments.source,
        })
        .from(tables.loanPayments)
        .where(
          and(
            eq(tables.loanPayments.loanId, loanId),
            inArray(tables.loanPayments.transactionId, [...candidates.keys()]),
          ),
        );

      let reverted = 0;
      let kept = 0;
      for (const payment of payments) {
        const row = candidates.get(payment.transactionId);
        if (!row) continue;
        // Tagged by hand on the transactions page: the user's decision, not this
        // rule's write.
        if (payment.source === "manual") {
          kept += 1;
          continue;
        }
        if (others.some((rule) => matchesStoredRule(row, rule))) {
          kept += 1;
          continue;
        }
        // The loan_payments trigger puts back both the principal and the
        // accrual cursor, so the balance reflects the tag never existing.
        await clearLoanPayment({ transactionId: payment.transactionId });
        reverted += 1;
      }
      results.push({ target: "loan", reverted, kept });
      continue;
    }

    // An action the API should have rejected already; nothing sensible to undo.
    results.push({ target: action.target, reverted: 0, kept: 0 });
  }

  return results;
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

  const rows = await loadCandidates(userId);
  if (rows.length === 0) return { scanned: 0, tagged: 0 };

  const alreadyTagged = await db.select({
    transactionId: tables.loanPayments.transactionId,
  }).from(tables.loanPayments);
  const tagged = new Set(alreadyTagged.map((entry) => entry.transactionId));

  let scanned = 0;
  let count = 0;

  for (const row of rows) {
    const loanId = resolveLoan(row, ruleSet);
    if (loanId === null) continue;
    scanned += 1;
    if (tagged.has(row.id)) continue;

    const amount = row.amount;
    if (amount <= 0) continue;

    try {
      await recordLoanPayment({
        loanId,
        userId,
        transactionId: row.id,
        paidOn: row.date,
        amount,
        source: "rule",
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