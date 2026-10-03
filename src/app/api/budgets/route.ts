import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { requireUserId } from "@/lib/auth";
import { parseMoney } from "@/lib/money";

/**
 * Budgets, grouped for the Rocket Money style layout.
 *
 * GET returns both groups plus earnings and the computed totals so the page
 * doesn't have to re-derive them.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const rows = await db.query.budgets.findMany({
    where: eq(tables.budgets.userId, auth.userId),
    orderBy: [
      asc(tables.budgets.budgetKind),
      asc(tables.budgets.sortOrder),
      asc(tables.budgets.name),
    ],
  });

  const groups: Record<tables.BudgetKind, BudgetRow[]> = {
    basic: [],
    category: [],
    earning: [],
  };

  for (const row of rows) {
    groups[row.budgetKind].push({
      id: row.id,
      kind: row.budgetKind,
      name: row.name,
      categories: row.categories,
      budgeted: toNumber(row.monthlyLimit),
      sortOrder: row.sortOrder,
    });
  }

  return Response.json({ groups, totals: computeTotals(groups) });
}

/**
 * Create or update one budget row.
 *
 * Idempotent on (user_id, kind, name): sending the same name twice updates the
 * existing row rather than erroring, which is what a form that autosaves wants.
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

  let input: BudgetInput;
  try {
    input = parseBudgetInput(body);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid input." },
      { status: 400 },
    );
  }

  const sortOrder =
    input.sortOrder ??
    (await nextSortOrder(auth.userId, input.kind));

  const [row] = await db
    .insert(tables.budgets)
    .values({
      userId: auth.userId,
      budgetKind: input.kind,
      name: input.name,
      categories: input.categories,
      monthlyLimit: input.budgeted.toFixed(2),
      sortOrder,
    })
    .onConflictDoUpdate({
      target: [
        tables.budgets.userId,
        tables.budgets.budgetKind,
        tables.budgets.name,
      ],
      set: {
        categories: input.categories,
        monthlyLimit: input.budgeted.toFixed(2),
        ...(input.sortOrder === undefined ? { sortOrder } : {}),
        updatedAt: new Date(),
      },
    })
    .returning({
      id: tables.budgets.id,
      kind: tables.budgets.budgetKind,
      name: tables.budgets.name,
      categories: tables.budgets.categories,
      budgeted: tables.budgets.monthlyLimit,
      sortOrder: tables.budgets.sortOrder,
    });

  return Response.json({
    budget: {
      ...row,
      budgeted: toNumber(row.budgeted),
    },
  });
}

/** Remove a budget row. Scoped to the user so ids can't be probed. */
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
    .delete(tables.budgets)
    .where(
      and(
        eq(tables.budgets.id, id),
        eq(tables.budgets.userId, auth.userId),
      ),
    )
    .returning({ id: tables.budgets.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Budget not found." }, { status: 404 });
  }

  return Response.json({ deleted: deleted.length });
}

export type BudgetRow = {
  id: number;
  kind: tables.BudgetKind;
  name: string;
  categories: string[];
  budgeted: number;
  sortOrder: number;
};

export type BudgetTotals = {
  basicsBudgeted: number;
  categoriesBudgeted: number;
  earningsBudgeted: number;
  /** The footer row: total budgeted across the flexible spending groups. */
  spendingBudgeted: number;
};

export function computeTotals(
  groups: Record<tables.BudgetKind, BudgetRow[]>,
): BudgetTotals {
  const sum = (rows: BudgetRow[]) =>
    rows.reduce((total, row) => total + row.budgeted, 0);

  return {
    basicsBudgeted: sum(groups.basic),
    categoriesBudgeted: sum(groups.category),
    earningsBudgeted: sum(groups.earning),
    // Rocket Money's "Spending Budget" covers both automatic and flexible
    // spending, so it's every outflow budget rather than just one group.
    spendingBudgeted: sum(groups.basic) + sum(groups.category),
  };
}

type BudgetInput = {
  kind: tables.BudgetKind;
  name: string;
  /** Plaid categories this bucket claims. Empty means display-only. */
  categories: string[];
  budgeted: number;
  sortOrder?: number;
};

function parseBudgetInput(body: unknown): BudgetInput {
  if (typeof body !== "object" || body === null) {
    throw new Error("Expected a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  const kind = raw.kind ?? raw.budgetKind;
  if (kind !== "basic" && kind !== "category" && kind !== "earning") {
    throw new Error('kind must be "basic", "category", or "earning".');
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error("name is required.");
  }
  const name = raw.name.trim();
  if (name.length > 80) {
    throw new Error("name must be 80 characters or fewer.");
  }

  // Accept "500", "$500", "500.25". Reject anything else rather than silently
  // storing 0 for a typo'd input.
  const budgeted = parseMoney(raw.budgeted ?? raw.monthlyLimit ?? 0);
  if (budgeted === null) {
    throw new Error("budgeted must be a non-negative number.");
  }
  if (budgeted > 1_000_000) {
    throw new Error("budgeted must be under 1,000,000.");
  }

  /*
   * A list, because a bucket is rarely one category - "Weekend" is dining *and*
   * entertainment, "Amazon" is general merchandise *and* online shopping. With one
   * slot per bucket the only options were a vague name or several buckets
   * competing for the same transactions, and two buckets sharing a category meant
   * only the first ever matched while the second read $0 forever, silently.
   *
   * Each value is uppercased and de-duplicated. Not validated against a fixed
   * list on purpose: Plaid's PFC taxonomy moved to v2 for Items created after
   * 2025-12-03, so a frozen enum would reject perfectly valid categories.
   * Matching is case-insensitive against the user's real data at read time.
   */
  let categories: string[] = [];
  if (raw.categories !== undefined && raw.categories !== null) {
    if (!Array.isArray(raw.categories)) {
      throw new Error("categories must be an array of strings.");
    }
    if (raw.categories.length > 50) {
      throw new Error("A bucket cannot match more than 50 categories.");
    }
    const seen = new Set<string>();
    for (const value of raw.categories) {
      if (typeof value !== "string") {
        throw new Error("categories must be an array of strings.");
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length > 100) {
        throw new Error("categories must be 100 characters or fewer.");
      }
      seen.add(trimmed.toUpperCase());
    }
    categories = [...seen];
  }

  let sortOrder: number | undefined;
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const parsed = Number(raw.sortOrder);
    if (!Number.isFinite(parsed)) {
      throw new Error("sortOrder must be a number.");
    }
    sortOrder = Math.trunc(parsed);
  }

  return { kind, name, categories, budgeted, sortOrder };
}

async function nextSortOrder(
  userId: string,
  kind: tables.BudgetKind,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${tables.budgets.sortOrder}), -1)` })
    .from(tables.budgets)
    .where(
      and(
        eq(tables.budgets.userId, userId),
        eq(tables.budgets.budgetKind, kind),
      ),
    );

  return (row?.max ?? -1) + 1;
}
