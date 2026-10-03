import assert from "node:assert/strict";
import { test } from "node:test";

import { cashFlowWindow } from "@/lib/cash-flow";
import {
  formatCurrencyInput,
  humanizeCategory,
  parseCurrencyInput,
  parseDateRange,
} from "@/lib/format";

/**
 * The money field. Both halves matter: the formatter runs on every keystroke and
 * has to be idempotent, and the parser has to tell "the box is empty" apart from
 * "the user typed zero" - conflating those two wipes a real budget.
 */

// ---------------------------------------------------------------------------
// Formatting while typing
// ---------------------------------------------------------------------------

test("digits get a dollar sign and thousands separators", () => {
  assert.equal(formatCurrencyInput("1550"), "$1,550");
  assert.equal(formatCurrencyInput("1234567"), "$1,234,567");
});

test("typing digits one at a time gives the same answer as typing the whole number", () => {
  /*
   * The caret problem. If formatting were not idempotent, "1" -> "$1" -> "$1" and
   * the next keystroke would land in the wrong place, or the field would fight
   * the user. Feeding the output back in must be a fixed point.
   */
  let text = "";
  for (const digit of "1234567") {
    text = formatCurrencyInput(text + digit);
  }
  assert.equal(text, "$1,234,567");
});

test("a trailing decimal point survives so decimals stay typable", () => {
  assert.equal(formatCurrencyInput("1550."), "$1,550.");
  assert.equal(formatCurrencyInput("$1,550."), "$1,550.");
  assert.equal(formatCurrencyInput("1550.5"), "$1,550.5");
  assert.equal(formatCurrencyInput("1550.55"), "$1,550.55");
});

test("fractional digits are not padded while typing", () => {
  // Padding to "1,550.50" would move the caret out from under the user.
  assert.equal(formatCurrencyInput("1550.5"), "$1,550.5");
});

test("an empty field stays empty rather than becoming $0", () => {
  assert.equal(formatCurrencyInput(""), "");
  assert.equal(formatCurrencyInput("$"), "");
  assert.equal(formatCurrencyInput("."), "$0.");
});

test("characters that are not part of a number are dropped", () => {
  // Pasted currency settles rather than being rejected, and keeps its cents
  // rather than being rounded away.
  assert.equal(formatCurrencyInput("$1,550.00"), "$1,550.00");
  assert.equal(formatCurrencyInput("abc"), "");
  assert.equal(formatCurrencyInput("1 5 5 0"), "$1,550");
});

test("a second decimal point is dropped rather than nested", () => {
  assert.equal(formatCurrencyInput("1.2.3"), "$1.23");
  assert.equal(formatCurrencyInput("1.."), "$1.");
});

test("leading zeros do not accumulate", () => {
  assert.equal(formatCurrencyInput("0"), "$0");
  assert.equal(formatCurrencyInput("05"), "$5");
  assert.equal(formatCurrencyInput("007"), "$7");
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

test("a formatted field reads back as the number it shows", () => {
  for (const raw of ["$0", "$1,550", "$1,234,567.89", "$1,550."]) {
    const parsed = parseCurrencyInput(raw);
    assert.ok(parsed !== null, `${raw} parses`);
  }
  assert.equal(parseCurrencyInput("$1,550"), 1550);
  assert.equal(parseCurrencyInput("$1,234,567.89"), 1234567.89);
  assert.equal(parseCurrencyInput("$1,550."), 1550);
});

test("an empty field reads as nothing rather than zero", () => {
  // The distinction that stops a cleared box from wiping a budget.
  assert.equal(parseCurrencyInput(""), null);
  assert.equal(parseCurrencyInput("$"), null);
  assert.equal(parseCurrencyInput("."), null);
  assert.equal(parseCurrencyInput("abc"), null);
});

test("zero is a value, not an absence", () => {
  assert.equal(parseCurrencyInput("$0"), 0);
  assert.equal(parseCurrencyInput("0.00"), 0);
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("every figure formatCurrency renders survives a round trip", () => {
  for (const amount of [0, 5, 99.99, 100, 1550, 4255.5, 123456.78]) {
    const shown = formatCurrencyInput(String(amount));
    assert.equal(
      parseCurrencyInput(shown),
      amount,
      `${shown} reads back as ${amount}`,
    );
  }
});

test("humanizeCategory turns PFC values into labels", () => {
  assert.equal(humanizeCategory("FOOD_AND_DRINK"), "Food And Drink");
  assert.equal(humanizeCategory("GENERAL_MERCHANDISE"), "General Merchandise");
});
/**
 * Ranges from `?from=&to=`.
 *
 * The bucket page takes a window rather than only a month so a year-to-date
 * figure can be opened up, and that made two things easy to get wrong: the month
 * count used to scale a budget, and what happens when the query string is junk.
 */
test("a range knows how many monthly budgets were in play", () => {
  // 273 days, nine monthly budgets. Counting days would scale the budget by ~22.
  const range = parseDateRange("2026-01-01", "2026-09-30");
  assert.equal(range?.months, 9);
});

test("the months a range counts match the cash flow page's own month count", () => {
  /*
   * The whole point of counting calendar months: the bucket page scales its budget
   * by this, and the cash flow page scales the same bucket by cashFlowWindow's
   * `months`. If the two ever disagree, one bucket shows two different "budgeted"
   * figures depending on which page you are standing on.
   */
  for (const month of [1, 4, 9, 12]) {
    const year = 2026;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const window = cashFlowWindow({
      scope: "ytd",
      year,
      month: 1,
      currentYear: 2030,
      currentMonth: month,
    });
    const range = parseDateRange(window.from, window.to);
    assert.equal(
      range?.months,
      window.months,
      `year-to-date through month ${month}`,
    );
    assert.ok(days > 0);
  }
});

test("a range crossing a year boundary counts both sides", () => {
  assert.equal(parseDateRange("2025-11-15", "2026-02-03")?.months, 4);
  assert.equal(parseDateRange("2026-03-01", "2026-03-31")?.months, 1);
  assert.equal(parseDateRange("2026-03-15", "2026-03-16")?.months, 1);
});

test("a range spanning exactly one month is labelled as that month", () => {
  assert.equal(
    parseDateRange("2026-08-01", "2026-08-31")?.label,
    "August 2026",
  );
  // Partial months still count as their own month, so the label matches the nav.
  assert.equal(parseDateRange("2026-08-15", "2026-08-16")?.label, "August 2026");
});

test("a range spanning months names both", () => {
  assert.equal(
    parseDateRange("2026-01-01", "2026-09-30")?.label,
    "January \u2013 September 2026",
  );
  // Across a year boundary the first month carries its own year.
  assert.equal(
    parseDateRange("2025-12-01", "2026-01-31")?.label,
    "December 2025 \u2013 January 2026",
  );
});

test("a junk range is rejected rather than half-applied", () => {
  // Postgres would read 2026-02-31 as March 3rd and quietly show the wrong rows.
  assert.equal(parseDateRange("2026-02-31", "2026-03-31"), null);
  assert.equal(parseDateRange("2026-13-01", "2026-13-31"), null);
  assert.equal(parseDateRange("2026-01-01", "2026-01-32"), null);
  // Reversed.
  assert.equal(parseDateRange("2026-09-30", "2026-01-01"), null);
  // Wrong shape, missing halves, and non-strings - all reach it from a URL.
  assert.equal(parseDateRange("2026-1-1", "2026-03-31"), null);
  assert.equal(parseDateRange("2026-01-01", ""), null);
  assert.equal(parseDateRange(undefined, undefined), null);
  assert.equal(parseDateRange(["2026-01-01"], "2026-03-31"), null);
});

test("a leap day is a real date", () => {
  assert.equal(parseDateRange("2024-02-29", "2024-02-29")?.months, 1);
});
