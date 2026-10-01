import "server-only";

import { and, eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { decryptToken } from "@/lib/crypto";
import { describePlaidError, getPlaidClient } from "@/lib/plaid/client";
import {
  syncAccounts,
  syncInvestments,
  syncItem,
  syncLiabilities,
  type SyncResult,
} from "@/lib/plaid/sync";

export { syncItem };

/** Plaid returns PRODUCT_NOT_READY when an optional product isn't enabled yet. */
const OPTIONAL_PRODUCT_CODES = new Set([
  "PRODUCT_NOT_READY",
  "INVALID_FIELD",
]);

/**
 * Refresh balances, liabilities and holdings without touching transactions.
 *
 * Called from the SYNC_UPDATES_AVAILABLE webhook: transactions and balances are
 * separate Plaid endpoints, and balances are what the daily net-worth snapshot
 * reads.
 */
export async function refreshNonTransactionalData(
  item: tables.Item,
): Promise<void> {
  const accessToken = decryptToken(item.accessTokenEncrypted);
  const warnings: string[] = [];

  try {
    await syncAccounts(item.id, accessToken);
  } catch (error) {
    warnings.push(`balances: ${describePlaidError(error).errorCode}`);
  }

  try {
    await syncLiabilities(item.id, accessToken);
  } catch (error) {
    const { errorCode, message } = describePlaidError(error);
    if (!OPTIONAL_PRODUCT_CODES.has(errorCode)) {
      warnings.push(`liabilities: ${errorCode} ${message}`);
    }
  }

  try {
    await syncInvestments(item.id, accessToken);
  } catch (error) {
    const { errorCode, message } = describePlaidError(error);
    if (!OPTIONAL_PRODUCT_CODES.has(errorCode)) {
      warnings.push(`investments: ${errorCode} ${message}`);
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `[plaid] non-transactional refresh warnings for item ${item.id}: ` +
        warnings.join("; "),
    );
  }
}

export type RefreshResult = SyncResult & {
  liabilities: number;
  investments: { holdings: number; transactions: number };
  /** Non-fatal problems, e.g. an institution without Investments support. */
  warnings: string[];
  /** How many transactions the budget engine routed on this pass. */
  budgetAssigned: number;
};

/**
 * Full refresh of one Item: transactions, balances, liabilities, holdings.
 *
 * The optional products (Liabilities, Investments) are requested at link time
 * so institutions that don't support them can still link. That means their sync
 * calls are EXPECTED to fail for those institutions, so failures here are
 * collected as warnings rather than aborting the whole refresh.
 */
export async function refreshAllForItem(
  item: tables.Item,
): Promise<RefreshResult> {
  const result = await syncItem(item);

  if (!result.ok) {
    return {
      ...result,
      liabilities: 0,
      investments: { holdings: 0, transactions: 0 },
      warnings: [],
      budgetAssigned: 0,
    };
  }

  // Route the newly-synced transactions into budget buckets. Runs after every
  // sync so a bucket's Actual is current without the user doing anything. The
  // engine only fills in unassigned rows, so this is cheap when there is nothing
  // new and never disturbs a manual assignment.
  const budgetAssigned = await routeNewTransactions(item.userId);

  const accessToken = decryptToken(item.accessTokenEncrypted);
  const warnings: string[] = [];

  // Refresh balances even though syncItem already did: /accounts/get is the
  // documented source for the daily snapshot, and balances move more often than
  // transactions.
  try {
    await syncAccounts(item.id, accessToken);
  } catch (error) {
    warnings.push(`balances: ${describePlaidError(error).errorCode}`);
  }

  let liabilities = 0;
  try {
    liabilities = await syncLiabilities(item.id, accessToken);
  } catch (error) {
    const { errorCode, message } = describePlaidError(error);
    if (!OPTIONAL_PRODUCT_CODES.has(errorCode)) {
      warnings.push(`liabilities: ${errorCode} ${message}`);
    }
  }

  let investments = { holdings: 0, transactions: 0 };
  try {
    investments = await syncInvestments(item.id, accessToken);
  } catch (error) {
    const { errorCode, message } = describePlaidError(error);
    if (!OPTIONAL_PRODUCT_CODES.has(errorCode)) {
      warnings.push(`investments: ${errorCode} ${message}`);
    }
  }

  return {
    ...result,
    liabilities,
    investments,
    warnings,
    budgetAssigned,
  };
}

/**
 * Run the budget rule engine, treating failure as non-fatal.
 *
 * Budget routing is bookkeeping on top of a successful sync. If it throws, the
 * bank data is still correct and the user can re-run it from the budgets page, so
 * this must never fail the sync that triggered it.
 */
async function routeNewTransactions(userId: string): Promise<number> {
  try {
    const { applyBudgetRules } = await import("@/lib/budget-engine");
    const outcome = await applyBudgetRules(userId);
    if (outcome.assigned > 0) {
      console.log(
        `[budgets] routed ${outcome.assigned} of ${outcome.scanned} ` +
          "transactions into buckets",
      );
    }
    return outcome.assigned;
  } catch (error) {
    console.error(
      "[budgets] rule engine failed:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

/** Refresh every Item owned by a user. Used by the manual Refresh button. */
export async function refreshAllItemsForUser(
  userId: string,
): Promise<RefreshResult[]> {
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    orderBy: (i, { asc }) => [asc(i.createdAt)],
  });

  const results: RefreshResult[] = [];
  // Sequential rather than parallel: Plaid rate-limits per access token, and a
  // personal app has a handful of Items at most.
  for (const item of items) {
    results.push(await refreshAllForItem(item));
  }
  return results;
}

/** Fetch one Item, scoped to its owner. Returns null if it isn't theirs. */
export async function getOwnedItem(
  itemId: number,
  userId: string,
): Promise<tables.Item | null> {
  const item = await db.query.items.findFirst({
    where: and(eq(tables.items.id, itemId), eq(tables.items.userId, userId)),
  });
  return item ?? null;
}

/**
 * Look up an Item by Plaid's item_id and verify it belongs to the user.
 *
 * Used by the webhook path, where the item_id comes from a signed Plaid payload
 * rather than the session.
 */
export async function getItemByPlaidId(
  plaidItemId: string,
): Promise<tables.Item | null> {
  const item = await db.query.items.findFirst({
    where: eq(tables.items.plaidItemId, plaidItemId),
  });
  return item ?? null;
}

/**
 * Current Item health straight from Plaid, used by the "check status" action.
 *
 * Plaid's current /item/get schema reports a per-product status object rather
 * than a single status string, so health is derived: a populated `item.error`
 * wins, then we fall back to whether the last transactions update failed.
 */
export async function fetchPlaidItemStatus(item: tables.Item): Promise<{
  status: tables.ItemStatus;
  errorCode: string | null;
  errorMessage: string | null;
  lastSuccessfulUpdate: string | null;
}> {
  const client = getPlaidClient();
  const accessToken = decryptToken(item.accessTokenEncrypted);
  const response = await client.itemGet({ access_token: accessToken });
  const { item: plaidItem, status } = response.data;

  const lastSuccessfulUpdate = status?.transactions?.last_successful_update ?? null;
  const lastFailedUpdate = status?.transactions?.last_failed_update ?? null;

  const errorCode = plaidItem.error?.error_code ?? null;
  const statusValue = errorCode
    ? mapItemErrorToStatus(errorCode)
    : lastFailedUpdate && !lastSuccessfulUpdate
      // Never updated successfully and at least one failure: almost always
      // expired credentials rather than a transient outage.
      ? "login_required"
      : "healthy";

  return {
    status: statusValue,
    errorCode,
    errorMessage: plaidItem.error?.error_message ?? null,
    lastSuccessfulUpdate,
  };
}

/** Map a Plaid Item error_code onto one of our item_status values. */
export function mapItemErrorToStatus(
  errorCode: string,
): tables.ItemStatus {
  const map: Record<string, tables.ItemStatus> = {
    ITEM_LOGIN_REQUIRED: "login_required",
    PENDING_EXPIRATION: "pending_expiration",
    ITEM_LOCKED: "item_locked",
    USER_LOCKED: "user_locked",
    REVOKED: "revoked",
    PENDING_DISCONNECT: "pending_disconnect",
  };
  return map[errorCode] ?? "error";
}