import { requireUserId } from "@/lib/auth";
import { createLinkToken } from "@/lib/plaid/link";

/**
 * Create a Plaid Link token.
 *
 * Body (all optional):
 *   { itemId?: number }  when present, produces an UPDATE-mode token for that
 *                        Item so re-auth doesn't consume a Trial-plan slot.
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
    // An empty body is valid and means "create a new Item".
  }

  try {
    // No redirect_uri is passed here. Plaid rejects the entire request unless
    // the value is registered in the dashboard, so PLAID_REDIRECT_URI is the only
    // source and it is omitted entirely when unset. That keeps non-OAuth
    // institutions working with no dashboard configuration at all.
    const result = await createLinkToken({
      userId: auth.userId,
      updateItemId: itemId,
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create link token.";
    // 400 for Plaid-side config rejections, 500 for our own bugs.
    const status = /INVALID_|INVALID_FIELD|MISSING|does not belong/.test(message)
      ? 400
      : 500;
    return Response.json({ error: message }, { status });
  }
}