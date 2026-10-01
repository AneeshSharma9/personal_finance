import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * Edit a transaction: re-categorize, add notes.
 *
 * The transaction is looked up through its account's Item, so a user can never
 * touch another user's row even with a guessed id.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  // Route params are a Promise in Next.js 16.
  const { id: rawId } = await ctx.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Invalid transaction id." }, { status: 400 });
  }

  let body: { categoryOverride?: unknown; notes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  let patch: Partial<{
    categoryOverride: string | null;
    notes: string | null;
    budgetId: number | null;
    updatedAt: Date;
  }>;

  let categoryChanged = false;

  try {
    patch = { updatedAt: new Date() };

    if ("categoryOverride" in body) {
      patch.categoryOverride = normalizeCategory(body.categoryOverride);
      categoryChanged = true;
    }
    if ("notes" in body) {
      patch.notes = normalizeNotes(body.notes);
    }
    if ("budgetId" in body) {
      patch.budgetId = await normalizeBudgetId(body.budgetId, auth.userId);
    }

    /*
     * A category change must also release the budget bucket.
     *
     * The rule engine only fills in NULL assignments, so a re-categorised
     * transaction would otherwise stay in a bucket that no longer matches its
     * category, and the budgets page would contradict the transactions page.
     * Clearing it lets the next apply re-route the transaction.
     *
     * An explicit `budgetId` in the same request wins, so a caller that wants to
     * set both is not overridden.
     */
    if (categoryChanged && !("budgetId" in body)) {
      patch.budgetId = null;
    }
  } catch (error) {
    if (error instanceof InvalidField) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (Object.keys(patch).length === 1) {
    return Response.json(
      {
        error:
          "Nothing to update. Send categoryOverride, notes, or budgetId.",
      },
      { status: 400 },
    );
  }

  const updated = await db.transaction(async (tx) => {
    const owned = await ownedTransactionIds(tx, auth.userId);
    if (!owned.includes(id)) return null;

    const [row] = await tx
      .update(tables.transactions)
      .set(patch)
      .where(eq(tables.transactions.id, id))
      .returning({
        id: tables.transactions.id,
        categoryOverride: tables.transactions.categoryOverride,
        notes: tables.transactions.notes,
        budgetId: tables.transactions.budgetId,
      });
    return row ?? null;
  });

  if (!updated) {
    // 404 rather than 403: do not confirm the row exists for someone else.
    return Response.json({ error: "Transaction not found." }, { status: 404 });
  }

  return Response.json({ transaction: updated });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function ownedTransactionIds(tx: Tx, userId: string): Promise<number[]> {
  const items = await tx.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  if (items.length === 0) return [];

  const accounts = await tx.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((i) => i.id),
    ),
    columns: { id: true },
  });
  if (accounts.length === 0) return [];

  const transactions = await tx.query.transactions.findMany({
    where: inArray(
      tables.transactions.accountId,
      accounts.map((a) => a.id),
    ),
    columns: { id: true },
  });
  return transactions.map((t) => t.id);
}

/** Empty string clears the override, which restores Plaid's own category. */
function normalizeCategory(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidField("categoryOverride must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 100) {
    throw new InvalidField("categoryOverride must be 100 characters or fewer.");
  }
  return trimmed;
}

function normalizeNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidField("notes must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) {
    throw new InvalidField("notes must be 2000 characters or fewer.");
  }
  return trimmed;
}

class InvalidField extends Error {}

/**
 * Validate a target budget bucket.
 *
 * Null clears the assignment. A non-null id is checked against the user's own
 * buckets, so a guessed id can't file a transaction into someone else's budget
 * and a deleted bucket is reported rather than silently 500ing on the FK.
 */
async function normalizeBudgetId(
  value: unknown,
  userId: string,
): Promise<number | null> {
  if (value === null || value === "") return null;

  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InvalidField("budgetId must be a positive integer or null.");
  }

  const bucket = await db.query.budgets.findFirst({
    where: and(
      eq(tables.budgets.id, id),
      eq(tables.budgets.userId, userId),
    ),
    columns: { id: true },
  });
  if (!bucket) {
    throw new InvalidField("That budget bucket does not exist.");
  }

  return id;
}