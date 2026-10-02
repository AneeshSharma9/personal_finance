import { sql } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { cronSecret, isAllowedEmail } from "@/lib/env";
import {
  refreshAllItemsForUser,
  type RefreshResult,
} from "@/lib/plaid/sync-items";
import { getAccounts, getNetWorth } from "@/lib/queries";
import { runSteps, type StepResult } from "@/lib/run-steps";

/**
 * Daily sync, then daily balance snapshots: the net-worth total, and one row per
 * account.
 *
 * It syncs first, so the snapshot records balances Plaid has just refreshed
 * rather than whatever the last page load happened to leave in the database. That
 * also means the dashboard's "Last synced" line advances on its own, and nobody
 * has to open the app or press Refresh to keep it honest.
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
 *
 * A Plaid failure does not fail the job. `refreshAllForItem` reports a broken
 * Item by returning `ok: false` rather than throwing - it also writes the Item's
 * status, which is what turns the dashboard's "needs attention" link red - so a
 * single unhealthy institution is reported in the response and the snapshot
 * still lands. Only an outright crash while writing the snapshot fails the run.
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

  const results: { userId: string; netWorth: number; accounts: number }[] = [];
  const synced: SyncSummary[] = [];
  const failedSteps: StepResult[] = [];

  for (const user of eligible) {
    const steps = await runSteps([
      /*
       * Sync first. This is the whole reason the snapshot reads fresh balances
       * rather than whatever the last page load left behind, and it is what
       * advances "Last synced" while the app sits closed. Sequential per Item is
       * `refreshAllItemsForUser`'s choice, not ours: Plaid rate-limits per access
       * token.
       */
      {
        name: `sync:${user.id}`,
        run: async () => {
          const items = await refreshAllItemsForUser(user.id);
          const broken = items.filter((item) => !item.ok);

          synced.push({
            userId: user.id,
            items: items.length,
            added: sum(items, "added"),
            modified: sum(items, "modified"),
            removed: sum(items, "removed"),
            budgetAssigned: sum(items, "budgetAssigned"),
            failedItems: broken.map((item) => ({
              itemId: item.itemId,
              error: item.error ?? "Sync failed for an unknown reason.",
            })),
            warnings: items.flatMap((item) => item.warnings),
          });
        },
      },
      {
        name: `snapshot:${user.id}`,
        run: async () => {
          const [breakdown, accounts, accountCount, liabilityCount] =
            await Promise.all([
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
        },
      },
    ]);

    failedSteps.push(...steps.filter((step) => !step.ok));
  }

  return Response.json({
    ok: true,
    snapshotDate,
    snapshots: results.length,
    accounts: results.reduce((total, row) => total + row.accounts, 0),
    /*
     * Still 200 even when the sync failed, on purpose: the snapshot did land, and
     * Vercel retrying the whole job because one institution needed re-auth would
     * re-sync every Item to no purpose. The failure is reported rather than
     * raised, which is also what surfaces it in the Vercel logs.
     */
    sync: synced,
    failedSteps,
  });
}

/** What one user's Plaid refresh pulled, for the cron response. */
type SyncSummary = {
  userId: string;
  items: number;
  added: number;
  modified: number;
  removed: number;
  budgetAssigned: number;
  failedItems: { itemId: number; error: string }[];
  warnings: string[];
};

function sum(
  items: readonly RefreshResult[],
  key: "added" | "modified" | "removed" | "budgetAssigned",
): number {
  return items.reduce((total, item) => total + item[key], 0);
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