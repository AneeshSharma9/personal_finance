import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { isAllowedEmail } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type CurrentUser = {
  id: string;
  email: string;
};

/**
 * The signed-in user, or null.
 *
 * Two gates apply:
 *   1. Supabase Auth must return a valid session.
 *   2. The email must appear in ALLOWED_EMAILS.
 *
 * Gate 2 is the important one for this app. Supabase signups may be open by
 * default, and a stranger creating an account would let them link their own
 * bank to your Plaid team and burn your 10-Item Trial cap. The allowlist is
 * what makes the app single-user.
 *
 * Wrapped in React `cache` so the several pages/components on a single render
 * share one round trip to Supabase Auth.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user?.email) {
    return null;
  }

  if (!isAllowedEmail(user.email)) {
    // Refuse the session but don't pretend the user doesn't exist; they need
    // to see an explanation rather than an infinite redirect loop.
    return null;
  }

  return { id: user.id, email: user.email };
});

/**
 * The signed-in user, or a redirect to the login page.
 *
 * Use in Server Components that render app content. API routes should use
 * requireUserId and return 401/403 instead of redirecting.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export type AuthFailure = {
  ok: false;
  status: 401 | 403;
  error: string;
};

export type AuthSuccess = { ok: true; userId: string; email: string };
export type AuthResult = AuthSuccess | AuthFailure;

/**
 * Authorisation check for Route Handlers.
 *
 * Never redirect from a route handler on auth failure - return the status so
 * the client can react. Distinguishes 401 (no session) from 403 (valid
 * session, wrong email) so a stranger can tell they are not allowlisted.
 */
export async function requireUserId(): Promise<AuthResult> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      ok: false,
      status: 401,
      error: "Not authenticated. Sign in at /login.",
    };
  }

  if (!user.email || !isAllowedEmail(user.email)) {
    return {
      ok: false,
      status: 403,
      error:
        "This account is not on the ALLOWED_EMAILS list. Add it to " +
        "ALLOWED_EMAILS in .env.local and redeploy.",
    };
  }

  return { ok: true, userId: user.id, email: user.email };
}

/**
 * Every Item owned by a user, oldest first.
 *
 * Prefer `getItems` in lib/queries.ts, which is cached per request for Server
 * Components. This variant exists for callers that already hold the db handle.
 */
export async function listItemsForUser(userId: string) {
  return db.query.items.findMany({
    where: (item, { eq }) => eq(item.userId, userId),
    orderBy: (item, { asc }) => [asc(item.createdAt)],
  });
}