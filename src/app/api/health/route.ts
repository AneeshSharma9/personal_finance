import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { cronSecret } from "@/lib/env";

/**
 * Deployment health check.
 *
 * Gated by CRON_SECRET so it cannot be used to probe infrastructure. Exists
 * because the most common deploy failure is "every page 500s and the only clue is
 * in Vercel's log tail" - one request answers whether the database is reachable.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/health
 */
export async function GET(request: Request) {
  const secret = cronSecret();
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-secret");

  if (!secret || provided !== secret) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Can we reach Postgres at all? This is the usual culprit: an IPv6-only
  //    direct-connection host, or an unencoded password in DATABASE_URL.
  try {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from users`,
    );
    checks.database = { ok: true, detail: `${rows[0]?.n ?? 0} users` };
  } catch (error) {
    checks.database = {
      ok: false,
      // postgres-js errors name the host and often say "getaddrinfo ENOTFOUND",
      // which is exactly the IPv6 case.
      detail: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // 2. Is the encryption key present and the right length? A wrong key does not
  //    fail here, but a missing one breaks every Plaid call.
  try {
    const { tokenEncryptionKey } = await import("@/lib/env");
    checks.encryptionKey = { ok: tokenEncryptionKey().length === 32 };
  } catch (error) {
    checks.encryptionKey = {
      ok: false,
      detail: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // 3. Are the Plaid credentials present for the configured environment?
  try {
    const { plaidCredentials, plaidEnv } = await import("@/lib/env");
    const { clientId } = plaidCredentials();
    checks.plaid = {
      ok: clientId.length > 0,
      detail: plaidEnv(),
    };
  } catch (error) {
    checks.plaid = {
      ok: false,
      detail: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // 4. Is an email allowlist configured? Without it, isAllowedEmail denies
  //    everyone and every page redirects to /login.
  try {
    const { allowedEmails } = await import("@/lib/env");
    checks.allowedEmails = { ok: allowedEmails().size > 0 };
  } catch (error) {
    checks.allowedEmails = {
      ok: false,
      detail: error instanceof Error ? error.message : "Unknown error",
    };
  }

  const healthy = Object.values(checks).every((check) => check.ok);

  return Response.json(
    { ok: healthy, checks },
    { status: healthy ? 200 : 503 },
  );
}