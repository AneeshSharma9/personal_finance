import "server-only";

import { and, count, eq } from "drizzle-orm";

import { db, tables } from "@/db";
import { accountDisplayName } from "@/lib/account-name";
import { requireUserId } from "@/lib/auth";

/**
 * One account: preview counts for the removal dialog, a rename, and removal.
 *
 * Plaid has no "remove one account" endpoint - an Item is the smallest unit it
 * exposes - so removal is a local one. The account row and everything hanging off
 * it go; the rest of the institution stays linked. Use unlinking the institution
 * instead when the whole login should go.
 */

/** Longest nickname an account can be given. Same cap as loans and buckets. */
const MAX_NICKNAME_LENGTH = 80;

/** Preview counts for the confirmation dialog. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const account = await ownedAccount(auth.userId, await idFrom(ctx));
  if (!account) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  const [transactionRow] = await db
    .select({ n: count() })
    .from(tables.transactions)
    .where(eq(tables.transactions.accountId, account.id));

  return Response.json({
    name: accountDisplayName(account),
    transactions: transactionRow?.n ?? 0,
  });
}

/**
 * Rename an account.
 *
 * Writes `name_override` rather than `name`, because `syncAccounts` puts Plaid's
 * name in its upsert `set` map - a rename in `name` would be reverted by the next
 * sync, whether that was a manual sync, a page load, or the nightly cron. The
 * bank name is not lost either way; it stays in `name` and is offered as the
 * hint behind the nickname.
 *
 * An empty string clears the nickname rather than being rejected, so "reset to
 * what the bank calls it" is the same control as setting one.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const id = await idFrom(ctx);
  const account = await ownedAccount(auth.userId, id);
  if (!account) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  let body: { nameOverride?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  if (!("nameOverride" in body)) {
    return Response.json(
      { error: "Send a nameOverride to rename an account." },
      { status: 400 },
    );
  }

  let nameOverride: string | null;
  try {
    nameOverride = normalizeNickname(body.nameOverride);
  } catch (error) {
    if (error instanceof InvalidField) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (nameOverride === account.nameOverride) {
    return Response.json({
      account: {
        id: account.id,
        name: account.name,
        nameOverride: account.nameOverride,
        displayName: accountDisplayName(account),
      },
    });
  }

  const [updated] = await db
    .update(tables.accounts)
    .set({ nameOverride, updatedAt: new Date() })
    .where(eq(tables.accounts.id, account.id))
    .returning({
      id: tables.accounts.id,
      name: tables.accounts.name,
      nameOverride: tables.accounts.nameOverride,
    });

  if (!updated) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  return Response.json({
    account: { ...updated, displayName: accountDisplayName(updated) },
  });
}

/** A trimmed nickname, or null to clear it. */
function normalizeNickname(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidField("nameOverride must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NICKNAME_LENGTH) {
    throw new InvalidField(
      `Nicknames must be ${MAX_NICKNAME_LENGTH} characters or fewer.`,
    );
  }
  return trimmed;
}

class InvalidField extends Error {}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const id = await idFrom(ctx);
  const account = await ownedAccount(auth.userId, id);
  if (!account) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  const [transactionRow] = await db
    .select({ n: count() })
    .from(tables.transactions)
    .where(eq(tables.transactions.accountId, account.id));

  const [deleted] = await db
    .delete(tables.accounts)
    .where(eq(tables.accounts.id, account.id))
    .returning({ id: tables.accounts.id });

  if (!deleted) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  return Response.json({
    deleted: { accounts: 1, transactions: transactionRow?.n ?? 0 },
  });
}

async function idFrom(ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = Number.parseInt(rawId, 10);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

/**
 * Resolve an account only if it belongs to this user.
 *
 * Walks account -> item -> user rather than trusting the id, so a guessed id
 * can't delete someone else's row. Returns null for an invalid id too, which the
 * caller turns into a 404.
 */
async function ownedAccount(userId: string, accountId: number) {
  if (accountId <= 0) return null;

  return db.query.accounts.findFirst({
    where: eq(tables.accounts.id, accountId),
    columns: { id: true, name: true, nameOverride: true, itemId: true },
  }).then(async (account) => {
    if (!account) return null;
    const owner = await db.query.items.findFirst({
      where: and(
        eq(tables.items.id, account.itemId),
        eq(tables.items.userId, userId),
      ),
      columns: { id: true },
    });
    return owner ? account : null;
  });
}