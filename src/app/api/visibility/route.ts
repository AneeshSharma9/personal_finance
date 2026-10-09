import "server-only";

import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import {
  HIDDEN_BALANCES_COOKIE,
  hiddenBalancesCookieOptions,
} from "@/lib/privacy";

/**
 * Hide or reveal balances.
 *
 * A cookie and nothing else. The pages read it server-side (see lib/privacy.ts
 * for why it is not `localStorage`), so there is no row to write and no client
 * state to reconcile - the whole feature is "the cookie is set" or "it is not".
 *
 * No GET. The toggle is handed `hidden` as a prop by the page that renders it, so
 * it already knows the current value; an endpoint to ask for it would be a second
 * source of truth for something the server just decided.
 *
 * `requireUserId` before the body is even parsed: an unauthenticated caller must
 * not be able to set it, even though nothing would render differently for them.
 * Cheap, and it keeps every write route in this app looking the same.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: { hidden?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  if (typeof body.hidden !== "boolean") {
    return Response.json({ error: "Send a boolean `hidden`." }, { status: 400 });
  }

  /*
   * `NextResponse.cookies` rather than `cookies()` from next/headers, which is
   * read-only in a request context. Nor a hand-built `Set-Cookie` string: the
   * clearing case has to repeat every flag the setting one used or the browser
   * keeps the old cookie, and `maxAge: 0` on top of the shared options object is
   * the only way that stays in step by construction.
   */
  const response = NextResponse.json({ hidden: body.hidden });
  if (body.hidden) {
    response.cookies.set(HIDDEN_BALANCES_COOKIE, "1", hiddenBalancesCookieOptions);
  } else {
    response.cookies.set(HIDDEN_BALANCES_COOKIE, "", {
      ...hiddenBalancesCookieOptions,
      maxAge: 0,
    });
  }
  return response;
}