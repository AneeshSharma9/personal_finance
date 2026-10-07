import "server-only";

import { and, count, eq, inArray } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * What deleting an Item would destroy, for the confirmation dialog.
 *
 * Unlinking is irreversible, and Plaid makes it doubly so: `/item/remove`
 * revokes the Item at Plaid but does NOT return the slot to the Trial plan's
 * 10-Item allowance (docs/architecture.md section 2). The UI has to say that
 * before the user clicks, not after.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const { id: rawId } = await ctx.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Invalid Item id." }, { status: 400 });
  }

  const item = await db.query.items.findFirst({
    where: and(eq(tables.items.id, id), eq(tables.items.userId, auth.userId)),
  });
  if (!item) {
    return Response.json({ error: "Item not found." }, { status: 404 });
  }

  const accounts = await db.query.accounts.findMany({
    where: eq(tables.accounts.itemId, id),
    columns: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const [transactionRow] = accountIds.length
    ? await db
        .select({ n: count() })
        .from(tables.transactions)
        .where(inArray(tables.transactions.accountId, accountIds))
    : [{ n: 0 }];

  return Response.json({
    institutionName: item.institutionName,
    environment: item.environment,
    status: item.status,
    accounts: accountIds.length,
    transactions: transactionRow?.n ?? 0,
  });
}

/**
 * Unlink an institution.
 *
 * Two steps, in this order:
 *   1. `/item/remove` at Plaid, to actually revoke the grant. Skipping this
 *      would leave a live credential sitting at Plaid that only our database
 *      forgot about.
 *   2. Delete the row. `items -> accounts -> transactions` all cascade, so this
 *      one delete clears the institution, its accounts, and every transaction.
 *
 * Budgets and budget rows are deliberately untouched: `transactions.budget_id`
 * is ON DELETE SET NULL, so buckets survive and simply start reporting 0.
 *
 * If the Plaid call fails the local rows are still removed, because leaving
 * orphaned data the user asked to delete is worse than a stale Item at Plaid
 * that has already been reported in the response.
 */
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const { id: rawId } = await ctx.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Invalid Item id." }, { status: 400 });
  }

  const item = await db.query.items.findFirst({
    where: and(eq(tables.items.id, id), eq(tables.items.userId, auth.userId)),
  });
  // 404, not 403: do not confirm that someone else's Item id exists.
  if (!item) {
    return Response.json({ error: "Item not found." }, { status: 404 });
  }

  const accounts = await db.query.accounts.findMany({
    where: eq(tables.accounts.itemId, id),
    columns: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const [transactionRow] = accountIds.length
    ? await db
        .select({ n: count() })
        .from(tables.transactions)
        .where(inArray(tables.transactions.accountId, accountIds))
    : [{ n: 0 }];

  // Revoke at Plaid first. Any failure here is logged, not fatal.
  let plaidRemoved = true;
  try {
    const { getPlaidClient } = await import("@/lib/plaid/client");
    const { decryptToken } = await import("@/lib/crypto");
    await getPlaidClient().itemRemove({
      access_token: decryptToken(item.accessTokenEncrypted),
    });
  } catch (error) {
    plaidRemoved = false;
    console.error(
      `[unlink] Plaid /item/remove failed for ${item.plaidItemId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  const [deleted] = await db
    .delete(tables.items)
    .where(
      and(eq(tables.items.id, id), eq(tables.items.userId, auth.userId)),
    )
    .returning({ id: tables.items.id });

  if (!deleted) {
    return Response.json({ error: "Item not found." }, { status: 404 });
  }

  return Response.json({
    deleted: {
      items: 1,
      // Both cascade; report what went with it so the UI can tell the user.
      accounts: accountIds.length,
      transactions: transactionRow?.n ?? 0,
    },
    plaidRemoved,
    warning: plaidRemoved
      ? "Removed. Note that unlinking does NOT free a Plaid Trial-plan Item slot."
      : "Removed locally, but Plaid could not revoke the grant. Remove it in the " +
        "Plaid Dashboard to revoke access.",
  });
}