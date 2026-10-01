import "server-only";

import { asc, eq, inArray } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { requireUserId } from "@/lib/auth";

/**
 * Accounts and balances, scoped to the signed-in user.
 *
 * Balances come from Plaid's `/accounts/get` cache, which is the documented
 * source for daily snapshots. Use `/accounts/balance/get` only when a real-time
 * number is genuinely needed.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  // Resolve the user's Item ids first so every downstream query is scoped.
  const items = await db.query.items.findMany({
    where: eq(tables.items.userId, auth.userId),
    columns: { id: true },
  });
  const itemIds = items.map((i) => i.id);

  if (itemIds.length === 0) {
    return Response.json({ accounts: [], totals: emptyTotals() });
  }

  const accounts = await db.query.accounts.findMany({
    where: inArray(tables.accounts.itemId, itemIds),
    orderBy: [asc(tables.accounts.type), asc(tables.accounts.name)],
  });

  // The /item/remove caveat: nothing here should ever delete rows on its own.
  return Response.json({
    accounts: accounts.map((account) => ({
      id: account.id,
      itemId: account.itemId,
      plaidAccountId: account.plaidAccountId,
      name: account.name,
      officialName: account.officialName,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      currentBalance: toNumber(account.currentBalance),
      availableBalance:
        account.availableBalance === null
          ? null
          : toNumber(account.availableBalance),
      isoCurrencyCode: account.isoCurrencyCode,
      balanceUpdatedAt: account.balanceUpdatedAt,
      /**
       * Plaid reports credit card and loan balances as positive amounts owed,
       * while depository balances are positive when you have money. We keep the
       * raw sign on the row and expose an explicit signed value here so the UI
       * never has to infer direction from account type.
       */
      signedBalance: signedBalance(account.type, toNumber(account.currentBalance)),
    })),
    totals: computeTotals(accounts),
  });
}

/**
 * Sign a balance from the net-worth perspective.
 *
 * Assets contribute positively; debt accounts are negated so they sum
 * correctly. This is the single place that decision is made.
 */
export function signedBalance(
  type: tables.AccountType,
  balance: number,
): number {
  return type === "credit" || type === "loan" ? -Math.abs(balance) : balance;
}

function computeTotals(accounts: tables.Account[]): Totals {
  const totals: Totals = emptyTotals();
  totals.accountCount = accounts.length;

  for (const account of accounts) {
    const balance = toNumber(account.currentBalance);
    const signed = signedBalance(account.type, balance);

    switch (account.type) {
      case "depository":
        totals.cash += signed;
        break;
      case "credit":
        totals.creditCardDebt += -signed;
        totals.liabilitiesTotal += -signed;
        break;
      case "loan":
        totals.loanDebt += -signed;
        totals.liabilitiesTotal += -signed;
        break;
      case "investment":
        // Investment value is authoritative from holdings, not from
        // current_balance (which can double count brokerage cash), so this is
        // deliberately excluded from cash and counted via holdings instead.
        totals.investmentAccounts += 1;
        break;
      default:
        totals.other += signed;
        break;
    }

    totals.assetsTotal += signed > 0 ? signed : 0;
  }

  totals.netWorth = totals.assetsTotal - totals.liabilitiesTotal;
  return totals;
}

export type Totals = {
  accountCount: number;
  cash: number;
  creditCardDebt: number;
  loanDebt: number;
  investmentAccounts: number;
  other: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  netWorth: number;
};

function emptyTotals(): Totals {
  return {
    accountCount: 0,
    cash: 0,
    creditCardDebt: 0,
    loanDebt: 0,
    investmentAccounts: 0,
    other: 0,
    assetsTotal: 0,
    liabilitiesTotal: 0,
    netWorth: 0,
  };
}

export type AccountDto = {
  id: number;
  itemId: number;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: tables.AccountType;
  subtype: tables.AccountSubtype | null;
  currentBalance: number;
  availableBalance: number | null;
  isoCurrencyCode: string;
  balanceUpdatedAt: Date | null;
  signedBalance: number;
};