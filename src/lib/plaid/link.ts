import "server-only";

import type { CountryCode, LinkTokenCreateRequest, Products } from "plaid";

import { db, tables } from "@/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import {
  plaidDaysRequested,
  plaidRedirectUri,
  plaidWebhookUrl,
} from "@/lib/env";
import {
  describePlaidError,
  getPlaidClient,
  LINK_COUNTRY_CODES,
  LINK_OPTIONAL_PRODUCTS,
  LINK_PRODUCTS,
} from "@/lib/plaid/client";

/**
 * Create a Link token.
 *
 * Two modes (PLANNED_ARCHITECTURE.md 5.1 and 5.4):
 *  - new: no `itemId`. Consumes a Trial-plan slot, so this is the expensive path.
 *  - update: `accessToken` for an existing Item whose login has expired. Free,
 *    so re-auth MUST go through this path rather than creating a new Item.
 */
export async function createLinkToken({
  userId,
  updateItemId,
}: {
  userId: string;
  /** When set, this is an update-mode token for that Item (no new slot used). */
  updateItemId?: number;
}): Promise<{ linkToken: string; expiration: string }> {
  const client = getPlaidClient();

  const webhook = plaidWebhookUrl();
  const redirectUri = plaidRedirectUri();

  const base = {
    user: { client_user_id: userId },
    client_name: "Personal Finance",
    // Match your Link branding in the Plaid Dashboard.
    language: "en",
    country_codes: LINK_COUNTRY_CODES,
    products: LINK_PRODUCTS as Products[],
    // Optional so institutions that don't support Liabilities/Investments can
    // still link instead of failing the whole flow.
    optional_products: LINK_OPTIONAL_PRODUCTS as Products[],
    webhook,
    // Omitted entirely when PLAID_REDIRECT_URI is unset. Sending an
    // unregistered value makes Plaid reject the whole request, so it must not be
    // present at all rather than defaulted to something plausible.
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  };

  try {
    const request: LinkTokenCreateRequest = updateItemId
      ? await updateModeLinkToken(updateItemId, base)
      : await newModeLinkToken(base);

    const response = await client.linkTokenCreate(request);
    return {
      linkToken: response.data.link_token,
      expiration: response.data.expiration,
    };
  } catch (error) {
    const described = describePlaidError(error);
    throw new Error(
      `Plaid link token creation failed (${described.errorCode}): ${described.message}`,
    );
  }
}

type LinkTokenBase = {
  user: { client_user_id: string };
  client_name: string;
  language: string;
  country_codes: CountryCode[];
  products: Products[];
  optional_products: Products[];
  webhook?: string;
  redirect_uri?: string;
};

async function newModeLinkToken(
  base: LinkTokenBase,
): Promise<LinkTokenCreateRequest> {
  return {
    ...base,
    transactions: {
      // ONLY applied the first time an Item is initialized with Transactions.
      // It cannot be changed later without spending another Trial slot, so this
      // is the one value to get right before linking real data. 730 is Plaid's
      // ceiling and comfortably clears the 180-day minimum that Recurring
      // Transactions detection wants.
      days_requested: plaidDaysRequested(),
    },
  } as LinkTokenCreateRequest;
}

async function updateModeLinkToken(
  updateItemId: number,
  base: LinkTokenBase,
): Promise<LinkTokenCreateRequest> {
  const item = await db.query.items.findFirst({
    where: (i, { eq }) => eq(i.id, updateItemId),
  });

  if (!item) {
    throw new Error("Item not found.");
  }

  // Sanity check: don't let one user run update mode against another's Item.
  if (item.userId !== base.user.client_user_id) {
    throw new Error("Item does not belong to the current user.");
  }

  const accessToken = decryptToken(item.accessTokenEncrypted);

  // Plaid requires the raw access token (not our encrypted copy) to put an
  // existing Item into update mode.
  return {
    ...base,
    access_token: accessToken,
  } as LinkTokenCreateRequest;
}

/**
 * Exchange a Link `public_token` for a durable `access_token` and store the
 * Item (PLANNED_ARCHITECTURE.md 5.1, step 5-6).
 *
 * Returns the new Item id. Persisting the access token is the load-bearing
 * step: lose it and the Item - plus its Trial slot - is gone.
 */
export async function exchangePublicToken({
  userId,
  publicToken,
  institution,
  environment,
}: {
  userId: string;
  publicToken: string;
  institution?: { name: string | null; institution_id: string | null };
  environment: "sandbox" | "production";
}): Promise<{ itemId: number; plaidItemId: string }> {
  const client = getPlaidClient();

  let exchange;
  try {
    exchange = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });
  } catch (error) {
    const described = describePlaidError(error);
    throw new Error(
      `Plaid public token exchange failed (${described.errorCode}): ${described.message}`,
    );
  }

  const accessToken = exchange.data.access_token;
  const plaidItemId = exchange.data.item_id;

  // Re-exchange is idempotent for the same public_token and returns the same
  // Item, so the unique index turns a double-submit into a conflict instead of
  // burning a second Trial slot.
  const existing = await db.query.items.findFirst({
    where: (i, { eq }) => eq(i.plaidItemId, plaidItemId),
  });
  if (existing) {
    return { itemId: existing.id, plaidItemId };
  }

  const [inserted] = await db
    .insert(tables.items)
    .values({
      userId,
      plaidItemId,
      accessTokenEncrypted: encryptToken(accessToken),
      institutionName: institution?.name ?? null,
      institutionId: institution?.institution_id ?? null,
      status: "healthy",
      environment,
      consentedAt: new Date(),
    })
    .returning({ id: tables.items.id });

  if (!inserted) {
    throw new Error("Failed to store Plaid Item.");
  }

  return { itemId: inserted.id, plaidItemId };
}