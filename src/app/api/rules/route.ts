import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";
import { applyRuleToHistory, type StoredRule } from "@/lib/rules";

/**
 * Rules for buckets and loans.
 *
 * Replaces /api/budgets/rules, which could only target a bucket. A rule is
 * upserted on (user_id, match_type, match_value), so re-saving changes where it
 * points rather than stacking a duplicate.
 *
 * Saving a rule also applies it to transactions that already exist and returns
 * how many moved. That is deliberate: a rule that only affects future syncs is
 * indistinguishable from a broken one, because the transactions a user wants to
 * catch are usually last month's.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const [rules, buckets, loans] = await Promise.all([
    db.query.budgetRules.findMany({
      where: eq(tables.budgetRules.userId, auth.userId),
      orderBy: [asc(tables.budgetRules.priority), asc(tables.budgetRules.id)],
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

  return Response.json({
    rules: rules.map((rule) => ({
      id: rule.id,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      budgetId: rule.budgetId,
      budgetName:
        rule.budgetId === null
          ? null
          : (bucketNameById.get(rule.budgetId) ?? "Deleted bucket"),
      loanId: rule.loanId,
      loanName:
        rule.loanId === null
          ? null
          : (loanNameById.get(rule.loanId) ?? "Deleted loan"),
      exclude: rule.exclude,
      target: rule.exclude ? "ignore" : rule.loanId === null ? "bucket" : "loan",
      priority: rule.priority,
      active: rule.active,
    })),
    buckets: buckets.map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.budgetKind,
    })),
    loans: loans.map((l) => ({ id: l.id, name: l.name })),
  });
}

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

  if (typeof raw.matchValue !== "string" || raw.matchValue.trim().length === 0) {
    return Response.json({ error: "matchValue is required." }, { status: 400 });
  }
  let matchValue = raw.matchValue.trim();
  if (matchValue.length > 200) {
    return Response.json(
      { error: "matchValue must be 200 characters or fewer." },
      { status: 400 },
    );
  }

  // An amount rule has to be a number. Normalising here means "600" and "600.00"
  // collide on the unique index instead of existing as two rules.
  if (matchType === "amount") {
    const parsed = Number(matchValue.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Response.json(
        { error: "An amount rule needs a positive number, like 600." },
        { status: 400 },
      );
    }
    matchValue = parsed.toFixed(2);
  } else if (matchType === "category") {
    matchValue = matchValue.toUpperCase();
  } else {
    matchValue = matchValue.toLowerCase();
  }

  /*
   * A rule targets exactly one of a bucket or a loan. `target` says which, rather
   * than inferring from whichever id happens to be present, so a half-filled form
   * cannot silently create a bucket rule.
   */
  const target =
    raw.target === "loan" ? "loan" : raw.target === "ignore" ? "ignore" : "bucket";
  let budgetId: number | null = null;
  let loanId: number | null = null;

  if (target === "ignore") {
    // Nothing to validate: the rule marks matching transactions as excluded, so
    // they count as neither income nor spending.
    budgetId = null;
    loanId = null;
  } else if (target === "bucket") {
    const value = Number(raw.budgetId);
    if (!Number.isInteger(value) || value <= 0) {
      return Response.json(
        { error: "Choose a bucket for this rule." },
        { status: 400 },
      );
    }
    const bucket = await db.query.budgets.findFirst({
      where: and(
        eq(tables.budgets.id, value),
        eq(tables.budgets.userId, auth.userId),
      ),
      columns: { id: true },
    });
    if (!bucket) {
      return Response.json({ error: "Bucket not found." }, { status: 404 });
    }
    budgetId = value;
  } else {
    const value = Number(raw.loanId);
    if (!Number.isInteger(value) || value <= 0) {
      return Response.json(
        { error: "Choose a loan for this rule." },
        { status: 400 },
      );
    }
    const loan = await db.query.loans.findFirst({
      where: and(
        eq(tables.loans.id, value),
        eq(tables.loans.userId, auth.userId),
      ),
      columns: { id: true },
    });
    if (!loan) {
      return Response.json({ error: "Loan not found." }, { status: 404 });
    }
    loanId = value;
  }

  const priority =
    raw.priority === undefined || raw.priority === null
      ? 0
      : Math.trunc(Number(raw.priority) || 0);

  const stored = {
    userId: auth.userId,
    budgetId,
    loanId,
    exclude: target === "ignore",
    matchType,
    matchValue,
    priority,
    active: raw.active === undefined ? true : Boolean(raw.active),
  };

  const [rule] = await db
    .insert(tables.budgetRules)
    .values(stored)
    .onConflictDoUpdate({
      target: [
        tables.budgetRules.userId,
        tables.budgetRules.matchType,
        tables.budgetRules.matchValue,
      ],
      set: {
        budgetId,
        loanId,
        exclude: stored.exclude,
        priority,
        active: stored.active,
      },
    })
    .returning({ id: tables.budgetRules.id });

  /*
   * Backfill history. Only worth doing for bucket rules and loan rules alike -
   * the whole point of the page is that a rule is not a promise about the future
   * only. Reported back so the client can say how many moved.
   */
  const applied = await applyRuleToHistory(auth.userId, {
    id: rule.id,
    matchType: stored.matchType,
    matchValue: stored.matchValue,
    budgetId,
    loanId,
    // Without this the target is inferred as "bucket" and an ignore rule
    // short-circuits to matched: 0 without ever looking at a transaction.
    exclude: stored.exclude,
  } satisfies StoredRule);

  return Response.json({ rule: { id: rule.id }, applied });
}

/**
 * Re-apply one existing rule to every transaction that matches it.
 *
 * Saving a rule already does this, so this is the "I suspect something changed"
 * path: transactions synced in after the rule was written, a rule whose target
 * was edited, or a bulk edit like excluding a run of rows by hand.
 *
 * Reads the stored row rather than accepting the rule body, so a rerun can only
 * ever do what the saved rule says.
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

  const rule = await db.query.budgetRules.findFirst({
    where: and(
      eq(tables.budgetRules.id, ruleId),
      eq(tables.budgetRules.userId, auth.userId),
    ),
  });
  if (!rule) {
    // 404 rather than 403: do not confirm that someone else's rule exists.
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  try {
    const applied = await applyRuleToHistory(auth.userId, {
      id: rule.id,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      budgetId: rule.budgetId,
      loanId: rule.loanId,
      exclude: rule.exclude,
    } satisfies StoredRule);

    return Response.json({ rule: { id: rule.id }, applied });
  } catch (error) {
    // applyRuleToHistory throws when the stored rule has no usable target,
    // which would otherwise surface as a bare 500.
    console.error(
      `[rules] rerun of ${rule.id} failed:`,
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

  const deleted = await db
    .delete(tables.budgetRules)
    .where(
      and(
        eq(tables.budgetRules.id, id),
        eq(tables.budgetRules.userId, auth.userId),
      ),
    )
    .returning({ id: tables.budgetRules.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Rule not found." }, { status: 404 });
  }

  return Response.json({ deleted: deleted.length });
}