import "server-only";

import { normaliseWorksheetInput, computeWorksheet } from "@/lib/budget-worksheet";
import { requireUserId } from "@/lib/auth";
import { getBudgetWorksheet, saveBudgetWorksheet } from "@/lib/queries";

/**
 * The budget worksheet.
 *
 * GET returns the saved inputs *and* the computed result, so a client can render
 * the whole page from one request and the server stays the only place the
 * arithmetic happens. PUT normalises before saving, which is where a blank field
 * or a pasted "$1,200" becomes a number, and returns the recomputed result so the
 * page does not have to duplicate `computeWorksheet` to know what it just saved.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const saved = await getBudgetWorksheet(auth.userId);
  if (!saved) {
    // A null rather than a 404: no worksheet yet is the normal state on a fresh
    // install, not a missing resource.
    return Response.json({ worksheet: null, result: null });
  }

  // The id is the row's, not something the client should send back.
  const { id, ...input } = saved;
  void id;

  return Response.json({
    worksheet: input,
    result: computeWorksheet(input),
  });
}

export async function PUT(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Body must be JSON." },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { error: "Body must be an object of worksheet fields." },
      { status: 400 },
    );
  }

  const input = normaliseWorksheetInput(body);
  await saveBudgetWorksheet(auth.userId, input);

  return Response.json({
    worksheet: input,
    result: computeWorksheet(input),
  });
}