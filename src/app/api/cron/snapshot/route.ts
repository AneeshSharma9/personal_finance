import { sql } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { cronSecret, isAllowedEmail } from "@/lib/env";
import { getAccounts, getNetWorth } from "@/lib/queries";

/**
 * Daily balance snapshots: the net-worth total, and one row per account.
 *
 * Plaid reports CURRENT balances only, so both histories exist only for days we
 * recorded. There is no backfill. Start this early (PLANNED_ARCHITECTURE.md 5.6).
 *
 * Loans are absent on purpose. The `loan_payments` trigger only does
 * `balance -= principal` on insert, so a loan's balance on any past day is
 * exactly recoverable from the ledger - see `loanBalanceSeries` in
 * `src/lib/loan-math.ts`. Snapshotting them too would be a strictly worse copy
 * of data already there in full.
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

  /*
   * One snapshot per day: re-running the cron updates the same row instead of
   * adding a duplicate (the unique index on user_id + snapshot_date).
   */
  const snapshotDate = todayUtc();

  const results = [];
  for (const user of eligible) {
    const [breakdown, accounts, accountCount, liabilityCount] = await Promise.all([
      getNetWorth(user.id),
      getAccounts(user.id),
      getAccountCount(user.id),
      getLiabilityCount(user.id),
    ]);

    const assetsTotal = breakdown.assets.toFixed(4);
    const liabilitiesTotal = breakdown.liabilities.toFixed(4);
    const netWorth = breakdown.netWorth.toFixed(4);
    const breakdownJson = {
      cash: breakdown.cash,
      other: breakdown.other,
      investments: breakdown.investments,
      creditCards: breakdown.creditCards,
      loans: breakdown.loans,
      manualAssets: breakdown.manualAssets,
      manualLiabilities: breakdown.manualLiabilities,
      accountCount,
      liabilityCount,
    };

    await db
      .insert(tables.netWorthSnapshots)
      .values({
        userId: user.id,
        snapshotDate,
        assetsTotal,
        liabilitiesTotal,
        netWorth,
        breakdownJson,
      })
      .onConflictDoUpdate({
        target: [
          tables.netWorthSnapshots.userId,
          tables.netWorthSnapshots.snapshotDate,
        ],
        // The breakdown belongs in the update too. It was left out, so a second
        // run on the same day refreshed the three totals while the stored
        // breakdown kept describing the morning's numbers - an account linked
        // after the first run left accountCount stale for the rest of the day.
        set: { assetsTotal, liabilitiesTotal, netWorth, breakdownJson },
      });

    /*
     * Per-account balances, for /accounts/[id]. Written for every account type,
     * not just the cash and investment ones the page links first: it is the same
     * query for all of them, and a credit card's balance over time is exactly as
     * interesting as a savings account's.
     */
    if (accounts.length > 0) {
      await db
        .insert(tables.accountBalanceSnapshots)
        .values(
          accounts.map((account) => ({
            accountId: account.id,
            snapshotDate,
            balance: toNumber(account.currentBalance).toFixed(4),
          })),
        )
        .onConflictDoUpdate({
          target: [
            tables.accountBalanceSnapshots.accountId,
            tables.accountBalanceSnapshots.snapshotDate,
          ],
          // Re-running the cron refreshes the day's reading rather than
          // duplicating it. A later sync on the same day can move a balance, and
          // the newest reading is the one the chart should end on. `excluded` is
          // the row this statement proposed to insert, so this takes the incoming
          // value without needing it in scope here.
          set: { balance: sql`excluded.balance` },
        });
    }

    results.push({
      userId: user.id,
      netWorth: breakdown.netWorth,
      accounts: accounts.length,
    });
  }

  return Response.json({
    ok: true,
    snapshotDate,
    snapshots: results.length,
    accounts: results.reduce((total, row) => total + row.accounts, 0),
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