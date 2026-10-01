import "server-only";

import { eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";
import {
  getOwnedItem,
  refreshAllForItem,
  refreshAllItemsForUser,
} from "@/lib/plaid/sync-items";

/**
 * Manual sync, for the "Refresh" button.
 *
 * Body: `{ itemId?: number }` to sync one Item, or omit to sync all of them.
 *
 * Plaid does not rate-limit these calls on connected Items (only the Item count
 * is capped on the Trial plan), so a manual refresh of all Items is cheap.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let itemId: number | undefined;
  try {
    const body = (await request.json()) as { itemId?: unknown };
    if (body.itemId !== undefined) {
      if (typeof body.itemId !== "number" || !Number.isInteger(body.itemId)) {
        return Response.json(
          { error: "itemId must be an integer." },
          { status: 400 },
        );
      }
      itemId = body.itemId;
    }
  } catch {
    // Empty body means "sync everything".
  }

  try {
    if (itemId !== undefined) {
      const item = await getOwnedItem(itemId, auth.userId);
      if (!item) {
        // Deliberately 404, not 403: do not confirm that someone else's Item id
        // exists.
        return Response.json(
          { error: "Item not found." },
          { status: 404 },
        );
      }

      const result = await refreshAllForItem(item);
      return Response.json({ results: [summarize(result)] });
    }

    const results = await refreshAllItemsForUser(auth.userId);
    return Response.json({
      results: results.map(summarize),
      itemCount: results.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Sync failed.";
    console.error("[sync] failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** GET reports per-Item sync state so the dashboard can show staleness. */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, auth.userId),
    orderBy: (i, { asc }) => [asc(i.createdAt)],
  });

  return Response.json({
    items: items.map((item) => ({
      id: item.id,
      institutionName: item.institutionName,
      status: item.status,
      errorCode: item.errorCode,
      errorMessage: item.errorMessage,
      lastSyncedAt: item.lastSyncedAt,
      hasCursor: item.cursor !== null,
      environment: item.environment,
    })),
  });
}

function summarize(result: {
  itemId: number;
  ok: boolean;
  added: number;
  modified: number;
  removed: number;
  accountsUpdated: number;
  liabilities: number;
  investments: { holdings: number; transactions: number };
  warnings: string[];
  error?: string;
}) {
  return {
    itemId: result.itemId,
    ok: result.ok,
    added: result.added,
    modified: result.modified,
    removed: result.removed,
    accountsUpdated: result.accountsUpdated,
    liabilities: result.liabilities,
    holdings: result.investments.holdings,
    investmentTransactions: result.investments.transactions,
    warnings: result.warnings,
    error: result.error,
  };
}