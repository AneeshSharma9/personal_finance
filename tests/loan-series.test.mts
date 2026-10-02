import assert from "node:assert/strict";
import { test } from "node:test";

import { loanBalanceSeries } from "@/lib/loan-math";

/**
 * A loan's balance history, reconstructed rather than recorded.
 *
 * The contract being defended is that every point is exactly what the
 * `loan_payments` trigger would have left in `loans.balance` on that day, and
 * that the series ends on the current balance. If either drifts, the chart is
 * showing a history the ledger does not support.
 */

const payments = [
  { paidOn: "2026-01-06", principal: 117.7 },
  { paidOn: "2026-02-03", principal: 82.97 },
  { paidOn: "2026-03-11", principal: 73.38 },
];

test("a loan with no payments is a single flat point", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 11000,
    payments: [],
    today: "2026-04-01",
  });
  assert.deepEqual(series, [
    { date: "2025-11-01", balance: 11000 },
    { date: "2026-04-01", balance: 11000 },
  ]);
});

test("the opening point is the balance before the first payment", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments,
    today: "2026-03-11",
  });
  // 10726 + 117.7 + 82.97 + 73.38 = 11000.05
  assert.equal(series[0].date, "2025-11-01");
  assert.equal(series[0].balance, 11000.05);
});

test("each payment produces the balance after it", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments,
    today: "2026-03-11",
  });
  // Each point is the previous one less that payment's principal, which is
  // exactly what the trigger did to loans.balance.
  assert.deepEqual(series, [
    { date: "2025-11-01", balance: 11000.05 },
    { date: "2026-01-06", balance: 10882.35 },
    { date: "2026-02-03", balance: 10799.38 },
    { date: "2026-03-11", balance: 10726 },
  ]);
});

test("the last point is the current balance when payments are older than today", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments,
    today: "2026-04-15",
  });
  assert.equal(series[series.length - 1].date, "2026-04-15");
  assert.equal(series[series.length - 1].balance, 10726);
});

test("no duplicate point when a payment lands today", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments,
    today: "2026-03-11",
  });
  assert.equal(series[series.length - 1].date, "2026-03-11");
  assert.equal(series.filter((p) => p.date === "2026-03-11").length, 1);
});

test("the balance only ever goes down for a normal amortising loan", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 6768.81,
    payments: [
      { paidOn: "2026-01-06", principal: 100 },
      { paidOn: "2026-02-03", principal: 200 },
      { paidOn: "2026-03-11", principal: 300 },
      { paidOn: "2026-04-21", principal: 400 },
    ],
    today: "2026-05-01",
  });
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(
      series[i].balance <= series[i - 1].balance,
      `point ${i} (${series[i].date}) did not rise: ${series[i - 1].balance} -> ${series[i].balance}`,
    );
  }
});

test("unsorted payments are handled", () => {
  const ordered = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments,
    today: "2026-03-11",
  });
  const shuffled = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 10726,
    payments: [payments[2], payments[0], payments[1]],
    today: "2026-03-11",
  });
  assert.deepEqual(shuffled, ordered);
});

test("two payments on one day collapse to that day's closing balance", () => {
  const series = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 900,
    payments: [
      { paidOn: "2026-02-01", principal: 50 },
      { paidOn: "2026-02-01", principal: 50 },
    ],
    today: "2026-02-01",
  });
  // One point for the day, showing the balance after BOTH payments. Two points on
  // one date would make the series ambiguous about which balance held when.
  const onTheDay = series.filter((p) => p.date === "2026-02-01");
  assert.equal(onTheDay.length, 1);
  assert.equal(onTheDay[0].balance, 900);
});

test("a payment predating the loan's open date does not precede the series", () => {
  const series = loanBalanceSeries({
    openedOn: "2026-01-01",
    balance: 900,
    // Back-dated tag, entered after the loan was created.
    payments: [{ paidOn: "2025-12-15", principal: 100 }],
    today: "2026-02-01",
  });
  assert.equal(series[0].date, "2025-12-15");
  assert.ok(
    series.every((p, i) => i === 0 || p.date >= series[i - 1].date),
    "dates stay ascending",
  );
});

test("a hand-corrected balance shifts every point by the same amount", () => {
  /*
   * The user can correct `loans.balance` by hand, and that is the only write the
   * trigger does not own. Every point must move with it, or the chart would show
   * a jump on the correction date that no payment explains.
   */
  const before = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 1000,
    payments,
    today: "2026-03-11",
  });
  const corrected = loanBalanceSeries({
    openedOn: "2025-11-01",
    balance: 950,
    payments,
    today: "2026-03-11",
  });
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(corrected[i].date, before[i].date);
    // Compared with a tolerance: these are currency figures that have been
    // through toFixed(2), so exact float equality is the wrong assertion even
    // when the arithmetic is right.
    assert.ok(
      Math.abs(corrected[i].balance - (before[i].balance - 50)) < 0.005,
      `point ${i} (${before[i].date}) moved by the correction: ` +
        `${before[i].balance} -> ${corrected[i].balance}, expected ${before[i].balance - 50}`,
    );
  }
});

test("a principal that exceeds the balance is honoured, not clamped", () => {
  // splitPayment caps principal so a balance cannot go negative, so this cannot
  // arise from the app - but a hand-edited ledger should still not be silently
  // rewritten by a chart function.
  const series = loanBalanceSeries({
    openedOn: "2026-01-01",
    balance: -50,
    payments: [{ paidOn: "2026-02-01", principal: 500 }],
    today: "2026-02-01",
  });
  assert.equal(series[series.length - 1].balance, -50);
});
