import "server-only";

import { eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { isAllowedEmail } from "@/lib/env";

/**
 * Create the `users` row for an authenticated user, if it isn't there already.
 *
 * Every app data table has a foreign key to `users.id`. Supabase Auth knows the
 * user exists; this app's tables do not, so the first write has to create the
 * row. Without this, the very first `/api/plaid/exchange` fails its insert.
 *
 * Takes the already-verified id and email from `requireUserId` rather than
 * re-reading the session: no second round trip to Auth, and no chance of the two
 * disagreeing.
 *
 * Deliberately not in lib/auth.ts: that module imports `next/navigation` for
 * `redirect`, which makes it unloadable outside a Next runtime. Keeping this
 * pure-data function separate keeps it testable and layers the module properly.
 *
 * Returns the user id, or null when the email is not allowlisted.
 */
export async function ensureUserRow(
  userId: string,
  email: string,
): Promise<string | null> {
  if (!isAllowedEmail(email)) return null;

  const existing = await db.query.users.findFirst({
    where: (user, { eq: equals }) => equals(user.id, userId),
  });
  if (existing) return existing.id;

  // A concurrent request can win the race; the primary key turns the loser into
  // a conflict rather than a duplicate, so re-read instead of trusting the
  // insert result alone.
  const [inserted] = await db
    .insert(tables.users)
    .values({ id: userId, email })
    .onConflictDoNothing({ target: tables.users.id })
    .returning({ id: tables.users.id });

  if (inserted) return inserted.id;

  const after = await db.query.users.findFirst({
    where: (user, { eq: equals }) => equals(user.id, userId),
  });
  return after?.id ?? null;
}

/** Delete a user row. Only used by tests and local teardown. */
export async function deleteUserRow(userId: string): Promise<void> {
  await db.delete(tables.users).where(eq(tables.users.id, userId));
}