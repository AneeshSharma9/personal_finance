import "server-only";

import { requireUserId } from "@/lib/auth";
import { applyBudgetRules, countUnassigned, resetAssignments } from "@/lib/budget-engine";

/**
 * Re-run budget routing.
 *
 * The engine also runs automatically after a transaction sync, so this is for
 * after changing rules - the new rules apply to everything currently unassigned.
 *
 * Body: `{ reset?: true }` to clear existing assignments first, which is what
 * you want after restructuring buckets so old routing decisions are re-made.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let reset = false;
  try {
    const body = (await request.json()) as { reset?: unknown };
    reset = body.reset === true;
  } catch {
    // No body means "just apply".
  }

  try {
    const cleared = reset ? await resetAssignments(auth.userId) : 0;
    const result = await applyBudgetRules(auth.userId);

    return Response.json({
      ok: true,
      cleared,
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