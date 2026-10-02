import "server-only";

import { and, eq } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { splitPayment } from "@/lib/loan-math";

/**
 * Writes for the loan payment ledger.
 *
 * Separate from the loans route so the transaction PATCH route can tag and
 * un-tag without duplicating the interest split, and so the two cannot drift on
 * how a payment is divided.
 *
 * `loans.balance` is never assigned here. The `loan_payments` trigger owns it:
 * inserting a payment subtracts its principal, deleting adds it back. Anything
 * else would double-count.
 */

/** A failure the caller should surface with a specific HTTP status. */
export class LoanError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LoanError";
  }
}

/**
 * Record a tagged transaction as a payment against a loan.
 *
 * The interest split is computed here, from the loan's outstanding balance, so
 * it reflects what was really owed at the moment of payment rather than being
 * back-filled from today's numbers.
 */
export async function recordLoanPayment(input: {
  loanId: number;
  userId: string;
  transactionId: number;
  /** Transaction date, YYYY-MM-DD. */
  paidOn: string;
  /**
   * Gross amount that left the bank account. Plaid signs: positive means money
   * out. A loan payment is money out, so a negative amount is rejected by the
   * caller rather than silently flipped.
   */
  amount: number;
}): Promise<{
  paymentId: number;
  interest: number;
  principal: number;
  overpayment: number;
  balance: number;
}> {
  return db.transaction(async (tx) => {
    const loan = await tx.query.loans.findFirst({
      where: and(
        eq(tables.loans.id, input.loanId),
        eq(tables.loans.userId, input.userId),
      ),
    });
    if (!loan) throw new LoanError("That loan does not exist.", 404);

    const balance = toNumber(loan.balance);
    const apr = toNumber(loan.apr);
    // Accrue from the last accrual, or from when the loan opened if it has never
    // been touched. This is what stops a late-tagged payment being charged
    // interest twice.
    const accruedFrom = loan.lastAccruedAt ?? loan.openedOn;

    const split = splitPayment({
      balance,
      apr,
      fromDate: accruedFrom,
      toDate: input.paidOn,
      amount: input.amount,
    });

    const [payment] = await tx
      .insert(tables.loanPayments)
      .values({
        loanId: input.loanId,
        transactionId: input.transactionId,
        amount: Math.abs(input.amount).toFixed(2),
        interest: split.interest.toFixed(2),
        principal: split.principal.toFixed(2),
        overpayment: split.overpayment.toFixed(2),
        paidOn: input.paidOn,
        accruedFrom,
      })
      .returning({ id: tables.loanPayments.id });

    // Read the balance back rather than trusting split.newBalance, so the caller
    // sees exactly what the trigger committed.
    const [after] = await tx
      .select({ balance: tables.loans.balance })
      .from(tables.loans)
      .where(eq(tables.loans.id, input.loanId));

    return {
      paymentId: payment.id,
      interest: split.interest,
      principal: split.principal,
      overpayment: split.overpayment,
      balance: toNumber(after?.balance),
    };
  });
}

/**
 * Remove a transaction's loan tag, letting the trigger restore the balance.
 *
 * Safe to call for a transaction that was never tagged: returns 0 rather than
 * throwing, so un-tagging is idempotent.
 *
 * No ownership filter is needed. `loan_payments.transaction_id` is UNIQUE, and
 * the caller has already established that the transaction belongs to the user,
 * so any payment row for it must be theirs too.
 */
export async function clearLoanPayment(input: {
  transactionId: number;
}): Promise<{ removed: number }> {
  const removed = await db
    .delete(tables.loanPayments)
    .where(eq(tables.loanPayments.transactionId, input.transactionId))
    .returning({ id: tables.loanPayments.id });

  return { removed: removed.length };
}

/** Which loan, if any, a transaction is already paying. */
export async function loanPaymentFor(
  transactionId: number,
): Promise<{ loanId: number; loanName: string } | null> {
  const row = await db
    .select({
      loanId: tables.loanPayments.loanId,
      loanName: tables.loans.name,
    })
    .from(tables.loanPayments)
    .innerJoin(tables.loans, eq(tables.loans.id, tables.loanPayments.loanId))
    .where(eq(tables.loanPayments.transactionId, transactionId))
    .limit(1);

  return row[0] ?? null;
}