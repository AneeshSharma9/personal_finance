import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";
import {
  actionKey,
  actionOf,
  applyRulesToHistory,
  groupRuleRows,
  revertRuleSteps,
  type ApplyResult,
  type RevertResult,
  type RuleAction,
  type StoredRule,
} from "@/lib/rules";

/**
 * Rules for buckets and loans.
 *
 * Replaces /api/budgets/rules, which could only target a bucket.
 *
 * A RULE IS ITS GROUP, NOT A ROW ID. Every row sharing a `rule_group` is one step
 * of that rule, repeated once per match value the rule names, and saving replaces
 * the whole set: rows still wanted are updated in place, rows no longer wanted are
 * deleted and their writes undone, and rows newly wanted are inserted and applied.
 *
 * This is the fix for the one-target rule. The old table was unique on
 * (user_id, match_type, match_value) and the save was an upsert on that key, so
 * adding a second target to "amount 453.91" silently overwrote the first instead
 * of joining it - which is exactly what happened to the Mazda 3 loan rule when a
 * bucket step was added to it.
 *
 * Saving a rule also applies it to transactions that already exist and returns
 * how many each step moved. That is deliberate: a rule that only affects future
 * syncs is indistinguishable from a broken one, because the transactions a user
 * wants to catch are usually last month's.
 */

/** A form will not build more than this, and it bounds one save's writes. */
const MAX_STEPS = 10;

/**
 * Alternatives per rule. Low, because every value is repeated once per step: this
 * is really a bound on how many rows one save can write.
 */
const MAX_MATCH_VALUES = 10;

type StepCheck =
  | { ok: true; action: RuleAction }
  | { ok: false; error: string; status: number };

/**
 * Bucket any transaction a rule just touched but left unbucketed.
 *
 * Loan and bucket targets are independent: a loan step writes a `loan_payments`
 * row and does not set `budget_id`, so a transaction can be a loan payment *and*
 * sit in a spending bucket at the same time. That is what makes "attach to the
 * loan, then budget it" work as one rule rather than two rules fighting over
 * the same transaction.
 *
 * Without this, a rule whose only step is a loan step leaves the rows unbucketed
 * until the next Plaid sync. Non-fatal, because the loan tag itself has already
 * committed and is the more important half.
 */
async function reconcileBuckets(userId: string): Promise<number> {
  try {
    const { applyBudgetRules } = await import("@/lib/budget-engine");
    const routed = await applyBudgetRules(userId);
    return routed.assigned;
  } catch (error) {
    console.error(
      "[rules] bucket routing after a rule failed:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

/**
 * Every row belonging to one rule, in the order its steps should be shown.
 *
 * Takes either the rule's group or the match it used to be identified by, because
 * a rule saved before the column existed has no group - and `null` group is a real
 * answer here, not a missing one, so the two cannot be collapsed into one lookup.
 */
async function rowsForRule(
  userId: string,
  rule: { ruleGroup: string | null; matchType: StoredRule["matchType"]; matchValue: string },
) {
  return db.query.budgetRules.findMany({
    where: and(
      eq(tables.budgetRules.userId, userId),
      rule.ruleGroup === null
        ? and(
            isNull(tables.budgetRules.ruleGroup),
            eq(tables.budgetRules.matchType, rule.matchType),
            eq(tables.budgetRules.matchValue, rule.matchValue),
          )
        : eq(tables.budgetRules.ruleGroup, rule.ruleGroup),
    ),
    orderBy: [
      asc(tables.budgetRules.priority),
      asc(tables.budgetRules.stepOrder),
      asc(tables.budgetRules.id),
    ],
  });
}

/**
 * One match value, normalised the same way whichever way it arrived.
 *
 * An amount rule has to be a number. Normalising here means "600" and "600.00" name
 * one alternative rather than two that never both fire - and, since the value is
 * the row's identity, it is what lets a re-save diff against what is stored instead
 * of inserting a duplicate.
 */
function normaliseMatchValue(
  matchType: StoredRule["matchType"],
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "A match value cannot be blank." };
  }
  if (trimmed.length > 200) {
    return { ok: false, error: "A match value must be 200 characters or fewer." };
  }

  if (matchType === "amount") {
    const parsed = Number(trimmed.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        ok: false,
        error: "An amount rule needs a positive number, like 600.",
      };
    }
    return { ok: true, value: parsed.toFixed(2) };
  }
  return {
    ok: true,
    value: matchType === "category" ? trimmed.toUpperCase() : trimmed.toLowerCase(),
  };
}

/**
 * The alternatives a rule matches on, OR'd together.
 *
 * Accepts either `matchValues` (a list) or the single `matchValue` it replaced, so
 * a caller that only ever sends one value keeps working - which is most of them,
 * and every saved rule from before this existed.
 *
 * De-duplicated *after* normalising, because "KFC" and "kfc" are one alternative
 * and two rows claiming it would report every match twice.
 */
function parseMatchValues(
  matchType: StoredRule["matchType"],
  raw: Record<string, unknown>,
): { values: string[] } | { error: string } {
  const supplied = Array.isArray(raw.matchValues)
    ? raw.matchValues
    : typeof raw.matchValue === "string"
      ? [raw.matchValue]
      : null;

  if (supplied === null) {
    return { error: "matchValues is required." };
  }
  if (supplied.length === 0) {
    return { error: "A rule needs at least one value to match on." };
  }
  if (supplied.length > MAX_MATCH_VALUES) {
    return {
      error: `A rule can match on at most ${MAX_MATCH_VALUES} values.`,
    };
  }

  const values: string[] = [];
  for (const entry of supplied) {
    if (typeof entry !== "string") {
      return { error: "matchValues must be an array of strings." };
    }
    const normalised = normaliseMatchValue(matchType, entry);
    if (!normalised.ok) return { error: normalised.error };
    if (!values.includes(normalised.value)) values.push(normalised.value);
  }

  return { values };
}

function toStored(row: {
  id: number;
  matchType: StoredRule["matchType"];
  matchValue: string;
  ruleGroup: string | null;
  budgetId: number | null;
  loanId: number | null;
  exclude: boolean;
}): StoredRule {
  return {
    id: row.id,
    matchType: row.matchType,
    matchValue: row.matchValue,
    ruleGroup: row.ruleGroup,
    budgetId: row.budgetId,
    loanId: row.loanId,
    exclude: row.exclude,
  };
}

/**
 * Validate one step and resolve its target to a row the user actually owns.
 *
 * Each step is checked on its own, and `target` is read explicitly rather than
 * inferred from whichever id happens to be present, so a half-filled form cannot
 * silently create a bucket step.
 */
async function validateStep(
  userId: string,
  raw: unknown,
  position: number,
): Promise<StepCheck> {
  const at = (error: string): StepCheck => ({
    ok: false,
    error: `Step ${position}: ${error}`,
    status: 400,
  });

  const input = (raw ?? {}) as Record<string, unknown>;
  const target =
    input.target === "loan"
      ? "loan"
      : input.target === "ignore"
        ? "ignore"
        : input.target === "bucket"
          ? "bucket"
          : null;

  if (target === null) {
    return at('must send to "bucket", "loan", or "ignore".');
  }

  if (target === "ignore") {
    // Nothing to resolve: the step marks matching transactions as excluded, so
    // they count as neither income nor spending.
    return { ok: true, action: { target, budgetId: null, loanId: null } };
  }

  if (target === "bucket") {
    const value = Number(input.budgetId);
    if (!Number.isInteger(value) || value <= 0) {
      return at("choose a bucket.");
    }
    const bucket = await db.query.budgets.findFirst({
      where: and(
        eq(tables.budgets.id, value),
        eq(tables.budgets.userId, userId),
      ),
      columns: { id: true },
    });
    if (!bucket) return { ok: false, error: `Step ${position}: bucket not found.`, status: 404 };
    return { ok: true, action: { target, budgetId: value, loanId: null } };
  }

  const value = Number(input.loanId);
  if (!Number.isInteger(value) || value <= 0) {
    return at("choose a loan.");
  }
  const loan = await db.query.loans.findFirst({
    where: and(eq(tables.loans.id, value), eq(tables.loans.userId, userId)),
    columns: { id: true },
  });
  if (!loan) return { ok: false, error: `Step ${position}: loan not found.`, status: 404 };
  return { ok: true, action: { target, budgetId: null, loanId: value } };
}

export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const [rows, buckets, loans] = await Promise.all([
    db.query.budgetRules.findMany({
      where: eq(tables.budgetRules.userId, auth.userId),
      orderBy: [
        asc(tables.budgetRules.priority),
        asc(tables.budgetRules.stepOrder),
        asc(tables.budgetRules.id),
      ],
    }),
    db.query.budgets.findMany({
      where: eq(tables.budgets.userId, auth.userId),
      orderBy: [asc(tables.budgets.budgetKind), asc(tables.budgets.name)],
    }),
    db.query.loans.findMany({
      where: eq(tables.loans.userId, auth.userId),
      orderBy: [asc(tables.loans.name)],
    }),
  ]);

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const loanNameById = new Map(loans.map((l) => [l.id, l.name]));

  const groups = groupRuleRows(rows.map(toStored));

  return Response.json({
    rules: groups.map((group) => ({
      id: group.id,
      ruleGroup: group.ruleGroup,
      matchType: group.matchType,
      matchValues: group.matchValues,
      steps: group.steps.map((step) => ({
        target: step.target,
        budgetId: step.budgetId,
        budgetName:
          step.budgetId === null
            ? null
            : (bucketNameById.get(step.budgetId) ?? "Deleted bucket"),
        loanId: step.loanId,
        loanName:
          step.loanId === null
            ? null
            : (loanNameById.get(step.loanId) ?? "Deleted loan"),
      })),
    })),
    buckets: buckets.map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.budgetKind,
    })),
    loans: loans.map((l) => ({ id: l.id, name: l.name })),
  });
}

/**
 * Create a rule, or replace the steps of the one with the same match.
 *
 * Not an upsert on a single row any more: the match is looked up, the steps that
 * survived are updated in place, the steps that vanished are deleted, and only
 * genuinely new steps are inserted.
 */
export async function PUT(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;

  if (
    raw.matchType !== "merchant" &&
    raw.matchType !== "category" &&
    raw.matchType !== "amount"
  ) {
    return Response.json(
      { error: 'matchType must be "merchant", "category", or "amount".' },
      { status: 400 },
    );
  }
  // The guard above validated this at runtime; comparing an `unknown` against
  // literals narrows to `string`, so the literal union is restated here.
  const matchType = raw.matchType as "merchant" | "category" | "amount";

  const matchValues = parseMatchValues(matchType, raw);
  if ("error" in matchValues) {
    return Response.json({ error: matchValues.error }, { status: 400 });
  }

  if (!Array.isArray(raw.steps)) {
    return Response.json(
      { error: "steps is required: an array of things to do with a match." },
      { status: 400 },
    );
  }
  if (raw.steps.length === 0) {
    return Response.json(
      { error: "A rule needs at least one step." },
      { status: 400 },
    );
  }
  if (raw.steps.length > MAX_STEPS) {
    return Response.json(
      { error: `A rule can have at most ${MAX_STEPS} steps.` },
      { status: 400 },
    );
  }

  const steps: RuleAction[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of raw.steps.entries()) {
    const check = await validateStep(auth.userId, candidate, index + 1);
    if (!check.ok) {
      return Response.json({ error: check.error }, { status: check.status });
    }
    // The same step twice would collide with itself in the one insert below,
    // and it says nothing the first copy did not.
    const key = actionKey(check.action);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(check.action);
  }

  if (steps.length === 0) {
    return Response.json(
      { error: "A rule needs at least one distinct step." },
      { status: 400 },
    );
  }

  const priority =
    raw.priority === undefined || raw.priority === null
      ? 0
      : Math.trunc(Number(raw.priority) || 0);

  /*
   * Which rule is being saved.
   *
   * `ruleGroup` is the answer for an edit - it is stable even as the match values
   * change, which is the whole reason it exists, since the old identity was the
   * match itself and "UAS" becoming "UAS or US Department of Education" would have
   * looked like a brand new rule. A new rule has no group, and is looked up by the
   * first value so that re-saving an existing one from a fresh form still replaces
   * it rather than duplicating it.
   */
  const ruleGroup =
    typeof raw.ruleGroup === "string" && raw.ruleGroup.length > 0
      ? raw.ruleGroup
      : null;

  const before = await rowsForRule(auth.userId, {
    ruleGroup,
    matchType,
    matchValue: matchValues.values[0],
  });

  /*
   * A group has to be one of this user's, or it does not exist.
   *
   * The form only ever sends back a group it was given, so this cannot happen
   * through the app - but a group is not a secret, and posting another rule's group
   * would fold this rule's rows into it, merging two unrelated rules into one list
   * with one set of steps. A group that matches nothing here is a 404, which is also
   * the truth: you cannot edit a rule that is not there.
   */
  if (ruleGroup !== null && before.length === 0) {
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  /*
   * One key per (value, step) pair, which is what a row is. Used to build the set
   * of rows the rule should end up with and to diff the stored rows against it -
   * dropping an alternative deletes rows exactly like dropping a step does, and it
   * has to undo the same writes.
   */
  const pairKey = (value: string, action: RuleAction) =>
    `${value} ${actionKey(action)}`;

  const wanted = new Map<string, { value: string; position: number }>();
  for (const value of matchValues.values) {
    for (const [position, step] of steps.entries()) {
      wanted.set(pairKey(value, step), { value, position });
    }
  }

  const keptByKey = new Map<string, (typeof before)[number]>();
  for (const row of before) {
    const key = pairKey(row.matchValue, actionOf(toStored(row)));
    // Only the first row for a pair is kept; a duplicate could only exist from a
    // partial save, and inserting a second would hit the unique index.
    if (!keptByKey.has(key)) keptByKey.set(key, row);
  }

  const stale = before.filter(
    (row) => !wanted.has(pairKey(row.matchValue, actionOf(toStored(row)))),
  );

  /**
   * The claims being withdrawn, one entry per step rather than per row.
   *
   * Three rows for one removed alternative are one claim each, and undoing it three
   * times would report the same transactions as nine.
   */
  const withdrawn = new Map<string, RuleAction>();
  for (const row of stale) {
    const action = actionOf(toStored(row));
    const key = actionKey(action);
    if (!withdrawn.has(key)) withdrawn.set(key, action);
  }

  /** Values whose rows are all being deleted, as opposed to ones that survive. */
  const droppedValues = [
    ...new Set(
      stale
        .map((row) => row.matchValue)
        .filter((value) => !matchValues.values.includes(value)),
    ),
  ];

  /*
   * The group is assigned by the first save that finds the rule ungrouped, and
   * reused afterwards. Generated here rather than asked for, because it is
   * identity, not something the user types - and a hand-written one is one typo away
   * from silently merging two rules that have nothing to do with each other.
   */
  const group = ruleGroup ?? before[0]?.ruleGroup ?? crypto.randomUUID();

  await db.transaction(async (tx) => {
    if (stale.length > 0) {
      await tx
        .delete(tables.budgetRules)
        .where(
          inArray(
            tables.budgetRules.id,
            stale.map((row) => row.id),
          ),
        );
    }

    for (const [key, { value, position }] of wanted) {
      const existing = keptByKey.get(key);

      if (existing) {
        /*
         * Two things can need writing: the step's position, and the group.
         *
         * The group matters more than it looks. A rule saved before the column
         * existed still has none, and identity falls back to its first value - so
         * renaming that value would make the next save look like a new rule and
         * leave the old one behind. Assigning the group on first contact is what
         * stops that, and it keeps every row under one identity.
         */
        const changed =
          existing.stepOrder !== position || existing.ruleGroup !== group;
        if (changed) {
          await tx
            .update(tables.budgetRules)
            .set({
              stepOrder: position,
              ruleGroup: group,
              updatedAt: new Date(),
            })
            .where(eq(tables.budgetRules.id, existing.id));
        }
        continue;
      }

      const step = steps[position]!;
      await tx.insert(tables.budgetRules).values({
        userId: auth.userId,
        matchType,
        matchValue: value,
        ruleGroup: group,
        budgetId: step.budgetId,
        loanId: step.loanId,
        exclude: step.target === "ignore",
        priority,
        stepOrder: position,
        active: true,
      });
    }
  });

  /*
   * Undo first, then apply what is left.
   *
   * The order matters twice over. revertRuleSteps reads the rules as they now
   * stand in order to tell a step's own writes from someone else's, which is why
   * the rows above are already deleted; and the surviving steps run last so that
   * where a removed step and a kept step touched the same field, the kept one is
   * what the transaction ends up with.
   *
   * The values handed over are the surviving ones *and* the ones just dropped:
   * both have writes to undo, and only the "someone else still claims this" check
   * keeps the survivors' transactions from being reverted along with the dropped
   * value's.
   */
  let reverted: RevertResult[] = [];
  try {
    reverted = await revertRuleSteps(
      auth.userId,
      {
        matchType,
        matchValues: [...matchValues.values, ...droppedValues],
      },
      [...withdrawn.values()],
    );
  } catch (error) {
    console.error(
      "[rules] could not undo the steps that were removed:",
      error instanceof Error ? error.message : error,
    );
  }

  let applied: ApplyResult[] = [];
  try {
    const saved = await rowsForRule(auth.userId, {
      ruleGroup: group,
      matchType,
      matchValue: matchValues.values[0],
    });
    applied = await applyRulesToHistory(auth.userId, saved.map(toStored));
  } catch (error) {
    console.error(
      "[rules] could not apply the saved rule:",
      error instanceof Error ? error.message : error,
    );
  }

  const bucketed = await reconcileBuckets(auth.userId);

  return Response.json({
    rule: { matchType, matchValues: matchValues.values, ruleGroup: group },
    applied,
    reverted,
    // Transactions a loan step left unbucketed that routing then placed, so the
    // UI can mention it alongside the steps that did the placing.
    bucketed,
  });
}

/**
 * Re-apply one existing rule to every transaction that matches it.
 *
 * Saving a rule already does this, so this is the "I suspect something changed"
 * path: transactions synced in after the rule was written, or a bulk edit like
 * excluding a run of rows by hand.
 *
 * Reads the stored rows rather than accepting the rule body, so a rerun can only
 * ever do what the saved rule says. Takes any one row's id and runs every step
 * of the rule that row belongs to.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let id: unknown;
  try {
    const body = (await request.json()) as { id?: unknown };
    id = body.id;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return Response.json({ error: "A numeric id is required." }, { status: 400 });
  }

  const anchor = await db.query.budgetRules.findFirst({
    where: and(
      eq(tables.budgetRules.id, ruleId),
      eq(tables.budgetRules.userId, auth.userId),
    ),
  });
  if (!anchor) {
    // 404 rather than 403: do not confirm that someone else's rule exists.
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  const rows = await rowsForRule(auth.userId, {
    ruleGroup: anchor.ruleGroup,
    matchType: anchor.matchType,
    matchValue: anchor.matchValue,
  });

  try {
    const applied = await applyRulesToHistory(
      auth.userId,
      rows.map(toStored),
    );

    const bucketed = await reconcileBuckets(auth.userId);

    return Response.json({
      rule: {
        id: rows[0]?.id ?? anchor.id,
        // Rows, not steps: a two-value rule applies each step twice, and reporting
        // "2 steps" for four writes would understate what just ran.
        rows: rows.length,
      },
      applied,
      bucketed,
    });
  } catch (error) {
    // applyRulesToHistory throws when a stored step has no usable target, which
    // would otherwise surface as a bare 500.
    console.error(
      `[rules] rerun of ${anchor.id} failed:`,
      error instanceof Error ? error.message : error,
    );
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not re-apply that rule.",
      },
      { status: 500 },
    );
  }
}

/**
 * Delete a rule: every step under its match, and everything those steps did.
 *
 * Undoing is the point. The loan step wrote payment rows and moved a debt
 * balance, so leaving them behind would leave the rule's history asserting
 * something that is no longer true.
 */
export async function DELETE(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const id = Number.parseInt(
    new URL(request.url).searchParams.get("id") ?? "",
    10,
  );
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "A numeric id is required." }, { status: 400 });
  }

  const anchor = await db.query.budgetRules.findFirst({
    where: and(
      eq(tables.budgetRules.id, id),
      eq(tables.budgetRules.userId, auth.userId),
    ),
  });
  if (!anchor) {
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  const rows = await rowsForRule(auth.userId, {
    ruleGroup: anchor.ruleGroup,
    matchType: anchor.matchType,
    matchValue: anchor.matchValue,
  });

  const deleted = await db
    .delete(tables.budgetRules)
    .where(
      inArray(
        tables.budgetRules.id,
        rows.map((row) => row.id),
      ),
    )
    .returning({ id: tables.budgetRules.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  // After the delete, so "is anything else still claiming this?" reads the rules
  // as they now stand rather than counting the step being removed.
  let reverted: RevertResult[] = [];
  try {
    // Every value the rule had, not just the row the delete was addressed by:
    // a two-value rule's writes were made under both, and undoing only one half
    // would leave the rule's own transactions claimed by nothing.
    reverted = await revertRuleSteps(
      auth.userId,
      {
        matchType: anchor.matchType,
        matchValues: [...new Set(rows.map((row) => row.matchValue))],
      },
      [
        ...new Map(
          rows.map((row) => [actionKey(actionOf(row)), actionOf(row)]),
        ).values(),
      ],
    );
  } catch (error) {
    console.error(
      "[rules] could not undo a deleted rule:",
      error instanceof Error ? error.message : error,
    );
  }

  // A bucket step the rule owned may have been its only reason to be in a
  // bucket, so put those rows back through the routing engine.
  const bucketed = await reconcileBuckets(auth.userId);

  return Response.json({ deleted: deleted.length, reverted, bucketed });
}