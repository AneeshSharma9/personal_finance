import "server-only";

import { requireUserId } from "@/lib/auth";
import { applyBudgetRules, countUnassigned } from "@/lib/budget-engine";

/**
 * Re-run budget routing over transactions that have no bucket.
 *
 * The engine also runs automatically after a transaction sync, so this is for
 * after changing rules - the new rules apply to everything currently unassigned.
 *
 * There is deliberately no `reset` option any more. Clearing every assignment
 * meant clearing manual ones too, since they were never tracked separately, and
 * there was no way to tell afterwards which had been deliberate. It was a
 * one-click way to lose every routing decision made by hand.
 */
export async function POST() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await applyBudgetRules(auth.userId);

    return Response.json({
      ok: true,
      scanned: result.scanned,
      assigned: result.assigned,
      remaining: await countUnassigned(auth.userId),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not apply rules.";
    console.error("[budget-rules] apply failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** How many transactions still have no bucket. */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  return Response.json({ unassigned: await countUnassigned(auth.userId) });
}