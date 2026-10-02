import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accruedInterest,
  daysBetween,
  payoffProgress,
  projectPayoff,
  splitPayment,
} from "@/lib/loan-math";

// ---------------------------------------------------------------------------
// daysBetween
// ---------------------------------------------------------------------------

test("daysBetween counts whole days and ignores time of day", () => {
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  assert.equal(daysBetween("2026-02-01", "2026-03-01"), 28); // 2026 is not a leap year
  assert.equal(daysBetween("2024-02-01", "2024-03-01"), 29); // leap year
});

test("daysBetween is zero for the same day and negative when reversed", () => {
  assert.equal(daysBetween("2026-05-10", "2026-05-10"), 0);
  assert.equal(daysBetween("2026-05-10", "2026-05-01"), -9);
});

test("daysBetween survives a daylight-saving transition", () => {
  // US DST starts 2026-03-08. A local-time implementation would return 6 or 7.
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
});

test("daysBetween returns 0 for unparseable dates rather than NaN", () => {
  assert.equal(daysBetween("2026-01-01", "not-a-date"), 0);
});

// ---------------------------------------------------------------------------
// accruedInterest
// ---------------------------------------------------------------------------

test("accruedInterest is zero when no time has passed", () => {
  assert.equal(
    accruedInterest({
      balance: 10_000,
      apr: 6,
      fromDate: "2026-01-01",
      toDate: "2026-01-01",
    }),
    0,
  );
});

test("accruedInterest is zero on a settled loan", () => {
  // A paid-off loan must not start growing again just because a month passed.
  assert.equal(
    accruedInterest({
      balance: 0,
      apr: 12,
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    }),
    0,
  );
});

test("accruedInterest uses actual/365 over a full year", () => {
  assert.equal(
    accruedInterest({
      balance: 10_000,
      apr: 5,
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
    }),
    500,
  );
});

test("accruedInterest is zero at a 0% APR", () => {
  assert.equal(
    accruedInterest({
      balance: 10_000,
      apr: 0,
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
    }),
    0,
  );
});

test("accruedInterest never returns for a reversed period", () => {
  // Tagging out of order would otherwise mint negative interest.
  assert.equal(
    accruedInterest({
      balance: 10_000,
      apr: 9,
      fromDate: "2026-06-01",
      toDate: "2026-01-01",
    }),
    0,
  );
});

// ---------------------------------------------------------------------------
// splitPayment - the case the user described
// ---------------------------------------------------------------------------

test("a 600 payment on a 25,000 loan at 5.9% retires less than 600 of debt", () => {
  // The shape from the feature request: ~600 a month on a car loan.
  const result = splitPayment({
    balance: 25_000,
    apr: 5.9,
    fromDate: "2026-09-02",
    toDate: "2026-10-02",
    amount: 600,
  });

  assert.equal(result.interest, 121.23); // 25000 * 0.059 * 30/365
  assert.equal(result.principal, 478.77); // 600 - 121.23
  assert.equal(result.newBalance, 24_521.23);
  assert.equal(result.overpayment, 0);
  // The three recorded parts must reconcile with the gross payment.
  assert.equal(
    round2(result.interest + result.principal + result.overpayment),
    600,
  );
});

test("the balance moves by exactly the principal, which is what makes it reversible", () => {
  const result = splitPayment({
    balance: 25_000,
    apr: 5.9,
    fromDate: "2026-09-02",
    toDate: "2026-10-02",
    amount: 600,
  });

  // The trigger applies `balance - principal`; reversing is `+ principal`.
  assert.equal(round2(25_000 - result.principal), result.newBalance);
  assert.equal(round2(result.newBalance + result.principal), 25_000);
});

test("an overpayment settles the loan and banks the excess", () => {
  const result = splitPayment({
    balance: 100,
    apr: 0,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    amount: 600,
  });

  assert.equal(result.principal, 100);
  assert.equal(result.overpayment, 500);
  assert.equal(result.newBalance, 0, "must never be driven negative");
});

test("paying an already-settled loan records the whole amount as overpayment", () => {
  const result = splitPayment({
    balance: 0,
    apr: 9,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    amount: 600,
  });

  assert.equal(result.interest, 0);
  assert.equal(result.principal, 0);
  assert.equal(result.overpayment, 600);
  assert.equal(result.newBalance, 0);
});

test("a payment smaller than the interest grows the balance", () => {
  // Negative amortisation. The honest outcome is a growing debt; reporting it as
  // progress would hide a bad loan behind a green number.
  const result = splitPayment({
    balance: 10_000,
    apr: 24,
    fromDate: "2026-09-02",
    toDate: "2026-10-02",
    amount: 150,
  });

  assert.equal(result.interest, 197.26);
  assert.equal(result.principal, -47.26, "principal is negative");
  assert.equal(result.newBalance, 10_047.26);
});

test("an exact payoff lands on zero", () => {
  const result = splitPayment({
    balance: 600,
    apr: 0,
    fromDate: "2026-01-01",
    toDate: "2026-12-31",
    amount: 600,
  });

  assert.equal(result.principal, 600);
  assert.equal(result.newBalance, 0);
});

test("the accrual window runs from last_accrued_at, so a long gap is not double-counted", () => {
  // Jan 1 -> Jul 1 is 181 days, not half of 365, so this is 357.04 and not 360.
  const firstHalf = accruedInterest({
    balance: 12_000,
    apr: 6,
    fromDate: "2026-01-01",
    toDate: "2026-07-01",
  });
  const fullYear = accruedInterest({
    balance: 12_000,
    apr: 6,
    fromDate: "2026-01-01",
    toDate: "2027-01-01",
  });

  assert.equal(daysBetween("2026-01-01", "2026-07-01"), 181);
  assert.equal(firstHalf, 357.04);
  assert.equal(fullYear, 720);
  assert.ok(firstHalf < fullYear, "half the days is less than the whole year");
});

test("successive payments each accrue only their own slice", () => {
  let balance = 25_000;
  let cursor = "2026-09-02";
  const principalParts: number[] = [];
  const interestParts: number[] = [];

  for (const toDate of ["2026-10-02", "2026-11-02", "2026-12-02"]) {
    const result = splitPayment({
      balance,
      apr: 5.9,
      fromDate: cursor,
      toDate,
      amount: 600,
    });
    balance = result.newBalance;
    cursor = toDate;
    principalParts.push(result.principal);
    interestParts.push(result.interest);
  }

  // The point of the whole feature: a 600 payment does NOT retire 600 of debt.
  // Roughly 120 a month is eaten by interest at this rate.
  for (const principal of principalParts) {
    assert.ok(principal < 600, `principal ${principal} should be under the payment`);
  }
  for (const interest of interestParts) {
    assert.ok(interest > 100 && interest < 130, `interest ${interest} in a sane band`);
  }

  // Only the principal portions came off the debt.
  const retired = principalParts.reduce((sum, n) => sum + n, 0);
  assert.equal(round2(retired), 1_439.3);
  assert.equal(balance, 23_560.7);
  assert.ok(
    balance > 25_000 - 600 * 3,
    "three 600 payments leave more than 1,800 still owed, because interest was charged",
  );
});

// ---------------------------------------------------------------------------
// projectPayoff
// ---------------------------------------------------------------------------

test("projectPayoff returns null when no payment is set", () => {
  assert.equal(projectPayoff({ balance: 10_000, apr: 6, payment: null }), null);
  assert.equal(projectPayoff({ balance: 10_000, apr: 6, payment: 0 }), null);
});

test("projectPayoff returns null when the payment never covers the interest", () => {
  // 150/mo against 24% on 10,000 accrues ~197 the first month, so the balance
  // grows forever and there is no payoff date to report.
  assert.equal(projectPayoff({ balance: 10_000, apr: 24, payment: 150 }), null);
});

test("projectPayoff clears a 0% loan in exactly balance/payment months", () => {
  const result = projectPayoff({ balance: 6_000, apr: 0, payment: 600 });
  assert.ok(result);
  assert.equal(result.months, 10);
  assert.equal(result.totalInterest, 0);
  assert.equal(result.totalPaid, 6_000);
});

test("projectPayoff on an interest-bearing loan takes longer and costs more", () => {
  const result = projectPayoff({ balance: 25_000, apr: 5.9, payment: 600 });
  assert.ok(result, "a 600/mo payment clears a 5.9% loan");
  assert.ok(result.months > 25_000 / 600, "longer than dividing by the payment");
  assert.ok(result.totalInterest > 0);
  assert.ok(result.totalPaid > 25_000);
});

test("projectPayoff is zero months for a settled loan", () => {
  assert.deepEqual(projectPayoff({ balance: 0, apr: 5, payment: 600 }), {
    months: 0,
    totalInterest: 0,
    totalPaid: 0,
  });
});

test("projectPayoff stops at its guard instead of spinning", () => {
  // 1/mo on a 100,000 loan would run ~8,300 months; the cap should bail out.
  assert.equal(
    projectPayoff({ balance: 100_000, apr: 0, payment: 1, maxMonths: 12 }),
    null,
  );
});

// ---------------------------------------------------------------------------
// payoffProgress
// ---------------------------------------------------------------------------

test("payoffProgress reports how much principal has been retired", () => {
  assert.equal(payoffProgress({ balance: 7_500, principal: 10_000 }), 25);
  assert.equal(payoffProgress({ balance: 10_000, principal: 10_000 }), 0);
});

test("payoffProgress is null when there is no principal to measure against", () => {
  assert.equal(payoffProgress({ balance: 500, principal: 0 }), null);
});

test("payoffProgress is clamped when the balance has been overpaid", () => {
  assert.equal(payoffProgress({ balance: -200, principal: 10_000 }), 100);
});

// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}