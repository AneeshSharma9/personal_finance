import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * Budget routing rules.
 *
 * A budget row's `category` is already an implicit category rule. These rows are
 * for what category alone can't express - "every Starbucks is Dining" - and for
 * overriding a category default.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const [rules, budgets] = await Promise.all([
    db.query.budgetRules.findMany({
      where: eq(tables.budgetRules.userId, auth.userId),
      orderBy: [
        asc(tables.budgetRules.priority),
        asc(tables.budgetRules.id),
      ],
    }),
    db.query.budgets.findMany({
      where: eq(tables.budgets.userId, auth.userId),
      columns: { id: true, name: true, budgetKind: true },
    }),
  ]);

  const budgetNameById = new Map(budgets.map((b) => [b.id, b.name]));

  return Response.json({
    rules: rules.map((rule) => ({
      id: rule.id,
      budgetId: rule.budgetId,
      budgetName: budgetNameById.get(rule.budgetId) ?? "Unknown bucket",
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      priority: rule.priority,
      active: rule.active,
    })),
  });
}

/**
 * Create or update a rule.
 *
 * Upserts on (userId, matchType, matchValue), so re-saving a rule changes where it
 * points rather than stacking a duplicate that could shadow it.
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

  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const matchType = raw.matchType;
  if (matchType !== "merchant" && matchType !== "category") {
    return Response.json(
      { error: 'matchType must be "merchant" or "category".' },
      { status: 400 },
    );
  }

  if (typeof raw.matchValue !== "string" || raw.matchValue.trim().length === 0) {
    return Response.json(
      { error: "matchValue is required." },
      { status: 400 },
    );
  }
  const matchValue = raw.matchValue.trim();
  if (matchValue.length > 200) {
    return Response.json(
      { error: "matchValue must be 200 characters or fewer." },
      { status: 400 },
    );
  }

  // Confirm the bucket exists and is the caller's, so a guessed id can't route
  // transactions into somebody else's bucket.
  const budgetId = Number(raw.budgetId);
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return Response.json({ error: "budgetId is required." }, { status: 400 });
  }

  const budget = await db.query.budgets.findFirst({
    where: and(
      eq(tables.budgets.id, budgetId),
      eq(tables.budgets.userId, auth.userId),
    ),
    columns: { id: true },
  });
  if (!budget) {
    return Response.json({ error: "Bucket not found." }, { status: 404 });
  }

  const priority = Number.isFinite(Number(raw.priority))
    ? Math.trunc(Number(raw.priority))
    : 0;
  const active = raw.active === undefined ? true : Boolean(raw.active);

  // Merchant matching is a substring search, so store it as typed; category
  // matching is case-insensitive so normalise to upper.
  const stored =
    matchType === "merchant" ? matchValue : matchValue.toUpperCase();

  const [rule] = await db
    .insert(tables.budgetRules)
    .values({
      userId: auth.userId,
      budgetId,
      matchType,
      matchValue: stored,
      priority,
      active,
    })
    .onConflictDoUpdate({
      target: [
        tables.budgetRules.userId,
        tables.budgetRules.matchType,
        tables.budgetRules.matchValue,
      ],
      set: { budgetId, priority, active, updatedAt: new Date() },
    })
    .returning({
      id: tables.budgetRules.id,
      budgetId: tables.budgetRules.budgetId,
      matchType: tables.budgetRules.matchType,
      matchValue: tables.budgetRules.matchValue,
      priority: tables.budgetRules.priority,
      active: tables.budgetRules.active,
    });

  return Response.json({ rule });
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