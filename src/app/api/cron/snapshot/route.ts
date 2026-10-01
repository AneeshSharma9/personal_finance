import { sql } from "drizzle-orm";

import { db, tables } from "@/db";
import { cronSecret, isAllowedEmail } from "@/lib/env";
import { getNetWorth } from "@/lib/queries";

/**
 * Daily net-worth snapshot.
 *
 * Plaid reports CURRENT balances only, so net-worth history exists only for
 * days we recorded. There is no backfill. Start this early
 * (PLANNED_ARCHITECTURE.md 5.6).
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. We also accept
 * `x-cron-secret` for manual testing with curl.
 */
export async function GET(request: Request) {
  const secret = cronSecret();
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured; refusing to run." },
      { status: 500 },
    );
  }

  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-secret");

  if (provided !== secret) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Everyone allowlisted gets a snapshot; the app is single-user but this
  // keeps the job correct if a second address is ever added.
  const users = await db.query.users.findMany();
  const eligible = users.filter((user) => isAllowedEmail(user.email));

  if (eligible.length === 0) {
    return Response.json({ error: "No allowed users found." }, { status: 404 });
  }

  // One snapshot per day: re-running the cron updates the same row instead of
  // adding a duplicate (the unique index on user_id + snapshot_date).
  const snapshotDate = todayUtc();

  const results = [];
  for (const user of eligible) {
    const [breakdown, accountCount, liabilityCount] = await Promise.all([
      getNetWorth(user.id),
      getAccountCount(user.id),
      getLiabilityCount(user.id),
    ]);

    await db
      .insert(tables.netWorthSnapshots)
      .values({
        userId: user.id,
        snapshotDate,
        assetsTotal: breakdown.assets.toFixed(4),
        liabilitiesTotal: breakdown.liabilities.toFixed(4),
        netWorth: breakdown.netWorth.toFixed(4),
        breakdownJson: {
          cash: breakdown.cash,
          other: breakdown.other,
          investments: breakdown.investments,
          creditCards: breakdown.creditCards,
          loans: breakdown.loans,
          manualAssets: breakdown.manualAssets,
          manualLiabilities: breakdown.manualLiabilities,
          accountCount,
          liabilityCount,
        },
      })
      .onConflictDoUpdate({
        target: [
          tables.netWorthSnapshots.userId,
          tables.netWorthSnapshots.snapshotDate,
        ],
        set: {
          assetsTotal: breakdown.assets.toFixed(4),
          liabilitiesTotal: breakdown.liabilities.toFixed(4),
          netWorth: breakdown.netWorth.toFixed(4),
        },
      });

    results.push({ userId: user.id, netWorth: breakdown.netWorth });
  }

  return Response.json({
    ok: true,
    snapshotDate,
    snapshots: results.length,
  });
}

/** UTC date as YYYY-MM-DD, matching the date column's granularity. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Account counts for the snapshot breakdown.
 *
 * Counted with SQL rather than by fetching rows: the cron runs daily and only
 * needs two integers per user.
 */
async function getAccountCount(userId: string): Promise<number> {
  const [row] = await db.execute<{ count: string }>(
    sql`
      select count(*)::text as count
      from accounts a
      join items i on i.id = a.item_id
      where i.user_id = ${userId}
    `,
  );
  return Number(row?.count ?? 0);
}

async function getLiabilityCount(userId: string): Promise<number> {
  const [row] = await db.execute<{ count: string }>(
    sql`
      select count(*)::text as count
      from liabilities l
      join accounts a on a.id = l.account_id
      join items i on i.id = a.item_id
      where i.user_id = ${userId}
    `,
  );
  return Number(row?.count ?? 0);
}