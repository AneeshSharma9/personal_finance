import "server-only";

import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * Transactions with filtering.
 *
 * Query params:
 *   from, to       ISO dates (YYYY-MM-DD)
 *   accountId      our account PK (repeatable via comma list)
 *   category       category_override, or plaid_category_primary
 *   q              search over merchant_name and name
 *   limit          default 100, max 500
 *   offset         default 0
 *   pending        "true" to exclude pending
 */
export async function GET(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const params = new URL(request.url).searchParams;

  const itemIds = await userItemIds(auth.userId);
  if (itemIds.length === 0) {
    return Response.json({ transactions: [], total: 0 });
  }

  const accountIds = await userAccountIds(itemIds, params.get("accountId"));
  if (accountIds === null) {
    return Response.json({ error: "Unknown accountId." }, { status: 400 });
  }

  const where: SQL[] = [inArray(tables.transactions.accountId, accountIds)];

  const from = parseDate(params.get("from"));
  const to = parseDate(params.get("to"));
  if (from) where.push(gte(tables.transactions.date, from));
  if (to) where.push(lte(tables.transactions.date, to));

  const category = params.get("category")?.trim();
  if (category) {
    const categoryMatch = or(
      eq(tables.transactions.categoryOverride, category),
      eq(tables.transactions.plaidCategoryPrimary, category),
    );
    if (categoryMatch) where.push(categoryMatch);
  }

  const search = params.get("q")?.trim();
  if (search) {
    // escapeLike so a literal % or _ in the search doesn't match everything.
    const pattern = `%${escapeLike(search)}%`;
    const searchMatch = or(
      ilike(tables.transactions.merchantName, pattern),
      ilike(tables.transactions.name, pattern),
    );
    if (searchMatch) where.push(searchMatch);
  }

  // Pending transactions get replaced when they post, so most views hide them.
  if (params.get("pending") !== "true") {
    where.push(eq(tables.transactions.pending, false));
  }

  const limit = clampInt(params.get("limit"), 100, 1, 500);
  const offset = clampInt(params.get("offset"), 0, 0, 100_000);

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: tables.transactions.id,
        date: tables.transactions.date,
        authorizedDate: tables.transactions.authorizedDate,
        amount: tables.transactions.amount,
        merchantName: tables.transactions.merchantName,
        name: tables.transactions.name,
        categoryOverride: tables.transactions.categoryOverride,
        plaidCategoryPrimary: tables.transactions.plaidCategoryPrimary,
        plaidCategoryDetailed: tables.transactions.plaidCategoryDetailed,
        pending: tables.transactions.pending,
        notes: tables.transactions.notes,
        website: tables.transactions.website,
        accountId: tables.transactions.accountId,
      })
      .from(tables.transactions)
      .where(and(...where))
      .orderBy(desc(tables.transactions.date), desc(tables.transactions.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.transactions)
      .where(and(...where)),
  ]);

  const accountNames = await accountNameMap(accountIds);

  return Response.json({
    transactions: rows.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      displayCategory: row.categoryOverride ?? row.plaidCategoryPrimary,
      accountName: accountNames.get(row.accountId) ?? "Unknown account",
      /**
       * Plaid signs amounts positive for money OUT and negative for money IN.
       * `amount` stays in Plaid's convention; `signedAmount` is the same number
       * from the perspective of your balance, which is what the UI shows.
       */
      signedAmount: -toNumber(row.amount),
    })),
    total: count,
    limit,
    offset,
    hasMore: offset + rows.length < count,
  });
}

async function userItemIds(userId: string): Promise<number[]> {
  const rows = await db.query.items.findMany({
    where: eq(tables.items.userId, userId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Resolve requested account ids, rejecting any the user doesn't own.
 *
 * Returns null (not an empty array) for an unknown id so the caller can 400
 * rather than silently returning nothing.
 */
async function userAccountIds(
  itemIds: number[],
  requested: string | null,
): Promise<number[] | null> {
  const owned = await db.query.accounts.findMany({
    where: inArray(tables.accounts.itemId, itemIds),
    columns: { id: true },
  });
  const ownedIds = owned.map((a) => a.id);

  if (!requested) return ownedIds;

  const wanted = requested
    .split(",")
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0);

  const valid = wanted.filter((id) => ownedIds.includes(id));
  // Any requested id that isn't owned means a bad request, not an empty result.
  if (valid.length !== wanted.length) return null;

  return valid.length > 0 ? valid : [];
}

async function accountNameMap(accountIds: number[]) {
  if (accountIds.length === 0) return new Map<number, string>();
  const rows = await db.query.accounts.findMany({
    where: inArray(tables.accounts.id, accountIds),
    columns: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Escape LIKE wildcards so a search for "50%" doesn't match everything. */
function escapeLike(input: string): string {
  return input.replace(/([\\%_])/g, "\\$1");
}