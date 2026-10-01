import "server-only";

import { and, count, eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * Remove a single account.
 *
 * Plaid has no "remove one account" endpoint - an Item is the smallest unit it
 * exposes - so this is a local removal. The account row and everything hanging
 * off it go; the rest of the institution stays linked.
 *
 * Use unlinking the institution instead when the whole login should go.
 */

/** Preview counts for the confirmation dialog. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const account = await ownedAccount(auth.userId, await idFrom(ctx));
  if (!account) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  const [transactionRow] = await db
    .select({ n: count() })
    .from(tables.transactions)
    .where(eq(tables.transactions.accountId, account.id));

  return Response.json({
    name: account.name,
    transactions: transactionRow?.n ?? 0,
  });
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const id = await idFrom(ctx);
  const account = await ownedAccount(auth.userId, id);
  if (!account) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  const [transactionRow] = await db
    .select({ n: count() })
    .from(tables.transactions)
    .where(eq(tables.transactions.accountId, account.id));

  const [deleted] = await db
    .delete(tables.accounts)
    .where(eq(tables.accounts.id, account.id))
    .returning({ id: tables.accounts.id });

  if (!deleted) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  return Response.json({
    deleted: { accounts: 1, transactions: transactionRow?.n ?? 0 },
  });
}

async function idFrom(ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = Number.parseInt(rawId, 10);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

/**
 * Resolve an account only if it belongs to this user.
 *
 * Walks account -> item -> user rather than trusting the id, so a guessed id
 * can't delete someone else's row. Returns null for an invalid id too, which the
 * caller turns into a 404.
 */
async function ownedAccount(userId: string, accountId: number) {
  if (accountId <= 0) return null;

  return db.query.accounts.findFirst({
    where: eq(tables.accounts.id, accountId),
    columns: { id: true, name: true, itemId: true },
  }).then(async (account) => {
    if (!account) return null;
    const owner = await db.query.items.findFirst({
      where: and(
        eq(tables.items.id, account.itemId),
        eq(tables.items.userId, userId),
      ),
      columns: { id: true },
    });
    return owner ? account : null;
  });
}