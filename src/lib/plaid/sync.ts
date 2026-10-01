import "server-only";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { db, tables } from "@/db";
import { decryptToken } from "@/lib/crypto";
import { plaidDaysRequested } from "@/lib/env";
import { describePlaidError, getPlaidClient } from "@/lib/plaid/client";

/**
 * Item statuses we persist so the UI can prompt for re-auth.
 *
 * ITEM_LOGIN_REQUIRED is the important one: the fix is Link in UPDATE MODE
 * (free) rather than a new Item (costs a Trial slot).
 */
const ITEM_ERROR_STATUS: Record<
  string,
  { status: tables.ItemStatus; message: string }
> = {
  ITEM_LOGIN_REQUIRED: {
    status: "login_required",
    message: "Your bank needs you to log in again to refresh access.",
  },
  PENDING_EXPIRATION: {
    status: "pending_expiration",
    message: "Your bank's access expires soon. Re-auth to keep syncing.",
  },
  ITEM_LOCKED: {
    status: "item_locked",
    message: "This Item is locked by Plaid. Check the Plaid Dashboard.",
  },
  USER_LOCKED: {
    status: "user_locked",
    message: "This Item is locked at the institution. Contact your bank.",
  },
  PENDING_DISCONNECT: {
    status: "pending_disconnect",
    message: "This Item is being disconnected.",
  },
  REVOKED: {
    status: "revoked",
    message: "Access to this Item was revoked at the institution.",
  },
  ERROR: {
    status: "error",
    message: "Plaid reported an error syncing this Item.",
  },
};

export type ItemRecord = tables.Item;

export async function getItemForUser(
  itemId: number,
  userId: string,
): Promise<ItemRecord | null> {
  const row = await db.query.items.findFirst({
    where: and(eq(tables.items.id, itemId), eq(tables.items.userId, userId)),
  });
  return row ?? null;
}

export type SyncResult = {
  itemId: number;
  ok: boolean;
  added: number;
  modified: number;
  removed: number;
  accountsUpdated: number;
  error?: string;
};

/**
 * Full sync of one Item: accounts, then transactions via /transactions/sync.
 *
 * Cursor discipline (PLANNED_ARCHITECTURE.md 5.2): we loop while has_more and
 * only persist next_cursor AFTER the batch is written. Writing the cursor
 * first would silently skip rows whose insert failed.
 */
export async function syncItem(item: ItemRecord): Promise<SyncResult> {
  const summary: SyncResult = {
    itemId: item.id,
    ok: false,
    added: 0,
    modified: 0,
    removed: 0,
    accountsUpdated: 0,
  };

  const client = getPlaidClient();
  const accessToken = decryptToken(item.accessTokenEncrypted);

  try {
    summary.accountsUpdated = await syncAccounts(item.id, accessToken);
  } catch (error) {
    await handleSyncError(item.id, error);
    const described = describePlaidError(error);
    return {
      ...summary,
      error: `${described.errorCode}: ${described.message}`,
    };
  }

  let cursor = item.cursor ?? undefined;

  // Plaid caps one response; loop until has_more is false. The bound is a
  // safety net against a cursor that never converges.
  for (let page = 0; page < 500; page += 1) {
    let response;
    try {
      response = await client.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });
    } catch (error) {
      await handleSyncError(item.id, error);
      const described = describePlaidError(error);
      return {
        ...summary,
        error: `${described.errorCode}: ${described.message}`,
      };
    }

    const { added, modified, removed, next_cursor: nextCursor } = response.data;

    // One transaction per page: added, modified and removed must land
    // atomically, or a crash mid-batch would leave the cursor and the rows
    // disagreeing.
    await db.transaction(async (tx) => {
      await upsertTransactions(tx, added);
      await upsertTransactions(tx, modified);

      if (removed.length > 0) {
        await removeTransactions(tx, removed);
      }
    });

    summary.added += added.length;
    summary.modified += modified.length;
    summary.removed += removed.length;
    cursor = nextCursor;

    if (!response.data.has_more) break;
  }

  // Cursor is saved only after the final batch commits.
  await db
    .update(tables.items)
    .set({
      cursor: cursor ?? null,
      status: "healthy",
      errorCode: null,
      errorMessage: null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tables.items.id, item.id));

  return { ...summary, ok: true };
}

async function handleSyncError(itemId: number, error: unknown) {
  const described = describePlaidError(error);
  const mapped = ITEM_ERROR_STATUS[described.errorCode];
  if (!mapped) return;

  await db
    .update(tables.items)
    .set({
      status: mapped.status,
      errorCode: described.errorCode,
      errorMessage: mapped.message,
      updatedAt: new Date(),
    })
    .where(eq(tables.items.id, itemId));
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Plaid adds account subtypes over time, so anything unrecognised degrades to
 * "other" instead of failing the insert.
 */
function mapAccountType(type: string): tables.AccountType {
  const known: readonly tables.AccountType[] = tables.ACCOUNT_TYPES;
  return known.includes(type as tables.AccountType)
    ? (type as tables.AccountType)
    : tables.FALLBACK_ACCOUNT_TYPE;
}

function mapAccountSubtype(
  subtype?: string | null,
): tables.AccountSubtype | null {
  if (!subtype) return null;
  const known: readonly tables.AccountSubtype[] = tables.ACCOUNT_SUBTYPES;
  return known.includes(subtype as tables.AccountSubtype)
    ? (subtype as tables.AccountSubtype)
    : tables.FALLBACK_ACCOUNT_SUBTYPE;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

/**
 * Build an `onConflictDoUpdate.set` map that copies each named column from the
 * incoming row.
 *
 * Postgres exposes the row that lost the conflict as `excluded`, which is the
 * only way to write a multi-row upsert where each row keeps its own values.
 * Using `sql.raw` here is safe because the identifiers come from our own schema
 * definitions, never from user input.
 */
function fromExcluded<T extends Record<string, unknown>>(
  columns: { [K in keyof T]: PgColumn },
): { [K in keyof T]: SQL } {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(columns)) {
    set[key] = sql.raw(`excluded.${column.name}`);
  }
  return set as { [K in keyof T]: SQL };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Pull /accounts/get into `accounts`, keyed by plaid_account_id. */
export async function syncAccounts(
  itemId: number,
  accessToken: string,
): Promise<number> {
  const client = getPlaidClient();
  const response = await client.accountsGet({ access_token: accessToken });

  const rows = response.data.accounts.map((account) => ({
    itemId,
    plaidAccountId: account.account_id,
    name: account.name,
    officialName: account.official_name ?? null,
    mask: account.mask ?? null,
    type: mapAccountType(account.type),
    subtype: mapAccountSubtype(account.subtype),
    // Plaid's raw sign is preserved: debt balances arrive positive.
    // Net-worth signs are derived at read time (schema.ts).
    currentBalance: String(account.balances.current ?? 0),
    availableBalance:
      account.balances.available === null ||
      account.balances.available === undefined
        ? null
        : String(account.balances.available),
    isoCurrencyCode: account.balances.iso_currency_code ?? "USD",
    balanceUpdatedAt: account.balances.last_updated_datetime
      ? new Date(account.balances.last_updated_datetime)
      : null,
    plaidUpdatedAt: new Date(),
    updatedAt: new Date(),
  }));

  if (rows.length === 0) return 0;

  await db
    .insert(tables.accounts)
    .values(rows)
    .onConflictDoUpdate({
      target: tables.accounts.plaidAccountId,
      set: fromExcluded({
        itemId: tables.accounts.itemId,
        name: tables.accounts.name,
        officialName: tables.accounts.officialName,
        mask: tables.accounts.mask,
        type: tables.accounts.type,
        subtype: tables.accounts.subtype,
        currentBalance: tables.accounts.currentBalance,
        availableBalance: tables.accounts.availableBalance,
        isoCurrencyCode: tables.accounts.isoCurrencyCode,
        balanceUpdatedAt: tables.accounts.balanceUpdatedAt,
        plaidUpdatedAt: tables.accounts.plaidUpdatedAt,
        updatedAt: tables.accounts.updatedAt,
      }),
    });

  return rows.length;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Minimal shape of a Plaid transaction that we depend on. */
type PlaidTransactionLike = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  authorized_date?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  pending?: boolean | null;
  iso_currency_code?: string | null;
  website?: string | null;
  logo_url?: string | null;
  personal_finance_category?: {
    primary: string;
    detailed: string;
    confidence_level?: string | null;
  } | null;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Upsert a batch of Plaid transactions.
 *
 * Pending transactions come back later as `modified` under the same
 * transaction_id once they post, so the unique constraint plus upsert handles
 * the pending -> posted transition without us matching them by hand
 * (PLANNED_ARCHITECTURE.md section 6).
 */
async function upsertTransactions(
  tx: Tx,
  transactions: PlaidTransactionLike[],
): Promise<void> {
  if (transactions.length === 0) return;

  // Transactions reference our accounts PK, so resolve Plaid ids first.
  const plaidAccountIds = [
    ...new Set(transactions.map((t) => t.account_id)),
  ];
  const accountRows = await tx
    .select({
      id: tables.accounts.id,
      plaidAccountId: tables.accounts.plaidAccountId,
    })
    .from(tables.accounts)
    .where(inArray(tables.accounts.plaidAccountId, plaidAccountIds));

  const accountIdByPlaidId = new Map(
    accountRows.map((row) => [row.plaidAccountId, row.id]),
  );

  const rows = transactions
    .map((t) => {
      const accountId = accountIdByPlaidId.get(t.account_id);
      // An unknown account means /accounts/get hasn't covered this Item yet.
      // syncAccounts runs first, so skipping beats writing an orphan row.
      if (!accountId) return null;

      return {
        accountId,
        plaidTransactionId: t.transaction_id,
        amount: String(t.amount),
        date: t.date,
        authorizedDate: t.authorized_date ?? null,
        merchantName: t.merchant_name ?? null,
        name: t.name ?? null,
        plaidCategoryPrimary: t.personal_finance_category?.primary ?? null,
        plaidCategoryDetailed: t.personal_finance_category?.detailed ?? null,
        pending: t.pending ?? false,
        isoCurrencyCode: t.iso_currency_code ?? null,
        website: t.website ?? null,
        logoUrl: t.logo_url ?? null,
        updatedAt: new Date(),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return;

  await tx
    .insert(tables.transactions)
    .values(rows)
    .onConflictDoUpdate({
      target: tables.transactions.plaidTransactionId,
      set: fromExcluded({
        accountId: tables.transactions.accountId,
        amount: tables.transactions.amount,
        date: tables.transactions.date,
        authorizedDate: tables.transactions.authorizedDate,
        merchantName: tables.transactions.merchantName,
        name: tables.transactions.name,
        plaidCategoryPrimary: tables.transactions.plaidCategoryPrimary,
        plaidCategoryDetailed: tables.transactions.plaidCategoryDetailed,
        pending: tables.transactions.pending,
        isoCurrencyCode: tables.transactions.isoCurrencyCode,
        website: tables.transactions.website,
        logoUrl: tables.transactions.logoUrl,
        updatedAt: tables.transactions.updatedAt,
        // categoryOverride, notes and isRecurring are intentionally absent:
        // those are user/derived state that must survive a Plaid re-sync.
      }),
    });
}

async function removeTransactions(
  tx: Tx,
  removed: { transaction_id: string }[],
): Promise<void> {
  const ids = removed.map((r) => r.transaction_id);
  if (ids.length === 0) return;

  // Plaid sometimes sends a short id when the full one is unavailable, so
  // match either exactly or by prefix.
  const fullIds = ids.filter((id) => id.length >= 20);
  const shortIds = ids.filter((id) => id.length < 20);

  const conditions: SQL[] = [];
  if (fullIds.length > 0) {
    conditions.push(inArray(tables.transactions.plaidTransactionId, fullIds));
  }
  for (const id of shortIds) {
    conditions.push(
      sql`${tables.transactions.plaidTransactionId} like ${`${id}%`}`,
    );
  }
  if (conditions.length === 0) return;

  await tx
    .delete(tables.transactions)
    .where(or(...conditions));
}

// ---------------------------------------------------------------------------
// Liabilities
// ---------------------------------------------------------------------------

type LiabilityRow = {
  accountId: number;
  kind: tables.LiabilityKind;
  apr: string | null;
  minimumPayment: string | null;
  nextDueDate: string | null;
  lastStatementBalance: string | null;
  lastStatementDate: string | null;
  rawJson: Record<string, unknown>;
};

/**
 * Pull /liabilities/get.
 *
 * Plaid does not return one uniform array: the response is grouped by
 * liability kind (`credit`, `student`, `mortgage`, `loan`, `line_of_credit`)
 * and the fields differ per group - a credit card reports an `aprs` array
 * while a mortgage reports `interest_rate.percentage` and
 * `next_monthly_payment`. So we normalise each group into one shape here.
 *
 * Requires the `liabilities` product, which we request as OPTIONAL at link
 * time, so a failure for an institution that doesn't support it is expected.
 */
export async function syncLiabilities(
  itemId: number,
  accessToken: string,
): Promise<number> {
  const client = getPlaidClient();
  const response = await client.liabilitiesGet({ access_token: accessToken });
  // Grouped by kind, not a flat array - see the doc comment above.
  const data = response.data.liabilities;

  const accounts = await db.query.accounts.findMany({
    where: eq(tables.accounts.itemId, itemId),
  });
  const accountIdByPlaidId = new Map(
    accounts.map((a) => [a.plaidAccountId, a.id]),
  );

  const resolve = (plaidAccountId: string | null): number | null =>
    plaidAccountId ? (accountIdByPlaidId.get(plaidAccountId) ?? null) : null;

  const rows: LiabilityRow[] = [];

  // Credit cards: multiple APRs, so take the purchase APR Plaid reports first.
  for (const credit of data.credit ?? []) {
    const accountId = resolve(credit.account_id);
    if (!accountId) continue;

    const apr = credit.aprs.find((a) => a.apr_percentage != null);

    rows.push({
      accountId,
      kind: "credit",
      apr: apr?.apr_percentage != null ? String(apr.apr_percentage) : null,
      minimumPayment: num(credit.minimum_payment_amount),
      nextDueDate: credit.next_payment_due_date,
      lastStatementBalance: num(credit.last_statement_balance),
      lastStatementDate: credit.last_statement_issue_date,
      rawJson: credit as unknown as Record<string, unknown>,
    });
  }

  // Student loans report a single interest rate, not an APR array.
  for (const student of data.student ?? []) {
    const accountId = resolve(student.account_id);
    if (!accountId) continue;

    rows.push({
      accountId,
      kind: "student",
      apr: num(student.interest_rate_percentage),
      minimumPayment: num(student.minimum_payment_amount),
      nextDueDate: student.next_payment_due_date,
      lastStatementBalance:
        num(student.last_statement_balance) ?? num(student.outstanding_interest_amount),
      lastStatementDate: student.last_statement_issue_date,
      rawJson: student as unknown as Record<string, unknown>,
    });
  }

  // Mortgages nest the rate inside an interest_rate object and use a
  // differently named payment field.
  for (const mortgage of data.mortgage ?? []) {
    const accountId = resolve(mortgage.account_id);
    if (!accountId) continue;

    rows.push({
      accountId,
      kind: "mortgage",
      apr: num(mortgage.interest_rate?.percentage),
      minimumPayment: num(mortgage.next_monthly_payment),
      nextDueDate: mortgage.next_payment_due_date,
      // Plaid does not report a mortgage statement balance; /accounts/get
      // remains the source of truth for the principal owed.
      lastStatementBalance: null,
      lastStatementDate: null,
      rawJson: mortgage as unknown as Record<string, unknown>,
    });
  }

  // Closed-end loans and lines of credit both nest interest_rate, and may
  // report several APRs.
  for (const loan of data.loan ?? []) {
    const accountId = resolve(loan.account_id);
    if (!accountId) continue;

    rows.push({
      accountId,
      kind: "other",
      apr: num(loan.interest_rate?.percentage),
      minimumPayment: num(loan.next_payment_amount),
      nextDueDate: loan.next_payment_due_date,
      lastStatementBalance: num(loan.principal_balance),
      lastStatementDate: null,
      rawJson: loan as unknown as Record<string, unknown>,
    });
  }

  for (const loc of data.line_of_credit ?? []) {
    const accountId = resolve(loc.account_id);
    if (!accountId) continue;

    const apr = loc.aprs.find((a) => a.apr_percentage != null);

    rows.push({
      accountId,
      kind: "other",
      apr: apr?.apr_percentage != null ? String(apr.apr_percentage) : null,
      minimumPayment: num(loc.minimum_payment_amount),
      nextDueDate: loc.next_payment_due_date,
      lastStatementBalance:
        num(loc.last_statement_balance) ?? num(loc.principal_balance),
      lastStatementDate: loc.last_statement_issue_date,
      rawJson: loc as unknown as Record<string, unknown>,
    });
  }

  if (rows.length === 0) return 0;

  await db
    .insert(tables.liabilities)
    .values(rows)
    .onConflictDoUpdate({
      target: tables.liabilities.accountId,
      set: fromExcluded({
        kind: tables.liabilities.kind,
        apr: tables.liabilities.apr,
        minimumPayment: tables.liabilities.minimumPayment,
        nextDueDate: tables.liabilities.nextDueDate,
        lastStatementBalance: tables.liabilities.lastStatementBalance,
        lastStatementDate: tables.liabilities.lastStatementDate,
        rawJson: tables.liabilities.rawJson,
        updatedAt: tables.liabilities.updatedAt,
      }),
    });

  return rows.length;
}

/** Plaid sends numbers; our numeric() columns take strings. Null stays null. */
function num(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

/**
 * Pull /investments/holdings/get and /investments/transactions/get.
 *
 * Requires the `investments` product, requested as OPTIONAL at link time.
 */
export async function syncInvestments(
  itemId: number,
  accessToken: string,
): Promise<{ holdings: number; transactions: number }> {
  const client = getPlaidClient();

const accounts = await db.query.accounts.findMany({
    where: eq(tables.accounts.itemId, itemId),
  });
  const accountIdByPlaidId = new Map(
    accounts.map((a) => [a.plaidAccountId, a.id]),
  );
  const investmentAccountIds = accounts.map((a) => a.id);

  const holdingsResponse = await client.investmentsHoldingsGet({
    access_token: accessToken,
  });

// Securities come back as a sibling array on the holdings response, not
  // embedded in each holding. Upsert them first so holdings can resolve ids.
  const securityRows = dedupeBy(
    holdingsResponse.data.securities.map((security) => ({
      plaidSecurityId: security.security_id,
      name: security.name ?? security.ticker_symbol ?? "Unknown security",
      tickerSymbol: security.ticker_symbol ?? null,
      isin: security.isin ?? null,
      cusip: security.cusip ?? null,
      type: security.type ?? null,
      closePrice: num(security.close_price),
      closePriceAsOf: security.close_price_as_of ?? null,
      updatedAt: new Date(),
    })),
    (r) => r.plaidSecurityId,
  );

  if (securityRows.length > 0) {
    await db
      .insert(tables.securities)
      .values(securityRows)
      .onConflictDoUpdate({
        target: tables.securities.plaidSecurityId,
        set: fromExcluded({
          name: tables.securities.name,
          tickerSymbol: tables.securities.tickerSymbol,
          isin: tables.securities.isin,
          cusip: tables.securities.cusip,
          type: tables.securities.type,
          closePrice: tables.securities.closePrice,
          closePriceAsOf: tables.securities.closePriceAsOf,
          updatedAt: tables.securities.updatedAt,
        }),
      });
  }

  const securities = await db.query.securities.findMany();
  const securityIdByPlaidId = new Map(
    securities.map((s) => [s.plaidSecurityId, s.id]),
  );

  const holdingRows = holdingsResponse.data.holdings
    .map((h) => {
      const accountId = accountIdByPlaidId.get(h.account_id);
      const securityId = securityIdByPlaidId.get(h.security_id);
      if (!accountId || !securityId) return null;

      return {
        accountId,
        securityId,
        quantity: String(h.quantity ?? 0),
        institutionPrice: num(h.institution_price),
        institutionValue: num(h.institution_value),
        costBasis: num(h.cost_basis),
        isoCurrencyCode: h.iso_currency_code ?? null,
        updatedAt: new Date(),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (holdingRows.length > 0) {
    await db
      .insert(tables.holdings)
      .values(holdingRows)
      .onConflictDoUpdate({
        target: [tables.holdings.accountId, tables.holdings.securityId],
        set: fromExcluded({
          quantity: tables.holdings.quantity,
          institutionPrice: tables.holdings.institutionPrice,
          institutionValue: tables.holdings.institutionValue,
          costBasis: tables.holdings.costBasis,
          isoCurrencyCode: tables.holdings.isoCurrencyCode,
          updatedAt: tables.holdings.updatedAt,
        }),
      });
  }

  // An empty holdings response means every position was closed: the accounts
  // still exist, so prune the holdings rather than skipping.
  await deleteStaleHoldings(holdingRows, investmentAccountIds);

  // /investments/transactions/get is date-ranged, unlike /transactions/sync.
  // Ask for the same window as the transactions product so we cover the same
  // history the user asked Plaid for at link time.
  const { start_date: startDate, end_date: endDate } =
    investmentDateWindow();

  const txnResponse = await client.investmentsTransactionsGet({
    access_token: accessToken,
    start_date: startDate,
    end_date: endDate,
  });

  const txnRows = dedupeBy(
    txnResponse.data.investment_transactions
      .map((t) => {
        const accountId = accountIdByPlaidId.get(t.account_id);
        if (!accountId) return null;

        return {
          accountId,
          securityId: t.security_id
            ? (securityIdByPlaidId.get(t.security_id) ?? null)
            : null,
          plaidInvestmentTxnId: t.investment_transaction_id,
          name: t.name ?? null,
          date: t.date,
          type: mapInvestmentTxnType(t.type, t.amount),
          subtype: t.subtype ?? null,
          quantity: num(t.quantity),
          price: num(t.price),
          amount: num(t.amount),
          fees: num(t.fees),
          isoCurrencyCode: t.iso_currency_code ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
    (r) => r.plaidInvestmentTxnId,
  );

  if (txnRows.length > 0) {
    await db
      .insert(tables.investmentTxns)
      .values(txnRows)
      .onConflictDoNothing({
        target: tables.investmentTxns.plaidInvestmentTxnId,
      });
  }

  return {
    holdings: holdingRows.length,
    transactions: txnRows.length,
  };
}

/** Remove holdings for synced accounts that Plaid no longer reports. */
async function deleteStaleHoldings(
  holdingRows: { accountId: number; securityId: number }[],
  syncedAccountIds: number[],
): Promise<void> {
  if (syncedAccountIds.length === 0) return;

  const incoming = new Set(
    holdingRows.map((r) => `${r.accountId}:${r.securityId}`),
  );

  const existing = await db
    .select({
      id: tables.holdings.id,
      accountId: tables.holdings.accountId,
      securityId: tables.holdings.securityId,
    })
    .from(tables.holdings)
    .where(inArray(tables.holdings.accountId, syncedAccountIds));

  const staleIds = existing
    .filter((h) => !incoming.has(`${h.accountId}:${h.securityId}`))
    .map((h) => h.id);

  if (staleIds.length > 0) {
    await db
      .delete(tables.holdings)
      .where(inArray(tables.holdings.id, staleIds));
  }
}

/**
 * Plaid reports investment flows as buy / sell / fee / cash / transfer /
 * cancel. Our enum models the accounting meaning instead, so cash-only
 * movements are classified by sign: Plaid documents a positive amount as cash
 * debited (money going in) and a negative amount as cash credited (money
 * coming out).
 */
function mapInvestmentTxnType(
  type: string,
  amount: number,
): tables.InvestmentTxn["type"] {
  switch (type) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "fee":
      return "fee";
    case "cancel":
      return "other";
    case "cash":
    case "transfer":
      return amount >= 0 ? "contribution" : "withdrawal";
    default:
      return "other";
  }
}

/**
 * Date window for /investments/transactions/get.
 *
 * Mirrors the history we asked for at link time so investment activity
 * matches the transaction window. Plaid rejects ranges over 730 days.
 */
function investmentDateWindow(): { start_date: string; end_date: string } {
  const days = Math.min(plaidDaysRequested(), 730);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

/** Postgres rejects a multi-row INSERT with the same conflict key twice. */
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}