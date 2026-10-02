import "server-only";

import { requireUserId } from "@/lib/auth";
import { getOwnedItem, refreshAllForItem } from "@/lib/plaid/sync-items";

/**
 * Re-pull one Item after a Link **update mode** run.
 *
 * Update mode returns no public_token - the existing access_token is reused -
 * so there is nothing to exchange. All the user did was grant Plaid access to
 * another account at the institution, and that shows up in `/accounts/get`.
 * Without this call the new card exists at Plaid but never reaches the database.
 *
 * Also the landing point for a webhook-driven refresh, so the "new account
 * appeared" case works without the user clicking anything.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let itemId: unknown;
  try {
    const body = (await request.json()) as { itemId?: unknown };
    itemId = body.itemId;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "A numeric itemId is required." }, { status: 400 });
  }

  const item = await getOwnedItem(id, auth.userId);
  if (!item) {
    // 404 rather than 403: do not confirm that someone else's Item exists.
    return Response.json({ error: "Item not found." }, { status: 404 });
  }

  try {
    const result = await refreshAllForItem(item);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ refreshed: true });
  } catch (error) {
    console.error(
      "[plaid-refresh] failed:",
      error instanceof Error ? error.message : error,
    );
    return Response.json({ error: "Could not refresh that institution." }, { status: 500 });
  }
}