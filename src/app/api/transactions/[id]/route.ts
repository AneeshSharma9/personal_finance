import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { requireUserId } from "@/lib/auth";
import {
  clearLoanPayment,
  LoanError,
  recordLoanPayment,
} from "@/lib/loan-payments";

/**
 * Edit a transaction: re-categorize, add notes, or tag it as a loan payment.
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

  let body: {
    categoryOverride?: unknown;
    notes?: unknown;
    budgetId?: unknown;
    loanId?: unknown;
    excluded?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  let patch: Partial<{
    categoryOverride: string | null;
    notes: string | null;
    budgetId: number | null;
    excluded: boolean;
    updatedAt: Date;
  }>;

  let categoryChanged = false;
  /** Set when a loan tag was applied, so the client can show the split. */
  let loanResult: unknown = null;

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
    if ("excluded" in body) {
      patch.excluded = normalizeExcluded(body.excluded);
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

  if (
    Object.keys(patch).length === 1 &&
    !("loanId" in body) &&
    !("excluded" in body)
  ) {
    return Response.json(
      {
        error:
          "Nothing to update. Send categoryOverride, notes, budgetId, loanId, or excluded.",
      },
      { status: 400 },
    );
  }

  /*
   * Loan tagging is handled separately from the column patch: it inserts a
   * loan_payments row and the database trigger moves the balance, so there is no
   * column on `transactions` to write. Ownership is re-checked here because the
   * existing check below runs inside the update's transaction.
   */
  if ("loanId" in body) {
    const existing = await findOwnedTransaction(auth.userId, id);
    if (!existing) {
      // 404 rather than 403: do not confirm the row exists for someone else.
      return Response.json(
        { error: "Transaction not found." },
        { status: 404 },
      );
    }

    try {
      if (body.loanId === null || body.loanId === "") {
        // Un-tagging. The trigger adds the principal back, so the balance
        // returns to what it was before the tag.
        loanResult = await clearLoanPayment({ transactionId: id });
      } else {
        const loanId = Number(body.loanId);
        if (!Number.isInteger(loanId) || loanId <= 0) {
          return Response.json(
            { error: "loanId must be a positive integer or null." },
            { status: 400 },
          );
        }

        // Plaid signs: positive means money left the account. A loan payment is
        // money out, so an inflow is a mistake worth reporting rather than
        // silently flipping into a payment.
        const amount = toNumber(existing.amount);
        if (amount <= 0) {
          return Response.json(
            {
              error:
                "That transaction is money coming in, not a payment. Tag an outgoing transaction instead.",
            },
            { status: 400 },
          );
        }

        loanResult = await recordLoanPayment({
          loanId,
          userId: auth.userId,
          transactionId: id,
          paidOn: existing.date,
          amount,
        });
      }
    } catch (error) {
      if (error instanceof LoanError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      // UNIQUE violation: this transaction already pays a loan.
      if (error instanceof Error && error.message.includes("loan_payments")) {
        return Response.json(
          {
            error:
              "That transaction is already tagged as a loan payment. Un-tag it first.",
          },
          { status: 400 },
        );
      }
      throw error;
    }
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
        excluded: tables.transactions.excluded,
      });
    return row ?? null;
  });

  if (!updated) {
    // 404 rather than 403: do not confirm the row exists for someone else.
    return Response.json({ error: "Transaction not found." }, { status: 404 });
  }

  return Response.json({ transaction: updated, loan: loanResult });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pool handle or an open transaction; both expose `.query`. */
type Queryable = Tx | typeof db;

async function ownedAccountIds(
  dbx: Queryable,
  userId: string,
): Promise<number[]> {
  const items = await dbx.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  if (items.length === 0) return [];

  const accounts = await dbx.query.accounts.findMany({
    where: inArray(
      tables.accounts.itemId,
      items.map((i) => i.id),
    ),
    columns: { id: true },
  });
  return accounts.map((a) => a.id);
}

async function ownedTransactionIds(tx: Tx, userId: string): Promise<number[]> {
  const accountIds = await ownedAccountIds(tx, userId);
  if (accountIds.length === 0) return [];

  const transactions = await tx.query.transactions.findMany({
    where: inArray(
      tables.transactions.accountId,
      accountIds,
    ),
    columns: { id: true },
  });
  return transactions.map((t) => t.id);
}

/**
 * Fetch one transaction only if it belongs to the user.
 *
 * Needed before tagging a loan payment, because the loan write happens outside
 * the update transaction below. Verifying ownership inside that transaction and
 * then writing the payment separately would leave a window where a user could
 * attach somebody else's transaction to their own loan.
 */
async function findOwnedTransaction(
  userId: string,
  id: number,
): Promise<{ id: number; amount: string; date: string } | null> {
  const accountIds = await ownedAccountIds(db, userId);
  if (accountIds.length === 0) return null;

  const row = await db.query.transactions.findFirst({
    where: and(
      eq(tables.transactions.id, id),
      inArray(tables.transactions.accountId, accountIds),
    ),
    // Relational queries take a boolean selection mask; `.returning()` elsewhere
    // in this file takes column references instead.
    columns: { id: true, amount: true, date: true },
  });
  return row ?? null;
}

/** Ignoring is a boolean; anything else is rejected rather than coerced. */
function normalizeExcluded(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new InvalidField("excluded must be true or false.");
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