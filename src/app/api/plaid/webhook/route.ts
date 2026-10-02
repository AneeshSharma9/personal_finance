import { eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { isAllowedEmail, plaidEnv } from "@/lib/env";
import { describePlaidError } from "@/lib/plaid/client";
import {
  summarizeWebhook,
  verifyPlaidWebhook,
  webhookEnvironmentMatches,
} from "@/lib/plaid/webhook";
import { syncInvestments, syncItem } from "@/lib/plaid/sync";
import {
  fetchPlaidItemStatus,
  refreshNonTransactionalData,
} from "@/lib/plaid/sync-items";
import { decryptToken } from "@/lib/crypto";

/**
 * Plaid webhook receiver (PLANNED_ARCHITECTURE.md 5.3).
 *
 * Plaid POSTs here. We verify the signature before trusting anything, then act
 * on the two webhook families we care about:
 *   SYNC_UPDATES_AVAILABLE -> new transactions are ready, run /transactions/sync
 *   ITEM                   -> the Item's health changed (e.g. login required)
 *
 * Plaid retries on non-2xx, so we acknowledge fast and do the work inline but
 * defensively: a sync failure updates the Item row and never throws, because an
 * unhandled throw here would trigger an endless retry storm.
 */
export async function POST(request: Request) {
  // The raw text is needed for the signature check; JSON.parse alone would let
  // a tampered body through if we re-serialised.
  const rawBody = await request.text();
  const headerValue = request.headers.get("plaid-verification");

  const verification = await verifyPlaidWebhook(headerValue, rawBody);
  if (!verification.ok) {
    console.error(`[plaid-webhook] rejected: ${verification.reason}`);
    return Response.json({ error: verification.reason }, { status: 400 });
  }

  const { body } = verification;

  if (!webhookEnvironmentMatches(body)) {
    // e.g. a Sandbox webhook arriving while PLAID_ENV=production. Ack it so
    // Plaid stops retrying, but do not touch any data.
    console.warn(
      `[plaid-webhook] ignoring ${summarizeWebhook(body)}: environment ` +
        `${body.environment} does not match PLAID_ENV=${plaidEnv()}`,
    );
    return Response.json({ ok: true, ignored: true });
  }

  console.log(`[plaid-webhook] received ${summarizeWebhook(body)}`);

  try {
    switch (body.webhook_type) {
      case "TRANSACTIONS":
        if (body.webhook_code === "SYNC_UPDATES_AVAILABLE") {
          await handleSyncUpdates(body.item_id);
        }
        break;

      case "ITEM":
        /*
         * Plaid detected an account it has not been given access to yet - the
         * newly-issued Capital One card. Only a Link update-mode run can grant
         * it, so there is nothing to sync automatically; refreshing here would
         * just re-fetch the accounts we already have. Logged so the case is
         * visible in the deployment logs.
         *
         * Do NOT respond by creating a new Item: /item/remove does not free a
         * Trial-plan slot, so re-linking would spend a permanent one.
         */
        if (body.webhook_code === "NEW_ACCOUNTS_AVAILABLE") {
          const item = await findItemByPlaidId(body.item_id);
          console.log(
            `[plaid-webhook] new accounts available at ` +
              `${item?.institutionName ?? body.item_id}; needs a Link ` +
              "update-mode run to grant access",
          );
        } else {
          await handleItemWebhook(body);
        }
        break;

      case "INVESTMENTS":
        if (body.webhook_code === "INVESTMENTS_UPDATES_AVAILABLE") {
          await handleInvestmentUpdates(body.item_id);
        }
        break;


      default:
        // Liabilities, asset reports and statements arrive here too. Accept
        // them so Plaid stops retrying; the next manual sync picks them up.
        break;
    }
  } catch (error) {
    // Log and still return 2xx: a retry would re-run the same work and, if the
    // cause is persistent (an expired token, a revoked Item), retry forever.
    console.error(
      `[plaid-webhook] handler failed for ${summarizeWebhook(body)}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return Response.json({ ok: true });
}

async function handleSyncUpdates(itemId: string | undefined) {
  const item = await findItemByPlaidId(itemId);
  if (!item) return;

  const result = await syncItem(item);
  if (!result.ok) {
    console.error(
      `[plaid-webhook] sync of ${item.plaidItemId} failed: ${result.error}`,
    );
    return;
  }

  // Balances, liabilities and holdings come from separate endpoints, so
  // refresh them too; the daily snapshot reads these rows.
  await refreshNonTransactionalData(item);

  // Route the new transactions into budget buckets. Non-fatal: the bank data is
  // already correct, and the budgets page can re-run it.
  try {
    const { applyBudgetRules } = await import("@/lib/budget-engine");
    const routed = await applyBudgetRules(item.userId);
    if (routed.assigned > 0) {
      console.log(
        `[plaid-webhook] routed ${routed.assigned} transactions into ` +
          "budget buckets",
      );
    }
  } catch (error) {
    console.error(
      "[plaid-webhook] budget routing failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function handleItemWebhook(body: {
  item_id?: string;
  webhook_code?: string;
  error?: unknown;
}) {
  const item = await findItemByPlaidId(body.item_id);
  if (!item) return;

  const errorCode =
    body.error && typeof body.error === "object"
      ? (body.error as { error_code?: string }).error_code
      : undefined;

  // ITEM_LOGIN_REQUIRED is the one that matters for slot safety: the fix is a
  // Link UPDATE-mode run (free), never a new Item (costs a Trial slot).
  if (body.webhook_code === "ITEM_LOGIN_REQUIRED" || errorCode) {
    const message =
      errorCode ??
      "Plaid reported an Item error. Check the Plaid Dashboard for details.";
    const status =
      body.webhook_code === "ITEM_LOGIN_REQUIRED" || errorCode === "ITEM_LOGIN_REQUIRED"
        ? "login_required"
        : "error";

    await db
      .update(tables.items)
      .set({
        status,
        errorCode: errorCode ?? null,
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(tables.items.id, item.id));

    console.warn(`[plaid-webhook] item ${item.plaidItemId}: ${message}`);
    return;
  }

  // Health webhook with no error payload: ask Plaid for the current state.
  try {
    const current = await fetchPlaidItemStatus(item);

    await db
      .update(tables.items)
      .set({
        status: current.status,
        errorCode: current.errorCode,
        errorMessage: current.errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(tables.items.id, item.id));
  } catch (error) {
    const described = describePlaidError(error);
    console.error(
      `[plaid-webhook] itemGet failed for ${item.plaidItemId}: ` +
        described.errorCode,
    );
  }
}

async function handleInvestmentUpdates(itemId: string | undefined) {
  const item = await findItemByPlaidId(itemId);
  if (!item) return;

  try {
    const accessToken = decryptToken(item.accessTokenEncrypted);
    const result = await syncInvestments(item.id, accessToken);
    console.log(
      `[plaid-webhook] investments for ${item.plaidItemId}: ` +
        `${result.holdings} holdings, ${result.transactions} transactions`,
    );
  } catch (error) {
    const described = describePlaidError(error);
    console.error(
      `[plaid-webhook] investment sync failed for ${item.plaidItemId}: ` +
        `${described.errorCode} (${described.message})`,
    );
  }
}


/**
 * Look up an Item by Plaid's item_id.
 *
 * Webhooks arrive unauthenticated - Plaid signs them and we verify the
 * signature, but there is no session cookie - so we must NOT call
 * requireUserId() here. The signature is the authorisation; we additionally
 * confirm the owning user is still on the allowlist before touching their data.
 */
async function findItemByPlaidId(plaidItemId: string | undefined) {
  if (!plaidItemId) return null;

  const item = await db.query.items.findFirst({
    where: eq(tables.items.plaidItemId, plaidItemId),
  });
  if (!item) return null;

  if (!(await ownerIsAllowed(item.userId))) {
    console.error(
      `[plaid-webhook] refusing to sync ${plaidItemId}: owner is missing or ` +
        "no longer on ALLOWED_EMAILS",
    );
    return null;
  }

  return item;
}

/**
 * Whether a user id still belongs to an allowlisted email.
 *
 * Checks ALLOWED_EMAILS directly rather than going through Supabase Auth,
 * because there is no session in a webhook context.
 */
async function ownerIsAllowed(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(tables.users.id, userId),
  });
  if (!user) return false;
  return isAllowedEmail(user.email);
}
