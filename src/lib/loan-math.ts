import "server-only";

/**
 * Manual-loan interest arithmetic.
 *
 * Pure functions with no database access, so the maths can be tested directly
 * (see tests/loan-math.test.mts). The caller persists the result; the
 * `loan_payments` trigger moves `loans.balance`.
 *
 * Model: simple interest on the outstanding balance, accruing daily at APR/365.
 * Actual/365 rather than a fixed monthly step, because payments get tagged
 * whenever the user gets round to it rather than on a billing date, and a fixed
 * step would over- or under-charge depending on when the tag lands.
 */

/** Days in a year, the denominator for actual/365 accrual. */
const DAYS_PER_YEAR = 365;

/** Average days per month, for the month-by-month payoff projection. */
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

/** Guard on the projection loop so a hopeless payment cannot spin forever. */
const MAX_PROJECTION_MONTHS = 1200;

export type PaymentSplit = {
  /** Portion of the payment that was interest; it grew the balance. */
  interest: number;
  /**
   * Portion that retired debt. Deliberately allowed to go NEGATIVE: when a
   * payment does not cover the interest it accrued, the debt grows. That is the
   * honest answer and hiding it would make a bad loan look like progress.
   */
  principal: number;
  /** Paid on a loan that was already settled. */
  overpayment: number;
  /** Balance after the payment. */
  newBalance: number;
};

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Whole days from `fromDate` to `toDate`, both `YYYY-MM-DD`.
 *
 * Parsed as UTC because these are dates, not instants. Going through local time
 * would make the count depend on the server's timezone and shift accrual by a
 * day either side of midnight.
 */
export function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Interest accrued over a period, in currency units.
 *
 * A zero or negative balance accrues nothing: a settled loan must not start
 * growing again just because time passed.
 */
export function accruedInterest(input: {
  balance: number;
  /** Percent, e.g. 5.9 for 5.9%. Matches how `liabilities.apr` is stored. */
  apr: number;
  fromDate: string;
  toDate: string;
}): number {
  const { balance, apr, fromDate, toDate } = input;
  if (balance <= 0) return 0;

  const days = daysBetween(fromDate, toDate);
  if (days <= 0) return 0;

  return round2(balance * (apr / 100) * (days / DAYS_PER_YEAR));
}

/**
 * Work out what a payment does to a loan: how much was interest, how much
 * retired principal, and what the balance becomes.
 *
 * The balance moves by `-principal` and nothing else, which is what makes
 * tagging reversible: the database trigger adds `principal` back on delete and
 * the balance returns to the cent.
 */
export function splitPayment(input: {
  balance: number;
  apr: number;
  /** Start of the accrual period: the loan's last_accrued_at, else opened_on. */
  fromDate: string;
  /** Transaction date. */
  toDate: string;
  /** Gross amount leaving the bank account. */
  amount: number;
}): PaymentSplit {
  const { balance, apr, fromDate, toDate } = input;
  const amount = round2(Math.abs(input.amount));

  if (balance <= 0) {
    // Already settled: the whole payment is recorded, none of it lands.
    return { interest: 0, principal: 0, overpayment: amount, newBalance: balance };
  }

  const interest = accruedInterest({ balance, apr, fromDate, toDate });
  // Interest is already inside `amount`, so the rest is what retires debt.
  let principal = round2(amount - interest);
  let overpayment = 0;

  if (principal >= balance) {
    // Would pay the loan off and then some. Cap the principal at what is owed
    // so the balance cannot be driven negative; bank the excess as overpayment.
    overpayment = round2(amount - interest - balance);
    principal = round2(balance);
  }

  return {
    interest,
    principal,
    overpayment,
    newBalance: round2(balance - principal),
  };
}

/**
 * Project when a loan clears, given a fixed payment.
 *
 * Returns `null` when the payment will never clear it - either because the
 * payment does not cover the interest it accrues (negative amortisation, so the
 * balance grows every month) or because there is no payment set. Callers should
 * surface that as a warning rather than a payoff date.
 */
export function projectPayoff(input: {
  balance: number;
  apr: number;
  /** Expected payment. Zero or absent means "unknown". */
  payment: number | null | undefined;
  maxMonths?: number;
}): { months: number; totalInterest: number; totalPaid: number } | null {
  const { balance, apr, payment } = input;
  const maxMonths = input.maxMonths ?? MAX_PROJECTION_MONTHS;

  if (balance <= 0) return { months: 0, totalInterest: 0, totalPaid: 0 };
  if (payment === null || payment === undefined) return null;

  const perMonth = round2(payment);
  if (perMonth <= 0) return null;

  let remaining = balance;
  let totalInterest = 0;
  let totalPaid = 0;

  for (let month = 1; month <= maxMonths; month += 1) {
    const interest = round2(
      remaining * (apr / 100) * (DAYS_PER_MONTH / DAYS_PER_YEAR),
    );

    if (perMonth <= interest) {
      // The payment is swallowed by interest; the balance only grows.
      return null;
    }

    remaining = round2(remaining + interest - perMonth);
    totalInterest = round2(totalInterest + interest);
    totalPaid = round2(totalPaid + perMonth);

    if (remaining <= 0) {
      return { months: month, totalInterest, totalPaid };
    }
  }

  // Still outstanding after the guard horizon.
  return null;
}

/** How much of a loan's original principal is still outstanding, as a percent. */
export function payoffProgress(input: {
  balance: number;
  principal: number;
}): number | null {
  const { balance, principal } = input;
  if (principal <= 0) return null;
  return Math.max(0, Math.min(100, ((principal - balance) / principal) * 100));
}
/** One point of a loan's balance history. */
export type LoanBalancePoint = {
  /** YYYY-MM-DD. */
  date: string;
  balance: number;
};

/**
 * A loan's balance on every day it changed, reconstructed from the payment ledger.
 *
 * This is exact rather than a reconstruction, and it is worth being precise about
 * why. The `loan_payments` trigger does only two things to `loans.balance`:
 *
 *   INSERT  ->  balance -= NEW.principal
 *   DELETE  ->  balance += OLD.principal
 *
 * Nothing else writes the column except the user, via the balance-correction
 * field. So for any day D,
 *
 *   balance(D) = currentBalance + sum(principal of payments made after D)
 *
 * Every historical balance is therefore recoverable from what is already stored,
 * which is why loans need no daily snapshot table while accounts do. It also means
 * the answer shifts by exactly the same amount as a hand correction: correct the
 * balance today and every past point moves with it, so the line stays coherent.
 *
 * Points are emitted at the loan's opening and after each payment, not for every
 * calendar day. A day with no payment had no balance change, so a point per day
 * would be a straight line drawn between events that did not happen - and, worse,
 * would imply the balance was measured then.
 *
 * Two things this deliberately does NOT show, because the ledger does not know
 * them:
 *
 *  - Interest accruing between payments. The trigger subtracts only principal, so
 *    the stored balance is flat until a payment lands. Real interest accrues
 *    daily; `accruedInterest` computes it for the loan page's "accrued since the
 *    last payment" line.
 *  - The gap between `principal` and the balance before the first payment, which
 *    is usually interest accrued before the loan was entered. The opening point
 *    is what the trigger implies, not the stated principal.
 */
export function loanBalanceSeries(input: {
  /** `loans.opened_on`, YYYY-MM-DD. */
  openedOn: string;
  /** `loans.balance` as it stands now. */
  balance: number;
  /** The payment ledger, in any order. */
  payments: { paidOn: string; principal: number }[];
  /**
   * Today, YYYY-MM-DD. A final point is added when the last payment is older
   * than this, so the line reaches the present rather than stopping at the last
   * payment and implying the loan has not been touched since.
   */
  today: string;
}): LoanBalancePoint[] {
  const payments = [...input.payments].sort((a, b) =>
    a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0,
  );

  const totalPrincipal = payments.reduce(
    (sum, payment) => sum + payment.principal,
    0,
  );

  /*
   * Walking backwards from the current balance. `balance` starts at today's
   * figure and adding each payment's principal back undoes it, so every point is
   * the balance as the trigger left it - no accumulated rounding of its own.
   */
  const points: LoanBalancePoint[] = [];
  let balance = input.balance + totalPrincipal;

  // The opening point sits on the day the loan opened, unless a payment predates
  // that (a back-dated tag), in which case the first payment's date is the
  // earliest thing we can honestly place.
  const firstPaymentDate = payments[0]?.paidOn ?? null;
  const startDate =
    firstPaymentDate && firstPaymentDate < input.openedOn
      ? firstPaymentDate
      : input.openedOn;

  points.push({ date: startDate, balance: round2(balance) });

  for (const payment of payments) {
    balance -= payment.principal;
    const date = payment.paidOn < startDate ? startDate : payment.paidOn;
    const previous = points[points.length - 1];

    /*
     * Two payments on one day, or a payment on the opening day, would otherwise
     * put two points on the same date and make the series ambiguous. Collapse
     * them: the day's closing balance is the one that matters.
     */
    if (previous.date === date) {
      previous.balance = round2(balance);
      continue;
    }
    points.push({ date, balance: round2(balance) });
  }

  // Reach the present. Skipped when the last payment is already today, so the
  // chart does not end on a duplicate point.
  const last = points[points.length - 1];
  if (last && input.today > last.date) {
    points.push({ date: input.today, balance: round2(input.balance) });
  }

  return points;
}
