import "server-only";

import { eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";
import { ensureUserRow } from "@/lib/users";
import { plaidEnv } from "@/lib/env";
import { exchangePublicToken } from "@/lib/plaid/link";
import { syncItem, refreshAllForItem } from "@/lib/plaid/sync-items";

/**
 * Exchange a Link `public_token` for a durable access token and store the Item.
 *
 * This is the step that consumes a Plaid Item slot (docs/architecture.md 5.1),
 * so it must be robust: a dropped response after exchange would leave the Item
 * created in Plaid but missing here, and the user would have no way to recover
 * the token. We therefore persist the token before doing anything else and make
 * re-submitting the same public_token idempotent (it returns the same Item).
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let publicToken: string;
  let institution: { name: string | null; institution_id: string | null } | undefined;

  try {
    const body = (await request.json()) as {
      public_token?: unknown;
      institution?: unknown;
    };

    if (typeof body.public_token !== "string" || !body.public_token) {
      return Response.json(
        { error: "public_token is required." },
        { status: 400 },
      );
    }
    publicToken = body.public_token;

    const inst = body.institution as
      | { name?: unknown; institution_id?: unknown }
      | undefined;
    if (inst && typeof inst === "object") {
      institution = {
        name: typeof inst.name === "string" ? inst.name : null,
        institution_id:
          typeof inst.institution_id === "string"
            ? inst.institution_id
            : null,
      };
    }
  } catch {
    return Response.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  // The `items` table has a foreign key to `users.id`, so the row must exist
  // before the Item is inserted. Supabase Auth knows about the user but nothing
  // else does, so create it here - the first moment we persist user-owned data.
  const userId = await ensureUserRow(auth.userId, auth.email);
  if (!userId) {
    return Response.json(
      { error: `Could not resolve a user record for ${auth.email}.` },
      { status: 500 },
    );
  }

  try {
    const { itemId, plaidItemId } = await exchangePublicToken({
      userId,
      publicToken,
      institution,
      environment: plaidEnv(),
    });

    // Kick off the first sync so the dashboard has data to show immediately.
    // Failures are reported, not fatal: the Item is already stored safely and
    // the user can retry from the UI.
    const item = await db.query.items.findFirst({
      where: eq(tables.items.id, itemId),
    });

    let sync: { ok: boolean; error?: string; added: number } | null = null;
    if (item) {
      const result = await refreshAllForItem(item);
      sync = {
        ok: result.ok,
        added: result.added,
        error: result.error,
      };
    }

    return Response.json(
      {
        itemId,
        plaidItemId,
        institutionName: institution?.name ?? null,
        sync,
      },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to exchange token.";
    console.error("[plaid-exchange] failed:", message);
    return Response.json({ error: message }, { status: 502 });
  }
}

export { syncItem };