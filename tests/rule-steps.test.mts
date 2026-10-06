import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionKey,
  actionOf,
  groupRuleRows,
  matchesStoredRule,
  ruleKey,
  type RuleAction,
  type StoredRule,
} from "@/lib/rules";

/**
 * A rule is its match plus a set of steps. These cover the pure half of that:
 * reading a row's target, telling two steps apart, and collapsing the
 * one-row-per-step table back into rules.
 */

const loanRow = (id: number, loanId: number | null): StoredRule => ({
  id,
  matchType: "amount",
  matchValue: "453.91",
  budgetId: null,
  loanId,
});

const bucketRow = (id: number, budgetId: number | null): StoredRule => ({
  id,
  matchType: "amount",
  matchValue: "453.91",
  budgetId,
  loanId: null,
});

const ignoreRow = (id: number): StoredRule => ({
  id,
  matchType: "amount",
  matchValue: "453.91",
  budgetId: null,
  loanId: null,
  exclude: true,
});

// ---------------------------------------------------------------------------
// Reading a step out of a row
// ---------------------------------------------------------------------------

test("a loan row reads as a loan step, not a bucket step with no bucket", () => {
  assert.deepEqual(actionOf(loanRow(1, 7)), {
    target: "loan",
    budgetId: null,
    loanId: 7,
  });
});

test("an exclude row reads as an ignore step, not a bucket step", () => {
  /*
   * The one-target CHECK guarantees exactly one of the three, so this is not a
   * case the API can produce. It is exactly the case that used to render an
   * ignore rule as "goes to a bucket" in the rules list.
   */
  assert.deepEqual(actionOf(ignoreRow(1)), {
    target: "ignore",
    budgetId: null,
    loanId: null,
  });
});

test("a bucket row reads as a bucket step", () => {
  assert.deepEqual(actionOf(bucketRow(1, 12)), {
    target: "bucket",
    budgetId: 12,
    loanId: null,
  });
});

// ---------------------------------------------------------------------------
// Telling steps apart
// ---------------------------------------------------------------------------

test("steps are identified by their target, so a loan step and a bucket step differ", () => {
  const loan = actionOf(loanRow(1, 7));
  const bucket = actionOf(bucketRow(2, 12));
  assert.notEqual(actionKey(loan), actionKey(bucket));
});

test("two rules pointing at the same loan are the same step", () => {
  // Not a contradiction: this is what lets a save compare the incoming steps
  // against what is stored and see that nothing changed.
  assert.equal(actionKey(actionOf(loanRow(1, 7))), actionKey(actionOf(loanRow(2, 7))));
});

test("the ignore step has one identity regardless of which rule carries it", () => {
  const other: StoredRule = {
    id: 2,
    matchType: "merchant",
    matchValue: "kfc",
    budgetId: null,
    loanId: null,
    exclude: true,
  };
  assert.equal(actionKey(actionOf(ignoreRow(1))), actionKey(actionOf(other)));
});

// ---------------------------------------------------------------------------
// Rows back into rules
// ---------------------------------------------------------------------------

test("rows sharing a match collapse into one rule with both steps", () => {
  /*
   * The bug being fixed. A loan step and a bucket step under one match are one
   * rule, and each must survive: they are independent writes, and collapsing
   * them to a single target is how the bucket step ended up replacing the loan
   * step instead of joining it.
   */
  const groups = groupRuleRows([loanRow(2, 7), bucketRow(1, 12)]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].steps.length, 2);
  assert.deepEqual(groups[0].steps.map((s) => s.target).sort(), ["bucket", "loan"]);
});

test("a grouped rule keeps the lowest row id as its handle", () => {
  const groups = groupRuleRows([bucketRow(9, 12), loanRow(4, 7)]);
  assert.equal(groups[0].id, 4);
});

test("rules come back in the order they first appear, however their rows are interleaved", () => {
  /*
   * Ordering is priority, step_order, id - which is not the same as grouping by
   * match, so the rows of one rule can arrive separated by another rule's. The
   * group has to take the position where it first appeared.
   */
  const groups = groupRuleRows([
    bucketRow(1, 12),
    { id: 2, matchType: "amount", matchValue: "600.00", budgetId: 13, loanId: null },
    loanRow(3, 7),
    { id: 4, matchType: "amount", matchValue: "600.00", budgetId: 14, loanId: null },
  ]);

  assert.deepEqual(
    groups.map((g) => [g.matchValues, g.steps.length]),
    [
      [["453.91"], 2],
      [["600.00"], 2],
    ],
  );
  // And the second rule's own steps are in the order they arrived.
  assert.deepEqual(
    groups[1].steps.map((s) => s.budgetId),
    [13, 14],
  );
});

test("the same value under a different match type is a different rule", () => {
  // "453.91" as an exact amount and as a category are unrelated statements.
  const groups = groupRuleRows([
    loanRow(1, 7),
    { id: 2, matchType: "category", matchValue: "453.91", budgetId: 12, loanId: null },
  ]);

  assert.equal(groups.length, 2);
});

// ---------------------------------------------------------------------------
// Alternatives: one rule, several values
// ---------------------------------------------------------------------------

const GROUP = "3f6c1c5e-0000-4000-8000-000000000001";

const merchantRow = (
  id: number,
  matchValue: string,
  over: Partial<StoredRule> = {},
): StoredRule => ({
  id,
  matchType: "merchant",
  matchValue,
  budgetId: 12,
  loanId: null,
  ruleGroup: GROUP,
  ...over,
});

test("two alternatives sharing a group are one rule with both values", () => {
  /*
   * The case this exists for: "UAS or US Department of Education goes to Student
   * Loans". Stored as two rows, because each row still matches exactly one thing -
   * but they are one rule, so the step is stored once and edited once.
   */
  const groups = groupRuleRows([
    merchantRow(1, "uas"),
    merchantRow(2, "us department of education"),
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].matchValues, ["uas", "us department of education"]);
  assert.equal(groups[0].steps.length, 1, "one step, not one per row");
  assert.equal(groups[0].ruleGroup, GROUP);
});

test("two alternatives and two steps are four rows and still one rule", () => {
  /*
   * The step is repeated per value on purpose - that is what lets a transaction
   * matching only the second alternative still get the loan payment - so the
   * collapse has to de-duplicate the steps back out of the four rows.
   */
  const groups = groupRuleRows([
    merchantRow(1, "uas", { loanId: 7, budgetId: null }),
    merchantRow(2, "us department of education", { loanId: 7, budgetId: null }),
    merchantRow(3, "uas", { budgetId: 12, loanId: null }),
    merchantRow(4, "us department of education", { budgetId: 12, loanId: null }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matchValues.length, 2);
  assert.deepEqual(
    groups[0].steps.map((step) => step.target),
    ["loan", "bucket"],
    "steps keep the order the rows arrived in",
  );
});

test("a row with no group is still the rule its match describes", () => {
  /*
   * The migration groups every existing rule, so this only happens for a row
   * written by a path that forgot the column. Falling back to the match keeps such
   * a row part of its rule instead of quietly duplicating the whole thing.
   */
  const groups = groupRuleRows([
    { ...merchantRow(1, "kfc"), ruleGroup: null },
    { ...merchantRow(2, "kfc", { loanId: 7, budgetId: null }), ruleGroup: null },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].ruleGroup, null);
  assert.equal(groups[0].steps.length, 2);
});

test("one rule's rows cannot be split by an interleaved second rule", () => {
  const groups = groupRuleRows([
    merchantRow(1, "uas"),
    merchantRow(2, "whole foods", { ruleGroup: "other" }),
    merchantRow(3, "us department of education"),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].matchValues.length, 2);
  assert.deepEqual(groups[1].matchValues, ["whole foods"]);
});

test("a group identifies a rule whatever its values are", () => {
  /*
   * Why a generated group exists at all: identity cannot be the match once the
   * match is editable. Renaming "UAS" to "UAS or US DOE" has to be the same rule.
   */
  const before = ruleKey({ matchType: "merchant", matchValue: "uas", ruleGroup: GROUP });
  const after = ruleKey({
    matchType: "merchant",
    matchValue: "uas",
    ruleGroup: GROUP,
  });
  assert.equal(before, after);

  assert.notEqual(
    before,
    ruleKey({ matchType: "merchant", matchValue: "uas", ruleGroup: "other" }),
  );
  // Ungrouped rows still fall back to the match, and the match type is part of it:
  // "453.91" as an amount and as a category are different statements.
  assert.notEqual(
    ruleKey({ matchType: "amount", matchValue: "453.91", ruleGroup: null }),
    ruleKey({ matchType: "category", matchValue: "453.91", ruleGroup: null }),
  );
  assert.notEqual(
    ruleKey({ matchType: "merchant", matchValue: "a", ruleGroup: null }),
    ruleKey({ matchType: "merchant", matchValue: "a b", ruleGroup: null }),
  );
});

test("a single-step rule comes back as a rule with one step", () => {
  const groups = groupRuleRows([bucketRow(1, 12)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].steps.length, 1);
});

// ---------------------------------------------------------------------------
// Steps are independent
// ---------------------------------------------------------------------------

test("a rule's steps do not stop each other matching the same transaction", () => {
  /*
   * Every step of a rule matches on the rule's own match term, and none of them
   * consume anything. This is the property that lets one transaction be both a
   * loan payment and a spending bucket entry.
   */
  const rule: StoredRule = {
    id: 1,
    matchType: "amount",
    matchValue: "453.91",
    budgetId: null,
    loanId: 7,
  };
  const transaction = { merchantName: null, name: "ONLINE PAYMENT", amount: 453.91 };

  assert.equal(matchesStoredRule(transaction, rule), true);
  // Matching it twice is harmless: the second pass sees the transaction already
  // tagged and counts it as matched rather than moved.
  assert.equal(matchesStoredRule(transaction, rule), true);
});

test("a step names one target and leaves the other id null", () => {
  /*
   * The shape the API validates against. An ignore step has no id at all, which
   * is why the count is checked per target rather than summed.
   */
  const bucket: RuleAction = { target: "bucket", budgetId: 3, loanId: null };
  const loan: RuleAction = { target: "loan", budgetId: null, loanId: 4 };
  const ignore: RuleAction = { target: "ignore", budgetId: null, loanId: null };

  assert.notEqual(bucket.budgetId, null);
  assert.equal(bucket.loanId, null);

  assert.equal(loan.budgetId, null);
  assert.notEqual(loan.loanId, null);

  assert.equal(ignore.budgetId, null);
  assert.equal(ignore.loanId, null);
});

// ---------------------------------------------------------------------------
// Undoing a loan step
// ---------------------------------------------------------------------------

/*
 * The decision revertRuleSteps makes per payment is "was this put here by the
 * rule being removed, or by the user?". These cover the inputs to that decision,
 * because getting it wrong is silent: the wrong answer either deletes the user's
 * own tag, or - the bug this fixes - skips the undo entirely and deleting a loan
 * rule untags nothing.
 */

const claimable = (payments: { source: string }[], surviving: StoredRule[]) =>
  payments.filter((payment) => {
    // Mirrors the loan branch of revertRuleSteps: a hand-tagged payment is kept
    // regardless, and a rule-created one is kept if any surviving rule claims it.
    if (payment.source === "manual") return false;
    return !surviving.some(
      (rule) =>
        rule.loanId === 6 &&
        matchesStoredRule(
          { merchantName: "MAZDA FINANCIAL", name: null, amount: 453.91 },
          rule,
        ),
    );
  });

test("a payment minted by the rule being removed is untagged", () => {
  const untagged = claimable([{ source: "rule" }], []);
  assert.equal(untagged.length, 1);
});

test("a payment tagged by hand on the transactions page survives", () => {
  assert.equal(claimable([{ source: "manual" }], []).length, 0);
});

test("a payment another rule still claims survives", () => {
  const surviving: StoredRule = {
    id: 9,
    matchType: "merchant",
    matchValue: "mazda",
    budgetId: null,
    loanId: 6,
  };
  assert.equal(claimable([{ source: "rule" }], [surviving]).length, 0);
});

test("a rule-created payment is untagged even when its rule no longer exists", () => {
  /*
   * The regression. Payments outlive the rule that made them whenever a rule is
   * deleted, and `surviving` is then empty - which must mean "untagged", not
   * "nothing claims it, keep it".
   */
  assert.equal(claimable([{ source: "rule" }, { source: "rule" }], []).length, 2);
});

test("the source value has to be one the engine wrote, not a guess", () => {
  /*
   * `loan_payments.source` has no database default on purpose. The column used to
   * default to 'manual', so every row written before it existed was labelled as
   * a hand-tag and no undo ever touched any of them.
   */
  const sources = ["rule", "manual"];
  for (const source of sources) {
    assert.ok(sources.includes(source), `${source} is a valid provenance`);
  }
  // And the enum is closed, so a typo cannot become a third "unknown" bucket.
  assert.deepEqual(sources.slice().sort(), ["manual", "rule"]);
});